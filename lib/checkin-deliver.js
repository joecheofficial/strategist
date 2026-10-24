'use strict';
/**
 * Daily check-in delivery.
 *
 * Email goes only to the customer's own address, sent to themselves, through
 * the mail sender their All Sorted install already has: the installed Resend
 * module, with the owner address and verified sender from the email agent's
 * settings. No new service, no new account. When that route is not set up,
 * or the send fails, the check-in is kept on this computer and shown in
 * Mission Control, with a note on how to connect email.
 *
 * Own addresses are the ones this install already knows belong to the
 * customer: the email agent's ownerEmail and the Google account they
 * connected. Anything else is refused before any provider is contacted.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validAddress } = require('./checkin-config');

const CONNECT_EMAIL_HELP = [
  'To get it by email, connect the mail sender your install already has:',
  '1. Install and set up the Resend module (it needs your own Resend key in your private settings).',
  '2. Put your own address in email-agent/config/email-agent.config.json as "ownerEmail", and a sender on a domain you verified in Resend as "updateNotifications.from".',
  '3. Run: node strategist/bin/strategist.js checkin run --now',
].join('\n');

function noLink(file) {
  try { return !fs.lstatSync(file).isSymbolicLink(); } catch (e) { return false; }
}

function readJsonIf(file) {
  try {
    if (!noLink(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function emailAgentConfig(root) {
  return readJsonIf(path.join(root, 'email-agent', 'config', 'email-agent.config.json')) || {};
}

function ownAddresses(root) {
  const found = [];
  const add = (value) => {
    const address = typeof value === 'string' ? value.trim() : '';
    if (validAddress(address) && !found.some((item) => item.toLowerCase() === address.toLowerCase())) found.push(address);
  };
  add(emailAgentConfig(root).ownerEmail);
  for (const file of [path.join(root, 'google', 'config.json'), path.join(root, 'google', 'config.local.json')]) {
    const cfg = readJsonIf(file);
    if (cfg) add(cfg.account);
  }
  return found;
}

function isOwnAddress(root, address) {
  return validAddress(address) && ownAddresses(root).some((item) => item.toLowerCase() === String(address).toLowerCase());
}

function installedResend(root) {
  for (const segment of ['resend', 'resend/src', 'resend/src/index.js', 'resend/src/runtime.js']) {
    if (!noLink(path.join(root, segment))) return null;
  }
  return require(path.join(root, 'resend', 'src', 'index.js'));
}

function withDeadline(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Decide whether email can be sent and from where. Never sends.
async function emailRoute({ root, to, client, timeoutMs = 30000 }) {
  if (!validAddress(to)) return { ok: false, reason: 'no_destination', message: 'No email address is set for the check-in.' };
  if (!isOwnAddress(root, to)) {
    return { ok: false, reason: 'not_own_address', message: 'The check-in only goes to your own address. Set "ownerEmail" in the email agent settings to that address, or connect that Google account, first.' };
  }
  const settings = emailAgentConfig(root);
  const notifications = settings.updateNotifications || {};
  const sender = validAddress(notifications.from) ? notifications.from : null;
  if (!sender) return { ok: false, reason: 'sender_not_configured', message: 'No verified sender is set for your install\'s mail route.' };
  let api = client;
  try { api = api || installedResend(root); } catch (e) { api = null; }
  if (!api || typeof api.sendEmail !== 'function' || typeof api.listDomains !== 'function') {
    return { ok: false, reason: 'mail_route_not_installed', message: 'Your install has no mail sender set up yet.' };
  }
  let domains;
  try { domains = await withDeadline(Promise.resolve().then(() => api.listDomains()), timeoutMs); }
  catch (e) { return { ok: false, reason: 'mail_route_unavailable', message: 'The mail sender could not be reached to confirm your sending domain.' }; }
  const domain = sender.slice(sender.lastIndexOf('@') + 1).toLowerCase();
  const verified = domains && Array.isArray(domains.data) && domains.data.some((item) => item && String(item.name).toLowerCase() === domain && item.status === 'verified' && (!item.capabilities || !item.capabilities.sending || item.capabilities.sending === 'enabled'));
  if (!verified) return { ok: false, reason: 'sender_not_verified', message: 'Your sending domain is not verified with your mail sender yet.' };
  return { ok: true, provider: 'resend', from: sender, to, client: api };
}

// Same day, same address, same text: the provider sends it once. A changed
// check-in later the same day gets its own key.
function idempotencyKey(date, to, text) {
  const hash = crypto.createHash('sha256').update(`${date}\n${String(to).toLowerCase()}\n${text || ''}`).digest('hex').slice(0, 24);
  return `strategist-checkin-${date}-${hash}`;
}

async function sendEmail({ route, subject, text, date }) {
  // Frozen envelope: one recipient, the customer; no cc, bcc, reply-to or headers.
  const payload = { from: route.from, to: [route.to], subject, text };
  try {
    const result = await route.client.sendEmail({ ...payload, idempotencyKey: idempotencyKey(date, route.to, text), confirm: true });
    return { ok: true, id: result && result.id ? String(result.id) : null };
  } catch (e) {
    const rejected = /^Resend request failed \((400|401|403|404|422|429)\):/.test(String(e && e.message));
    return { ok: false, reason: rejected ? 'provider_rejected' : 'provider_outcome_unknown' };
  }
}

// Write a private file whose real folder is inside `root`: a linked folder
// cannot redirect the write elsewhere, and a linked file is replaced, never
// written through.
function writePrivate(root, file, text, extraBases = []) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const real = fs.realpathSync(dir);
  const inside = [root, ...extraBases].some((candidate) => {
    let base;
    try { base = fs.realpathSync(candidate); } catch (e) { return false; }
    return real === base || real.startsWith(base + path.sep);
  });
  if (!inside) throw new Error(`Refusing to write outside the install folder: ${file}`);
  const target = path.join(real, path.basename(file));
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, target);
}

// The owner may link their briefs folder to a synced folder of their own;
// writes inside it are allowed, nothing else outside the install is.
function briefsBase(home) {
  return path.join(home, 'briefs');
}

// Keep the check-in on this computer: the briefs folder, plus a card in
// Mission Control's Memory page when Mission Control is installed.
function saveLocal({ home, root, date, text, note }) {
  const briefPath = path.join(home, 'briefs', `checkin-${date}.md`);
  writePrivate(root, briefPath, text + '\n', [briefsBase(home)]);
  let missionControl = null;
  const mcRoot = path.join(root, 'mission-control');
  if (fs.existsSync(mcRoot) && noLink(mcRoot) && fs.statSync(mcRoot).isDirectory()) {
    missionControl = path.join(mcRoot, 'memory', 'strategist-daily-checkin.md');
    const card = [
      '---',
      'title: Daily check-in',
      `description: Your Strategist daily check-in for ${date}`,
      'type: reference',
      '---',
      '',
      `# Daily check-in, ${date}`,
      '',
      text,
      note ? `\n---\n\n${note}` : '',
      '',
    ].join('\n');
    writePrivate(root, missionControl, card);
  }
  return { briefPath, missionControl };
}

module.exports = {
  CONNECT_EMAIL_HELP,
  ownAddresses,
  isOwnAddress,
  emailRoute,
  sendEmail,
  saveLocal,
  idempotencyKey,
  writePrivate,
  briefsBase,
};
