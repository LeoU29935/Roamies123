// Focus mode: a timed block of work. While it runs, Roamies glances at the window in front (app, title, web address,
// from the hands helper on macOS and Windows) every so often, and nudges playfully when it stays on a distraction.
export const CHECK_MS = 20_000;       // how often it looks
export const DRIFT_CHECKS = 2;        // in a row on a distraction before a nudge: a quick glance is fine
export const NUDGE_GAP_MS = 3 * 60_000; // at most one nudge this often
export const MIN_MINUTES = 5, MAX_MINUTES = 240;

// Sites by address; apps and pages by name (in the app's name or the window title).
export const DEFAULT_DISTRACTIONS = ['youtube.com', 'YouTube', 'reddit.com', 'x.com', 'twitter.com', 'tiktok.com', 'instagram.com',
  'facebook.com', 'netflix.com', 'Netflix', 'twitch.tv', 'Twitch', 'Steam', 'Epic Games', 'Roblox', 'Minecraft', 'League of Legends',
  'Fortnite', 'Valorant', 'Counter-Strike', 'Battle.net', 'disneyplus.com', 'primevideo.com', '9gag.com'];

/** A list typed by the user ("youtube.com, Steam, chess.com") → clean entries; empty → the defaults. */
export function parseDistractions(text) {
  const items = String(text ?? '').split(/[,;\n]/).map((s) => s.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, ''))
    .filter((s) => s.length >= 2 && s.length <= 60);
  const seen = new Set();
  return items.filter((s) => !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase())).slice(0, 60);
}

const hostOf = (url) => { try { return new URL(/^[a-z]+:/i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The entry the front window matches ({ app, title, url }), or null. Roamies itself never counts. */
export function distraction(front, list = DEFAULT_DISTRACTIONS) {
  if (!front?.app || /^roamies$/i.test(front.app)) return null;
  const host = front.url ? hostOf(front.url) : '';
  const app = String(front.app).toLowerCase(), title = String(front.title ?? '');
  for (const entry of list) {
    const e = entry.toLowerCase();
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(e)) {
      // An address: the site or a subdomain of it; without an address (some browsers), its name in the title.
      if (host && (host === e || host.endsWith(`.${e}`))) return entry;
      if (!host && new RegExp(`(^|[^a-z0-9])${escape(e)}($|[^a-z0-9])`, 'i').test(title)) return entry;
    } else if (app.includes(e)) return entry;
    // A name in the window title: only when there's no address, since a page's title is about anything (a page about
    // "youtube-dl" isn't YouTube); with an address, sites are judged by it.
    else if (!host && new RegExp(`(^|[^\\p{L}\\p{N}])${escape(e)}($|[^\\p{L}\\p{N}])`, 'iu').test(title)) return entry;
  }
  return null;
}

/** A new block. minutes is clamped; task is what they're focusing on (optional). */
export function startBlock(minutes, task = '', now = Date.now()) {
  const m = Math.round(Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Number(minutes) || 25)));
  return { startedAt: now, until: now + m * 60_000, minutes: m, task: String(task ?? '').trim().slice(0, 120), streak: 0, drifts: 0, nudgedAt: 0, on: null };
}

/**
 * One look at the front window during a block. Mutates the block; returns what to do:
 * { end: true } when time is up, { nudge: entry } when they've stayed on a distraction, else {}.
 */
export function check(block, front, list, now = Date.now()) {
  if (now >= block.until) return { end: true };
  const hit = distraction(front, list);
  if (!hit) { block.streak = 0; block.on = null; return {}; }
  if (block.on !== hit) block.drifts++;
  block.on = hit;
  block.streak++;
  if (block.streak >= DRIFT_CHECKS && now - block.nudgedAt >= NUDGE_GAP_MS) { block.nudgedAt = now; return { nudge: hit }; }
  return {};
}
