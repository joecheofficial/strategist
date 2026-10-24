'use strict';
/**
 * Daily check-in settings: the answers from the check-in interview.
 *
 * Saved at <strategist home>/config/daily-checkin.json. The daily job reads
 * this file every run, so re-running the interview or editing the file
 * changes the next check-in. Nothing runs until the interview is complete.
 */
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const SECTIONS = ['priorities', 'money', 'pipeline', 'calendar', 'relationships', 'risks'];
const SECTION_LABELS = {
  priorities: 'Priorities: the few things that matter today',
  money: 'Money: owed to you, due from you, leaking',
  pipeline: 'Pipeline: deals, leads and proposals in motion',
  calendar: 'Calendar: today\'s meetings and fixed commitments',
  relationships: 'Relationships: people to follow up with',
  risks: 'Risks: deadlines and things quietly going wrong',
};
const DELIVERY_METHODS = ['email', 'local'];
// The metered fallback can never be allowed more than this per UTC day.
const MAX_DAILY_CAP_USD = 1;
const MAX_MATTERS_CHARS = 600;

function configPath(home) {
  return path.join(home, 'config', 'daily-checkin.json');
}

function validAddress(value) {
  return typeof value === 'string' && value.length <= 254 && !value.includes('..') &&
    /^[^\s@<>,;:"()[\]\\\x00-\x1f\x7f]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(value);
}

function validTimeZone(value) {
  if (typeof value !== 'string' || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch (e) {
    return false;
  }
}

function systemTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (e) {
    return 'UTC';
  }
}

function parseTime(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function parseSections(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,\s]+/);
  const picked = [];
  for (const raw of list) {
    const name = String(raw).trim().toLowerCase();
    if (!name) continue;
    if (!SECTIONS.includes(name)) throw new Error(`Unknown section "${name}". Choose from: ${SECTIONS.join(', ')}`);
    if (!picked.includes(name)) picked.push(name);
  }
  return picked;
}

function defaults() {
  return {
    schemaVersion: SCHEMA_VERSION,
    enabled: false,
    completedAt: null,
    sections: ['priorities', 'money', 'calendar', 'risks'],
    mattersMost: '',
    time: { hour: 7, minute: 30 },
    timeZone: systemTimeZone(),
    delivery: { method: 'email', to: null },
    model: { meteredApi: { enabled: false, dailyCapUsd: MAX_DAILY_CAP_USD } },
  };
}

// Problems that stop a check-in from being scheduled or run.
function validate(cfg) {
  const problems = [];
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return ['the settings are not a JSON object'];
  if (cfg.schemaVersion !== SCHEMA_VERSION) problems.push('schemaVersion must be 1');
  if (!Array.isArray(cfg.sections) || cfg.sections.length === 0) problems.push('sections: pick at least one thing to see');
  else {
    try { parseSections(cfg.sections); } catch (e) { problems.push('sections: ' + e.message); }
  }
  if (typeof cfg.mattersMost !== 'string' || !cfg.mattersMost.trim()) problems.push('mattersMost: say what matters most to you right now');
  else if (cfg.mattersMost.length > MAX_MATTERS_CHARS) problems.push(`mattersMost: keep it under ${MAX_MATTERS_CHARS} characters`);
  if (!cfg.time || !parseTime(`${cfg.time.hour}:${String(cfg.time.minute).padStart(2, '0')}`) ||
      !Number.isInteger(cfg.time.hour) || !Number.isInteger(cfg.time.minute)) problems.push('time: use a time such as 07:30');
  if (!validTimeZone(cfg.timeZone)) problems.push('timeZone: use a time zone name such as Europe/London');
  const delivery = cfg.delivery || {};
  if (!DELIVERY_METHODS.includes(delivery.method)) problems.push('delivery.method: email or local');
  if (delivery.method === 'email' && !validAddress(delivery.to)) problems.push('delivery.to: your own email address');
  const metered = (cfg.model && cfg.model.meteredApi) || {};
  if (typeof metered.enabled !== 'boolean') problems.push('model.meteredApi.enabled: true or false');
  if (typeof metered.dailyCapUsd !== 'number' || !(metered.dailyCapUsd > 0) || metered.dailyCapUsd > MAX_DAILY_CAP_USD) {
    problems.push(`model.meteredApi.dailyCapUsd: a number above 0 and at most ${MAX_DAILY_CAP_USD}`);
  }
  return problems;
}

function isComplete(cfg) {
  return Boolean(cfg && cfg.completedAt && validate(cfg).length === 0);
}

function readConfig(home) {
  const file = configPath(home);
  let stat;
  try { stat = fs.lstatSync(file); } catch (e) { return null; }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('config/daily-checkin.json must be a regular file, not a link');
  if (stat.size > 64 * 1024) throw new Error('config/daily-checkin.json is too large');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeConfig(home, cfg) {
  const problems = validate(cfg);
  if (problems.length) throw new Error('The check-in settings are not valid:\n  - ' + problems.join('\n  - '));
  const file = configPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('config/daily-checkin.json must be a regular file, not a link');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
  return file;
}

// Apply interview answers (all strings, from flags or prompts) on top of the
// current settings. Unknown keys are refused; an empty answer keeps the value.
function applyAnswers(current, answers) {
  const cfg = JSON.parse(JSON.stringify(current || defaults()));
  const allowed = ['sections', 'mattersMost', 'time', 'timeZone', 'deliver', 'to', 'meteredApi', 'dailyCapUsd'];
  for (const key of Object.keys(answers || {})) {
    if (!allowed.includes(key)) throw new Error(`Unknown setting: ${key}`);
  }
  const has = (key) => answers[key] !== undefined && answers[key] !== null && String(answers[key]).trim() !== '';
  if (has('sections')) cfg.sections = parseSections(answers.sections);
  if (has('mattersMost')) cfg.mattersMost = String(answers.mattersMost).replace(/\s+/g, ' ').trim();
  if (has('time')) {
    const time = parseTime(answers.time);
    if (!time) throw new Error('Use a time such as 07:30 (24-hour clock).');
    cfg.time = time;
  }
  if (has('timeZone')) {
    if (!validTimeZone(String(answers.timeZone).trim())) throw new Error('Use a time zone name such as America/New_York.');
    cfg.timeZone = String(answers.timeZone).trim();
  }
  cfg.delivery = cfg.delivery || { method: 'email', to: null };
  if (has('deliver')) {
    const method = String(answers.deliver).trim().toLowerCase();
    if (!DELIVERY_METHODS.includes(method)) throw new Error('Deliver by "email" or "local".');
    cfg.delivery.method = method;
  }
  if (has('to')) cfg.delivery.to = String(answers.to).trim();
  cfg.model = cfg.model || {};
  cfg.model.meteredApi = cfg.model.meteredApi || { enabled: false, dailyCapUsd: MAX_DAILY_CAP_USD };
  if (has('meteredApi')) {
    const value = String(answers.meteredApi).trim().toLowerCase();
    if (!['on', 'off'].includes(value)) throw new Error('The metered fallback is "on" or "off".');
    cfg.model.meteredApi.enabled = value === 'on';
  }
  if (has('dailyCapUsd')) {
    const cap = Number(answers.dailyCapUsd);
    if (!(cap > 0) || cap > MAX_DAILY_CAP_USD) throw new Error(`The daily cap is above 0 and at most ${MAX_DAILY_CAP_USD} USD.`);
    cfg.model.meteredApi.dailyCapUsd = cap;
  }
  return cfg;
}

function describe(cfg) {
  const time = `${String(cfg.time.hour).padStart(2, '0')}:${String(cfg.time.minute).padStart(2, '0')}`;
  const where = cfg.delivery.method === 'email' ? `email to ${cfg.delivery.to}` : 'saved on this computer and shown in Mission Control';
  return [
    `Status: ${!cfg.completedAt ? 'interview not finished' : cfg.enabled ? 'on' : 'off'}`,
    `What you see: ${cfg.sections.join(', ')}`,
    `What matters most: ${cfg.mattersMost || '(not answered yet)'}`,
    `When: every day at ${time} (${cfg.timeZone})`,
    `Where: ${where}`,
    `Metered API fallback: ${cfg.model.meteredApi.enabled ? `on, capped at ${cfg.model.meteredApi.dailyCapUsd} USD a day` : 'off'}`,
  ].join('\n');
}

module.exports = {
  SCHEMA_VERSION,
  SECTIONS,
  SECTION_LABELS,
  DELIVERY_METHODS,
  MAX_DAILY_CAP_USD,
  configPath,
  validAddress,
  validTimeZone,
  systemTimeZone,
  parseTime,
  parseSections,
  defaults,
  validate,
  isComplete,
  readConfig,
  writeConfig,
  applyAnswers,
  describe,
};
