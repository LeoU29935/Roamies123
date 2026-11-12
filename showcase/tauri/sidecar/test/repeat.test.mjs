// Repeating reminders and commitments: the repeat rules, the next time in local time, and how a series fires,
// is ticked off, catches up after a missed time, and ends. Runs against a throwaway HOME. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.TZ = 'America/New_York'; // has daylight saving, so wall-clock times are tested across a change
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-repeat-test-'));
process.env.HOME = TMP; process.env.USERPROFILE = TMP; delete process.env.ROAMIES_DATA_DIR;
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const S = await import('../store.mjs');
assert.ok(S.DIR.startsWith(TMP), 'store must live under the test HOME');

const at = (y, mo, d, h = 9, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const local = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };

// ---------- parsing ----------
{
  const spec = (t) => S.parseRepeat(t)?.spec;
  assert.equal(spec('daily'), 'daily');
  assert.equal(spec('Every day'), 'daily');
  assert.equal(spec('every 1 day'), 'daily');
  assert.equal(spec('weekdays'), 'weekdays');
  assert.equal(spec('every weekday'), 'weekdays');
  assert.equal(spec('mon,tue,wed,thu,fri'), 'weekdays');
  assert.equal(spec('weekends'), 'sun,sat');
  assert.equal(spec('every monday and thursday'), 'mon,thu');
  assert.equal(spec('Fri, Mon, wed'), 'mon,wed,fri');
  assert.equal(spec('on Tuesdays'), 'tue');
  assert.equal(spec('every 2 hours'), 'every 2 hours');
  assert.equal(spec('every 30m'), 'every 30 minutes');
  assert.equal(spec('hourly'), 'every 1 hour');
  assert.equal(spec('every 3 days'), 'every 3 days');
  assert.equal(spec('every 2 weeks'), 'every 2 weeks');
  assert.equal(spec('fortnightly'), 'every 2 weeks');
  assert.equal(spec('monthly'), 'monthly');
  assert.equal(spec('repeats yearly'), 'yearly');
  assert.equal(S.parseRepeat('none'), null);
  assert.equal(S.parseRepeat(''), null);
  assert.equal(S.parseRepeat('every 1 minute'), undefined, 'under 5 minutes is refused');
  assert.equal(S.parseRepeat('every 0 days'), undefined);
  assert.equal(S.parseRepeat('sometimes'), undefined);
  assert.equal(S.parseRepeat('every blue moon'), undefined);
  assert.equal(S.repeatLabel('mon,wed,fri'), 'Mon, Wed, Fri');
  assert.equal(S.repeatLabel('every 2 hours'), 'every 2 hours');
  console.log('repeat parsing tests: passed');
}

// ---------- next time ----------
{
  const next = (t, start, after) => local(S.nextOccurrence(S.parseRepeat(t).rule, start, after));
  const mon = at(2026, 11, 9); // Monday 9 Nov 2026, 9:00
  assert.equal(next('daily', mon, mon), '2026-11-10 9:00');
  assert.equal(next('daily', mon, mon - 1), '2026-11-9 9:00', 'the start itself counts when it is still ahead');
  assert.equal(next('daily', mon, at(2026, 11, 20, 12)), '2026-11-21 9:00', 'jumps straight past many missed days');
  assert.equal(next('weekdays', mon, at(2026, 11, 13, 10)), '2026-11-16 9:00', 'Friday after 9 → Monday');
  assert.equal(next('mon,thu', mon, mon), '2026-11-12 9:00');
  assert.equal(next('weekly', mon, mon), '2026-11-16 9:00');
  assert.equal(next('every 2 weeks', mon, at(2026, 11, 17)), '2026-11-23 9:00');
  assert.equal(next('every 3 days', mon, at(2026, 11, 10)), '2026-11-12 9:00');
  assert.equal(S.nextOccurrence(S.parseRepeat('every 2 hours').rule, mon, mon + 5 * 36e5), mon + 6 * 36e5);
  // Daylight saving ends 1 Nov 2026 in New York: 9:00 stays 9:00 (a fixed 24 h step would give 8:00).
  assert.equal(next('daily', at(2026, 10, 31), at(2026, 10, 31)), '2026-11-1 9:00', 'across the clock change');
  assert.equal(next('daily', at(2026, 3, 7), at(2026, 3, 7, 10)), '2026-3-8 9:00', 'across the spring change');
  // Monthly on the 31st: clamps in short months, comes back to the 31st after.
  const jan31 = at(2027, 1, 31);
  assert.equal(next('monthly', jan31, jan31), '2027-2-28 9:00');
  assert.equal(next('monthly', jan31, at(2027, 2, 28, 10)), '2027-3-31 9:00');
  assert.equal(next('monthly', jan31, at(2027, 4, 1)), '2027-4-30 9:00');
  assert.equal(next('yearly', at(2028, 2, 29), at(2028, 3, 1)), '2029-2-28 9:00', 'leap day');
  console.log('repeat next-time tests: passed');
}

// ---------- the series in the store ----------
{
  const H = 36e5;
  // A repeating reminder moves on each time it fires and never closes.
  const start = Date.now() - 1000;
  const r = await S.addCommitment('Drink water', start, 'reminder', 'every 2 hours');
  assert.equal(r.repeat, 'every 2 hours');
  let fired = await S.takeDueReminders();
  assert.deepEqual(fired.map((c) => c.id), [r.id], 'fires');
  assert.equal(fired[0].next, start + 2 * H, 'reports where it moved on to');
  let c = S.openCommitments().find((x) => x.id === r.id);
  assert.ok(c && c.status === 'open' && c.due === start + 2 * H && !c.remindedAt, 'still open, at its next time');
  assert.equal(S.nextDue(), start + 2 * H, 'the timer sleeps until then');
  // Asleep for 9 hours: it fires once, not four times, and moves past now.
  fired = await S.takeDueReminders(start + 9 * H);
  assert.equal(fired.length, 1, 'missed times are skipped, not stacked');
  c = S.openCommitments().find((x) => x.id === r.id);
  assert.equal(c.due, start + 10 * H);
  // Dropping ends it.
  await S.updateCommitment(r.id, { status: 'dropped' });
  assert.ok(!S.openCommitments().some((x) => x.id === r.id), 'dropped ends the series');

  // A repeating commitment: nudged once, moves on when done; skipped days catch up and nudge again.
  const mon9 = at(2026, 11, 9), now0 = mon9 + 60e3;
  const g = await S.addCommitment('Gym', mon9, 'commitment', 'weekdays');
  fired = await S.takeDueReminders(now0);
  assert.deepEqual(fired.map((x) => x.id), [g.id]);
  assert.equal((await S.takeDueReminders(now0 + 60e3)).length, 0, 'not nagged twice for the same time');
  assert.equal(S.nextDue(), at(2026, 11, 10), 'wakes again at the next time if it is still not done');
  // Not done Monday or Tuesday; on Wednesday at 10 it catches up to Wednesday 9:00 and nudges again.
  fired = await S.takeDueReminders(at(2026, 11, 11, 10));
  assert.equal(fired.length, 1);
  assert.ok(fired[0].missed, 'flagged as missed');
  assert.equal(local(fired[0].due), '2026-11-11 9:00', 'caught up to the latest time');
  // Done on Wednesday → Thursday 9:00, still open, counted.
  const done = await S.updateCommitment(g.id, { status: 'done', now: at(2026, 11, 11, 18) });
  assert.ok(done.advanced, 'done moves it on');
  assert.equal(done.status, 'open');
  assert.equal(local(done.due), '2026-11-12 9:00');
  assert.equal(done.timesDone, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(S.DIR, 'memory.json'), 'utf8')).commitments.find((x) => x.id === g.id);
  assert.ok(!('advanced' in saved), 'the result flag is not written to disk');
  // Done early (Thursday's, ticked off on Wednesday night) → Friday, not Thursday again.
  const early = await S.updateCommitment(g.id, { status: 'done', now: at(2026, 11, 11, 22) });
  assert.equal(local(early.due), '2026-11-13 9:00');
  // Stop repeating: it stays as a one-off at its time; done then closes it.
  const once = await S.updateCommitment(g.id, { repeat: null });
  assert.ok(!once.repeat);
  const closed = await S.updateCommitment(g.id, { status: 'done' });
  assert.ok(!closed.advanced && closed.status === 'done', 'a one-off closes');

  // Snoozed (keepSeries): only this time moves; after it goes off, the series is back at its own time.
  {
    const d9 = at(2026, 12, 1, 9), r2 = await S.addCommitment('Vitamins', d9, 'reminder', 'daily');
    await S.takeDueReminders(d9 + 1000); // fired: now due tomorrow at 9
    await S.updateCommitment(r2.id, { status: 'open', dueMs: d9 + 10 * 60e3, keepSeries: true }); // "snooze 10 minutes"
    let x = S.openCommitments().find((q) => q.id === r2.id);
    assert.equal(local(x.due), '2026-12-1 9:10', 'snoozed to 9:10');
    await S.takeDueReminders(d9 + 11 * 60e3);
    x = S.openCommitments().find((q) => q.id === r2.id);
    assert.equal(local(x.due), '2026-12-2 9:00', 'then back to 9:00 tomorrow, not 9:10');
    // Without keepSeries, a new time moves the whole series (that's "move it to 10 every day").
    await S.updateCommitment(r2.id, { dueMs: at(2026, 12, 2, 10) });
    await S.takeDueReminders(at(2026, 12, 2, 10, 1));
    assert.equal(local(S.openCommitments().find((q) => q.id === r2.id).due), '2026-12-3 10:00');
    await S.updateCommitment(r2.id, { status: 'dropped' });
  }
  // "Weekdays at 9" asked for on a Saturday starts on Monday.
  const w = await S.addCommitment('Stand-up', at(2026, 11, 14), 'reminder', 'weekdays');
  assert.equal(local(w.due), '2026-11-16 9:00');
  // A repeat with no time can't fire, so it isn't kept as a series.
  const n = await S.addCommitment('Someday thing', null, 'commitment', 'daily');
  assert.ok(!n.repeat);
  // The list carries the rule.
  const L = S.listItems(at(2026, 11, 14, 8));
  assert.equal([...L.today, ...L.later].find((i) => i.id === w.id).repeat, 'weekdays');
  // Plain one-off reminders behave as before.
  const one = await S.addCommitment('One-off', Date.now() - 1000, 'reminder');
  await S.takeDueReminders();
  assert.ok(!S.openCommitments().some((x) => x.id === one.id), 'a one-off reminder still clears itself');
  await S.flushWrites();
  console.log('repeat series tests: passed');
}
