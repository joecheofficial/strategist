#!/usr/bin/env node
'use strict';
/**
 * Strategist (member edition)
 *
 * A daily chief-of-staff for one business owner. It reads the business
 * config you wrote, your recent notes, your recent briefs, and your lessons
 * file, then convenes a seven-persona strategy council (via Claude Code)
 * and writes one short, direct brief to the briefs folder.
 *
 * Read-only on your business. It never sends messages, never touches
 * money, never calls any API except the local `claude` command line tool.
 *
 * Commands:
 *   node bin/strategist.js setup            create folders + starter config
 *   node bin/strategist.js brief            generate today's brief
 *   node bin/strategist.js brief --weekly   generate a weekly review instead
 *   node bin/strategist.js brief --print-prompt   write the prompt only (no Claude call)
 *   node bin/strategist.js focus "what I'm doing right now"   check for mid-day drift
 *   node bin/strategist.js triage "item one; item two; item three"   rank candidate priorities
 *   node bin/strategist.js decision "should I raise prices 20%"   frame a decision with the council
 *   node bin/strategist.js review           audit whether recent Top 3 priorities actually moved
 *   node bin/strategist.js check            validate config and environment
 *   node bin/strategist.js checkin interview   set up the daily check-in (see CHECKIN.md)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const VERSION = '2.7.1';
const PKG_ROOT = path.resolve(__dirname, '..');

function home() {
  return process.env.STRATEGIST_HOME || path.resolve(__dirname, '..');
}

function readIf(p, max) {
  try {
    let t = fs.readFileSync(p, 'utf8');
    if (max && t.length > max) t = t.slice(0, max) + '\n[... truncated ...]';
    return t;
  } catch (e) {
    return null;
  }
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function loadCouncil(root) {
  const override = path.join(root, 'config', 'council.json');
  return loadJson(fs.existsSync(override) ? override : path.join(PKG_ROOT, 'config', 'council.json'));
}

function loadConfig(root) {
  const p = path.join(root, 'config', 'business.json');
  if (!fs.existsSync(p)) return null;
  return loadJson(p);
}

function validateConfig(cfg) {
  const problems = [];
  if (!cfg || typeof cfg !== 'object') return ['config is not a JSON object'];
  if (!cfg.owner || /your name/i.test(String(cfg.owner))) {
    problems.push('owner: put your actual name in config/business.json');
  }
  if (!cfg.business || !cfg.business.name) {
    problems.push('business.name: describe your business in config/business.json');
  }
  if (!cfg.mission || !cfg.mission.statement) {
    problems.push('mission.statement: write down what you are actually trying to achieve');
  }
  if (!Array.isArray(cfg.goals) || cfg.goals.length === 0) {
    problems.push('goals: add at least one dated goal');
  }
  if (!Array.isArray(cfg.projects)) {
    problems.push('projects: list your active projects (an empty list is allowed)');
  }
  return problems;
}

// Pinned notes are live state files (notes/_leads.md, notes/_open-invoices.md)
// that the owner or their agents keep current. They are always read, in name
// order, whether or not they changed today. Ordinary notes are the newest few.
const PINNED_NOTE_MAX_CHARS = 4000;
const NOTE_MAX_CHARS = 8000;

function isPinnedNote(file) {
  return /^_.*\.md$/i.test(file);
}

function gatherNotes(root, limit) {
  const dir = path.join(root, 'notes');
  if (!fs.existsSync(dir)) return null;
  // statSync follows symbolic links, so a state file linked into notes/ counts.
  const entries = fs.readdirSync(dir).filter((f) => {
    if (!/\.(md|txt)$/i.test(f)) return false;
    try {
      return fs.statSync(path.join(dir, f)).isFile();
    } catch (e) {
      return false;
    }
  });
  const pinned = entries
    .filter(isPinnedNote)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const ordinary = entries
    .filter((f) => !isPinnedNote(f))
    .map((f) => {
      const p = path.join(dir, f);
      return { file: f, path: p, mtime: fs.statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime || (a.file < b.file ? -1 : 1))
    .slice(0, limit || 5);
  if (pinned.length === 0 && ordinary.length === 0) return null;
  const blocks = pinned.map(
    (f) => `--- pinned note: ${f} ---\n${readIf(path.join(dir, f), PINNED_NOTE_MAX_CHARS) || ''}`
  );
  for (const f of ordinary) {
    blocks.push(`--- note: ${f.file} ---\n${readIf(f.path, NOTE_MAX_CHARS) || ''}`);
  }
  return blocks.join('\n\n');
}

// Fill {{PLACEHOLDERS}} in one pass with a replacer function, so text that
// contains $&, $$ or $' (prices, shell snippets) is copied literally and a
// value that happens to contain {{ANOTHER}} is never filled a second time.
function fillTemplate(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  );
}

function recentBriefs(root, limit) {
  const dir = path.join(root, 'briefs');
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.md$/i.test(f) && !/-prompt\.md$/i.test(f))
    .sort()
    .reverse()
    .slice(0, limit || 3);
  if (files.length === 0) return null;
  return files
    .map((file) => `--- Brief from ${file.replace(/\.md$/i, '')} ---\n${readIf(path.join(dir, file), 3500) || ''}`)
    .join('\n\n');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function buildPrompt(opts) {
  const root = (opts && opts.root) || home();
  const weekly = !!(opts && opts.weekly);
  const template = fs.readFileSync(
    path.join(PKG_ROOT, 'prompts', 'council-brief-prompt.md'),
    'utf8'
  );
  const council = loadCouncil(root);
  const cfg =
    loadConfig(root) ||
    loadJson(
      fs.existsSync(path.join(root, 'config', 'business.example.json'))
        ? path.join(root, 'config', 'business.example.json')
        : path.join(PKG_ROOT, 'config', 'business.example.json')
    );
  const notes = gatherNotes(root, 5);
  const previousBriefs = recentBriefs(root, 3);
  const learning = readIf(path.join(root, 'LEARNING.md'), 8000);
  return fillTemplate(template, {
    TODAY: today(),
    MODE: weekly ? 'WEEKLY REVIEW' : 'DAILY BRIEF',
    COUNCIL_JSON: JSON.stringify(council, null, 2),
    BUSINESS_JSON: JSON.stringify(cfg, null, 2),
    NOTES: notes || 'No recent notes provided.',
    PREVIOUS_BRIEFS: previousBriefs || '(no previous briefs yet)',
    LEARNING: learning || 'No lessons recorded yet.',
  });
}

function buildTriagePrompt(root, itemsText) {
  const template = fs.readFileSync(
    path.join(PKG_ROOT, 'prompts', 'triage-prompt.md'),
    'utf8'
  );
  const cfg =
    loadConfig(root) ||
    loadJson(
      fs.existsSync(path.join(root, 'config', 'business.example.json'))
        ? path.join(root, 'config', 'business.example.json')
        : path.join(PKG_ROOT, 'config', 'business.example.json')
    );
  const items = String(itemsText || '')
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const itemsBlock = items.length
    ? items.map((item, index) => `${index + 1}. ${item}`).join('\n')
    : 'No items provided; triage using only the business config goals, moneyWatch, and active projects.';
  return fillTemplate(template, {
    TODAY: today(),
    BUSINESS_JSON: JSON.stringify(cfg, null, 2),
    ITEMS: itemsBlock,
  });
}

function buildDecisionPrompt(root, decisionText) {
  const template = fs.readFileSync(
    path.join(PKG_ROOT, 'prompts', 'decision-council-prompt.md'),
    'utf8'
  );
  const council = loadCouncil(root);
  const cfg =
    loadConfig(root) ||
    loadJson(
      fs.existsSync(path.join(root, 'config', 'business.example.json'))
        ? path.join(root, 'config', 'business.example.json')
        : path.join(PKG_ROOT, 'config', 'business.example.json')
    );
  return fillTemplate(template, {
    TODAY: today(),
    COUNCIL_JSON: JSON.stringify(council, null, 2),
    BUSINESS_JSON: JSON.stringify(cfg, null, 2),
    DECISION: decisionText,
  });
}

function buildReviewPrompt(root) {
  const template = fs.readFileSync(
    path.join(PKG_ROOT, 'prompts', 'follow-through-review-prompt.md'),
    'utf8'
  );
  const recent = recentBriefs(root, 7);
  return fillTemplate(template, {
    TODAY: today(),
    RECENT_BRIEFS: recent || '(no previous briefs yet)',
  });
}

function buildFocusPrompt(root, activity) {
  const template = fs.readFileSync(
    path.join(PKG_ROOT, 'prompts', 'focus-check-prompt.md'),
    'utf8'
  );
  const brief = readIf(path.join(root, 'briefs', today() + '.md'), 6000);
  const cfg =
    loadConfig(root) ||
    loadJson(
      fs.existsSync(path.join(root, 'config', 'business.example.json'))
        ? path.join(root, 'config', 'business.example.json')
        : path.join(PKG_ROOT, 'config', 'business.example.json')
    );
  const mission = cfg.mission && cfg.mission.statement
    ? cfg.mission.statement
    : 'No mission statement is available.';
  const briefContext = brief ||
    `No brief exists for today. Grade this activity against the mission: ${mission}`;
  return fillTemplate(template, {
    TODAY: today(),
    TODAYS_BRIEF: briefContext,
    CURRENT_ACTIVITY: activity,
  });
}

function claudeAvailable() {
  const res = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  return !res.error && res.status === 0;
}

function runClaude(prompt) {
  const res = spawnSync('claude', ['-p'], {
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    const detail = res.error
      ? 'the claude command line tool is unavailable'
      : (res.stderr || '').trim() || 'claude exited with status ' + res.status;
    return { ok: false, detail };
  }
  return { ok: true, text: (res.stdout || '').trim() };
}

function ensureDirs(root) {
  for (const d of ['config', 'notes', 'briefs']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
}

function cmdSetup(root) {
  ensureDirs(root);
  const cfgPath = path.join(root, 'config', 'business.json');
  if (!fs.existsSync(cfgPath)) {
    fs.copyFileSync(
      fs.existsSync(path.join(root, 'config', 'business.example.json'))
        ? path.join(root, 'config', 'business.example.json')
        : path.join(PKG_ROOT, 'config', 'business.example.json'),
      cfgPath
    );
    console.log('Created config/business.json from the example.');
  } else {
    console.log('config/business.json already exists, leaving it alone.');
  }
  console.log('');
  console.log('Next steps:');
  console.log('  1. Open config/business.json and replace every example value');
  console.log('     with the truth about YOUR business, mission, and goals.');
  console.log('  2. Optional: drop short notes about what happened this week');
  console.log('     into the notes/ folder as .md or .txt files.');
  console.log('  3. Run: node bin/strategist.js brief');
  return 0;
}

function cmdCheck(root) {
  let failed = false;
  console.log('Strategist ' + VERSION);
  console.log('Home: ' + root);
  const cfg = loadConfig(root);
  if (!cfg) {
    console.log('Config: MISSING. Run: node bin/strategist.js setup');
    failed = true;
  } else {
    const problems = validateConfig(cfg);
    if (problems.length === 0) {
      console.log('Config: ok');
    } else {
      console.log('Config: needs attention');
      for (const p of problems) console.log('  - ' + p);
      failed = true;
    }
  }
  const notesDir = path.join(root, 'notes');
  const briefsDir = path.join(root, 'briefs');
  const count = (d, re) =>
    fs.existsSync(d) ? fs.readdirSync(d).filter((f) => re.test(f)).length : 0;
  console.log('Notes: ' + count(notesDir, /\.(md|txt)$/i));
  console.log('Briefs: ' + count(briefsDir, /\.md$/i));
  console.log('Focus: ready (uses today\'s brief when present)');
  if (claudeAvailable()) {
    console.log('Claude Code CLI: found');
  } else {
    console.log(
      'Claude Code CLI: not found. Briefs will fall back to writing a prompt file you paste into Claude yourself.'
    );
  }
  return failed ? 1 : 0;
}

function cmdFocus(root, activity) {
  if (!activity) {
    console.error('Tell Strategist what you are doing. Example: node bin/strategist.js focus "reviewing a client proposal"');
    return 1;
  }
  ensureDirs(root);
  const prompt = buildFocusPrompt(root, activity);
  const promptPath = path.join(root, 'briefs', today() + '-focus-prompt.md');
  const res = runClaude(prompt);
  if (!res.ok) {
    fs.writeFileSync(promptPath, prompt);
    console.error('Could not run the claude command line tool: ' + res.detail);
    console.error('Fallback: the full prompt was saved to ' + promptPath);
    console.error('Paste its contents into Claude to get your focus check.');
    return 1;
  }
  console.log(res.text);
  return 0;
}

function cmdTriage(root, itemsText) {
  ensureDirs(root);
  const prompt = buildTriagePrompt(root, itemsText);
  const promptPath = path.join(root, 'briefs', today() + '-triage-prompt.md');
  const res = runClaude(prompt);
  if (!res.ok) {
    fs.writeFileSync(promptPath, prompt);
    console.error('Could not run the claude command line tool: ' + res.detail);
    console.error('Fallback: the full prompt was saved to ' + promptPath);
    console.error('Paste its contents into Claude to get your triage.');
    return 1;
  }
  console.log(res.text);
  return 0;
}

function cmdDecision(root, decisionText) {
  if (!decisionText) {
    console.error('Tell Strategist what decision you are weighing. Example: node bin/strategist.js decision "should I raise prices 20% for new members"');
    return 1;
  }
  ensureDirs(root);
  const prompt = buildDecisionPrompt(root, decisionText);
  const promptPath = path.join(root, 'briefs', today() + '-decision-prompt.md');
  const res = runClaude(prompt);
  if (!res.ok) {
    fs.writeFileSync(promptPath, prompt);
    console.error('Could not run the claude command line tool: ' + res.detail);
    console.error('Fallback: the full prompt was saved to ' + promptPath);
    console.error('Paste its contents into Claude to get the council\'s take.');
    return 1;
  }
  console.log(res.text);
  return 0;
}

function cmdReview(root) {
  ensureDirs(root);
  const prompt = buildReviewPrompt(root);
  const promptPath = path.join(root, 'briefs', today() + '-review-prompt.md');
  const res = runClaude(prompt);
  if (!res.ok) {
    fs.writeFileSync(promptPath, prompt);
    console.error('Could not run the claude command line tool: ' + res.detail);
    console.error('Fallback: the full prompt was saved to ' + promptPath);
    console.error('Paste its contents into Claude to get your review.');
    return 1;
  }
  console.log(res.text);
  return 0;
}

function cmdBrief(root, opts) {
  const cfg = loadConfig(root);
  if (!cfg) {
    console.error(
      'No config yet. Run: node bin/strategist.js setup, then edit config/business.json.'
    );
    return 1;
  }
  const problems = validateConfig(cfg);
  if (problems.length > 0) {
    console.error('Heads up, your config still has gaps:');
    for (const p of problems) console.error('  - ' + p);
    console.error('The brief will be weaker until you fix these.\n');
  }
  ensureDirs(root);
  const prompt = buildPrompt({ root, weekly: opts.weekly });
  const stamp = today() + (opts.weekly ? '-weekly' : '');
  const promptPath = path.join(root, 'briefs', stamp + '-prompt.md');

  if (opts.printPrompt) {
    fs.writeFileSync(promptPath, prompt);
    console.log('Prompt written to: ' + promptPath);
    console.log('Paste its contents into Claude to get your brief.');
    return 0;
  }

  console.error('[strategist] convening the council via Claude Code...');
  const res = runClaude(prompt);
  if (!res.ok) {
    fs.writeFileSync(promptPath, prompt);
    console.error('Could not run the claude command line tool: ' + res.detail);
    console.error('Fallback: the full prompt was saved to ' + promptPath);
    console.error('Paste its contents into Claude to get your brief.');
    return 1;
  }
  const outPath = path.join(root, 'briefs', stamp + '.md');
  fs.writeFileSync(outPath, res.text + '\n');
  console.log(res.text);
  console.error('\n[strategist] brief saved to ' + outPath);
  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] && !args[0].startsWith('--') ? args[0] : 'brief';
  const opts = {
    weekly: args.includes('--weekly'),
    printPrompt: args.includes('--print-prompt'),
  };
  const root = home();
  let code;
  if (command !== 'checkin' && !process.env.ALLSORTED_SCHEDULED && !process.env.ALLSORTED_UNATTENDED) {
    const checkin = require('../lib/checkin-cli');
    const ctx = checkin.locate(root);
    const notice = checkin.offer(ctx);
    if (notice) console.log(notice + '\n');
  }
  if (command === 'checkin') {
    // The daily check-in has its own commands and settings (CHECKIN.md).
    require('../lib/checkin-cli').main(args.slice(1), { home: root }).then(
      (result) => { if (result.text) console.log(result.text); process.exit(result.code); },
      (e) => { console.error('[strategist] ' + String(e && e.message ? e.message : e)); process.exit(1); }
    );
    return;
  }
  if (command === 'setup') code = cmdSetup(root);
  else if (command === 'check') code = cmdCheck(root);
  else if (command === 'brief') {
    try {
      code = cmdBrief(root, opts);
    } catch (e) {
      console.error('[strategist] error: ' + String(e && e.message ? e.message : e).replace(/\s+/g, ' ').trim());
      code = 1;
    }
  } else if (command === 'focus') {
    try {
      code = cmdFocus(root, args.slice(1).join(' ').trim());
    } catch (e) {
      console.error('[strategist] error: ' + String(e && e.message ? e.message : e).replace(/\s+/g, ' ').trim());
      code = 1;
    }
  } else if (command === 'triage') {
    try {
      code = cmdTriage(root, args.slice(1).join(' ').trim());
    } catch (e) {
      console.error('[strategist] error: ' + String(e && e.message ? e.message : e).replace(/\s+/g, ' ').trim());
      code = 1;
    }
  } else if (command === 'decision') {
    try {
      code = cmdDecision(root, args.slice(1).join(' ').trim());
    } catch (e) {
      console.error('[strategist] error: ' + String(e && e.message ? e.message : e).replace(/\s+/g, ' ').trim());
      code = 1;
    }
  } else if (command === 'review') {
    try {
      code = cmdReview(root);
    } catch (e) {
      console.error('[strategist] error: ' + String(e && e.message ? e.message : e).replace(/\s+/g, ' ').trim());
      code = 1;
    }
  }
  else {
    console.error('Unknown command: ' + command);
    console.error('Commands: setup, brief [--weekly] [--print-prompt], focus "current activity", triage "item one; item two", decision "the decision", review, check, checkin');
    code = 1;
  }
  process.exit(code);
}

if (require.main === module) main();

module.exports = {
  VERSION,
  home,
  loadCouncil,
  loadConfig,
  validateConfig,
  gatherNotes,
  fillTemplate,
  PINNED_NOTE_MAX_CHARS,
  NOTE_MAX_CHARS,
  recentBriefs,
  buildPrompt,
  buildFocusPrompt,
  buildTriagePrompt,
  buildDecisionPrompt,
  buildReviewPrompt,
};
