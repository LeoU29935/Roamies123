// The agent's tools: screen capture, reading and working other apps (the "hands" helper), files, commands,
// web pages and memory. Every file, command, URL and open goes through safety.mjs first.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWebFetchTool, createWebSearchTool, runSideWebSearch, runSideWebSearchViaClaudeCode } from '@kenkaiiii/ggcoder/web';
import { z } from 'zod';
import { parseSipsSize, readProblem, rematch, sameBounds, shotFits, shotMap, shotProblem, snapRect, toScreen } from './pointing.mjs';
import { ASK, BLOCK, checkDrawAction, checkFetch, checkOpen, checkRead, checkWrite, classifyCommand, isRiskyClick, isYes, riskyKind } from './safety.mjs';
import { CARDS, DrawArgs, LIMITS, checkDraw, createParts, createPhotos, describeParts, faviconFor, pickTextMatch, quizNote, resolveTargets } from './draw.mjs';
import { plain } from './intro.mjs';
import { linuxSession, seesPointer } from './platform.mjs';
import { addCommitment, forgetFact, getCommitment, parseDue, parseRepeat, repeatLabel, updateCommitment } from './store.mjs';
import { snoozeTarget, snoozeUntil } from './snooze.mjs';

const HOME = os.homedir();
export const expand = (p) => path.resolve(String(p).replace(/^~(?=$|\/|\\)/, HOME));
const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n…(${s.length - n} more characters)` : s);
// windowsHide: no console window flashing up for each command or screenshot on Windows.
// onLine: called with each line of stderr as it arrives (the hands helper's live progress).
export const run = (cmd, args, { onLine, ...opts } = {}) => new Promise((res) => {
  const child = execFile(cmd, args, { maxBuffer: 8 << 20, timeout: 60_000, windowsHide: true, ...opts }, (err, stdout, stderr) => res({ err, stdout: String(stdout), stderr: String(stderr) }));
  if (!onLine || !child.stderr) return;
  let buf = '';
  child.stderr.on('data', (d) => {
    buf += d;
    for (let k; (k = buf.indexOf('\n')) >= 0; buf = buf.slice(k + 1)) { try { onLine(buf.slice(0, k)); } catch { /* a listener's fault never fails the command */ } }
  });
});
// Windows "open": Start-Process gets the target (and the app to open it in) through environment variables, so
// nothing in them is ever parsed as a command (cmd's start split URLs at "&", and quotes in names broke it). A
// failure says "Unable to find application", as macOS's open does.
const WIN_OPEN = "try { if ($env:ROAMIES_OPEN_APP) { Start-Process -FilePath $env:ROAMIES_OPEN_APP -ArgumentList ('\"' + $env:ROAMIES_OPEN + '\"') -ErrorAction Stop } else { Start-Process -FilePath $env:ROAMIES_OPEN -ErrorAction Stop } } catch { [Console]::Error.WriteLine('Unable to find application: ' + $_.Exception.Message); exit 1 }";
export const winOpen = (target, app = '') => run('powershell', ['-NoProfile', '-NonInteractive', '-Command', WIN_OPEN], { env: { ...process.env, ROAMIES_OPEN: target, ROAMIES_OPEN_APP: app } });
// run_command's shell. Windows: cmd /d /s /c "…" passed as is (what Node's shell: true does); handed over as a plain
// argument, Node escaped its quotes as \" which cmd doesn't read, so any command with quotes in it broke.
export const shellFor = (command, platform = process.platform, env = process.env) => (platform === 'win32'
  ? ['cmd.exe', ['/d', '/s', '/c', `"${command}"`], { windowsVerbatimArguments: true }]
  : [env.SHELL || (platform === 'linux' ? '/bin/bash' : '/bin/zsh'), ['-lc', command], {}]);
const THIS_COMPUTER = process.platform === 'darwin' ? 'this Mac' : 'this computer';
const LINUX = process.platform === 'linux';
// A Wayland session hides the pointer and clicks in other apps, so a drawing can't wait for them (platform.mjs).
const POINTER_OK = seesPointer(process.platform, LINUX ? linuxSession() : '');

// ---------- Linux: apps by name ----------
// Apps are listed by their .desktop files (the menus and app grids read the same ones). Opening "Files" or
// "Firefox" finds its entry and starts it the way the desktop would.

/** The [Desktop Entry] group of a .desktop file: its keys (localised ones like Name[de] left out). */
export function parseDesktopEntry(text) {
  const out = {};
  let inMain = false;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) { inMain = line === '[Desktop Entry]'; continue; }
    const eq = line.indexOf('=');
    if (!inMain || eq < 1 || line.startsWith('#')) continue;
    const k = line.slice(0, eq).trim();
    if (!k.includes('[') && !(k in out)) out[k] = line.slice(eq + 1).trim();
  }
  return out;
}

/** The best app for a name, from [{ id: 'org.gnome.Nautilus', file, entry }] (entry as parseDesktopEntry gives).
 *  Hidden ones and anything that isn't an app never match. Best first: the name shown in the menus, the file's
 *  id (or its last part: "nautilus"), the kind of app ("Web Browser"), then a name holding every word asked for
 *  ("chrome" finds "Google Chrome"). */
export function findDesktopApp(apps, name) {
  const want = String(name).trim().toLowerCase().replace(/\.desktop$/, '');
  if (!want) return null;
  const words = want.split(/\s+/);
  const usable = apps.filter(({ entry: e }) => (e.Type ?? 'Application') === 'Application' && e.Exec && e.NoDisplay !== 'true' && e.Hidden !== 'true');
  const low = (s) => String(s ?? '').toLowerCase();
  const tests = [
    (a) => low(a.entry.Name) === want,
    (a) => low(a.id) === want || low(a.id).split('.').pop() === want,
    (a) => low(a.entry.GenericName) === want,
    (a) => words.every((w) => low(a.entry.Name).split(/[^a-z0-9+]+/).includes(w)),
  ];
  for (const t of tests) { const hit = usable.find(t); if (hit) return hit; }
  return null;
}

/** Every app in the XDG application folders (the user's own first, so theirs wins over a system one of the same id). */
async function desktopApps() {
  const dataHome = process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share');
  const dirs = [dataHome, ...(process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':'), path.join(HOME, '.local/share/flatpak/exports/share'), '/var/lib/flatpak/exports/share', '/var/lib/snapd/desktop']
    .filter(Boolean).map((d) => path.join(d, 'applications'));
  const seen = new Set(), apps = [];
  for (const dir of dirs) {
    const files = await fs.readdir(dir).catch(() => []);
    for (const f of files) {
      if (!f.endsWith('.desktop') || seen.has(f)) continue;
      seen.add(f);
      const file = path.join(dir, f);
      const text = await fs.readFile(file, 'utf8').catch(() => '');
      if (text) apps.push({ id: f.slice(0, -'.desktop'.length), file, entry: parseDesktopEntry(text) });
    }
  }
  return apps;
}

/** Runs a launcher (gio, gtk-launch, xdg-open) and resolves when it exits, like run(). Not when its output closes:
 *  the app it starts inherits that output and keeps it open for as long as it runs. */
export const launch = (cmd, args, timeout = 30_000) => new Promise((res) => {
  let p, stderr = '', done = false;
  const finish = (r) => { if (done) return; done = true; clearTimeout(t); p?.stderr?.destroy(); res({ stdout: '', stderr, ...r }); };
  const t = setTimeout(() => { p?.kill(); finish({ err: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }); }, timeout);
  try { p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { return finish({ err: e }); }
  p.stderr.on('data', (d) => { stderr += d; });
  p.on('error', (e) => finish({ err: e }));
  p.on('exit', (code, signal) => finish({ err: code === 0 ? null : Object.assign(new Error(`exit ${code ?? signal}`), { code: code ?? signal }) }));
});

/** Opens an app by name on Linux (gio launch, else gtk-launch). Errors say "Unable to find application" when
 *  there's no such app, as macOS's open does, so the caller words it the same way. */
async function openLinuxApp(name) {
  const app = findDesktopApp(await desktopApps(), name);
  if (!app) return { err: new Error('not found'), stdout: '', stderr: `Unable to find application named "${name}"` };
  let r = await launch('gio', ['launch', app.file]);
  if (r.err?.code === 'ENOENT') r = await launch('gtk-launch', [app.id]);
  if (r.err?.code === 'ENOENT') return { err: r.err, stdout: '', stderr: `Found ${app.entry.Name}, but this computer has neither gio nor gtk-launch to start it.` };
  return { ...r, app };
}
const actionsOff = `File edits and commands are switched off. Tell the user to turn on "Allow File Edits & Commands" in the ${process.platform === 'darwin' ? 'menu bar' : 'system tray'} menu if they want this.`;

// "hands": the bundled helper that captures one window or area and reads/controls other apps (hands/main.swift on
// macOS, hands-win on Windows; same commands and JSON). A .mjs one (a test's fake) runs on this Node.
const HANDS = process.env.ROAMIES_HANDS || '';
const runHands = (args, opts) => (HANDS.endsWith('.mjs') ? run(process.execPath, [HANDS, ...args], opts) : run(HANDS, args, opts));
const STALE_ID = 'The page changed since read_window, so that id is out of date. Call read_window again and use the new ids.';
// An app named in read_window or act_in_app that isn't open: open it (with the open tool's safety check) and wait
// up to 6 s for its window. True when it's there. Only plain app names, never paths or links.
async function launchApp(name, hands) {
  const n = String(name).trim();
  if (!['darwin', 'win32'].includes(process.platform) || !n || /[/\\:]/.test(n) || checkOpen(n, HOME).level === BLOCK) return false;
  // Opened only to act in it: in background mode (the default) it opens behind the user's app, not in front (macOS).
  const r = process.platform === 'win32' ? await winOpen(n) : await run('open', [...(process.env.ROAMIES_BG !== '0' ? ['-g'] : []), '-a', n]);
  if (r.err && /Unable to find application/i.test(r.stderr)) throw new Error(`There's no app called "${n}" on ${THIS_COMPUTER} (not installed, or it has another name). Don't look for it another way; say so and carry on with the rest.`);
  if (r.err) return false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await hands('locate', `app:${n}`).then((r) => r?.ok !== false && r?.window, () => false)) { await new Promise((r) => setTimeout(r, 300)); return true; }
  }
  return false;
}
// read_window and act_in_app output: visible controls first, then up to 15 scrolled out of view.
function controlList(controls, texts = []) {
  const vis = controls.filter((c) => !c.offscreen), off = controls.filter((c) => c.offscreen).slice(0, 15);
  const line = (c) => `${c.id} ${c.role}${c.label ? ` "${c.label}"` : ''}${c.value ? ` = "${c.value}"` : ''}${c.focused ? ' (focused)' : ''}`;
  const labels = new Set(controls.map((c) => c.label));
  const words = texts.filter((t) => !labels.has(t));
  return vis.map(line).join('\n')
    + (off.length ? `\nFurther down (draw or click_text with their text scrolls to them): ${off.map((c) => `${c.id} "${c.label || c.role}"`).join(', ')}` : '')
    + (words.length ? `\nText on screen: ${words.join(' | ')}` : '');
}
// A safety verdict: blocked throws with the reason, otherwise returns the checked absolute path.
const allowed = (v) => { if (v.level === BLOCK) throw new Error(`Blocked for safety: ${v.reason}`); return v.path; };
// Shrinks an image to at most 1568 px on its long side (Claude's own cap), never enlarging small ones. Returns [w, h].
export async function fitImage(file) {
  const size = async () => parseSipsSize((await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file])).stdout);
  const s = await size();
  if (!s || Math.max(...s) <= 1568) return s;
  await run('sips', ['-Z', '1568', file]);
  return size();
}
export const imageBlock = async (file, mediaType) => {
  const data = (await fs.readFile(file)).toString('base64');
  fs.unlink(file).catch(() => {});
  return { type: 'image', mediaType, data };
};

// deps: what the tools need from the app (settings, overlay, input bubble, menu). State lives per instance.
const BROWSERS = /^(browser|safari|google chrome|chrome|arc|firefox|microsoft edge|edge|brave browser|brave|opera|vivaldi)$/i;
const ADDRESS = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i;
/** The web address an act_in_app call only types into a browser's address bar (then Return, then maybe a wait), or null. */
export function typedAddress(target, steps) {
  if (!BROWSERS.test(String(target).trim())) return null;
  const i = steps.findIndex((s) => s.do === 'type');
  if (i < 0 || !ADDRESS.test(String(steps[i].text ?? '').trim()) || /\.app$/i.test(steps[i].text)) return null;
  const bar = /address|search field|smart search|url|location|new tab|omnibox/i;
  const before = steps.slice(0, i).every((s) => (s.do === 'key' && /^(cmd|command)\+(l|t)$/i.test(String(s.key).replace(/\s/g, ''))) || (s.do === 'click_text' && bar.test(s.text ?? '')));
  const ret = steps[i + 1]?.do === 'key' && /^(return|enter)$/i.test(String(steps[i + 1].key).trim());
  const after = steps.slice(i + 2).every((s) => s.do === 'wait');
  return before && ret && after ? String(steps[i].text).trim() : null;
}

// One line for the live state: which app, window and page is in front right now. Query strings and
// fragments are dropped (they can hold tokens), and long titles are cut.
export function frontLine(f, who = 'The user') {
  if (!f?.app) return '';
  const cut = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  let url = '';
  try { if (f.url) { const u = new URL(f.url); url = /^https?:$/.test(u.protocol) ? cut(u.host + u.pathname.replace(/\/$/, ''), 120) : ''; } } catch { /* not a URL */ }
  const title = f.title ? ` — "${cut(String(f.title).replace(/\s+/g, ' ').trim(), 120)}"` : '';
  return `- Right now ${who} is in ${f.app}${title}${url ? ` (${url})` : ''}. This was just checked and overrides any app or page from earlier messages; they can still ask about something elsewhere.`;
}

// Git settings a downloaded repo's own config could use to run a program from a "read-only" git status or log:
// switched off for every command the agent runs (git reads GIT_CONFIG_COUNT/KEY/VALUE over every config file).
const GIT_SAFE = {
  GIT_CONFIG_COUNT: '4',
  GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'core.pager', GIT_CONFIG_VALUE_1: 'cat',
  GIT_CONFIG_KEY_2: 'diff.external', GIT_CONFIG_VALUE_2: '',
  GIT_CONFIG_KEY_3: 'core.hooksPath', GIT_CONFIG_VALUE_3: '/dev/null',
};

/** Puts text on the clipboard; true when it got there. It goes in through stdin (Linux: through the app itself,
 *  askShell), so nothing in it is ever parsed as a command. */
export const copyText = (text, askShell) => (LINUX ? askShell({ type: 'clipboard', text: String(text) }).then((r) => !!r?.ok) : new Promise((res) => {
  const [cmd, args] = process.platform === 'darwin' ? ['pbcopy', []] : process.platform === 'win32' ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command', '$input | Set-Clipboard']] : ['xclip', ['-selection', 'clipboard']];
  const p = execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err) => res(!err));
  p.stdin?.end(String(text));
}));

// askShell: Linux asks the app itself for screenshots and copying ({type:'screenshot'|'clipboard', …} → its answer).
/** GG Coder's side search for the sign-in in use, so a search's result pages never fill the main model's context: Claude
 *  Code's WebSearch on a Claude sign-in ({ cc, cwd }), Anthropic's server search on an Anthropic key ({ apiKey, baseUrl }),
 *  else null, and web_search uses its keyless engines (DuckDuckGo, Brave, Bing, Google). */
export function sideSearchFor(route) {
  if (route?.cc?.executable) return (req) => runSideWebSearchViaClaudeCode(req, { executable: route.cc.executable, env: route.cc.env ?? {}, cwd: route.cwd ?? HOME });
  if (route?.apiKey) return (req) => runSideWebSearch(req, { apiKey: route.apiKey, ...(route.baseUrl ? { baseUrl: route.baseUrl } : {}) });
  return null;
}
// Every request and redirect hop of web_fetch goes through safety.mjs, by name and by the addresses it resolves to.
export const guardFetch = async (url) => { const v = await checkFetch(url); return v.level === BLOCK ? `Blocked for safety: ${v.reason}` : null; };

export function createTools({ allowActions, ui, ask, openUrl, onCommitments, dashboard = null, firedReminders = () => [], focus = null, showList, fmtWhen, commitmentsText, userName, onPlan = () => {}, speak = () => false, onHandoff = () => {}, watchClicks = () => {}, onInkGone = () => {}, askShell = async () => ({ ok: false, error: 'Roamies isn\'t running.' }), workdir = HOME, own = null, sideSearch = async () => null }) {
  // Relative paths (and run_command) start in workdir: the home folder for the chat, its own folder for an agent.
  const at = (p) => { const s = String(p ?? ''); return /^~(?=$|\/|\\)/.test(s) || path.isAbsolute(s) || /^[a-z]:[\\/]/i.test(s) ? s : path.join(workdir, s); };
  const where = workdir === HOME ? "the user's home folder" : `its working folder (${workdir})`;
  let axNudged = 0;
  let lastShot = null; // how the latest screenshot's pixels map to screen points (see pointing.mjs)
  let lastRead = null; // { win, controls } from the latest read_window, to catch ids that went stale
  // Bumped for every new request: what was seen before it may be another page, tab or app by now.
  let turn = 0;
  // Risky clicks the user allowed this request, as "app|kind": one Allow covers that kind in that app until the next request.
  let allowedClicks = { turn: -1, keys: new Set() };
  async function shotPoint(x, y) {
    const problem = shotProblem(lastShot, turn);
    if (problem) throw new Error(problem);
    if (lastShot.win != null) {
      const now = await hands('locate', `window:${lastShot.win}`).catch(() => null);
      if (!sameBounds(now?.window?.bounds, lastShot.bounds)) throw new Error('That window moved or closed since the screenshot. Take a new screenshot first.');
    }
    return toScreen(lastShot, x, y);
  }
  // The control that read_window listed at this id, wherever it is now.
  async function liveControls(spec) {
    // Only the controls: the page's text isn't needed to re-find ids.
    const fresh = await hands('ui', spec, 'controls');
    const problem = readProblem(lastRead, fresh.window.id, turn);
    if (problem) throw new Error(problem);
    return (id) => {
      const c = rematch(lastRead.controls[id - 1], fresh.controls, id);
      if (!c) throw new Error(STALE_ID);
      return c;
    };
  }
  async function hands(...args) {
    if (!HANDS) throw new Error('This needs the Roamies app.');
    // Acting in an app may take the real cursor: meanwhile clicks go through the overlay, even where the Sidekick or
    // its bubble sits on the spot being clicked.
    const acting = args[0] === 'act';
    if (acting) ui({ kind: 'hands', on: true });
    // While it acts, the Sidekick hops to where each step lands. Only the spot is passed on, never what is typed.
    const onLine = acting ? (line) => {
      if (line[0] !== '@') return;
      let ev;
      try { ev = JSON.parse(line.slice(1)); } catch { return; }
      if (ev.ev === 'borrow') ui({ kind: 'hands', borrow: true });
      else if (ev.ev === 'step' && Array.isArray(ev.bounds) && ev.bounds.length === 4 && ev.bounds.every(Number.isFinite)) ui({ kind: 'hands', step: { bounds: ev.bounds } });
    } : undefined;
    let r;
    try { r = await runHands(args, { timeout: 120_000, onLine }); } finally { if (acting) ui({ kind: 'hands', on: false }); }
    let res;
    try { res = JSON.parse(r.stdout.trim().split('\n').pop() || '{}'); } catch { throw new Error(`hands helper failed: ${r.stderr.trim().slice(0, 200) || 'no output'}`); }
    if (res.ok === false && !res.cancelled) {
      if (process.platform === 'darwin' && /Accessibility/i.test(res.error ?? '')) {
        // Open the exact Settings pane (once a minute at most) so the fix is one click away.
        if (Date.now() - axNudged > 60_000) { axNudged = Date.now(); openUrl('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'); }
        throw new Error('Accessibility is off for Roamies, so I can\'t read or control other apps yet. I just opened System Settings → Privacy & Security → Accessibility: switch on Roamies there, then ask again. Tell the user exactly that, briefly.');
      }
      throw new Error(res.error || 'That did not work.');
    }
    return res;
  }
  async function readWindow(target = 'front') {
    const t = String(target || 'front');
    const read = () => Promise.all([hands('ui', t === 'front' ? 'front' : `app:${t}`), hands('windows').catch(() => null)]);
    const [res, all] = await read().catch(async (err) => {
      if (t === 'front' || !/No matching window/.test(String(err?.message ?? err)) || !(await launchApp(t, hands))) throw err;
      return read();
    });
    lastRead = { win: res.window.id, app: res.window.app, controls: res.controls, turn };
    const others = (all?.windows ?? []).filter((w) => w.app === res.window.app && w.id !== res.window.id).length;
    const head = `${res.window.app}${res.window.title ? ` — ${res.window.title}` : ''}${others ? ` (front window; ${res.window.app} has ${others} more, which draw with text also searches)` : ''}`;
    if (!res.controls.length) return `${head}\n${res.note}`;
    return `${head}\n${controlList(res.controls, res.texts)}${res.elsewhere?.length ? `\nElsewhere on the page (scrolled out of view): ${res.elsewhere.join(' | ')}` : ''}`;
  }
  // A yes/no in an input bubble. Stop (or the turn ending) counts as no.
  async function confirm(question, ctx) {
    const answer = await ask({ placeholder: question, choices: ['Allow', "Don't allow"] }, ctx?.signal);
    return isYes(answer);
  }

  // The helper's screenshot: one window or app (even behind others), or the screen; shrunk by the helper itself.
  async function handsShot(file, t) {
    const spec = t === 'screen' || t === 'front' || t.startsWith('window:') ? t : `app:${t}`;
    // Shot straight away, with nothing played on screen (the Roamie only shows a "looking" tag).
    // 1568 px is Claude's own cap; a bigger image gets shrunk again and its coordinates drift. The helper shrinks it
    // itself and says the final size; an older helper doesn't, so sips does it here.
    const res = await hands('capture', file, spec, '1568');
    const size = Array.isArray(res.pixels) && res.pixels.length === 2 ? res.pixels : await fitImage(file);
    const bounds = res.window?.bounds ?? res.bounds;
    // area: what the picture covers when it's more than the window (its child windows too); bounds still tell
    // whether the window moved.
    const area = res.area ?? bounds;
    // A picture that isn't the shape of the area it's said to show would point in the wrong place: refuse to point.
    lastShot = !size || !bounds ? null : shotFits(area, ...size) ? { ...shotMap(area, ...size), bounds, win: res.window?.id ?? null, turn } : { unmapped: true, turn };
    const what = res.window ? `the ${res.window.app} window${res.window.title ? ` "${res.window.title}"` : ''}` : 'the whole screen';
    const dims = lastShot?.unmapped ? ` (it doesn't line up with the window on screen, so don't point or click by its pixels; use visible words)` : size ? ` (${size[0]}×${size[1]} px; for draw or click_at give x, y in this image's pixels)` : '';
    return { content: [{ type: 'text', text: `Screenshot of ${what}${dims}.` }, await imageBlock(file, 'image/jpeg')] };
  }
  // target: "screen", "front" (the window you're working in), an app name ("browser", "Safari", "Figma"),
  // or "window:<id>" from list_windows. Apps that are open but hidden or minimised are brought forward.
  async function screenshot({ target = 'screen' } = {}, ctx) {
    const file = path.join(os.tmpdir(), `sidekick-${Date.now()}.jpg`);
    // Windows without the helper (or when it fails on the whole screen): PowerShell's screenshot below.
    const viaHands = process.platform === 'darwin' || (process.platform === 'win32' && HANDS);
    const t = String(target || 'screen').trim();
    const shot = viaHands ? await handsShot(file, t).catch((e) => { if (process.platform === 'win32' && t === 'screen') return null; throw e; }) : null;
    if (shot) return shot;
    if (process.platform === 'win32') {
      // DPI-aware (or scaled displays capture only the top-left part), shrunk to Claude's 1568 px cap, and the
      // file path passed by environment variable so odd characters in it can't break the script.
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
        "Add-Type -Name D -Namespace RoamiesWin -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();'",
        '[RoamiesWin.D]::SetProcessDPIAware() | Out-Null',
        '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
        '$i=New-Object System.Drawing.Bitmap $b.Width,$b.Height',
        '[System.Drawing.Graphics]::FromImage($i).CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size)',
        '$s=[Math]::Min(1.0,1568.0/[Math]::Max($b.Width,$b.Height))',
        '$o=New-Object System.Drawing.Bitmap ([int]($b.Width*$s)),([int]($b.Height*$s))',
        "$g=[System.Drawing.Graphics]::FromImage($o);$g.InterpolationMode='HighQualityBicubic';$g.DrawImage($i,0,0,$o.Width,$o.Height)",
        '$o.Save($env:ROAMIES_SHOT,[System.Drawing.Imaging.ImageFormat]::Jpeg)',
        // Physical size, the image size and the screen's scale, so draw can turn its pixels into overlay points.
        "Write-Output ('{0} {1} {2} {3} {4}' -f $b.Width,$b.Height,$o.Width,$o.Height,([System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero).DpiX/96))",
      ].join(';');
      // -EncodedCommand (UTF-16LE base64): no quoting for Windows' command line to mangle.
      const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { env: { ...process.env, ROAMIES_SHOT: file } });
      if (r.err) throw new Error('Screen capture failed.');
      const [pw, ph, iw, ih, sc] = r.stdout.trim().split(/\s+/).map(Number);
      lastShot = pw && iw && sc ? { ...shotMap([0, 0, pw / sc, ph / sc], iw, ih), bounds: [0, 0, pw / sc, ph / sc], win: null, turn } : null;
      const data = (await fs.readFile(file)).toString('base64');
      fs.unlink(file).catch(() => {});
      return { content: [{ type: 'text', text: `Screenshot of the main display${iw ? ` (${iw}×${ih} px; for draw give x, y in this image's pixels)` : ''}.` }, { type: 'image', mediaType: 'image/jpeg', data }] };
    }
    if (!LINUX) throw new Error(`Screenshots aren't available on ${process.platform}.`);
    // Linux: the app takes it (the X screen, or the desktop's screenshot portal on Wayland), shrunk to Claude's cap,
    // and says what part of the desktop it covers, so draw can turn its pixels into places on screen.
    const res = await askShell({ type: 'screenshot', file });
    if (!res?.ok) { fs.unlink(file).catch(() => {}); throw new Error(res?.error || 'Screen capture failed.'); }
    const [iw, ih] = Array.isArray(res.pixels) ? res.pixels : [];
    const b = Array.isArray(res.bounds) && res.bounds.length === 4 ? res.bounds : null;
    lastShot = iw && ih && b ? { ...shotMap(b, iw, ih), bounds: b, win: null, turn } : null;
    const whole = t === 'screen' ? '' : ' (one app\'s window can\'t be captured alone on Linux, so this is the whole desktop)';
    return { content: [{ type: 'text', text: `Screenshot of the whole desktop${whole}${iw ? ` (${iw}×${ih} px; for draw give x, y in this image's pixels)` : ''}.` }, await imageBlock(file, 'image/jpeg')] };
  }

  // ---------- drawing on screen (the draw tool) ----------
  // The overlay plays a drawing a beat at a time; each beat's places are looked up just before it's sent, so a
  // walkthrough's next step is found on the screen as it is after the click. A drawing stays until it's cleared or the
  // screen changes: a new drawing in a later request replaces it (unless it edits it), the front window switching,
  // moving or closing clears it, so does a click there that changes what it shows (a link, button, tab, menu item, a
  // double-click that opens something: the user's or the agent's own), the page or document in it changing (another
  // address in a browser, another title elsewhere: keys, swipes and script-driven clicks too), and Esc or Clear all on
  // screen. All of it goes, cards too: they were about that screen. Screen marks also go at the end of a request that
  // drew nothing.
  // Parts (p1 …) stay editable meanwhile.
  const parts = createParts();
  // Pictures looked at with see_photo: a photo's labels are only drawn on one of these.
  const photos = createPhotos();
  const buttons = new Map(); // part id → the button's action, for when it's clicked
  const quizzes = new Map(); // part id → the quiz drawn there, to score what was clicked
  // Parts of drawings that go by themselves (the tour, the setup showcase): about no window, so switching windows keeps them.
  const loose = new Set();
  // Cards the user pinned (ink.js): the overlay keeps them through clears and window changes, so they're remembered here too.
  const pinned = new Set();
  const keepPinned = (id) => pinned.has(id);
  const forgetInk = () => { parts.clear(keepPinned); for (const m of [buttons, quizzes]) for (const id of [...m.keys()]) if (!pinned.has(id)) m.delete(id); for (const id of [...loose]) if (!pinned.has(id)) loose.delete(id); };
  const windowBound = () => parts.ids.some((p) => !loose.has(p));
  const ink = { waits: new Map(), turn: -1, active: 0, front: '', win: null, page: '', watch: null, checks: [] };
  const inkWait = (key, ms, signal) => new Promise((resolve) => {
    const done = (v) => { clearTimeout(t); signal?.removeEventListener('abort', stop); ink.waits.delete(key); resolve(v); };
    const t = setTimeout(() => done('timeout'), ms), stop = () => done('stopped');
    // Already cut off before getting here: the abort event has fired, so it would wait the whole time.
    if (signal?.aborted) return stop();
    signal?.addEventListener('abort', stop, { once: true });
    ink.waits.set(key, done);
  });
  const clearScreenInk = (stop = false) => { parts.clearScreen(); for (const id of buttons.keys()) if (!parts.has(id)) buttons.delete(id); ui({ kind: 'agent', e: { type: 'ink_clear', screen: true, stop } }); };
  const clearAllInk = () => { forgetInk(); ui({ kind: 'agent', e: { type: 'ink_clear' } }); };
  // The window a drawing belongs to: the front window's id and place. Its title isn't part of it (a page updating
  // its title, a document being edited, isn't the screen changing).
  // Its rect and app too, so a click can be told to be in it.
  const frontWin = async () => {
    if (!HANDS) return null;
    const r = await runHands(['locate', 'front'], { timeout: 900 });
    try { const w = JSON.parse(r.stdout.trim().split('\n').pop() || '{}').window; return w ? { key: `${w.id}|${(w.bounds ?? []).map((v) => Math.round(v / 4)).join(',')}`, rect: w.bounds ?? null, app: w.app ?? '' } : null; } catch { return null; }
  };
  const frontKey = async () => (await frontWin())?.key ?? '';
  // What the front window shows: a browser's address (without the #part), else its title, less what changes on its
  // own ("(3) Inbox", "— Edited"). '' when it can't be read, which never counts as a change.
  const pageOf = ({ url, title } = {}) => (url ? String(url).replace(/#.*$/, '') : String(title ?? '').replace(/^\(\d+\)\s*/, '').replace(/\s+[—–-]\s+Edited$/i, '').trim());
  const frontPage = async () => {
    if (!HANDS) return '';
    const r = await runHands(['front'], { timeout: 900 });
    try { return pageOf(JSON.parse(r.stdout.trim().split('\n').pop() || '{}')); } catch { return ''; }
  };
  // The screen under the drawing changed: all of it fades (cards too), and the model is told nothing is there.
  function screenChanged(why) {
    forgetInk(); ink.front = ''; ink.win = null; ink.page = ''; watchClicks(false);
    for (const t of ink.checks) clearTimeout(t);
    ink.checks = [];
    ui({ kind: 'agent', e: { type: 'ink_stale' } });
    onInkGone(why);
  }
  // Has the page or document in its window changed since it was drawn?
  async function pageCheck() {
    if (!windowBound() || !ink.page || ink.active) return;
    const now = await frontPage();
    if (now && ink.page && now !== ink.page && windowBound()) screenChanged('page');
  }
  // When another window comes to the front, or that window moves or closes, the drawing no longer sits on what it was about.
  function watchStale() {
    if (!HANDS || ink.watch) return;
    ink.watch = setInterval(async () => {
      if (ink.active) return;
      if (!windowBound()) { clearInterval(ink.watch); ink.watch = null; watchClicks(false); return; }
      const [k, page] = await Promise.all([frontKey(), frontPage()]);
      if (!windowBound()) return;
      // Not read when it was drawn (the helper was slow): what's there now is what it's about.
      if (!ink.front && k) ink.front = k;
      if (!ink.page && page) ink.page = page;
      if (k && k !== ink.front) screenChanged('window');
      else if (page && page !== ink.page) screenChanged('page');
    }, 1500);
    ink.watch.unref?.();
  }
  // Steps that change what a window shows: the agent doing one is the screen changing under a drawing.
  const CHANGING = new Set(['click', 'click_text', 'press_button', 'key', 'click_at', 'choose']);
  const agentChangesScreen = () => { if (windowBound() && !ink.active) screenChanged('agent'); };
  const toClipboard = (text) => copyText(text, askShell);
  // How each kind of place is found. retry: just after a click, when a menu or dialog may still be opening.
  function lookups(spec, retry) {
    let live = null, shotOk = null, controls = null, fitQueue = null, wins = null;
    // The same words marked twice in a segment (a ring and a connect to it): one helper round trip.
    const seen = new Map();
    return {
      text(find) {
        const k = String(find).trim().toLowerCase();
        if (!seen.has(k)) seen.set(k, this.findText(find));
        return seen.get(k);
      },
      // Text read off the screen: words inside paragraphs, text in images and canvases, single characters (case
      // matters). Exact boxes; [] when it isn't there (or without the helper).
      async textAll(find) {
        if (!HANDS) return [];
        // The window the latest screenshot showed, when there's one from this request: the front app can change
        // between looking and drawing.
        const where = lastShot?.turn === turn && lastShot.win != null ? `window:${lastShot.win}` : spec;
        return (await hands('ocr-find', where, String(find), 'all').catch(() => null))?.matches ?? [];
      },
      async findText(find) {
        if (!HANDS) throw new Error('Finding words on screen needs the Roamies app; take a screenshot and give x, y instead.');
        // Text read off the screen: one match, or where each of several is, so the right one can be picked with within.
        const readOne = async () => {
          const all = await this.textAll(find);
          if (all.length > 1) throw new Error(`"${find}" appears ${all.length} times on screen (${all.slice(0, 4).map((o) => `in "${String(o.text).slice(0, 40)}"`).join(', ')}). Add within: {x, y, w, h} (screenshot pixels round the one you mean), or every: true for all of them.`);
          return all[0] ?? null;
        };
        // One character: read the screen first (labels rarely hold one letter, and the case matters).
        if (String(find).trim().length === 1) { const o = await readOne(); if (o) return o; }
        for (let k = 0; ; k++) {
          // "front" searches every window of the front app; text is often in a window behind the frontmost one.
          const res = await hands('find-text', spec, find, 'scroll').catch((e) => (k < (retry ? 4 : 0) ? { matches: [] } : Promise.reject(e)));
          const m = pickTextMatch(res.matches, find);
          if (m) return m;
          // Not a whole label: the exact words inside longer text, or in an image or canvas, read off the screen.
          const o = await readOne();
          if (o) return o;
          if (k >= (retry ? 4 : 0)) {
            const near = (res.matches ?? []).slice(0, 3).map((x) => `"${x.text.replace(/\s+/g, ' ').slice(0, 50)}"`).join(', ');
            throw new Error(`No button, label or heading reads "${find}"${near ? ` (it only appears inside longer text: ${near})` : ''}. Use the exact words shown on screen; if you don't know them, take a screenshot first.`);
          }
          await new Promise((r) => setTimeout(r, 400));
        }
      },
      async id(n) {
        if (!HANDS) throw new Error('read_window ids need the Roamies app; give x, y from a screenshot instead.');
        live ??= await liveControls(spec);
        const c = live(n);
        if (c.offscreen) throw new Error(`"${c.label || c.role}" is further down the page. Use its text instead; that scrolls to it.`);
        return c;
      },
      // A box guessed from screenshot pixels, fitted to what's really drawn there. The guesses of one beat come
      // together (its marks are found at once), so they go to the helper in one call.
      refine(rect) {
        if (!HANDS || spec === 'screen' && !lastShot) return Promise.resolve(null);
        return new Promise((resolve) => {
          fitQueue ??= { list: [] };
          fitQueue.list.push({ rect, resolve });
          fitQueue.timer ??= setTimeout(async () => {
            const q = fitQueue; fitQueue = null;
            // The window the screenshot was of: its own pixels, even where another window covers it now.
            const res = await hands('refine', JSON.stringify(q.list.map((x) => x.rect)), ...(lastShot?.win != null ? [`window:${lastShot.win}`] : [])).catch(() => null);
            q.list.forEach((x, i) => { const b = res?.boxes?.[i]; x.resolve(Array.isArray(b) && b.length === 4 ? b : null); });
          }, 0);
        });
      },
      // The controls on screen now (once per segment), for loops drawn from screenshot pixels to snap to.
      async snap(rect) {
        if (!HANDS || spec === 'screen') return null;
        controls ??= hands('ui', spec, 'controls').then((r) => (r.controls ?? []).filter((c) => !c.offscreen && c.bounds).map((c) => c.bounds), () => []);
        return snapRect(rect, await controls);
      },
      // The open windows' boxes, front to back (once per segment), for frames drawn round a whole window.
      windows() {
        if (!HANDS) return Promise.resolve([]);
        wins ??= hands('windows').then((r) => (r.windows ?? []).map((w) => w.bounds).filter(Array.isArray), () => []);
        return wins;
      },
      // The screenshot is checked once per segment (not for every point of a traced outline).
      async pixel(x, y) {
        if (!shotOk) {
          const problem = shotProblem(lastShot, turn);
          if (problem) throw new Error(problem);
          if (lastShot.win != null) {
            const now = await hands('locate', `window:${lastShot.win}`).catch(() => null);
            if (!sameBounds(now?.window?.bounds, lastShot.bounds)) throw new Error('That window moved or closed since the screenshot. Take a new screenshot first.');
          }
          shotOk = true;
        }
        const [w, h] = lastShot.size ?? [];
        if (w && h && (x < -2 || y < -2 || x > w + 2 || y > h + 2)) throw new Error(`${Math.round(x)}, ${Math.round(y)} is outside the screenshot (${w}×${h} px).`);
        return toScreen(lastShot, x, y);
      },
    };
  }
  // Fills in what cards fetch (photos, favicons) and does the actions, all checked by safety.mjs first.
  async function prepare(beats, t, notes) {
    const marks = beats.flatMap((b) => b.marks);
    // Safety first, before any fetching or acting.
    for (const m of marks) {
      if (m.kind === 'button' || m.action || m.kind === 'open' || m.kind === 'copy' || m.kind === 'type' || m.kind === 'handoff') {
        // Anything with a button (a ticket too) is checked as a button.
        const v = checkDrawAction({ kind: m.action ? 'button' : m.kind, url: m.url, text: m.text, action: m.action }, { allowActions: allowActions() });
        if (v.level === BLOCK) throw new Error(`Blocked for safety: ${v.reason}`);
      }
    }
    // Pictures and favicons are fetched all at once (each is a network round trip).
    await Promise.all(marks.map(async (m) => {
      if (m.kind === 'photo') {
        try { Object.assign(m, await photos.get(m)); } catch (e) { m.missing = true; notes.push(`No photo for ${m.query ?? 'that link'} (${e.message}); drew its frame and caption only.`); }
      } else if (m.kind === 'sources' || m.sources?.length) {
        m.sources = await Promise.all(m.sources.map(async (x) => ({ ...x, icon: checkDrawAction({ kind: 'favicon', url: x.url }).level === BLOCK ? null : await faviconFor(x.url).catch(() => null) })));
      }
    }));
    for (const b of beats) for (const m of b.marks) {
      if (m.kind === 'copy') { if (!(await toClipboard(m.text))) notes.push("Couldn't copy to the clipboard."); }
      else if (m.kind === 'open') { await tools.find((x) => x.name === 'open').execute({ target: m.url }); }
      else if (m.kind === 'handoff') onHandoff(m.task || m.text || m.label || 'a task');
      else if (m.kind === 'type') {
        if (!HANDS) throw new Error('Typing into apps needs the Roamies app.');
        const src = m.at.src, app = t === 'front' || t === 'screen' ? {} : { app: t };
        const steps = src.text != null ? [{ do: 'fill', field: src.text, text: m.text }]
          : src.id != null ? [{ do: 'click', id: m.at.live }, { do: 'type', text: m.text }]
            : [{ do: 'click_at', x: m.at.rect[0] + m.at.rect[2] / 2, y: m.at.rect[1] + m.at.rect[3] / 2, global: true }, { do: 'type', text: m.text }];
        await hands('act', JSON.stringify({ steps, ...app }));
        if (lastShot) lastShot.used = true;
      }
    }
  }
  // opts.fade: seconds after it finishes that the drawing goes by itself (the welcome tour).
  async function draw(args, ctx, opts = {}) {
    const problems = checkDraw(args);
    if (problems.length) throw new Error(problems.join('\n'));
    // Labels on a picture the model hasn't seen would be guesses: it looks first (see_photo), then draws.
    const unseen = photos.unseen(args.beats);
    if (unseen) throw new Error(unseen);
    const t = String(args.target || 'front'), spec = t === 'front' ? 'front' : t === 'screen' ? 'screen' : `app:${t}`;
    const id = ctx.toolCallId, edits = args.edit ?? [], notes = [], said = [];
    // Clicks and hovers in other apps can't be seen here (Wayland): the beats play one after another instead.
    const beats = (args.beats ?? []).map((b) => (POINTER_OK || !b.wait ? b : { ...b, wait: undefined }));
    if (beats.some((b, i) => b !== (args.beats ?? [])[i])) notes.push("This desktop doesn't let Roamies see clicks in other apps, so the beats played one after another instead of waiting for clicks.");
    for (const e of edits) if (e.do !== 'clear' && !parts.has(e.part)) throw new Error(`There's no ${e.part} on screen now${parts.ids.length ? ` (there is: ${parts.describe()})` : ' (nothing is drawn)'}. Draw it again instead.`);
    // A new drawing in a later request replaces the old one (cards too), unless it's editing what's there.
    if (ink.turn !== turn && !edits.length && parts.ids.length) clearAllInk();
    ink.turn = turn;
    for (const e of edits) if (e.do === 'erase') parts.remove(e.part); else if (e.do === 'clear') { parts.clear(); pinned.clear(); }
    // One segment per beat: each is sent as soon as its places are found, so the first marks draw while the rest
    // are still being looked up (each lookup is a helper round trip). after: it comes after a click or hover.
    const segs = beats.map((b, i) => ({ from: i, to: i + 1, after: i > 0 && !!beats[i - 1].wait }));
    if (!segs.length) segs.push({ from: 0, to: 0 });
    const drawn = [], shut = [];
    // Cut off (they spoke over it): the overlay stops too, or it keeps the caption up waiting for a click.
    const stopped = () => { if (ctx?.signal?.aborted) clearAllInk(); return 'Stopped.'; };
    // Where there's room for cards: the screen minus the front window; and what's on it, so names avoid covering words.
    const hasCards = beats.some((b) => b.marks.some((m) => CARDS.includes(m.kind)));
    const win = hasCards && HANDS ? (await hands('locate', 'front').catch(() => null))?.window?.bounds ?? null : null;
    const busy = lastRead?.turn === turn ? lastRead.controls.filter((c) => !c.offscreen && c.bounds).slice(0, 300).map((c) => c.bounds) : [];
    ink.active++;
    // Lookups are shared until a click or hover (then the screen may have changed, and words are retried a moment).
    let look = null;
    try {
      for (const [k, sg] of segs.entries()) {
        if (ctx?.signal?.aborted) return stopped();
        let seg;
        try {
          if (!look || sg.after) look = lookups(spec, sg.after);
          seg = await resolveTargets(beats.slice(sg.from, sg.to), look);
          // Typing needs the original place (its words or id) to act on; resolveTargets keeps it.
          seg.forEach((b, j) => b.marks.forEach((m, n) => { if (m.at) m.at.src = beats[sg.from + j].marks[m.from ?? n]?.at; }));
          await prepare(seg, t, notes);
        } catch (e) {
          if (!k) throw e;
          notes.push(`Stopped before beat ${sg.from + 1}: ${e.message}`);
          break;
        }
        // Cancelled while this step's places were looked up: it never shows.
        if (ctx?.signal?.aborted) return stopped();
        const ids = parts.assign(seg);
        drawn.push(...ids.map((p) => [p, parts.get(p)]));
        if (opts.fade) for (const p of ids) loose.add(p);
        // Only a few cards stay up at once (the overlay closes the oldest as each new one is drawn), so the oldest are
        // forgotten here too. Eight cards at once covered the screen, and the last one landed on top of the first.
        // A deep explanation shows one big card at a time.
        else for (const p of parts.trimCards(args.deep ? 1 : LIMITS.cardsShown, (q) => loose.has(q) || pinned.has(q))) { shut.push(p); buttons.delete(p); }
        for (const b of seg) for (const m of b.marks) if (m.action && m.part) buttons.set(m.part, m.action);
        for (const b of seg) for (const m of b.marks) if (m.kind === 'quiz' && m.part) quizzes.set(m.part, m);
        const out = seg.map((b, j) => ({ ...b, n: sg.from + j + 1, caption: plain(b.say), voiced: !!speak(b.say) }));
        said.push(...out.map((b) => b.caption));
        ui({ kind: 'agent', e: { type: 'draw', id, seg: k, beats: out, edits: k ? [] : edits, last: k === segs.length - 1, win, busy: k ? [] : busy, ...(opts.fade ? { fade: opts.fade } : {}), ...(args.deep ? { deep: true } : {}) } });
        // The first beat must show; later ones queue behind it on the overlay without holding this up.
        if (!k) {
          const started = await inkWait(`${id}:start:0`, 15_000, ctx?.signal);
          if (started === 'stopped') return stopped();
          if (started === 'timeout') throw new Error("The drawing didn't show (the overlay isn't responding).");
        }
        const w = out.at(-1)?.wait;
        if (!w) continue;
        const n = out.at(-1).n, r = await inkWait(`${id}:wait:${n}`, w === 'click' ? 120_000 : 60_000, ctx?.signal);
        if (r === 'stopped') return stopped();
        notes.push(`Beat ${n}: ${r === 'timeout' ? `no ${w} within ${w === 'click' ? 2 : 1} minute${w === 'click' ? 's' : ''}, so I stopped there` : `${userName} ${r}`}.`);
        if (r === 'timeout') break;
        // They clicked: the screen has changed under the old screenshot.
        if (lastShot) lastShot.used = true;
        await new Promise((res) => setTimeout(res, 350));
      }
    } finally { ink.active--; }
    if (windowBound()) { [ink.win, ink.page] = await Promise.all([frontWin(), frontPage()]); ink.front = ink.win?.key ?? ''; watchStale(); if (ink.win) watchClicks(true); }
    const list = describeParts(drawn);
    if (shut.length) notes.push(args.deep ? `A deep explanation shows one card at a time, so each closed as the next came (${shut.join(', ')}); only the last is up now.` : `Only ${LIMITS.cardsShown} cards stay up at once, so the oldest closed as newer ones were drawn (${shut.join(', ')}).`);
    // The lines were already said (and captioned) as it drew. Said here, right before the reply is written, so the
    // reply doesn't say them again: models restated each step after a walkthrough even with the rule in the prompt.
    const spoken = said.filter(Boolean);
    const heard = spoken.length ? `Already said out loud as it drew: ${spoken.map((s) => `"${s}"`).join(' ')} Don't repeat or rephrase any of that in your reply: add nothing, or one short sentence they haven't heard yet (a question, or what comes after).` : '';
    // A quiz is answered on screen: without this, models asked the user to report their score.
    if (beats.some((b) => b.marks.some((m) => m.kind === 'quiz'))) notes.push(`${userName} answers the quiz by clicking and sees right or wrong on the card; how they did reaches you with their next message, so don't ask for their answers or score.`);
    return [drawn.length ? `Drew ${list}.` : edits.length ? 'Edited the drawing.' : 'Done.', ...notes, edits.length || drawn.length ? `On screen now: ${parts.describe() || 'nothing'}.` : '', heard].filter(Boolean).join(' ');
  }
  // From the overlay: a segment started drawing, a wait ended, a card was closed, a button was clicked.
  const inkEvents = {
    started: (id, seg) => ink.waits.get(`${id}:start:${seg}`)?.('started'),
    waitDone: (id, beat, result) => ink.waits.get(`${id}:wait:${beat}`)?.(['clicked', 'hovered', 'skipped'].includes(result) ? result : 'skipped'),
    closed: (part) => { parts.remove(String(part)); buttons.delete(String(part)); loose.delete(String(part)); pinned.delete(String(part)); },
    pinned: (part, on) => { if (!on) pinned.delete(String(part)); else if (parts.has(String(part))) pinned.add(String(part)); },
    button: (part) => buttons.get(String(part)) ?? null,
    // A quiz was answered on screen (the option clicked for each question): how it went, in words for the model.
    quizDone: (part, picks) => quizNote(quizzes.get(String(part)), picks),
    // A request ended: if it drew nothing, the marks from before it are done with.
    endRequest: () => { if (ink.turn !== turn && parts.screenCount) clearScreenInk(); },
    // Stop. Cancelling a request that drew: all of its drawing goes, diagrams and cards too, and the overlay stops
    // playing it. Otherwise (only the voice was still going) the screen marks go and the cards stay.
    stop: (cancelled = false) => {
      for (const done of [...ink.waits.values()]) done('stopped');
      if (cancelled && ink.turn === turn && parts.ids.length) clearAllInk(); else clearScreenInk(true);
    },
    // The user sent the whole drawing away (Esc): nothing is on screen any more.
    cleared: () => { for (const done of [...ink.waits.values()]) done('stopped'); forgetInk(); },
    // The app takes its own drawing away (the setup showcase, when its step is left): everything goes.
    clear: () => { for (const done of [...ink.waits.values()]) done('stopped'); clearAllInk(); },
    describe: () => parts.describe(),
    // The user clicked ({ x, y, role, app, acts } from the voice helper). In the drawing's window, or one of its app's
    // menu items: on something that does something, the drawing goes now; anywhere else in it, it goes if the page then
    // changes (a script-driven link). Not while a walkthrough waits for exactly that click.
    userClick: (c) => {
      if (!windowBound() || !ink.win) return watchClicks(false);
      if (ink.active || ink.waits.size) return;
      const [x, y, w, h] = ink.win.rect ?? [], inside = w > 0 && c.x >= x && c.x <= x + w && c.y >= y && c.y <= y + h;
      const menu = /^AXMenu(Bar)?Item$/.test(String(c.role)) && !!c.app && c.app === ink.win.app;
      if (!inside && !menu) return;
      if (c.acts) return screenChanged('click');
      for (const ms of [700, 1600]) ink.checks.push(setTimeout(() => pageCheck().catch(() => {}), ms));
    },
    copy: (text) => toClipboard(text),
    // A drawing the app makes itself (the welcome tour): the same checks and overlay as one from the model.
    show: (beats, id, opts) => draw({ beats }, { toolCallId: id }, opts),
  };

  const tools = [
    {
      name: 'take_screenshot',
      description: "Look at the user's screen. target: 'front' = just the window they're working in (best default when they say 'this' or 'here'), an app name like 'browser', 'Safari', 'Figma' or 'Notes' (works even if it's hidden behind other windows), 'window:<id>' from list_windows, or 'screen' for everything.",
      parameters: z.object({ target: z.string().optional() }), execute: screenshot,
    },
    // The hands helper's tools: on macOS always (they explain what's missing), elsewhere when the helper is there.
    ...(process.platform === 'darwin' || HANDS ? [
      {
        name: 'list_windows', description: 'List the open app windows (app, title, id), front to back.',
        parameters: z.object({}),
        execute: async () => {
          const res = await hands('windows');
          return res.windows.map((w) => `window:${w.id}  ${w.app}${w.title ? ` — ${w.title}` : ''}${w.frontApp ? '  (frontmost app)' : ''}`).join('\n') || 'No windows open.';
        },
      },
      {
        name: 'read_window',
        description: "List the buttons, links, fields, checkboxes and other controls in an app's front window (id, role, label, value), plus the text on screen and the text scrolled out of view above and below it, so you can read a whole page without scrolling or a screenshot. Needed before act_in_app steps that use ids. To mark or click something by its visible words you don't need this: use draw or click_text with text. target: 'front', an app name, or 'browser'.",
        parameters: z.object({ target: z.string().optional() }),
        execute: async ({ target = 'front' }) => readWindow(target),
      },
      {
        name: 'act_in_app',
        description: "Do things in another app for the user: click, fill in forms, pick from dropdowns and date pickers, scroll, press keys. Steps run in order; put a whole task in one call. {do:'click_text', text} clicks a link, button or tab by its visible words (no read_window needed). {do:'fill', field, text} fills one text field: field is its label or placeholder as shown (or id), it replaces the text and checks it took; use one fill per field, never click a label and type. {do:'choose', field, option} picks an option in a dropdown, select menu, type-to-search box or picker: it opens it, types or scrolls through the list (hundreds of options, even lists that only load rows as they scroll) and picks; field is its label or id. Never scroll a dropdown list yourself. To go to a web address, use the open tool (instant), not the address bar. To search a site that has a search page (YouTube, Google, Amazon, Wikipedia…), open its search URL (e.g. https://www.youtube.com/results?search_query=…) instead of typing into its search box, unless the user asks you to use the box: then fill it (fill replaces any old search) and press return. Many identical buttons or fields (a Reply under every post): add near, words from that item (author or first words of the post), to click_text or fill and it uses the one belonging to that item, scrolling to it. {do:'scroll', direction:'down'|'up'|'left'|'right', amount, text or id} scrolls the page, or the list or panel under that text or control; needed only for content that loads as you scroll: {do:'scroll', direction:'down', to_end:true} keeps going until the feed stops loading more, in one step; then read_window lists everything that loaded. Things already on the page don't need scrolling: click_text, fill and draw find them anywhere on it and scroll there themselves. {do:'click', id}; {do:'key', key} e.g. 'return', 'tab', 'escape'; {do:'type', text} only when the cursor is already in a text field; {do:'click_at', x, y} pixels in your latest screenshot, last resort; {do:'wait', seconds}. Dates: fill the date field with the date as the page shows dates (e.g. 10/30/2026); if a calendar opens instead, choose the month and year, then click_text the day (its label often reads like 'Choose Friday, October 30th, 2026'). After the steps the result lists the window's controls and text as they are now (after scrolls too), with fresh ids and field values, so check them there instead of calling read_window again. Every item on a long page ('reply to each post'): scroll with to_end if it loads more, one read_window, then one act_in_app call doing every item with near. Never survey a page by scrolling and screenshotting, and never stop at the first screenful. Never submit payments, send messages or delete things unless the user clearly asked for exactly that; showing or pointing at a button is not a request to click it. Clicks on delete, pay, send or sign-out buttons always ask the user first, so when they asked you to click one, call act_in_app right away instead of asking in your reply; the app asks them.",
        parameters: z.object({
          target: z.string().optional(),
          steps: z.array(z.object({
            // read_window and take_screenshot aren't steps (the result already shows the window), but models put them
            // in anyway; they're dropped instead of failing the whole call.
            do: z.enum(['click_text', 'fill', 'choose', 'scroll', 'set', 'focus', 'click', 'type', 'key', 'click_at', 'wait', 'read_window', 'take_screenshot', 'screenshot']),
            id: z.number().int().optional(), field: z.string().optional(), text: z.string().optional(), option: z.string().optional(), near: z.string().optional(),
            key: z.string().optional(), direction: z.enum(['down', 'up', 'left', 'right']).optional(), amount: z.number().int().optional(), to_end: z.boolean().optional(),
            x: z.number().optional(), y: z.number().optional(), seconds: z.number().optional(),
          })).min(1).max(40),
        }),
        executionMode: 'sequential',
        execute: async ({ target = 'front', steps: given }, ctx) => {
          const asked = String(target || 'front');
          const steps = given.filter((s) => !['read_window', 'take_screenshot', 'screenshot'].includes(s.do));
          // Only reading steps (models sometimes send read_window here): read the window instead of failing the call.
          if (!steps.length) return readWindow(asked);
          if (!allowActions()) throw new Error(actionsOff);
          if (steps.some((s) => CHANGING.has(s.do))) agentChangesScreen();
          // "Type a web address into the browser's bar and press Return" is just opening a link: do that directly
          // (instant, and nothing can land in the wrong field) instead of clicking the bar and typing.
          const url = typedAddress(asked, steps);
          if (url) {
            const r = await tools.find((x) => x.name === 'open').execute({ target: url, app: /^(front|browser)$/i.test(asked) ? undefined : asked });
            return `${r} (went straight to the address instead of typing it)`;
          }
          // Stay on the exact window read for this request: an app can have several, and keystrokes must land in this one.
          const sameApp = lastRead?.turn === turn && (asked === 'front' || (lastRead.app ?? '').toLowerCase().includes(asked.toLowerCase()) || (asked.toLowerCase() === 'browser'));
          const t = sameApp ? `window:${lastRead.win}` : asked;
          // Ids up to the first click come from read_window; after a click the helper re-reads the page itself.
          const firstClick = steps.findIndex((s) => s.do === 'click' || s.do === 'click_text');
          const upTo = firstClick < 0 ? steps.length : firstClick + 1;
          const spec = t === 'front' || t.startsWith('window:') ? t : `app:${t}`;
          const live = steps.slice(0, upTo).some((s) => s.id != null) ? await liveControls(spec) : null;
          const mapped = [];
          for (const [i, s] of steps.entries()) {
            if (s.do === 'click_at' && s.x != null && s.y != null) { const [x, y] = await shotPoint(s.x, s.y); mapped.push({ ...s, x, y, global: true }); }
            else if (live && i < upTo && s.id != null) { const c = live(s.id); mapped.push({ ...s, id: c.id, label: c.label }); }
            else mapped.push(s);
          }
          // Delete, pay, send, sign out: ask first, whatever the request was. The helper refuses these clicks without it.
          if (allowedClicks.turn !== turn) allowedClicks = { turn, keys: new Set() };
          const appName = sameApp && lastRead.app ? lastRead.app : asked;
          const inThisPlan = new Set(); // one plan acts in one window, so its own steps share an Allow even when the app isn't known yet
          for (const s of mapped) {
            const label = s.do === 'click_text' ? s.text : s.do === 'click' ? s.label : s.do === 'choose' ? s.option : null;
            if (label && isRiskyClick(label)) {
              const kind = riskyKind(label);
              // "front" or "browser" could be a different app by the next call, so those aren't remembered past this plan.
              const key = /^(front|browser)$/i.test(appName) ? null : `${appName.toLowerCase()}|${kind}`;
              if (!inThisPlan.has(kind) && !(key && allowedClicks.keys.has(key))) {
                const where = appName === 'front' ? '' : ` in ${appName}`;
                const covers = key ? ` Allow covers every "${kind}" click there for the rest of this request.` : '';
                if (!(await confirm(`Click "${label}"${where}? It could delete, pay, send or sign out.${covers}`, ctx))) {
                  throw new Error(`${userName} said no, so I didn't click "${label}" (nothing after it ran either).`);
                }
                inThisPlan.add(kind);
                if (key) allowedClicks.keys.add(key);
              }
              s.confirmed = true;
            }
            delete s.label;
          }
          const plan = { steps: mapped, ...(t === 'front' ? {} : t.startsWith('window:') ? { window: +t.slice(7) } : { app: t }) };
          const act = () => hands('act', JSON.stringify(plan));
          let res;
          try {
            try { res = await act(); }
            catch (err) {
              // The app isn't open yet: open it (the same check as the open tool) and go on, instead of a round trip.
              if (plan.app && /No matching window/.test(String(err?.message ?? err)) && await launchApp(plan.app, hands)) { res = await act(); return finish(res); }
              // The window read earlier closed (a date picker or popup): use the app's front window instead.
              if (!plan.window || !/No matching window/.test(String(err?.message ?? err))) throw err;
              delete plan.window;
              if (asked !== 'front' && lastRead?.app) plan.app = lastRead.app;
              res = await act();
            }
          } finally {
            if (lastShot && mapped.some((s) => s.do !== 'wait')) lastShot.used = true;
          }
          return finish(res);
          function finish(res) {
            if (!res.controls) return `In ${res.window.app}: ${res.done.join(', ')}.`;
            lastRead = { win: res.window.id, app: res.window.app, controls: res.controls, turn };
            return `In ${res.window.app}: ${res.done.join(', ')}.\nNow showing: ${res.window.title || res.window.app}\n${controlList(res.controls, res.texts)}`;
          }
        },
      },
    ] : []),
    {
      name: 'draw',
      description: `Draw on the user's screen while you talk. Your Roamie turns into its cursor and draws with its tip, each beat's marks paced to its spoken line (also shown as a caption). One call holds a whole explanation or walkthrough.
beats: [{say, marks, wait?}]. say: one short line, under 20 words, spoken and captioned while that beat's marks draw, so your reply after draw never repeats or rephrases it (no restating the steps). Keep 1 to 4 marks per beat, in the order you mention them.
Places (at, to, tie), best first: {text: the exact words shown on screen} (exact bounds, scrolls to it; target 'screen' searches every app; also words inside paragraphs, text in images or canvases, and a single character, which matches case); add every: true to mark every place that text appears (each letter s, each mention of a word), one mark per place, and within: {x, y, w, h} (screenshot pixels, x, y the centre) to keep to one part of the screen (every s in one sentence); {id} from read_window, for controls without words; {x, y, w, h} pixels in your latest screenshot, for icons, shapes and areas without words: x, y is the thing's centre, and w, h its whole width and height; the box is then fitted to what's really drawn there, so a close guess is enough.
Which mark: one control they should click: target (with wait 'click' in a walkthrough); one thing to notice: ring (follows its shape; r sets the corner radius); a small spot or icon: point; a region or panel: frame; key words: underline (outdated ones: strike); right or wrong: check, cross; order of steps: num; a name beside something: label (text) or label on any mark; how two things relate: connect (at → to; flow: true runs moving dots along it, for something that travels or keeps happening); an odd-shaped group: trace (points); scroll here: scroll (dir); one thing above all else: spotlight (sparingly); something to hover: hover with wait 'hover'; big words: write (text, size).
Walkthroughs ("how do I…"): one beat per step, each a target on that step's control with label and wait 'click'; the next step is found after they click, on the screen as it is then.
Explanations that a picture makes clearer go on cards beside the window (tie connects a card to what it explains; every card can take a title, and card_size: small for an aside, large for something to read closely (a dense table, a detailed graph or diagram), full to fill the screen for something to study; normal by default. They can still resize it or make it full screen themselves): card (heading, text, items, sources), note (text, tone), list (title, items), mindmap (title: the topic; branches [{text, items: up to 6 short points, tone}], 2 to 8) for a topic and its parts at a glance (the user clicks a branch to open its points), clip (title, text), sources ([{name, url}]), legend (keys [{tone, text}]).
photo (query: a thing with a Wikipedia page, or url; text = caption). To name its parts add labels [{text, x, y}], x and y as fractions of the picture from its top left (0 to 1): only after see_photo has shown you that same picture, never from memory.
Numbers: bars (bars [{label, value, tone}], unit) compares amounts; graph (x_range, y_range, plots [{points, tone, label}], dots [{x, y, label}]) is for curves and change over time; timeline (events [{when, text}]) for dates. table (columns [headings], rows [[one cell per column]], up to ${LIMITS.columns} by ${LIMITS.rows}) compares things side by side: the first column names each row, cells stay short, and a cell of exactly "yes" or "no" is drawn as a tick or a cross.
flow (nodes [{id, text, shape: box|round|diamond, tone}], links [{from, to, label, flow}] by node id, dir: down|right) for a process, cause and effect or a decision: round for a start or an end, diamond for a question, flow: true runs moving dots along a link (what travels: data, blood, current), animate: true on the flow runs them along every link. Up to ${LIMITS.nodes} nodes, a few words each; it lays itself out.
map (region: world, a continent, or country names with commas between; shade [{name, tone}] colours countries in; pins [{name, lat, lon}]; routes [{from, to}] between pins by name). Country outlines only, no streets: cities, states and very small countries have no outline, so mark them with pins. Without region it fits what is shaded and pinned.
math (steps [{tex, note}]) writes worked maths one step at a time. tex: one line of LaTeX per step (\\frac{a}{b}, \\sqrt{x}, x^{2}, x_{1}, \\left( \\right), \\text{words}, Greek, \\times \\cdot \\pm \\le \\ne \\approx \\pi \\infty; no \\begin, & or \\\\ line breaks); note: a few plain words on what changed. geometry (vertices [{id, x, y}] in your own units with y up, lines [{from, to, label, dash}], angles [{at, from, to, label}] with at the corner, circles [{at, r, label}]) for triangles, circles and angles.
molecule (smiles, label) for chemistry. model (parts [{shape: box|sphere|cylinder|cone|torus, at [x,y,z], size [x,y,z], rot [deg x,y,z], tone, label, motion}] within about -1 to 1, title) for objects and machines. motion {do: spin|orbit|slide|pulse, axis: x|y|z, around [x,y,z], to [x,y,z], secs} makes a part move to show how the thing works: slide goes from at to "to" and back (a piston), orbit circles the point "around" (a planet, a crank pin), spin turns it in place (a round part spinning on its own axis looks still, so spin a box or orbit one round it), pulse swells and shrinks (a heart).
quiz (questions [{text, options: 2 to 4, answer: the right option word for word, explain}], up to ${LIMITS.questions}) for "test me": they answer by clicking and see right or wrong at once, and their score comes to you with their next message, so say a line and stop: never ask the questions in words too, or ask them for their answers or score.
Deep explanations: when they want to really understand something ("explain gene transcription in depth", "teach me how a jet engine works", "walk me through photosynthesis"), or the answer is a process with several stages, set deep: true. Each card then opens big in the middle of the screen and replaces the one before, so plan 4 to 10 beats with one card each that build on each other: the big picture first, then one stage or idea per card (flow, model, molecule, graph, timeline, table, math, photo with labels), then a short summary card. Each say line tells that part of the story; the cards show it. Not for quick answers.
Actions: type (text into the field at; needs actions allowed), copy (text to the clipboard), open (url), handoff (task), button (text + action {do: ask|open|copy, value}: a likely next step they can click), emote (name: hype, wave, upset, remind, motivate), sfx (name). tone: accent, teal, amber, coral, lilac, sky, lime, red, white.
A drawing stays until the user clears it or the window changes; your next drawing replaces it. At most ${LIMITS.cardsShown} cards show at once (one more closes the oldest), so make a point with the fewest cards. Every drawn piece gets an id (p1, p2 …) in the result. To change what's drawn ("make that red", "move it left", "never mind"): edit [{do: recolor|move|erase|clear, part, tone, dx, dy}] with no beats. Up to 12 beats, 40 marks each.${POINTER_OK ? '' : " On this desktop (Wayland) clicks and hovers in other apps can't be seen: never use wait; beats play one after another, so say each step's line in an order that reads well without pausing."}`,
      parameters: DrawArgs, executionMode: 'sequential', timeoutMs: 30 * 60_000,
      execute: draw,
    },
    {
      name: 'see_photo',
      description: "Look at a picture before naming its parts. Give the same query (a thing with a Wikipedia page) or url you will give draw's photo mark: you get that picture back, so you can see where each part is. Needed once before a photo with labels; a photo without labels doesn't need it.",
      parameters: z.object({ query: z.string().max(100).optional(), url: z.string().max(2000).optional() }),
      execute: async ({ query, url }) => {
        const p = await photos.see({ query, url });
        return { content: [
          { type: 'text', text: `This is the picture a photo mark with ${url ? 'this url' : `query "${query}"`} shows${p.title ? ` (${p.title})` : ''}. To name its parts, draw that photo with labels [{text, x, y}]: x and y are fractions of this picture, x from 0 at its left edge to 1 at its right, y from 0 at its top to 1 at its bottom. Put each point on the middle of the part it names, and only name parts you can see here.` },
          { type: 'image', mediaType: p.mediaType, data: p.data },
        ] };
      },
    },
    {
      name: 'read_file', description: 'Read a text file. Paths may start with ~. Files with passwords or keys (.ssh, .env, auth.json, keychains) are off limits.',
      parameters: z.object({ path: z.string() }),
      execute: async ({ path: p }) => clip(await fs.readFile(allowed(checkRead(at(p), HOME)), 'utf8'), 60_000),
    },
    {
      name: 'list_files', description: 'List the files and folders in a directory.',
      parameters: z.object({ dir: z.string() }),
      execute: async ({ dir }) => {
        const ents = await fs.readdir(allowed(checkRead(at(dir), HOME)), { withFileTypes: true });
        return ents.slice(0, 300).map((e) => (e.isDirectory() ? e.name + '/' : e.name)).join('\n') + (ents.length > 300 ? `\n…and ${ents.length - 300} more` : '');
      },
    },
    {
      name: 'search_files', description: `Search file contents under a specific folder for a text pattern (regex). Not your whole home folder: that trips macOS privacy prompts. To find files by name anywhere, use run_command with ${process.platform === 'darwin' ? 'mdfind' : LINUX ? 'find or locate' : 'dir /s'}.`,
      parameters: z.object({ pattern: z.string(), dir: z.string() }),
      execute: async ({ pattern, dir }) => {
        const d = allowed(checkRead(at(dir), HOME, { recursive: true }));
        // -e and -- keep a pattern like "--pre=cmd" from being read as an option (rg --pre runs programs).
        let r = await run('rg', ['-n', '--max-count', '5', '--max-columns', '200', '-e', pattern, '--', d]);
        if (r.err?.code === 'ENOENT') r = await run('grep', ['-rnI', '-m', '5', '-E', '-e', pattern, '--', d]);
        return clip(r.stdout || 'No matches.', 12_000);
      },
    },
    {
      name: 'write_file', description: 'Create or overwrite a text file with the given content (missing folders are made). Use this, not run_command, to create or change files: a new file needs no yes from the user; overwriting asks them. Several new files: one write_file call each, all in the same turn (a shell loop that makes files has to ask).',
      parameters: z.object({ path: z.string(), content: z.string() }), executionMode: 'sequential',
      execute: async ({ path: p, content }, ctx) => {
        if (!allowActions()) throw new Error(actionsOff);
        p = at(p);
        const exists = await fs.stat(expand(p)).then(() => true, () => false);
        const v = checkWrite(p, HOME, { exists, own });
        const f = allowed(v);
        if (v.level === ASK && !(await confirm(v.reason, ctx))) throw new Error(`${userName} said no, so I didn't write ${p}.`);
        await fs.mkdir(path.dirname(f), { recursive: true });
        await fs.writeFile(f, content);
        return `Wrote ${content.length} characters to ${f}.`;
      },
    },
    {
      name: 'run_command', description: `Run a shell command in ${where} and return its output. Use it for what the other tools can't do (counting, sorting, wc, mdfind, git, moving or copying); to open a file, folder, app or link use the open tool, which needs no yes. Prefer write_file for creating or editing files (several files: one write_file call each, in the same turn); never edit with sed -i or tee, and never make files in a shell loop (for/while), which always needs a yes. A > redirect into a new file is fine; overwriting an existing file, and commands that change things, make the user confirm first, which is slow.`,
      parameters: z.object({ command: z.string() }), executionMode: 'sequential', timeoutMs: 190_000, // up to 2 min to answer, then the 60 s run
      execute: async ({ command }, ctx) => {
        if (!allowActions()) throw new Error(actionsOff);
        const v = classifyCommand(command, HOME, { exists: existsSync, cwd: workdir, own });
        if (v.level === BLOCK) throw new Error(`Blocked for safety: ${v.reason} Don't try to get around this; tell ${userName} what you wanted to do instead.`);
        if (v.level === ASK && !(await confirm(`Run \`${command.length > 70 ? command.slice(0, 67) + '…' : command}\`?${v.reason ? ' ' + v.reason : ''}`, ctx))) {
          throw new Error(`${userName} said no, so the command didn't run.`);
        }
        const [sh, shArgs, shOpts] = shellFor(command);
        const r = await run(sh, shArgs, { ...shOpts, cwd: workdir, env: { ...process.env, ...GIT_SAFE } });
        const out = clip((r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : '')).trim() || '(no output)', 12_000);
        if (r.err && r.err.code !== 0) throw new Error(`Exit ${r.err.code ?? r.err.signal}\n${out}`);
        return out;
      },
    },
    // GG Coder's own web tools: search with a side search or keyless engines, pages as Markdown with offset to read on.
    createWebSearchTool(undefined, async (req) => {
      const side = sideSearchFor(await Promise.resolve().then(sideSearch).catch(() => null));
      return side ? side(req) : null;
    }),
    createWebFetchTool(undefined, { guardUrl: guardFetch }),
    {
      name: 'open', description: 'Open a website, a file or folder, or an app by name (e.g. "Safari", "https://skool.com", "~/Documents"). Links open in the default browser; set app to open one in a particular browser or app (e.g. app "Safari" when the user says "in Safari").',
      parameters: z.object({ target: z.string(), app: z.string().optional() }),
      execute: async ({ target, app }) => {
        let t = String(target).trim();
        // A bare web address ("example.com", "www.bbc.co.uk/news") is a link, not an app name: it used to fail as
        // "Unable to find application named example.com" and cost a retry. App bundles ("Notes.app") stay apps.
        if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i.test(t) && !/\.app$/i.test(t)) t = `https://${t}`;
        const isFile = /^[~/.]/.test(t) && await fs.stat(expand(t)).then((s) => s.isFile() && (s.mode & 0o111) !== 0, () => false);
        allowed(checkOpen(t, HOME, { executable: isFile }));
        agentChangesScreen();
        // mailto: has no //, but it's a link too (it used to be taken for an app name and fail).
        const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^mailto:/i.test(t), isPath = /^[~/.]/.test(t) || /^[a-z]:\\/i.test(t);
        let r;
        const inApp = app && ['darwin', 'win32'].includes(process.platform) && (isUrl || isPath) ? ['-a', String(app)] : [];
        if (process.platform === 'darwin') r = await run('open', isUrl || isPath ? [...inApp, isPath ? expand(t) : t] : ['-a', t]);
        else if (process.platform === 'win32') r = await winOpen(isPath ? expand(t) : t, app && (isUrl || isPath) ? String(app) : '');
        // Linux: links and files go to xdg-open; a plain name is an app, found by its .desktop file.
        else if (isUrl || isPath) r = await launch('xdg-open', [isPath ? expand(t) : t]);
        else r = await openLinuxApp(t);
        // Not installed: say so plainly, so the model doesn't go hunting for it with scripts (which need a yes each).
        if (r.err && /Unable to find application/i.test(r.stderr)) throw new Error(`There's no app called "${inApp.length ? app : t}" on ${THIS_COMPUTER} (not installed, or it has another name). Don't look for it another way; tell ${userName} and carry on with the rest.`);
        if (r.err) throw new Error(r.stderr.trim() || `Couldn't open ${t}.`);
        if (lastShot) lastShot.used = true;
        return `Opened ${t}${inApp.length ? ` in ${app}` : ''}.`;
      },
    },
    {
      name: 'remember_commitment',
      description: `Save something ${userName} has committed to doing, or anything they ask to be reminded about, so you can remind them at the right moment. Use it whenever they say they will do something or say "remind me". kind: 'reminder' for a plain "remind me to X at/in …" (it clears itself once the nudge is given), 'commitment' (default) for something they say they'll do or finish ("I'll finish the slides by Friday"), which stays open until they say it's done. due: a relative time like "in 90s", "in 5m", "in 1h30m" or "in 2 days" (best for short timers), or a local time YYYY-MM-DDTHH:mm:ss, YYYY-MM-DDTHH:mm, or YYYY-MM-DD if only the day is known; omit if there's no time at all. Resolve words like "Thursday", "at 2" or "tonight" from the timestamp on their message. repeat: only when they ask for it again and again ("every morning", "every weekday at 9", "every 2 hours", "on Mondays and Thursdays"): one of daily, weekdays, weekends, weekly, monthly, yearly, "every N minutes|hours|days|weeks|months" (at least 5 minutes), or days like "mon,wed,fri". It needs due, set to the first time (e.g. tomorrow 09:00 for "every morning at 9"). A repeating 'reminder' moves to its next time each time it fires; a repeating 'commitment' (a habit they want held to, like the gym) moves on when they mark it done. One saved item covers the whole series: never save one per day.`,
      parameters: z.object({ text: z.string().min(2).max(200), due: z.string().optional(), kind: z.enum(['reminder', 'commitment']).optional(), repeat: z.string().max(60).optional() }),
      execute: async ({ text, due, kind, repeat }) => {
        const ms = parseDue(due);
        if (ms === undefined) throw new Error(`Couldn't read the time "${due}". Use YYYY-MM-DDTHH:mm or YYYY-MM-DD.`);
        const r = repeat === undefined ? null : parseRepeat(repeat);
        if (r === undefined) throw new Error(`Couldn't read the repeat "${repeat}". Use daily, weekdays, weekly, monthly, "every 2 hours" (5 minutes or more) or days like "mon,wed,fri".`);
        if (r && !ms) throw new Error('A repeating reminder needs due: the first time it should go off.');
        // A plain reminder with no time has nothing to fire, so it's kept like a commitment.
        const c = await addCommitment(text, ms, ms ? kind : 'commitment', r?.spec);
        onCommitments(c);
        return `Saved as ${c.id}${c.due ? `, due ${fmtWhen(c.due)}` : ''}${c.repeat ? `, repeating ${repeatLabel(c.repeat)}` : ''}. I'll remind them${c.due ? ' when it is due' : ''}.`;
      },
    },
    {
      name: 'update_commitment',
      description: 'Mark a saved commitment done or dropped, or change its due time (same format as remember_commitment; use "none" to clear it) or its repeat (same format; "none" stops it repeating). Done on a repeating one ticks off this time and moves it to the next; dropped ends the whole series, so only drop one when they want it gone for good.',
      parameters: z.object({ id: z.string(), status: z.enum(['open', 'done', 'dropped']).optional(), due: z.string().optional(), repeat: z.string().max(60).optional() }),
      execute: async ({ id, status, due, repeat }) => {
        const ms = due === undefined ? undefined : due === 'none' ? null : parseDue(due);
        if (ms === undefined && due !== undefined) throw new Error(`Couldn't read the time "${due}".`);
        const r = repeat === undefined ? undefined : parseRepeat(repeat);
        if (r === undefined && repeat !== undefined) throw new Error(`Couldn't read the repeat "${repeat}".`);
        const c = await updateCommitment(id, { status, dueMs: ms, repeat: repeat === undefined ? undefined : r?.spec ?? null });
        if (!c) throw new Error(`No commitment with id ${id}. Call list_commitments to see the ids.`);
        onCommitments(c);
        if (c.advanced) return `Ticked off this time. ${c.id} repeats ${repeatLabel(c.repeat)}; next due ${fmtWhen(c.due)}.`;
        return `${c.id} is now ${c.status}${c.due ? `, due ${fmtWhen(c.due)}` : ''}${c.repeat ? `, repeating ${repeatLabel(c.repeat)}` : ''}.`;
      },
    },
    {
      name: 'forget_fact', description: 'Delete a saved fact that is wrong or that the user asks you to forget. Ids are in the memory section of the <live-state> block.',
      parameters: z.object({ id: z.string() }),
      execute: async ({ id }) => { const f = await forgetFact(id); if (!f) throw new Error(`No fact with id ${id}.`); return `Forgot: ${f.text}`; },
    },
    {
      // The step trail on screen. Free to call: always alongside other tool calls, never in a turn of its own.
      name: 'plan_steps',
      description: 'Shows the user a checklist of the parts of a request with 3 or more separate parts (do x, then y, then z). First call: steps, a few words each, in order, in the same turn as your first action. After that, in the same turn as the tool calls that do a part, call it with now: [that part\'s number(s), from 1]; it ticks off by itself when those calls succeed. A part you skip or can\'t do: skipped: [{step, why}], why in a few plain words, in the same turn as your next tool call. Never call it in a turn on its own, and never for one- or two-part requests.',
      parameters: z.object({
        steps: z.array(z.string()).min(2).max(8).optional(),
        now: z.array(z.number().int()).optional(),
        skipped: z.array(z.object({ step: z.number().int(), why: z.string() })).optional(),
      }),
      execute: async (args) => { onPlan(args); return 'ok'; },
    },
    {
      name: 'show_list', description: "Show the user their list on screen (reminders and commitments, Today and Later). Use when they ask to see their list, to-dos or reminders; then answer in a few words, don't read it all out.",
      parameters: z.object({}),
      execute: async () => { showList(); return 'The list is on screen.'; },
    },
    ...(dashboard ? [{
      name: 'arrange_dashboard',
      description: `Lay out ${userName}'s dashboard (the first page of the Roamies panel) when they ask to change it: a 6-column grid of widgets, rows going down. kind: 'todo' (their reminders and commitments, ticked off there), 'notes' (text they type there; text sets it), 'custom' (a value with a label and a little text you keep up to date, e.g. a streak, a count or a goal; how: the steps you'd take to find the current value, so a Refresh button there can ask you). x 0-5 and w 1-6 are columns, y and h are rows (h 2 is about a sticky note, 4 a tall list). "On the left" is x 0, "on the right" ends at column 6, "in the middle" is centred. Give the whole layout: widgets you leave out are removed; pass a widget's id to keep it and its contents. The current layout is in the live state.`,
      parameters: z.object({ widgets: z.array(z.object({ id: z.string().max(6).optional(), kind: z.enum(['todo', 'notes', 'custom']), title: z.string().max(40).optional(), x: z.number().optional(), y: z.number().optional(), w: z.number().optional(), h: z.number().optional(), text: z.string().max(4000).optional(), value: z.string().max(24).optional(), label: z.string().max(40).optional(), how: z.string().max(300).optional() })).max(12) }),
      execute: async ({ widgets }) => dashboard.arrange(widgets),
    }, {
      name: 'update_widget',
      description: "Change what one dashboard widget shows, by id (see the live state): a custom widget's value, label, text or how (after you've found the current value), a notes widget's text, or any widget's title. Not for moving or resizing: that's arrange_dashboard.",
      parameters: z.object({ id: z.string().max(6), title: z.string().max(40).optional(), text: z.string().max(4000).optional(), value: z.string().max(24).optional(), label: z.string().max(40).optional(), how: z.string().max(300).optional() }),
      execute: async ({ id, ...patch }) => dashboard.update(id, patch),
    }] : []),
    {
      name: 'snooze_reminder',
      description: `Snooze a reminder or commitment that just went off, when ${userName} says "snooze", "snooze 10 minutes", "remind me again in an hour", "move it to tomorrow" or "later tonight". until: "in 10m" / "10 minutes" / "1h", "tomorrow" (same time of day, next day), "tonight" (8 pm), or a local time YYYY-MM-DDTHH:mm; "snooze" alone means 10 minutes. Leave id out for the one that just went off; give it when they name another. This brings back a plain reminder that already cleared itself.`,
      parameters: z.object({ until: z.string().max(40).optional(), id: z.string().optional() }),
      execute: async ({ until = 'in 10m', id }) => {
        const target = snoozeTarget(id, firedReminders());
        if (!target) throw new Error('Nothing went off in the last 30 minutes. Call list_commitments and pass the id.');
        const c = getCommitment(target);
        if (!c) throw new Error(`No reminder with id ${target}. Call list_commitments to see the ids.`);
        const ms = snoozeUntil(until, c.due);
        if (ms === undefined) throw new Error(`Couldn't read "${until}" as a time ahead. Use "in 10m", "tomorrow", "tonight" or YYYY-MM-DDTHH:mm.`);
        // keepSeries: a repeating one (where that's supported) moves only this time, not its whole series.
        const u = await updateCommitment(target, { status: 'open', dueMs: ms, keepSeries: true });
        onCommitments(u);
        return `Snoozed "${u.text}" until ${fmtWhen(ms)}.`;
      },
    },
    {
      name: 'list_commitments', description: "List the open commitments you're keeping track of.",
      parameters: z.object({}),
      execute: async () => commitmentsText() || 'Nothing open.',
    },
    ...(focus ? [{
      name: 'start_focus',
      description: `Start a focus block when ${userName} wants to focus or work without distractions for a while ("focus for 45 minutes", "help me stay on task"). While it runs you look at the window in front every 20 seconds and get a note when they stay on a distraction (from their list: YouTube, Reddit, games and so on), so you can nudge them back. minutes: 5 to 240 (25 if they don't say). task: what they're working on, if they said. Starting one replaces a running block.`,
      parameters: z.object({ minutes: z.number().optional(), task: z.string().max(120).optional() }),
      execute: async ({ minutes, task }) => focus.start(minutes, task),
    }, {
      name: 'stop_focus',
      description: 'End the running focus block early, when they say they\'re done or want to stop.',
      parameters: z.object({}),
      execute: async () => focus.stop(),
    }] : []),
  ];

  // What's in front, for the live state. Quick and never fails: '' if the helper is missing, slow or denied.
  async function whereNow() {
    if (!HANDS) return '';
    const r = await runHands(['front'], { timeout: 900 });
    try { return frontLine(JSON.parse(r.stdout.trim().split('\n').pop() || '{}'), userName); } catch { return ''; }
  }
  // The window in front as data ({ app, title, url }), for focus mode; null if the helper is missing or slow.
  async function frontNow() {
    if (!HANDS) return null;
    const r = await runHands(['front'], { timeout: 900 }).catch(() => null);
    try { const f = JSON.parse(r?.stdout.trim().split('\n').pop() || '{}'); return f.app ? f : null; } catch { return null; }
  }
  // The front window's bounds ([x, y, w, h], screen points) for game mode, or null (no helper, no permission, too slow).
  async function frontBounds() {
    if (!HANDS) return null;
    const r = await Promise.race([hands('locate', 'front').catch(() => null), new Promise((res) => setTimeout(() => res(null), 1500))]);
    const b = r?.window?.bounds;
    return Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) ? b : null;
  }
  return { tools, hands, whereNow, frontNow, frontBounds, ink: inkEvents, nextTurn: () => ++turn };
}
