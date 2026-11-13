// Snoozing a reminder that just went off ("snooze 10 minutes", "move it to tomorrow"): when it should come back.
import { parseDue } from './store.mjs';

export const SNOOZE_WINDOW_MS = 30 * 60_000; // "snooze" with no name means the reminder that fired within this

/**
 * until: 'tomorrow' (same time of day as before, next day; 9:00 if it had no time), 'tonight' (8 pm, or tomorrow's if
 * that's past), or anything parseDue reads ('in 10m', '2026-11-13T09:00'). → ms, or undefined if unreadable or not ahead.
 */
export function snoozeUntil(until, due, now = Date.now()) {
  const s = String(until ?? '').trim().toLowerCase();
  let t;
  if (s === 'tomorrow' || s === 'tomorrow same time' || s === 'same time tomorrow') {
    const base = new Date(due ?? now), d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(due != null ? base.getHours() : 9, due != null ? base.getMinutes() : 0, 0, 0);
    t = d.getTime();
  } else if (s === 'tonight') {
    const d = new Date(now); d.setHours(20, 0, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    t = d.getTime();
  } else {
    const rel = /^\d+(\.\d+)?\s*[a-z]+/.test(s) ? `in ${s}` : s; // "10 minutes" is "in 10 minutes"
    t = parseDue(rel, now);
  }
  return t != null && t > now ? t : undefined;
}

/** Which reminder "snooze" means: the given id, else the latest one that fired within the window. */
export function snoozeTarget(id, fired, now = Date.now()) {
  if (id) return id;
  const recent = (fired ?? []).filter((f) => now - f.at <= SNOOZE_WINDOW_MS).sort((a, b) => b.at - a.at);
  return recent[0]?.id ?? null;
}
