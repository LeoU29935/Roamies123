// Deep explain mode: a deep drawing is marked for the overlay (big cards, one at a time) and keeps one card up.
import assert from 'node:assert/strict';
import { createTools } from '../tools.mjs';
import { DrawArgs } from '../draw.mjs';

assert.equal(DrawArgs.safeParse({ beats: [{ say: 'Hi', marks: [] }], deep: true }).success, true, 'deep is an option');
const events = [];
const noop = async () => {};
const made = createTools({ allowActions: () => false, ui: (m) => { if (m.kind === 'agent' && m.e?.type === 'draw') { events.push(m.e); setTimeout(() => made.ink.started(m.e.id, m.e.seg), 5); } }, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test' });
const draw = made.tools.find((t) => t.name === 'draw');
assert.match(draw.description, /deep: true/, 'the model is told when to use it');
const card = (title, items) => ({ kind: 'list', title, items });
const beats = [
  { say: 'The big picture.', marks: [card('overview', ['DNA to mRNA'])] },
  { say: 'First, initiation.', marks: [card('initiation', ['RNA polymerase binds the promoter'])] },
  { say: 'Then elongation.', marks: [card('elongation', ['mRNA is built 5 to 3'])] },
];
const result = await draw.execute({ beats, deep: true }, { toolCallId: 'deep1' });
assert.ok(events.length >= 1 && events.every((e) => e.deep === true), 'every segment says deep');
assert.match(String(result), /p3/, 'all three cards drawn');
assert.match(String(result), /one card at a time/, 'the model is told only the last is up');
assert.equal(made.ink.describe().split(',').filter((s) => /list/.test(s)).length, 1, 'one card kept up at a time');
events.length = 0;
await draw.execute({ beats: beats.slice(0, 2) }, { toolCallId: 'plain1' });
assert.ok(events.every((e) => !('deep' in e)), 'ordinary drawings are unchanged');
console.log('deep explain tests: passed');
process.exit(0);
