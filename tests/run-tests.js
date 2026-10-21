#!/usr/bin/env node
'use strict';
/**
 * Strategist structural tests. No network, no Claude call, no writes outside
 * a temp folder. Exit 0 = all good.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const strategist = require(path.join(ROOT, 'bin', 'strategist.js'));

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('ok   ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + ' :: ' + e.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// Build a sandbox home so tests never touch a real install.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'strategist-test-'));
for (const d of ['bin', 'config', 'prompts', 'notes', 'briefs']) {
  fs.mkdirSync(path.join(sandbox, d), { recursive: true });
}
for (const f of [
  ['config/council.json'],
  ['config/business.example.json'],
  ['prompts/council-brief-prompt.md'],
  ['prompts/focus-check-prompt.md'],
  ['prompts/triage-prompt.md'],
  ['prompts/decision-council-prompt.md'],
  ['prompts/follow-through-review-prompt.md'],
]) {
  fs.copyFileSync(path.join(ROOT, f[0]), path.join(sandbox, f[0]));
}

check('council.json has exactly 7 personas including mckeown', () => {
  const council = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'config', 'council.json'), 'utf8')
  );
  assert(Array.isArray(council) && council.length === 7, 'expected 7 personas');
  for (const p of council) {
    assert(p.id && p.name && p.lens, 'persona missing id/name/lens: ' + JSON.stringify(p));
  }
  assert(council.some((p) => p.id === 'mckeown'), 'mckeown persona missing');
});

check('focus prompt exists with its three placeholders', () => {
  const prompt = fs.readFileSync(
    path.join(ROOT, 'prompts', 'focus-check-prompt.md'),
    'utf8'
  );
  for (const placeholder of ['{{TODAY}}', '{{TODAYS_BRIEF}}', '{{CURRENT_ACTIVITY}}']) {
    assert(prompt.includes(placeholder), 'missing placeholder: ' + placeholder);
  }
});

check('agent brain points to every shipped reasoning prompt', () => {
  const brain = fs.readFileSync(path.join(ROOT, 'BRAIN.md'), 'utf8');
  assert(brain.includes('prompts/council-brief-prompt.md'), 'council prompt is not mapped');
  assert(brain.includes('prompts/focus-check-prompt.md'), 'focus prompt is not mapped');
  assert(brain.includes('prompts/triage-prompt.md'), 'triage prompt is not mapped');
  assert(brain.includes('prompts/decision-council-prompt.md'), 'decision council prompt is not mapped');
  assert(brain.includes('prompts/follow-through-review-prompt.md'), 'follow-through review prompt is not mapped');
});

check('recipes meet the natural-language routing convention', () => {
  for (const name of ['generate-brief', 'focus-check', 'triage-priorities', 'decision-council', 'review-follow-through']) {
    const recipe = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'recipes', name + '.recipe.json'), 'utf8')
    );
    assert(recipe.taskClass === 'planning', name + ' taskClass must be planning');
    assert(Array.isArray(recipe.phrases) && recipe.phrases.length >= 5, name + ' needs five phrases');
    const generic = recipe.phrases.filter((phrase) => !/strategist/i.test(phrase));
    assert(generic.length >= 2, name + ' needs two phrases without the product name');
    const handler = require(path.join(ROOT, 'recipes', name + '.js'));
    assert(typeof handler.runRecipe === 'function', name + ' handler must export runRecipe');
  }
});

check('focus recipe fails gracefully without an activity', () => {
  const result = require(path.join(ROOT, 'recipes', 'focus-check.js')).runRecipe();
  assert(result.status === 'error', 'missing activity should return an error result');
  assert(result.metadata.code === 'missing_activity', 'missing activity error should be stable');
});

check('decision recipe fails gracefully without a decision', () => {
  const result = require(path.join(ROOT, 'recipes', 'decision-council.js')).runRecipe();
  assert(result.status === 'error', 'missing decision should return an error result');
  assert(result.metadata.code === 'missing_decision', 'missing decision error should be stable');
});

check('triage prompt fills every placeholder and handles an empty list', () => {
  const prompt = strategist.buildTriagePrompt(sandbox, '');
  assert(!/\{\{[A-Z_]+\}\}/.test(prompt), 'unfilled placeholder remains');
  assert(prompt.includes('No items provided'), 'empty-list fallback message missing');
});

check('triage prompt numbers a provided item list', () => {
  const prompt = strategist.buildTriagePrompt(sandbox, 'send the referral page; chase invoice 042');
  assert(prompt.includes('1. send the referral page'), 'first item not numbered correctly');
  assert(prompt.includes('2. chase invoice 042'), 'second item not numbered correctly');
});

check('decision prompt fills every placeholder and includes all seven personas', () => {
  const prompt = strategist.buildDecisionPrompt(sandbox, 'should I raise prices 20%');
  assert(!/\{\{[A-Z_]+\}\}/.test(prompt), 'unfilled placeholder remains');
  assert(prompt.includes('should I raise prices 20%'), 'decision text missing');
  for (const name of ['Dalio', 'Hormozi', 'Dunford', 'Martin', 'McGrath', 'Munger', 'McKeown']) {
    assert(prompt.includes(name), 'council persona missing from decision prompt: ' + name);
  }
});

check('review prompt fills every placeholder and degrades with no brief history', () => {
  const prompt = strategist.buildReviewPrompt(sandbox);
  assert(!/\{\{[A-Z_]+\}\}/.test(prompt), 'unfilled placeholder remains');
  assert(prompt.includes('no previous briefs yet'), 'empty-history fallback message missing');
});

check('council prompt has Follow-Through and multi-brief placeholder only', () => {
  const prompt = fs.readFileSync(
    path.join(ROOT, 'prompts', 'council-brief-prompt.md'),
    'utf8'
  );
  assert(prompt.includes('{{PREVIOUS_BRIEFS}}'), 'multi-brief placeholder missing');
  assert(prompt.includes('*Follow-Through*'), 'Follow-Through section missing');
  assert(!prompt.includes('{{PREVIOUS_BRIEF}}'), 'old singular placeholder remains');
});

check('business.example.json parses and has the required shape', () => {
  const cfg = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'config', 'business.example.json'), 'utf8')
  );
  assert(cfg.owner, 'owner missing');
  assert(cfg.business && cfg.business.name, 'business.name missing');
  assert(cfg.mission && cfg.mission.statement, 'mission.statement missing');
  assert(Array.isArray(cfg.goals) && cfg.goals.length > 0, 'goals missing');
  assert(Array.isArray(cfg.projects), 'projects missing');
});

check('validateConfig flags the untouched example config', () => {
  const cfg = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'config', 'business.example.json'), 'utf8')
  );
  const problems = strategist.validateConfig(cfg);
  assert(problems.length > 0, 'placeholder owner should be flagged');
});

check('validateConfig passes a filled-in config', () => {
  const problems = strategist.validateConfig({
    owner: 'Sam',
    business: { name: 'Sample Studio' },
    mission: { statement: 'Reach 10 clients' },
    goals: [{ goal: 'Close 2 clients', by: '2026-09-01' }],
    projects: [],
  });
  assert(problems.length === 0, 'unexpected problems: ' + problems.join('; '));
});

check('buildPrompt fills every placeholder', () => {
  process.env.STRATEGIST_HOME = sandbox;
  const prompt = strategist.buildPrompt({ root: sandbox, weekly: false });
  delete process.env.STRATEGIST_HOME;
  assert(!/\{\{[A-Z_]+\}\}/.test(prompt), 'unfilled placeholder remains');
  assert(prompt.includes('DAILY BRIEF'), 'mode not set');
  for (const name of ['Dalio', 'Hormozi', 'Dunford', 'Martin', 'McGrath', 'Munger']) {
    assert(prompt.includes(name), 'council persona missing from prompt: ' + name);
  }
  assert(prompt.includes('Top 3 Today'), 'output spec missing');
});

check('three recent briefs appear newest-first in the printed prompt', () => {
  fs.copyFileSync(
    path.join(ROOT, 'config', 'business.example.json'),
    path.join(sandbox, 'config', 'business.json')
  );
  for (const [date, text] of [
    ['2026-07-30', 'oldest brief'],
    ['2026-07-31', 'middle brief'],
    ['2026-08-01', 'newest brief'],
  ]) {
    fs.writeFileSync(path.join(sandbox, 'briefs', date + '.md'), text);
  }
  fs.writeFileSync(path.join(sandbox, 'briefs', '2026-08-02-prompt.md'), 'ignore me');
  execFileSync(
    process.execPath,
    [path.join(ROOT, 'bin', 'strategist.js'), 'brief', '--print-prompt'],
    {
      env: Object.assign({}, process.env, { STRATEGIST_HOME: sandbox }),
      encoding: 'utf8',
    }
  );
  const promptPath = path.join(sandbox, 'briefs', new Date().toISOString().slice(0, 10) + '-prompt.md');
  const prompt = fs.readFileSync(promptPath, 'utf8');
  const newest = prompt.indexOf('--- Brief from 2026-08-01 ---');
  const middle = prompt.indexOf('--- Brief from 2026-07-31 ---');
  const oldest = prompt.indexOf('--- Brief from 2026-07-30 ---');
  assert(newest !== -1 && middle !== -1 && oldest !== -1, 'not all brief headers found');
  assert(newest < middle && middle < oldest, 'briefs are not newest-first');
  assert(!prompt.includes('ignore me'), 'prompt file was included as a brief');
});

check('buildPrompt weekly mode and notes ingestion work', () => {
  fs.writeFileSync(
    path.join(sandbox, 'notes', 'monday.md'),
    'Signed one new client this week.'
  );
  const prompt = strategist.buildPrompt({ root: sandbox, weekly: true });
  assert(prompt.includes('WEEKLY REVIEW'), 'weekly mode not set');
  assert(prompt.includes('Signed one new client'), 'note content not included');
});

check('setup command creates config and folders in a fresh home', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'strategist-setup-'));
  for (const d of ['bin', 'config', 'prompts']) {
    fs.mkdirSync(path.join(fresh, d), { recursive: true });
  }
  fs.copyFileSync(
    path.join(ROOT, 'config', 'business.example.json'),
    path.join(fresh, 'config', 'business.example.json')
  );
  execFileSync(process.execPath, [path.join(ROOT, 'bin', 'strategist.js'), 'setup'], {
    env: Object.assign({}, process.env, { STRATEGIST_HOME: fresh }),
    encoding: 'utf8',
  });
  assert(fs.existsSync(path.join(fresh, 'config', 'business.json')), 'business.json not created');
  assert(fs.existsSync(path.join(fresh, 'notes')), 'notes folder not created');
  assert(fs.existsSync(path.join(fresh, 'briefs')), 'briefs folder not created');
  fs.rmSync(fresh, { recursive: true, force: true });
});

check('brief --print-prompt writes a prompt file without calling Claude', () => {
  fs.copyFileSync(
    path.join(ROOT, 'config', 'business.example.json'),
    path.join(sandbox, 'config', 'business.json')
  );
  execFileSync(
    process.execPath,
    [path.join(ROOT, 'bin', 'strategist.js'), 'brief', '--print-prompt'],
    {
      env: Object.assign({}, process.env, { STRATEGIST_HOME: sandbox }),
      encoding: 'utf8',
    }
  );
  const files = fs.readdirSync(path.join(sandbox, 'briefs'));
  assert(files.some((f) => f.endsWith('-prompt.md')), 'prompt file not written');
});

check('split home resolves shipped assets and degrades without Claude', () => {
  const splitHome = fs.mkdtempSync(path.join(os.tmpdir(), 'strategist-split-home-'));
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'strategist-empty-bin-'));
  for (const d of ['config', 'notes', 'briefs']) {
    fs.mkdirSync(path.join(splitHome, d), { recursive: true });
  }
  fs.copyFileSync(
    path.join(ROOT, 'config', 'business.example.json'),
    path.join(splitHome, 'config', 'business.json')
  );
  const env = Object.assign({}, process.env, {
    STRATEGIST_HOME: splitHome,
    PATH: emptyBin,
  });
  const brief = require('child_process').spawnSync(
    process.execPath,
    [path.join(ROOT, 'bin', 'strategist.js'), 'brief', '--print-prompt'],
    { env, encoding: 'utf8' }
  );
  assert(brief.status === 0, 'split-home brief failed: ' + brief.stderr);
  assert(!/ENOENT/.test(brief.stderr), 'split-home brief reported ENOENT');
  assert(
    fs.existsSync(path.join(splitHome, 'briefs', new Date().toISOString().slice(0, 10) + '-prompt.md')),
    'split-home brief prompt was not written'
  );
  const focus = require('child_process').spawnSync(
    process.execPath,
    [path.join(ROOT, 'bin', 'strategist.js'), 'focus', 'x'],
    { env, encoding: 'utf8' }
  );
  assert(focus.status === 1, 'split-home focus should use the degrade fallback');
  assert(!/ENOENT/.test(focus.stderr), 'split-home focus reported ENOENT');
  assert(
    fs.existsSync(path.join(splitHome, 'briefs', new Date().toISOString().slice(0, 10) + '-focus-prompt.md')),
    'split-home focus prompt was not written'
  );
  fs.rmSync(splitHome, { recursive: true, force: true });
  fs.rmSync(emptyBin, { recursive: true, force: true });
});

check('pinned _*.md notes always come first, in name order, before the 5 newest notes', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'strategist-pinned-'));
  const notes = path.join(home, 'notes');
  fs.mkdirSync(notes, { recursive: true });
  const old = new Date('2026-01-01T00:00:00Z');
  for (const name of ['_revenue-scorecard.md', '_leads.md', '_open-invoices.md']) {
    fs.writeFileSync(path.join(notes, name), 'state of ' + name);
    fs.utimesSync(path.join(notes, name), old, old);
  }
  for (let i = 1; i <= 7; i++) {
    const p = path.join(notes, 'day-' + i + '.md');
    fs.writeFileSync(p, 'ordinary note ' + i);
    const when = new Date(Date.UTC(2026, 9, i));
    fs.utimesSync(p, when, when);
  }
  const text = strategist.gatherNotes(home, 5);
  const order = [...text.matchAll(/^--- (pinned note|note): (.+) ---$/gm)].map((m) => m[2]);
  assert(
    JSON.stringify(order) === JSON.stringify([
      '_leads.md', '_open-invoices.md', '_revenue-scorecard.md',
      'day-7.md', 'day-6.md', 'day-5.md', 'day-4.md', 'day-3.md',
    ]),
    'unexpected note order: ' + order.join(', ')
  );
  assert(text.includes('--- pinned note: _leads.md ---'), 'pinned notes are not labelled');
  assert(!text.includes('day-2.md') && !text.includes('day-1.md'), 'older ordinary notes leaked in');
  fs.rmSync(home, { recursive: true, force: true });
});

check('a pinned state file linked into notes/ from elsewhere is still read', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'strategist-link-'));
  fs.mkdirSync(path.join(home, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(home, 'agents', 'leads.md'), 'three warm leads');
  try {
    fs.symlinkSync(path.join(home, 'agents', 'leads.md'), path.join(home, 'notes', '_leads.md'));
  } catch (e) {
    fs.rmSync(home, { recursive: true, force: true });
    return; // symbolic links need extra rights on some Windows setups
  }
  const text = strategist.gatherNotes(home, 5);
  assert(text && text.includes('--- pinned note: _leads.md ---') && text.includes('three warm leads'), 'linked pinned note was skipped');
  fs.rmSync(home, { recursive: true, force: true });
});

check('pinned notes are capped at 4,000 characters and ordinary notes at 8,000', () => {
  assert(strategist.PINNED_NOTE_MAX_CHARS === 4000, 'pinned cap changed');
  assert(strategist.NOTE_MAX_CHARS === 8000, 'ordinary cap changed');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'strategist-caps-'));
  fs.mkdirSync(path.join(home, 'notes'), { recursive: true });
  const body = (n, tail) => 'x'.repeat(n) + tail;
  fs.writeFileSync(path.join(home, 'notes', '_state.md'), body(3990, 'PIN-KEEP') + 'PIN-CUT');
  fs.writeFileSync(path.join(home, 'notes', 'comments.md'), body(7900, 'STANDING CORRECTION') + 'y'.repeat(200) + 'NOTE-CUT');
  const text = strategist.gatherNotes(home, 5);
  const pinned = text.split('--- note: comments.md ---')[0];
  const ordinary = text.split('--- note: comments.md ---')[1];
  assert(!pinned.includes('PIN-CUT'), 'pinned note was not capped at 4,000');
  assert(pinned.includes('[... truncated ...]'), 'pinned truncation marker missing');
  assert(ordinary.includes('STANDING CORRECTION'), 'ordinary note lost text before 8,000 characters');
  assert(!ordinary.includes('NOTE-CUT'), 'ordinary note was not capped at 8,000');
  fs.rmSync(home, { recursive: true, force: true });
});

check('dollar patterns in notes and inputs are copied literally into every prompt', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'strategist-dollar-'));
  for (const d of ['config', 'notes', 'briefs']) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'config', 'business.example.json'), path.join(home, 'config', 'business.json'));
  const tricky = "Invoice $$500 paid; $& is a regex token; $' and $` too; also {{LEARNING}} literally";
  fs.writeFileSync(path.join(home, 'notes', '_open-invoices.md'), tricky);
  fs.writeFileSync(path.join(home, 'LEARNING.md'), 'lesson $1 and $<name>');
  const prompt = strategist.buildPrompt({ root: home, weekly: false });
  assert(prompt.includes(tricky), 'note text was garbled by replacement patterns');
  assert(prompt.includes('lesson $1 and $<name>'), 'learning text was garbled');
  assert(!/\{\{(TODAY|MODE|NOTES|PREVIOUS_BRIEFS|COUNCIL_JSON|BUSINESS_JSON)\}\}/.test(prompt), 'a placeholder was left unfilled');
  assert((prompt.match(/lesson \$1/g) || []).length === 1, 'learning was injected into the note text');
  assert(strategist.buildDecisionPrompt(home, 'charge $$ or $& more?').includes('charge $$ or $& more?'), 'decision text garbled');
  assert(strategist.buildTriagePrompt(home, "chase $'late$' invoice").includes("chase $'late$' invoice"), 'triage text garbled');
  assert(strategist.buildFocusPrompt(home, 'pricing at $$9').includes('pricing at $$9'), 'focus text garbled');
  assert(strategist.fillTemplate('a {{X}} b {{Y}}', { X: '$&', Y: '{{X}}' }) === 'a $& b {{X}}', 'fillTemplate is not single-pass and literal');
  fs.rmSync(home, { recursive: true, force: true });
});

check('council prompt tells the council to treat pinned notes as current facts', () => {
  const prompt = fs.readFileSync(path.join(ROOT, 'prompts', 'council-brief-prompt.md'), 'utf8');
  assert(/pinned note/i.test(prompt) && /current facts/i.test(prompt), 'pinned-note instruction missing');
  assert(prompt.indexOf('pinned note') < prompt.indexOf('{{NOTES}}'), 'instruction must come before the notes');
});

fs.rmSync(sandbox, { recursive: true, force: true });

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
