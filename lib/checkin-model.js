'use strict';
/**
 * Which model, if any, writes the daily check-in.
 *
 * The owner working LLM preference is tried first through All Sorted Dispatch,
 * then another signed-in CLI. Scheduled and foreground runs share this route.
 * An explicitly enabled, capped metered API remains optional. Otherwise the
 * check-in uses the data-only fallback.
 *
 * Credentials are never read from files, copied, printed or stored here.
 */
const fs = require('fs');
const path = require('path');
const { MAX_DAILY_CAP_USD } = require('./checkin-config');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-5-5';
// USD per million tokens. A model without a price here is refused, so a cost
// can always be reserved before the call.
const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};
const MAX_OUTPUT_TOKENS = 6000;
const REQUEST_TIMEOUT_MS = 120000;
const LEDGER_NAME = 'anthropic-api-spend.json';

function utcDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}

// A deliberately high token estimate: about one token per two bytes.
function maxCostUsd(prompt, model) {
  const price = PRICES[model];
  if (!price) return null;
  const inputTokens = Math.ceil(Buffer.byteLength(String(prompt), 'utf8') / 2) + 64;
  return (inputTokens * price.input + MAX_OUTPUT_TOKENS * price.output) / 1e6;
}

function actualCostUsd(usage, model) {
  const price = PRICES[model];
  if (!price || !usage || !Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.output_tokens)) return null;
  const cacheWrite = Number.isFinite(usage.cache_creation_input_tokens) ? usage.cache_creation_input_tokens * price.input * 1.25 : 0;
  const cacheRead = Number.isFinite(usage.cache_read_input_tokens) ? usage.cache_read_input_tokens * price.input * 0.1 : 0;
  return (usage.input_tokens * price.input + usage.output_tokens * price.output + cacheWrite + cacheRead) / 1e6;
}

// --- Install-wide spend ledger for the metered Anthropic API ---------------
// <root>/state/anthropic-api-spend.json, one entry per UTC day. Reservations
// count against the cap from the moment they are made, survive restarts, and
// are only released when the provider definitely refused the request.

function ledgerPath(root) {
  return path.join(root, 'state', LEDGER_NAME);
}

function withLedgerLock(root, work) {
  const file = ledgerPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      try { return work(file); } finally { fs.rmSync(lock, { force: true }); }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try {
        const holder = JSON.parse(fs.readFileSync(lock, 'utf8'));
        try { process.kill(holder.pid, 0); } catch (err) { stale = err.code === 'ESRCH'; }
      } catch (err) { /* unreadable lock: wait */ }
      if (stale) { fs.rmSync(lock, { force: true }); continue; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  throw new Error('The spend ledger is busy; the metered call was not made.');
}

function readLedger(file) {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('The spend ledger must not be a link.');
  } catch (e) {
    if (e.code === 'ENOENT') return { schemaVersion: 1, days: {} };
    throw e;
  }
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || value.schemaVersion !== 1 || typeof value.days !== 'object') throw new Error('The spend ledger is not readable; the metered call was not made.');
  return value;
}

function writeLedger(file, ledger) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}

function dayTotal(entry) {
  const reserved = Object.values(entry.reservations || {}).reduce((sum, value) => sum + value.usd, 0);
  return (entry.spentUsd || 0) + reserved;
}

function reserve(root, { usd, capUsd, now, id }) {
  return withLedgerLock(root, (file) => {
    const ledger = readLedger(file);
    const day = utcDay(now);
    const entry = ledger.days[day] || (ledger.days[day] = { spentUsd: 0, reservations: {} });
    const used = dayTotal(entry);
    if (used + usd > capUsd + 1e-9) return { ok: false, usedUsd: used };
    entry.reservations[id] = { usd, at: new Date(now).toISOString(), by: 'strategist-checkin' };
    writeLedger(file, ledger);
    return { ok: true, day, usedUsd: used };
  });
}

// spentUsd null = outcome unknown: the whole reservation is booked as spent.
function settle(root, { day, id, spentUsd }) {
  return withLedgerLock(root, (file) => {
    const ledger = readLedger(file);
    const entry = ledger.days[day];
    if (!entry || !entry.reservations[id]) return;
    const reserved = entry.reservations[id].usd;
    delete entry.reservations[id];
    entry.spentUsd = (entry.spentUsd || 0) + (spentUsd === null ? reserved : spentUsd);
    writeLedger(file, ledger);
  });
}

// --- Routes -----------------------------------------------------------------

// The installed runtime is authoritative; the bundled adapter supports standalone copies.
async function agentText(root, deps, prompt, env, scheduled) {
  if (env.STRATEGIST_OFFLINE === '1') return { ok: false, reason: 'native_login_unavailable' };
  if (deps && typeof deps.unattendedOAuth === 'function') return deps.unattendedOAuth(root);
  try {
    const file = require('./agent-route').helper(root);
    const runner = (deps && deps.agentLlm) || require(file);
    return { ok: true, text: await runner.ask(root, prompt, { env, timeoutMs: (scheduled ? 16 : 10) * 60 * 1000 }) };
  } catch { return { ok: false, reason: 'native_login_unavailable' }; }
}

async function meteredApi({ root, prompt, cfg, env, now, deps }) {
  const metered = (cfg.model && cfg.model.meteredApi) || {};
  if (metered.enabled !== true) return { ok: false, reason: 'metered_api_off' };
  const key = env.ANTHROPIC_API_KEY;
  if (typeof key !== 'string' || !key.trim()) return { ok: false, reason: 'metered_api_no_key' };
  const model = DEFAULT_MODEL;
  const estimate = maxCostUsd(prompt, model);
  if (estimate === null) return { ok: false, reason: 'metered_api_unknown_price' };
  const capUsd = Math.min(Number(metered.dailyCapUsd) || 0, MAX_DAILY_CAP_USD);
  if (estimate > capUsd) return { ok: false, reason: 'metered_api_cap_too_low' };
  const id = `checkin-${now}-${process.pid}`;
  let held;
  try { held = reserve(root, { usd: estimate, capUsd, now, id }); }
  catch (e) { return { ok: false, reason: 'metered_api_ledger_unavailable' }; }
  if (!held.ok) return { ok: false, reason: 'metered_api_daily_cap' };
  // A ledger that cannot be updated after the call keeps the full reservation
  // booked, which is the safe direction; the text is still used.
  const book = (spentUsd) => { try { settle(root, { day: held.day, id, spentUsd }); } catch (e) { /* reservation stays booked */ } };
  const doFetch = (deps && deps.fetch) || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  let data = null;
  try {
    response = await doFetch(ANTHROPIC_URL, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: MAX_OUTPUT_TOKENS, output_config: { effort: 'low' }, messages: [{ role: 'user', content: prompt }] }),
    });
    try { data = await response.json(); } catch (e) { data = null; }
  } catch (e) {
    book(null);
    return { ok: false, reason: 'metered_api_outcome_unknown' };
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    // A 4xx is a refusal before any work: nothing was billed. Anything else may have been.
    const refused = response.status >= 400 && response.status < 500;
    book(refused ? 0 : null);
    return { ok: false, reason: refused ? `metered_api_refused_${response.status}` : 'metered_api_outcome_unknown' };
  }
  book(actualCostUsd(data && data.usage, model));
  if (!data || data.stop_reason === 'refusal' || !Array.isArray(data.content)) return { ok: false, reason: 'metered_api_no_answer' };
  const text = data.content.filter((block) => block && block.type === 'text').map((block) => block.text).join('\n').trim();
  if (!text) return { ok: false, reason: 'metered_api_no_answer' };
  return { ok: true, text, model };
}

const REASON_TEXT = {
  data_only_requested: 'you asked for the data-only version',
  native_login_unavailable: 'your native Claude Code, Codex or Antigravity login is unavailable, locked or needs sign-in; open your normal session and sign in, then retry',
  metered_api_off: 'the metered API fallback is off',
  metered_api_no_key: 'no Anthropic API key is in your private settings',
  metered_api_unknown_price: 'the model price is unknown, so no cost could be reserved',
  metered_api_daily_cap: 'today\'s metered API cap is used up',
  metered_api_cap_too_low: 'your daily cap is lower than one check-in can cost',
  metered_api_ledger_unavailable: 'the spend ledger could not be read, so no metered call was made',
  metered_api_outcome_unknown: 'the metered API did not answer clearly',
  metered_api_no_answer: 'the metered API returned no usable answer',
};

function explain(reason) {
  if (REASON_TEXT[reason]) return REASON_TEXT[reason];
  if (/^metered_api_refused_/.test(reason)) return 'the metered API refused the request';
  return reason;
}

// Try each route in order. Returns { route, text?, attempts: [{route, reason}] }.
async function writeWithModel({ root, prompt, cfg, scheduled, env = process.env, now = Date.now(), deps = {} }) {
  const attempts = [];
  const oauth = await agentText(root, deps, prompt, env, scheduled);
  if (oauth && oauth.ok && oauth.text) return { route: 'safe-oauth', text: oauth.text, attempts };
  attempts.push({ route: 'safe-oauth', reason: (oauth && oauth.reason) || 'native_login_unavailable' });
  const api = await meteredApi({ root, prompt, cfg, env, now, deps });
  if (api.ok) return { route: 'metered-api', text: api.text, model: api.model, attempts };
  attempts.push({ route: 'metered-api', reason: api.reason });
  return { route: 'data-only', attempts };
}

module.exports = {
  DEFAULT_MODEL,
  PRICES,
  MAX_OUTPUT_TOKENS,
  ledgerPath,
  maxCostUsd,
  actualCostUsd,
  reserve,
  settle,
  readLedger,
  utcDay,
  writeWithModel,
  explain,
};
