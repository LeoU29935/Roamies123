// The mind map card: what the draw tool accepts for it. Run: npm test
import assert from 'node:assert/strict';
import { CARDS, DrawArgs, checkDraw } from '../draw.mjs';
import { readFileSync } from 'node:fs';

assert.ok(CARDS.includes('mindmap'), 'a card');
const mm = (branches) => ({ beats: [{ say: 'A map.', marks: [{ kind: 'mindmap', title: 'cells', branches }] }] });
const two = [{ text: 'Nucleus', items: ['Holds DNA'] }, { text: 'Mitochondria', tone: 'amber', items: ['Make ATP', 'Have their own DNA'] }];
assert.equal(DrawArgs.safeParse(mm(two)).success, true);
assert.deepEqual(checkDraw(mm(two)), []);
assert.match(checkDraw(mm([two[0]])).join(), /branches \(at least 2/, 'one branch is not a map');
assert.match(checkDraw(mm(undefined)).join(), /branches/);
assert.equal(DrawArgs.safeParse(mm([...Array(9)].map((_, i) => ({ text: `b${i}` })))).success, false, 'at most 8 branches');
assert.equal(DrawArgs.safeParse(mm([{ text: 'a', items: [...Array(7)].map(() => 'x') }, two[0]])).success, false, 'at most 6 points a branch');
// The overlay draws it: a mindmap renderer next to the others.
assert.ok(readFileSync(new URL('../../../roamies/ink.js', import.meta.url), 'utf8').includes('async mindmap(m)'), 'ink.js draws mind maps');
console.log('mind map tests: passed');
