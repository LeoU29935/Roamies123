// "Save as image" on a card (ink.js renders it as a PNG): saved to the Downloads folder under the card's title.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_BYTES = 12 * 1024 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Where it goes: ~/Downloads, or the home folder where there isn't one. */
export const imageDir = (home = os.homedir()) => (existsSync(path.join(home, 'Downloads')) ? path.join(home, 'Downloads') : home);

/** A safe file name from a card's title and the time: "Roamies – planets – 2026-11-12 15.04.09.png". */
export function imageName(title, at = new Date()) {
  const t = String(title ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '').replace(/\s+/g, ' ').slice(0, 40) || 'card';
  const p = (n) => String(n).padStart(2, '0');
  return `Roamies – ${t} – ${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}.${p(at.getMinutes())}.${p(at.getSeconds())}.png`;
}

/** Base64 PNG from the overlay → the saved file's path. Anything that isn't a PNG, or is too big, is refused. */
export async function saveCardImage({ title, data }, dir = imageDir()) {
  const buf = Buffer.from(String(data ?? ''), 'base64');
  if (buf.length < 100 || buf.length > MAX_BYTES || !buf.subarray(0, 8).equals(PNG)) throw new Error('not a card image');
  let file = path.join(dir, imageName(title));
  for (let i = 2; existsSync(file) && i < 50; i++) file = file.replace(/( \(\d+\))?\.png$/, ` (${i}).png`);
  await fs.writeFile(file, buf, { mode: 0o644, flag: 'wx' });
  return file;
}
