// Memory sync between computers (macOS and Windows) through a folder the user already syncs (iCloud Drive, OneDrive,
// Dropbox, Google Drive). No server, no account: each computer writes only its own file, <folder>/Roamies Sync/<device>.json,
// and reads the others', so the sync service never sees two computers editing one file. Commitments, reminders and facts
// are merged item by item, newest change wins; a deletion is kept as a tombstone so it isn't brought back.
// Conversations, sign-ins and keys are never written there.
// Everything in the folder is encrypted (AES-256-GCM) with a key made from a passphrase the user types on each computer
// (scrypt, with a salt kept in the folder's sync.json). The key stays in each computer's own secret store (secrets.mjs);
// the passphrase itself is never stored. Only the random device ids in the file names are readable.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SUBDIR = 'Roamies Sync';
export const HEADER = 'sync.json';
export const KEY_NAME = 'sync-key'; // the secret store's name for this computer's copy of the key
export const MIN_PASSPHRASE = 8;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const CHECK = 'roamies-sync';

// ---------- encryption ----------
/** The folder key from the passphrase and the folder's salt (scrypt; about a tenth of a second, at setup only). */
export const deriveKey = (passphrase, salt) => scryptSync(String(passphrase).normalize('NFC'), salt, 32, SCRYPT);
/** Encrypts a JSON value; aad (the device id, or 'check') is bound in, so a file can't be passed off as another's. */
export function seal(key, value, aad) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(String(aad)));
  const data = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
/** Decrypts what seal made; throws if the key is wrong or anything was changed. */
export function unseal(key, box, aad) {
  if (typeof box?.iv !== 'string' || typeof box.tag !== 'string' || typeof box.data !== 'string') throw new Error('not sealed');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  d.setAAD(Buffer.from(String(aad)));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'));
}

/**
 * Sets up the folder for this passphrase: the first computer writes sync.json (a new salt, and a check sealed with the
 * key); the next ones check the passphrase against it. → { key } or { error } (too short, or not the passphrase the
 * folder was set up with).
 */
export async function prepareFolder(dir, passphrase) {
  if (String(passphrase ?? '').length < MIN_PASSPHRASE) return { error: `The passphrase needs at least ${MIN_PASSPHRASE} characters.` };
  const sub = path.join(dir, SUBDIR), file = path.join(sub, HEADER);
  await fs.mkdir(sub, { recursive: true });
  const read = async () => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } };
  let head = await read();
  if (!head) {
    const salt = randomBytes(16), key = deriveKey(passphrase, salt);
    const fresh = { version: 1, kdf: 'scrypt', salt: salt.toString('base64'), check: seal(key, CHECK, 'check') };
    try { await fs.writeFile(file, JSON.stringify(fresh), { flag: 'wx', mode: 0o600 }); return { key }; } catch { head = await read(); }
  }
  if (head?.version !== 1 || head.kdf !== 'scrypt' || typeof head.salt !== 'string') return { error: 'The sync folder was set up by a newer Roamies, or its sync.json is damaged.' };
  const key = deriveKey(passphrase, Buffer.from(head.salt, 'base64'));
  try { if (unseal(key, head.check, 'check') === CHECK) return { key }; } catch { /* wrong passphrase */ }
  return { error: "That isn't the passphrase this sync folder was set up with. Use the same one as on your other computer." };
}
export const TOMB_DAYS = 60;
const MAX_FILE = 5 * 1024 * 1024;
const SKEW_MS = 24 * 3600_000; // a stamp further ahead than this is a broken clock, not a change
const VOLATILE = { f: ['usedAt'], c: [] }; // fields that change all the time and never sync

const stable = (v) => JSON.stringify(v, Object.keys(v).sort());
const strip = (kind, v) => { const o = { ...v }; for (const k of VOLATILE[kind]) delete o[k]; return o; };
export const hashItem = (kind, v) => createHash('sha256').update(stable(strip(kind, v))).digest('hex').slice(0, 16);
// An item's own idea of when it last changed, for the first pass (before there's any sync state).
const ownTime = (v) => Math.max(0, ...['createdAt', 'updatedAt', 'doneAt', 'remindedAt'].map((k) => (Number.isFinite(v?.[k]) ? v[k] : 0)));

/** A new device id (kept in config). */
export const newDevice = () => randomBytes(6).toString('hex');

// ---------- checking what another computer wrote ----------
const ID = /^[cf][0-9a-f]{1,16}$/;
const STATUS = new Set(['open', 'done', 'dropped']);
function validItem(key, v) {
  if (!v || typeof v !== 'object' || typeof v.id !== 'string' || `${key[0]}:${v.id}` !== key || !ID.test(v.id)) return false;
  if (typeof v.text !== 'string' || !v.text.trim() || v.text.length > 500) return false;
  if (key[0] === 'c') {
    if (!STATUS.has(v.status) || (v.due != null && !Number.isFinite(v.due)) || !Number.isFinite(v.createdAt)) return false;
    if (v.kind != null && v.kind !== 'reminder' && v.kind !== 'commitment') return false;
  }
  return Object.keys(v).length <= 20 && JSON.stringify(v).length <= 2000;
}
/** A remote file's contents → { device, items, tombs } with anything malformed dropped, or null. */
export function cleanRemote(data, now = Date.now()) {
  if (data?.version !== 1 || typeof data.device !== 'string' || typeof data.items !== 'object' || !data.items) return null;
  const items = {}, tombs = {};
  for (const [key, e] of Object.entries(data.items)) {
    if (/^[cf]:/.test(key) && Number.isFinite(e?.at) && e.at <= now + SKEW_MS && validItem(key, e.v)) items[key] = { v: e.v, at: e.at };
  }
  for (const [key, at] of Object.entries(data.tombs ?? {})) if (/^[cf]:[0-9a-f]{1,16}$/.test(key) && Number.isFinite(at) && at <= now + SKEW_MS) tombs[key] = at;
  return { device: data.device, items, tombs };
}

// ---------- the merge (pure) ----------
/**
 * local: { commitments, facts } as stored here. state: what the last pass saw ({ items: {key: {hash, at}}, tombs }).
 * remotes: cleaned files from the other computers. → { commitments, facts, state, out, changed }
 * out is this computer's file; changed says whether local memory needs replacing.
 */
export function merge({ local, state = { items: {}, tombs: {} }, remotes = [], device, name = '', now = Date.now() }) {
  const prevItems = state.items ?? {}, tombs = { ...(state.tombs ?? {}) };
  const mine = new Map();
  for (const [kind, list] of [['c', local.commitments ?? []], ['f', local.facts ?? []]]) {
    for (const v of list) {
      const key = `${kind}:${v.id}`, h = hashItem(kind, v), prev = prevItems[key];
      // Changed here since the last pass: stamped now. New to the sync state: its own times say when.
      mine.set(key, { v, at: prev ? (prev.hash === h ? prev.at : now) : ownTime(v) || now });
    }
  }
  // Gone since the last pass: deleted here.
  for (const key of Object.keys(prevItems)) if (!mine.has(key) && !(key in tombs)) tombs[key] = now;
  for (const r of remotes) for (const [key, at] of Object.entries(r.tombs)) if (!(at <= (tombs[key] ?? -1))) tombs[key] = at;

  const best = new Map(mine);
  for (const r of remotes) {
    for (const [key, e] of Object.entries(r.items)) {
      const cur = best.get(key);
      if (!cur || e.at > cur.at || (e.at === cur.at && stable(e.v) > stable(cur.v))) best.set(key, e);
    }
  }
  const keep = new Map();
  for (const [key, e] of best) if (!(key in tombs) || tombs[key] < e.at) keep.set(key, e);
  // An item that came back after its tombstone is alive again; the tombstone goes.
  for (const key of keep.keys()) delete tombs[key];
  const cut = now - TOMB_DAYS * 864e5;
  for (const [key, at] of Object.entries(tombs)) if (at < cut) delete tombs[key];

  const usedAt = new Map((local.facts ?? []).map((f) => [f.id, f.usedAt]));
  const pick = (kind) => [...keep].filter(([k]) => k[0] === kind).map(([, e]) => {
    const v = { ...e.v };
    if (kind === 'f') { delete v.usedAt; if (usedAt.get(v.id) != null) v.usedAt = usedAt.get(v.id); }
    return v;
  }).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || (a.id < b.id ? -1 : 1));
  const commitments = pick('c'), facts = pick('f');

  const items = {}, outItems = {};
  for (const [key, e] of keep) { items[key] = { hash: hashItem(key[0], e.v), at: e.at }; outItems[key] = { v: strip(key[0], e.v), at: e.at }; }
  const sig = (cs, fs) => [...cs.map((v) => `c:${v.id}:${hashItem('c', v)}`), ...fs.map((v) => `f:${v.id}:${hashItem('f', v)}`)].sort().join('|');
  const changed = sig(commitments, facts) !== sig(local.commitments ?? [], local.facts ?? []);
  return {
    commitments, facts, changed,
    state: { items, tombs },
    out: { version: 1, device, name: String(name).slice(0, 60), at: now, items: outItems, tombs },
  };
}

// ---------- the folder ----------
/** Folders that sync on this computer, best first, for the setup prompt's suggestion. */
export function suggestFolders(home = os.homedir(), platform = process.platform) {
  const c = [];
  if (platform === 'darwin') {
    c.push(path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'));
    try { for (const d of readdirSync(path.join(home, 'Library', 'CloudStorage'))) c.push(path.join(home, 'Library', 'CloudStorage', d)); } catch { /* none */ }
  }
  c.push(path.join(home, 'OneDrive'), path.join(home, 'Dropbox'), path.join(home, 'iCloudDrive'), path.join(home, 'Google Drive'), path.join(home, 'My Drive'));
  if (platform === 'win32') c.push('G:\\My Drive');
  return c.filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } });
}

/** Typed folder → { ok, dir } or { ok: false, why }. It must exist; a ~ is expanded; the home folder itself is refused. */
export function checkFolder(raw, home = os.homedir()) {
  let d = String(raw ?? '').trim().replace(/^["']|["']$/g, '');
  if (!d) return { ok: false, why: 'empty' };
  if (d === '~' || d.startsWith('~/') || d.startsWith('~\\')) d = path.join(home, d.slice(1));
  d = path.resolve(d);
  if (d === path.resolve(home) || d === path.parse(d).root) return { ok: false, why: 'Pick the synced folder itself (like iCloud Drive or OneDrive), not your whole home folder.' };
  try { if (!statSync(d).isDirectory()) return { ok: false, why: 'That\'s a file, not a folder.' }; } catch { return { ok: false, why: 'I can\'t find that folder on this computer.' }; }
  return { ok: true, dir: d };
}

/** The other computers' files in the folder, decrypted and cleaned. Half-synced ones are skipped this time; ones that
 *  don't open with this key (another passphrase, or changed) are counted in out.unreadable. */
export async function readRemotes(dir, device, key, now = Date.now()) {
  const sub = path.join(dir, SUBDIR), out = [];
  out.unreadable = 0;
  let names = [];
  try { names = await fs.readdir(sub); } catch { return out; }
  for (const n of names) {
    if (!/^[0-9a-f]{12}\.json$/.test(n) || n === `${device}.json`) continue;
    const id = n.slice(0, -5);
    let outer;
    try {
      const f = path.join(sub, n);
      if ((await fs.stat(f)).size > MAX_FILE) continue;
      outer = JSON.parse(await fs.readFile(f, 'utf8'));
    } catch { continue; } // being written or synced right now
    if (outer?.version !== 1 || outer.device !== id) continue;
    let inner;
    try { inner = unseal(key, outer.enc, id); } catch { out.unreadable++; continue; }
    const r = cleanRemote(inner, now);
    if (r && r.device === id) out.push(r);
  }
  return out;
}

/** Writes this computer's file, encrypted: a temp file, then a rename, so another computer never reads half of it. */
export async function writeOwn(dir, device, data, key) {
  const sub = path.join(dir, SUBDIR);
  await fs.mkdir(sub, { recursive: true });
  const file = path.join(sub, `${device}.json`), tmp = path.join(sub, `.${device}.${randomBytes(3).toString('hex')}.tmp`);
  await fs.writeFile(tmp, JSON.stringify({ version: 1, device, enc: seal(key, data, device) }), { mode: 0o600 });
  await fs.rename(tmp, file);
  return file;
}

export const folderReady = (dir) => !!dir && existsSync(dir);
