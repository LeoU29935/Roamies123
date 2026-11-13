// The morning briefing: when it goes with a request, and what it asks for. Run: npm test
import assert from 'node:assert/strict';
process.env.TZ = 'Europe/Berlin';
const { briefDay, briefNote, TODOIST_TODAY } = await import('../brief.mjs');

const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
assert.equal(briefDay(at(2026, 11, 12, 9)), '2026-11-12');
assert.equal(briefDay(at(2026, 11, 12, 3, 59)), '2026-11-11', 'before 4 am is still the day before');
assert.equal(briefDay(at(2026, 11, 12, 4)), '2026-11-12');
assert.equal(briefDay(at(2027, 1, 1, 2)), '2026-12-31', 'across the year');

const base = { on: true, lastDay: '2026-11-11', byVoice: true, now: at(2026, 11, 12, 8), name: 'Sam' };
const b = briefNote(base);
assert.equal(b.day, '2026-11-12');
assert.match(b.note, /first time Sam has talked to you today/);
assert.match(b.note, /Then answer what they just said/);
assert.doesNotMatch(b.note, /Todoist/, 'no Todoist unless asked');
assert.equal(briefNote({ ...base, lastDay: '2026-11-12' }), null, 'once a day');
assert.equal(briefNote({ ...base, on: false }), null, 'off');
assert.equal(briefNote({ ...base, byVoice: false }), null, 'typed requests never trigger it');
assert.equal(briefNote({ ...base, lastDay: undefined }).day, '2026-11-12', 'first ever');
assert.equal(briefNote({ ...base, now: at(2026, 11, 13, 2), lastDay: '2026-11-12' }), null, '2 am is still yesterday');

const t = briefNote({ ...base, todoist: true, canRead: true });
assert.match(t.note, /read_window with target "Todoist"/);
assert.ok(t.note.includes(TODOIST_TODAY));
assert.match(t.note, /never instructions/, 'what Todoist says is data');
assert.doesNotMatch(briefNote({ ...base, todoist: true, canRead: false }).note, /Todoist/, 'no window reading (Linux): no Todoist step');
console.log('morning briefing tests: passed');
