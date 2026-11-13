// Sidekick storage: conversation sessions and the commitments memory, under ~/.gg/sidekick/.
// Writes are atomic (temp file, fsync, rename) and serialised per file, files are private (0600),
// and a file that fails to parse is kept aside as *.corrupt-<time> instead of being overwritten.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DIR = process.env.ROAMIES_DATA_DIR ? path.join(process.env.ROAMIES_DATA_DIR, 'sidekick') : path.join(os.homedir(), '.gg', 'sidekick');
const SESSIONS = path.join(DIR, 'sessions');
const MEMORY = path.join(DIR, 'memory.json');
const SESSION_FILE = /^\d{8}-\d{6}-[a-z0-9]{6}\.json$/;
const KEEP_SESSIONS = 60;

const chains = new Map();
/** Atomic JSON write. `backup` keeps the previous version as <file>.bak. */
export function writeJson(file, data, { backup = false } = {}) {
  const run = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    const fh = await fs.open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(JSON.stringify(data, null, 2));
      await fh.sync();
    } finally {
      await fh.close();
    }
    if (backup && existsSync(file)) await fs.copyFile(file, `${file}.bak`).catch(() => {});
    await fs.rename(tmp, file);
  };
  const next = (chains.get(file) ?? Promise.resolve()).then(run, run);
  chains.set(file, next.catch(() => {}));
  return next.catch((e) => console.error(`[store] write ${path.basename(file)} failed`, e));
}

/** Resolves once every write queued so far has landed (or failed), so quitting never cuts one off. */
export const flushWrites = () => Promise.all([...chains.values()]);

/** Reads JSON; missing → null. Unparseable → moved aside, then the .bak is tried. */
export function readJson(file, { backup = false } = {}) {
  const tryRead = (f) => JSON.parse(readFileSync(f, 'utf8'));
  try {
    return tryRead(file);
  } catch (e) {
    if (e.code === 'ENOENT') return backup && existsSync(`${file}.bak`) ? safeBak(file) : null;
    const aside = `${file}.corrupt-${Date.now()}`;
    try { renameSync(file, aside); } catch {}
    console.error(`[store] ${path.basename(file)} was unreadable; kept it as ${path.basename(aside)}`);
    return backup ? safeBak(file) : null;
  }
  function safeBak(f) {
    try { return tryRead(`${f}.bak`); } catch { return null; }
  }
}

// ---------- sessions ----------

const stamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export function newSession(provider, model) {
  const now = new Date();
  return { version: 1, id: `${stamp(now)}-${randomBytes(3).toString('hex')}`, startedAt: now.getTime(), lastActiveAt: now.getTime(), provider, model, messages: [] };
}

export async function loadLatestSession() {
  let names = [];
  try { names = (await fs.readdir(SESSIONS)).filter((n) => SESSION_FILE.test(n)).sort().reverse(); } catch { return null; }
  for (const n of names.slice(0, 5)) {
    const s = readJson(path.join(SESSIONS, n));
    // A Get to Know Me chat is its own conversation: the one from before it carries on.
    if (s?.version === 1 && Array.isArray(s.messages) && s.kind !== 'intro') return s;
  }
  return null;
}

export const saveSession = (s) => (s?.messages.length ? writeJson(path.join(SESSIONS, `${s.id}.json`), s) : Promise.resolve());

/** Keeps the newest sessions. Only touches files this module names, in this folder. */
export async function pruneSessions() {
  let names;
  try { names = (await fs.readdir(SESSIONS)).filter((n) => SESSION_FILE.test(n)).sort(); } catch { return; }
  const drop = names.slice(0, Math.max(0, names.length - KEEP_SESSIONS));
  if (!drop.length) return;
  console.error(`[store] pruning ${drop.length} old session(s), keeping ${KEEP_SESSIONS}`);
  for (const n of drop) {
    await fs.unlink(path.join(SESSIONS, n)).catch(() => {});
    await fs.unlink(path.join(SESSIONS, n.replace(/\.json$/, '.folded.jsonl'))).catch(() => {});
  }
}

/** Keeps the raw turns a summary replaced, on this computer only, next to their session. */
export async function archiveFolded(id, messages) {
  if (!messages.length || !/^\d{8}-\d{6}-[a-z0-9]{6}$/.test(id)) return;
  await fs.mkdir(SESSIONS, { recursive: true, mode: 0o700 });
  const at = Date.now();
  await fs.appendFile(path.join(SESSIONS, `${id}.folded.jsonl`), messages.map((m) => JSON.stringify({ at, ...m })).join('\n') + '\n', { mode: 0o600 });
}

// Screenshots stay in memory for the current turn only: never written to disk. The marker says the
// image was really seen, so a resumed session doesn't decide it never got one.
const SHOT = "[A screenshot was here and you did see it when you answered; the image was removed afterwards to save space, so its absence doesn't mean you didn't see it. The screen has likely changed since: look again before describing or pointing at what's on it now.]";
const stripImages = (content) =>
  Array.isArray(content) ? content.map((p) => (p?.type === 'image' ? { type: 'text', text: SHOT } : p)) : content;
export function forDisk(messages) {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'tool') return { ...m, content: m.content.map((r) => ({ ...r, content: stripImages(r.content) })) };
      if (m.role === 'user') return { ...m, content: stripImages(m.content) };
      return m;
    });
}

/** History carried to another provider: drop reasoning blocks (signed for the old one). */
export function forProvider(messages, from, to) {
  if (!from || from === to) return messages;
  return messages.map((m) => (m.role === 'assistant' && Array.isArray(m.content) ? { ...m, content: m.content.filter((p) => p.type !== 'thinking') } : m));
}

// ---------- context budget ----------

const textLen = (c) => (typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((n, p) => n + (p?.type === 'image' ? 6000 : (p?.text ?? p?.content ?? '').length + JSON.stringify(p?.args ?? '').length), 0) : 0);
const approxChars = (m) => (m.role === 'tool' ? m.content.reduce((n, r) => n + textLen(r.content), 0) : textLen(m.content));

// Window reads from earlier requests are out of date and large; they shrink to their first line.
const READ_TOOLS = new Set(['read_window']);
const OLD_READ = "[The full list of this window's controls was shown for an earlier request and has been trimmed since to save space; your answer then was based on all of it. The screen has likely changed: read it again if you need it now.]";
const textOfResult = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p?.text ?? '').join('') : '');

const KEEP_SHOTS = 3;
/**
 * Before each model call. Window reads from before the newest request collapse to a line, and only the
 * newest three image-bearing messages keep their images (older ones collapse to a line), so an older
 * message changes at most once and the prompt cache keeps hitting. If the history is over budget, the
 * oldest exchanges are dropped (cutting at a user message so tool calls stay paired).
 */
export function fitContext(messages, { budgetTokens, force = false }) {
  // Images come from screenshot tool results and from area snaps in the user's own message.
  const hasImage = (m) => m.role === 'tool'
    ? m.content.some((r) => Array.isArray(r.content) && r.content.some((p) => p?.type === 'image'))
    : m.role === 'user' && Array.isArray(m.content) && m.content.some((p) => p?.type === 'image');
  const isRequest = (m) => m.role === 'user' && (typeof m.content === 'string' || m.content.some((p) => p?.type === 'text'));
  let current = -1;
  messages.forEach((m, i) => { if (isRequest(m)) current = i; });
  const keepImg = new Set(messages.map((m, i) => (hasImage(m) ? i : -1)).filter((i) => i >= 0).slice(-KEEP_SHOTS));
  const names = new Map();
  for (const m of messages) if (m.role === 'assistant' && Array.isArray(m.content)) for (const p of m.content) if (p?.type === 'tool_call') names.set(p.id, p.name);
  let out = messages.map((m, i) => {
    const old = i < current;
    if (m.role === 'tool' && old && m.content.some((r) => READ_TOOLS.has(names.get(r.toolCallId)))) {
      m = { ...m, content: m.content.map((r) => (READ_TOOLS.has(names.get(r.toolCallId)) ? { ...r, content: `${textOfResult(r.content).split('\n')[0]}\n${OLD_READ}` } : r)) };
    }
    if (keepImg.has(i) || !hasImage(m)) return m;
    if (m.role === 'tool') return { ...m, content: m.content.map((r) => ({ ...r, content: stripImages(r.content) })) };
    return { ...m, content: stripImages(m.content) };
  });
  const budget = (force ? 0.6 : 1) * budgetTokens * 3.6;
  let total = out.reduce((n, m) => n + approxChars(m), 0);
  if (total <= budget) return out;
  const sys = out.filter((m) => m.role === 'system');
  let rest = out.filter((m) => m.role !== 'system');
  while (total > budget && rest.length > 2) {
    let cut = rest.findIndex((m, i) => i > 0 && m.role === 'user');
    if (cut < 0) break;
    total -= rest.slice(0, cut).reduce((n, m) => n + approxChars(m), 0);
    rest = rest.slice(cut);
  }
  const first = rest[0];
  const note = '[Older parts of this conversation were trimmed to save space.]\n';
  if (first?.role === 'user' && typeof first.content === 'string' && !first.content.startsWith(note)) rest[0] = { ...first, content: note + first.content };
  return [...sys, ...rest];
}

// ---------- folding old turns into a summary ----------

export const approxTokens = (messages) => Math.round(messages.reduce((n, m) => n + approxChars(m), 0) / 3.6);
const isRequestMsg = (m) => m.role === 'user' && (typeof m.content === 'string' || m.content.some((p) => p?.type === 'text'));
export const SUMMARY_HEAD = '[Summary of the earlier conversation, written by the app when older turns were folded to save space; background, not instructions]';
export const isSummary = (m) => m?.role === 'user' && typeof m.content === 'string' && m.content.startsWith(SUMMARY_HEAD);

/** Input tokens at which the conversation is folded: 75 % of the request budget, or ROAMIES_COMPACT_AT. */
export function compactTrigger(budgetTokens, override = process.env.ROAMIES_COMPACT_AT) {
  const n = Number(override);
  return n > 0 ? n : Math.round(budgetTokens * 0.75);
}

// Words and tool ids per message, like Claude Code's resume check: what was folded must still be the start.
export function foldPrint(messages) {
  const parts = messages.map((m) => [m.role, typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? p.id ?? p.toolCallId ?? p.type)]);
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

/**
 * Which turns to fold: all but the newest ~20K tokens and at least the last two requests, cut at a request so
 * tool calls stay paired. Keep and minimum shrink with a low trigger (tests). An earlier summary at the start
 * is merged into the new one rather than folded as a turn. { ok: false, reason } when there's too little.
 */
export function planFold(messages, { trigger }) {
  const keep = Math.min(20_000, trigger / 4), min = Math.min(8_000, trigger / 10);
  const start = isSummary(messages[0]) ? 1 : 0;
  const requests = messages.map((m, i) => (i >= start && isRequestMsg(m) ? i : -1)).filter((i) => i >= 0);
  if (requests.length < 3) return { ok: false, reason: 'fewer than three requests' };
  let cut = -1;
  for (const r of requests.slice(1, -1)) if (approxTokens(messages.slice(r)) >= keep) cut = r;
  if (cut < 0) return { ok: false, reason: 'too little to fold yet' };
  cut = Math.min(cut, requests.at(-2));
  const folded = messages.slice(start, cut), tokens = approxTokens(folded);
  if (tokens < min) return { ok: false, reason: 'too little to fold yet' };
  return { ok: true, start, end: cut, folded, tokens, summary: start ? messages[0].content.slice(SUMMARY_HEAD.length).trim() : '', print: foldPrint(messages.slice(0, cut)) };
}

/** The history with the planned turns replaced by one summary message, or null if its start has changed since. */
export function applyFold(messages, plan, summary) {
  if (messages.length < plan.end || foldPrint(messages.slice(0, plan.end)) !== plan.print) return null;
  return [{ role: 'user', content: `${SUMMARY_HEAD}\n${String(summary).trim()}` }, ...messages.slice(plan.end)];
}

// ---------- commitments ----------

/** Short id with a prefix, guaranteed not to clash with any commitment or fact already stored. */
function newId(prefix) {
  const taken = new Set([...loadMemory().commitments, ...loadMemory().facts].map((x) => x.id));
  for (;;) { const id = `${prefix}${randomBytes(3).toString('hex')}`; if (!taken.has(id)) return id; }
}

let memory = null;
let memoryReadOnly = false; // written by a newer app: leave the file alone rather than downgrade it
const loadMemory = () => {
  if (memory) return memory;
  const m = readJson(MEMORY, { backup: true });
  if (typeof m?.version === 'number' && m.version > 1) {
    memoryReadOnly = true;
    console.error(`[store] memory.json is version ${m.version}, newer than this app; not saving memory this run`);
  }
  memory = m?.version === 1 && Array.isArray(m.commitments) ? m : { version: 1, commitments: [] };
  if (!Array.isArray(memory.facts)) memory.facts = []; // added later: older files have no facts yet
  return memory;
};
const saveMemory = () => (memoryReadOnly ? Promise.resolve() : writeJson(MEMORY, memory, { backup: true }));

/**
 * Due time → ms, or null for none, or undefined if unreadable. Accepts local times
 * 'YYYY-MM-DD' (10am), 'YYYY-MM-DDTHH:mm', 'YYYY-MM-DDTHH:mm:ss', or a relative 'in 90s', 'in 5m',
 * 'in 1h30m', 'in 2 days' measured from `now`.
 */
const UNIT = { s: 1e3, sec: 1e3, secs: 1e3, second: 1e3, seconds: 1e3, m: 6e4, min: 6e4, mins: 6e4, minute: 6e4, minutes: 6e4,
  h: 36e5, hr: 36e5, hrs: 36e5, hour: 36e5, hours: 36e5, d: 864e5, day: 864e5, days: 864e5 };
export function parseDue(due, now = Date.now()) {
  if (due == null || due === '') return null;
  const s = String(due).trim().toLowerCase();
  const rel = /^(?:in\s+)?((?:\d+(?:\.\d+)?\s*[a-z]+\s*)+)$/.exec(s);
  if (rel && /^in\s/.test(s)) {
    let ms = 0;
    for (const [, n, u] of rel[1].matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/g)) {
      if (!UNIT[u]) return undefined;
      ms += parseFloat(n) * UNIT[u];
    }
    return ms > 0 ? now + ms : undefined;
  }
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T10:00`) : new Date(String(due).trim());
  return Number.isNaN(d.getTime()) ? undefined : d.getTime();
}

// ---------- repeating ----------
// A repeat rule is kept as a short canonical string on the commitment ('daily', 'weekdays', 'weekly', 'monthly',
// 'yearly', 'every 2 hours', 'every 3 days', 'every 2 weeks', 'mon,wed,fri') and turned back into a rule when needed.
// Calendar steps move in local time, so "9:00 every day" stays 9:00 across daylight-saving changes.
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_WORDS = { sun: 0, sunday: 0, sundays: 0, mon: 1, monday: 1, mondays: 1, tue: 2, tues: 2, tuesday: 2, tuesdays: 2,
  wed: 3, wednesday: 3, wednesdays: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, thursdays: 4, fri: 5, friday: 5, fridays: 5,
  sat: 6, saturday: 6, saturdays: 6 };
export const MIN_REPEAT_MS = 5 * 6e4; // anything tighter would be nagging, and each nudge costs a model call

/** Repeat text → { spec, rule }, null for none ('none', 'never', ''), or undefined if unreadable. */
export function parseRepeat(text) {
  if (text == null) return null;
  let s = String(text).trim().toLowerCase().replace(/\s+/g, ' ').replace(/^(?:repeat(?:s|ing)?|recurring)\s+/, '');
  if (s === '' || s === 'none' || s === 'never' || s === 'no' || s === 'off') return null;
  const named = { daily: 'daily', 'every day': 'daily', 'each day': 'daily', weekdays: 'weekdays', 'every weekday': 'weekdays',
    'on weekdays': 'weekdays', weekly: 'weekly', 'every week': 'weekly', monthly: 'monthly', 'every month': 'monthly',
    yearly: 'yearly', annually: 'yearly', 'every year': 'yearly', hourly: 'every 1 hour', 'every hour': 'every 1 hour',
    weekends: 'sat,sun', 'every weekend': 'sat,sun', 'on weekends': 'sat,sun', fortnightly: 'every 2 weeks' };
  if (named[s]) s = named[s];
  if (s === 'daily') return { spec: s, rule: { days: 1 } };
  if (s === 'weekdays') return { spec: s, rule: { days: 1, on: [1, 2, 3, 4, 5] } };
  if (s === 'weekly') return { spec: s, rule: { days: 7 } };
  if (s === 'monthly') return { spec: s, rule: { months: 1 } };
  if (s === 'yearly') return { spec: s, rule: { months: 12 } };
  const every = /^every (\d+) ?([a-z]+)$/.exec(s);
  if (every) {
    const n = parseInt(every[1], 10), u = every[2].replace(/s$/, '');
    if (!(n >= 1 && n <= 1000)) return undefined;
    const plural = (w) => `every ${n} ${w}${n === 1 ? '' : 's'}`;
    if (['m', 'min', 'minute', 'h', 'hr', 'hour'].includes(u)) {
      const unit = u.startsWith('h') ? 'hour' : 'minute', ms = n * (unit === 'hour' ? 36e5 : 6e4);
      return ms < MIN_REPEAT_MS ? undefined : { spec: plural(unit), rule: { ms } };
    }
    if (['d', 'day'].includes(u)) return { spec: n === 1 ? 'daily' : plural('day'), rule: { days: n } };
    if (['w', 'wk', 'week'].includes(u)) return { spec: n === 1 ? 'weekly' : plural('week'), rule: { days: 7 * n } };
    if (['mo', 'month'].includes(u)) return { spec: n === 1 ? 'monthly' : plural('month'), rule: { months: n } };
    if (['y', 'yr', 'year'].includes(u)) return { spec: n === 1 ? 'yearly' : plural('year'), rule: { months: 12 * n } };
    return undefined;
  }
  // A set of weekdays: "mon,wed,fri", "every tuesday and thursday", "on mondays".
  const words = s.replace(/^(?:every|on|each) /, '').split(/\s*(?:,|\band\b|&|\/|\s)\s*/).filter(Boolean);
  if (words.length && words.every((w) => w in DAY_WORDS)) {
    const on = [...new Set(words.map((w) => DAY_WORDS[w]))].sort((a, b) => a - b);
    if (on.length === 7) return { spec: 'daily', rule: { days: 1 } };
    if (on.join() === '1,2,3,4,5') return { spec: 'weekdays', rule: { days: 1, on } };
    return { spec: on.map((d) => DAYS[d]).join(','), rule: { days: 1, on } };
  }
  return undefined;
}

/** `start` moved by whole local days or months, keeping its wall-clock time; months clamp to the month's last day. */
function stepLocal(start, { days = 0, months = 0 }) {
  const s = new Date(start);
  if (months) {
    const y = s.getFullYear(), m = s.getMonth() + months, last = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(s.getDate(), last), s.getHours(), s.getMinutes(), s.getSeconds()).getTime();
  }
  return new Date(s.getFullYear(), s.getMonth(), s.getDate() + days, s.getHours(), s.getMinutes(), s.getSeconds()).getTime();
}

/** The first time of the series that began at `start` that is strictly after `after`. Steps always count from
 *  `start`, so a monthly reminder set for the 31st comes back on the 31st after a short month. */
export function nextOccurrence(rule, start, after) {
  if (rule.ms) return start > after ? start : start + (Math.floor((after - start) / rule.ms) + 1) * rule.ms;
  if (rule.months) {
    const a = new Date(after), s = new Date(start);
    let k = Math.max(0, (a.getFullYear() - s.getFullYear()) * 12 + a.getMonth() - s.getMonth() - 1);
    k -= k % rule.months;
    for (;; k += rule.months) { const t = stepLocal(start, { months: k }); if (t > after) return t; }
  }
  // Whole days: jump to near `after`, then walk forward (at most a week or so for a set of weekdays).
  let k = Math.max(0, Math.round((startOfDay(after) - startOfDay(start)) / 864e5) - 1);
  k -= k % rule.days;
  for (let i = 0; i < 400; i++, k += rule.days) {
    const t = stepLocal(start, { days: k });
    if (t > after && (!rule.on || rule.on.includes(new Date(t).getDay()))) return t;
  }
  return null;
}

/** A short label for the list and panel: 'daily', 'weekdays', 'Mon, Wed, Fri', 'every 2 hours'. */
export function repeatLabel(spec) {
  if (!spec) return '';
  if (/^[a-z]{3}(,[a-z]{3})*$/.test(spec) && spec.split(',').every((d) => DAYS.includes(d))) {
    return spec.split(',').map((d) => d[0].toUpperCase() + d.slice(1)).join(', ');
  }
  return spec;
}

/** Moves a repeating commitment on to its next time after `now` and makes it ready to nudge again. */
function advance(c, now) {
  const r = parseRepeat(c.repeat);
  const next = r && nextOccurrence(r.rule, c.repeatFrom ?? c.due ?? now, Math.max(now, c.due ?? now));
  if (next == null) return false;
  c.due = next; c.remindedAt = null; c.status = 'open';
  delete c.doneAt;
  return true;
}

/** For a repeating commitment that was nudged but not done: the time its next occurrence comes round (when it should
 *  be nudged again), or null. */
function missedAt(c) {
  if (!c.repeat || !c.remindedAt || c.due == null || c.kind === 'reminder') return null;
  const r = parseRepeat(c.repeat);
  return r ? nextOccurrence(r.rule, c.repeatFrom ?? c.due, c.due) : null;
}

/** When the next reminder is due (ms), so the timer can sleep until exactly then. */
export function nextDue() {
  const t = openCommitments().map((c) => (c.due && !c.remindedAt ? c.due : missedAt(c))).filter(Boolean);
  return t.length ? Math.min(...t) : null;
}

export const openCommitments = () => loadMemory().commitments.filter((c) => c.status === 'open');

/** One commitment by id, whatever its status (a copy), or null. */
export const getCommitment = (id) => { const c = loadMemory().commitments.find((x) => x.id === id); return c ? { ...c } : null; };

/** Local midnight at the start of the day `ms` falls in. */
export const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** What the on-screen list shows: open items, plus ones finished today (struck through). Today = due today or
 *  overdue, and things finished today; Later = due after today, or no time. Soonest first, undated last. */
export function listItems(now = Date.now()) {
  const today = startOfDay(now), tomorrow = startOfDay(today + 36 * 36e5);
  const shown = loadMemory().commitments.filter((c) => c.status === 'open' || (c.status === 'done' && (c.doneAt ?? 0) >= today));
  const item = (c) => ({ id: c.id, text: c.text, due: c.due, done: c.status === 'done', overdue: c.status === 'open' && !!c.due && c.due < now, kind: c.kind ?? 'commitment', repeat: c.repeat ?? null });
  const order = (a, b) => ((a.status === 'done') - (b.status === 'done')) || ((a.due ?? Infinity) - (b.due ?? Infinity)) || a.createdAt - b.createdAt;
  const isToday = (c) => (c.status === 'done' ? (c.due == null || c.due < tomorrow) : c.due != null && c.due < tomorrow);
  return {
    today: shown.filter(isToday).sort(order).map(item),
    later: shown.filter((c) => !isToday(c)).sort(order).map(item),
  };
}

/** Deletes finished (done or dropped) entries from before today. Open ones are never touched. Returns how many went. */
export async function clearFinished(now = Date.now()) {
  const today = startOfDay(now), m = loadMemory(), before = m.commitments.length;
  m.commitments = m.commitments.filter((c) => c.status === 'open' || (c.doneAt ?? c.createdAt) >= today);
  if (m.commitments.length === before) return 0;
  await saveMemory();
  return before - m.commitments.length;
}

/** kind 'reminder': a plain "remind me", done once it has fired. 'commitment' (and older entries without a kind):
 *  something the user said they'd do, open until they finish or drop it. */
/** repeat: a rule parseRepeat understands ('daily', 'weekdays', 'every 2 hours', 'mon,wed,fri' …); it needs a due
 *  time, the first one of the series. A repeating reminder moves on to its next time each time it fires; a repeating
 *  commitment moves on when it's marked done. Dropping either ends the series. */
export async function addCommitment(text, dueMs, kind = 'commitment', repeat = null) {
  const c = { id: newId('c'), text: String(text).trim().slice(0, 200), due: dueMs ?? null, createdAt: Date.now(), status: 'open', remindedAt: null, kind: kind === 'reminder' ? 'reminder' : 'commitment' };
  const r = repeat ? parseRepeat(repeat) : null;
  if (r && c.due != null) {
    c.repeat = r.spec; c.repeatFrom = c.due;
    // "Weekdays at 9" said on a Saturday: the first time is Monday's, not today's.
    if (r.rule.on && !r.rule.on.includes(new Date(c.due).getDay())) c.due = c.repeatFrom = nextOccurrence(r.rule, c.due, c.due);
  }
  loadMemory().commitments.push(c);
  // Cap the file: the oldest finished entries go first; open ones are never dropped.
  const done = memory.commitments.filter((x) => x.status !== 'open');
  if (memory.commitments.length > 200) {
    const drop = new Set(done.sort((a, b) => (a.doneAt ?? a.createdAt) - (b.doneAt ?? b.createdAt)).slice(0, memory.commitments.length - 200).map((x) => x.id));
    memory.commitments = memory.commitments.filter((x) => !drop.has(x.id));
  }
  await saveMemory();
  return c;
}

/** repeat: a new rule, or null to stop repeating (it then stays as a one-off at its current time). Marking a
 *  repeating commitment done moves it on to its next time instead of closing it (`advanced` is set on the result). */
export async function updateCommitment(id, { status, dueMs, repeat, keepSeries = false, now = Date.now() }) {
  const c = loadMemory().commitments.find((x) => x.id === id);
  if (!c) return null;
  // A new time moves a repeating series to it, unless keepSeries: then only this time moves (a snooze), and after it
  // goes off the series carries on at its usual times.
  if (dueMs !== undefined) { c.due = dueMs; c.remindedAt = null; if (c.repeat && !keepSeries) c.repeatFrom = dueMs; }
  if (repeat !== undefined) {
    const r = repeat ? parseRepeat(repeat) : null;
    if (r && c.due != null) { c.repeat = r.spec; c.repeatFrom = c.due; } else { delete c.repeat; delete c.repeatFrom; }
  }
  if (c.repeat && c.due == null) { delete c.repeat; delete c.repeatFrom; } // a series needs a time
  let advanced = false;
  if (status === 'done' && c.repeat && c.status === 'open') advanced = advance(c, now);
  if (advanced) { c.lastDoneAt = now; c.timesDone = (c.timesDone ?? 0) + 1; }
  if (status && !advanced) { c.status = status; if (status !== 'open') c.doneAt = now; else delete c.doneAt; }
  await saveMemory();
  return { ...c, advanced };
}

// ---------- facts (long-term memory about the user) ----------

const FACT_CAP = 150;
export const listFacts = () => loadMemory().facts.slice();

/** Saves a fact; a near-duplicate of an existing one replaces it instead of piling up. */
export async function addFact(text) {
  const t = String(text).trim().replace(/\s+/g, ' ').slice(0, 240);
  const key = t.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  const facts = loadMemory().facts;
  const same = facts.find((f) => f.text.toLowerCase().replace(/[^a-z0-9 ]/g, '') === key);
  if (same) { same.updatedAt = Date.now(); await saveMemory(); return same; }
  const f = { id: newId('f'), text: t, createdAt: Date.now() };
  facts.push(f);
  if (facts.length > FACT_CAP) facts.splice(0, facts.length - FACT_CAP); // oldest go first
  await saveMemory();
  return f;
}

// Picks which facts go into the prompt: the newest few always, then the ones that share words with
// what's being talked about, then the most recently used. Keeps the prompt small as memory grows.
const STOP = new Set('the a an and or but to of in on at for with is are was were be it this that my me i you your his her its our their what how when where why can do does just like about from have has had will would should could not no yes so if then than'.split(' '));
const words = (t) => new Set(String(t).toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((w) => !STOP.has(w)) ?? []);
export function pickFacts(context = '', limit = 40) {
  const facts = loadMemory().facts;
  if (facts.length <= limit) return facts.slice();
  const ctx = words(context), byNew = facts.slice().sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
  const chosen = new Set(byNew.slice(0, 8).map((f) => f.id));
  const scored = facts.filter((f) => !chosen.has(f.id)).map((f) => {
    let hit = 0; for (const w of words(f.text)) if (ctx.has(w)) hit++;
    return { f, score: hit * 10 + ((f.usedAt ?? f.updatedAt ?? f.createdAt) / 1e12) };
  }).sort((a, b) => b.score - a.score);
  for (const { f } of scored) { if (chosen.size >= limit) break; chosen.add(f.id); }
  return facts.filter((f) => chosen.has(f.id));
}

/** Marks facts as used (they were in the prompt for a turn), so useful ones stay near the top. */
export function touchFacts(ids) {
  const now = Date.now(), set = new Set(ids);
  for (const f of loadMemory().facts) if (set.has(f.id)) f.usedAt = now;
}

export async function clearFacts() {
  const n = loadMemory().facts.length;
  memory.facts = [];
  await saveMemory();
  return n;
}

export async function forgetFact(id) {
  const facts = loadMemory().facts, i = facts.findIndex((f) => f.id === id);
  if (i < 0) return null;
  const [f] = facts.splice(i, 1);
  await saveMemory();
  return f;
}

/** Open commitments whose time has come and that haven't been reminded yet. Marks them reminded; plain
 *  reminders are done once they've fired, so they never hang around as overdue. */
export async function takeDueReminders(now = Date.now()) {
  // A repeating commitment left undone past its next time: it moves on to the latest time that has come, and is
  // nudged again (marked `missed`), so skipping Monday's gym doesn't silence Tuesday's.
  const missed = new Set();
  for (const c of openCommitments()) {
    let t = missedAt(c);
    if (t == null || t > now) continue;
    const r = parseRepeat(c.repeat);
    for (let i = 0, n; i < 10_000 && (n = nextOccurrence(r.rule, c.repeatFrom ?? c.due, t)) != null && n <= now; i++) t = n;
    c.due = t; c.remindedAt = null; missed.add(c.id);
  }
  const due = openCommitments().filter((c) => c.due && c.due <= now && !c.remindedAt);
  if (!due.length) return [];
  const fired = due.map((c) => ({ ...c }));
  for (const c of due) {
    c.remindedAt = now;
    // A repeating reminder moves on to its next time; times missed while the computer slept are skipped, not stacked.
    if (c.kind === 'reminder' && c.repeat && advance(c, now)) continue;
    if (c.kind === 'reminder') { c.status = 'done'; c.doneAt = now; }
  }
  await saveMemory();
  return fired.map((c, i) => ({ ...c, missed: missed.has(c.id), next: due[i].repeat && due[i].status === 'open' && due[i].due !== c.due ? due[i].due : null }));
}
