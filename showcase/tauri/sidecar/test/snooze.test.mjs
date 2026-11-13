// Snoozing a reminder by voice: when it comes back, and which one. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.TZ = 'America/New_York';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-snooze-test-'));
process.env.HOME = TMP; process.env.USERPROFILE = TMP; delete process.env.ROAMIES_DATA_DIR;
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const { snoozeUntil, snoozeTarget, SNOOZE_WINDOW_MS } = await import('../snooze.mjs');
const S = await import('../store.mjs');

const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const now = at(2026, 11, 12, 15, 30), due = at(2026, 11, 12, 15, 0);
assert.equal(snoozeUntil('in 10m', due, now), now + 10 * 60_000);
assert.equal(snoozeUntil('10 minutes', due, now), now + 10 * 60_000, 'no "in" needed');
assert.equal(snoozeUntil('1h', due, now), now + 36e5);
assert.equal(snoozeUntil('tomorrow', due, now), at(2026, 11, 13, 15, 0), 'same time tomorrow');
assert.equal(snoozeUntil('Tomorrow', null, now), at(2026, 11, 13, 9, 0), 'no time: 9 am');
assert.equal(snoozeUntil('tonight', due, now), at(2026, 11, 12, 20, 0));
assert.equal(snoozeUntil('tonight', due, at(2026, 11, 12, 21)), at(2026, 11, 13, 20, 0), 'past 8 pm: tomorrow night');
assert.equal(snoozeUntil('2026-11-12T18:00', due, now), at(2026, 11, 12, 18, 0));
assert.equal(snoozeUntil('2026-11-12T09:00', due, now), undefined, 'not in the past');
assert.equal(snoozeUntil('whenever', due, now), undefined);
assert.equal(snoozeUntil('tomorrow', at(2026, 3, 7, 9), at(2026, 3, 7, 10)), at(2026, 3, 8, 9), 'across the clock change, still 9:00');

const fired = [{ id: 'c1', at: now - 60_000 }, { id: 'c2', at: now - 5_000 }, { id: 'c3', at: now - SNOOZE_WINDOW_MS - 1 }];
assert.equal(snoozeTarget('cX', fired, now), 'cX', 'a named one wins');
assert.equal(snoozeTarget(null, fired, now), 'c2', 'the latest that fired');
assert.equal(snoozeTarget(null, [fired[2]], now), null, 'too long ago');
assert.equal(snoozeTarget(null, [], now), null);

// Through the store: a plain reminder clears when it fires; snoozing brings it back, and it fires again.
const r = await S.addCommitment('Call mom', Date.now() - 1000, 'reminder');
await S.takeDueReminders();
assert.equal(S.getCommitment(r.id).status, 'done', 'cleared after firing');
const back = snoozeUntil('in 10m', S.getCommitment(r.id).due);
const c = await S.updateCommitment(r.id, { status: 'open', dueMs: back });
assert.equal(c.status, 'open'); assert.equal(c.due, back); assert.equal(c.remindedAt, null);
assert.equal(S.nextDue(), back, 'the timer wakes for it');
assert.deepEqual((await S.takeDueReminders(back + 1)).map((x) => x.id), [r.id], 'and it goes off again');
assert.equal(S.getCommitment('nope'), null);
const copy = S.getCommitment(r.id); copy.text = 'changed';
assert.equal(S.getCommitment(r.id).text, 'Call mom', 'a copy, not the stored one');
// A repeating reminder: a snooze moves only this time (keepSeries), and after it goes off it's back at its own time.
{
  const nine = at(2026, 12, 1, 9), d = await S.addCommitment('Vitamins', nine, 'reminder', 'daily');
  await S.takeDueReminders(nine + 1000);
  const back10 = snoozeUntil('in 10m', S.getCommitment(d.id).due, nine + 2000);
  await S.updateCommitment(d.id, { status: 'open', dueMs: back10, keepSeries: true });
  assert.equal(S.getCommitment(d.id).due, back10, 'snoozed');
  await S.takeDueReminders(back10 + 1000);
  assert.equal(S.getCommitment(d.id).due, at(2026, 12, 2, 9), 'then tomorrow at 9:00, not 9:10');
  await S.updateCommitment(d.id, { status: 'dropped' });
}
// The snooze tool asks for that, and a reminder nudge's listenAfter reaches prompt() in the right place.
{
  const { readFileSync } = await import('node:fs');
  const tools = readFileSync(new URL('../tools.mjs', import.meta.url), 'utf8'), side = readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
  assert.match(tools, /updateCommitment\(target, \{ status: 'open', dueMs: ms, keepSeries: true \}\)/);
  const params = /async function prompt\(([^)]*)\)/.exec(side)[1].split(',').map((p) => p.trim().split(/\s*=/)[0]);
  const args = /running\.then\(\(\) => prompt\(([^)]*)\)\)/.exec(side)[1].split(',').map((a) => a.trim());
  assert.deepEqual(args, params, 'enqueue passes prompt its arguments in prompt\'s order');
}
await S.flushWrites();
console.log('snooze tests: passed');
