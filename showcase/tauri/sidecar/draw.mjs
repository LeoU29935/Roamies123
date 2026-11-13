// The draw tool's pieces: the beats-and-marks schema (checked before anything draws), where each mark goes on the
// real screen, the parts already drawn (p1, p2 …) so follow-ups can edit them, photos and favicons for cards, and a
// small SMILES reader for molecules, a small LaTeX reader for maths, the layering of flow diagrams and the countries a
// map can show. No model-written code ever runs: the overlay only draws these structures.
import { z } from 'zod';
import { checkUrl } from './safety.mjs';
import { COUNTRIES } from './countries.mjs';

export const LIMITS = { beats: 12, marks: 40, points: 200, parts3d: 40, atoms: 120, photoBytes: 800_000, iconBytes: 64_000,
  nodes: 16, links: 24, columns: 6, rows: 12, bars: 12, labels: 8, pins: 12, shade: 40, routes: 8, steps: 10, tex: 300, vertices: 16, questions: 6, cardsShown: 4 };
export const TONES = ['accent', 'teal', 'amber', 'coral', 'lilac', 'sky', 'lime', 'red', 'white'];
// Marks on the real screen (they need a place on it), actions in apps, and cards drawn on calm space.
export const SCREEN = ['point', 'target', 'hover', 'ring', 'frame', 'underline', 'strike', 'check', 'cross', 'connect', 'trace', 'num', 'label', 'write', 'scroll', 'spotlight', 'highlight', 'line', 'curve', 'arrow', 'circle', 'rect'];
export const ACTIONS = ['emote', 'sfx', 'type', 'copy', 'open', 'handoff', 'button'];
export const CARDS = ['card', 'note', 'list', 'clip', 'sources', 'photo', 'graph', 'legend', 'timeline', 'molecule', 'model', 'flow', 'table', 'bars', 'map', 'math', 'geometry', 'quiz', 'ticket', 'medal'];
export const KINDS = [...SCREEN, ...ACTIONS, ...CARDS];
// Drawn from a list of points (screenshot pixels) instead of one place.
const PATHS = new Set(['trace', 'line', 'curve', 'arrow']);
const EMOTES = ['hype', 'wave', 'upset', 'remind', 'motivate'];
const SOUNDS = ['pop', 'tick', 'blip', 'whoosh', 'scan', 'done', 'page', 'hype', 'focus', 'expand'];
const SHAPES = ['box', 'sphere', 'cylinder', 'cone', 'torus'];
const MOTIONS = ['spin', 'orbit', 'slide', 'pulse'];
const NODE_SHAPES = ['box', 'round', 'diamond'];

const num = z.number();
const pair = z.array(num).length(2);
const triple = z.array(num).length(3);
const Target = z.object({
  text: z.string().min(1).max(80).optional(), every: z.boolean().optional(), within: z.object({ x: num, y: num, w: num, h: num }).optional(),
  id: z.number().int().optional(),
  x: num.optional(), y: num.optional(), w: num.optional(), h: num.optional(),
});
const Mark = z.object({
  kind: z.enum(KINDS),
  at: Target.optional(), to: Target.optional(), tie: Target.optional(),
  label: z.string().min(1).max(40).optional(), text: z.string().min(1).max(600).optional(),
  r: num.optional(), n: z.number().int().optional(), dir: z.enum(['up', 'down', 'right']).optional(), tone: z.enum(TONES).optional(),
  size: num.optional(), points: z.array(pair).max(LIMITS.points).optional(),
  card_size: z.enum(['small', 'normal', 'large', 'full']).optional(),
  name: z.string().max(20).optional(), url: z.string().max(2000).optional(), query: z.string().min(1).max(100).optional(),
  title: z.string().min(1).max(60).optional(), heading: z.string().min(1).max(80).optional(),
  items: z.array(z.string().min(1).max(120)).max(12).optional(),
  sources: z.array(z.object({ name: z.string().min(1).max(40), url: z.string().max(2000) })).max(8).optional(),
  x_range: pair.optional(), y_range: pair.optional(),
  plots: z.array(z.object({ points: z.array(pair).min(2).max(LIMITS.points), tone: z.enum(TONES).optional(), label: z.string().max(30).optional() })).max(4).optional(),
  dots: z.array(z.object({ x: num, y: num, label: z.string().max(30).optional() })).max(12).optional(),
  keys: z.array(z.object({ tone: z.enum(TONES), text: z.string().min(1).max(40) })).max(8).optional(),
  events: z.array(z.object({ when: z.string().min(1).max(16), text: z.string().min(1).max(60) })).max(10).optional(),
  smiles: z.string().min(1).max(200).optional(),
  parts: z.array(z.object({
    // One number for a size means that size every way (models write size: 2 for a ball or a cube).
    shape: z.enum(SHAPES), at: triple.optional(), size: z.preprocess((v) => (typeof v === 'number' ? [v, v, v] : v), triple).optional(), rot: triple.optional(),
    tone: z.enum(TONES).optional(), label: z.string().max(30).optional(),
    motion: z.object({ do: z.enum(MOTIONS), axis: z.enum(['x', 'y', 'z']).optional(), around: triple.optional(), to: triple.optional(), secs: num.optional() }).optional(),
  })).max(LIMITS.parts3d).optional(),
  nodes: z.array(z.object({ id: z.string().min(1).max(16), text: z.string().min(1).max(60), shape: z.enum(NODE_SHAPES).optional(), tone: z.enum(TONES).optional() })).max(LIMITS.nodes).optional(),
  links: z.array(z.object({ from: z.string().min(1).max(16), to: z.string().min(1).max(16), label: z.string().max(30).optional(), flow: z.boolean().optional() })).max(LIMITS.links).optional(),
  flow: z.boolean().optional(), animate: z.boolean().optional(),
  columns: z.array(z.string().max(30)).max(LIMITS.columns).optional(),
  rows: z.array(z.array(z.string().max(80)).max(LIMITS.columns)).max(LIMITS.rows).optional(),
  bars: z.array(z.object({ label: z.string().min(1).max(30), value: num, tone: z.enum(TONES).optional() })).max(LIMITS.bars).optional(),
  unit: z.string().max(12).optional(),
  labels: z.array(z.object({ text: z.string().min(1).max(30), x: num, y: num })).max(LIMITS.labels).optional(),
  region: z.string().max(80).optional(),
  shade: z.array(z.object({ name: z.string().min(1).max(50), tone: z.enum(TONES).optional() })).max(LIMITS.shade).optional(),
  pins: z.array(z.object({ name: z.string().min(1).max(30), lat: num, lon: num })).max(LIMITS.pins).optional(),
  routes: z.array(z.object({ from: z.string().min(1).max(30), to: z.string().min(1).max(30), tone: z.enum(TONES).optional() })).max(LIMITS.routes).optional(),
  steps: z.array(z.object({ tex: z.string().min(1).max(160), note: z.string().max(80).optional() })).max(LIMITS.steps).optional(),
  vertices: z.array(z.object({ id: z.string().min(1).max(8), x: num, y: num })).max(LIMITS.vertices).optional(),
  lines: z.array(z.object({ from: z.string().min(1).max(8), to: z.string().min(1).max(8), label: z.string().max(20).optional(), dash: z.boolean().optional(), tone: z.enum(TONES).optional() })).max(24).optional(),
  angles: z.array(z.object({ at: z.string().min(1).max(8), from: z.string().min(1).max(8), to: z.string().min(1).max(8), label: z.string().max(12).optional() })).max(8).optional(),
  circles: z.array(z.object({ at: z.string().min(1).max(8), r: num, label: z.string().max(20).optional(), tone: z.enum(TONES).optional() })).max(4).optional(),
  questions: z.array(z.object({ text: z.string().min(1).max(160), options: z.array(z.string().min(1).max(80)).min(2).max(4), answer: z.string().min(1).max(80), explain: z.string().max(200).optional() })).max(LIMITS.questions).optional(),
  action: z.object({ do: z.enum(['ask', 'open', 'copy']), value: z.string().min(1).max(600) }).optional(),
  task: z.string().max(120).optional(),
});
const Beat = z.object({ say: z.string().min(1).max(240), marks: z.array(Mark).max(LIMITS.marks), wait: z.enum(['click', 'hover']).optional() });
const Edit = z.object({ do: z.enum(['recolor', 'move', 'erase', 'clear']), part: z.string().max(8).optional(), tone: z.enum(TONES).optional(), dx: num.optional(), dy: num.optional() });
export const DrawArgs = z.object({
  target: z.string().optional(),
  beats: z.array(Beat).max(LIMITS.beats).optional(),
  edit: z.array(Edit).max(20).optional(),
  deep: z.boolean().optional(),
});

const hasAt = (t) => !!t && (t.text != null || t.id != null || (t.x != null && t.y != null));
/** Everything wrong with a draw call that the schema can't say, as lines for the model; [] when it's fine. */
export function checkDraw(args) {
  const out = [], beats = args.beats ?? [], edits = args.edit ?? [];
  if (!beats.length && !edits.length) out.push('Give beats to draw, or edit to change what is drawn.');
  beats.forEach((b, i) => {
    b.marks.forEach((m, j) => {
      const where = `beat ${i + 1} mark ${j + 1} (${m.kind})`, need = (ok, what) => { if (!ok) out.push(`${where}: needs ${what}.`); };
      if (PATHS.has(m.kind)) need(m.points?.length >= 2 || hasAt(m.at), 'points ([x, y] screenshot pixels, at least 2) or at');
      else if (m.kind === 'connect') { need(hasAt(m.at), 'at'); need(hasAt(m.to), 'to'); }
      else if (SCREEN.includes(m.kind)) need(hasAt(m.at), 'at (text, id, or x and y)');
      if (m.kind === 'label' || m.kind === 'write') need(m.text || m.label, 'text');
      if (m.kind === 'emote') need(EMOTES.includes(m.name), `name, one of ${EMOTES.join(', ')}`);
      if (m.kind === 'sfx') need(SOUNDS.includes(m.name), `name, one of ${SOUNDS.join(', ')}`);
      if (m.kind === 'type') { need(hasAt(m.at), 'at (the field)'); need(m.text, 'text'); }
      if (m.kind === 'copy') need(m.text, 'text');
      if (m.kind === 'open') need(m.url, 'url');
      if (m.kind === 'button') { need(m.text && m.text.length <= 40, 'text (under 40 characters)'); need(m.action, 'action ({do: ask|open|copy, value})'); }
      if (m.kind === 'card') need(m.text || m.heading, 'text or heading');
      if (m.kind === 'note') need(m.text, 'text');
      if (m.kind === 'list') need(m.items?.length, 'items');
      if (m.kind === 'clip') need(m.title && m.text, 'title and text');
      if (m.kind === 'sources') need(m.sources?.length, 'sources');
      if (m.kind === 'photo') need(m.query || m.url, 'query (a thing with a Wikipedia page) or url');
      if (m.kind === 'scroll' && m.dir === 'right') out.push(`${where}: dir for scroll is up or down.`);
      // The kinds with a structure of their own: each says what is wrong in words the model can fix.
      const more = CHECKS[m.kind] ?? (m.kind === 'photo' && m.labels ? CHECKS.labels : null);
      if (more) out.push(...more(m).map((s) => `${where}: ${s}`));
      if (m.kind === 'graph') need(m.plots?.length || m.dots?.length, 'plots or dots');
      if (m.kind === 'legend') need(m.keys?.length, 'keys');
      if (m.kind === 'timeline') need(m.events?.length >= 2, 'events (at least 2)');
      if (m.kind === 'molecule') { need(m.smiles, 'smiles'); if (m.smiles) { try { parseSmiles(m.smiles); } catch (e) { out.push(`${where}: ${e.message}`); } } }
      if (m.kind === 'ticket') need(m.title, 'title');
      if (m.kind === 'medal') need(m.text, 'text');
    });
    if (b.wait && !b.marks.some((m) => SCREEN.includes(m.kind) && hasAt(m.at))) out.push(`beat ${i + 1}: wait needs a mark on the thing to ${b.wait} (a target or hover with at).`);
  });
  edits.forEach((e, i) => {
    if (e.do !== 'clear' && !e.part) out.push(`edit ${i + 1} (${e.do}): needs part (an id like p3).`);
    if (e.do === 'recolor' && !e.tone) out.push(`edit ${i + 1}: recolor needs tone.`);
    if (e.do === 'move' && e.dx == null && e.dy == null) out.push(`edit ${i + 1}: move needs dx or dy (screen points).`);
  });
  return out;
}

const quoted = (list) => list.map((s) => `"${s}"`).join(', ');
// Ids that must be there and be different: nodes of a flow, vertices of a figure.
function idProblems(list, what) {
  const seen = new Set(), out = [];
  for (const n of list) { if (seen.has(n.id)) out.push(`two ${what} share the id "${n.id}"; give each its own.`); seen.add(n.id); }
  return out;
}
const CHECKS = {
  model(m) {
    if (!m.parts?.length) return ['needs parts.'];
    const out = [];
    m.parts.forEach((p, k) => {
      const mo = p.motion, who = `part ${k + 1}${p.label ? ` (${p.label})` : ''}`;
      if (!mo) return;
      if (mo.do === 'slide' && !mo.to) out.push(`${who}: slide needs to ([x, y, z]: where it slides to and back from at).`);
      if (mo.secs != null && !(mo.secs >= 0.3 && mo.secs <= 60)) out.push(`${who}: secs (one full cycle) must be between 0.3 and 60.`);
    });
    return out;
  },
  flow: (m) => checkFlow(m),
  table(m) {
    const cols = m.columns?.length ?? 0, out = [];
    if (cols < 2) out.push('needs columns (2 to 6 headings).');
    if (!m.rows?.length) out.push('needs rows (each a list of cells, one per column).');
    if (cols >= 2) (m.rows ?? []).forEach((r, k) => { if (r.length !== cols) out.push(`row ${k + 1} has ${r.length} cell${r.length === 1 ? '' : 's'} but there are ${cols} columns; give every row one cell per column ("" for an empty one).`); });
    return out;
  },
  bars(m) {
    if (!(m.bars?.length >= 2)) return ['needs bars (at least 2, each {label, value}).'];
    const out = [];
    m.bars.forEach((b, k) => { if (!Number.isFinite(b.value) || b.value < 0) out.push(`bar ${k + 1} ("${b.label}"): value must be 0 or more (for values below zero use graph).`); });
    if (!out.length && !m.bars.some((b) => b.value > 0)) out.push('every value is 0; at least one bar needs a value above 0.');
    return out;
  },
  labels(m) {
    const out = [];
    m.labels.forEach((l, k) => { if (!(l.x >= 0 && l.x <= 1 && l.y >= 0 && l.y <= 1)) out.push(`label ${k + 1} ("${l.text}"): x and y are fractions of the picture from its top left (0 to 1), not pixels.`); });
    return out;
  },
  map(m) {
    const out = [], pins = m.pins ?? [];
    if (!m.region && !m.shade?.length && !pins.length) return ['needs region, shade (countries to colour in) or pins.'];
    for (const p of pins) if (!(Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180)) out.push(`pin "${p.name}": lat must be between -90 and 90 and lon between -180 and 180 (south and west are negative).`);
    (m.routes ?? []).forEach((r, k) => { for (const end of [r.from, r.to]) if (!pins.some((p) => p.name === end)) out.push(`route ${k + 1}: no pin is named "${end}"${pins.length ? ` (pins: ${quoted(pins.map((p) => p.name))})` : ' (routes run between pins: add pins with name, lat, lon)'}.`); });
    try { resolveRegion(m); } catch (e) { out.push(e.message); }
    return out;
  },
  math(m) {
    if (!m.steps?.length) return ['needs steps (each {tex, note}).'];
    const out = [];
    m.steps.forEach((s, k) => { try { parseTex(s.tex); } catch (e) { out.push(`step ${k + 1}: ${e.message}`); } });
    return out;
  },
  geometry(m) {
    const vs = m.vertices ?? [], ids = new Set(vs.map((v) => v.id));
    if (vs.length < 2) return ['needs vertices (at least 2, each {id, x, y} in your own units, y up).'];
    const out = idProblems(vs, 'vertices'), known = (id, who) => { if (!ids.has(id)) out.push(`${who}: no vertex has the id "${id}" (vertices: ${quoted([...ids])}).`); };
    if (!m.lines?.length && !m.circles?.length) out.push('needs lines ({from, to}) or circles ({at, r}) between its vertices.');
    (m.lines ?? []).forEach((l, k) => { known(l.from, `line ${k + 1}`); known(l.to, `line ${k + 1}`); if (l.from === l.to) out.push(`line ${k + 1} goes from "${l.from}" to itself.`); });
    (m.angles ?? []).forEach((a, k) => { for (const id of [a.at, a.from, a.to]) known(id, `angle ${k + 1}`); if (a.at === a.from || a.at === a.to || a.from === a.to) out.push(`angle ${k + 1}: at (its corner), from and to (a point on each arm) must be three different vertices.`); });
    (m.circles ?? []).forEach((c, k) => { known(c.at, `circle ${k + 1}`); if (!(c.r > 0)) out.push(`circle ${k + 1}: r must be above 0 (in the same units as the vertices).`); });
    if (vs.every((v) => v.x === vs[0].x && v.y === vs[0].y)) out.push('every vertex is at the same place.');
    return out;
  },
  quiz(m) {
    if (!m.questions?.length) return ['needs questions (each {text, options, answer, explain}).'];
    const out = [];
    m.questions.forEach((q, k) => {
      const opts = q.options.map(sameText);
      if (new Set(opts).size !== opts.length) out.push(`question ${k + 1}: two options are the same.`);
      if (!opts.includes(sameText(q.answer))) out.push(`question ${k + 1}: answer must be one of its options, word for word (options: ${quoted(q.options)}).`);
    });
    return out;
  },
};
const sameText = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();

// ---------------------------------------------------------------- where marks go
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** A thing's corner radius from its box and accessibility role: round for small square things and checkboxes, a pill
 *  for thin things and words, a gently rounded box for fields, lists and anything bigger. r: given by the model. */
export function shapeRadius(w, h, role = '', r) {
  if (r != null && Number.isFinite(r)) return Math.max(0, r);
  const short = Math.min(w, h), long = Math.max(w, h), ro = String(role).toLowerCase();
  if (/check|radio|switch|toggle/.test(ro) && long <= 40) return short / 2;
  if (/field|text ?area|combo|search|table|list|group|image|web|scroll|window|area|cell|row|outline/.test(ro)) return clamp(short * 0.12, 4, 12);
  if (short <= 56) return short / 2;
  if (long <= 120 && long < short * 1.4) return short / 2;
  return clamp(short * 0.12, 8, 18);
}

/** The text match to mark: a whole label or heading (exact or word), not words buried in a paragraph. */
export function pickTextMatch(matches, find) {
  const q = String(find).trim();
  return (matches ?? []).find((m) => m.match !== 'partial' && m.text.trim().length <= Math.max(40, q.length * 3)) ?? null;
}

/** Big enough to be a window or a pane of one. The fit to drawn content is for icons, words and buttons: on a box
 *  this size it joined the neighbouring windows in, so frames came out several windows wide. */
export const windowSized = ([, , w, h]) => w >= 200 && h >= 150;
/** The open window a box was drawn round: every edge within 6% of that window's side (16 to 48 points). The closest
 *  when several fit, the frontmost on a tie; null when none does. windows: [x, y, w, h] each, front to back. */
export function fitWindow(rect, windows) {
  const [x, y, w, h] = rect;
  let best = null, bestOff = Infinity;
  for (const b of windows ?? []) {
    if (!Array.isArray(b) || !(b[2] > 0 && b[3] > 0)) continue;
    const tx = clamp(b[2] * 0.06, 16, 48), ty = clamp(b[3] * 0.06, 16, 48);
    const l = Math.abs(x - b[0]), r = Math.abs(x + w - b[0] - b[2]), t = Math.abs(y - b[1]), u = Math.abs(y + h - b[1] - b[3]);
    if (l > tx || r > tx || t > ty || u > ty) continue;
    if (l + r + t + u < bestOff) { bestOff = l + r + t + u; best = b; }
  }
  return best ? [...best] : null;
}

/** One place → { rect: [x, y, w, h] in global screen points, r, role, name }. look: { text(find), id(n), pixel(x, y), refine?(rect), snap?(rect), windows?() }. */
export async function resolveTarget(t, look, r) {
  let rect, role = '', name = '', live;
  if (t.text != null) {
    const m = await look.text(t.text);
    rect = m.bounds; role = m.role ?? 'text'; name = m.text;
  } else if (t.id != null) {
    const c = await look.id(t.id);
    rect = c.bounds; role = c.role ?? ''; name = c.label || c.role || '';
    live = c.id;
  } else if (t.x != null && t.y != null) {
    // x, y is the thing's centre, with or without w, h: models give centres either way, and read as a top-left
    // corner every loop sat half its size too low and to the right.
    if (t.w != null && t.h != null && t.w > 0 && t.h > 0) {
      const a = await look.pixel(t.x - t.w / 2, t.y - t.h / 2), b = await look.pixel(t.x + t.w / 2, t.y + t.h / 2);
      rect = [a[0], a[1], b[0] - a[0], b[1] - a[1]];
      // Round a window: that window's own edges, or the box as given when no window is there.
      if (windowSized(rect)) rect = fitWindow(rect, await look.windows?.()) ?? rect;
      // Fitted to what's really drawn there (an icon, a shape, a word, a letter); else the button or field it's a few
      // pixels off. Models' pixel guesses are often a letter or a few points out.
      else rect = (await look.refine?.(rect)) ?? (await look.snap?.(rect)) ?? rect;
    } else { const a = await look.pixel(t.x, t.y), g = [a[0] - 14, a[1] - 14, 28, 28]; rect = (await look.refine?.(g)) ?? g; }
  } else throw new Error('Give a place: text shown on screen, an id from read_window, or x and y from a screenshot.');
  rect = rect.map((v) => Math.round(v));
  return { rect, r: shapeRadius(rect[2], rect[3], role, r), role, name, ...(live != null ? { live } : {}) };
}

/** The beats with every place resolved to the screen. Paths (trace, line…) map each screenshot pixel. Cards and actions
 *  keep their content; ties and fields are resolved too. Throws the first problem, naming the mark. */
export async function resolveTargets(beats, look) {
  const out = [];
  for (const [i, b] of beats.entries()) {
    // A beat's marks are found together, so the helper fits their boxes in one go; their order stays.
    const found = await Promise.all(b.marks.map(async (m, j) => {
      const where = `beat ${i + 1} mark ${j + 1} (${m.kind})`;
      try {
        // Every place some text appears (each letter s, each mention of a word): one mark per place, in reading order.
        // within alone picks the one in that area (the text appears more than once).
        if ((m.at?.every || m.at?.within) && m.at.text != null && look.textAll) {
          let hits = await look.textAll(m.at.text);
          // within: only the ones in that part of the screenshot (x, y its centre, w, h its size).
          if (m.at.within) {
            const { x, y, w, h } = m.at.within, a = await look.pixel(x - w / 2, y - h / 2), z2 = await look.pixel(x + w / 2, y + h / 2);
            hits = hits.filter(({ bounds: [bx, by, bw, bh] }) => bx + bw / 2 >= a[0] && bx + bw / 2 <= z2[0] && by + bh / 2 >= a[1] && by + bh / 2 <= z2[1]);
          }
          if (!hits.length) throw new Error(`"${m.at.text}" isn't on screen${m.at.within ? ' in that area' : ''}.`);
          return hits.slice(0, m.at.every ? LIMITS.marks : 1).map((h) => ({ ...m, from: j, at: { rect: h.bounds.map((v) => Math.round(v)), r: shapeRadius(h.bounds[2], h.bounds[3], 'text', m.r), role: 'text', name: String(m.at.text) } }));
        }
        // from: which of the beat's marks it was made from (every can turn one into several).
        const o = { ...m, from: j };
        if (m.at && hasAt(m.at)) o.at = await resolveTarget(m.at, look, m.r);
        if (m.to && hasAt(m.to)) o.to = await resolveTarget(m.to, look);
        if (m.tie && hasAt(m.tie)) o.tie = await resolveTarget(m.tie, look);
        if (PATHS.has(m.kind) && m.points?.length >= 2) o.points = await Promise.all(m.points.map(([x, y]) => look.pixel(x, y)));
        if (m.kind === 'molecule') o.mol = parseSmiles(m.smiles);
        // The rest arrive already worked out, like a molecule: the overlay only lays them out.
        if (m.kind === 'flow') o.lay = flowLayers(m.nodes, m.links);
        if (m.kind === 'map') Object.assign(o, resolveRegion(m));
        if (m.kind === 'math') o.steps = m.steps.map((s) => ({ ...s, tree: parseTex(s.tex) }));
        if (m.kind === 'quiz') o.questions = m.questions.map((q) => ({ ...q, right: q.options.map(sameText).indexOf(sameText(q.answer)) }));
        return [o];
      } catch (e) { throw new Error(`${where}: ${e?.message ?? e}`); }
    }));
    out.push({ say: b.say, wait: b.wait ?? null, marks: found.flat().slice(0, LIMITS.marks) });
  }
  return out;
}

// ---------------------------------------------------------------- parts drawn so far
const quote = (s) => `“${String(s).replace(/\s+/g, ' ').slice(0, 40)}”`;
/** What a mark is, in a few words, for the tool result: ring “Export”, card “Compound interest”. */
export function partDesc(m) {
  const words = m.label ?? m.title ?? m.heading ?? m.at?.name ?? m.text ?? m.query ?? m.smiles ?? m.region ?? m.nodes?.[0]?.text ?? m.columns?.join(', ')
    ?? m.bars?.[0]?.label ?? m.steps?.[0]?.tex ?? m.questions?.[0]?.text ?? m.shade?.[0]?.name ?? m.pins?.[0]?.name ?? m.vertices?.map((v) => v.id).join('') ?? '';
  return `${m.kind}${words ? ` ${quote(words)}` : ''}`;
}
/** How a quiz answered on screen went, for the model: the score and what was missed. m: the quiz mark as it was
 *  sent to the overlay (each question with `right`); picks: the option chosen for each question, by its place. */
export function quizNote(m, picks) {
  const qs = m?.questions ?? [], cut = (t) => `“${String(t).replace(/\s+/g, ' ').slice(0, 100)}”`;
  if (!qs.length) return null;
  const pick = (i) => (Number.isInteger(picks?.[i]) && picks[i] >= 0 && picks[i] < qs[i].options.length ? picks[i] : -1);
  const missed = qs.map((q, i) => (pick(i) === q.right ? null : `${cut(q.text)} (they ${pick(i) < 0 ? 'skipped it' : `picked ${cut(q.options[pick(i)])}`}; the answer is ${cut(q.options[q.right])})`)).filter(Boolean);
  return `They answered the quiz${m.title ? ` ${cut(m.title)}` : ''} on screen by clicking: ${qs.length - missed.length} of ${qs.length} right.${missed.length ? ` Missed: ${missed.join('; ')}.` : ''}`;
}
const SILENT = new Set(['emote', 'sfx', 'copy', 'open', 'handoff']);
/** The parts on screen: ids never reused in a conversation, screen marks cleared on their own, cards until closed. */
export function createParts() {
  const all = new Map();
  let n = 0;
  return {
    /** Gives every drawn mark in these beats an id (part) and returns the new ids. */
    assign(beats) {
      const ids = [];
      for (const b of beats) for (const m of b.marks) {
        if (SILENT.has(m.kind)) continue;
        m.part = `p${++n}`;
        all.set(m.part, { kind: m.kind, desc: partDesc(m), screen: SCREEN.includes(m.kind) || m.kind === 'type' || (m.kind === 'button' && !!m.at) });
        ids.push(m.part);
      }
      return ids;
    },
    has: (id) => all.has(id),
    get: (id) => all.get(id),
    remove(id) { all.delete(id); },
    /** keep(id): parts that stay (a card the user pinned). */
    clear(keep = () => false) { for (const id of [...all.keys()]) if (!keep(id)) all.delete(id); },
    clearScreen() { for (const [id, p] of all) if (p.screen) all.delete(id); },
    /** Only `max` cards stay up at once (the overlay closes the oldest as each new one is drawn): forgets the older
     *  ones and returns their ids. skip(id): cards that don't count (a drawing that goes by itself). */
    trimCards(max, skip = () => false) {
      const cards = [...all].filter(([id, p]) => CARDS.includes(p.kind) && !skip(id)).map(([id]) => id), gone = cards.slice(0, Math.max(0, cards.length - max));
      for (const id of gone) all.delete(id);
      return gone;
    },
    get screenCount() { return [...all.values()].filter((p) => p.screen).length; },
    get ids() { return [...all.keys()]; },
    describe: (ids = [...all.keys()]) => describeParts(ids.map((id) => [id, all.get(id)]).filter(([, p]) => p)),
  };
}
/** "p1 ring “Export”, p2 card “Interest”" — the ids the model edits with. */
export const describeParts = (entries) => entries.map(([id, p]) => `${id} ${p.desc}`).join(', ');

// ---------------------------------------------------------------- photos and favicons
// Fetched through the same rules as web_fetch (public http(s) only, every redirect checked), size-capped, and handed
// to the overlay as data URLs so it can dither them on its canvas without loading anything itself.
async function getChecked(url, { fetchImpl = fetch, max, accept }) {
  let at = String(url), res;
  for (let hop = 0; ; hop++) {
    const v = checkUrl(at);
    if (v.level === 'block') throw new Error(`Blocked for safety: ${v.reason}`);
    res = await fetchImpl(at, { headers: { 'user-agent': 'Roamies-Sidekick', accept }, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    const next = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (!next) break;
    if (hop >= 4) throw new Error('Too many redirects.');
    at = new URL(next, at).href;
  }
  if (!res.ok) throw new Error(`${res.status} from ${new URL(at).hostname}`);
  const len = +(res.headers.get('content-length') ?? 0);
  if (max && len > max) throw new Error('That picture is too big.');
  const buf = Buffer.from(await res.arrayBuffer());
  if (max && buf.length > max) throw new Error('That picture is too big.');
  return { buf, type: String(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(), url: at };
}
const IMAGE = /^image\/(png|jpeg|jpg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml)$/;
async function imageData(url, opts) {
  const { buf, type } = await getChecked(url, { ...opts, accept: 'image/*' });
  if (!IMAGE.test(type)) throw new Error("That link isn't a picture.");
  return `data:${type};base64,${buf.toString('base64')}`;
}
/** A named thing's picture: its Wikipedia summary thumbnail (query), or a picture URL the model already found. */
export async function photoFor({ query, url }, { fetchImpl = fetch } = {}) {
  if (url) return { src: await imageData(url, { fetchImpl, max: LIMITS.photoBytes }), credit: new URL(url).hostname.replace(/^www\./, '') };
  // Titles are case-sensitive after the first letter, which Wikipedia always capitalises.
  const title = String(query).trim().replace(/\s+/g, '_'), page = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.charAt(0).toUpperCase() + title.slice(1))}`;
  const { buf } = await getChecked(page, { fetchImpl, max: 200_000, accept: 'application/json' });
  let j; try { j = JSON.parse(buf.toString('utf8')); } catch { throw new Error(`No Wikipedia page for "${query}".`); }
  const pic = j?.thumbnail?.source ?? j?.originalimage?.source;
  if (!pic) throw new Error(`Wikipedia has no picture for "${query}".`);
  return { src: await imageData(pic, { fetchImpl, max: LIMITS.photoBytes }), title: j.title ?? query, credit: 'Wikipedia' };
}
// What a model can be shown: not a drawing file (svg) or an icon.
const LOOKABLE = /^image\/(png|jpe?g|gif|webp)$/;
/** The pictures the model has looked at (the see_photo tool). Labels go on a picture by where its parts are, which
 *  the model can't know for a picture it hasn't seen: a labelled photo is refused until its picture has been looked
 *  at, and the card then shows that very picture. */
export function createPhotos({ fetchImpl = fetch, max = 12 } = {}) {
  const seen = new Map();
  const key = (m) => (m.url ? `url ${String(m.url).trim()}` : `query ${String(m.query ?? '').trim().toLowerCase().replace(/[\s_]+/g, ' ')}`);
  return {
    /** Fetches the picture a photo mark would show and returns it for the model to look at: { title, mediaType, data }. */
    async see({ query, url }) {
      if (!query && !url) throw new Error('Give query (a thing with a Wikipedia page) or url (a link to a picture).');
      const got = await photoFor({ query, url }, { fetchImpl }), m = /^data:([^;]+);base64,(.*)$/s.exec(got.src);
      if (!m || !LOOKABLE.test(m[1])) throw new Error("That picture is a kind that can't be looked at here (a drawing file or an icon). Try another picture, or show this one without labels.");
      const k = key({ query, url });
      seen.delete(k); seen.set(k, got);
      while (seen.size > max) seen.delete(seen.keys().next().value);
      return { title: got.title ?? '', mediaType: m[1] === 'image/jpg' ? 'image/jpeg' : m[1], data: m[2] };
    },
    /** What to tell the model when beats label a picture it hasn't looked at; null when they don't. */
    unseen(beats) {
      for (const [i, b] of (beats ?? []).entries()) for (const [j, m] of b.marks.entries()) {
        if (m.kind !== 'photo' || !m.labels?.length || seen.has(key(m))) continue;
        const how = JSON.stringify(m.url ? { url: m.url } : { query: m.query });
        return `beat ${i + 1} mark ${j + 1} (photo): labels go on a picture you have looked at, or they land in the wrong places. First call see_photo with ${how}, then draw again with each label's x and y read off that picture. (A photo without labels needs no look.)`;
      }
      return null;
    },
    /** The picture for a photo mark: the one looked at, else fetched now. */
    get: async (m) => seen.get(key(m)) ?? photoFor({ query: m.query, url: m.url }, { fetchImpl }),
  };
}
const icons = new Map();
/** A site's favicon as a data URL (cached), or null: the overlay draws a dot instead. */
export async function faviconFor(link, { fetchImpl = fetch } = {}) {
  let host;
  try { const u = new URL(String(link)); if (!/^https?:$/.test(u.protocol)) return null; host = u.hostname; } catch { return null; }
  if (icons.has(host)) return icons.get(host);
  const got = await imageData(`https://${host}/favicon.ico`, { fetchImpl, max: LIMITS.iconBytes }).catch(() => null);
  icons.set(host, got);
  return got;
}

// ---------------------------------------------------------------- SMILES (a small, strict subset)
const ORGANIC = ['Cl', 'Br', 'B', 'C', 'N', 'O', 'P', 'S', 'F', 'I'];
const AROMATIC = ['b', 'c', 'n', 'o', 'p', 's'];
const VALENCE = { B: [3], C: [4], N: [3, 5], O: [2], P: [3, 5], S: [2, 4, 6], F: [1], Cl: [1], Br: [1], I: [1] };
/** Atoms (element, aromatic, charge, hydrogens) and bonds (order 1, 2, 3 or 1.5 aromatic) from a SMILES string.
 *  Supports organic-subset and bracket atoms ([NH4+], [O-], [nH], [Fe+2]), = # : - bonds, branches and ring
 *  closures (1-9, %10-%99). Anything else (chirality, / \, dots, isotopes) is refused with a reason. */
export function parseSmiles(s) {
  const str = String(s ?? '').trim();
  if (!str) throw new Error('The SMILES is empty.');
  const atoms = [], bonds = [], stack = [], rings = new Map();
  let prev = null, bond = null, i = 0;
  const fail = (why) => { throw new Error(`Can't read SMILES "${str.slice(0, 40)}" at ${i + 1}: ${why}.`); };
  const addAtom = (a) => {
    if (atoms.length >= LIMITS.atoms) fail(`more than ${LIMITS.atoms} atoms`);
    atoms.push(a); const k = atoms.length - 1;
    if (prev != null) bonds.push({ a: prev, b: k, order: bond ?? (a.arom && atoms[prev].arom ? 1.5 : 1) });
    prev = k; bond = null;
  };
  while (i < str.length) {
    const ch = str[i];
    if (ch === '(') { if (prev == null) fail('a branch before any atom'); stack.push(prev); i++; continue; }
    if (ch === ')') { if (!stack.length) fail('a ) without its ('); prev = stack.pop(); i++; continue; }
    if (ch === '-' || ch === '=' || ch === '#' || ch === ':') { if (bond != null) fail('two bonds in a row'); bond = { '-': 1, '=': 2, '#': 3, ':': 1.5 }[ch]; i++; continue; }
    if (/[0-9%]/.test(ch)) {
      if (prev == null) fail('a ring number before any atom');
      let n;
      if (ch === '%') { const m = /^%(\d\d)/.exec(str.slice(i)); if (!m) fail('% needs two digits'); n = +m[1]; i += 3; } else { n = +ch; i++; }
      if (rings.has(n)) {
        const o = rings.get(n); rings.delete(n);
        if (o.at === prev) fail('a ring closing on itself');
        const order = bond ?? o.bond ?? (atoms[o.at].arom && atoms[prev].arom ? 1.5 : 1);
        bonds.push({ a: o.at, b: prev, order }); bond = null;
      } else { rings.set(n, { at: prev, bond }); bond = null; }
      continue;
    }
    if (ch === '[') {
      const end = str.indexOf(']', i);
      if (end < 0) fail('a [ without its ]');
      const m = /^([A-Z][a-z]?|se|as|[bcnops])(H\d?)?([+-]\d?|\+\+|--)?$/.exec(str.slice(i + 1, end));
      if (!m) fail(`"[${str.slice(i + 1, end)}]" is not a supported bracket atom (no isotopes or chirality)`);
      const arom = /^[a-z]/.test(m[1]), el = arom ? m[1][0].toUpperCase() + m[1].slice(1) : m[1];
      const h = m[2] ? (m[2].length > 1 ? +m[2].slice(1) : 1) : 0;
      const c = m[3] ? (m[3] === '++' ? 2 : m[3] === '--' ? -2 : (m[3][0] === '+' ? 1 : -1) * (m[3].length > 1 ? +m[3].slice(1) : 1)) : 0;
      addAtom({ el, arom, charge: c, h, bracket: true });
      i = end + 1; continue;
    }
    const org = ORGANIC.find((e) => str.startsWith(e, i));
    if (org) { addAtom({ el: org, arom: false, charge: 0, h: null }); i += org.length; continue; }
    if (AROMATIC.includes(ch)) { addAtom({ el: ch.toUpperCase(), arom: true, charge: 0, h: null }); i++; continue; }
    fail(`"${ch}" is not supported`);
  }
  if (stack.length) fail('a ( without its )');
  if (rings.size) fail(`ring ${[...rings.keys()][0]} is never closed`);
  if (bond != null) fail('a bond with nothing after it');
  // Implicit hydrogens for organic-subset atoms: the smallest normal valence that fits, minus the bonds.
  for (const [k, a] of atoms.entries()) {
    if (a.h != null) continue;
    // Aromatic n, o, s, p carry no implicit hydrogen (pyrrole's is written [nH]); an aromatic bond counts once, plus
    // one for the ring's shared double bond.
    if (a.arom && a.el !== 'C' && a.el !== 'B') { a.h = 0; continue; }
    const mine = bonds.filter((b) => b.a === k || b.b === k);
    const used = mine.reduce((s, b) => s + (b.order === 1.5 ? 1 : b.order), 0) + (mine.some((b) => b.order === 1.5) ? 1 : 0);
    const v = (VALENCE[a.el] ?? [0]).find((x) => x >= used) ?? used;
    a.h = Math.max(0, v - used);
  }
  return { atoms: atoms.map(({ el, arom, charge, h }) => ({ el, arom, charge, h })), bonds };
}

// ---------------------------------------------------------------- flow diagrams: which layer each node sits in
/** What's wrong with a flow's nodes and links, as lines; [] when it's fine. */
export function checkFlow(m) {
  const nodes = m.nodes ?? [], links = m.links ?? [], ids = new Set(nodes.map((n) => n.id));
  if (nodes.length < 2) return ['needs nodes (at least 2, each {id, text}).'];
  const out = idProblems(nodes, 'nodes');
  if (!links.length) out.push('needs links (each {from, to}: the ids of two nodes).');
  if (m.dir === 'up') out.push('dir for a flow is down or right.');
  links.forEach((l, k) => {
    for (const end of [l.from, l.to]) if (!ids.has(end)) out.push(`link ${k + 1}: no node has the id "${end}" (nodes: ${quoted([...ids])}).`);
    if (l.from === l.to) out.push(`link ${k + 1} goes from "${l.from}" to itself.`);
  });
  return out;
}
/** Layers for a checked flow, top to bottom (or left to right): { layers: [[id …] …], via: { link index: [id …] },
 *  back: [link index …] }. A link that closes a loop (back) is turned round for layering, so the rest still reads one
 *  way; a link that skips layers passes through a placeholder ("~3.1") in each one, listed in via, so it gets its own
 *  lane instead of running under the nodes between. Nodes in a layer are ordered to keep links from crossing. */
export function flowLayers(nodes, links) {
  const ids = nodes.map((n) => n.id), out = new Map(ids.map((id) => [id, []]));
  const edges = links.map((l, k) => ({ k, a: l.from, b: l.to })).filter((e) => e.a !== e.b && out.has(e.a) && out.has(e.b));
  for (const e of edges) out.get(e.a).push(e);
  const state = new Map(), back = new Set();
  const visit = (id) => {
    state.set(id, 1);
    for (const e of out.get(id)) { const st = state.get(e.b); if (st === 1) back.add(e.k); else if (!st) visit(e.b); }
    state.set(id, 2);
  };
  const fed = new Set(edges.map((e) => e.b));
  for (const id of [...ids.filter((x) => !fed.has(x)), ...ids]) if (!state.get(id)) visit(id);
  const dag = edges.map((e) => (back.has(e.k) ? { k: e.k, a: e.b, b: e.a } : e));
  // Each node as far down as its longest chain of links puts it; then a start with nothing above moves next to what it feeds.
  const rank = new Map(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    let moved = false;
    for (const e of dag) if (rank.get(e.b) < rank.get(e.a) + 1) { rank.set(e.b, rank.get(e.a) + 1); moved = true; }
    if (!moved) break;
  }
  const into = new Set(dag.map((e) => e.b));
  for (const id of ids) { if (into.has(id)) continue; const kids = dag.filter((e) => e.a === id).map((e) => rank.get(e.b)); if (kids.length) rank.set(id, Math.min(...kids) - 1); }
  const depth = Math.max(...rank.values()) + 1, layers = Array.from({ length: depth }, () => []), via = {}, segs = [];
  for (const id of ids) layers[rank.get(id)].push(id);
  for (const e of dag) {
    const chain = [e.a];
    for (let r = rank.get(e.a) + 1; r < rank.get(e.b); r++) { const d = `~${e.k}.${r}`; layers[r].push(d); chain.push(d); }
    chain.push(e.b);
    if (chain.length > 2) via[e.k] = chain.slice(1, -1);
    for (let j = 1; j < chain.length; j++) segs.push([chain[j - 1], chain[j]]);
  }
  // Fewer crossings: each layer sorted by where its neighbours sit in the layer before, down then up, a few times.
  const pos = new Map();
  const index = () => layers.forEach((l) => l.forEach((id, j) => pos.set(id, j)));
  index();
  for (let sweep = 0; sweep < 4; sweep++) {
    const down = sweep % 2 === 0;
    for (let r = down ? 1 : depth - 2; down ? r < depth : r >= 0; r += down ? 1 : -1) {
      const near = new Set(layers[r + (down ? -1 : 1)]);
      const mid = (id) => { const ns = segs.filter(([a, b]) => (down ? b === id && near.has(a) : a === id && near.has(b))).map(([a, b]) => pos.get(down ? a : b)); return ns.length ? ns.reduce((x, y) => x + y, 0) / ns.length : pos.get(id); };
      const want = new Map(layers[r].map((id) => [id, mid(id)]));
      layers[r].sort((a, b) => want.get(a) - want.get(b) || pos.get(a) - pos.get(b));
      index();
    }
  }
  return { layers, via, back: [...back] };
}

// ---------------------------------------------------------------- maps: countries and regions by name
const REGIONS = {
  world: [-169, -56, 180, 82], africa: [-20, -36, 53, 38], europe: [-25, 34, 45, 72], asia: [25, -11, 180, 78], 'north america': [-168, 7, -20, 84],
  'south america': [-82, -56, -34, 13], oceania: [110, -48, 180, 0], antarctica: [-180, -90, 180, -60],
  'middle east': [25, 12, 63, 42], 'southeast asia': [92, -11, 141, 28], 'east asia': [73, 18, 146, 54], 'south asia': [60, 5, 98, 38],
  scandinavia: [4, 54, 32, 71.5], caribbean: [-86, 9, -59, 27], 'central america': [-93, 7, -77, 19],
};
const REGION_ALSO = { australasia: 'oceania', 'south east asia': 'southeast asia', 'nordic countries': 'scandinavia', nordics: 'scandinavia', earth: 'world', globe: 'world', 'latin america': 'south america' };
const normName = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w && w !== 'the').join(' ');
// Places often asked for by name that are part of a country here.
const PART_OF = { england: 'United Kingdom', scotland: 'United Kingdom', wales: 'United Kingdom', 'northern ireland': 'United Kingdom', alaska: 'United States', hawaii: 'United States', tibet: 'China', siberia: 'Russia', sicily: 'Italy', corsica: 'France' };
const BY_NAME = new Map();
COUNTRIES.forEach((c, i) => { for (const k of [normName(c.n), ...c.a]) BY_NAME.set(k, i); });
function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) { const next = [i]; for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); row = next; }
  return row[b.length];
}
/** The country called that (any of its usual names): its index in COUNTRIES. Throws with the nearest names when
 *  there is none, since a country too small for this scale has no outline to draw. */
export function findCountry(name) {
  const key = normName(name), hit = BY_NAME.get(key);
  if (hit != null) return hit;
  const near = COUNTRIES.map((c) => { const n = normName(c.n); return [n.includes(key) || key.includes(n) ? 0 : editDistance(key, n), c.n]; })
    .filter(([d, n]) => key.length >= 3 && d <= Math.max(2, Math.floor(n.length / 3))).sort((a, b) => a[0] - b[0]).slice(0, 3).map(([, n]) => n);
  const whole = PART_OF[key];
  throw new Error(`no country outline for "${String(name).slice(0, 40)}"${whole ? ` (it is part of ${whole}, which has one)` : near.length ? ` (nearest: ${near.join(', ')})` : ''}. Countries only, and the very small ones aren't outlined: mark a city, a state or a small country with a pin (name, lat, lon) instead.`);
}
/** What a map shows: { view: [west, south, east, north] in degrees (east can pass 180), shade: [{ i, name, tone, at }] }
 *  with i the country's index in the outlines. region: 'world', a continent or part of one, or country names (commas
 *  between); without it the view fits the shaded countries and the pins, with room to see what's round them. */
export function resolveRegion(m) {
  const shade = (m.shade ?? []).map((s) => { const i = findCountry(s.name); return { i, name: COUNTRIES[i].n, tone: s.tone, at: COUNTRIES[i].at }; });
  const pins = (m.pins ?? []).filter((p) => Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180);
  let box = null, named = false;
  const join = (b) => { box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : [...b]; };
  for (const piece of String(m.region ?? '').split(/,|;|\band\b|&/i).map(normName).filter(Boolean)) {
    const r = REGIONS[REGION_ALSO[piece] ?? piece];
    if (r) { join(r); named = true; continue; }
    let i;
    try { i = findCountry(piece); } catch (e) { throw new Error(`region: ${e.message} Regions by name: ${Object.keys(REGIONS).join(', ')}.`); }
    join(COUNTRIES[i].b);
  }
  const fitted = !!box;
  // Pins are always in view; shaded countries too unless a region was named (a few countries coloured in on a world map).
  if (!named) for (const s of shade) join(COUNTRIES[s.i].b);
  for (const p of pins) join([p.lon, p.lat, p.lon, p.lat]);
  if (!box) throw new Error('needs region, shade (countries to colour in) or pins.');
  // Room round it: a little for a named region, more for a view fitted to one country or a pin, so its neighbours show.
  let [w, s, e, n] = box;
  const pad = named ? 0 : fitted ? 0.12 : 0.4, span = named ? 0 : 7;
  const gx = Math.max((e - w) * pad, (span - (e - w)) / 2, 0), gy = Math.max((n - s) * pad, (span - (n - s)) / 2, 0);
  w -= gx; e += gx; s = Math.max(-89, s - gy); n = Math.min(89, n + gy);
  if (e - w > 360) { w = -180; e = 180; }
  const r1 = (v) => Math.round(v * 10) / 10;
  return { view: [r1(w), r1(s), r1(e), r1(n)], shade };
}

// ---------------------------------------------------------------- maths (a small, strict subset of LaTeX)
const GREEK = { alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω' };
const TEX_ORD = { ...GREEK, infty: '∞', partial: '∂', nabla: '∇', hbar: 'ℏ', ell: 'ℓ', degree: '°', circ: '∘', angle: '∠', triangle: '△', emptyset: '∅', varnothing: '∅', forall: '∀', exists: '∃', neg: '¬', lnot: '¬', prime: '′', dots: '…', ldots: '…', cdots: '⋯', langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', sum: '∑', prod: '∏', int: '∫', oint: '∮',
  checkmark: '✓', star: '⋆', bullet: '•', square: '□', Box: '□', blacksquare: '∎', uparrow: '↑', downarrow: '↓', updownarrow: '↕', colon: ':', lbrace: '{', rbrace: '}', lvert: '|', rvert: '|', vert: '|', backslash: '\\' };
const TEX_OP = { times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', ast: '∗', cup: '∪', cap: '∩', setminus: '∖', land: '∧', wedge: '∧', lor: '∨', vee: '∨', oplus: '⊕' };
const TEX_REL = { le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', equiv: '≡', sim: '∼', simeq: '≃', cong: '≅', propto: '∝', lt: '<', gt: '>', nleq: '≰', ngeq: '≱', doteq: '≐', to: '→', gets: '←', longleftarrow: '←', Longrightarrow: '⇒', longleftrightarrow: '↔', rightarrow: '→', longrightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', implies: '⇒', iff: '⇔', mapsto: '↦', in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃', perp: '⊥', parallel: '∥', ll: '≪', gg: '≫', therefore: '∴', because: '∵', mid: '∣' };
const TEX_FN = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'log', 'ln', 'lg', 'exp', 'lim', 'max', 'min', 'det', 'gcd', 'mod', 'deg', 'arg', 'sup', 'inf', 'Pr', 'dim', 'ker']);
const TEX_SPACE = { ',': 0.17, ':': 0.22, ';': 0.28, ' ': 0.33, '!': 0, quad: 1, qquad: 2 };
const TEX_OVER = { vec: 'vec', overrightarrow: 'vec', bar: 'bar', overline: 'bar', hat: 'hat', widehat: 'hat', tilde: 'tilde', widetilde: 'tilde', dot: 'dot', underline: 'under', cancel: 'cancel' };
// Styles and sizes that change nothing drawn here: read past.
const TEX_SKIP = new Set(['displaystyle', 'textstyle', 'scriptstyle', 'limits', 'nolimits', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'bigm', 'mathstrut', 'nonumber', 'notag']);
const TEX_STYLE = new Set(['mathrm', 'mathbf', 'mathit', 'boldsymbol', 'mathsf', 'mathcal', 'mathtt', 'bm', 'mathnormal']);
const TEX_BB = { N: 'ℕ', Z: 'ℤ', Q: 'ℚ', R: 'ℝ', C: 'ℂ' };
const CHAR_OP = { '+': '+', '-': '−', '−': '−', '*': '·', '×': '×', '·': '·', '÷': '÷', '±': '±' };
const CHAR_REL = { '=': '=', '<': '<', '>': '>', '≤': '≤', '≥': '≥', '≠': '≠', '≈': '≈', '→': '→', '⇒': '⇒' };
const FENCES = { '(': '(', ')': ')', '[': '[', ']': ']', '|': '|', '.': '', '\\{': '{', '\\}': '}', '\\|': '‖', '\\langle': '⟨', '\\rangle': '⟩', '\\lfloor': '⌊', '\\rfloor': '⌋', '\\lceil': '⌈', '\\rceil': '⌉', '\\lvert': '|', '\\rvert': '|' };
const TEX_HELP = 'supported: \\frac, \\sqrt, ^, _, \\left( \\right), \\text, \\vec, \\bar, \\boxed, Greek letters, and symbols like \\times \\cdot \\pm \\le \\ne \\approx \\to \\pi \\infty \\sum \\int';
/** One line of maths as a tree for the overlay to lay out. Nodes: { t: 's', s, k } a symbol (k: num, var, op, rel, fn,
 *  ord), 'row' { c }, 'frac' { a, b }, 'sqrt' { a, n? }, 'script' { a, sup?, sub? }, 'fence' { l, r, a }, 'text' { s },
 *  'over' { a, m } (m: vec, bar, hat, tilde, dot, under, cancel), 'box' { a }, 'sp' { w }. Supports fractions, roots, powers and subscripts, sized brackets, words,
 *  Greek and common symbols; a wrapping $…$ is dropped. Anything else (\begin, &, \\, unknown commands) is refused
 *  with a reason, so nothing reaches the screen as raw LaTeX. */
export function parseTex(src) {
  const s = String(src ?? '').trim().replace(/^\$\$?|\$\$?$/g, '').replace(/^\\[([]|\\[)\]]$/g, '').trim();
  if (!s) throw new Error('The math is empty.');
  let i = 0, count = 0;
  const fail = (why) => { throw new Error(`Can't read math "${s.slice(0, 40)}" at ${Math.min(i, s.length) + 1}: ${why}.`); };
  const node = (n) => { if (++count > LIMITS.tex) fail('too long for one step; split it over two'); return n; };
  const sym = (ch, k) => node({ t: 's', s: ch, k });
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  // What a command takes: {…}, or the single thing after it (\frac12, x^2).
  const arg = (depth) => { ws(); if (i >= s.length) fail('something is missing at the end'); return atom(depth, true) ?? arg(depth); };
  const braced = (depth) => { ws(); if (s[i] !== '{') fail('expected {'); return atom(depth); };
  const fence = () => {
    ws();
    const m = /^(\\[a-zA-Z]+|\\[{}|]|[()[\]|.])/.exec(s.slice(i));
    if (!m || !(m[1] in FENCES)) fail('\\left and \\right need a bracket after them: ( ) [ ] | \\{ \\} or . for none');
    i += m[1].length;
    return FENCES[m[1]];
  };
  function row(end, depth) {
    const c = [];
    for (;;) {
      ws();
      if (i >= s.length) break;
      const ch = s[i];
      if (ch === '}') { if (end === '}') break; fail('a } without its {'); }
      if (end === ']' && ch === ']') break;
      if (s.startsWith('\\right', i) && !/[a-zA-Z]/.test(s[i + 6] ?? '')) { if (end === 'right') break; fail('a \\right without its \\left'); }
      if (ch === '^' || ch === '_') {
        i++;
        const key = ch === '^' ? 'sup' : 'sub', last = c.pop() ?? sym('', 'ord');
        const scr = last.t === 'script' && !last[key] ? last : node({ t: 'script', a: last });
        scr[key] = arg(depth + 1);
        // A raised ring is a degree sign.
        if (key === 'sup' && scr.sup.t === 's' && scr.sup.s === '∘' && !scr.sub) c.push(scr.a, sym('°', 'ord')); else c.push(scr);
        continue;
      }
      const a = atom(depth);
      if (a) c.push(a);
    }
    return c.length === 1 ? c[0] : node({ t: 'row', c });
  }
  // The next thing; null for a command that draws nothing. one: a lone digit rather than a whole number (x^10 is x¹0).
  function atom(depth, one) {
    if (depth > 16) fail('nested too deep');
    const ch = s[i];
    if (ch === '{') { i++; const r = row('}', depth + 1); if (s[i] !== '}') fail('a { without its }'); i++; return r; }
    if (ch === '}') fail('a } without its {');
    if (ch !== '\\') {
      if (/[0-9]/.test(ch)) { const m = one ? [ch] : /^[0-9]+(?:[.,][0-9]+)*/.exec(s.slice(i)); i += m[0].length; return sym(m[0], 'num'); }
      i += ch.length;
      if (ch === '&') fail('& (tables and lined-up equations) is not supported: put each line in its own step');
      if (ch === '$' || ch === '#') fail(`"${ch}" is not needed: give the math without it`);
      if (ch === '~') return node({ t: 'sp', w: 0.33 });
      if (ch === "'") return sym('′', 'ord');
      if (ch in CHAR_OP) return sym(CHAR_OP[ch], 'op');
      if (ch in CHAR_REL) return sym(CHAR_REL[ch], 'rel');
      return sym(ch, /[a-zA-Z]/.test(ch) ? 'var' : 'ord');
    }
    const m = /^\\([a-zA-Z]+|[^a-zA-Z])/.exec(s.slice(i));
    if (!m) fail('a \\ with nothing after it');
    const name = m[1];
    i += m[0].length;
    if (name === 'frac' || name === 'dfrac' || name === 'tfrac') { const a = arg(depth + 1), b = arg(depth + 1); return node({ t: 'frac', a, b }); }
    if (name === 'sqrt') {
      ws();
      let n;
      if (s[i] === '[') { i++; n = row(']', depth + 1); if (s[i] !== ']') fail('a [ without its ]'); i++; }
      return node({ t: 'sqrt', a: arg(depth + 1), ...(n ? { n } : {}) });
    }
    if (name === 'left') {
      const l = fence(), a = row('right', depth + 1);
      if (!s.startsWith('\\right', i)) fail('a \\left without its \\right');
      i += 6;
      return node({ t: 'fence', l, r: fence(), a });
    }
    if (name === 'right') fail('a \\right without its \\left');
    if (name === 'text' || name === 'textbf' || name === 'textit' || name === 'textrm' || name === 'operatorname' || name === 'mbox') {
      ws();
      if (s[i] !== '{') fail(`\\${name} needs its words in { }`);
      const end = s.indexOf('}', i);
      if (end < 0) fail('a { without its }');
      const words = s.slice(i + 1, end);
      if (words.includes('{')) fail(`\\${name} can only hold plain words`);
      i = end + 1;
      return node({ t: 'text', s: words });
    }
    if (name === 'mathbb') { const a = braced(depth + 1); if (a.t === 's' && TEX_BB[a.s]) return sym(TEX_BB[a.s], 'ord'); return a; }
    if (TEX_STYLE.has(name)) return arg(depth + 1);
    if (name in TEX_OVER) return node({ t: 'over', m: TEX_OVER[name], a: arg(depth + 1) });
    if (name === 'boxed' || name === 'fbox') return node({ t: 'box', a: arg(depth + 1) });
    // n over k in brackets: a fraction without its bar.
    if (name === 'binom' || name === 'dbinom' || name === 'tbinom') { const a = arg(depth + 1), b = arg(depth + 1); return node({ t: 'fence', l: '(', r: ')', a: node({ t: 'frac', a, b, bar: false }) }); }
    // A colour is read past (the card has its own); what it colours stays.
    if (name === 'color' || name === 'textcolor') { braced(depth + 1); return name === 'textcolor' ? arg(depth + 1) : null; }
    if (name === 'phantom' || name === 'hphantom' || name === 'vphantom' || name === 'hspace') { braced(depth + 1); return node({ t: 'sp', w: 0.5 }); }
    if (name in TEX_SPACE) return node({ t: 'sp', w: TEX_SPACE[name] });
    if (TEX_SKIP.has(name)) return null;
    if (TEX_FN.has(name)) return sym(name, 'fn');
    if (name in TEX_OP) return sym(TEX_OP[name], 'op');
    if (name in TEX_REL) return sym(TEX_REL[name], 'rel');
    if (name in TEX_ORD) return sym(TEX_ORD[name], 'ord');
    if ('{}%$_&#'.includes(name)) return sym(name, 'ord');
    if (name === '|') return sym('‖', 'ord');
    if (name === '\\') fail('\\\\ (a new line) is not supported: put each line in its own step');
    if (name === 'begin' || name === 'end') fail(`\\${name}{…} blocks (matrices, cases, lined-up equations) are not supported: one line per step`);
    fail(`\\${name} is not supported (${TEX_HELP})`);
  }
  const tree = row(null, 0);
  if (i < s.length) fail(s[i] === ']' ? 'a ] without its [' : `"${s[i]}" is out of place`);
  return tree;
}
