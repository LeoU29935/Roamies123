// Saving a card as an image: file names, and only real PNGs written. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imageName, saveCardImage } from '../cardimage.mjs';

const at = new Date(2026, 10, 12, 15, 4, 9);
assert.equal(imageName('planets', at), 'Roamies – planets – 2026-11-12 15.04.09.png');
assert.equal(imageName('a/b:c*?"<>|d', at), 'Roamies – a b c d – 2026-11-12 15.04.09.png', 'no path or reserved characters');
assert.equal(imageName('..', at), 'Roamies – card – 2026-11-12 15.04.09.png');
assert.equal(imageName('', at).startsWith('Roamies – card'), true);
assert.ok(imageName('x'.repeat(200), at).length < 80, 'kept short');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-img-'));
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const f1 = await saveCardImage({ title: 'planets', data: png.toString('base64') }, dir);
const f2 = await saveCardImage({ title: 'planets', data: png.toString('base64') }, dir);
assert.ok(f1.startsWith(dir) && fs.readFileSync(f1).equals(png), 'written as is');
assert.notEqual(f1, f2, 'a second save in the same second gets its own name');
await assert.rejects(saveCardImage({ title: 'x', data: Buffer.from('<svg onload=alert(1)>').toString('base64') }, dir), /not a card image/);
await assert.rejects(saveCardImage({ title: 'x', data: '' }, dir), /not a card image/);
fs.rmSync(dir, { recursive: true, force: true });
console.log('card image tests: passed');
