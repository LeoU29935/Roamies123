// Memory sync between computers through a shared folder: the merge, what's accepted from another computer, and two
// computers converging through a real folder. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-sync-test-'));
process.env.HOME = TMP; process.env.USERPROFILE = TMP; delete process.env.ROAMIES_DATA_DIR;
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const { merge, cleanRemote, checkFolder, readRemotes, writeOwn, prepareFolder, seal, unseal, deriveKey, SUBDIR, HEADER, TOMB_DAYS } = await import('../sync.mjs');

const T = 1_800_000_000_000;
const c = (id, text, extra = {}) => ({ id, text, due: null, createdAt: T, status: 'open', remindedAt: null, kind: 'commitment', ...extra });
const f = (id, text, extra = {}) => ({ id, text, createdAt: T, ...extra });
const remoteOf = (r) => cleanRemote(JSON.parse(JSON.stringify(r.out)), r.out.at + 1);

// Two computers with different things: both end up with everything.
let A = merge({ local: { commitments: [c('ca1', 'Mac task')], facts: [f('fa1', 'Likes tea')] }, device: 'aaaaaaaaaaaa', now: T + 10 });
let B = merge({ local: { commitments: [c('cb1', 'PC task')], facts: [] }, device: 'bbbbbbbbbbbb', now: T + 20 });
assert.equal(A.changed, false, 'nothing from elsewhere yet');
let A2 = merge({ local: A, state: A.state, remotes: [remoteOf(B)], device: 'aaaaaaaaaaaa', now: T + 30 });
assert.ok(A2.changed);
assert.deepEqual(A2.commitments.map((x) => x.id), ['ca1', 'cb1']);
assert.deepEqual(A2.facts.map((x) => x.text), ['Likes tea']);
// Nothing new: no change, and stamps stay put.
const A3 = merge({ local: A2, state: A2.state, remotes: [remoteOf(B)], device: 'aaaaaaaaaaaa', now: T + 40 });
assert.equal(A3.changed, false);
assert.deepEqual(A3.state.items, A2.state.items, 'a quiet pass changes no stamps');

// The newer change wins, whichever computer made it.
const B2 = merge({ local: { commitments: [c('cb1', 'PC task'), c('ca1', 'Mac task')], facts: [] }, state: B.state, device: 'bbbbbbbbbbbb', now: T + 50 });
const edited = merge({ local: { commitments: [c('ca1', 'Mac task', { status: 'done', doneAt: T + 60 }), c('cb1', 'PC task')], facts: A3.facts }, state: A3.state, device: 'aaaaaaaaaaaa', now: T + 60 });
const B3 = merge({ local: B2, state: B2.state, remotes: [remoteOf(edited)], device: 'bbbbbbbbbbbb', now: T + 70 });
assert.equal(B3.commitments.find((x) => x.id === 'ca1').status, 'done', 'the Mac ticked it off later: done on the PC too');
const older = merge({ local: { commitments: [c('ca1', 'Mac task, renamed long ago')], facts: [] }, state: { items: { 'c:ca1': { hash: 'x', at: T + 1 } }, tombs: {} }, device: 'cccccccccccc', now: T + 1 });
const B4 = merge({ local: B3, state: B3.state, remotes: [remoteOf(edited), remoteOf(older)], device: 'bbbbbbbbbbbb', now: T + 80 });
assert.equal(B4.commitments.find((x) => x.id === 'ca1').text, 'Mac task', 'an older change loses');

// Deleting on one computer deletes on the other, and it doesn't come back.
const gone = merge({ local: { commitments: B4.commitments.filter((x) => x.id !== 'cb1'), facts: B4.facts }, state: B4.state, device: 'bbbbbbbbbbbb', now: T + 90 });
assert.ok(gone.out.tombs['c:cb1'] === T + 90, 'tombstone written');
const A4 = merge({ local: edited, state: edited.state, remotes: [remoteOf(gone)], device: 'aaaaaaaaaaaa', now: T + 100 });
assert.ok(!A4.commitments.some((x) => x.id === 'cb1'), 'deleted here too');
const A5 = merge({ local: A4, state: A4.state, remotes: [remoteOf(gone), remoteOf(B)], device: 'aaaaaaaaaaaa', now: T + 110 });
assert.ok(!A5.commitments.some((x) => x.id === 'cb1'), 'an old copy elsewhere doesn\'t bring it back');
// Changed again after the deletion, somewhere: it lives.
const revived = merge({ local: { commitments: [c('cb1', 'PC task, changed after')], facts: [] }, state: { items: { 'c:cb1': { hash: 'x', at: T + 20 } }, tombs: {} }, device: 'dddddddddddd', now: T + 120 });
const A6 = merge({ local: A5, state: A5.state, remotes: [remoteOf(gone), remoteOf(revived)], device: 'aaaaaaaaaaaa', now: T + 130 });
assert.equal(A6.commitments.find((x) => x.id === 'cb1')?.text, 'PC task, changed after', 'a later change outlives the tombstone');
assert.ok(!('c:cb1' in A6.out.tombs));
// Old tombstones are dropped.
const late = merge({ local: A5, state: A5.state, device: 'aaaaaaaaaaaa', now: T + 100 + (TOMB_DAYS + 1) * 864e5 });
assert.ok(!('c:cb1' in late.out.tombs), 'tombstones expire');

// How recently a fact was used stays on each computer and never counts as a change.
const used = merge({ local: { commitments: [], facts: [f('fa1', 'Likes tea', { usedAt: T + 999 })] }, state: A.state, device: 'aaaaaaaaaaaa', now: T + 200 });
assert.equal(used.state.items['f:fa1'].at, A.state.items['f:fa1'].at, 'usedAt is not a change');
assert.ok(!('usedAt' in used.out.items['f:fa1'].v), 'and isn\'t written out');
assert.equal(used.facts[0].usedAt, T + 999, 'kept here');

// What's accepted from another computer.
const now = T + 1000;
const bad = cleanRemote({ version: 1, device: 'eeeeeeeeeeee', items: {
  'c:ce1': { v: c('ce1', 'fine'), at: T },
  'c:ce2': { v: c('ce3', 'id mismatch'), at: T },
  'c:ce4': { v: c('ce4', 'bad status', { status: 'deleted' }), at: T },
  'c:ce5': { v: c('ce5', 'x'.repeat(600)), at: T },
  'c:ce6': { v: c('ce6', 'from the future'), at: now + 2 * 864e5 },
  'f:fe1': { v: f('fe1', 'fine fact'), at: T },
  'f:../x': { v: f('../x', 'path'), at: T },
  'z:ze1': { v: f('ze1', 'unknown kind'), at: T },
}, tombs: { 'c:ce7': T, 'c:bad id': T } }, now);
assert.deepEqual(Object.keys(bad.items).sort(), ['c:ce1', 'f:fe1']);
assert.deepEqual(Object.keys(bad.tombs), ['c:ce7']);
assert.equal(cleanRemote({ version: 2, device: 'x', items: {} }), null, 'a newer format is left alone');
assert.equal(cleanRemote('nonsense'), null);

// Encryption: a round trip, and nothing opens with the wrong key, the wrong device id, or a changed byte.
{
  const k1 = deriveKey('correct horse battery', Buffer.alloc(16, 1)), k2 = deriveKey('correct horse batterz', Buffer.alloc(16, 1));
  const box = seal(k1, { hello: 'world' }, 'aaaaaaaaaaaa');
  assert.deepEqual(unseal(k1, box, 'aaaaaaaaaaaa'), { hello: 'world' });
  assert.throws(() => unseal(k2, box, 'aaaaaaaaaaaa'), 'another passphrase');
  assert.throws(() => unseal(k1, box, 'bbbbbbbbbbbb'), 'a file renamed to pass for another computer');
  const bad = { ...box, data: Buffer.from(Buffer.from(box.data, 'base64').map((b, i) => (i === 0 ? b ^ 1 : b))).toString('base64') };
  assert.throws(() => unseal(k1, bad, 'aaaaaaaaaaaa'), 'a changed byte');
  assert.notEqual(seal(k1, 'x', 'a').iv, seal(k1, 'x', 'a').iv, 'a fresh IV every time');
}

// The folder.
assert.equal(checkFolder('', TMP).ok, false);
assert.equal(checkFolder(TMP, TMP).ok, false, 'not the home folder itself');
assert.equal(checkFolder(path.join(TMP, 'nope'), TMP).ok, false);
fs.mkdirSync(path.join(TMP, 'Cloud'));
assert.deepEqual(checkFolder('~/Cloud', TMP), { ok: true, dir: path.join(TMP, 'Cloud') });

// Two computers through a real folder, a few passes each: they converge, and each writes only its own file.
{
  const dir = path.join(TMP, 'Cloud');
  const setup1 = await prepareFolder(dir, 'correct horse battery'), setup2 = await prepareFolder(dir, 'correct horse battery');
  assert.ok(setup1.key && setup2.key && setup1.key.equals(setup2.key), 'the same passphrase gives both computers the same key');
  assert.match((await prepareFolder(dir, 'short')).error, /at least 8/, 'too short a passphrase is refused');
  const head = JSON.parse(fs.readFileSync(path.join(dir, SUBDIR, HEADER), 'utf8'));
  assert.ok(head.salt && head.check && !JSON.stringify(head).includes('correct horse'), 'the header holds a salt and a check, never the passphrase');
  const pc = { key: setup1.key, id: 'aaaaaaaaaaaa', local: { commitments: [c('c01', 'Mac 1'), c('c02', 'Mac 2')], facts: [f('f01', 'Has a cat')] }, state: undefined };
  const win = { key: setup2.key, id: 'bbbbbbbbbbbb', local: { commitments: [c('c03', 'Win 1')], facts: [f('f02', 'Lives in Berlin')] }, state: undefined };
  let t = T + 5000;
  const pass = async (me) => {
    t += 10;
    const r = merge({ local: me.local, state: me.state, remotes: await readRemotes(dir, me.id, me.key, t), device: me.id, name: 'Lab-PC', now: t });
    await writeOwn(dir, me.id, r.out, me.key);
    me.local = { commitments: r.commitments, facts: r.facts }; me.state = r.state;
  };
  await pass(pc); await pass(win); await pass(pc);
  win.local.commitments = win.local.commitments.map((x) => (x.id === 'c01' ? { ...x, status: 'done', doneAt: t } : x));
  win.local.facts = win.local.facts.filter((x) => x.id !== 'f01');
  await pass(win); await pass(pc); await pass(win);
  const view = (m) => JSON.stringify({ c: m.local.commitments.map((x) => [x.id, x.status]), f: m.local.facts.map((x) => x.id) });
  assert.equal(view(pc), view(win), 'both computers hold the same memory');
  assert.deepEqual(JSON.parse(view(pc)), { c: [['c01', 'done'], ['c02', 'open'], ['c03', 'open']], f: ['f02'] });
  assert.deepEqual(fs.readdirSync(path.join(dir, SUBDIR)).sort(), ['aaaaaaaaaaaa.json', 'bbbbbbbbbbbb.json', 'sync.json'], 'one file each plus the header, no temp files left');
  fs.writeFileSync(path.join(dir, SUBDIR, 'cccccccccccc.json'), '{"version":1,"device":"ccc'); // half synced
  assert.equal((await readRemotes(dir, pc.id, pc.key)).length, 1, 'a half-written file is skipped');
  // Nothing in the folder can be read without the passphrase: not the reminders, the facts or the computer's name.
  for (const f of fs.readdirSync(path.join(dir, SUBDIR))) {
    const text = fs.readFileSync(path.join(dir, SUBDIR, f), 'utf8');
    for (const secret of ['Mac 1', 'Win 1', 'Lives in Berlin', 'Lab-PC', 'commitment', 'status']) assert.ok(!text.includes(secret), `${f} doesn't show "${secret}"`);
  }
  // A third computer set up with another passphrase can't join, and its file isn't read here.
  const other = await prepareFolder(dir, 'a different passphrase');
  assert.match(other.error, /isn't the passphrase/, 'a different passphrase is refused at setup');
  const strangerKey = deriveKey('a different passphrase', Buffer.alloc(16, 7));
  await writeOwn(dir, 'cccccccccccc', { version: 1, device: 'cccccccccccc', name: '', at: Date.now(), items: {}, tombs: {} }, strangerKey);
  const seen = await readRemotes(dir, pc.id, pc.key);
  assert.equal(seen.length, 1, 'the stranger file is not merged');
  assert.equal(seen.unreadable, 1, 'and is reported as unreadable');
}

// The store's side: applying a merge only if memory didn't change meanwhile.
{
  const S = await import('../store.mjs');
  await S.addCommitment('Local one', null);
  const snap = S.syncSnapshot();
  assert.equal(snap.commitments.length, 1);
  assert.equal(await S.applySynced({ commitments: [...snap.commitments, c('c99', 'From the PC')], facts: [] }, snap.basis), true);
  assert.deepEqual(S.openCommitments().map((x) => x.text), ['Local one', 'From the PC']);
  const snap2 = S.syncSnapshot();
  await S.addCommitment('Added meanwhile', null);
  assert.equal(await S.applySynced({ commitments: [], facts: [] }, snap2.basis), false, 'changed meanwhile: not applied');
  assert.equal(S.openCommitments().length, 3, 'nothing lost');
  await S.flushWrites();
}
console.log('sync tests: passed');
