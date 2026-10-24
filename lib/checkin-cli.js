'use strict';
/**
 * `strategist checkin ...`: the daily check-in.
 *
 *   checkin interview [answers]   set it up (asks the questions when run in a terminal)
 *   checkin set [answers]         change any answer, for example --to or --time
 *   checkin show                  print the current settings
 *   checkin run --now             make today's check-in now
 *   checkin run --dry-run         show today's check-in without sending or saving
 *   checkin on | off              turn the daily job on or off (answers are kept)
 *   checkin status                settings plus the daily job's state
 *
 * Answers: --sections priorities,money,pipeline,calendar,relationships,risks
 *          --matters "what matters most"  --time 07:30  --timezone Europe/London
 *          --deliver email|local  --to <your own address>
 *          --metered-api on|off  --daily-cap 0.50
 */
const fs = require('fs');
const path = require('path');
const config = require('./checkin-config');
const brief = require('./checkin-brief');
const model = require('./checkin-model');
const deliver = require('./checkin-deliver');
const schedule = require('./checkin-schedule');

const PKG_ROOT = path.resolve(__dirname, '..');
const FLAGS = {
  '--sections': 'sections', '--matters': 'mattersMost', '--time': 'time', '--timezone': 'timeZone',
  '--deliver': 'deliver', '--to': 'to', '--metered-api': 'meteredApi', '--daily-cap': 'dailyCapUsd',
};
const USAGE = [
  'Daily check-in commands (node strategist/bin/strategist.js checkin ...):',
  '  interview [answers]   set it up; asks the questions when run in a terminal',
  '  set [answers]         change any answer, for example --to or --time',
  '  show                  print the current settings',
  '  run --now             make today\'s check-in now',
  '  run --dry-run         show today\'s check-in without sending or saving',
  '  on | off              turn the daily job on or off (your answers are kept)',
  'Answers: --sections priorities,money,pipeline,calendar,relationships,risks',
  '         --matters "what matters most"  --time 07:30  --timezone Europe/London',
  '         --deliver email|local  --to <your own address>  --metered-api on|off  --daily-cap 0.50',
].join('\n');
const SWITCHES = ['--now', '--scheduled', '--dry-run', '--data-only', '--no-schedule', '--json'];

function parseArgs(argv) {
  const answers = {};
  const switches = new Set();
  let root = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (FLAGS[arg]) {
      if (index + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      answers[FLAGS[arg]] = argv[++index];
    } else if (arg === '--root') {
      root = argv[++index];
      if (!root) throw new Error('--root needs a folder');
    } else if (SWITCHES.includes(arg)) switches.add(arg);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return { answers, switches, root };
}

// <root>/strategist is the installed home, so the install root is its parent
// when that parent is an All Sorted install. A standalone copy keeps all of
// its state inside its own folder.
function locate(home, rootFlag) {
  const resolvedHome = path.resolve(home);
  if (rootFlag || process.env.ALLSORTED_ROOT) return { home: resolvedHome, root: path.resolve(rootFlag || process.env.ALLSORTED_ROOT) };
  const parent = path.dirname(resolvedHome);
  const isInstall = ['allsorted-dist.lock.json', path.join('bin', 'as-run'), '.allsorted-update-runtime'].some((name) => fs.existsSync(path.join(parent, name)));
  return { home: resolvedHome, root: isInstall ? parent : resolvedHome };
}

function markNext(root, status) {
  try {
    deliver.writePrivate(root, path.join(root, 'state', 'strategist-checkin-next.json'), JSON.stringify({ task: 'strategist-daily-checkin', status, resumeWith: ['set up my daily check-in'], updatedAt: new Date().toISOString() }, null, 2) + '\n');
  } catch (e) { /* a marker is a convenience only */ }
}

function offer(ctx) {
  let notice = '';
  try { notice = JSON.parse(fs.readFileSync(path.join(ctx.root, 'state', 'strategist-checkin-attention.json'), 'utf8')).message || ''; } catch { /* no notice */ }
  if (config.isComplete(config.readConfig(ctx.home))) return notice;
  const marker = path.join(ctx.root, 'state', 'strategist-checkin-next.json');
  try {
    const state = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (['offered', 'done', 'declined'].includes(state.status)) return notice;
  } catch (error) { if (error.code !== 'ENOENT') return ''; }
  markNext(ctx.root, 'offered');
  return (notice ? notice + '\n' : '') + 'Want a short check-in every morning? Say "set up my daily check-in" for six quick questions, or "not now" to leave it for later. Interview prompt: ' + path.join(PKG_ROOT, 'prompts', 'checkin-interview.md');
}

async function ask(questions) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answers = {};
  try {
    for (const [key, question] of questions) {
      answers[key] = await new Promise((resolve) => rl.question(question, resolve));
    }
  } finally {
    rl.close();
  }
  return answers;
}

function interviewQuestions(current, own) {
  const t = current.time;
  return [
    ['sections', `What do you want to see each morning? Pick any of: ${config.SECTIONS.join(', ')}\n  [${current.sections.join(',')}] > `],
    ['mattersMost', `What matters most to you right now, in one or two sentences?\n  ${current.mattersMost ? `[${current.mattersMost}] ` : ''}> `],
    ['time', `What time should it arrive? (24-hour, for example 07:30)\n  [${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}] > `],
    ['timeZone', `Which time zone?\n  [${current.timeZone}] > `],
    ['deliver', `Where should it go? "email" (to yourself) or "local" (kept on this computer and shown in Mission Control)\n  [${current.delivery.method}] > `],
    ['to', `Which of your own email addresses?\n  [${current.delivery.to || own[0] || 'none known yet'}] > `],
  ];
}

function finishAnswers(cfg, own) {
  if (cfg.delivery.method === 'email' && !cfg.delivery.to) {
    if (own.length) cfg.delivery.to = own[0];
    else cfg.delivery.method = 'local';
  }
  return cfg;
}

function help(home) {
  const bin = path.join(home, 'bin', 'strategist.js');
  return [
    'Change it any time:',
    `  node "${bin}" checkin interview           ask the questions again`,
    `  node "${bin}" checkin set --to <your own address>   send to another of your own addresses`,
    `  node "${bin}" checkin set --deliver local  keep it on this computer instead of email`,
    `  node "${bin}" checkin set --time 08:00     change the time`,
    `  node "${bin}" checkin off                  stop the daily job (your answers are kept)`,
    `Or edit ${config.configPath(home)} and run "checkin on" again.`,
  ].join('\n');
}

function scheduleAfterSave(cfg, ctx, switches, options) {
  if (switches.has('--no-schedule')) return 'Daily job: not changed (--no-schedule).';
  const result = schedule.on(cfg, { root: ctx.root, home: ctx.home, ...options.schedule });
  return result.ok ? `Daily job: on (${result.label}).` : `Daily job: not set up, because ${result.reason}.`;
}

async function cmdInterview(ctx, parsed, options, { requireAll }) {
  const current = config.readConfig(ctx.home) || config.defaults();
  const own = deliver.ownAddresses(ctx.root);
  let answers = parsed.answers;
  const interactive = Object.keys(answers).length === 0 && process.stdin.isTTY && !options.noPrompt;
  if (interactive) {
    answers = await ask(interviewQuestions(current, own));
    for (let tries = 0; tries < 3 && !String(answers.mattersMost || '').trim() && !current.mattersMost; tries += 1) {
      Object.assign(answers, await ask([['mattersMost', 'This one is needed: what matters most to you right now? > ']]));
    }
  }
  else if (requireAll && Object.keys(answers).length === 0) {
    throw new Error('Give the answers as options (see "checkin help"), or run this in a terminal to be asked.');
  }
  const cfg = finishAnswers(config.applyAnswers(current, answers), own);
  if (requireAll || !cfg.completedAt) {
    cfg.completedAt = new Date().toISOString();
    cfg.enabled = true;
  }
  config.writeConfig(ctx.home, cfg);
  markNext(ctx.root, 'done');
  const lines = ['Saved your daily check-in settings.', config.describe(cfg)];
  if (cfg.delivery.method === 'email' && !deliver.isOwnAddress(ctx.root, cfg.delivery.to)) {
    lines.push(`Note: ${cfg.delivery.to} is not yet an address this install knows as yours, so the check-in will be kept on this computer until it is. Set "ownerEmail" in email-agent/config/email-agent.config.json to it.`);
  }
  lines.push(cfg.enabled ? scheduleAfterSave(cfg, ctx, parsed.switches, options) : 'Daily job: off (run "checkin on" to turn it on).');
  lines.push(help(ctx.home));
  return { code: 0, text: lines.join('\n') };
}

function receiptPath(home, date) {
  return path.join(home, 'briefs', 'checkin-receipts', `${date}.json`);
}

function readReceiptFile(home, date) {
  try {
    const value = JSON.parse(fs.readFileSync(receiptPath(home, date), 'utf8'));
    if (value && Array.isArray(value.runs)) return value;
    // An older single-run receipt still counts as delivered.
    return { date, delivered: value && value.delivered ? value.delivered : null, runs: value ? [value] : [] };
  } catch (e) {
    return { date, delivered: null, runs: [] };
  }
}

// What today's runs add up to. A send attempt whose receipt was never written
// (only its .sending marker exists) still counts as made.
function readReceipt(home, date) {
  const receipt = readReceiptFile(home, date);
  if (!receipt.delivered && fs.existsSync(sendingPath(home, date))) receipt.delivered = 'email-unclear';
  return receipt;
}

// Written before every send: a send whose receipt could not be written still
// counts as made, so no later wake that day sends it again.
function sendingPath(home, date) {
  return path.join(home, 'briefs', 'checkin-receipts', `${date}.sending`);
}

// One receipt per day, every run appended; `delivered` is the first delivery.
function recordRun(ctx, date, run) {
  const receipt = readReceiptFile(ctx.home, date);
  receipt.runs.push(run);
  if (!receipt.delivered && run.delivered) receipt.delivered = run.delivered;
  deliver.writePrivate(ctx.root, receiptPath(ctx.home, date), JSON.stringify(receipt, null, 2) + '\n', [deliver.briefsBase(ctx.home)]);
  return receipt;
}

// A scheduled run that cannot do its job leaves a receipt and a Mission Control
// note, so a check-in that stopped arriving is never a silent mystery.
function recordFailure(ctx, cfg, now, reason, detail) {
  const zone = cfg && config.validTimeZone(cfg.timeZone) ? cfg.timeZone : config.systemTimeZone();
  const date = brief.dateIn(zone, now);
  try {
    recordRun(ctx, date, { at: new Date(now).toISOString(), scheduled: true, delivered: null, status: 'failed', reason, detail: String(detail || '').slice(0, 300) });
    deliver.saveLocal({ home: ctx.home, root: ctx.root, date, text: `Today's check-in could not be made: ${String(detail || reason).slice(0, 300)}`, note: 'Run: node strategist/bin/strategist.js checkin show, then checkin run --now to see what needs fixing.' });
  } catch (e) { /* the launchd log still has the error */ }
}

// The run proceeds at or after the chosen time in the chosen zone.
function dueNow(cfg, now) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: cfg.timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(now));
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  return get('hour') * 60 + get('minute') >= cfg.time.hour * 60 + cfg.time.minute;
}

async function cmdRun(ctx, parsed, options) {
  const scheduled = parsed.switches.has('--scheduled');
  const now = options.now || Date.now();
  if (!scheduled) return makeCheckin(ctx, parsed, options, now);
  let cfg = null;
  try {
    cfg = config.readConfig(ctx.home);
    return await makeCheckin(ctx, parsed, options, now);
  } catch (e) {
    recordFailure(ctx, cfg, now, 'error', e && e.message);
    return { code: 1, text: `The daily check-in failed: ${e && e.message}` };
  }
}

async function makeCheckin(ctx, parsed, options, now) {
  const scheduled = parsed.switches.has('--scheduled');
  const dryRun = parsed.switches.has('--dry-run');
  const env = options.env || process.env;
  const unattended = scheduled || env.ALLSORTED_SCHEDULED === '1' || env.ALLSORTED_UNATTENDED === '1';
  const cfg = config.readConfig(ctx.home);
  if (!cfg || !cfg.completedAt) {
    return { code: scheduled ? 0 : 1, text: 'The daily check-in is not set up yet, so nothing was made. Run: node strategist/bin/strategist.js checkin interview' };
  }
  if (scheduled && cfg.enabled !== true) return { code: 0, text: 'The daily check-in is turned off, so this scheduled run did nothing.' };
  const problems = config.validate(cfg);
  if (scheduled && !dryRun) {
    const zone = config.validTimeZone(cfg.timeZone) ? cfg.timeZone : config.systemTimeZone();
    const valid = problems.length === 0;
    if (valid && !dueNow(cfg, now)) return { code: 0, text: '' };
    const receipt = readReceipt(ctx.home, brief.dateIn(zone, now));
    // Quiet once today's check-in is made, or after three failed tries today.
    if (receipt.delivered || receipt.runs.filter((run) => run.status === 'failed').length >= 3) return { code: 0, text: '' };
  }
  if (problems.length) {
    if (scheduled) recordFailure(ctx, cfg, now, 'settings_invalid', `the settings need fixing: ${problems.join('; ')}`);
    return { code: 1, text: `The check-in settings need fixing, so nothing was made:\n  - ${problems.join('\n  - ')}\nRun: node strategist/bin/strategist.js checkin interview` };
  }
  if (scheduled && !dryRun) {
    // Prove today's receipt can be written before any model call or send, so a
    // broken receipts folder can never turn the quarter-hour wakes into repeats.
    deliver.writePrivate(ctx.root, path.join(ctx.home, 'briefs', 'checkin-receipts', `${brief.dateIn(cfg.timeZone, now)}.started`), JSON.stringify({ at: new Date(now).toISOString() }) + '\n', [deliver.briefsBase(ctx.home)]);
  }
  const data = brief.gatherData({ home: ctx.home, root: ctx.root, cfg, now, deps: options.deps });
  const draft = brief.dataBrief(data, cfg, 'Data only.');
  let outcome = { route: 'data-only', attempts: [{ route: 'model', reason: 'data_only_requested' }] };
  // A dry run is a free preview: it never calls a model.
  if (!parsed.switches.has('--data-only') && !dryRun) {
    const template = fs.readFileSync(path.join(PKG_ROOT, 'prompts', 'daily-checkin-prompt.md'), 'utf8');
    const { fillTemplate } = require('../bin/strategist.js');
    const prompt = brief.modelPrompt({ template, data, cfg, draft, fill: fillTemplate });
    outcome = await model.writeWithModel({ root: ctx.root, prompt, cfg, scheduled: unattended, env, now, deps: options.deps || {} });
  }
  if (unattended) {
    const noticeFile = path.join(ctx.root, 'state', 'strategist-checkin-attention.json');
    if (outcome.route === 'data-only') {
      deliver.writePrivate(ctx.root, noticeFile, JSON.stringify({message:'Your daily check-in used data only because the native login could not answer. Open your normal Claude Code or Codex session, check sign-in, then say "make my daily check-in". No API fallback was enabled.',at:new Date(now).toISOString()}) + '\n');
    } else { try { fs.unlinkSync(noticeFile); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  const why = outcome.attempts.map((attempt) => model.explain(attempt.reason)).join('; ');
  const routeName = { 'claude-code': 'your Claude Code login', 'safe-oauth': 'your own login (Safe OAuth)', 'metered-api': 'your metered Anthropic API key, within your daily cap' }[outcome.route];
  const text = outcome.route === 'data-only'
    ? brief.dataBrief(data, cfg, `Data only, from your files, with no model${why ? `: ${why}` : ''}.`)
    : `${outcome.text.replace(/\*How this was made\*[\s\S]*$/, '').trim()}\n\n*How this was made*\nWritten by ${routeName} from your files.`;
  const subject = `Your daily check-in, ${data.today}`;
  if (dryRun) return { code: 0, text: `${subject}\n\n${text}\n\n(Dry run: a data-only preview. Nothing was sent, saved or spent.)` };

  const run = { at: new Date(now).toISOString(), scheduled, route: outcome.route, attempts: outcome.attempts, delivered: null, emailId: null, reason: null };
  let note = null;
  if (cfg.delivery.method === 'email') {
    const route = await deliver.emailRoute({ root: ctx.root, to: cfg.delivery.to, client: options.deps && options.deps.mailClient });
    let intent = false;
    if (route.ok) {
      try {
        deliver.writePrivate(ctx.root, sendingPath(ctx.home, data.today), JSON.stringify({ at: new Date(now).toISOString() }) + '\n', [deliver.briefsBase(ctx.home)]);
        intent = true;
      } catch (e) {
        run.reason = 'receipt_not_writable';
        note = `The email was not sent, because today's receipt could not be written: ${e.message}`;
      }
    }
    if (route.ok && intent) {
      const sent = await deliver.sendEmail({ route, subject, text, date: data.today });
      if (sent.ok) { run.delivered = 'email'; run.emailId = sent.id; }
      else { run.reason = sent.reason; note = sent.reason === 'provider_outcome_unknown' ? 'The email may or may not have gone out; it was not retried. Check your inbox.' : 'Your mail sender refused the email.'; }
      // Record a send, or an unclear send, before anything else can fail, so a
      // later run the same day never sends it again.
      if (sent.ok || sent.reason === 'provider_outcome_unknown') {
        try { recordRun(ctx, data.today, { ...run, delivered: run.delivered || 'email-unclear' }); } catch (e) { /* the .sending marker still stops a resend */ }
      }
    } else if (!route.ok) {
      run.reason = route.reason;
      note = `${route.message}\n\n${deliver.CONNECT_EMAIL_HELP}`;
    }
  } else {
    run.reason = 'local_delivery_chosen';
  }
  let saved = { briefPath: null, missionControl: null };
  try {
    saved = deliver.saveLocal({ home: ctx.home, root: ctx.root, date: data.today, text, note });
  } catch (e) {
    if (!run.delivered) throw e;
    note = `${note ? `${note}\n` : ''}The local copy could not be saved: ${e.message}`;
  }
  const emailed = run.delivered === 'email' || run.reason === 'provider_outcome_unknown';
  if (!run.delivered) run.delivered = 'local';
  run.saved = { brief: saved.briefPath, missionControl: saved.missionControl };
  if (!emailed) {
    try { recordRun(ctx, data.today, run); }
    catch (e) {
      if (scheduled) throw e;
      note = `${note ? `${note}\n` : ''}Today's receipt could not be written: ${e.message}`;
    }
  }
  const lines = [run.delivered === 'email' ? `Sent today's check-in to ${cfg.delivery.to}.` : saved.briefPath ? `Saved today's check-in to ${saved.briefPath}${saved.missionControl ? ' and Mission Control (Memory)' : ''}.` : 'The email outcome is unclear and the local copy could not be saved.'];
  if (note) lines.push(note);
  if (!scheduled) lines.push('', text);
  return { code: 0, text: lines.join('\n') };
}

async function main(argv, options = {}) {
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'status';
  if (command === 'help') return { code: 0, text: USAGE };
  const parsed = parseArgs(argv.slice(command === argv[0] ? 1 : 0));
  const ctx = locate(options.home || process.env.STRATEGIST_HOME || PKG_ROOT, parsed.root);
  options.schedule = options.schedule || {};
  if (command === 'offer') return { code: 0, text: offer(ctx) };
  if (command === 'decline') { markNext(ctx.root, 'declined'); return { code: 0, text: 'Daily check-in setup left for later. Say "set up my daily check-in" any time.' }; }
  if (command === 'interview') return cmdInterview(ctx, parsed, options, { requireAll: true });
  if (command === 'set') {
    if (!config.readConfig(ctx.home)) throw new Error('Run "checkin interview" first.');
    return cmdInterview(ctx, parsed, options, { requireAll: false });
  }
  if (command === 'show' || command === 'status') {
    const cfg = config.readConfig(ctx.home);
    if (!cfg) return { code: 0, text: 'The daily check-in is not set up yet. Run: node strategist/bin/strategist.js checkin interview' };
    const job = schedule.status({ root: ctx.root, home: ctx.home, ...options.schedule });
    return { code: 0, text: `${config.describe(cfg)}\nDaily job: ${job.installed ? (job.loaded ? 'on' : 'installed, not loaded') : 'off'} (${job.label})\n\n${help(ctx.home)}` };
  }
  if (command === 'run') return cmdRun(ctx, parsed, options);
  if (command === 'on') {
    const cfg = config.readConfig(ctx.home);
    if (!config.isComplete(cfg)) return { code: 1, text: 'Finish the check-in interview first: node strategist/bin/strategist.js checkin interview' };
    cfg.enabled = true;
    config.writeConfig(ctx.home, cfg);
    return { code: 0, text: scheduleAfterSave(cfg, ctx, parsed.switches, options) };
  }
  if (command === 'off') {
    // The job is removed even when the settings file cannot be updated.
    const result = schedule.off({ root: ctx.root, home: ctx.home, ...options.schedule });
    try {
      const cfg = config.readConfig(ctx.home);
      if (cfg) { cfg.enabled = false; config.writeConfig(ctx.home, cfg); }
    } catch (e) {
      return { code: 1, text: `The daily job was removed, but the settings could not be updated: ${e.message}` };
    }
    return { code: 0, text: `The daily check-in is off${result.removed ? ' and its job was removed' : ''}. Your answers are kept; "checkin on" turns it back on.` };
  }
  throw new Error(`Unknown checkin command: ${command}. Try: interview, set, show, run, on, off, status`);
}

module.exports = { offer, main, parseArgs, locate, finishAnswers, receiptPath, readReceipt, dueNow, sendingPath };
