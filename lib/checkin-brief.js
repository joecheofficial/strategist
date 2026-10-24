'use strict';
/**
 * Builds the daily check-in from the customer's own files.
 *
 * gatherData() reads, never writes: the business config, notes (pinned state
 * files first), the latest Strategist brief, yesterday's check-in and, when
 * the customer asked for it and Google is connected, today's calendar through
 * the Google module's read-only runtime.
 *
 * dataBrief() turns that into the data-only check-in, with no model at all.
 * Unknown stays unknown: a missing source is named, never shown as zero.
 */
const fs = require('fs');
const path = require('path');
const { SECTION_LABELS } = require('./checkin-config');

const MAX_ITEMS = 6;
const PINNED_KEYS = {
  money: /^_(open-invoices|invoices|money|revenue|cash|bills|payments)/i,
  pipeline: /^_(leads|pipeline|deals|proposals|sales)/i,
  relationships: /^_(follow-?ups|people|relationships|contacts|clients)/i,
  risks: /^_(risks|deadlines|blockers)/i,
};

function dateIn(timeZone, now) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Reads a file only when it resolves inside `within` (the install root), so a
// link in notes/ can point at another file of this install but never at, say,
// a key file elsewhere on the Mac.
function readIf(file, max, within) {
  try {
    const real = fs.realpathSync(file);
    if (within) {
      const base = fs.realpathSync(within);
      if (real !== base && !real.startsWith(base + path.sep)) return null;
    }
    if (!fs.statSync(real).isFile()) return null;
    const text = fs.readFileSync(real, 'utf8');
    return max && text.length > max ? text.slice(0, max) : text;
  } catch (e) {
    return null;
  }
}

function loadJsonIf(file) {
  const text = readIf(file, 256 * 1024);
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

// One line per bullet or numbered item, trimmed, at most n.
function bullets(text, n) {
  if (!text) return [];
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^([-*•]|\d+[.)])\s+/.test(line))
    .map((line) => line.replace(/^([-*•]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').slice(0, 240))
    .filter(Boolean)
    .slice(0, n || MAX_ITEMS);
}

function section(text, heading) {
  if (!text) return null;
  const start = text.indexOf(heading);
  if (start < 0) return null;
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n\s*\*[A-Z][^*\n]{1,60}\*/);
  return next >= 0 ? rest.slice(0, next) : rest;
}

function isExample(value) {
  return /^\s*example\b/i.test(String(value || ''));
}

function pinnedNotes(home, root) {
  const dir = path.join(home, 'notes');
  let files = [];
  try { files = fs.readdirSync(dir).filter((file) => /^_.*\.(md|txt)$/i.test(file)).sort(); } catch (e) { return []; }
  return files.map((file) => ({ file, text: readIf(path.join(dir, file), 4000, root) || '' }));
}

function latestBrief(home, today) {
  const dir = path.join(home, 'briefs');
  let files = [];
  try { files = fs.readdirSync(dir).filter((file) => /^\d{4}-\d{2}-\d{2}\.md$/.test(file) && file <= `${today}.md`).sort(); } catch (e) { return null; }
  if (!files.length) return null;
  const file = files[files.length - 1];
  return { date: file.slice(0, 10), text: readIf(path.join(dir, file), 8000) };
}

function previousCheckin(home, today) {
  const dir = path.join(home, 'briefs');
  let files = [];
  try { files = fs.readdirSync(dir).filter((file) => /^checkin-\d{4}-\d{2}-\d{2}\.md$/.test(file) && file < `checkin-${today}.md`).sort(); } catch (e) { return null; }
  if (!files.length) return null;
  const file = files[files.length - 1];
  return { date: file.slice(8, 18), text: readIf(path.join(dir, file), 8000) };
}

// Today's calendar through the Google module's read-only runtime. Reads are
// allowed on a schedule; that module refuses every scheduled write.
function readCalendar(root, deps, range) {
  if (deps && typeof deps.readCalendar === 'function') return deps.readCalendar(root, range);
  const runtimeFile = path.join(root, 'google', 'recipes', 'runtime.js');
  const cfg = loadJsonIf(path.join(root, 'google', 'config.json'));
  if (!fs.existsSync(runtimeFile) || !cfg || !cfg.account || String(cfg.account).startsWith('{{')) {
    return { ok: false, reason: 'Google calendar is not connected' };
  }
  try {
    const { runGog } = require(runtimeFile);
    const result = runGog({ account: cfg.account, gogBin: cfg.gogBin }, ['calendar', 'events', '--from', range.from, '--to', range.to, '--max', '20']);
    if (!result || result.status !== 'ok') return { ok: false, reason: 'Google calendar could not be read today' };
    const raw = Array.isArray(result.data) ? result.data : (result.data && (result.data.events || result.data.items)) || [];
    const events = raw.slice(0, 20).map((event) => {
      const start = event.start && (event.start.dateTime || event.start.date) || event.startTime || '';
      const title = String(event.summary || event.title || '(no title)').replace(/\s+/g, ' ').slice(0, 120);
      return { start: String(start).slice(0, 25), title };
    });
    return { ok: true, events };
  } catch (e) {
    return { ok: false, reason: 'Google calendar could not be read today' };
  }
}

function zoneOffset(timeZone, instant) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(instant));
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  const minutes = Math.round((Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - instant) / 60000);
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

// The whole of `day` in the chosen time zone, as RFC 3339 times, so the
// calendar shows the person's day even when the Mac is set to another zone.
function dayRange(day, timeZone, now) {
  const next = new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return { from: `${day}T00:00:00${zoneOffset(timeZone, now)}`, to: `${next}T00:00:00${zoneOffset(timeZone, now + 86400000)}` };
}

// Text from notes, calendars and files must not be able to close the data block.
function neutral(text) {
  return String(text == null ? '' : text).replace(/\b(BEGIN|END)\s+DATA\b/gi, '$1_DATA');
}

function gatherData({ home, root, cfg, now = Date.now(), deps = {} }) {
  const today = dateIn(cfg.timeZone, now);
  const business = loadJsonIf(path.join(home, 'config', 'business.json'));
  let businessAgeDays = null;
  try { businessAgeDays = Math.floor((now - fs.statSync(path.join(home, 'config', 'business.json')).mtimeMs) / 86400000); } catch (e) { /* none */ }
  const pinned = pinnedNotes(home, root);
  const pick = (key) => pinned.filter((note) => PINNED_KEYS[key].test(note.file));
  return {
    today,
    business,
    businessAgeDays,
    pinned,
    money: pick('money'),
    pipeline: pick('pipeline'),
    relationships: pick('relationships'),
    risksNotes: pick('risks'),
    brief: latestBrief(home, today),
    previous: previousCheckin(home, today),
    calendar: cfg.sections.includes('calendar') ? readCalendar(root, deps, dayRange(today, cfg.timeZone, now)) : null,
  };
}

function goalsByDate(business) {
  const goals = Array.isArray(business && business.goals) ? business.goals.filter((goal) => goal && goal.goal && !isExample(goal.goal)) : [];
  return goals.slice().sort((a, b) => String(a.by || '9999').localeCompare(String(b.by || '9999')));
}

function focusItems(data) {
  const fromBrief = data.brief ? bullets(section(data.brief.text, '*Top 3 Today*'), 4) : [];
  if (fromBrief.length) return { items: fromBrief, source: `your Strategist brief of ${data.brief.date}` };
  const goals = goalsByDate(data.business).slice(0, 3).map((goal) => `${goal.goal}${goal.by ? ` (by ${goal.by})` : ''}`);
  if (goals.length) return { items: goals, source: 'your goals in config/business.json, nearest date first' };
  const projects = (Array.isArray(data.business && data.business.projects) ? data.business.projects : [])
    .filter((project) => project && project.name && !isExample(project.name) && String(project.status || 'active').toLowerCase() === 'active')
    .slice(0, 3).map((project) => project.name);
  if (projects.length) return { items: projects, source: 'your active projects in config/business.json' };
  return { items: [], source: null };
}

function noteLines(notes) {
  const lines = [];
  for (const note of notes) for (const line of bullets(note.text, MAX_ITEMS)) lines.push(line);
  return lines.slice(0, MAX_ITEMS);
}

function risksFor(data) {
  const risks = [];
  const todayMs = Date.parse(`${data.today}T00:00:00Z`);
  for (const goal of goalsByDate(data.business)) {
    const by = Date.parse(`${goal.by}T00:00:00Z`);
    if (!Number.isFinite(by)) continue;
    const days = Math.round((by - todayMs) / 86400000);
    if (days < 0) risks.push(`Past its date by ${-days} day(s): ${goal.goal}`);
    else if (days <= 14) risks.push(`Due in ${days} day(s): ${goal.goal}`);
  }
  risks.push(...noteLines(data.risksNotes));
  if (data.businessAgeDays !== null && data.businessAgeDays > 30) risks.push(`Your business config was last changed ${data.businessAgeDays} days ago; your goals may be out of date.`);
  return risks.slice(0, MAX_ITEMS);
}

function listOr(lines, empty) {
  return lines.length ? lines.map((line) => `- ${line}`).join('\n') : `- ${empty}`;
}

// The data-only check-in. No model, no network beyond the optional calendar read.
function dataBrief(data, cfg, how) {
  const out = [];
  out.push(`*What matters most to you*\n${cfg.mattersMost}`);
  const want = (name) => cfg.sections.includes(name);
  if (want('priorities')) {
    const focus = focusItems(data);
    out.push(`*Focus today*\n${listOr(focus.items, 'No priorities found yet. Run a Strategist brief or fill in your goals in config/business.json.')}${focus.source ? `\nFrom ${focus.source}. That's it for today.` : ''}`);
  }
  if (data.previous) {
    const yesterday = bullets(section(data.previous.text, '*Focus today*'), 4);
    if (yesterday.length) out.push(`*Follow-through from ${data.previous.date}*\n${yesterday.map((line) => `- Did this move? ${line}`).join('\n')}`);
  }
  if (want('money')) {
    const lines = [...noteLines(data.money)];
    for (const item of Array.isArray(data.business && data.business.moneyWatch) ? data.business.moneyWatch : []) {
      if (item && !isExample(item) && lines.length < MAX_ITEMS) lines.push(String(item).slice(0, 240));
    }
    out.push(`*Money*\n${listOr(lines, 'Unknown: no money notes yet. Keep notes/_open-invoices.md current and it shows up here.')}`);
  }
  if (want('pipeline')) out.push(`*Pipeline*\n${listOr(noteLines(data.pipeline), 'Unknown: no pipeline notes yet. Keep notes/_leads.md current and it shows up here.')}`);
  if (want('calendar')) {
    const cal = data.calendar || { ok: false, reason: 'Calendar not read' };
    const lines = cal.ok ? cal.events.map((event) => `${event.start ? event.start.replace('T', ' ').slice(0, 16) + ' ' : ''}${event.title}`) : [];
    out.push(`*Calendar*\n${cal.ok ? listOr(lines, 'Nothing on your calendar today.') : `- Unknown: ${cal.reason}.`}`);
  }
  if (want('relationships')) out.push(`*People to follow up with*\n${listOr(noteLines(data.relationships), 'Unknown: no follow-up notes yet. Keep notes/_follow-ups.md current and it shows up here.')}`);
  if (want('risks')) out.push(`*Risks*\n${listOr(risksFor(data), 'Nothing flagged from your goals and notes.')}`);
  const paused = (Array.isArray(data.business && data.business.projects) ? data.business.projects : [])
    .filter((project) => project && project.name && !isExample(project.name) && /paused|parked|later/i.test(String(project.status || '')))
    .map((project) => project.name).slice(0, 3);
  if (paused.length) out.push(`*Not today*\n${paused.map((name) => `- ${name}`).join('\n')}`);
  out.push(`*How this was made*\n${how}`);
  return out.join('\n\n');
}

function modelPrompt({ template, data, cfg, draft, fill }) {
  return fill(template, {
    TODAY: data.today,
    SECTIONS: cfg.sections.map((name) => `- ${SECTION_LABELS[name]}`).join('\n'),
    MATTERS_MOST: neutral(cfg.mattersMost),
    DATA_BRIEF: neutral(draft),
    BUSINESS_JSON: neutral(JSON.stringify(data.business || {}, null, 2).slice(0, 12000)),
    PINNED_NOTES: neutral(data.pinned.map((note) => `--- ${note.file} ---\n${note.text}`).join('\n\n').slice(0, 16000)) || '(none)',
    PREVIOUS_CHECKIN: data.previous ? neutral(data.previous.text.slice(0, 6000)) : '(none yet)',
  });
}

module.exports = { dateIn, dayRange, neutral, bullets, section, gatherData, dataBrief, modelPrompt, focusItems, risksFor };
