// The dashboard: the panel's first page, a grid of widgets the user arranges by asking ("to-dos on the left, notes on
// the right, my Clozemaster streak in the middle"), or by dragging and resizing them in the panel. Saved in config.
// Widgets: 'todo' (their reminders and commitments), 'notes' (text they type, or ask Roamies to write), 'custom'
// (a value and some text Roamies keeps up to date, with how it finds them, e.g. a streak read from a site).
export const COLS = 6, MAX_ROWS = 12, MAX_WIDGETS = 12;
export const KINDS = ['todo', 'notes', 'custom'];
const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const str = (v, n) => (v == null ? undefined : String(v).replace(/\s+$/g, '').slice(0, n));

export function defaultDashboard() {
  return { version: 1, widgets: [
    { id: 'w1', kind: 'todo', title: 'To do', x: 0, y: 0, w: 3, h: 4 },
    { id: 'w2', kind: 'notes', title: 'Notes', x: 3, y: 0, w: 3, h: 4, text: '' },
  ] };
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** Puts each widget where it asked, or the nearest free spot below it, in order: nothing ever overlaps. */
export function pack(widgets) {
  const placed = [];
  for (const w of widgets) {
    const q = { ...w };
    while (placed.some((p) => overlaps(p, q)) && q.y < 200) q.y++;
    placed.push(q);
  }
  return placed;
}

/** One widget as given (by the model or the panel) → a clean one, or null. Unknown fields are dropped. */
export function cleanWidget(raw, id) {
  if (!raw || !KINDS.includes(raw.kind)) return null;
  const w = clampInt(raw.w, 1, COLS, raw.kind === 'custom' ? 2 : 3);
  const out = {
    id, kind: raw.kind, title: str(raw.title, 40) || { todo: 'To do', notes: 'Notes', custom: 'Widget' }[raw.kind],
    x: clampInt(raw.x, 0, COLS - w, 0), y: clampInt(raw.y, 0, MAX_ROWS - 1, 0), w, h: clampInt(raw.h, 1, 8, raw.kind === 'custom' ? 2 : 4),
  };
  if (raw.kind === 'notes') out.text = str(raw.text, 4000) ?? '';
  if (raw.kind === 'custom') {
    for (const [k, n] of [['value', 24], ['label', 40], ['text', 600], ['how', 300]]) { const v = str(raw[k], n); if (v) out[k] = v; }
    if (Number.isFinite(raw.updatedAt)) out.updatedAt = raw.updatedAt;
  }
  return out;
}

const nextId = (widgets) => { const used = new Set(widgets.map((w) => w.id)); for (let i = 1; ; i++) if (!used.has(`w${i}`)) return `w${i}`; };

/** The saved dashboard, cleaned (a missing or broken one is the default). */
export function loadDashboard(saved) {
  if (saved?.version !== 1 || !Array.isArray(saved.widgets)) return defaultDashboard();
  const widgets = [];
  for (const w of saved.widgets.slice(0, MAX_WIDGETS)) { const c = /^w\d{1,3}$/.test(w?.id) && !widgets.some((q) => q.id === w.id) ? cleanWidget(w, w.id) : null; if (c) widgets.push(c); }
  return { version: 1, widgets: pack(widgets) };
}

/**
 * The model's arrangement replaces the layout: [{ id?, kind, title, x, y, w, h, text?, value?, label?, how? }]. A given
 * id keeps that widget's contents (notes text, a custom value) unless new ones are given.
 */
export function arrange(dash, list, now = Date.now()) {
  const widgets = [];
  for (const raw of (list ?? []).slice(0, MAX_WIDGETS)) {
    const old = raw?.id ? dash.widgets.find((w) => w.id === raw.id && w.kind === raw.kind) : null;
    const merged = old ? { ...old, ...Object.fromEntries(Object.entries(raw).filter(([, v]) => v != null)) } : raw;
    // A new widget's id skips every id in use: kept widgets, ones this layout names, and ones already given out.
    const taken = [...dash.widgets, ...list.filter((q) => q?.id).map((q) => ({ id: q.id })), ...widgets];
    const c = cleanWidget(merged, old?.id ?? nextId(taken));
    if (!c) continue;
    if (c.kind === 'custom' && (raw.value != null || raw.text != null)) c.updatedAt = now;
    widgets.push(c);
  }
  return { version: 1, widgets: pack(widgets) };
}

/** Changes one widget's contents ({ title, text, value, label, how }); null if there's no such widget. */
export function updateWidget(dash, id, patch, now = Date.now()) {
  const i = dash.widgets.findIndex((w) => w.id === id);
  if (i < 0) return null;
  const c = cleanWidget({ ...dash.widgets[i], ...Object.fromEntries(Object.entries(patch ?? {}).filter(([k, v]) => v != null && !['id', 'kind', 'x', 'y', 'w', 'h'].includes(k))) }, id);
  if (c.kind === 'custom' && (patch.value != null || patch.text != null)) c.updatedAt = now;
  const widgets = dash.widgets.slice(); widgets[i] = c;
  return { version: 1, widgets };
}

/** From the panel: a widget dragged ({ x, y }) or resized ({ w, h }). The others make room below it. */
export function moveWidget(dash, id, { x, y, w, h }) {
  const cur = dash.widgets.find((q) => q.id === id);
  if (!cur) return null;
  const nw = clampInt(w ?? cur.w, 1, COLS, cur.w), moved = { ...cur, w: nw, h: clampInt(h ?? cur.h, 1, 8, cur.h), x: clampInt(x ?? cur.x, 0, COLS - nw, cur.x), y: clampInt(y ?? cur.y, 0, MAX_ROWS - 1, cur.y) };
  // The moved one keeps its spot; the rest are placed around it, top to bottom.
  const rest = dash.widgets.filter((q) => q.id !== id).sort((a, b) => a.y - b.y || a.x - b.x);
  return { version: 1, widgets: pack([moved, ...rest]) };
}

export const removeWidget = (dash, id) => ({ version: 1, widgets: dash.widgets.filter((w) => w.id !== id) });

/** One line per widget for the model's live state. */
export function describeDashboard(dash) {
  return dash.widgets.map((w) => `${w.id} ${w.kind} "${w.title}" at column ${w.x + 1}-${w.x + w.w}, row ${w.y + 1}-${w.y + w.h}${w.kind === 'custom' && w.value ? ` = ${w.value}${w.label ? ` ${w.label}` : ''}` : ''}${w.how ? ` (updates by: ${w.how})` : ''}`).join('; ');
}
