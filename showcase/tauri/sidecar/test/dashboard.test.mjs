// The dashboard: layouts the model asks for, the panel's drags and resizes, and what's kept. Run: npm test
import assert from 'node:assert/strict';
import { arrange, cleanWidget, defaultDashboard, describeDashboard, loadDashboard, moveWidget, pack, removeWidget, updateWidget, COLS } from '../dashboard.mjs';

const overlap = (ws) => ws.some((a, i) => ws.some((b, j) => i < j && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));
const d0 = defaultDashboard();
assert.deepEqual(d0.widgets.map((w) => w.kind), ['todo', 'notes']);
assert.deepEqual(loadDashboard(undefined), d0, 'nothing saved: the default');
assert.deepEqual(loadDashboard({ version: 7 }), d0, 'a newer or broken one: the default');

// "To-dos on the left, notes on the right, my Clozemaster streak in the middle."
const d1 = arrange(d0, [
  { id: 'w1', kind: 'todo', title: 'To do', x: 0, y: 0, w: 2, h: 4 },
  { kind: 'custom', title: 'Clozemaster streak', x: 2, y: 0, w: 2, h: 2, value: '45', label: 'days', how: 'open clozemaster.com/dashboard and read the streak' },
  { id: 'w2', kind: 'notes', title: 'Notes', x: 4, y: 0, w: 2, h: 4 },
], 1000);
assert.deepEqual(d1.widgets.map((w) => [w.kind, w.x, w.w]), [['todo', 0, 2], ['custom', 2, 2], ['notes', 4, 2]]);
const streak = d1.widgets[1];
assert.equal(streak.id, 'w3', 'a new widget gets a new id');
assert.equal(streak.value, '45'); assert.equal(streak.updatedAt, 1000);
assert.match(describeDashboard(d1), /w3 custom "Clozemaster streak" at column 3-4, row 1-2 = 45 days \(updates by: open clozemaster/);

// Notes keep their text when rearranged without it.
const typed = updateWidget(d1, 'w2', { text: 'Buy milk' });
const d2 = arrange(typed, [{ id: 'w2', kind: 'notes', title: 'Notes', x: 0, y: 0, w: 6, h: 2 }]);
assert.equal(d2.widgets[0].text, 'Buy milk', 'contents survive a new layout');
assert.equal(d2.widgets.length, 1, 'widgets left out are removed');

// Overlaps are pushed down, never stacked.
const crowd = arrange(d0, [{ kind: 'todo', x: 0, y: 0, w: 4, h: 3 }, { kind: 'notes', x: 2, y: 1, w: 4, h: 2 }, { kind: 'custom', x: 0, y: 0, w: 2, h: 1 }]);
assert.ok(!overlap(crowd.widgets), 'no overlaps');
assert.deepEqual(crowd.widgets.map((w) => w.y), [0, 3, 3], 'pushed down to the first free row, side by side where they fit');

// Limits and junk.
assert.equal(cleanWidget({ kind: 'clock' }, 'w1'), null, 'unknown kinds are dropped');
const big = cleanWidget({ kind: 'notes', x: 5, w: 9, h: 99, title: 'x'.repeat(99), text: 'y'.repeat(5000), evil: '<script>' }, 'w1');
assert.equal(big.w, COLS); assert.equal(big.x, 0, 'pulled in so it fits'); assert.equal(big.h, 8); assert.equal(big.title.length, 40); assert.equal(big.text.length, 4000);
assert.ok(!('evil' in big), 'unknown fields dropped');
assert.equal(arrange(d0, Array.from({ length: 20 }, () => ({ kind: 'notes' }))).widgets.length, 12, 'at most 12 widgets');

// The panel: resize and move; the others make room.
const r = moveWidget(d1, 'w1', { w: 4, h: 4 });
assert.deepEqual([r.widgets.find((w) => w.id === 'w1').w, overlap(r.widgets)], [4, false], 'resized, nothing overlapping');
const m = moveWidget(d1, 'w2', { x: 0, y: 0 });
assert.deepEqual(m.widgets.find((w) => w.id === 'w2').x, 0); assert.equal(overlap(m.widgets), false);
assert.equal(moveWidget(d1, 'nope', { x: 1 }), null);
assert.equal(updateWidget(d1, 'nope', { text: 'x' }), null);

// The model updating a custom widget: the value and when; layout fields can't be changed that way.
const u = updateWidget(d1, 'w3', { value: '46', x: 5, kind: 'notes' }, 2000);
assert.deepEqual([u.widgets[1].value, u.widgets[1].updatedAt, u.widgets[1].x, u.widgets[1].kind], ['46', 2000, 2, 'custom']);
assert.equal(removeWidget(d1, 'w3').widgets.length, 2);

// What's saved comes back the same; a duplicated or odd id is dropped.
assert.deepEqual(loadDashboard(JSON.parse(JSON.stringify(d1))), d1);
assert.equal(loadDashboard({ version: 1, widgets: [d1.widgets[0], d1.widgets[0], { ...d1.widgets[1], id: '../x' }] }).widgets.length, 1);
assert.ok(!overlap(pack([{ x: 0, y: 0, w: 6, h: 2 }, { x: 0, y: 0, w: 6, h: 2 }])));
console.log('dashboard tests: passed');
