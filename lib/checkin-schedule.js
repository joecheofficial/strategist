'use strict';
/**
 * The once-a-day check-in job (macOS launchd).
 *
 * Label ai.allsorted.strategist-checkin, beside the install's other daily
 * jobs such as ai.allsorted.brain-refresh. It is written only when the
 * interview is complete and the check-in is on, it runs through the install's
 * as-run so it gets the same private settings as every other command, and the
 * run itself does nothing unless the settings still say it is on.
 *
 * Turn it off:  node strategist/bin/strategist.js checkin off
 * That removes the job from LaunchAgents and keeps your answers.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { isComplete } = require('./checkin-config');

const LABEL = 'ai.allsorted.strategist-checkin';

// A derived distribution shows its own product name, like the brain refresh job.
function labelFor(root) {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'allsorted-dist.lock.json'), 'utf8'));
    const name = lock && lock.product && typeof lock.product.name === 'string' ? lock.product.name.trim() : '';
    const tag = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!tag || tag === 'allsorted' || tag.length > 40) return LABEL;
    return `ai.${tag}.strategist-checkin`;
  } catch (e) {
    return LABEL;
  }
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
}

function offsetMinutes(timeZone, instant) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(instant));
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  return Math.round((Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - instant) / 60000);
}

// The chosen time in the chosen time zone, as this Mac's local clock time
// (launchd runs on the Mac's clock). Same zone: unchanged.
function localClock(cfg, now = Date.now(), systemZone) {
  const zone = systemZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  if (zone === cfg.timeZone) return { hour: cfg.time.hour, minute: cfg.time.minute };
  const wanted = cfg.time.hour * 60 + cfg.time.minute;
  const shift = offsetMinutes(zone, now) - offsetMinutes(cfg.timeZone, now);
  const local = (((wanted + shift) % 1440) + 1440) % 1440;
  return { hour: Math.floor(local / 60), minute: local % 60 };
}

// The job wakes every hour at the chosen minute and the three quarter-hours
// after it, so the chosen time is hit exactly in any time zone (whole, half
// or quarter-hour offsets), through daylight saving changes and when the Mac
// moves to another zone. The run itself does nothing until the chosen time in
// the chosen zone, and only once a day (checkin-cli dueNow and receipts).
function minuteSlots(cfg) {
  return [0, 15, 30, 45].map((step) => (cfg.time.minute + step) % 60).sort((a, b) => a - b);
}

function plist({ root, home, cfg, nodePath = process.execPath, label = labelFor(root), now, systemZone }) {
  const asRun = path.join(root, 'bin', 'as-run');
  const command = [nodePath, path.join(home, 'bin', 'strategist.js'), 'checkin', 'run', '--scheduled'];
  const args = fs.existsSync(asRun) ? [asRun, ...command] : command;
  const logs = path.join(root, 'state');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key><dict><key>ALLSORTED_SCHEDULED</key><string>1</string><key>ALLSORTED_UNATTENDED</key><string>1</string><key>STRATEGIST_HOME</key><string>${xml(home)}</string><key>PATH</key><string>${xml(path.dirname(nodePath))}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin</string></dict>
  <key>StartCalendarInterval</key><array>${minuteSlots(cfg).map((minute) => `<dict><key>Minute</key><integer>${minute}</integer></dict>`).join('')}</array>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${xml(path.join(logs, 'strategist-checkin.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logs, 'strategist-checkin.log'))}</string>
</dict></plist>
`;
}

function context(options) {
  const root = path.resolve(options.root);
  const home = path.resolve(options.home);
  const userHome = options.userHome || os.homedir();
  const label = labelFor(root);
  return {
    root,
    home,
    label,
    template: path.join(root, 'state', 'schedules', `${label}.plist`),
    agent: path.join(userHome, 'Library', 'LaunchAgents', `${label}.plist`),
    domain: `gui/${typeof process.getuid === 'function' ? process.getuid() : 0}`,
    run: options.run || ((command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })),
    platform: options.platform || process.platform,
    env: options.env || process.env,
  };
}

// Why the job must not be registered now, or null.
function registerBlocker(cfg, ctx, injected) {
  if (!isComplete(cfg)) return 'the check-in interview is not finished';
  if (cfg.enabled !== true) return 'the check-in is turned off';
  if (ctx.env.ALLSORTED_SKIP_SCHEDULE === '1') return 'ALLSORTED_SKIP_SCHEDULE=1 is set (test or setup run)';
  if (!injected && ctx.env.NODE_TEST_CONTEXT) return 'this is a test run';
  if (ctx.platform !== 'darwin') return 'the daily job is set up on macOS only; run "checkin run --now" yourself or schedule it with your system scheduler';
  return null;
}

function on(cfg, options) {
  const ctx = context(options);
  const blocker = registerBlocker(cfg, ctx, Boolean(options.run));
  if (blocker) return { ok: false, scheduled: false, label: ctx.label, reason: blocker };
  if (fs.existsSync(ctx.agent) && !ownsAgent(ctx)) return { ok: false, scheduled: false, label: ctx.label, reason: `another install already has a daily check-in job (${ctx.agent}); turn that one off first` };
  fs.mkdirSync(path.dirname(ctx.template), { recursive: true });
  fs.writeFileSync(ctx.template, plist({ root: ctx.root, home: ctx.home, cfg, nodePath: options.nodePath, label: ctx.label, now: options.now, systemZone: options.systemZone }), { mode: 0o600 });
  try { ctx.run('launchctl', ['bootout', `${ctx.domain}/${ctx.label}`]); } catch (e) { /* not loaded */ }
  fs.mkdirSync(path.dirname(ctx.agent), { recursive: true });
  if (fs.existsSync(ctx.agent) && fs.lstatSync(ctx.agent).isSymbolicLink()) throw new Error(`Refusing to replace a linked LaunchAgent: ${ctx.agent}`);
  fs.copyFileSync(ctx.template, ctx.agent);
  fs.chmodSync(ctx.agent, 0o644);
  try {
    ctx.run('launchctl', ['bootstrap', ctx.domain, ctx.agent]);
  } catch (e) {
    fs.rmSync(ctx.agent, { force: true });
    return { ok: false, scheduled: false, label: ctx.label, reason: `launchd refused the job: ${String(e.message).split('\n')[0]}` };
  }
  return { ok: true, scheduled: true, label: ctx.label, agent: ctx.agent, clock: localClock(cfg, options.now, options.systemZone) };
}

// True when the installed LaunchAgent runs this install root, so turning one
// install off never removes another install's job.
function ownsAgent(ctx) {
  try {
    if (fs.lstatSync(ctx.agent).isSymbolicLink()) return false;
    const match = /<key>WorkingDirectory<\/key><string>([^<]*)<\/string>/.exec(fs.readFileSync(ctx.agent, 'utf8'));
    if (!match) return false;
    const listed = match[1].replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
    const real = (value) => { try { return fs.realpathSync(value); } catch (e) { return path.resolve(value); } };
    return listed === ctx.root || real(listed) === real(ctx.root);
  } catch (e) {
    return false;
  }
}

function off(options) {
  const ctx = context(options);
  if (!ownsAgent(ctx)) return { ok: true, scheduled: false, label: ctx.label, removed: false };
  if (ctx.platform === 'darwin') {
    try { ctx.run('launchctl', ['bootout', `${ctx.domain}/${ctx.label}`]); } catch (e) { /* not loaded */ }
  }
  fs.rmSync(ctx.agent, { force: true });
  return { ok: true, scheduled: false, label: ctx.label, removed: true };
}

function status(options) {
  const ctx = context(options);
  let loaded = false;
  if (ctx.platform === 'darwin') {
    try { ctx.run('launchctl', ['print', `${ctx.domain}/${ctx.label}`]); loaded = true; } catch (e) { loaded = false; }
  }
  return { label: ctx.label, installed: fs.existsSync(ctx.agent), loaded, agent: ctx.agent };
}

module.exports = { LABEL, labelFor, localClock, minuteSlots, offsetMinutes, plist, on, off, status, registerBlocker, ownsAgent };
