// Roamies drawing on screen: the Sidekick turns into its cursor and draws hand-drawn teal marks with its tip (the
// same pen as the user's ⌃⌥ ink: teal, a dark edge so it reads on white, a soft glow), paced to its voice with a
// caption at the bottom. Screen marks follow each thing's real shape; cards and diagrams go on calm space beside the
// window and stay until closed. The sidecar (draw.mjs, tools.mjs) sends beats already checked and placed in global
// screen points; this overlay draws what falls on its own monitor. No model-written code runs here.
(() => {
  const R = window.Roamie;
  if (!R || typeof document === 'undefined') return;

  // ---------------------------------------------------------------- look
  const P = 4, MONO = '"Martian Mono", ui-monospace, monospace', DOTO = '"Doto", "Martian Mono", ui-monospace, monospace';
  const ACC = '#78ffe2', HOT = '#e6fffa', MID = '#28c4b8', DEEP = '#0e5c60', EDGE = 'rgba(3,39,34,0.6)';
  const GLASS = 'rgba(6,22,24,0.94)', TEXT = '#dcfff6', DIM = '#8ab8b0', INKDARK = '#032722';
  const TONES = { accent: ACC, teal: '#78ffe2', amber: '#ffcf5c', coral: '#ff8a7a', lilac: '#b9a4ff', sky: '#7cc8ff', lime: '#b6f36b', red: '#ff6b6b', white: '#e8fffa' };
  const LED = ['#051214', '#0e5c60', '#28c4b8', '#78ffe2', '#e6fffa'];
  const B4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const tone = (t) => TONES[t] || ACC;
  const now = () => performance.now() / 1000;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
  const back = (u) => 1 + 2.2 * (u - 1) ** 3 + 1.2 * (u - 1) ** 2;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mixHex = (a, b, k) => '#' + hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * k).toString(16).padStart(2, '0')).join('');
  const rgba = (h, a) => `rgba(${hex(h).join(',')},${a})`;
  const sfx = (n) => R.sfx?.play(n);
  const reducedMQ = matchMedia('(prefers-reduced-motion: reduce)');
  const reduced = () => reducedMQ.matches;
  const sleep = (ms) => new Promise((r) => setTimeout(r, reduced() ? Math.min(ms, 60) : ms));
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  // Global screen points → this overlay's px.
  const loc = (x, y) => [x - (R.origin?.x ?? 0), y - (R.origin?.y ?? 0)];
  const locRect = (r) => (r ? [...loc(r[0], r[1]), r[2], r[3]] : null);

  // ---------------------------------------------------------------- geometry: shapes drawn the way a hand would
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const len = (pts) => pts.reduce((s, p, i) => (i ? s + dist(pts[i - 1], p) : 0), 0);
  function dense(pts, step = 2) {
    const out = [];
    for (let i = 1; i < pts.length; i++) { const n = Math.max(1, Math.ceil(dist(pts[i - 1], pts[i]) / step)); for (let k = 0; k < n; k++) out.push([lerp(pts[i - 1][0], pts[i][0], k / n), lerp(pts[i - 1][1], pts[i][1], k / n)]); }
    out.push(pts[pts.length - 1]);
    // repeated points (where arcs meet) have no direction and pinch the pen into a spike
    return out.filter((p, i) => !i || dist(p, out[i - 1]) > 0.3);
  }
  const at = (pts, u) => { const f = clamp(u, 0, 1) * (pts.length - 1), i = Math.floor(f), k = f - i, a = pts[i], b = pts[Math.min(i + 1, pts.length - 1)]; return [lerp(a[0], b[0], k), lerp(a[1], b[1], k)]; };
  const arc = (cx, cy, rx, ry, a0, a1, n = 40) => Array.from({ length: n + 1 }, (_, k) => { const a = a0 + ((a1 - a0) * k) / n; return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]; });
  function roundRect(x, y, w, h, r) {
    r = clamp(r, 0, Math.min(w, h) / 2);
    return [...arc(x + w - r, y + r, r, r, -Math.PI / 2, 0, 10), ...arc(x + w - r, y + h - r, r, r, 0, Math.PI / 2, 10), ...arc(x + r, y + h - r, r, r, Math.PI / 2, Math.PI, 10), ...arc(x + r, y + r, r, r, Math.PI, Math.PI * 1.5, 10)];
  }
  function stepped(x, y, w, h, c = 2 * P) {
    const s = c / 2;
    return [[x + c, y], [x + w - c, y], [x + w - c, y + s], [x + w - s, y + s], [x + w - s, y + c], [x + w, y + c], [x + w, y + h - c], [x + w - s, y + h - c], [x + w - s, y + h - s], [x + w - c, y + h - s], [x + w - c, y + h],
      [x + c, y + h], [x + c, y + h - s], [x + s, y + h - s], [x + s, y + h - c], [x, y + h - c], [x, y + c], [x + s, y + c], [x + s, y + s], [x + c, y + s], [x + c, y]];
  }
  const steppedPath = (x, y, w, h, c) => { const p = new Path2D(); stepped(x, y, w, h, c).forEach((q, i) => (i ? p.lineTo(q[0], q[1]) : p.moveTo(q[0], q[1]))); return p; };
  function catmull(pts, closed) {
    const Q = closed ? [pts[pts.length - 1], ...pts, pts[0], pts[1]] : [pts[0], ...pts, pts[pts.length - 1]], out = [];
    for (let i = 1; i < Q.length - 2; i++) for (let k = 0; k < 10; k++) {
      const t = k / 10, [p0, p1, p2, p3] = [Q[i - 1], Q[i], Q[i + 1], Q[i + 2]];
      out.push([0, 1].map((d) => 0.5 * (2 * p1[d] + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t * t + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t * t * t)));
    }
    if (closed) out.push(out[0]);
    return out;
  }
  // A wobble along a path: a few slow waves with random phases, so no two marks are the same.
  const wobble = (amp) => { const w = [1, 2, 3].map((f) => [f, rnd(0, Math.PI * 2), amp / f ** 0.9 * rnd(0.6, 1.1)]); return (u) => w.reduce((s, [f, ph, a]) => s + a * Math.sin(u * Math.PI * 2 * f + ph), 0); };
  // The fallback shape rule (the sidecar sends r from the thing's role): a pill for thin things, round for small square
  // ones, a gently rounded box for anything bigger.
  function shapeRadius(w, h, r) {
    if (r != null) return r;
    const short = Math.min(w, h), long = Math.max(w, h);
    if (short <= 56) return short / 2;
    if (long <= 120 && long < short * 1.4) return short / 2;
    return clamp(short * 0.12, 8, 18);
  }
  // A loop round a box, hugging its shape: starts near the top left, goes round once and runs a little past its
  // start, each side bowing a touch, the whole loop a hair off straight.
  function loop(x, y, w, h, o = {}) {
    const pad = o.pad ?? 6, bx = x - pad, by = y - pad, bw = w + 2 * pad, bh = h + 2 * pad, cx = bx + bw / 2, cy = by + bh / 2;
    const r = Math.min(shapeRadius(w, h, o.r) + pad, bw / 2, bh / 2);
    const rr = roundRect(bx, by, bw, bh, r), base = dense([...rr, rr[0]], 1.5);
    let s0 = 0; const want = [bx + Math.min(bw * 0.28, 40), by]; base.forEach((p, i) => { if (dist(p, want) < dist(base[s0], want)) s0 = i; });
    const ring = [...base.slice(s0), ...base.slice(1, s0 + 1)];
    const over = o.over ?? rnd(0.08, 0.16), n = Math.ceil(ring.length * (1 + over));
    const size = Math.min(bw, bh), wob = wobble(clamp(size * 0.035, 0.8, 2.6)), drift = rnd(2, Math.min(6, size * 0.12)) * (Math.random() < 0.7 ? 1 : -1);
    const rot = rnd(-1.6, 1.6) * Math.PI / 180, sx = rnd(0.985, 1.025), sy = rnd(0.98, 1.03), c = Math.cos(rot), s = Math.sin(rot);
    const out = [];
    for (let i = 0; i < n; i++) {
      const p = ring[i % ring.length], q = ring[(i + 1) % ring.length], u = i / ring.length;
      const tx = q[0] - p[0], ty = q[1] - p[1], tl = Math.hypot(tx, ty) || 1, nx = ty / tl, ny = -tx / tl;
      const off = wob(u) + drift * clamp((u - 0.75) / 0.35, 0, 1);
      const px = cx + (p[0] + nx * off - cx) * sx, py = cy + (p[1] + ny * off - cy) * sy, dx = px - cx, dy = py - cy;
      out.push([cx + dx * c - dy * s, cy + dx * s + dy * c]);
    }
    return out;
  }
  // A stroke from a to b as a hand draws it: a slight bow, a touch of wobble, ends not quite where asked.
  function handLine(a, b, o = {}) {
    const d = dist(a, b), bow = (o.bow ?? rnd(-0.025, 0.025)) * d, wob = wobble(Math.min(1.2, d * 0.01)), nx = -(b[1] - a[1]) / (d || 1), ny = (b[0] - a[0]) / (d || 1);
    const j = o.jitter ?? 2, A = [a[0] + rnd(-j, j), a[1] + rnd(-j / 2, j / 2)], B = [b[0] + rnd(-j, j), b[1] + rnd(-j / 2, j / 2)];
    const n = Math.max(8, Math.ceil(d / 2));
    return Array.from({ length: n + 1 }, (_, k) => { const u = k / n, off = Math.sin(u * Math.PI) * bow + wob(u); return [lerp(A[0], B[0], u) + nx * off, lerp(A[1], B[1], u) + ny * off]; });
  }
  const handPath = (pts, amp = 1.2) => { const d = dense(pts, 2), wob = wobble(amp); return d.map((p, i) => { const q = d[Math.min(i + 1, d.length - 1)], r0 = d[Math.max(i - 1, 0)], tx = q[0] - r0[0], ty = q[1] - r0[1], tl = Math.hypot(tx, ty) || 1, off = wob(i / d.length); return [p[0] + (ty / tl) * off, p[1] - (tx / tl) * off]; }); };
  const boxOf = (pts) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return [x0, y0, x1 - x0, y1 - y0]; };
  const grow = (r, g) => [r[0] - g, r[1] - g, r[2] + 2 * g, r[3] + 2 * g];
  const overlap = (a, b) => Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const inside = (r, x, y, pad = 0) => !!r && x >= r[0] - pad && x <= r[0] + r[2] + pad && y >= r[1] - pad && y <= r[1] + r[3] + pad;
  const union = (a, b) => (!a ? b : !b ? a : (() => { const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]); return [x0, y0, Math.max(a[0] + a[2], b[0] + b[2]) - x0, Math.max(a[1] + a[3], b[1] + b[3]) - y0]; })());
  // The point on a box's edge facing p, a little outside it.
  const edgeToward = (r, p, pad = 6) => {
    const cx = r[0] + r[2] / 2, cy = r[1] + r[3] / 2, dx = p[0] - cx, dy = p[1] - cy, hw = r[2] / 2 + pad, hh = r[3] / 2 + pad;
    const k = Math.min(hw / (Math.abs(dx) || 1e-6), hh / (Math.abs(dy) || 1e-6));
    return [cx + dx * Math.min(1, k), cy + dy * Math.min(1, k)];
  };

  // ---------------------------------------------------------------- canvases: base (glass, edges, words) and lit (glowing ink)
  // Full screen, but allocated only while something is drawn, and only the area round the marks is redrawn, and only
  // while something on it animates.
  const view = document.createElement('canvas'), litC = document.createElement('canvas'), meas = document.createElement('canvas').getContext('2d');
  view.setAttribute('aria-hidden', 'true');
  Object.assign(view.style, { position: 'fixed', left: '0', top: '0', width: '100vw', height: '100vh', pointerEvents: 'none', visibility: 'hidden', cursor: 'default' });
  const V = view.getContext('2d'), Lc = litC.getContext('2d');
  const hasFilter = 'filter' in V;
  let W = innerWidth, H = innerHeight, DPR = 1, alloc = false;
  const mount = () => { const st = document.getElementById('stage'); if (st?.parentNode) st.parentNode.insertBefore(view, st); else document.body.appendChild(view); };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
  function allocate() {
    W = innerWidth; H = innerHeight; DPR = Math.min(2, devicePixelRatio || 1);
    for (const c of [view, litC]) { c.width = Math.round(W * DPR); c.height = Math.round(H * DPR); }
    alloc = true; view.style.visibility = ''; lastU = null;
  }
  const freeCanvas = () => { for (const c of [view, litC]) { c.width = c.height = 1; } alloc = false; view.style.visibility = 'hidden'; lastU = null; };
  addEventListener('resize', () => { W = innerWidth; H = innerHeight; if (alloc) { allocate(); touch(); } });

  const marks = [];
  let raf = 0, until = 0, lastU = null;
  // Something changed: draw for at least a little while (entrances, fades) and keep going while anything is live.
  function touch(sec = 0.7) { until = Math.max(until, now() + sec); if (!raf) raf = requestAnimationFrame(render); }
  function add(m) {
    Object.assign(m, { p: m.p ?? 0, alpha: 1, dx: 0, dy: 0, born: now(), alive: true, z: m.z ?? 3, color: m.color ?? ACC });
    marks.push(m); touch(); return m;
  }
  // A rect in a mark's own coordinates → on screen: moved by (dx, dy), and for a card zoomed by k from its top left
  // (ox, oy), when it has been resized or made full screen.
  const xf = (m, r) => {
    const k = m.k ?? 1;
    if (k === 1) return [r[0] + m.dx, r[1] + m.dy, r[2], r[3]];
    const ox = m.ox ?? 0, oy = m.oy ?? 0;
    return [ox + (r[0] - ox) * k + m.dx, oy + (r[1] - oy) * k + m.dy, r[2] * k, r[3] * k];
  };
  const markBox = (m) => { const b = typeof m.box === 'function' ? m.box() : m.box ?? (m.pts ? boxOf(m.pts) : null); return b ? xf(m, b) : [0, 0, W, H]; };
  const clampR = (r) => { const x0 = Math.max(0, Math.floor(r[0])), y0 = Math.max(0, Math.floor(r[1])), x1 = Math.min(W, Math.ceil(r[0] + r[2])), y1 = Math.min(H, Math.ceil(r[1] + r[3])); return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)]; };
  // Repaints one area: clears it on both layers, draws the marks that touch it, then the glow (the ink blurred under
  // itself, like the user's pen: 0.75, radius ~6).
  // The ink (lit layer) lands on top of what was drawn before it, so names, buttons and toasts (z 6 and up) are drawn
  // in a second pass after it: a circle or arrow never covers a label.
  function paint(C, t) {
    if (C[2] <= 0 || C[3] <= 0) return;
    const order = [...marks].sort((a, b) => a.z - b.z).filter((m) => overlap(grow(markBox(m), 28), C) > 0), cut = order.findIndex((m) => m.z >= 6);
    const passes = cut < 0 ? [order] : [order.slice(0, cut), order.slice(cut)];
    passes.forEach((group, i) => {
      for (const c of i ? [Lc] : [V, Lc]) { c.setTransform(DPR, 0, 0, DPR, 0, 0); c.clearRect(C[0], C[1], C[2], C[3]); }
      for (const c of [V, Lc]) { c.save(); c.beginPath(); c.rect(C[0], C[1], C[2], C[3]); c.clip(); }
      for (const m of group) {
        for (const c of [V, Lc]) {
          c.save(); c.globalAlpha = m.alpha; c.translate(m.dx, m.dy);
          if ((m.k ?? 1) !== 1) { c.translate(m.ox, m.oy); c.scale(m.k, m.k); c.translate(-m.ox, -m.oy); }
        }
        try { m.draw(V, Lc, t); } catch (e) { console.error('ink', e); m.alive = false; }
        for (const c of [V, Lc]) c.restore();
      }
      for (const c of [V, Lc]) c.restore();
      const sx = C[0] * DPR, sy = C[1] * DPR, sw = C[2] * DPR, sh = C[3] * DPR;
      V.save(); V.setTransform(1, 0, 0, 1, 0, 0);
      if (hasFilter) { V.globalAlpha = 0.75; V.filter = `blur(${4 * DPR}px)`; V.drawImage(litC, sx, sy, sw, sh, sx, sy, sw, sh); V.filter = 'none'; V.globalAlpha = 1; }
      else { V.shadowColor = rgba(ACC, 0.75); V.shadowBlur = 8 * DPR; }
      V.drawImage(litC, sx, sy, sw, sh, sx, sy, sw, sh);
      V.restore();
    });
  }
  // While something is being drawn, everything drawn is repainted each frame. Once it settles, only the few things
  // that keep moving (a waiting target's pulse, a turning model, bobbing chevrons) are, at 30 frames a second.
  let lastLive = 0;
  function render() {
    raf = 0;
    const t = now();
    for (let i = marks.length - 1; i >= 0; i--) if (!marks[i].alive) marks.splice(i, 1);
    if (!marks.length) { if (alloc) freeCanvas(); return; }
    if (!alloc) allocate();
    const full = t < until || !!drag || !!sizing || !lastU, live = full ? [] : marks.filter((m) => m.live?.(t));
    if (full) {
      let U = null;
      for (const m of marks) U = union(U, grow(markBox(m), 28));
      U = clampR(U);
      paint(lastU ? clampR(union(U, lastU)) : U, t);
      lastU = U;
    } else if (live.length) {
      if (t - lastLive >= 1 / 31) { lastLive = t; paint(clampR(live.reduce((u, m) => union(u, grow(markBox(m), 28)), null)), t); }
    }
    // touch() while drawing (text still typing in) may have asked for the next frame already: one frame, never two.
    if ((full || live.length) && !raf) raf = requestAnimationFrame(render);
  }
  async function tween(dur, f) {
    if (reduced() || dur <= 0) { f(1); touch(); return; }
    const t0 = now();
    for (;;) { const u = clamp((now() - t0) / dur, 0, 1); f(u); touch(); if (u >= 1) return; await frame(); }
  }

  // ---------------------------------------------------------------- the pen
  // An even line with soft ends and a little pressure change along it, and a dark edge so it reads on white.
  function outline(pts, w) {
    const n = pts.length, Lf = [], Rt = [], hw = [], ph = rnd(0, 6);
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], tx = b[0] - a[0], ty = b[1] - a[1], tl = Math.hypot(tx, ty) || 1, t = i / Math.max(1, n - 1);
      const end = Math.min(1, t / 0.06, (1 - t) / 0.08), r = (w / 2) * (0.55 + 0.45 * Math.sqrt(clamp(end, 0, 1))) * (1 + 0.08 * Math.sin(t * 9 + ph));
      hw.push(r); Lf.push([pts[i][0] - (ty / tl) * r, pts[i][1] + (tx / tl) * r]); Rt.push([pts[i][0] + (ty / tl) * r, pts[i][1] - (tx / tl) * r]);
    }
    return { Lf, Rt, hw };
  }
  const colorOf = (m, color) => { const rc = m.recolor; return rc && now() - rc < 0.5 ? mixHex(m.color0, color, (now() - rc) / 0.5) : color; };
  function pen(base, lit, m, pts, p, color, o = {}) {
    if (p <= 0 || !pts || pts.length < 2) return;
    if (p < 1) touch(0.1);
    const key = o.key || 'o', w = o.w || 3.6;
    const ol = (m.__ol ??= {})[key]?.src === pts ? m.__ol[key] : (m.__ol[key] = { src: pts, ...outline(pts, w) });
    const k = Math.max(1, Math.round((pts.length - 1) * clamp(p, 0, 1)));
    const body = new Path2D(); body.moveTo(ol.Lf[0][0], ol.Lf[0][1]);
    for (let i = 1; i <= k; i++) body.lineTo(ol.Lf[i][0], ol.Lf[i][1]);
    for (let i = k; i >= 0; i--) body.lineTo(ol.Rt[i][0], ol.Rt[i][1]);
    body.closePath();
    const c = colorOf(m, color);
    base.save(); base.lineJoin = 'round'; base.lineWidth = 2.5; base.strokeStyle = EDGE; base.stroke(body); base.beginPath(); base.arc(pts[k][0], pts[k][1], ol.hw[k] + 1.2, 0, Math.PI * 2); base.fillStyle = EDGE; base.fill(); base.restore();
    lit.save(); lit.fillStyle = c; lit.fill(body); lit.beginPath(); lit.arc(pts[k][0], pts[k][1], ol.hw[k], 0, Math.PI * 2); lit.arc(pts[0][0], pts[0][1], ol.hw[0], 0, Math.PI * 2); lit.fill(); lit.restore();
  }
  // Our chrome for cards and chips: stepped corners, dark glass, an accent edge, a glint along the top.
  function chrome(c, x, y, w, h, o = {}) {
    const path = steppedPath(x, y, w, h, o.corner ?? 2 * P), edge = o.edge || ACC;
    c.save();
    c.fillStyle = o.fill || GLASS; c.shadowColor = 'rgba(0,0,0,0.35)'; c.shadowBlur = 14; c.shadowOffsetY = 4; c.fill(path);
    c.shadowColor = rgba(edge, 0.7); c.shadowBlur = 8; c.shadowOffsetY = 0; c.strokeStyle = edge; c.lineWidth = 1.5; c.globalAlpha *= 0.9; c.stroke(path);
    c.globalAlpha *= 0.6; c.shadowBlur = 0; c.strokeStyle = '#ffffff'; c.lineWidth = 1; c.beginPath(); c.moveTo(x + 3 * P, y + 1.5); c.lineTo(x + Math.min(w * 0.45, 90), y + 1.5); c.stroke();
    c.restore();
  }
  // Words typing themselves in; the last couple land white.
  function typed(c, str, x, y, font, color, u, o = {}) {
    str = String(str ?? '');
    c.save(); c.font = font; c.textBaseline = o.baseline || 'alphabetic'; c.textAlign = 'left';
    const full = c.measureText(str).width, x0 = o.anchor === 'middle' ? x - full / 2 : o.anchor === 'end' ? x - full : x;
    // With reduced motion the words are simply there.
    const n = reduced() ? str.length : Math.floor(str.length * clamp(u, 0, 1));
    // Still typing in: keep repainting until it's all there (a card stopped after 1.5 s, freezing long text mid-word).
    if (n < str.length) touch(0.1);
    if (o.rim) { c.lineWidth = o.rim; c.strokeStyle = EDGE; c.lineJoin = 'round'; c.strokeText(str.slice(0, n), x0, y); }
    if (n >= str.length || o.land === false) { c.fillStyle = color; c.fillText(str.slice(0, n), x0, y); }
    else { const head = str.slice(0, Math.max(0, n - 2)); c.fillStyle = color; c.fillText(head, x0, y); c.fillStyle = '#ffffff'; c.fillText(str.slice(head.length, n), x0 + c.measureText(head).width, y); }
    c.restore();
    return full;
  }
  const textW = (str, font) => { meas.font = font; return meas.measureText(String(str)).width; };
  // Cut to fit maxW px with an ellipsis (by measured width, not a character count).
  function ellipsize(str, maxW, font) {
    str = String(str ?? '');
    if (textW(str, font) <= maxW) return str;
    let lo = 0, hi = str.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (textW(`${str.slice(0, mid).trimEnd()}…`, font) <= maxW) lo = mid; else hi = mid - 1; }
    // End on a whole word when one is close, rather than mid-word.
    let cut = str.slice(0, lo);
    const sp = cut.lastIndexOf(' ');
    if (lo < str.length && str[lo] !== ' ' && sp > cut.length * 0.6) cut = cut.slice(0, sp);
    return `${cut.trimEnd()}…`;
  }
  // Lines of at most w px. A word wider than a line (a link, a long name) is broken across lines; past max rows the
  // last one ends in an ellipsis.
  function wrapRows(str, w, font, max = Infinity) {
    meas.font = font;
    const fits = (t) => meas.measureText(t).width <= w, rows = [];
    for (const para of String(str ?? '').split('\n')) {
      let row = '';
      for (let wd of para.split(/\s+/).filter(Boolean)) {
        const tr = row ? `${row} ${wd}` : wd;
        if (fits(tr)) { row = tr; continue; }
        if (row) { rows.push(row); row = ''; }
        while (!fits(wd)) { let k = wd.length - 1; while (k > 1 && !fits(wd.slice(0, k))) k--; rows.push(wd.slice(0, k)); wd = wd.slice(k); }
        row = wd;
      }
      rows.push(row);
    }
    while (rows.length > 1 && !rows[rows.length - 1]) rows.pop();
    if (rows.length > max) { const rest = rows.splice(max); rows[max - 1] = ellipsize(`${rows[max - 1]} ${rest.join(' ')}`, w, font); }
    return rows;
  }
  // The card fonts load on first use; measuring before they arrive gave widths for the fallback font, and the text
  // then grew past its card once the real one loaded. Everything waits for them once (never more than 1.5 s).
  let fontsOk = null;
  const fontsReady = () => (fontsOk ??= Promise.race([Promise.all([`500 13px ${MONO}`, `700 11px ${MONO}`, `800 16px ${DOTO}`].map((f) => document.fonts?.load(f))), sleep(1500)]).catch(() => {}));
  function wrapped(c, rows, x, y, lh, font, color, u) {
    const total = rows.reduce((s, r) => s + r.length + 1, 0);
    let left = reduced() ? total : Math.floor(total * clamp(u, 0, 1));
    if (left < total) touch(0.1);
    rows.forEach((r, i) => { const k = Math.min(r.length, left); left -= r.length + 1; if (k > 0) typed(c, r.slice(0, k), x, y + i * lh, font, color, 1); });
  }

  // ---------------------------------------------------------------- the cursor: the real Sidekick in cursor form
  const agent = () => R.tiles?.find((t) => t.creature?.agent)?.creature?.agent ?? null;
  const penApi = () => agent()?.pen ?? null;
  const tipNow = () => penApi()?.held ? penApi().tip : [W * 0.8, H * 0.8];
  const take = async () => { try { await penApi()?.take(); } catch (e) { console.error('ink pen', e); } };
  const fly = (x, y) => penApi()?.move(x, y) ?? Promise.resolve();
  const rest = (x, y) => penApi()?.rest(x, y) ?? Promise.resolve();
  const tap = async (x, y) => { await (penApi()?.tap(x, y) ?? Promise.resolve()); burst(x, y); };
  const park = (kind, x, y) => penApi()?.park(kind, x, y);
  // Draw along points at a hand's pace; the cursor's tip leads the stroke.
  // A hand's pace, a little brisk: about 900 px a second, never a blink, never a crawl.
  const penDur = (pts) => clamp(len(pts) / 900, 0.25, 1.0);
  async function trace(pts, dur, onP) {
    const p = penApi();
    if (reduced() || !p?.held) { onP(1); touch(); return; }
    await p.trace(pts, dur, (u) => { onP(u); touch(); });
  }
  function burst(x, y, big) {
    const rr = big ? 16 : 7;
    add({ z: 9, p: 1, box: [x - 50, y - 50, 100, 100], draw(b, l, t) { const u = (t - this.born) / (big ? 0.45 : 0.35); if (u >= 1) { this.alive = false; return; } const r = rr + u * (big ? 30 : 14); l.save(); l.globalAlpha *= 1 - u; l.strokeStyle = u < 0.3 ? HOT : ACC; l.lineWidth = 2; l.beginPath(); l.arc(x, y, r, 0, Math.PI * 2); l.stroke(); l.restore(); }, live: () => true });
  }

  // ---------------------------------------------------------------- names: pixel tags on the calmest free spot
  // A solid teal tag with a hard drop shadow; it lands in three pixel steps. Names, step numbers and buttons share it.
  const CHIP = (k = 1) => `700 ${11 * k}px ${MONO}`;
  const pillSize = (s) => [Math.round(textW(s, CHIP()) + 22), 23];
  function chip(b, x, y, w, h, str, age, o = {}) {
    const k = o.k || 1, cx = x + w / 2, cy = y + h / 2 + 0.5, type = (age - 0.08) / (0.12 + String(str).length * 0.025), fill = o.color || ACC;
    const u = clamp(age / 0.2, 0, 1), drop = reduced() ? 0 : Math.round((1 - u) * 3) * 3;
    b.save(); b.translate(0, -drop);
    if (o.down) b.translate(0, 2);
    b.fillStyle = mixHex(fill, '#000000', 0.62); b.fill(steppedPath(x, y + (o.down ? 1 : 3), w, h, P));
    b.fillStyle = o.hover ? mixHex(fill, '#ffffff', 0.3) : fill; b.fill(steppedPath(x, y, w, h, P));
    b.fillStyle = 'rgba(255,255,255,0.55)'; b.fillRect(x + P, y + 1, w - 2 * P, 1.5); b.fillStyle = 'rgba(3,39,34,0.25)'; b.fillRect(x + P, y + h - 2.5, w - 2 * P, 1.5);
    typed(b, str, cx, cy, CHIP(k), INKDARK, type, { anchor: 'middle', baseline: 'middle', land: false });
    b.restore();
  }
  // What's on screen (from the sidecar: controls read this request), so names avoid covering words.
  let busyRects = [];
  const pillsNow = () => marks.filter((m) => m.alive && m.pill).map((m) => [m.pill[0] + m.dx, m.pill[1] + m.dy, m.pill[2], m.pill[3]]);
  // Things this beat is about to mark count as marked already, so a name never lands on the next thing to be circled.
  let upcoming = [];
  const markedNow = () => [...marks.filter((m) => m.alive && m.marked).map((m) => [m.marked[0] + m.dx, m.marked[1] + m.dy, m.marked[2], m.marked[3]]), ...upcoming];
  const scr = () => { const S = R.safe ?? {}; return [(S.left ?? 0) + 4, (S.top ?? 0) + 4, W - (S.right ?? 0) - 4, H - (S.bottom ?? 0) - 4]; };
  // Pen lines (arrows, underlines, rings) already on screen, as their points: a name keeps off the line itself.
  const inkNow = () => marks.filter((m) => m.alive && m.pts && m.p > 0).map((m) => ({ pts: m.pts, dx: m.dx, dy: m.dy }));
  const crossesInk = (r, ink) => ink.some((q) => q.pts.some(([px, py], i) => {
    if (inside(r, px + q.dx, py + q.dy)) return true;
    const n = q.pts[i + 1]; return !!n && inside(r, (px + n[0]) / 2 + q.dx, (py + n[1]) / 2 + q.dy);
  }));
  // Beside the marked box on the spot covering the least text and no other name, mark or pen line: above, below,
  // right, left, then the same a little further out.
  function nameSpot(box, str, size) {
    const [w, h] = size ?? pillSize(str), [x, y, bw, bh] = box, g = 6, far = 3 * g + h, S = scr(), pills = pillsNow(), marked = markedNow(), ink = inkNow();
    const spots = [[x, y - h - g], [x, y + bh + g], [x + bw + g, y + bh / 2 - h / 2], [x - w - g, y + bh / 2 - h / 2], [x + bw - w, y - h - g], [x + bw - w, y + bh + g],
      [x + bw + g, y - h - g], [x + bw + g, y + bh + g], [x - w - g, y - h - g], [x - w - g, y + bh + g], [x, y - h - far], [x, y + bh + far]];
    let best = null, bestCost = Infinity;
    spots.forEach((s, k) => {
      const r = [s[0], s[1], w, h];
      if (r[0] < S[0] || r[1] < S[1] || r[0] + w > S[2] || r[1] + h > S[3]) return;
      if (pills.some((q) => overlap(grow(r, 3), q) > 0) || marked.some((q) => overlap(r, q) > 0)) return;
      const cost = busyRects.reduce((a, q) => a + overlap(grow(r, 2), q), 0) / (w * h) + k * 0.01 + (k >= 10 ? 0.05 : 0) + (crossesInk(grow(r, 4), ink) ? 2 : 0);
      if (cost < bestCost) { best = r; bestCost = cost; }
    });
    return best || [clamp(x, S[0], S[2] - w), clamp(y - h - g, S[1], S[3] - h), w, h];
  }
  function pillMark(part, r, str, screen = true) {
    return add({ z: 6, part, screen, kind: 'pill', pill: r, box: r, draw(b, l, t) { chip(b, r[0], r[1], r[2], r[3], str, t - this.born, { color: this.color === ACC ? ACC : this.color }); } });
  }
  async function name(part, box, str, screen = true) {
    if (!str) return null;
    const r = nameSpot(box, str), [tx, ty] = tipNow();
    if (Math.hypot(r[0] + r[2] - 8 - tx, r[1] + r[3] - 4 - ty) > 140) await fly(r[0] + r[2] - 8, r[1] + r[3] - 4);
    sfx('pop');
    return pillMark(part, r, str, screen);
  }
  // A small report in our chrome near the cursor: copied, opening, handed off.
  function toast(str, sub, o = {}) {
    const [x, y] = tipNow(), w = Math.min(420, Math.max(textW(str, `600 11px ${MONO}`), sub ? textW(sub, `400 11px ${MONO}`) : 0) + 50), h = sub ? 46 : 28;
    // Clear of the cursor, and stacked under any toast still showing (several actions in one beat).
    const S = scr(), live = marks.filter((m) => m.alive && m.kind === 'toast' && !m.leave);
    const below = live.reduce((yy, m) => Math.max(yy, m.box[1] + m.box[3] - 20 + 6), y + 30);
    const bx = clamp(x + 34, S[0] + 4, S[2] - w - 4), by = clamp(below, S[1] + 4, S[3] - h - 4);
    const subText = sub ? ellipsize(String(sub).replace(/\s+/g, ' '), w - 44, `400 11px ${MONO}`) : '';
    return add({ z: 8, p: 1, kind: 'toast', box: [bx - 4, by - 4, w + 8, h + 20], live: () => true, draw(b, l, t) {
      const u = clamp((t - this.born) / 0.25, 0, 1), out = this.leave ? clamp((t - this.leave) / 0.3, 0, 1) : 0;
      b.save(); b.globalAlpha *= 1 - out; b.translate(0, (1 - back(u)) * 10);
      chrome(b, bx, by, w, h);
      const cx = bx + 16, cy = by + 14;
      if (o.spin) for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2, on = (Math.floor(t * 10) - k + 8) % 8 < 3; b.fillStyle = on ? ACC : DEEP; b.fillRect(Math.round(cx + Math.cos(a) * 6) - 1.5, Math.round(cy + Math.sin(a) * 6) - 1.5, 3, 3); }
      else { b.fillStyle = ACC; [[-5, 0], [-2, 3], [1, 0], [4, -3], [7, -6]].forEach(([dx, dy]) => b.fillRect(cx + dx - 1.5, cy + dy - 1.5, 3, 3)); }
      typed(b, ellipsize(str, w - 44, `600 11px ${MONO}`), bx + 32, by + 18, `600 11px ${MONO}`, TEXT, (t - this.born) / 0.4);
      if (subText) typed(b, subText, bx + 32, by + 36, `400 11px ${MONO}`, DIM, (t - this.born - 0.2) / 0.6);
      b.restore();
      if (out >= 1) this.alive = false;
    } });
  }
  const leaveAfter = async (m, ms) => { await sleep(ms); m.leave = now(); touch(0.5); };

  // ---------------------------------------------------------------- screen marks
  const strokeMark = (part, pts, color = ACC, extra = {}) => add({ z: 3, part, screen: true, pts, color, ...extra, draw(b, l, t) { pen(b, l, this, this.pts, this.p, this.color, { w: this.w }); this.more?.(b, l, t); } });
  const drawStroke = (m, dur) => trace(m.pts, dur ?? penDur(m.pts), (e) => (m.p = e));
  const rectOf = (m) => locRect(m.at?.rect);
  const pathPts = (m) => (m.points?.length >= 2 ? m.points.map(([x, y]) => loc(x, y)) : (() => { const [x, y, w, h] = rectOf(m); return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]; })());
  // The last mark the user is asked to click or hover, parked on by the cursor.
  const SCREEN_MARKS = {
    async point(m) {
      const [x0, y0, w0, h0] = rectOf(m), x = x0 + w0 / 2, y = y0 + h0 / 2, r = rnd(12, 15);
      const s = strokeMark(m.part, loop(x - r, y - r, 2 * r, 2 * r, { pad: 0, r, over: rnd(0.12, 0.2) }), tone(m.tone), { marked: [x - r - 3, y - r - 3, 2 * r + 6, 2 * r + 6], more(b, l) { if (this.p > 0.98) { l.fillStyle = colorOf(this, this.color); l.beginPath(); l.arc(x, y, 3.2, 0, Math.PI * 2); l.fill(); } } });
      await drawStroke(s, 0.55); await name(m.part, s.marked, m.label); await rest(x + r, y + r);
    },
    target: (m) => pointer(m, false),
    hover: (m) => pointer(m, true),
    async ring(m) {
      const [x, y, w, h] = rectOf(m), s = strokeMark(m.part, loop(x, y, w, h, { r: m.at.r }), tone(m.tone));
      s.marked = boxOf(s.pts);
      await drawStroke(s); await name(m.part, s.marked, m.label); await rest(x + w, y + h);
    },
    async frame(m) {
      // An area: one pen line round it, closing on itself, then a faint tint.
      const [x, y, w, h] = rectOf(m), pts = loop(x, y, w, h, { pad: 4, r: Math.min(12, m.at.r ?? shapeRadius(w, h)), over: rnd(0.02, 0.05) });
      const s = strokeMark(m.part, pts, tone(m.tone), { z: 1, fa: 0, marked: [x - 4, y - 4, w + 8, h + 8] });
      s.draw = function (b, l) { if (this.fa) { const path = new Path2D(); pts.forEach((q, i) => (i ? path.lineTo(q[0], q[1]) : path.moveTo(q[0], q[1]))); b.fillStyle = rgba(colorOf(this, this.color), 0.11 * this.fa); b.fill(path); } pen(b, l, this, pts, this.p, this.color); };
      await drawStroke(s); sfx('scan'); await tween(0.2, (u) => (s.fa = u)); await name(m.part, s.marked, m.label);
    },
    async underline(m) { const [x, y, w, h] = rectOf(m), s = strokeMark(m.part, handLine([x - 2, y + h + 3], [x + w + 2, y + h + 3 + rnd(-1.5, 1.5)], { bow: rnd(0.01, 0.035) }), tone(m.tone), { w: 3.2 }); await drawStroke(s); await name(m.part, [x, y, w, h + 4], m.label); await rest(x + w, y + h); },
    async strike(m) { const [x, y, w, h] = rectOf(m), s = strokeMark(m.part, handLine([x - 3, y + h / 2 + rnd(-1, 1)], [x + w + 3, y + h / 2 + rnd(-1.5, 1)]), tone(m.tone || 'coral'), { w: 3 }); await drawStroke(s); await name(m.part, [x, y, w, h], m.label); await rest(x + w, y + h / 2); },
    check: (m) => { const [x, y] = glyphSpot(m); return glyph(m, [handLine([x - 9, y - 1], [x - 2, y + 7], { jitter: 1 }), handLine([x - 2, y + 7], [x + 11, y - 9], { jitter: 1, bow: 0.04 })], tone(m.tone || 'lime')); },
    cross: (m) => { const [x, y] = glyphSpot(m); return glyph(m, [handLine([x - 8, y - 8], [x + 8, y + 8], { jitter: 1 }), handLine([x + 8, y - 8], [x - 8, y + 8], { jitter: 1 })], tone(m.tone || 'coral')); },
    async connect(m) {
      const A = rectOf(m), B = locRect(m.to.rect), ca = [B[0] + B[2] / 2, B[1] + B[3] / 2], cb = [A[0] + A[2] / 2, A[1] + A[3] / 2];
      await arrow(m.part, edgeToward(A, ca), edgeToward(B, cb, 8), { tone: m.tone, flow: !!m.flow });
      await name(m.part, B, m.label);
    },
    async trace(m) {
      const p0 = pathPts(m), base = catmull(p0, true), pts = handPath(base, 1.4), tail = handPath(base.slice(0, 12), 1).map((q) => [q[0] + rnd(1, 3), q[1] - rnd(1, 3)]), all = [...pts, ...tail];
      const s = strokeMark(m.part, all, tone(m.tone), { z: 1, fa: 0, marked: boxOf(pts) });
      s.draw = function (b, l) { if (this.fa) { const path = new Path2D(); pts.forEach((q, i) => (i ? path.lineTo(q[0], q[1]) : path.moveTo(q[0], q[1]))); b.fillStyle = rgba(colorOf(this, this.color), 0.11 * this.fa); b.fill(path); } pen(b, l, this, all, this.p, this.color); };
      await drawStroke(s); await tween(0.35, (u) => (s.fa = u)); await name(m.part, s.marked, m.label);
    },
    async num(m, ctx) {
      const [x0, y0] = rectOf(m), x = x0 - 2, y = y0 - 2, n = m.n ?? ++ctx.num;
      await tap(x, y); sfx('blip');
      add({ z: 6, part: m.part, screen: true, p: 1, marked: [x - 12, y - 12, 24, 24], box: [x - 12, y - 14, 26, 28], draw(b, l, t) { chip(b, x - 11, y - 11, 22, 22, String(n), t - this.born, { color: this.color }); } });
      await rest(x, y);
    },
    async label(m) { const box = rectOf(m), str = m.text || m.label, r = nameSpot(box, str); await fly(r[0] + r[2] - 8, r[1] + 19); sfx('pop'); pillMark(m.part, r, str); },
    async write(m) {
      const [x0, y0, w0, h0] = rectOf(m), str = m.text || m.label, S0 = scr(), size = clamp(Math.min(m.size ?? 30, ((S0[2] - S0[0] - 40) / Math.max(1, textW(str, `800 30px ${DOTO}`))) * 30), 12, 64), font = `800 ${size}px ${DOTO}`, w = textW(str, font);
      const x = clamp(x0, scr()[0], scr()[2] - w), y = y0 + h0 + size * 1.05;
      const s = add({ z: 4, part: m.part, screen: true, color: tone(m.tone), box: [x - 4, y - size, w + 8, size * 1.4], marked: [x, y - size, w, size * 1.2], draw(b) { typed(b, str, x, y, font, colorOf(this, this.color), this.p, { rim: 5 }); } });
      await trace(handLine([x, y - size * 0.3], [x + w, y - size * 0.3], { jitter: 1 }), 0.4 + str.length * 0.06, (e) => (s.p = e)); await rest(x + w, y);
    },
    async scroll(m) {
      const [x0, y0, w0, h0] = rectOf(m), x = x0 + w0 / 2, y = y0 + h0 / 2, sgn = m.dir === 'up' ? -1 : 1;
      const cs = [0, 1].map((k) => { const yy = y + k * 13 * sgn; return handLine([x - 11, yy - 6 * sgn], [x, yy + 5 * sgn], { jitter: 0.6 }).concat(handLine([x, yy + 5 * sgn], [x + 11, yy - 6 * sgn], { jitter: 0.6 })); });
      const s = add({ z: 4, part: m.part, screen: true, p: 0, p2: 0, color: tone(m.tone), box: [x - 20, y - 30, 40, 70], marked: [x - 14, y - 14, 28, 44], live: () => true, draw(b, l, t) { const bob = this.p2 >= 1 && !reduced() ? Math.sin(t * 4) * 3 * sgn : 0; l.save(); b.save(); l.translate(0, bob); b.translate(0, bob); pen(b, l, this, cs[0], this.p, this.color, { key: 'a' }); pen(b, l, this, cs[1], this.p2, this.color, { key: 'b' }); l.restore(); b.restore(); } });
      await trace(cs[0], 0.3, (e) => (s.p = e)); await trace(cs[1], 0.3, (e) => (s.p2 = e));
      await name(m.part, s.marked, m.label);
    },
    async spotlight(m) {
      const [x, y, w, h] = rectOf(m), p = 8, g = (v) => Math.round(v / P) * P, hole = [g(x - p), g(y - p), g(w + 2 * p), g(h + 2 * p)];
      add({ z: 0, part: m.part, screen: true, p: 1, box: () => [0, 0, W, H], draw(b, l, t) {
        const u = clamp((t - this.born) / 0.5, 0, 1), BAND = 6, e = BAND * P;
        b.fillStyle = `rgba(3,14,16,${0.62 * u})`;
        const outer = new Path2D(); outer.rect(0, 0, W, H); outer.rect(hole[0] - e, hole[1] - e, hole[2] + 2 * e, hole[3] + 2 * e); b.fill(outer, 'evenodd');
        // a dithered falloff round the opening (our pixels) instead of a blur
        for (let gy = Math.floor((hole[1] - e) / P); gy < (hole[1] + hole[3] + e) / P; gy++) for (let gx = Math.floor((hole[0] - e) / P); gx < (hole[0] + hole[2] + e) / P; gx++) {
          const cx = gx * P + 2, cy = gy * P + 2, dx = Math.max(hole[0] - cx, 0, cx - hole[0] - hole[2]), dy = Math.max(hole[1] - cy, 0, cy - hole[1] - hole[3]), d = Math.hypot(dx, dy) / P;
          if (d === 0) continue;
          if (d < BAND && (d / BAND) * 16 * u < B4[(((gy % 4) + 4) % 4) * 4 + (((gx % 4) + 4) % 4)] + 0.5) continue;
          b.fillRect(gx * P, gy * P, P, P);
        }
      } });
      sfx('focus'); await fly(x + w * 0.85, y + h + 10); await name(m.part, [x, y, w, h], m.label);
    },
    async highlight(m) {
      const [x, y, w, h] = rectOf(m), band = handLine([x, y + h / 2], [x + w, y + h / 2 + rnd(-1.5, 1.5)], { jitter: 1 });
      const s = add({ z: 0, part: m.part, screen: true, color: tone(m.tone || 'amber'), box: [x - 6, y - 6, w + 12, h + 12], draw(b) { const k = Math.max(2, Math.round(band.length * this.p)); b.save(); b.lineCap = 'butt'; b.lineJoin = 'round'; b.lineWidth = h; b.strokeStyle = rgba(colorOf(this, this.color), 0.4); b.beginPath(); band.slice(0, k).forEach((q, i) => (i ? b.lineTo(q[0], q[1]) : b.moveTo(q[0], q[1]))); b.stroke(); b.restore(); } });
      await trace(band, 0.5, (e) => (s.p = e)); await name(m.part, [x, y, w, h], m.label);
    },
    line: (m) => free(m, handPath(pathPts(m))),
    curve: (m) => free(m, handPath(catmull(pathPts(m), false), 1)),
    async arrow(m) { const p = pathPts(m); await arrow(m.part, p[0], p[p.length - 1], { bend: 0.03, tone: m.tone, via: p.length > 2 ? p : null, flow: !!m.flow }); },
    circle: (m) => { const [x, y, w, h] = rectOf(m), r = Math.max(w, h) / 2; return free(m, loop(x + w / 2 - r, y + h / 2 - r, 2 * r, 2 * r, { pad: 4, r })); },
    rect: (m) => { const [x, y, w, h] = rectOf(m); return free(m, loop(x, y, w, h, { pad: 4, r: 6, over: rnd(0.03, 0.08) })); },
  };
  // Click here (target) or hover here: a loop round the control that breathes while it waits, with the cursor parked
  // on it, tapping (click) or circling slowly (hover).
  async function pointer(m, hov) {
    const [x, y, w, h] = rectOf(m), pts = loop(x, y, w, h, { r: m.at.r, pad: 5 });
    const s = add({ z: 3, part: m.part, screen: true, pts, color: tone(m.tone), marked: boxOf(pts), waiting: false, live() { return this.waiting; }, draw(b, l, t) {
      if (this.p >= 1 && this.waiting && !hov && !reduced()) {
        const u = 0.5 + 0.5 * Math.sin(t * 4), path = new Path2D(); pts.forEach((q, i) => (i ? path.lineTo(q[0], q[1]) : path.moveTo(q[0], q[1])));
        b.fillStyle = rgba(colorOf(this, this.color), 0.06 + 0.07 * u); b.fill(path); l.save(); l.globalAlpha *= 0.85 + 0.15 * u; pen(b, l, this, pts, 1, this.color); l.restore(); return;
      }
      pen(b, l, this, pts, this.p, this.color, { w: hov ? 2.8 : 3.6 });
    } });
    await drawStroke(s); await name(m.part, s.marked, m.label);
    const px = x + Math.min(w * 0.72, w - 10), py = y + h * 0.68;
    await fly(px, py);
    s.parkAt = [px, py, hov ? 'circle' : 'tap'];
    return s;
  }
  // A tick or cross goes beside the thing on the spot covering the least (right, left, above…), its centre returned.
  function glyphSpot(m) { const r = nameSpot(rectOf(m), '', [26, 24]); return [r[0] + 13, r[1] + 12]; }
  function glyph(m, strokes, color) {
    const all = strokes.flat(), s = add({ z: 3, part: m.part, screen: true, pts: all, color, ps: strokes.map(() => 0), marked: boxOf(all), draw(b, l) { strokes.forEach((q, i) => pen(b, l, this, q, this.ps[i], this.color, { key: 's' + i, w: 3.4 })); } });
    return (async () => { for (const [i, q] of strokes.entries()) await trace(q, 0.22, (e) => (s.ps[i] = e)); sfx('tick'); await name(m.part, s.marked, m.label); await rest(...all[all.length - 1]); })();
  }
  async function free(m, pts) { const s = strokeMark(m.part, pts, tone(m.tone)); s.marked = boxOf(pts); await drawStroke(s); await name(m.part, s.marked, m.label); }
  // A curved arrow, the head drawn as two quick strokes after the line.
  async function arrow(part, a, b, o = {}) {
    let curve;
    if (o.via) curve = handPath(catmull(o.via, false), 0.8);
    else {
      const bend = (o.bend ?? 0.25) + rnd(-0.04, 0.04), mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, c = [mx - (b[1] - a[1]) * bend, my + (b[0] - a[0]) * bend];
      curve = handPath(Array.from({ length: 41 }, (_, k) => { const t = k / 40; return [(1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0], (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1]]; }), 0.8);
    }
    const end = curve[curve.length - 1], prev = curve[Math.max(0, curve.length - 8)], ang = Math.atan2(end[1] - prev[1], end[0] - prev[0]), hl = rnd(11, 15), sp = rnd(2.5, 2.8);
    const head = handLine([end[0] + Math.cos(ang + sp) * hl, end[1] + Math.sin(ang + sp) * hl], end, { jitter: 0.5 }).concat(handLine(end, [end[0] + Math.cos(ang - sp) * hl, end[1] + Math.sin(ang - sp) * hl], { jitter: 0.5 }));
    // flow: bright squares run along it once it's drawn, like a flow diagram's moving links (still, with reduced motion).
    const L = o.flow ? len(curve) : 0;
    const s = strokeMark(part, curve, tone(o.tone), { screen: o.screen ?? true, hp: 0, box: () => boxOf([...curve, ...head]), live: o.flow ? () => !reduced() && s.hp >= 1 : undefined,
      more(bb, l, t) {
        if (this.hp) pen(bb, l, this, head, this.hp, this.color, { key: 'h' });
        if (o.flow && this.hp >= 1) { const gap = L / Math.max(1, Math.round(L / 46)), d0 = reduced() ? gap / 2 : (t * 60) % gap; l.fillStyle = HOT; for (let d = d0; d < L; d += gap) { const [px, py] = at(curve, d / L); l.fillRect(Math.round(px) - 2, Math.round(py) - 2, 4, 4); } }
      } });
    await drawStroke(s); await trace(head, 0.22, (e) => (s.hp = e)); await rest(end[0], end[1]);
    return s;
  }

  // ---------------------------------------------------------------- actions in the real app
  const ACTIONS_DRAW = {
    async type(m) {
      // The sidecar has already typed it into the field (act_in_app's path); this shows where and what.
      const [x, y, w, h] = rectOf(m); await tap(x + Math.min(w * 0.3, 40), y + h / 2); sfx('focus');
      const str = String(m.text), font = `400 12px ${MONO}`, n0 = now();
      for (let i = 0; i < Math.min(str.length, 24); i++) { sfx('key'); await sleep(35 + Math.random() * 35); }
      add({ z: 4, part: m.part, screen: true, p: 1, box: [x - 4, y - 30, w + 8, h + 34], live: (t) => t - n0 < 3, draw(b, l, t) {
        const age = t - n0; if (age > 3.2) return;
        if (Math.floor(age * 2) % 2 === 0) { l.fillStyle = this.color; l.fillRect(x + 8, y + 5, 2, h - 10); }
        const shown = ellipsize(`typed: ${str.replace(/\s+/g, ' ')}`, 360, font), tw = textW(shown, font) + 16;
        b.globalAlpha *= clamp(1 - (age - 2.6) / 0.6, 0, 1); chrome(b, x, y - 28, tw, 22, { corner: P }); typed(b, shown, x + 8, y - 13, font, TEXT, age / 0.5);
      } });
      await rest(x + w, y + h);
    },
    async copy(m) { sfx('tick'); leaveAfter(toast('Copied to your clipboard', m.text), 1800); },
    async open(m) { let h = m.url; try { h = new URL(m.url).hostname.replace(/^www\./, ''); } catch {} sfx('whoosh'); leaveAfter(toast(`Opening ${h}`, m.url, { spin: true }), 1800); },
    async handoff(m) { sfx('toolstart'); leaveAfter(toast('Handed off', m.task || m.text || m.label || '', { spin: true }), 2200); },
    async button(m) {
      const k = 1.15, w = Math.round(textW(m.text, CHIP(k)) + 34), h = 32;
      const r = m.at ? nameSpot(rectOf(m), m.text, [w, h]) : place(w, h, m.part);
      await tap(r[0] + w - 14, r[1] + h - 8); sfx('pop');
      add({ z: 6, part: m.part, screen: !!m.at, kind: 'button', pill: r, box: [r[0] - 2, r[1] - 4, w + 4, h + 10], hover: false, down: 0, draw(b, l, t) { chip(b, r[0], r[1], w, h, m.text, t - this.born, { k, color: this.color, hover: this.hover, down: now() - this.down < 0.15 }); },
        hits() { return [{ rect: [r[0], r[1], w, h], kind: 'button', part: m.part }]; } });
    },
    async emote(m) {
      const [x, y] = tipNow(); agent()?.act?.(m.name);
      for (let k = 0; k < 9; k++) { const a = (k / 9) * Math.PI * 2 + rnd(-0.2, 0.2), r0 = rnd(30, 40), ln = rnd(10, 16), col = k % 3 ? ACC : tone('amber'); add({ z: 9, p: 1, box: [x - 90, y - 90, 180, 180], live: () => true, draw(b, l, t) { const u = (t - this.born) / 0.8; if (u > 1) { this.alive = false; return; } const r = r0 + u * 22; l.save(); l.globalAlpha *= 1 - u; l.strokeStyle = col; l.lineWidth = 3; l.lineCap = 'round'; l.beginPath(); l.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r); l.lineTo(x + Math.cos(a) * (r + ln), y + Math.sin(a) * (r + ln)); l.stroke(); l.restore(); } }); }
      sfx(m.name === 'hype' ? 'hype' : 'pop'); await sleep(900);
    },
    async sfx(m) { sfx(m.name); },
  };

  // ---------------------------------------------------------------- cards and diagrams on calm space
  // Beside the front window (sent as global bounds), else on the screen, filling from the left: the first card goes in the
  // leftmost free column and each next one just right of those already up (top to bottom in each column, columns left
  // to right); never on another card or a screen mark.
  let winRect = null;
  function place(w, h, part, strict = false) {
    // Game mode (sidebar.js): cards stack in the panel at the screen's right edge, below the Roamie.
    const side = R.sidebar?.on ? R.sidebar : null;
    const S = scr(), top = S[1] + (side ? side.top : 12), bot = S[3] - 64; // room for the caption
    // Cards keep a small gap from each other (their boxes already include the shadow), marks a bigger one. A card
    // that's fading out is no longer in the way.
    const panel = R.panel?.rect, up = marks.filter((m) => m.alive && m.card && !m.leaving);
    const taken = [...up.map((m) => grow(markBox(m), 6)), ...markedNow().map((r) => grow(r, 10)), ...pillsNow(), ...(panel ? [grow(panel, 6)] : [])];
    const roomL = !!winRect && winRect[0] - S[0] >= w + 28, roomR = !!winRect && S[2] - (winRect[0] + winRect[2]) >= w + 28;
    // A window that fills the screen leaves no room beside it: then cards go over it like on an empty screen.
    const overWin = !winRect || (!roomL && !roomR);
    const fits = (x) => x >= S[0] + 8 && x + w <= S[2] - 8 && (overWin || x >= winRect[0] + winRect[2] || x + w <= winRect[0]);
    const xs = [];
    if (side) { const x = S[2] - Math.max(w, side.width - 32) / 2 - w / 2 - 16; for (let y = top; y + h <= bot; y += 12) { const r = [x, y, w, h]; if (!taken.some((q) => overlap(r, q) > 0)) return r; } if (!strict) return [x, top, w, h]; }
    if (roomL || overWin) xs.push(S[0] + 16);
    for (const b of up.map(markBox).sort((a, q) => a[0] - q[0])) { const x = b[0] + b[2] + 8; if (fits(x)) xs.push(x); }
    if (roomR) xs.push(winRect[0] + winRect[2] + 20);
    xs.push(S[0] + 16, S[2] - w - 16);
    for (const x of xs) for (let y = top; y + h <= bot; y += 12) { const r = [x, y, w, h]; if (!taken.some((q) => overlap(r, q) > 0)) return r; }
    // Too tall to fit between the top and the caption: the first column where it covers nothing else, from the top.
    for (const x of xs) { const r = [x, top, w, h]; if (!taken.some((q) => overlap(r, q) > 0)) return r; }
    // Nowhere free. strict: the caller makes room first (roomFor); else top left, over what's there.
    return strict ? null : [S[0] + 16, top, w, h];
  }
  // Where a new card goes. Only a few cards stay up at once and none sits on another: the oldest close to make way
  // (the sidecar hears each one). Regression: eight cards at once left no room, and the last was drawn over the first.
  // A drawing that goes by itself (the tour, the setup showcase) keeps all of its cards.
  const MAX_CARDS = 4;
  function roomFor(w, h, part) {
    const old = () => [...new Set(marks.filter((q) => q.alive && q.card && !q.local && !q.pinned && !q.leaving && q.part !== part && !drawnBy.has(q.part)).sort((a, b) => a.born - b.born).map((q) => q.part))];
    const shut = (id) => { R.ink.send?.({ type: 'ink_closed', part: id }); fadeOut(partMarks(id), 0.25); };
    if (!drawnBy.has(part)) for (const id of old().slice(0, -(MAX_CARDS - 1))) shut(id);
    for (;;) {
      const r = place(w, h, part, true), id = r ? null : old()[0];
      if (r || id == null) return r ?? place(w, h, part);
      shut(id);
    }
  }
  // A card opening: the cursor drags its corner out. Returns the card mark; draw(b, l, t, x, y) paints its insides.
  // Taller than the screen allows: it opens at the tallest it may be and its insides scroll (wheel or trackpad), so
  // nothing in it is ever cut off.
  // The pin button in a card's title bar, centred on (px, py): drawn like the full-screen and close buttons; pinned, it
  // sits on a lit tile (the filled-button look), so the state shows by shape as well as colour.
  function pinIcon(b, px, py, m) {
    if (m.pinned) { b.fillStyle = m.hoverPin ? HOT : ACC; b.fillRect(px - 10, py - 9, 20, 18); }
    b.fillStyle = m.pinned ? INKDARK : m.hoverPin ? HOT : DIM;
    b.fillRect(px - 4, py - 6, 8, 2); b.fillRect(px - 2, py - 4, 4, 4); b.fillRect(px - 5, py, 10, 2); b.fillRect(px - 1, py + 2, 2, 4);
  }
  async function card(m, w, h, inner, o = {}) {
    const full = h;
    h = Math.min(full, maxCardH());
    // Deep explain: one big card at a time, zoomed to cover most of the screen and centred above the caption; the
    // card before it goes as it comes. Otherwise the size the assistant chose (draw's card_size): small or large opens
    // zoomed (never past the screen), placed for that size; full opens, then goes full screen.
    const deep = deepParts.has(m.part);
    let k = 1, x, y;
    if (deep) {
      const before = [...new Set(marks.filter((q) => q.alive && q.card && !q.local && !q.leaving && q.part !== m.part).map((q) => q.part))];
      for (const id of before) { R.ink.send?.({ type: 'ink_closed', part: id }); fadeOut(partMarks(id), 0.35); }
      const S = scr(), SW = S[2] - S[0], SH = S[3] - S[1] - 80;
      k = Math.max(1, Math.min((SW * 0.86) / w, (SH * 0.94) / h, 2.6));
      x = S[0] + (SW - w * k) / 2; y = S[1] + Math.max(8, (SH - h * k) / 2);
    } else {
      const S0 = scr(), fit = Math.max(1, Math.min((S0[2] - S0[0] - 32) / (w + 8), (S0[3] - S0[1] - 100) / (h + 14)));
      k = Math.min(m.card_size === 'small' ? 0.8 : m.card_size === 'large' ? 1.5 : 1, fit);
      [x, y] = roomFor(Math.round(w * k), Math.round(h * k), m.part);
    }
    const bar = o.bar === false ? 0 : 26;
    const c = add({ z: 2, part: m.part, card: true, kind: m.kind, cw: 0, ch: 0, p: 0, done: 0, w, h, ox: x, oy: y, k, deep, sy: 0, scrollMax: Math.max(0, full - h), color: tone(m.tone), live: o.live, box: () => [x - 4, y - 4, w + 8, h + 14],
      draw(b, l, t) {
        if (this.cw < 4) return;
        chrome(b, x, y, this.cw, this.ch, { edge: o.edge ? colorOf(this, this.color) : ACC });
        if (this.p < 1) return;
        if (bar) {
          b.fillStyle = 'rgba(120,255,226,0.06)'; b.fillRect(x + 2, y + 2, w - 4, bar - 2);
          b.fillStyle = DEEP; b.fillRect(x + 2, y + bar, w - 4, 1);
          [0, 1].forEach((k) => { b.fillStyle = k ? DEEP : ACC; b.fillRect(x + 12 + k * 12, y + 11, 5, 5); });
          if (o.title) typed(b, ellipsize(String(o.title).toLowerCase(), w - 206, `500 10px ${MONO}`), x + w / 2, y + 17, `500 10px ${MONO}`, DIM, (t - this.done) / 0.4, { anchor: 'middle' });
          // pin: a pixel pushpin with the full-screen and close buttons, drawn like them; pinned, it sits on a lit tile
          // (the filled-button look), so the state shows by shape as well as colour. The card stays until its ×.
          pinIcon(b, x + w - 70, y + 13, this);
          // save as image: a pixel arrow down into a tray, left of the pin
          { const sx = x + w - 95, sy = y + 13; b.fillStyle = this.hoverSave ? HOT : this.saved && now() - this.saved < 1.2 ? ACC : DIM;
            b.fillRect(sx - 1, sy - 6, 2, 7); b.fillRect(sx - 3, sy - 1, 6, 2); b.fillRect(sx - 2, sy + 1, 4, 1); b.fillRect(sx - 5, sy + 3, 10, 2); b.fillRect(sx - 5, sy + 1, 2, 2); b.fillRect(sx + 3, sy + 1, 2, 2); }
          // full screen: four pixel corners (pointing in once it's full)
          { const fx = x + w - 44, fy = y + 13, s = 4, f = this.full ? -1 : 1;
            b.fillStyle = this.hoverFull ? HOT : DIM;
            for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
              const cx = fx + sx * s, cy = fy + sy * s;
              b.fillRect(cx - (sx * f < 0 ? 0 : 2), cy - 1, 3, 2); b.fillRect(cx - 1, cy - (sy * f < 0 ? 0 : 2), 2, 3);
            } }
          // close: a small pixel ×
          const cx = x + w - 18, cy = y + 13, hot = this.hoverClose;
          b.fillStyle = hot ? HOT : DIM; for (let k = -3; k <= 3; k++) { b.fillRect(cx + k - 1, cy + k - 1, 2, 2); b.fillRect(cx + k - 1, cy - k - 1, 2, 2); }
        }
        // A last guard: nothing inside a card is drawn outside it.
        for (const c of [b, l]) { c.save(); c.beginPath(); c.rect(x + 2, y + bar + 1, w - 4, h - bar - 3); c.clip(); }
        try { inner.call(this, b, l, t, x, y + bar - this.sy, t - this.done); } finally { b.restore(); l.restore(); }
        if (this.scrollMax > 0) {
          const top = y + bar + 6, len = h - bar - 12, th = Math.max(18, (len * h) / full), ty = top + (len - th) * (this.sy / this.scrollMax);
          b.fillStyle = rgba(ACC, 0.15); b.fillRect(x + w - 7, top, 2, len);
          b.fillStyle = ACC; b.fillRect(x + w - 7, ty, 2, th);
        }
        // resize grip: three pixel steps in the bottom right corner
        if (this.p >= 1 && !this.full) { b.fillStyle = this.hoverGrip ? HOT : rgba(ACC, 0.45); for (let k = 0; k < 3; k++) for (let j = 0; j <= k; j++) b.fillRect(x + w - 6 - j * 4, y + h - 14 + k * 4, 2, 2); }
      },
      hits() {
        const out = bar ? [{ rect: [x + w - 28, y + 2, 26, 22], kind: 'close', part: m.part }, { rect: [x + w - 54, y + 2, 22, 22], kind: 'full', part: m.part }, { rect: [x + w - 82, y + 2, 24, 22], kind: 'pin', part: m.part }, { rect: [x + w - 106, y + 2, 22, 22], kind: 'save', part: m.part, title: o.title || m.kind }, { rect: [x, y, w - 108, bar], kind: 'drag', part: m.part }] : [{ rect: [x, y, w, Math.min(h, 24)], kind: 'drag', part: m.part }];
        if (!this.full) out.unshift({ rect: [x + w - 18, y + h - 18, 18, 18], kind: 'resize', part: m.part });
        // Links scrolled out of view can't be clicked.
        const more = (this.more?.() ?? []).filter((q) => q.rect[1] >= y + bar && q.rect[1] + q.rect[3] <= y + h);
        return [...more, ...out, { rect: [x, y, w, h], kind: 'card', part: m.part }];
      },
    });
    await fly(x, y); sfx('expand');
    await tween(0.45, (u) => { const e = ease(u); c.cw = w * e; c.ch = h * e; penApi()?.set?.(x + c.cw * k, y + c.ch * k); });
    c.p = 1; c.done = now(); touch(1.5); syncClearAll();
    if (m.card_size === 'full' && !c.full) await toggleFull(c);
    if (m.tie?.rect) { const T = locRect(m.tie.rect), C = [x, y, w, h], tc = [T[0] + T[2] / 2, T[1] + T[3] / 2]; await arrow(m.part, edgeToward(T, [x + w / 2, y + h / 2], 6), edgeToward(C, tc, 6), { bend: -0.2, screen: false }); }
    return c;
  }
  const BODY = `400 13px ${MONO}`, SMALL = `400 11px ${MONO}`;
  // The tallest a card may be: the screen less its margins and the caption.
  const maxCardH = () => Math.max(160, scr()[3] - scr()[1] - 100);
  // A row of sources: favicon (or a dot) and name, each opening its link.
  function sourcesRow(c, list, x, y, w, t) {
    let cx = x; const hits = [];
    c.font = `500 10px ${MONO}`; c.fillStyle = DIM; c.fillText('SOURCES', cx, y); cx += textW('SOURCES', c.font) + 12;
    for (const s of list) {
      const nw = textW(s.name, SMALL) + 26;
      if (cx + nw > x + w) break;
      if (s.img?.complete && s.img.naturalWidth) c.drawImage(s.img, cx, y - 10, 12, 12); else { c.fillStyle = MID; c.fillRect(cx + 3, y - 7, 6, 6); }
      typed(c, s.name, cx + 16, y, SMALL, DIM, t / 0.4);
      hits.push({ rect: [cx - 2, y - 13, nw, 18], kind: 'link', url: s.url });
      cx += nw;
    }
    return hits;
  }
  const loadIcons = (list) => (list ?? []).map((s) => { const o = { ...s }; if (s.icon) { o.img = new Image(); o.img.onload = () => touch(); o.img.src = s.icon; } return o; });
  const CARDS_DRAW = {
    async card(m) {
      const HEAD = `800 22px ${DOTO}`, srcs = loadIcons(m.sources);
      // Everything shown: laid out 340 wide, then 440 and 560 while it's taller than the screen allows; past that it scrolls.
      const lay = (w) => {
        const heads = m.heading ? wrapRows(m.heading, w - 40, HEAD) : [], head = heads.length ? heads.length * 26 + 14 : 0;
        const rows = m.text ? wrapRows(m.text, w - 40, BODY) : [], items = (m.items ?? []).map((it) => wrapRows(it, w - 64, BODY));
        const h = 26 + 18 + head + rows.length * 19 + (rows.length && items.length ? 10 : 0) + items.reduce((s2, r) => s2 + r.length * 19 + 6, 0) + (srcs.length ? 30 : 0) + 14;
        return { w, heads, head, rows, items, h };
      };
      let L = lay(340);
      for (const wide of [440, 560]) if (L.h > maxCardH()) L = lay(wide);
      const { w, heads, head, rows, items, h } = L, gap = rows.length && items.length ? 10 : 0;
      const ticks = items.map((_, i) => handLine([0, 0], [8, 0], { jitter: 0.3 }));
      let hits = [];
      const c = await card(m, w, h, function (b, l, t, x, y, age) {
        let yy = y + 18;
        heads.forEach((r, i) => typed(b, r, x + 20, yy + 18 + i * 26, HEAD, TEXT, (age - i * 0.3) / 0.6)); yy += head;
        wrapped(b, rows, x + 20, yy + 6, 19, BODY, TEXT, (age - 0.2) / (0.4 + rows.join(' ').length * 0.012)); yy += rows.length * 19 + gap;
        items.forEach((r, i) => { const a = age - 0.4 - i * 0.25; if (a <= 0) return; pen(b, l, this, ticks[i].map(([px, py]) => [px + x + 24, py + yy + 1]), clamp(a / 0.2, 0, 1), this.color, { key: 'k' + i, w: 2.6 }); wrapped(b, r, x + 40, yy + 6, 19, BODY, TEXT, a / 0.5); yy += r.length * 19 + 6; });
        if (srcs.length) hits = sourcesRow(b, srcs, x + 20, y + h - 26 - 18, w - 40, age - 0.6);
      }, { title: m.title || 'answer' });
      c.more = () => hits.map((q) => ({ ...q, part: m.part }));
    },
    async note(m) {
      // All of it; a long note goes wider rather than very tall.
      const narrow = wrapRows(m.text, 210 - 28, `500 13px ${MONO}`), w = narrow.length > 12 ? 320 : 210;
      const rows = w === 210 ? narrow : wrapRows(m.text, w - 28, `500 13px ${MONO}`), h = 40 + rows.length * 19;
      await card(m, w, h, function (b, l, t, x, y, age) { b.fillStyle = colorOf(this, this.color); b.fillRect(x + 8, y + 8, w - 16, 3); wrapped(b, rows, x + 14, y + 32, 19, `500 13px ${MONO}`, TEXT, age / (0.3 + m.text.length * 0.025)); }, { bar: false, edge: true });
      sfx('page');
    },
    // A mind map: the topic on the left, its branches beside it, each branch's points behind a +. A click on a branch
    // opens or closes its points (the map slides to make room); a click on the topic opens or closes them all. The
    // card is sized for everything open, so nothing moves out from under the pointer.
    async mindmap(m) {
      const ROOTF = `800 16px ${DOTO}`, RW = 150, BW = 160, LW = 180, GAP = 36, PX = 16;
      const rootRows = wrapRows(m.title || 'topic', RW - 20, ROOTF), rootH = rootRows.length * 20 + 18;
      const B = (m.branches ?? []).slice(0, 8).map((q) => {
        const rows = wrapRows(q.text, BW - 40, BODY), leaves = (q.items ?? []).slice(0, 6).map((it) => { const r = wrapRows(it, LW - 20, SMALL); return { rows: r, h: r.length * 14 + 12 }; });
        return { rows, h: rows.length * 17 + 14, leaves, tone: q.tone, op: 0, y: null, ly: leaves.map(() => null) };
      });
      const leafH = (q) => q.leaves.reduce((s, L) => s + L.h + 6, -6);
      const slot = (q, open) => Math.max(q.h, open && q.leaves.length ? leafH(q) : 0) + 12;
      const anyLeaves = B.some((q) => q.leaves.length);
      const w = PX * 2 + RW + GAP + BW + (anyLeaves ? GAP + LW : 0), CH = Math.max(rootH + 20, B.reduce((s, q) => s + slot(q, true), 0) + 16), h = 26 + CH;
      const open = new Set(), RX = PX, BX = PX + RW + GAP, LX = BX + BW + GAP;
      let hits = [], last = 0, moving = false;
      // Where everything should be for what's open now (y of each box's centre, from the content's top).
      const targets = () => {
        const total = B.reduce((s, q, i) => s + slot(q, open.has(i)), 0);
        let yy = (CH - total) / 2;
        return B.map((q, i) => {
          const sh = slot(q, open.has(i)), cy = yy + sh / 2;
          let ly = cy - leafH(q) / 2;
          const leaves = q.leaves.map((L) => { const c = open.has(i) ? ly + L.h / 2 : cy; ly += L.h + 6; return c; });
          yy += sh;
          return { cy, leaves };
        });
      };
      const curve = (b, x0, y0, x1, y1) => { const mx = (x0 + x1) / 2; b.beginPath(); b.moveTo(x0, y0); b.bezierCurveTo(mx, y0, mx, y1, x1, y1); b.stroke(); };
      const c = await card(m, w, h, function (b, l, t, x, y, age) {
        const dt = clamp(t - (last || t), 0, 0.1); last = t;
        const T = targets(), k = 1 - Math.exp(-dt * 12);
        moving = false;
        B.forEach((q, i) => {
          q.y = q.y == null ? T[i].cy : q.y + (T[i].cy - q.y) * k;
          q.op += ((open.has(i) ? 1 : 0) - q.op) * k;
          q.ly = q.ly.map((v, j) => (v == null ? T[i].leaves[j] : v + (T[i].leaves[j] - v) * k));
          if (Math.abs(q.y - T[i].cy) > 0.3 || Math.abs(q.op - (open.has(i) ? 1 : 0)) > 0.01) moving = true;
        });
        hits = [];
        const ry = y + CH / 2, grow = clamp(age / 0.5, 0, 1);
        // the topic
        const rpath = steppedPath(x + RX, ry - rootH / 2, RW, rootH, P);
        b.fillStyle = rgba(ACC, 0.08); b.fill(rpath); b.strokeStyle = this.hoverId === 'root' ? HOT : ACC; b.lineWidth = 2; b.stroke(rpath);
        rootRows.forEach((r, k2) => typed(b, r, x + RX + RW / 2, ry - rootH / 2 + 22 + k2 * 20, ROOTF, TEXT, age / 0.4, { anchor: 'middle' }));
        hits.push({ rect: [x + RX, ry - rootH / 2, RW, rootH], kind: 'pick', id: 'root' });
        B.forEach((q, i) => {
          const a = clamp((age - 0.25 - i * 0.12) / 0.35, 0, 1);
          if (a <= 0) return;
          const by = y + q.y, col = tone(q.tone) ?? this.color, hot = this.hoverId === `b${i}`;
          b.globalAlpha *= a; b.strokeStyle = rgba(col, 0.7); b.lineWidth = 2;
          curve(b, x + RX + RW, ry, x + BX, by);
          const bp = steppedPath(x + BX, by - q.h / 2, BW, q.h, P);
          b.fillStyle = rgba(col, hot ? 0.14 : 0.06); b.fill(bp); b.strokeStyle = hot ? HOT : col; b.stroke(bp);
          q.rows.forEach((r, k2) => typed(b, r, x + BX + 12, by - q.h / 2 + 19 + k2 * 17, BODY, TEXT, a));
          if (q.leaves.length) {
            // + or − in the box's right edge
            const px = x + BX + BW - 12, py = by; b.fillStyle = hot ? HOT : col;
            b.fillRect(px - 4, py - 1, 9, 2); if (!open.has(i)) b.fillRect(px - 1, py - 4, 2, 9);
            hits.push({ rect: [x + BX, by - q.h / 2, BW, q.h], kind: 'pick', id: `b${i}` });
          }
          if (q.op > 0.02) {
            b.globalAlpha *= q.op;
            q.leaves.forEach((L, j) => {
              const ly = y + q.ly[j];
              b.strokeStyle = rgba(col, 0.5); b.lineWidth = 1.5; curve(b, x + BX + BW, by, x + LX, ly);
              b.fillStyle = rgba(col, 0.9); b.fillRect(x + LX, ly - 2, 4, 4);
              L.rows.forEach((r, k2) => { b.font = SMALL; b.fillStyle = TEXT; b.textAlign = 'left'; b.fillText(r, x + LX + 10, ly - L.h / 2 + 15 + k2 * 14); });
            });
            b.globalAlpha /= q.op;
          }
          b.globalAlpha /= a;
        });
        if (moving || grow < 1) touch(0.15);
      }, { title: 'mind map', live: () => moving });
      c.more = () => hits.map((q) => ({ ...q, part: m.part }));
      c.pick = (id) => {
        if (id === 'root') { const all = open.size < B.filter((q) => q.leaves.length).length; open.clear(); if (all) B.forEach((q, i) => q.leaves.length && open.add(i)); }
        else { const i = Number(id.slice(1)); if (open.has(i)) open.delete(i); else open.add(i); }
        sfx('pip'); moving = true; touch(1);
      };
    },
    async list(m) {
      const TITLE = `800 20px ${DOTO}`;
      // The whole title and every point in full: 280 wide, wider while a point runs past three lines or it's too tall.
      const lay = (w) => {
        const title = wrapRows(m.title || 'list', w - 36, TITLE), items = m.items.map((it) => wrapRows(it, w - 58, BODY)), tops = [];
        let yy = 50 + (title.length - 1) * 24; for (const r of items) { tops.push(yy); yy += r.length * 19 + 11; }
        return { w, title, items, tops, h: 26 + yy + 6 };
      };
      let L = lay(280);
      for (const wide of [360, 440]) if (L.h > maxCardH() || L.items.some((r) => r.length > 3)) L = lay(wide);
      const { w, title, items, tops, h } = L, rings = items.map(() => loop(0, 0, 12, 12, { pad: 0, r: 6, over: 0.1 }));
      await card(m, w, h, function (b, l, t, x, y, age) {
        title.forEach((r, i) => typed(b, r, x + 18, y + 30 + i * 24, TITLE, TEXT, (age - i * 0.2) / 0.4));
        items.forEach((r, i) => { const a = age - 0.3 - i * 0.26; if (a <= 0) return; pen(b, l, this, rings[i].map(([px, py]) => [px + x + 18, py + y + tops[i]]), clamp(a / 0.3, 0, 1), this.color, { key: 'r' + i, w: 2.4 }); wrapped(b, r, x + 40, y + tops[i] + 11, 19, BODY, TEXT, a / 0.4); });
      }, { title: 'list' });
      for (let i = 0; i < items.length; i++) { touch(0.5); await sleep(260); }
    },
    async clip(m) {
      const TF = `800 18px ${DOTO}`, CF = `400 12px ${MONO}`;
      // The whole title and text: 320 wide, 420 when long.
      const lay = (w) => { const title = wrapRows(m.title, w - 36, TF), rows = wrapRows(m.text, w - 36, CF); return { w, title, rows, h: 26 + 62 + (title.length - 1) * 22 + rows.length * 18 }; };
      let L = lay(320);
      if (L.h > maxCardH() || L.rows.length > 14) L = lay(420);
      const { w, title, rows, h } = L, top = 56 + (title.length - 1) * 22;
      await card(m, w, h, function (b, l, t, x, y, age) { title.forEach((r, i) => typed(b, r, x + 18, y + 30 + i * 22, TF, TEXT, (age - i * 0.2) / 0.5)); wrapped(b, rows, x + 18, y + top, 18, CF, DIM, (age - 0.3) / 1.2); }, { title: m.label || 'clipping' });
    },
    async sources(m) {
      const srcs = loadIcons(m.sources), w = 360, h = 26 + 40; let hits = [];
      const c = await card(m, w, h, function (b, l, t, x, y, age) { hits = sourcesRow(b, srcs, x + 18, y + 25, w - 36, age); }, { title: 'sources' });
      c.more = () => hits.map((q) => ({ ...q, part: m.part }));
    },
    async photo(m) {
      const cells = [], cap = m.text || m.title || m.query || '';
      // The picture first (at most 4 s), so the card takes its shape and nothing is cropped.
      const img = m.src && !m.missing ? await new Promise((res) => {
        const i = new Image(), t = setTimeout(() => res(null), 4000);
        i.onload = () => { clearTimeout(t); res(i.naturalWidth && i.naturalHeight ? i : null); };
        i.onerror = () => { clearTimeout(t); res(null); };
        i.src = m.src;
      }) : null;
      // About the area of a 240 × 192 frame in the picture's own proportions, no wider than 360 or taller than 300.
      const a = img ? img.naturalWidth / img.naturalHeight : 4 / 3;
      let iw = Math.sqrt(240 * 192 * a), ih = iw / a;
      const maxH = Math.min(300, maxCardH() - 150);
      if (iw > 360) { iw = 360; ih = iw / a; }
      if (ih > maxH) { ih = maxH; iw = ih * a; }
      const gw = Math.max(1, Math.floor(iw / 3)), gh = Math.max(1, Math.floor(ih / 3)), pw = gw * 3, ph = gh * 3;
      // Names for its parts (labels, as fractions of the picture): in a column each side of it, each on the side its
      // part is on and as near its height as the others allow, with a line to the part. Only when there's a picture.
      const cols = [0, 1].map((side) => (img ? m.labels ?? [] : []).filter((q) => (q.x >= 0.5 ? 1 : 0) === side).map((q) => ({ ...q, side, rows: wrapRows(q.text, 112, SMALL), p: 0 })).sort((a, q) => a.y - q.y));
      const colW = cols.map((list) => (list.length ? Math.ceil(Math.max(...list.flatMap((q) => q.rows.map((r) => textW(r, SMALL))))) + 20 : 0));
      let ah = ph;
      for (const list of cols) {
        let low = 0;
        for (const q of list) { q.hh = q.rows.length * 13; q.top = Math.max(q.y * ph - q.hh / 2, low); low = q.top + q.hh + 6; }
        let limit = Math.max(ph, list.reduce((a, q) => a + q.hh + 6, -6));
        for (const q of [...list].reverse()) { q.top = Math.min(q.top, limit - q.hh); limit = q.top - 6; }
        if (list.length) ah = Math.max(ah, list.at(-1).top + list.at(-1).hh);
      }
      // Never narrower than 240, so the caption has room; a narrow picture sits centred.
      const w = Math.max(240, pw + 24 + colW[0] + colW[1]), ix = colW[0] + Math.round((w - colW[0] - colW[1] - pw) / 2);
      const named = cols.flat().sort((a, q) => (m.labels ?? []).findIndex((o) => o.text === a.text) - (m.labels ?? []).findIndex((o) => o.text === q.text));
      for (const q of named) {
        // From the words' inner edge to the part.
        const from = [q.side ? ix + pw + 6 : ix - 6, 12 + q.top + q.hh / 2], to = [ix + q.x * pw, 12 + q.y * ph];
        q.line = handLine(from, to, { jitter: 0.3, bow: rnd(-0.01, 0.01) }); q.to = to;
      }
      // The whole caption: a short one big, a long one in body type; the credit under it.
      const long = cap.length > 60, CAPF = long ? `400 12px ${MONO}` : `800 16px ${DOTO}`, capLh = long ? 17 : 20;
      const capRows = cap ? wrapRows(cap, w - 24, CAPF) : [], credRows = m.credit ? wrapRows(m.credit, w - 24, `400 10px ${MONO}`) : [];
      // 12 above the picture, 12 between it and the caption, as at its sides.
      const capY = 12 + ah + 12 + (long ? 12 : 15), credY = capRows.length ? capY + (capRows.length - 1) * capLh + 16 : 12 + ah + 12 + 10;
      const h = 26 + 12 + ah + 12 + capRows.length * capLh + credRows.length * 14 + 12;
      let ready = false;
      if (img) {
        const cv = document.createElement('canvas'); cv.width = gw; cv.height = gh;
        const c2 = cv.getContext('2d', { willReadFrequently: true });
        c2.drawImage(img, 0, 0, gw, gh); // the frame has the picture's proportions: all of it, none cut off
        const d = c2.getImageData(0, 0, gw, gh).data;
        // Into the Sidekick's five LED levels with an ordered dither.
        for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) { const i = (gy * gw + gx) * 4, lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255, v = clamp(lum + (B4[(gy % 4) * 4 + (gx % 4)] / 16 - 0.5) * 0.22, 0, 0.999); cells.push([gx, gy, Math.floor(v * 5)]); }
        ready = true;
      }
      const c = await card(m, w, h, function (b, l, t, x, y, age) {
        const u = clamp(age / 1, 0, 1);
        if (ready) for (const [gx, gy, v] of cells) { if ((B4[(gy % 4) * 4 + (gx % 4)] + 0.5) / 16 > u * 1.05) continue; b.fillStyle = LED[v]; b.fillRect(x + ix + gx * 3, y + 12 + gy * 3, 3, 3); }
        else { b.fillStyle = 'rgba(14,92,96,0.25)'; b.fillRect(x + ix, y + 12, pw, ph); typed(b, 'no picture found', x + w / 2, y + 12 + ph / 2, SMALL, DIM, 1, { anchor: 'middle' }); }
        capRows.forEach((r, i) => typed(b, r, x + w / 2, y + capY + i * capLh, CAPF, TEXT, (age - 0.6 - i * 0.15) / 0.5, { anchor: 'middle' }));
        credRows.forEach((r, i) => typed(b, r, x + w / 2, y + credY + i * 14, `400 10px ${MONO}`, DIM, (age - 0.8) / 0.4, { anchor: 'middle' }));
        named.forEach((q, i) => {
          if (q.p <= 0) return;
          pen(b, l, this, placed(this, `n${i}`, q.line, x, y), q.p, this.color, { key: `n${i}`, w: 2.2 });
          q.rows.forEach((r, k) => typed(b, r, x + (q.side ? ix + pw + 10 : ix - 10), y + 12 + q.top + 10 + k * 13, SMALL, TEXT, (t - q.born) / 0.25, { anchor: q.side ? 'start' : 'end' }));
          if (q.p >= 1) { const px = Math.round(x + q.to[0]), py = Math.round(y + q.to[1]); b.fillStyle = INKDARK; b.fillRect(px - 4, py - 4, 8, 8); l.fillStyle = HOT; l.fillRect(px - 2, py - 2, 4, 4); }
        });
      }, { title: 'photo' });
      sfx('scan');
      // Each name in the order given, once the picture is in: its line runs from the words to the part.
      if (named.length) {
        const [x, y] = [markBox(c)[0] + 4, markBox(c)[1] + 4 + 26];
        await sleep(700);
        for (const q of named) { q.born = now(); await trace(q.line.map(([px, py]) => [px + x, py + y]), 0.3, (e) => (q.p = e)); sfx('blip'); }
        touch(0.6);
      }
      return c;
    },
    async graph(m) {
      const w = 360, gx0 = 46, gy0 = 22, gw = w - gx0 - 22, gh = 168;
      const all = [...(m.plots ?? []).flatMap((p) => p.points), ...(m.dots ?? []).map((d) => [d.x, d.y])];
      const xr = m.x_range ?? [Math.min(...all.map((p) => p[0])), Math.max(...all.map((p) => p[0]))], yr = m.y_range ?? [Math.min(0, ...all.map((p) => p[1])), Math.max(...all.map((p) => p[1]))];
      const sx = (v) => gx0 + ((v - xr[0]) / ((xr[1] - xr[0]) || 1)) * gw, sy = (v) => gy0 + gh - ((v - yr[0]) / ((yr[1] - yr[0]) || 1)) * gh;
      const axes = handLine([gx0, gy0], [gx0, gy0 + gh], { jitter: 0.4, bow: 0.005 }).concat(handLine([gx0, gy0 + gh], [gx0 + gw, gy0 + gh], { jitter: 0.4, bow: 0.005 }));
      const plots = (m.plots ?? []).map((p) => ({ ...p, pts: handPath([...p.points].sort((a, b) => a[0] - b[0]).map(([a, v]) => [sx(a), sy(v)]), 0.5), p: 0 }));
      const dots = (m.dots ?? []).map((d) => ({ ...d, pts: loop(sx(d.x) - 5, sy(d.y) - 5, 10, 10, { pad: 0, r: 5 }), p: 0 }));
      const fmt = (v) => (Math.abs(v) >= 1000 ? `${Math.round(v / 100) / 10}k` : String(Math.round(v * 10) / 10));
      const keys = plots.filter((p) => p.label).map((p) => [p.tone, p.label]);
      // Keys flow onto more rows rather than being left out.
      const kAt = []; { let kx = gx0, kr = 0; for (const [, words] of keys) { const kw = textW(words, SMALL) + 30; if (kx > gx0 && kx + kw - 16 > w - 10) { kr++; kx = gx0; } kAt.push([kx, kr]); kx += kw; } }
      const h = 26 + 250 + Math.max(0, (kAt.at(-1)?.[1] ?? 0) * 18);
      let ax = 0;
      const c = await card(m, w, h, function (b, l, t, x, y) {
        const off = (pts) => pts.map(([px, py]) => [px + x, py + y]);
        this.__off ??= { axes: off(axes), plots: plots.map((p) => off(p.pts)), dots: dots.map((d) => off(d.pts)) };
        const O = this.__off;
        pen(b, l, this, O.axes, ax, MID, { key: 'ax', w: 2.4 });
        if (ax >= 1) {
          b.font = `400 10px ${MONO}`; b.fillStyle = DIM;
          for (let k = 0; k <= 4; k++) { const v = xr[0] + ((xr[1] - xr[0]) * k) / 4, v2 = yr[0] + ((yr[1] - yr[0]) * k) / 4; b.textAlign = 'center'; b.fillText(fmt(v), x + sx(v), y + gy0 + gh + 16); b.textAlign = 'right'; b.fillText(fmt(v2), x + gx0 - 8, y + sy(v2) + 3); }
          b.textAlign = 'left';
        }
        plots.forEach((p, i) => pen(b, l, this, O.plots[i], p.p, tone(p.tone), { key: 'p' + i }));
        dots.forEach((d, i) => { pen(b, l, this, O.dots[i], d.p, HOT, { key: 'd' + i, w: 2.6 }); if (d.p >= 1 && d.label) { const lab = ellipsize(d.label, w - 40, SMALL), lx = Math.min(x + sx(d.x) + 9, x + w - 12 - textW(lab, SMALL)); typed(b, lab, lx, y + sy(d.y) - 8, SMALL, TEXT, 1); } });
        keys.forEach(([tn, words], i) => { const [kx, kr] = kAt[i], ky = y + gy0 + gh + 38 + kr * 18; b.fillStyle = tone(tn); b.beginPath(); b.arc(x + kx + 4, ky, 4, 0, Math.PI * 2); b.fill(); typed(b, words, x + kx + 14, ky + 4, SMALL, DIM, 1); });
      }, { title: m.title || 'graph' });
      const [x, y] = [markBox(c)[0] + 4, markBox(c)[1] + 4 + 26];
      await trace(axes.map(([px, py]) => [px + x, py + y]), 0.7, (e) => (ax = e));
      for (const p of plots) await trace(p.pts.map(([px, py]) => [px + x, py + y]), 1.2, (e) => (p.p = e));
      for (const d of dots) await trace(d.pts.map(([px, py]) => [px + x, py + y]), 0.3, (e) => (d.p = e));
    },
    async legend(m) {
      // Keys flow onto more lines rather than past the edge.
      const maxW = 420, at0 = []; let cx = 18, row = 0, widest = 0;
      for (const k of m.keys) { const text = ellipsize(k.text, maxW - 54, SMALL), kw = textW(text, SMALL) + 32; if (cx > 18 && cx + kw > maxW - 4) { row++; cx = 18; } at0.push([cx, row, text]); cx += kw; widest = Math.max(widest, cx); }
      const w = Math.min(maxW, widest + 4), h = 18 + (row + 1) * 22;
      await card(m, w, h, function (b, l, t, x, y, age) { m.keys.forEach((k, i) => { const [kx, r, text] = at0[i], ky = y + 20 + r * 22; b.fillStyle = tone(k.tone); b.beginPath(); b.arc(x + kx + 4, ky - 4, 4, 0, Math.PI * 2); b.fill(); typed(b, text, x + kx + 14, ky, SMALL, DIM, age / 0.4); }); }, { bar: false });
    },
    async timeline(m) {
      const ev = m.events, w = clamp(ev.length * 82, 320, 620);
      const xs = ev.map((_, i) => 30 + ((w - 60) * i) / Math.max(1, ev.length - 1));
      // Each event's words in full, wrapped to its own column: halfway to the next event on its side of the line (or
      // the card's edge), so end events kept inside the card can't run into their neighbours. The line moves down to
      // make room for the tallest one above it.
      const cols = xs.map((px, i) => [i >= 2 ? (xs[i - 2] + px) / 2 + 4 : 10, i + 2 < ev.length ? (px + xs[i + 2]) / 2 - 4 : w - 10]);
      const words = ev.map((e, i) => wrapRows(e.text, cols[i][1] - cols[i][0], SMALL));
      const upN = Math.max(1, ...words.filter((_, i) => i % 2 === 0).map((r) => r.length)), downN = Math.max(1, ...words.filter((_, i) => i % 2).map((r) => r.length));
      const ty = 58 + (upN - 1) * 13, h = 26 + ty + 62 + (downN - 1) * 13;
      const line = handLine([16, ty], [w - 16, ty], { jitter: 0.5, bow: 0.006 });
      let lp = 0; const shown = [];
      const c = await card(m, w, h, function (b, l, t, x, y) {
        this.__line ??= line.map(([px, py]) => [px + x, py + y]);
        pen(b, l, this, this.__line, lp, MID, { key: 'l', w: 2.6 });
        ev.forEach((e, i) => {
          const s = shown[i]; if (s == null) return; const a = t - s, up = i % 2 === 0, px = x + xs[i];
          chip(b, px - 7, y + ty - 7, 14, 14, '', a, { color: this.color });
          // Centred on its dot, but never past the card's edges.
          const inCard = (str, font) => { const tw = textW(str, font); return clamp(px, x + 10 + tw / 2, x + w - 10 - tw / 2); };
          const inCol = (str) => { const tw = textW(str, SMALL); return clamp(px, x + cols[i][0] + tw / 2, x + cols[i][1] - tw / 2); };
          const when = `800 15px ${DOTO}`, rows = words[i], n = rows.length;
          typed(b, e.when, inCard(e.when, when), y + ty + (up ? -18 : 34), when, TEXT, a / 0.3, { anchor: 'middle' });
          rows.forEach((r, k) => typed(b, r, inCol(r), y + ty + (up ? -36 - (n - 1 - k) * 13 : 50 + k * 13), SMALL, DIM, (a - 0.1 - k * 0.1) / 0.4, { anchor: 'middle' }));
        });
      }, { title: m.title || 'timeline' });
      const [x, y] = [markBox(c)[0] + 4, markBox(c)[1] + 4 + 26];
      await trace(line.map(([px, py]) => [px + x, py + y]), 0.8, (e) => (lp = e));
      for (let i = 0; i < ev.length; i++) { await tap(x + xs[i], y + ty); sfx('blip'); shown[i] = now(); touch(); await sleep(150); }
    },
    molecule: (m) => drawMolecule(m),
    async model(m) {
      const w = 320, h = 26 + 236, view3d = R.ink3d?.create(m.parts, w - 24, 210);
      await card(m, w, h, function (b, l, t, x, y, age) {
        if (!view3d) { typed(b, '3D isn’t available here', x + w / 2, y + 100, SMALL, DIM, 1, { anchor: 'middle' }); return; }
        const u = clamp(age / 0.8, 0, 1), f = view3d.frame(reduced() ? 0 : t);
        for (let i = 0; i < f.lv.length; i++) { const v = f.lv[i]; if (!v) continue; const gx = i % f.gw, gy = (i / f.gw) | 0; if ((B4[(gy % 4) * 4 + (gx % 4)] + 0.5) / 16 > u * 1.05) continue; b.fillStyle = LED[v]; b.fillRect(x + 12 + gx * 3, y + 6 + gy * 3, 3, 3); }
        // Labels follow their parts as it turns; one that would land on another this frame waits its turn.
        if (u >= 1) { const took = []; for (const lab of f.labels) { const lx = x + 12 + lab.x, ly = y + 6 + lab.y, r = [lx - 2, ly - 14, textW(lab.text, `600 10px ${MONO}`) + 10, 16]; if (took.some((q) => overlap(q, r) > 0)) continue; took.push(r); b.fillStyle = ACC; b.fillRect(lx - 1.5, ly - 1.5, 3, 3); typed(b, lab.text, lx + 6, ly - 4, `600 10px ${MONO}`, TEXT, 1, { rim: 3 }); } }
      }, { title: m.title || m.label || 'model', live: () => !!view3d && !reduced() });
      sfx('scan');
    },
    table: (m) => drawTable(m),
    bars: (m) => drawBars(m),
    flow: (m) => drawFlow(m),
    math: (m) => drawMath(m),
    geometry: (m) => drawGeometry(m),
    map: (m) => drawMap(m),
    quiz: (m) => drawQuiz(m),
    ticket: (m) => drawTicket(m),
    medal: (m) => drawMedal(m),
  };

  // ---------------------------------------------------------------- molecules: a 2D layout from the parsed SMILES
  // Ring templates (each small ring wants to be a regular polygon) plus springs on bonds and 120° angles, and a push
  // between atoms that aren't bonded, relaxed for a few hundred steps from a zigzag start.
  function layoutMolecule(mol) {
    const n = mol.atoms.length, adj = Array.from({ length: n }, () => []);
    for (const b of mol.bonds) { adj[b.a].push(b.b); adj[b.b].push(b.a); }
    // Smallest ring through each bond (BFS without that bond), up to 8 atoms.
    const rings = [], seen = new Set();
    for (const b of mol.bonds) {
      const prev = new Map([[b.a, -1]]), q = [b.a];
      while (q.length) { const v = q.shift(); if (v === b.b) break; for (const u of adj[v]) { if ((v === b.a && u === b.b) || prev.has(u)) continue; prev.set(u, v); q.push(u); } }
      if (!prev.has(b.b)) continue;
      const ring = []; for (let v = b.b; v !== -1; v = prev.get(v)) ring.push(v);
      if (ring.length > 8) continue;
      const key = [...ring].sort((a, c) => a - c).join(',');
      if (!seen.has(key)) { seen.add(key); rings.push(ring); }
    }
    const want = new Map(); const pk = (i, j) => (i < j ? `${i},${j}` : `${j},${i}`);
    for (const b of mol.bonds) want.set(pk(b.a, b.b), 1);
    // Bond angles: 120° (two or three neighbours), 90° when four crowd round one atom in 2D, and straight through an
    // atom with a triple bond or two double bonds (O=C=O, nitriles).
    const order = (v) => mol.bonds.filter((b) => b.a === v || b.b === v).map((b) => b.order);
    const linear = (v) => adj[v].length === 2 && (order(v).includes(3) || order(v).filter((o) => o === 2).length === 2);
    for (let v = 0; v < n; v++) for (let i = 0; i < adj[v].length; i++) for (let j = i + 1; j < adj[v].length; j++) if (!want.has(pk(adj[v][i], adj[v][j]))) want.set(pk(adj[v][i], adj[v][j]), linear(v) ? 2 : adj[v].length >= 4 ? Math.SQRT2 : Math.sqrt(3));
    for (const r of rings) { const N = r.length; for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) { const k = Math.min(j - i, N - (j - i)); want.set(pk(r[i], r[j]), Math.sin((Math.PI * k) / N) / Math.sin(Math.PI / N)); } }
    const pairs = [...want].map(([k, d]) => [...k.split(',').map(Number), d]);
    // Which pairs have a wanted distance, as a table (looked up for every pair on every step of the relaxation).
    const wanted = new Uint8Array(n * n);
    for (const [i, j] of pairs) { wanted[i * n + j] = 1; wanted[j * n + i] = 1; }
    // Start: walk the molecule depth-first. A ring reached through one of its atoms is laid down whole as a regular
    // polygon pointing away from what's placed; chains zigzag, branches fan out away from their parent. Jittered on retries.
    const ringsOf = Array.from({ length: n }, () => []);
    rings.forEach((r, ri) => r.forEach((v) => ringsOf[v].push(ri)));
    const start = (jit) => {
      const pos = Array.from({ length: n }, () => null), done = new Set(), seenV = new Set();
      const away = (v) => { let x = 0, y = 0; for (const u of adj[v]) if (pos[u]) { x += pos[v][0] - pos[u][0]; y += pos[v][1] - pos[u][1]; } const l = Math.hypot(x, y); return l > 1e-6 ? Math.atan2(y / l, x / l) : 0; };
      const placeRing = (ri, a, dirA) => {
        const R = rings[ri], N = R.length, rad = 1 / (2 * Math.sin(Math.PI / N)), i0 = R.indexOf(a), c = [pos[a][0] + Math.cos(dirA) * rad, pos[a][1] + Math.sin(dirA) * rad], a0 = dirA + Math.PI;
        for (let k = 1; k < N; k++) { const v = R[(i0 + k) % N]; if (!pos[v]) pos[v] = [c[0] + Math.cos(a0 + (k * 2 * Math.PI) / N) * rad, c[1] + Math.sin(a0 + (k * 2 * Math.PI) / N) * rad]; }
        done.add(ri);
      };
      // A ring fused onto one already laid down (two of its atoms placed, side by side): built on that shared edge,
      // on the side away from the first ring.
      const placeFused = (ri) => {
        const R = rings[ri], N = R.length, ix = R.map((v, k) => (pos[v] ? k : -1)).filter((k) => k >= 0);
        if (ix.length !== 2 || !((ix[1] - ix[0] === 1) || (ix[0] === 0 && ix[1] === N - 1))) return;
        const [i0, i1] = ix[1] - ix[0] === 1 ? ix : [ix[1], ix[0]], A = pos[R[i0]], B = pos[R[i1]], M = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
        let nx = -(B[1] - A[1]), ny = B[0] - A[0]; const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
        const pull = [Math.cos(away(R[i0])) + Math.cos(away(R[i1])), Math.sin(away(R[i0])) + Math.sin(away(R[i1]))];
        if (nx * pull[0] + ny * pull[1] < 0) { nx = -nx; ny = -ny; }
        const ap = 1 / (2 * Math.tan(Math.PI / N)), rad = 1 / (2 * Math.sin(Math.PI / N)), c = [M[0] + nx * ap, M[1] + ny * ap];
        // Walk round from B away from A, so the polygon closes back on A.
        const aB = Math.atan2(B[1] - c[1], B[0] - c[0]), aA = Math.atan2(A[1] - c[1], A[0] - c[0]);
        const dirn = Math.sin(aA - aB) > 0 ? -1 : 1;
        for (let k = 1; k < N - 1; k++) { const v = R[(i1 + k) % N]; if (!pos[v]) { const a = aB + (dirn * k * 2 * Math.PI) / N; pos[v] = [c[0] + Math.cos(a) * rad, c[1] + Math.sin(a) * rad]; } }
        done.add(ri);
      };
      const visit = (v, depth) => {
        seenV.add(v);
        for (const ri of ringsOf[v]) if (!done.has(ri) && rings[ri].filter((x) => pos[x]).length === 1) placeRing(ri, v, away(v) + rnd(-jit, jit));
        for (let again = true; again;) { again = false; for (let ri = 0; ri < rings.length; ri++) if (!done.has(ri) && rings[ri].filter((x) => pos[x]).length === 2) { const before = done.size; placeFused(ri); if (done.size > before) again = true; } }
        const kids = adj[v].filter((u) => !pos[u]), base = away(v), m = kids.length;
        const offs = m === 1 ? [(depth % 2 ? 1 : -1) * Math.PI / 3] : m === 2 ? [-Math.PI / 3, Math.PI / 3] : kids.map((_, k) => -Math.PI / 2 + (k * Math.PI) / Math.max(1, m - 1));
        kids.forEach((u, k) => { const a = base + offs[k] + rnd(-jit, jit); pos[u] = [pos[v][0] + Math.cos(a), pos[v][1] + Math.sin(a)]; });
        for (const u of adj[v]) if (!seenV.has(u)) visit(u, depth + 1);
      };
      for (let s0 = 0; s0 < n; s0++) if (!pos[s0]) { pos[s0] = [s0 * 4, 0]; visit(s0, 0); }
      return pos;
    };
    const relax = (pos) => {
      for (let it = 0; it < 400; it++) {
        const step = 0.12 * (1 - it / 420);
        for (const [i, j, d] of pairs) { const dx = pos[j][0] - pos[i][0], dy = pos[j][1] - pos[i][1], l = Math.hypot(dx, dy) || 1e-3, f = ((l - d) / l) * step; pos[i][0] += dx * f; pos[i][1] += dy * f; pos[j][0] -= dx * f; pos[j][1] -= dy * f; }
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { if (wanted[i * n + j]) continue; const dx = pos[j][0] - pos[i][0], dy = pos[j][1] - pos[i][1], l2 = dx * dx + dy * dy; if (l2 > 9) continue; const l = Math.sqrt(l2) || 1e-3, f = (step * 0.6) / (l2 + 0.1); pos[i][0] -= (dx / l) * f; pos[i][1] -= (dy / l) * f; pos[j][0] += (dx / l) * f; pos[j][1] += (dy / l) * f; }
      }
      // How far it is from every wanted distance, plus atoms crowding each other: the lowest wins.
      let stress = 0;
      for (const [i, j, d] of pairs) stress += (Math.hypot(pos[j][0] - pos[i][0], pos[j][1] - pos[i][1]) - d) ** 2;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (!wanted[i * n + j] && Math.hypot(pos[j][0] - pos[i][0], pos[j][1] - pos[i][1]) < 0.8) stress += 1;
      // Bonds crossing each other (a ring folded into a bowtie) are never right.
      const side = (a, b, c) => (c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0]), B = mol.bonds;
      for (let a = 0; a < B.length; a++) for (let c = a + 1; c < B.length; c++) {
        const P = B[a], Q = B[c];
        if (P.a === Q.a || P.a === Q.b || P.b === Q.a || P.b === Q.b) continue;
        if (side(pos[Q.a], pos[Q.b], pos[P.a]) * side(pos[Q.a], pos[Q.b], pos[P.b]) < 0 && side(pos[P.a], pos[P.b], pos[Q.a]) * side(pos[P.a], pos[P.b], pos[Q.b]) < 0) stress += 25;
      }
      return stress;
    };
    // A few tries from different starts: one can fold a ring the wrong way round, another won't.
    let pos = null, best = Infinity;
    // Good enough (no crossings, every distance close) ends the tries early.
    for (let k = 0; k < (n > 60 ? 3 : 10) && best > Math.max(0.05, pairs.length * 0.01); k++) { const p = start(k ? 0.6 : 0); const st = relax(p); if (st < best) { best = st; pos = p; } }
    return { pos, rings };
  }
  const ATOM_TONE = { O: 'coral', N: 'sky', S: 'amber', P: 'lilac', F: 'lime', Cl: 'lime', Br: 'coral', I: 'lilac' };
  async function drawMolecule(m) {
    const mol = m.mol, { pos, rings } = layoutMolecule(mol), w = 320, bw = w - 48, bh = 214;
    const cap = m.label || m.text || '', CAPF = `800 16px ${DOTO}`, capRows = cap ? wrapRows(cap, w - 24, CAPF) : [];
    const h = 26 + 270 + Math.max(0, capRows.length - 1) * 20;
    const bx = boxOf(pos), s = Math.min(bw / Math.max(bx[2], 1), bh / Math.max(bx[3], 1), 34);
    const P2 = pos.map(([x, y]) => [24 + (x - bx[0]) * s + (bw - bx[2] * s) / 2, 18 + (y - bx[1]) * s + (bh - bx[3] * s) / 2]);
    // Carbons are the skeleton's corners (unlabelled, as chemists draw them); everything else is named with its hydrogens.
    const label = (a) => `${a.el}${a.h ? `H${a.h > 1 ? a.h : ''}` : ''}${a.charge ? `${Math.abs(a.charge) > 1 ? Math.abs(a.charge) : ''}${a.charge > 0 ? '+' : '−'}` : ''}`;
    const labels = mol.atoms.map((a, i) => (a.el === 'C' && !a.charge && (mol.bonds.some((b) => b.a === i || b.b === i)) ? '' : label(a)));
    const ringOf = (b) => rings.find((r) => r.includes(b.a) && r.includes(b.b));
    // Each bond as hand strokes, cut short where an atom is labelled; double and triple bonds lean into their ring.
    const strokes = [], bondOf = [];
    for (const b of mol.bonds) {
      let A = P2[b.a], B = P2[b.b];
      const d = dist(A, B) || 1, ux = (B[0] - A[0]) / d, uy = (B[1] - A[1]) / d, cutA = labels[b.a] ? 9 : 0, cutB = labels[b.b] ? 9 : 0;
      A = [A[0] + ux * cutA, A[1] + uy * cutA]; B = [B[0] - ux * cutB, B[1] - uy * cutB];
      const nx = -uy, ny = ux, r = ringOf(b), c = r ? r.reduce((acc, i) => [acc[0] + P2[i][0] / r.length, acc[1] + P2[i][1] / r.length], [0, 0]) : null;
      const side = c && ((c[0] - (A[0] + B[0]) / 2) * nx + (c[1] - (A[1] + B[1]) / 2) * ny) < 0 ? -1 : 1;
      strokes.push(handLine(A, B, { jitter: 0.4, bow: rnd(-0.03, 0.03) })); bondOf.push(b);
      const off = (k, sh = 0.18) => { const o = 4.5 * k * (r ? side : 1); return handLine([A[0] + nx * o + ux * d * sh * (r ? 1 : 0), A[1] + ny * o + uy * d * sh * (r ? 1 : 0)], [B[0] + nx * o - ux * d * sh * (r ? 1 : 0), B[1] + ny * o - uy * d * sh * (r ? 1 : 0)], { jitter: 0.3 }); };
      if (b.order === 2) { strokes.push(off(1)); bondOf.push(null); }
      if (b.order === 3) { strokes.push(off(1), off(-1)); bondOf.push(null, null); }
    }
    // Aromatic rings: a circle inside.
    for (const r of rings) {
      if (!r.every((i, k) => mol.bonds.some((b) => b.order === 1.5 && ((b.a === i && b.b === r[(k + 1) % r.length]) || (b.b === i && b.a === r[(k + 1) % r.length]))))) continue;
      const c = r.reduce((acc, i) => [acc[0] + P2[i][0] / r.length, acc[1] + P2[i][1] / r.length], [0, 0]), rad = Math.min(...r.map((i) => dist(P2[i], c))) * 0.58;
      strokes.push(loop(c[0] - rad, c[1] - rad, 2 * rad, 2 * rad, { pad: 0, r: rad, over: 0.08 })); bondOf.push(null);
    }
    const ps = strokes.map(() => 0), born = [];
    const c = await card(m, w, h, function (b, l, t, x, y, age) {
      this.__s ??= strokes.map((q) => q.map(([px, py]) => [px + x, py + y]));
      this.__s.forEach((q, i) => pen(b, l, this, q, ps[i], this.color, { key: 'b' + i, w: 2.6 }));
      labels.forEach((lab, i) => {
        if (!lab || born[i] == null) return;
        const [px, py] = [P2[i][0] + x, P2[i][1] + y], a = mol.atoms[i];
        typed(b, lab, px, py + 4, `700 13px ${MONO}`, tone(ATOM_TONE[a.el] || 'white'), (t - born[i]) / 0.25, { anchor: 'middle', rim: 4, land: false });
      });
      capRows.forEach((r, i) => typed(b, r, x + w / 2, y + 256 + i * 20, CAPF, TEXT, (age - 0.5 - i * 0.15) / 0.5, { anchor: 'middle' }));
    }, { title: 'molecule' });
    const [x, y] = [markBox(c)[0] + 4, markBox(c)[1] + 4 + 26];
    // Bonds are short and close together: the pen hops straight to each one instead of gliding there.
    const fast = strokes.length > 18;
    for (const [i, q] of strokes.entries()) {
      const pts = q.map(([px, py]) => [px + x, py + y]);
      penApi()?.set?.(pts[0][0], pts[0][1]);
      if (fast && i % 3) { ps[i] = 1; const b = bondOf[i]; if (b) for (const v of [b.a, b.b]) if (labels[v] && born[v] == null) born[v] = now(); touch(); continue; }
      await trace(pts, fast ? 0.12 : 0.2, (e) => (ps[i] = e));
      const b = bondOf[i];
      if (b) for (const v of [b.a, b.b]) if (labels[v] && born[v] == null) { born[v] = now(); sfx('blip'); }
    }
    for (let i = 0; i < ps.length; i++) ps[i] = 1;
    labels.forEach((lab, i) => { if (lab && born[i] == null) born[i] = now(); });
    touch(1);
  }

  // ---------------------------------------------------------------- tables and bars
  // A stroke moved to where its card is now: the same points until the card's insides move (scrolling), so the pen
  // keeps its outline instead of making a new one every frame.
  // How far a small stroke has got; all the way at once with reduced motion.
  const strokeAt = (age, dur) => (reduced() ? 1 : clamp(age / dur, 0, 1));
  const placed = (m, key, pts, ox, oy) => { const c = (m.__at ??= {})[key]; return c && c.x === ox && c.y === oy ? c.pts : (m.__at[key] = { x: ox, y: oy, pts: pts.map(([px, py]) => [px + ox, py + oy]) }).pts; };
  const TH = `600 10px ${MONO}`, TD = `400 12px ${MONO}`, TD1 = `600 12px ${MONO}`;
  const tickPts = () => handPath([[0, 6], [4, 10], [12, 0]], 0.3), crossPts = () => [handLine([1, 0], [11, 10], { jitter: 0.3 }), handLine([11, 0], [1, 10], { jitter: 0.3 })];
  async function drawTable(m) {
    const cols = m.columns, n = cols.length, PX = 10, LH = 16, EDGE_X = 8;
    const font = (ci) => (ci === 0 ? TD1 : TD), yn = (v) => { const k = String(v).trim().toLowerCase(); return k === 'yes' ? 1 : k === 'no' ? -1 : 0; };
    // Each column as wide as its longest cell; when that's wider than the card may be, the widest give way and wrap.
    const natural = cols.map((h, ci) => Math.ceil(Math.max(28, textW(h.toUpperCase(), TH), ...m.rows.map((r) => (yn(r[ci]) ? 14 : textW(r[ci], font(ci)))))));
    const lay = (maxW) => {
      const room = maxW - 2 * EDGE_X - n * 2 * PX;
      let cap = Math.max(...natural);
      while (cap > 56 && natural.reduce((a, v) => a + Math.min(v, cap), 0) > room) cap -= 4;
      const ws = natural.map((v) => Math.min(v, cap)), xs = [];
      let cx = EDGE_X + PX; for (const cw of ws) { xs.push(cx); cx += cw + 2 * PX; }
      const heads = cols.map((h, ci) => wrapRows(h.toUpperCase(), ws[ci], TH)), headH = Math.max(...heads.map((r) => r.length)) * 13 + 14;
      const rows = m.rows.map((r) => r.map((v, ci) => (yn(v) ? { yn: yn(v), rows: [''] } : { rows: wrapRows(v, ws[ci], font(ci)) })));
      const rowH = rows.map((r) => Math.max(...r.map((cell) => cell.rows.length)) * LH + 12);
      return { w: cx - PX + EDGE_X, xs, heads, headH, rows, rowH, h: 26 + 6 + headH + rowH.reduce((a, v) => a + v, 0) + 8, deep: Math.max(...rows.flat().map((cell) => cell.rows.length)) };
    };
    let L = lay(460);
    for (const wide of [600, 760]) if (L.h > maxCardH() || L.deep > 3) L = lay(Math.min(wide, scr()[2] - scr()[0] - 40));
    const { w, xs, heads, headH, rows, rowH, h } = L;
    const glyphs = rows.map((r) => r.map((cell) => (cell.yn > 0 ? [tickPts()] : cell.yn < 0 ? crossPts() : null)));
    await card(m, w, h, function (b, l, t, x, y, age) {
      let yy = y + 6;
      heads.forEach((r, ci) => r.forEach((line, k) => typed(b, line, x + xs[ci], yy + 15 + k * 13, TH, DIM, age / 0.3)));
      yy += headH;
      b.fillStyle = MID; b.fillRect(x + EDGE_X, yy - 1, w - 2 * EDGE_X, 1);
      rows.forEach((cells, ri) => {
        const a = age - 0.2 - ri * 0.09;
        if (a > 0) cells.forEach((cell, ci) => {
          // yes and no as a tick and a cross: told apart by shape, not only by colour.
          if (cell.yn) glyphs[ri][ci].forEach((pts, k) => pen(b, l, this, placed(this, `g${ri}.${ci}.${k}`, pts, x + xs[ci], Math.round(yy + rowH[ri] / 2 - 5)), strokeAt(a - k * 0.12, 0.2), tone(cell.yn > 0 ? 'lime' : 'coral'), { key: `g${ri}.${ci}.${k}`, w: 2.6 }));
          else wrapped(b, cell.rows, x + xs[ci], yy + 6 + 12, LH, font(ci), TEXT, a / 0.3);
        });
        yy += rowH[ri];
        if (ri < rows.length - 1) { b.fillStyle = DEEP; b.fillRect(x + EDGE_X, yy - 1, w - 2 * EDGE_X, 1); }
      });
    }, { title: m.title || 'table' });
    sfx('page'); touch(0.6 + rows.length * 0.1);
  }
  // Whole numbers with thousands separators, a couple of decimals for small ones, M and B for the very big.
  const fmtValue = (v) => (Math.abs(v) >= 1e9 ? `${+(v / 1e9).toFixed(2)}B` : Math.abs(v) >= 1e6 ? `${+(v / 1e6).toFixed(2)}M` : v.toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) < 100 ? 2 : 1 }));
  async function drawBars(m) {
    const bars = m.bars, unit = m.unit ? ` ${m.unit}` : '', top = Math.max(...bars.map((q) => q.value)) || 1, LH = 15, BH = 12;
    // Names on the left (wrapped, never cut), the bar, then its value: the words sit on the card, not on the colour.
    const vals = bars.map((q) => `${fmtValue(q.value)}${unit}`), valW = Math.ceil(Math.max(...vals.map((v) => textW(v, TD1))));
    const labW = Math.min(150, Math.ceil(Math.max(...bars.map((q) => textW(q.label, TD))))), names = bars.map((q) => wrapRows(q.label, labW, TD));
    const w = clamp(16 + labW + 12 + 150 + 8 + valW + 16, 300, 460), x0 = 16 + labW + 12, track = w - x0 - 8 - valW - 16;
    const rowH = names.map((r) => Math.max(26, r.length * LH + 10)), tops = []; let yy = 12; for (const rh of rowH) { tops.push(yy); yy += rh; }
    const h = 26 + yy + 12, axis = handLine([x0 - 1, 8], [x0 - 1, yy + 4], { jitter: 0.3, bow: 0.004 });
    let ax = 0;
    const c = await card(m, w, h, function (b, l, t, x, y, age) {
      pen(b, l, this, placed(this, 'ax', axis, x, y), ax, MID, { key: 'ax', w: 2.2 });
      bars.forEach((q, i) => {
        const a = age - 0.25 - i * 0.08, mid = y + tops[i] + rowH[i] / 2;
        names[i].forEach((r, k) => typed(b, r, x + 16 + labW, mid + 4 - ((names[i].length - 1) * LH) / 2 + k * LH, TD, TEXT, (age - i * 0.05) / 0.3, { anchor: 'end' }));
        if (a <= 0) return;
        const u = reduced() ? 1 : ease(clamp(a / 0.5, 0, 1)), full = Math.max(2, (q.value / top) * track), bw = Math.max(2, full * u), col = tone(q.tone);
        if (u < 1) touch(0.1);
        b.fillStyle = col; b.fillRect(x + x0, mid - BH / 2, bw, BH);
        b.fillStyle = 'rgba(255,255,255,0.45)'; b.fillRect(x + x0, mid - BH / 2, bw, 1.5); b.fillStyle = 'rgba(3,39,34,0.3)'; b.fillRect(x + x0, mid + BH / 2 - 1.5, bw, 1.5);
        if (u >= 1) typed(b, vals[i], x + x0 + full + 8, mid + 4, TD1, TEXT, (a - 0.5) / 0.25);
      });
    }, { title: m.title || 'bars' });
    const [x, y] = [markBox(c)[0] + 4, markBox(c)[1] + 4 + 26];
    await trace(axis.map(([px, py]) => [px + x, py + y]), 0.4, (e) => (ax = e));
    sfx('blip'); touch(1 + bars.length * 0.08);
  }

  // ---------------------------------------------------------------- flow diagrams
  // The sidecar sends the layers (which nodes share a row, in what order, and the lanes long links pass through);
  // here they get sizes from their words and places, and the links between them become pen strokes.
  const NODEF = `500 12px ${MONO}`;
  const bez = (a, c1, c2, b, n = 14) => Array.from({ length: n + 1 }, (_, k) => { const t = k / n, u = 1 - t; return [0, 1].map((d) => u * u * u * a[d] + 3 * u * u * t * c1[d] + 3 * u * t * t * c2[d] + t * t * t * b[d]); });
  // right: layers run left to right instead of top to bottom. wrapW: the widest a node's words may be.
  function layoutFlow(m, right, wrapW) {
    const { layers, via, back } = m.lay, byId = new Map(m.nodes.map((n) => [n.id, n])), box = new Map(), rank = new Map();
    layers.forEach((ids, r) => ids.forEach((id) => {
      rank.set(id, r);
      const n = byId.get(id);
      if (!n) { box.set(id, { id, w: 8, h: 8, lane: true }); return; }
      const rows = wrapRows(n.text, wrapW, NODEF), tw = Math.max(...rows.map((q) => textW(q, NODEF)));
      box.set(id, { id, n, rows, layer: r, w: Math.max(56, Math.ceil(tw) + (n.shape === 'diamond' ? 44 : 24)), h: rows.length * 15 + 15 });
    }));
    const main = (q) => (right ? q.w : q.h), cross = (q) => (right ? q.h : q.w), GAP = right ? 14 : 22;
    // Each link as the chain of things it passes, first layer to last; a link that closes a loop runs the other way.
    const chains = m.links.map((l, k) => { const up = back.includes(k); return { k, l, up, ids: [up ? l.to : l.from, ...(via[k] ?? []), up ? l.from : l.to], words: l.label ? wrapRows(l.label, 104, SMALL) : null }; })
      .filter((q) => q.ids.every((id) => box.has(id)) && q.l.from !== q.l.to);
    const segs = chains.flatMap((q) => q.ids.slice(1).map((id, j) => [q.ids[j], id]));
    // Room between two layers: more where a link's words sit there (beside its start).
    const gaps = layers.map(() => (right ? 46 : 38));
    for (const q of chains) { if (!q.words) continue; const g = q.up ? rank.get(q.ids.at(-1)) - 1 : rank.get(q.ids[0]); gaps[g] = Math.max(gaps[g], right ? Math.max(...q.words.map((r) => textW(r, SMALL))) + 30 : q.words.length * 13 + 30); }
    const at = [], thick = layers.map((ids) => Math.max(...ids.map((id) => main(box.get(id)))));
    let u = 14; layers.forEach((_, r) => { at.push(u); u += thick[r] + (r < layers.length - 1 ? gaps[r] : 0); });
    // Across: in order, no closer than their sizes allow, each as near as it can be to the middle of what it links to.
    const mid = new Map();
    const pack = (ids, want) => {
      const xs = [];
      ids.forEach((id, j) => xs.push(Math.max(want(id), j ? xs[j - 1] + (cross(box.get(ids[j - 1])) + cross(box.get(id))) / 2 + GAP : -Infinity)));
      const off = ids.reduce((a, id, j) => a + xs[j] - want(id), 0) / ids.length;
      ids.forEach((id, j) => mid.set(id, xs[j] - off));
    };
    for (const ids of layers) pack(ids, () => 0);
    for (let sweep = 0; sweep < 6; sweep++) {
      const down = sweep % 2 === 0;
      for (let r = down ? 1 : layers.length - 2; down ? r < layers.length : r >= 0; r += down ? 1 : -1) {
        pack(layers[r], (id) => { const ns = segs.filter(([a, b]) => (down ? b : a) === id).map(([a, b]) => mid.get(down ? a : b)); return ns.length ? ns.reduce((a, v) => a + v, 0) / ns.length : mid.get(id); });
      }
    }
    const lo = Math.min(...[...box.values()].map((q) => mid.get(q.id) - cross(q) / 2));
    for (const q of box.values()) {
      const c = mid.get(q.id) - lo + 14, r = rank.get(q.id), a = at[r] + (thick[r] - main(q)) / 2;
      Object.assign(q, right ? { x: a, y: c - q.h / 2 } : { x: c - q.w / 2, y: a });
    }
    // Where links leave and reach a node: spread along its side, in the order of where they go, so two never share a spot.
    const spot = new Map();
    for (const side of [0, 1]) for (const q of box.values()) {
      const mine = segs.map((sg, i) => [sg, i]).filter(([sg]) => sg[side] === q.id).sort((a, b) => mid.get(a[0][1 - side]) - mid.get(b[0][1 - side]));
      const span = Math.min(cross(q) * 0.6, (mine.length - 1) * 16);
      mine.forEach(([, i], j) => { const off = mine.length > 1 ? -span / 2 + (span * j) / (mine.length - 1) : 0, cx = q.x + q.w / 2, cy = q.y + q.h / 2, e = q.lane ? 0 : 3;
        spot.set(`${i}.${side}`, right ? [side ? q.x - e : q.x + q.w + e, cy + (q.lane ? 0 : off)] : [cx + (q.lane ? 0 : off), side ? q.y - e : q.y + q.h + e]); });
    }
    let si = 0, x1 = 0, y1 = 0;
    const links = chains.map((q) => {
      let pts = [], run = null;
      const n = q.ids.length - 1;
      for (let j = 0; j < n; j++, si++) {
        const A = spot.get(`${si}.0`), B = spot.get(`${si}.1`), d = (right ? B[0] - A[0] : B[1] - A[1]) * 0.5;
        const piece = bez(A, right ? [A[0] + d, A[1]] : [A[0], A[1] + d], right ? [B[0] - d, B[1]] : [B[0], B[1] - d], B);
        if (j === (q.up ? n - 1 : 0)) run = piece;
        pts.push(...piece);
      }
      if (q.up) pts.reverse();
      pts = handPath(pts, 0.5);
      const end = pts[pts.length - 1], prev = pts[Math.max(0, pts.length - 6)], ang = Math.atan2(end[1] - prev[1], end[0] - prev[0]);
      const head = handLine([end[0] + Math.cos(ang + 2.6) * 9, end[1] + Math.sin(ang + 2.6) * 9], end, { jitter: 0.3 }).concat(handLine(end, [end[0] + Math.cos(ang - 2.6) * 9, end[1] + Math.sin(ang - 2.6) * 9], { jitter: 0.3 }));
      return { pts, head, run, words: q.words, flow: !!q.l.flow || !!m.animate, from: q.l.from, to: q.l.to, len: len(pts) };
    });
    const nodes = [...box.values()].filter((q) => !q.lane), ink = links.flatMap((q) => q.pts), put = [];
    // A link's words go beside its line near its start (either side when it runs down, above or below when it runs
    // across), at the spot that covers the least: no node, no other words, as little of any line as can be.
    for (const q of links) {
      if (!q.words) continue;
      const lw = Math.max(...q.words.map((r) => textW(r, SMALL))), lh = q.words.length * 13;
      let best = null;
      for (const k of [7, 4, 10]) for (const side of [1, -1]) {
        const [px, py] = q.run[k], r = right ? [px - lw / 2, side > 0 ? py - 8 - lh : py + 8, lw, lh] : [side > 0 ? px + 9 : px - 9 - lw, py - lh / 2, lw, lh], g = grow(r, 3);
        const cost = (r[0] < 4 ? 500 : 0) + (r[1] < 4 ? 500 : 0) + nodes.filter((nd) => overlap(g, [nd.x, nd.y, nd.w, nd.h]) > 0).length * 400 + put.filter((o) => overlap(g, o) > 0).length * 400 + ink.filter(([ix, iy]) => inside(g, ix, iy)).length;
        if (!best || cost < best.cost) best = { cost, r };
      }
      put.push(best.r);
      q.label = { rows: q.words, anchor: 'start', x: best.r[0], y: best.r[1] + 10 };
      x1 = Math.max(x1, best.r[0] + lw); y1 = Math.max(y1, best.r[1] + lh);
    }
    for (const q of nodes) { x1 = Math.max(x1, q.x + q.w); y1 = Math.max(y1, q.y + q.h); }
    return { W: Math.ceil(x1 + 14), H: Math.ceil(y1 + 14), nodes, links };
  }
  function flowNode(b, nd, ox, oy, age) {
    const x = ox + nd.x, y = oy + nd.y, { w, h } = nd, u = reduced() ? 1 : clamp(age / 0.18, 0, 1);
    if (u < 1) touch(0.1);
    let path;
    // A decision: pointed at both ends. A start or an end: rounder. A step: a plain box.
    if (nd.n.shape === 'diamond') { path = new Path2D(); [[x + 11, y], [x + w - 11, y], [x + w, y + h / 2], [x + w - 11, y + h], [x + 11, y + h], [x, y + h / 2]].forEach((q, i) => (i ? path.lineTo(q[0], q[1]) : path.moveTo(q[0], q[1]))); path.closePath(); }
    else if (nd.n.shape === 'round') { path = new Path2D(); roundRect(x, y, w, h, Math.min(h / 2, 15)).forEach((q, i) => (i ? path.lineTo(q[0], q[1]) : path.moveTo(q[0], q[1]))); path.closePath(); }
    else path = steppedPath(x, y, w, h, P);
    b.save(); b.globalAlpha *= u;
    b.fillStyle = rgba(ACC, 0.07); b.fill(path); b.strokeStyle = tone(nd.n.tone); b.lineWidth = 1.5; b.stroke(path);
    b.restore();
    nd.rows.forEach((r, k) => typed(b, r, x + w / 2, y + 19 + k * 15, NODEF, TEXT, (age - 0.05) / 0.25, { anchor: 'middle' }));
  }
  async function drawFlow(m) {
    const S = scr(), maxW = Math.min(S[2] - S[0] - 48, 860), maxH = maxCardH() - 26, first = m.dir === 'right';
    // The way it was asked for; turned the other way, or with narrower nodes, when that fits the screen and this doesn't.
    const tries = [[first, 124], [!first, 124], [first, 92], [!first, 92]].map(([r, ww]) => layoutFlow(m, r, ww));
    const L = tries.find((q) => q.W <= maxW && q.H <= maxH) ?? tries.find((q) => q.W <= maxW) ?? tries.reduce((a, q) => (q.W < a.W ? q : a));
    const w = Math.max(220, L.W), h = 26 + L.H, ox = Math.round((w - L.W) / 2);
    const shown = new Map(), ps = L.links.map(() => 0), hs = L.links.map(() => 0), born = [], moving = L.links.some((q) => q.flow);
    const c = await card(m, w, h, function (b, l, t, x, y) {
      L.links.forEach((q, i) => {
        pen(b, l, this, placed(this, `l${i}`, q.pts, x + ox, y), ps[i], MID, { key: `l${i}`, w: 2.4 });
        if (hs[i]) pen(b, l, this, placed(this, `h${i}`, q.head, x + ox, y), hs[i], MID, { key: `h${i}`, w: 2.4 });
        if (born[i] == null) return;
        if (q.label) q.label.rows.forEach((r, k) => typed(b, r, x + ox + q.label.x, y + q.label.y + k * 13, SMALL, DIM, (t - born[i]) / 0.3));
        // What flows along it: bright squares running from its start to its end (still, with reduced motion).
        if (q.flow) { const gap = q.len / Math.max(1, Math.round(q.len / 46)), d0 = reduced() ? gap / 2 : (t * 60) % gap; l.fillStyle = HOT; for (let d = d0; d < q.len; d += gap) { const [px, py] = at(q.pts, d / q.len); l.fillRect(Math.round(x + ox + px) - 2, Math.round(y + py) - 2, 4, 4); } }
      });
      for (const nd of L.nodes) { const s0 = shown.get(nd.id); if (s0 != null) flowNode(b, nd, x + ox, y, t - s0); }
    }, { title: m.title || 'flow', live: () => moving && !reduced() && born.some((v) => v != null) });
    const [x, y] = [markBox(c)[0] + 4 + ox, markBox(c)[1] + 4 + 26];
    const show = (id) => { if (!shown.has(id)) { shown.set(id, now()); touch(0.5); } };
    for (const nd of L.nodes) if (nd.layer === 0) show(nd.id);
    // Each link in the order given, its nodes arriving as it reaches them; a big diagram draws every other one at once.
    const fast = L.links.length > 8;
    for (const [i, q] of L.links.entries()) {
      show(q.from);
      const pts = q.pts.map(([px, py]) => [px + x, py + y]);
      if (fast && i % 2) ps[i] = 1;
      else { penApi()?.set?.(pts[0][0], pts[0][1]); await trace(pts, fast ? 0.14 : clamp(q.len / 600, 0.2, 0.5), (e) => (ps[i] = e)); sfx('blip'); }
      hs[i] = 1; born[i] = now(); show(q.to);
    }
    for (const nd of L.nodes) show(nd.id);
    touch(1);
  }

  // ---------------------------------------------------------------- maths: laid out from the tree the sidecar parsed
  // Each piece becomes a box (width, height above and below the baseline) and a list of things to paint in it: text,
  // a glyph stretched to its contents' height (brackets), lines (fraction bars, roots, arrows) and frames.
  const MF = (fs, wt = 500) => `${wt} ${Math.round(fs * 10) / 10}px ${MONO}`;
  function texBox(n, fs) {
    const A = 0.78 * fs, D = 0.22 * fs, ops = [];
    const put = (q, dx, dy) => { for (const o of q.ops) ops.push({ ...o, x: o.x + dx, y: o.y + dy }); };
    const kid = (c, size = fs) => (c ? texBox(c, size) : { w: 0, asc: 0, desc: 0, ops: [] });
    if (n.t === 's') {
      const big = '∑∏∫∮'.includes(n.s) && n.s !== '', size = big ? fs * 1.35 : fs, font = MF(size, n.k === 'fn' ? 400 : 500);
      return { w: textW(n.s, font), asc: big ? fs : A, desc: big ? 0.36 * fs : D, ops: n.s ? [{ t: 't', s: n.s, x: 0, y: big ? 0.14 * fs : 0, font }] : [] };
    }
    if (n.t === 'text') { const font = MF(fs * 0.92, 400); return { w: textW(n.s, font), asc: A, desc: D, ops: [{ t: 't', s: n.s, x: 0, y: 0, font }] }; }
    if (n.t === 'sp') return { w: n.w * fs, asc: 0, desc: 0, ops: [] };
    if (n.t === 'row') {
      // Room round signs: more beside = and its kin, some beside + and ×, none for a minus that starts a term.
      let x = 0, asc = 0, desc = 0, prev = null;
      for (const c of n.c) {
        const q = texBox(c, fs), kind = c.t === 's' ? c.k : 'ord', lead = kind === 'op' && (!prev || prev === 'op' || prev === 'rel' || prev === 'open');
        const pad = kind === 'rel' ? 0.36 * fs : kind === 'op' && !lead ? 0.24 * fs : 0;
        x += prev ? pad : 0; put(q, x, 0); x += q.w + pad + (kind === 'fn' ? 0.14 * fs : 0) + (c.t === 's' && (c.s === ',' || c.s === ';') ? 0.3 * fs : 0);
        asc = Math.max(asc, q.asc); desc = Math.max(desc, q.desc);
        prev = c.t === 's' && '([{'.includes(c.s) && c.s ? 'open' : kind;
      }
      return { w: x, asc, desc, ops };
    }
    if (n.t === 'frac') {
      const size = Math.max(fs * 0.84, 8), a = kid(n.a, size), b = kid(n.b, size), w = Math.max(a.w, b.w) + 0.5 * fs, axis = 0.3 * fs, gap = 0.2 * fs;
      put(a, (w - a.w) / 2, -(axis + gap + a.desc)); put(b, (w - b.w) / 2, -axis + gap + b.asc);
      if (n.bar !== false) ops.push({ t: 'l', x: 0.08 * fs, y: -axis, pts: [[0, 0], [w - 0.16 * fs, 0]] });
      return { w, asc: axis + gap + a.desc + a.asc, desc: gap + b.asc + b.desc - axis, ops };
    }
    if (n.t === 'sqrt') {
      const a = kid(n.a), rw = 0.62 * fs, top = Math.max(a.asc, A * 0.8) + 0.2 * fs, low = Math.max(a.desc, D * 0.6);
      put(a, rw, 0);
      ops.push({ t: 'l', x: 0, y: 0, pts: [[0.04 * fs, -0.32 * fs], [0.18 * fs, -0.38 * fs], [0.36 * fs, low], [0.56 * fs, -top], [rw + a.w + 0.1 * fs, -top]] });
      if (n.n) put(kid(n.n, Math.max(fs * 0.55, 7)), 0, -top * 0.6);
      return { w: rw + a.w + 0.18 * fs, asc: top + 0.1 * fs, desc: low, ops };
    }
    if (n.t === 'script') {
      const a = kid(n.a), size = Math.max(fs * 0.68, 7.5), up = kid(n.sup, size), dn = kid(n.sub, size);
      const rise = Math.max(0.42 * fs, a.asc - 0.36 * fs), drop = Math.max(0.2 * fs, a.desc + 0.04 * fs);
      put(a, 0, 0);
      if (n.sup) put(up, a.w + 0.04 * fs, -rise);
      if (n.sub) put(dn, a.w + 0.04 * fs, drop);
      return { w: a.w + 0.04 * fs + Math.max(up.w, dn.w), asc: Math.max(a.asc, n.sup ? rise + up.asc : 0), desc: Math.max(a.desc, n.sub ? drop + dn.desc : 0), ops };
    }
    if (n.t === 'fence') {
      const a = kid(n.a), font = MF(fs), tall = Math.max(a.asc, A) + Math.max(a.desc, D), ky = Math.max(1, tall / (A + D)), cy = (Math.max(a.desc, D) - Math.max(a.asc, A)) / 2;
      let x = 0;
      if (n.l) { ops.push({ t: 'g', s: n.l, x, y: cy, font, ky }); x += textW(n.l, font); }
      put(a, x, 0); x += a.w;
      if (n.r) { ops.push({ t: 'g', s: n.r, x, y: cy, font, ky }); x += textW(n.r, font); }
      return { w: x, asc: Math.max(a.asc, A) + 0.06 * fs, desc: Math.max(a.desc, D) + 0.06 * fs, ops };
    }
    if (n.t === 'over') {
      const a = kid(n.a), y = -(a.asc + 0.08 * fs), h = 0.16 * fs;
      put(a, 0, 0);
      // Under it, or struck through: nothing added on top.
      if (n.m === 'under') { ops.push({ t: 'l', x: 0, y: a.desc + 0.1 * fs, pts: [[0, 0], [a.w, 0]] }); return { w: a.w, asc: a.asc, desc: a.desc + 0.2 * fs, ops }; }
      if (n.m === 'cancel') { ops.push({ t: 'l', x: 0, y: 0, pts: [[-0.05 * fs, a.desc], [a.w + 0.05 * fs, -a.asc]] }); return { w: a.w, asc: a.asc, desc: a.desc, ops }; }
      if (n.m === 'bar') ops.push({ t: 'l', x: 0, y, pts: [[0.04 * fs, 0], [a.w - 0.04 * fs, 0]] });
      else if (n.m === 'vec') ops.push({ t: 'l', x: 0, y, pts: [[0, 0], [a.w, 0], [a.w - h, -h], [a.w, 0], [a.w - h, h]] });
      else if (n.m === 'hat') ops.push({ t: 'l', x: 0, y, pts: [[a.w / 2 - h * 1.3, h * 0.5], [a.w / 2, -h * 0.7], [a.w / 2 + h * 1.3, h * 0.5]] });
      else { const mk = n.m === 'dot' ? '·' : '~', font = MF(fs * 0.8); ops.push({ t: 't', s: mk, x: (a.w - textW(mk, font)) / 2, y: y + 0.3 * fs, font }); }
      return { w: a.w, asc: a.asc + 0.3 * fs, desc: a.desc, ops };
    }
    if (n.t === 'box') {
      const a = kid(n.a), pad = 0.36 * fs;
      put(a, pad, 0); ops.push({ t: 'r', x: 0, y: -(a.asc + pad), w: a.w + 2 * pad, h: a.asc + a.desc + 2 * pad });
      return { w: a.w + 2 * pad, asc: a.asc + pad, desc: a.desc + pad, ops };
    }
    return { w: 0, asc: 0, desc: 0, ops };
  }
  function paintTex(c, q, x, y, color, frame) {
    c.save(); c.fillStyle = color; c.strokeStyle = color; c.lineWidth = 1.5; c.lineJoin = 'round'; c.lineCap = 'round'; c.textAlign = 'left';
    for (const o of q.ops) {
      if (o.t === 't') { c.font = o.font; c.textBaseline = 'alphabetic'; c.fillText(o.s, x + o.x, y + o.y); }
      else if (o.t === 'g') { c.save(); c.translate(x + o.x, y + o.y); c.scale(1, o.ky); c.font = o.font; c.textBaseline = 'middle'; c.fillText(o.s, 0, 0); c.restore(); }
      else if (o.t === 'l') { c.beginPath(); o.pts.forEach(([px, py], i) => (i ? c.lineTo(x + o.x + px, y + o.y + py) : c.moveTo(x + o.x + px, y + o.y + py))); c.stroke(); }
      else if (o.t === 'r') { c.save(); c.strokeStyle = frame; c.strokeRect(Math.round(x + o.x) + 0.5, Math.round(y + o.y) + 0.5, Math.round(o.w), Math.round(o.h)); c.restore(); }
    }
    c.restore();
  }
  async function drawMath(m) {
    const FS = 17, GUT = 26, PADR = 20, NLH = 14, NUMF = `500 10px ${MONO}`;
    // Every step at full size; the card as wide as the widest (300 to 560), and a step wider than that is set smaller to fit.
    const raw = m.steps.map((st) => texBox(st.tree, FS)), w = clamp(Math.ceil(Math.max(...raw.map((q) => q.w))) + GUT + 20 + PADR, 300, 560), room = w - GUT - 20 - PADR;
    // A step too wide for the card: a little smaller first (down to 13 px), then carried on to more lines, breaking
    // before a sign (=, +, ×) and set in a little; a single piece still too wide (a huge fraction) is shrunk to fit.
    const fit = (tree, size, width) => { let q = texBox(tree, size); for (let k = 0; k < 3 && q.w > width; k++) q = texBox(tree, Math.max(6, (size * width) / q.w - k * 0.5)); return q; };
    const steps = m.steps.map((st, i) => {
      const note = st.note ? wrapRows(st.note, room, SMALL) : [];
      if (raw[i].w <= room) return { lines: [{ q: raw[i], dx: 0 }], note };
      const fs = Math.max(13, (FS * room) / raw[i].w), whole = texBox(st.tree, fs), IN = 1.4 * fs;
      if (whole.w <= room || st.tree.t !== 'row') return { lines: [{ q: fit(st.tree, fs, room), dx: 0 }], note };
      const lines = []; let cur = [];
      const flush = () => { if (cur.length) lines.push({ q: fit({ t: 'row', c: cur }, fs, room - (lines.length ? IN : 0)), dx: lines.length ? IN : 0 }); cur = []; };
      for (const c of st.tree.c) {
        const sign = c.t === 's' && (c.k === 'rel' || c.k === 'op');
        if (sign && cur.length > 1 && texBox({ t: 'row', c: [...cur, c] }, fs).w > (room - (lines.length ? IN : 0)) * 0.82) flush();
        cur.push(c);
      }
      flush();
      return { lines, note };
    });
    let yy = 14;
    for (const st of steps) {
      for (const ln of st.lines) { ln.y = yy + ln.q.asc; yy = ln.y + ln.q.desc + 8; }
      st.noteY = yy + 8; yy += (st.note.length ? 2 + st.note.length * NLH : 0) + 10;
    }
    const h = 26 + yy, born = [];
    for (const st of steps) for (const ln of st.lines) ln.rev = 0;
    const c = await card(m, w, h, function (b, l, t, x, y) {
      steps.forEach((st, i) => {
        if (st.lines[0].rev <= 0) return;
        const x0 = x + GUT + 20;
        typed(b, String(i + 1), x + GUT, y + st.lines[0].y, NUMF, DIM, 1, { anchor: 'end' });
        // Written out from the left, as the cursor passes.
        for (const ln of st.lines) {
          if (ln.rev <= 0) continue;
          b.save(); b.beginPath(); b.rect(x0 + ln.dx - 2, y + ln.y - ln.q.asc - 4, (ln.q.w + 4) * ln.rev, ln.q.asc + ln.q.desc + 8); b.clip();
          paintTex(b, ln.q, x0 + ln.dx, y + ln.y, TEXT, colorOf(this, this.color));
          b.restore();
        }
        if (born[i] != null) st.note.forEach((r, k) => typed(b, r, x0, y + st.noteY + k * NLH, SMALL, DIM, (t - born[i] - k * 0.1) / 0.35));
      });
    }, { title: m.title || 'math' });
    const [x, y] = [markBox(c)[0] + 4, markBox(c)[1] + 4 + 26];
    // One step at a time, a breath between them, so each can be followed.
    for (const [i, st] of steps.entries()) {
      for (const ln of st.lines) {
        const x0 = x + GUT + 20 + ln.dx, yb = y + ln.y - c.sy;
        await fly(x0, yb);
        await trace([[x0, yb], [x0 + ln.q.w, yb]], clamp(ln.q.w / 420, 0.3, 0.8), (e) => (ln.rev = e));
        ln.rev = 1;
      }
      born[i] = now(); sfx('blip'); touch(0.6);
      if (i < steps.length - 1) await sleep(450);
    }
  }

  // ---------------------------------------------------------------- geometry: points, lines, angles and circles
  async function drawGeometry(m) {
    const w = 340, GW = w - 84, GH = 196, col = tone(m.tone);
    const vs = m.vertices, by = new Map(vs.map((v) => [v.id, v])), circles = (m.circles ?? []).filter((q) => by.has(q.at));
    // Fitted to the card: the figure's own units, y up, scaled to fill the drawing area with room for names.
    const ext = [...vs.map((v) => [v.x, v.y]), ...circles.flatMap((q) => { const o = by.get(q.at); return [[o.x - q.r, o.y - q.r], [o.x + q.r, o.y + q.r]]; })];
    const bx = boxOf(ext), k = Math.min(GW / Math.max(bx[2], 1e-9), GH / Math.max(bx[3], 1e-9)), fw = bx[2] * k, fh = bx[3] * k;
    const P2 = (v) => [42 + (GW - fw) / 2 + (v.x - bx[0]) * k, 30 + (GH - fh) / 2 + (bx[1] + bx[3] - v.y) * k];
    const pt = new Map(vs.map((v) => [v.id, P2(v)])), mid = [42 + GW / 2, 30 + GH / 2], h = 26 + GH + 60;
    // A point's name sits on the side its lines don't leave from: away from them, else away from the figure's middle.
    const away = (id, d) => {
      const p = pt.get(id); let dx = 0, dy = 0;
      for (const q of m.lines ?? []) { const o = q.from === id ? pt.get(q.to) : q.to === id ? pt.get(q.from) : null; if (!o) continue; const n = Math.hypot(o[0] - p[0], o[1] - p[1]) || 1; dx -= (o[0] - p[0]) / n; dy -= (o[1] - p[1]) / n; }
      if (Math.hypot(dx, dy) < 0.3) { dx = p[0] - mid[0]; dy = p[1] - mid[1]; }
      if (Math.hypot(dx, dy) < 0.3) { dx = -1; dy = 1; }
      const n = Math.hypot(dx, dy);
      return [p[0] + (dx / n) * d, p[1] + (dy / n) * d];
    };
    // Words already placed (names of points, then angles, then lines): later ones keep off them.
    const LAB = `600 12px ${MONO}`, taken = [], names = new Map(vs.map((v) => [v.id, away(v.id, 13)]));
    const spot = (str, font, cx, cy) => [cx - textW(str, font) / 2 - 2, cy - 8, textW(str, font) + 4, 16];
    for (const v of vs) taken.push(spot(v.id, LAB, ...names.get(v.id)));
    const lineSpots = (q) => {
      const a = pt.get(q.from), b = pt.get(q.to), n = [-(b[1] - a[1]), b[0] - a[0]], nl = Math.hypot(...n) || 1;
      // Its name beside its middle, on the side facing out of the figure; the other side, or along it, when that's taken.
      const c0 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], side = (c0[0] - mid[0]) * n[0] + (c0[1] - mid[1]) * n[1] >= 0 ? 1 : -1;
      // Far enough out that the words clear the line whatever its slope.
      const d = 7 + Math.abs(n[0] / nl) * (textW(q.label ?? '', SMALL) / 2 + 2) + Math.abs(n[1] / nl) * 7;
      return [0.5, 0.32, 0.68].flatMap((u) => [side, -side].map((sd) => [lerp(a[0], b[0], u) + (n[0] / nl) * d * sd, lerp(a[1], b[1], u) + (n[1] / nl) * d * sd]));
    };
    const settle = (str, spots) => {
      if (!str) return spots[0];
      const cost = (p) => { const r = spot(str, SMALL, ...p); return taken.reduce((a, o) => a + overlap(r, o), 0) + ink.filter(([ix, iy]) => inside(r, ix, iy)).length * 30; };
      const best = spots.reduce((a, p) => (cost(p) < cost(a) ? p : a));
      taken.push(spot(str, SMALL, ...best));
      return best;
    };
    const lines = (m.lines ?? []).filter((q) => pt.has(q.from) && pt.has(q.to)).map((q) => ({ ...q, pts: handLine(pt.get(q.from), pt.get(q.to), { jitter: 0.4, bow: rnd(-0.008, 0.008) }), p: 0 }));
    const rings = circles.map((q) => { const o = pt.get(q.at), r = q.r * k; return { ...q, pts: loop(o[0] - r, o[1] - r, 2 * r, 2 * r, { pad: 0, r, over: 0.06 }), p: 0, at: [o[0] + r * 0.72 + 8, o[1] - r * 0.72 - 6] }; });
    // Everything drawn as a line: words keep off it, since ink shows through them.
    const ink = [...lines, ...rings].flatMap((q) => q.pts), perCorner = new Map();
    const angles = (m.angles ?? []).filter((q) => [q.at, q.from, q.to].every((id) => pt.has(id))).map((q) => {
      const o = pt.get(q.at), a1 = Math.atan2(pt.get(q.from)[1] - o[1], pt.get(q.from)[0] - o[0]), a2 = Math.atan2(pt.get(q.to)[1] - o[1], pt.get(q.to)[0] - o[0]);
      const turn = ((a2 - a1 + Math.PI * 3) % (Math.PI * 2)) - Math.PI, nth = perCorner.get(q.at) ?? 0, r = 18 + nth * 5, half = a1 + turn / 2;
      perCorner.set(q.at, nth + 1);
      // A right angle is a small square; any other an arc, each further out when several share a corner.
      const square = Math.abs(Math.abs(turn) - Math.PI / 2) < 0.012, s = 11;
      const pts = square ? handPath([[o[0] + Math.cos(a1) * s, o[1] + Math.sin(a1) * s], [o[0] + (Math.cos(a1) + Math.cos(a2)) * s, o[1] + (Math.sin(a1) + Math.sin(a2)) * s], [o[0] + Math.cos(a2) * s, o[1] + Math.sin(a2) * s]], 0.2)
        : arc(o[0], o[1], r, r, a1, a1 + turn, Math.max(8, Math.round(Math.abs(turn) * 10)));
      return { ...q, pts, p: 0, at: settle(q.label, [13, 22].map((d) => [o[0] + Math.cos(half) * (r + d), o[1] + Math.sin(half) * (r + d)])) };
    });
    for (const q of lines) q.at = settle(q.label, lineSpots(q));
    const seen = new Map();
    const c = await card(m, w, h, function (b, l, t, x, y) {
      const mine = colorOf(this, this.color);
      lines.forEach((q, i) => {
        const lc = q.tone ? tone(q.tone) : mine, pts = placed(this, `l${i}`, q.pts, x, y);
        if (q.dash && q.p > 0) {
          // A dashed line: drawn straight onto both layers, as far as the pen has got.
          const n = Math.max(2, Math.round(pts.length * q.p));
          for (const [cx, style, lw] of [[b, EDGE, 4.5], [l, lc, 2.2]]) { cx.save(); cx.setLineDash([6, 5]); cx.lineCap = 'round'; cx.strokeStyle = style; cx.lineWidth = lw; cx.beginPath(); for (let j = 0; j < n; j++) (j ? cx.lineTo(pts[j][0], pts[j][1]) : cx.moveTo(pts[j][0], pts[j][1])); cx.stroke(); cx.restore(); }
          if (q.p < 1) touch(0.1);
        } else pen(b, l, this, pts, q.p, lc, { key: `l${i}`, w: 2.6 });
        if (q.label && q.p >= 1) typed(b, q.label, x + q.at[0], y + q.at[1] + 4, SMALL, TEXT, (t - q.done) / 0.3, { anchor: 'middle', rim: 3 });
      });
      rings.forEach((q, i) => { pen(b, l, this, placed(this, `c${i}`, q.pts, x, y), q.p, q.tone ? tone(q.tone) : mine, { key: `c${i}`, w: 2.4 }); if (q.label && q.p >= 1) typed(b, q.label, x + q.at[0], y + q.at[1], SMALL, TEXT, (t - q.done) / 0.3, { rim: 3 }); });
      angles.forEach((q, i) => { pen(b, l, this, placed(this, `a${i}`, q.pts, x, y), q.p, tone('amber'), { key: `a${i}`, w: 2 }); if (q.label && q.p >= 1) typed(b, q.label, x + q.at[0], y + q.at[1] + 4, SMALL, TEXT, (t - q.done) / 0.3, { anchor: 'middle', rim: 3 }); });
      for (const v of vs) {
        const s0 = seen.get(v.id); if (s0 == null) continue;
        const p = pt.get(v.id), n = names.get(v.id);
        l.fillStyle = HOT; l.fillRect(Math.round(x + p[0]) - 2, Math.round(y + p[1]) - 2, 4, 4);
        typed(b, v.id, x + n[0], y + n[1] + 4, LAB, TEXT, (t - s0) / 0.2, { anchor: 'middle', rim: 3, land: false });
      }
    }, { title: m.title || 'figure' });
    const [x, y] = [markBox(c)[0] + 4, markBox(c)[1] + 4 + 26], on = (pts) => pts.map(([px, py]) => [px + x, py + y]);
    const see = (id) => { if (!seen.has(id)) { seen.set(id, now()); touch(0.4); } };
    for (const q of lines) { see(q.from); await trace(on(q.pts), clamp(len(q.pts) / 500, 0.25, 0.6), (e) => (q.p = e)); q.done = now(); see(q.to); }
    for (const q of rings) { see(q.at); await trace(on(q.pts), 0.7, (e) => (q.p = e)); q.done = now(); }
    for (const q of angles) { await trace(on(q.pts), 0.25, (e) => (q.p = e)); q.done = now(); sfx('blip'); }
    for (const v of vs) see(v.id);
    touch(1);
  }

  // ---------------------------------------------------------------- maps: country outlines (world.js), pins and routes
  // The sidecar sends the view (west, south, east, north) and which countries to colour in, by their place in
  // world.js. Longitudes are squeezed by the view's latitude so shapes look right; no streets, no terrain.
  async function drawMap(m) {
    const world = R.world, [vw, vs, ve, vn] = m.view, lon0 = (vw + ve) / 2, lat0 = (vs + vn) / 2, kx = Math.max(0.3, Math.cos((lat0 * Math.PI) / 180));
    const PW = Math.max(0.5, (ve - vw) * kx), PH = Math.max(0.5, vn - vs), X0 = 12, Y0 = 10, NAMEF = `600 11px ${MONO}`;
    // 420 wide for most places, wider for a wide one (the world, Russia); a tall one (Chile, Norway) is narrower
    // instead of very tall.
    let mw = PW / PH > 1.8 ? Math.min(560, scr()[2] - scr()[0] - 60) : 420, mh = (mw * PH) / PW;
    if (mh > 300) { mh = 300; mw = Math.max(240, (mh * PW) / PH); }
    mw = Math.round(mw); mh = Math.round(Math.max(150, mh));
    const sc = Math.min(mw / PW, mh / PH), w = mw + 2 * X0, h = 26 + Y0 + mh + 12;
    const proj = (lon, lat, turn = 0) => [mw / 2 + (lon + turn - lon0) * kx * sc, mh / 2 - (lat - lat0) * sc];
    // The turn of the globe that puts a place nearest the view, so lands across the date line join up.
    const near = (lon) => Math.round((lon0 - lon) / 360) * 360;
    const pathOf = (rings) => {
      const p = new Path2D();
      for (const r of rings) {
        let lx = r[0], ly = r[1]; const turn = near(lx / world.q), a = proj(lx / world.q, ly / world.q, turn);
        p.moveTo(a[0], a[1]);
        for (let i = 2; i < r.length; i += 2) { lx += r[i]; ly += r[i + 1]; const q = proj(lx / world.q, ly / world.q, turn); p.lineTo(q[0], q[1]); }
        p.closePath();
      }
      return p;
    };
    // The land is painted once, at the screen's sharpness, and reused every frame.
    let land = null;
    if (world) {
      const dpr = Math.min(2, devicePixelRatio || 1);
      land = document.createElement('canvas'); land.width = Math.round(mw * dpr); land.height = Math.round(mh * dpr);
      const lc = land.getContext('2d');
      // Land is only a little lighter than the card, so the coast is drawn: every outline stroked wide, then every
      // country filled over it, which leaves the half of the line that lies in the sea. Then the borders, thin and dark.
      const paths = world.countries.map(([, rings]) => pathOf(rings));
      lc.scale(dpr, dpr); lc.lineJoin = 'round';
      lc.strokeStyle = MID; lc.lineWidth = 3; for (const p of paths) lc.stroke(p);
      lc.fillStyle = mixHex(DEEP, LED[0], 0.3); for (const p of paths) lc.fill(p, 'evenodd');
      lc.strokeStyle = rgba(LED[0], 1); lc.lineWidth = 1; for (const p of paths) lc.stroke(p);
    }
    const pins = (m.pins ?? []).map((p) => ({ ...p, at: proj(p.lon, p.lat, near(p.lon)) })), byName = new Map(pins.map((p) => [p.name, p]));
    const shaded = world ? (m.shade ?? []).filter((q) => world.countries[q.i]).map((q) => ({ ...q, path: pathOf(world.countries[q.i][1]), edge: tone(q.tone), fill: mixHex(tone(q.tone), LED[0], 0.62), c: proj(q.at[0], q.at[1], near(q.at[0])) })) : [];
    const routes = (m.routes ?? []).filter((q) => byName.has(q.from) && byName.has(q.to)).map((q) => {
      // A gentle arc between its pins, bowed towards the top of the map.
      const a = byName.get(q.from).at, b = byName.get(q.to).at, d = dist(a, b), n = [-(b[1] - a[1]) / (d || 1), (b[0] - a[0]) / (d || 1)], up = n[1] > 0 ? -1 : 1, c = [(a[0] + b[0]) / 2 + n[0] * d * 0.18 * up, (a[1] + b[1]) / 2 + n[1] * d * 0.18 * up];
      return { ...q, p: 0, pts: handPath(Array.from({ length: 31 }, (_, k) => { const u = k / 30; return [0, 1].map((i) => (1 - u) ** 2 * a[i] + 2 * (1 - u) * u * c[i] + u * u * b[i]); }), 0.5) };
    });
    // Names keep inside the map, off each other, the pins and the routes: a country's on it, a pin's beside it.
    const taken = pins.map((p) => [p.at[0] - 5, p.at[1] - 5, 10, 10]), ink = routes.flatMap((q) => q.pts);
    const settle = (str, spots) => {
      const tw = textW(str, NAMEF), rect = ([px, py]) => [clamp(px, 3, Math.max(3, mw - tw - 3)), clamp(py, 3, mh - 17), tw, 14];
      const cost = (r) => taken.reduce((a, o) => a + overlap(grow(r, 2), o), 0) + ink.filter(([ix, iy]) => inside(r, ix, iy)).length * 12;
      const best = spots.map(rect).reduce((a, r) => (cost(r) < cost(a) ? r : a));
      taken.push(best);
      return best;
    };
    for (const p of pins) { const tw = textW(p.name, NAMEF); p.name_ = settle(p.name, [[p.at[0] + 9, p.at[1] - 7], [p.at[0] - 9 - tw, p.at[1] - 7], [p.at[0] - tw / 2, p.at[1] - 22], [p.at[0] - tw / 2, p.at[1] + 8]]); }
    for (const q of shaded) { const tw = textW(q.name, NAMEF); q.name_ = settle(q.name, [0, -16, 16, -32, 32].map((d) => [q.c[0] - tw / 2, q.c[1] - 7 + d])); }
    const c = await card(m, w, h, function (b, l, t, x, y, age) {
      const mx = x + X0, my = y + Y0;
      if (!land) { typed(b, 'maps aren’t available here', x + w / 2, y + Y0 + mh / 2, SMALL, DIM, 1, { anchor: 'middle' }); return; }
      const u = reduced() ? 1 : clamp(age / 0.5, 0, 1);
      if (u < 1) touch(0.1);
      for (const cx of [b, l]) { cx.save(); cx.beginPath(); cx.rect(mx, my, mw, mh); cx.clip(); }
      b.save(); b.globalAlpha *= u; b.drawImage(land, mx, my, mw, mh); b.restore();
      for (const q of shaded) {
        if (q.born == null) continue;
        const a = reduced() ? 1 : clamp((t - q.born) / 0.3, 0, 1);
        if (a < 1) touch(0.1);
        b.save(); b.translate(mx, my); b.globalAlpha *= a; b.fillStyle = q.fill; b.fill(q.path, 'evenodd'); b.strokeStyle = q.edge; b.lineWidth = 1.5; b.lineJoin = 'round'; b.stroke(q.path); b.restore();
      }
      routes.forEach((q, i) => pen(b, l, this, placed(this, `r${i}`, q.pts, mx, my), q.p, tone(q.tone), { key: `r${i}`, w: 2.4 }));
      for (const q of shaded) if (q.born != null) typed(b, q.name, mx + q.name_[0], my + q.name_[1] + 11, NAMEF, TEXT, (t - q.born) / 0.3, { rim: 3 });
      for (const p of pins) {
        if (p.born == null) continue;
        const px = Math.round(mx + p.at[0]), py = Math.round(my + p.at[1]);
        b.fillStyle = INKDARK; b.fillRect(px - 5, py - 5, 10, 10); l.fillStyle = HOT; l.fillRect(px - 3, py - 3, 6, 6);
        typed(b, p.name, mx + p.name_[0], my + p.name_[1] + 11, NAMEF, TEXT, (t - p.born) / 0.25, { rim: 3 });
      }
      b.restore(); l.restore();
      b.strokeStyle = DEEP; b.lineWidth = 1; b.strokeRect(mx + 0.5, my + 0.5, mw - 1, mh - 1);
    }, { title: m.title || 'map' });
    if (!land) return;
    const [x, y] = [markBox(c)[0] + 4 + X0, markBox(c)[1] + 4 + 26 + Y0], inMap = (p) => p[0] >= 0 && p[0] <= mw && p[1] >= 0 && p[1] <= mh;
    sfx('scan'); await sleep(350);
    for (const q of shaded) { if (inMap(q.c)) await tap(x + q.c[0], y + q.c[1]); q.born = now(); touch(0.5); await sleep(120); }
    for (const p of pins) { if (inMap(p.at)) await tap(x + p.at[0], y + p.at[1]); p.born = now(); sfx('blip'); touch(0.4); await sleep(90); }
    for (const q of routes) await trace(q.pts.map(([px, py]) => [px + x, py + y]), clamp(len(q.pts) / 500, 0.3, 0.9), (e) => (q.p = e));
    touch(1);
  }

  // ---------------------------------------------------------------- quizzes: answered by clicking, marked at once
  // One question at a time. A click on an option marks it right or wrong there and then (a tick or a cross as well as
  // a colour) and shows why; the last Next shows the score and tells the sidecar which options were picked.
  async function drawQuiz(m) {
    const qs = m.questions, QF = `600 13px ${MONO}`, PAD = 18, OPX = 34, NUMF = `500 10px ${MONO}`;
    const lay = (w) => {
      const pages = qs.map((q) => {
        const text = wrapRows(q.text, w - 2 * PAD, QF), opts = q.options.map((o) => wrapRows(o, w - 2 * PAD - OPX - 10, TD)), why = q.explain ? wrapRows(q.explain, w - 2 * PAD, SMALL) : [], tops = [];
        let yy = 34 + text.length * 18 + 6;
        for (const r of opts) { tops.push(yy); yy += r.length * 16 + 14 + 6; }
        return { text, opts, tops, why, whyY: yy + 18, h: yy + 24 + why.length * 14 + 10 + 30 + 14 };
      });
      return { w, pages, sum: qs.map((q) => wrapRows(q.text, w - 2 * PAD - 26, TD, 2)), h: 26 + Math.max(...pages.map((pg) => pg.h)) };
    };
    let L = lay(360);
    if (L.h > maxCardH()) L = lay(460);
    const { w, pages, sum } = L, sumTops = []; let sy = 96; for (const r of sum) { sumTops.push(sy); sy += r.length * 16 + 8; }
    const h = Math.max(L.h, 26 + sy + 10 + 44), picks = [], S = { i: 0, done: false, at: now(), answered: 0, down: 0 }, marks = new Map();
    const glyph = (key, ok) => (marks.has(key) ? marks.get(key) : marks.set(key, ok ? [tickPts()] : crossPts()).get(key));
    const score = () => qs.filter((q, i) => picks[i] === q.right).length;
    let hits = [];
    const c = await card(m, w, h, function (b, l, t, x, y) {
      hits = [];
      const a = t - S.at;
      if (S.done) {
        typed(b, `${score()} of ${qs.length}`, x + PAD, y + 52, `800 30px ${DOTO}`, TEXT, a / 0.4);
        typed(b, 'right', x + PAD, y + 74, SMALL, DIM, (a - 0.3) / 0.3);
        sum.forEach((rows, i) => {
          const ok = picks[i] === qs[i].right, aa = a - 0.4 - i * 0.12;
          if (aa <= 0) return;
          glyph(`s${i}`, ok).forEach((pts, k) => pen(b, l, this, placed(this, `s${i}.${k}`, pts, x + PAD, y + sumTops[i] - 10), strokeAt(aa - k * 0.1, 0.2), tone(ok ? 'lime' : 'coral'), { key: `s${i}.${k}`, w: 2.4 }));
          wrapped(b, rows, x + PAD + 26, y + sumTops[i], 16, TD, TEXT, aa / 0.3);
        });
        // One thing to do next: have another go (the card's × puts it away).
        const bw = Math.round(textW('Try again', CHIP()) + 30), br = [x + w - PAD - bw, y + h - 26 - 44, bw, 28];
        chip(b, br[0], br[1], br[2], br[3], 'Try again', a - 0.6, { hover: this.hoverId === 'again', down: now() - S.down < 0.15 });
        hits.push({ rect: br, kind: 'pick', id: 'again' });
        return;
      }
      const pg = pages[S.i], q = qs[S.i], picked = picks[S.i], answered = picked != null, since = t - S.answered;
      typed(b, `${S.i + 1} / ${qs.length}`, x + w - PAD, y + 18, NUMF, DIM, 1, { anchor: 'end' });
      pg.text.forEach((r, k) => typed(b, r, x + PAD, y + 36 + k * 18, QF, TEXT, (a - k * 0.15) / 0.4));
      pg.opts.forEach((rows, k) => {
        const oy = y + pg.tops[k], oh = rows.length * 16 + 14, r = [x + PAD, oy, w - 2 * PAD, oh], right = k === q.right, mine = picked === k, hot = !answered && this.hoverId === `o${k}`;
        const shown = answered && (right || mine), path = steppedPath(r[0], r[1], r[2], r[3], P);
        b.save();
        if (answered && !shown) b.globalAlpha *= 0.6;
        b.fillStyle = rgba(ACC, hot ? 0.16 : 0.07); b.fill(path);
        b.strokeStyle = shown ? tone(right ? 'lime' : 'coral') : hot ? ACC : MID; b.lineWidth = shown ? 2 : 1.5; b.stroke(path);
        if (!shown) typed(b, 'ABCD'[k], r[0] + 17, oy + oh / 2 + 4, `700 11px ${MONO}`, DIM, 1, { anchor: 'middle' });
        rows.forEach((row, j) => typed(b, row, r[0] + OPX, oy + 19 + j * 16, TD, TEXT, (a - 0.2 - k * 0.08) / 0.3));
        b.restore();
        if (shown) glyph(`q${S.i}.${k}`, right).forEach((pts, j) => pen(b, l, this, placed(this, `q${S.i}.${k}.${j}`, pts, r[0] + 11, Math.round(oy + oh / 2 - 5)), strokeAt(since - j * 0.1, 0.2), tone(right ? 'lime' : 'coral'), { key: `q${S.i}.${k}.${j}`, w: 2.6 }));
        if (!answered) hits.push({ rect: r, kind: 'pick', id: `o${k}` });
      });
      if (!answered) return;
      typed(b, picked === q.right ? 'Right.' : `Not quite: it's ${'ABCD'[q.right]}.`, x + PAD, y + pg.whyY, TD1, TEXT, since / 0.25);
      wrapped(b, pg.why, x + PAD, y + pg.whyY + 18, 14, SMALL, DIM, (since - 0.2) / 0.5);
      const label = S.i < qs.length - 1 ? 'Next' : 'See score', bw = Math.round(textW(label, CHIP()) + 30), br = [x + w - PAD - bw, y + h - 26 - 44, bw, 28];
      chip(b, br[0], br[1], br[2], br[3], label, since - 0.15, { hover: this.hoverId === 'next', down: now() - S.down < 0.15 });
      hits.push({ rect: br, kind: 'pick', id: 'next' });
    }, { title: m.title || 'quiz' });
    c.more = () => hits.map((q) => ({ ...q, part: m.part }));
    c.keep = true;
    c.pick = (id) => {
      if (S.done) { if (id === 'again') { picks.length = 0; marks.clear(); Object.assign(S, { i: 0, done: false, at: now() + 0.12, down: now() }); sfx('pip'); touch(1.5); } return; }
      if (id !== 'next') {
        if (picks[S.i] != null) return;
        picks[S.i] = +String(id).slice(1); S.answered = now(); sfx(picks[S.i] === qs[S.i].right ? 'done' : 'poof');
      } else if (picks[S.i] != null) {
        S.down = now(); S.at = now() + 0.12; sfx('pip');
        if (S.i < qs.length - 1) S.i++;
        else { S.done = true; if (score() === qs.length) sfx('hype'); R.ink.send?.({ type: 'quiz_done', part: m.part, picks: qs.map((_, i) => picks[i] ?? -1) }); }
      }
      touch(1.5);
    };
    sfx('page');
  }

  // ---------------------------------------------------------------- the welcome tour: job tickets and a goal medal
  async function drawTicket(m) {
    const w = 270, TF = `800 18px ${DOTO}`, titles = wrapRows(m.title, w - 36 - (m.n != null ? 34 : 0), TF), off = (titles.length - 1) * 22;
    const rows = m.text ? wrapRows(m.text, w - 40, `400 12px ${MONO}`) : [], btn = m.action ? 36 : 0, h = 64 + off + rows.length * 17 + btn + 14;
    const k = 1.05, btnText = ellipsize(m.label || 'Try it', w - 80, CHIP(k)), realBw = Math.round(textW(btnText, CHIP(k)) + 34);
    let hover = false, down = 0, br = null;
    const c = await card(m, w, h, function (b, l, t, x, y, age) {
      // a ticket: notches on both sides, a dashed tear line, a big number
      b.fillStyle = 'rgba(3,14,16,1)'; for (const sx of [x - 1, x + w - 9]) b.fillRect(sx, y + 36 + off, 10, 10);
      b.fillStyle = DEEP; for (let dx = x + 14; dx < x + w - 14; dx += 8) b.fillRect(dx, y + 41 + off, 4, 1);
      titles.forEach((r, i) => typed(b, r, x + 18, y + 26 + i * 22, TF, TEXT, (age - i * 0.2) / 0.4));
      if (m.n != null) typed(b, String(m.n).padStart(2, '0'), x + w - 18, y + 26, `800 18px ${DOTO}`, MID, 1, { anchor: 'end' });
      wrapped(b, rows, x + 18, y + 64 + off, 17, `400 12px ${MONO}`, DIM, (age - 0.2) / 0.8);
      if (m.action) { br = [x + 18, y + h - btn - 10, realBw, 30]; chip(b, br[0], br[1], br[2], br[3], btnText, age - 0.5, { k, color: this.color, hover, down: now() - down < 0.15 }); }
    }, { bar: false, edge: true });
    c.more = () => (br ? [{ rect: br, kind: 'button', part: m.part }] : []);
    c.setHover = (v) => { hover = v; }; c.press = () => { down = now(); };
    sfx('page');
  }
  async function drawMedal(m) {
    const w = 230, ring = loop(0, 0, 120, 120, { pad: 0, r: 60, over: 0.12 }), star = (() => { const pts = []; for (let i = 0; i <= 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 16 : 36; pts.push([Math.cos(a) * r, Math.sin(a) * r]); } return handPath(pts, 0.6); })();
    let rp = 0, sp = 0;
    const goal = wrapRows((m.title || 'your goal').toUpperCase(), w - 30, `600 10px ${MONO}`), rows = wrapRows(m.text, w - 40, `600 12px ${MONO}`);
    const goff = (goal.length - 1) * 14, h = 250 + goff + Math.max(0, rows.length - 3) * 17;
    const c = await card(m, w, h, function (b, l, t, x, y, age) {
      const cx = x + w / 2, cy = y + 86;
      // ribbon
      b.fillStyle = DEEP; b.beginPath(); b.moveTo(cx - 34, y + 6); b.lineTo(cx - 8, y + 40); b.lineTo(cx - 20, y + 44); b.closePath(); b.fill(); b.beginPath(); b.moveTo(cx + 34, y + 6); b.lineTo(cx + 8, y + 40); b.lineTo(cx + 20, y + 44); b.closePath(); b.fill();
      this.__r ??= ring.map(([px, py]) => [px + cx - 60, py + cy - 60]); this.__st ??= star.map(([px, py]) => [px + cx, py + cy]);
      pen(b, l, this, this.__r, rp, tone('amber'), { key: 'r' }); pen(b, l, this, this.__st, sp, tone('amber'), { key: 's', w: 3 });
      goal.forEach((r, i) => typed(b, r, cx, y + 168 + i * 14, `600 10px ${MONO}`, DIM, (age - 0.6) / 0.4, { anchor: 'middle' }));
      wrapped(b, rows, x + 20, y + 190 + goff, 17, `600 12px ${MONO}`, TEXT, (age - 0.8) / 0.8);
      if (sp >= 1 && !reduced()) { const g = (Math.sin(t * 2) + 1) / 2; l.fillStyle = rgba(tone('amber'), 0.25 * g); l.fillRect(cx - 2, cy - 48, 4, 4); }
    }, { bar: false, edge: true, live: () => sp >= 1 });
    c.color = tone('amber');
    const [x, y] = [markBox(c)[0] + 4, markBox(c)[1] + 4], cx = x + w / 2, cy = y + 86;
    await trace(ring.map(([px, py]) => [px + cx - 60, py + cy - 60]), 0.9, (e) => (rp = e));
    await trace(star.map(([px, py]) => [px + cx, py + cy]), 0.8, (e) => (sp = e));
    sfx('hype'); burst(cx, cy, true);
  }

  // ---------------------------------------------------------------- edits on what's drawn (part ids p1, p2 …)
  const partMarks = (id) => marks.filter((m) => m.alive && m.part === id);
  const partBox = (ms) => ms.reduce((u, m) => union(u, markBox(m)), null);
  async function edit(e) {
    if (e.do === 'clear') { sfx('dematerialize'); const live = marks.filter((m) => m.alive && (m.part || m.card) && !m.local); await tween(0.35, (u) => live.forEach((m) => (m.alpha = 1 - u))); live.forEach((m) => (m.alive = false)); return; }
    const ms = partMarks(e.part);
    if (!ms.length) return;
    const box = partBox(ms);
    if (e.do === 'recolor') { if (box) await tap(box[0] + box[2] * 0.5, box[1]); for (const m of ms) { m.color0 = colorOf(m, m.color); m.color = tone(e.tone); m.recolor = now(); } sfx('blip'); touch(0.6); await sleep(550); for (const m of ms) m.recolor = null; }
    else if (e.do === 'move') {
      const dx = e.dx ?? 0, dy = e.dy ?? 0, start = ms.map((m) => [m.dx, m.dy]);
      if (box) await fly(box[0] + box[2] / 2, box[1] + box[3] / 2);
      sfx('whoosh');
      await tween(0.6, (u) => { const k = ease(u); ms.forEach((m, i) => { m.dx = start[i][0] + dx * k; m.dy = start[i][1] + dy * k; }); if (box) penApi()?.set?.(box[0] + box[2] / 2 + dx * k, box[1] + box[3] / 2 + dy * k); });
    } else if (e.do === 'erase') {
      sfx('dematerialize');
      // Strokes are taken back the way they were drawn (backwards); everything else fades.
      for (const m of [...ms].reverse()) {
        if (m.pts && m.p > 0) { const pts = m.pts, p0 = m.p; await fly(...at(pts, p0)); await tween(0.45, (u) => { m.p = p0 * (1 - u); }); }
        else await tween(0.3, (u) => (m.alpha = 1 - u));
        m.alive = false;
      }
      touch();
    }
  }
  const fadeOut = async (ms, sec = 0.35) => { ms.forEach((m) => (m.leaving = true)); syncClearAll(); await tween(sec, (u) => ms.forEach((m) => (m.alpha = Math.min(m.alpha, 1 - u)))); ms.forEach((m) => (m.alive = false)); touch(); syncClearAll(); };
  // Clear all: once two or more cards are open, one chip at the bottom clears the whole drawing (no closing them one
  // by one). It sits just above where the caption shows.
  let clearAll = null;
  function syncClearAll() {
    const n = new Set(marks.filter((m) => m.alive && m.card && !m.leaving && !m.pinned).map((m) => m.part)).size;
    if (n >= 2) {
      const str = `Clear all · ${n}`, k = 1, w = Math.round(textW(str, CHIP(k)) + 26), h = 26;
      if (clearAll?.alive && clearAll.str === str) return;
      if (clearAll) clearAll.alive = false;
      const r = () => [Math.round(W / 2 - w / 2), Math.round(H - (R.safe?.bottom ?? 0) - 18 - 34 - 12 - h), w, h];
      clearAll = add({ z: 7, kind: 'clearall', str, box: () => grow(r(), 4), hover: false, draw(b, l, t) { const q = r(); chip(b, q[0], q[1], q[2], q[3], str, t - this.born, { color: this.hover ? HOT : DIM, hover: this.hover }); },
        hits() { return [{ rect: r(), kind: 'clearall' }]; } });
    } else if (clearAll) { clearAll.alive = false; clearAll = null; touch(); }
  }
  // The drawing goes and the reminders card stays: what a window coming to the front does, asked for by a click.
  // Pinned: the card (and its arrow) stays through new drawings, clicks elsewhere, window changes, Esc and Clear all,
  // until its × is clicked. The sidecar hears it, so the model knows it's still up.
  function pinPart(part, on) {
    for (const m of partMarks(part)) m.pinned = on;
    sfx(on ? 'pip' : 'tick'); touch(0.3); syncClearAll();
    R.ink.send?.({ type: 'ink_pinned', part, on });
  }
  function clearDrawing() {
    stop();
    R.ink.send?.({ type: 'ink_cleared' });
    sfx('dematerialize');
    fadeOut(marks.filter((m) => m.alive && !m.local && !m.pinned));
  }
  function clearEverything() {
    stop();
    for (const id of new Set(marks.filter((m) => m.alive && m.part && !m.local && !m.pinned).map((m) => m.part))) R.ink.send?.({ type: 'ink_closed', part: id });
    R.ink.send?.({ type: 'ink_cleared' });
    sfx('dematerialize');
    fadeOut(marks.filter((m) => m.alive && !m.pinned));
  }

  // ---------------------------------------------------------------- speech: the caption at the bottom
  const cap = document.createElement('div');
  cap.setAttribute('role', 'status'); cap.setAttribute('aria-live', 'polite');
  Object.assign(cap.style, { position: 'fixed', left: '50%', bottom: '18px', transform: 'translateX(-50%)', maxWidth: 'min(720px, 80vw)', padding: '8px 16px', font: `500 13px ${MONO}`, color: TEXT, background: GLASS, border: `1.5px solid ${ACC}`, boxShadow: `0 0 12px ${rgba(ACC, 0.45)}`, borderRadius: '2px', opacity: '0', transition: 'opacity .2s', pointerEvents: 'none', textAlign: 'center', zIndex: '5' });
  const mountCap = () => document.body.appendChild(cap);
  if (document.body) mountCap(); else document.addEventListener('DOMContentLoaded', mountCap);
  const caption = { show(text) { cap.style.bottom = `${(R.safe?.bottom ?? 0) + 18}px`; cap.textContent = text; cap.style.opacity = text ? '1' : '0'; }, hide() { cap.style.opacity = '0'; } };

  // ---------------------------------------------------------------- pacing: each line on the voice clock
  // Spoken lines: the marks are released across the line from when its audio starts (voice-out.js learns how many
  // characters a second the voice says); text only, about 2.6 words a second.
  const cps = () => R.voiceOut?.cps?.() ?? 15;
  async function voiceStart() {
    const t0 = now();
    while (now() - t0 < 2.5) { if (R.voiceOut?.playing()) return now(); await sleep(50); }
    return now();
  }
  const until_ = async (t, gen) => { while (now() < t && gen === G.gen) await sleep(Math.min(100, (t - now()) * 1000)); };

  // ---------------------------------------------------------------- the player
  const G = { gen: 0, q: [], playing: false, held: false, wait: null, ptr: null, idle: [] };
  const PEN_FREE = new Set(['sfx', 'copy', 'open', 'handoff']);
  const onScreen = (r) => !!r && r[0] + r[2] > 0 && r[1] + r[3] > 0 && r[0] < W && r[1] < H;
  async function runMark(m, ctx) {
    const f = SCREEN_MARKS[m.kind] ?? ACTIONS_DRAW[m.kind] ?? CARDS_DRAW[m.kind];
    if (!f) return null;
    await fontsReady();
    if (SCREEN_MARKS[m.kind] && !m.at && !m.points) return null;
    // Not on this overlay's screen (the shell moved the overlay to the first marked thing's screen): skipped, rather
    // than the cursor flying off the edge to draw where nobody sees it.
    if (SCREEN_MARKS[m.kind] && m.at && !onScreen(rectOf(m))) { console.warn('ink: off this screen', m.kind); return null; }
    return f(m, ctx);
  }
  async function runBeat(b, e, clock, gen) {
    const voiced = b.voiced && clock.T != null, chars = String(b.caption ?? '').length;
    const t0 = voiced ? Math.max(now(), clock.T + clock.before / cps()) : now();
    const dur = voiced ? Math.max(1.2, chars / cps()) : Math.max(1.6, String(b.caption ?? '').split(/\s+/).filter(Boolean).length / 2.6);
    clock.before += chars + 1;
    // Behind the voice (the previous beat's marks took longer than its line): draw this one faster to catch up.
    const late = now() - t0;
    if (penApi()) penApi().speed = late > 0.4 ? clamp(1 + late / 2, 1, 2.5) : 1;
    await until_(t0, gen);
    if (gen !== G.gen) return;
    caption.show(b.caption);
    upcoming = b.marks.filter((m) => m.at?.rect && SCREEN_MARKS[m.kind]).map((m) => grow(rectOf(m), 4));
    const ctx = { num: 0 }, made = [];
    for (const [i, m] of b.marks.entries()) {
      await until_(t0 + (dur * 0.8 * i) / Math.max(1, b.marks.length), gen);
      if (gen !== G.gen) return;
      // Its own place stops counting as upcoming: its name goes right beside it.
      const own = m.at?.rect ? grow(rectOf(m), 4) : null;
      if (own) upcoming = upcoming.filter((r) => r.join() !== own.join());
      try { made.push(await runMark(m, ctx)); } catch (err) { console.error('ink mark', m.kind, err); }
      // Stopped while it was being made (a card waits for fonts or a photo first): it appeared after the clear, so it goes.
      if (gen !== G.gen) { if (m.part) fadeOut(marks.filter((q) => q.alive && q.part === m.part), 0.2); return; }
    }
    upcoming = [];
    await until_(t0 + dur, gen);
    if (gen !== G.gen || !b.wait) return;
    const result = await waitFor(b, made, gen);
    G.clock = null;
    if (gen !== G.gen) return;
    R.ink.send?.({ type: 'draw_wait_done', id: e.id, beat: b.n, result });
    // That step is done: its screen marks go (the screen has changed under them), and the sidecar forgets them.
    if (result === 'clicked' || result === 'hovered') {
      sfx('done');
      const gone = marks.filter((m) => m.alive && m.screen && b.marks.some((q) => q.part && q.part === m.part));
      for (const id of new Set(gone.map((m) => m.part))) R.ink.send?.({ type: 'ink_closed', part: id });
      fadeOut(gone, 0.3);
    }
  }
  // Waits for a click on (or hover over) the marked thing; the shell reports presses while armed (ink_wait).
  function waitFor(b, made, gen) {
    const m = b.marks.find((q) => (q.kind === 'target' || q.kind === 'hover') && q.at) ?? b.marks.find((q) => q.at);
    const rect = grow(rectOf(m), 10), mark = made.find((q) => q?.parkAt);
    if (mark) { mark.waiting = true; park(mark.parkAt[2], mark.parkAt[0], mark.parkAt[1]); touch(); }
    return new Promise((resolve) => {
      let hoverAt = 0;
      const done = (r) => { clearTimeout(timer); clearInterval(tick); G.wait = null; if (b.wait === 'click') R.ink.invoke?.('ink_wait', { on: false }); if (mark) mark.waiting = false; park(null); resolve(r); };
      const timer = setTimeout(() => done('timeout'), (b.wait === 'click' ? 125 : 65) * 1000);
      const tick = setInterval(() => { if (gen !== G.gen) done('skipped'); }, 200);
      G.wait = {
        click: (x, y) => { if (b.wait === 'click' && inside(rect, x, y)) done('clicked'); },
        ptr: (x, y) => { if (b.wait !== 'hover') return; if (inside(rect, x, y)) { hoverAt ||= now(); if (now() - hoverAt > 0.5) done('hovered'); } else hoverAt = 0; },
      };
      if (b.wait === 'click') R.ink.invoke?.('ink_wait', { on: true });
    });
  }
  async function runSeg(e, gen) {
    R.ink.send?.({ type: 'draw_started', id: e.id, seg: e.seg });
    if (e.fade) for (const b of e.beats ?? []) for (const m of b.marks) if (m.part) drawnBy.set(m.part, e.id);
    if (e.deep) for (const b of e.beats ?? []) for (const m of b.marks) if (m.part) deepParts.add(m.part);
    if (e.win) winRect = locRect(e.win);
    if (e.busy?.length) busyRects = e.busy.map(locRect);
    for (const ed of e.edits ?? []) { if (gen !== G.gen) return; if (ed.do !== 'clear') { await take(); G.held = true; } await edit(ed); }
    const needsPen = (e.beats ?? []).some((b) => b.marks.some((m) => !PEN_FREE.has(m.kind)));
    if (needsPen) { await take(); G.held = true; }
    // One voice clock for a whole drawing (its beats arrive one at a time), started again after each click or hover,
    // when the next line is only spoken once its beat is sent.
    const voiced = (e.beats ?? []).some((b) => b.voiced);
    let clock = G.clock?.id === e.id ? G.clock : null;
    if (!clock) clock = G.clock = { id: e.id, T: voiced ? await voiceStart() : null, before: 0 };
    else if (clock.T == null && voiced) clock.T = await voiceStart();
    for (const b of e.beats ?? []) { if (gen !== G.gen) return; await runBeat(b, e, clock, gen); }
  }
  async function pump() {
    if (G.playing) return;
    G.playing = true;
    try {
      while (G.q.length) {
        const e = G.q.shift(), gen = G.gen;
        try { await runSeg(e, gen); } catch (err) { console.error('ink', err); }
        if (gen !== G.gen) continue;
        if (e.last && e.fade) fadeLater(e.id, e.fade);
        if (e.last) R.ink.send?.({ type: 'draw_done', id: e.id });
        if (e.last && !G.q.length) {
          await sleep(900);
          if (!G.q.length && gen === G.gen) { caption.hide(); if (G.held) { G.held = false; await penApi()?.release(); } }
        } else if (!G.q.length) caption.hide();
      }
    } finally { G.playing = false; if (!G.q.length) for (const f of G.idle.splice(0)) f(); }
  }
  // A drawing that goes by itself (the welcome tour): faded `sec` after it finishes, waiting while the pointer rests
  // on one of its pieces (they may be about to click a button).
  const drawnBy = new Map(); // part → drawing id, for drawings that fade by themselves
  const deepParts = new Set(); // parts of a deep explanation: big cards, one at a time
  function fadeLater(id, sec) {
    const mine = () => marks.filter((m) => m.alive && drawnBy.get(m.part) === id);
    const tick = () => {
      const ms = mine();
      if (!ms.length) return;
      if (G.ptr && ms.some((m) => inside(markBox(m), G.ptr[0], G.ptr[1]))) { setTimeout(tick, 3000); return; }
      for (const p of new Set(ms.map((m) => m.part))) R.ink.send?.({ type: 'ink_closed', part: p });
      fadeOut(ms, 0.8);
    };
    setTimeout(tick, sec * 1000);
  }
  function stop() {
    G.gen++; G.q.length = 0; caption.hide();
    G.wait = null; R.ink.invoke?.('ink_wait', { on: false });
    if (G.held) { G.held = false; penApi()?.release(); }
    for (const f of G.idle.splice(0)) f();
  }

  // ---------------------------------------------------------------- the reminders card: Today / Later
  // The sidecar's list ({ today, later, seconds, flash, toggle }), shown as a card like the drawn list. It belongs to
  // this overlay (part 'reminders', local): new drawings and stale windows leave it; ×, Esc and Clear all close it.
  const REM_W = 340, REM_PART = 'reminders', HEADF = `800 16px ${DOTO}`;
  const REM = { data: { today: [], later: [] }, known: false, m: null, until: 0, timer: 0, shown: new Map(), ticked: new Map(), rings: new Map(), checks: new Map(), strikes: new Map(), flash: null, flashAt: 0 };
  const remOpen = () => !!REM.m && REM.m.alive && !REM.m.leaving;
  const remWhen = (i) => (i.done ? 'done' : i.overdue ? `late ${i.when}` : i.when || '');
  const cached = (map, key, make) => (map.has(key) ? map.get(key) : (map.set(key, make()), map.get(key)));
  const shift = (pts, x, y) => pts.map(([px, py]) => [px + x, py + y]);
  // Rows in card coordinates (from the card's top left), cut to the screen's height with "+N more".
  function remLayout(x, y) {
    const { today, later } = REM.data, all = [...today, ...later];
    const whenW = Math.min(96, Math.max(0, ...all.map((i) => textW(remWhen(i), SMALL))));
    const tw = REM_W - 40 - (whenW ? whenW + 12 : 0) - 16, rows = [];
    let yy = 26 + 8;
    const head = (label, n, gap) => { if (gap) yy += 8; rows.push({ head: label, n, gap, y: yy, h: 26 }); yy += 26; };
    const item = (i) => { const lines = wrapRows(i.text, tw, BODY, 3), h = lines.length * 19 + 10; rows.push({ i, lines, when: remWhen(i), y: yy, h }); yy += h; };
    head('Today', today.filter((i) => !i.done).length);
    if (today.length) today.forEach(item); else { rows.push({ note: later.length ? 'Nothing due today' : 'Nothing on your list yet', y: yy, h: 26 }); yy += 26; }
    if (later.length) { head('Later', later.length, true); later.forEach(item); }
    const max = maxCardH();
    let hidden = 0;
    if (yy + 10 > max) {
      while (rows.length > 1 && rows[rows.length - 1].y + rows[rows.length - 1].h + 26 + 10 > max) { const r = rows.pop(); if (r.i) hidden++; }
      while (rows.length > 1 && rows[rows.length - 1].head) rows.pop();
      yy = rows[rows.length - 1].y + rows[rows.length - 1].h;
      if (hidden) { rows.push({ more: `+${hidden} more`, y: yy, h: 26 }); yy += 26; }
    }
    // Ink in screen points, made once per item so its outline doesn't change from frame to frame.
    for (const r of rows) {
      if (!r.i) continue;
      const id = r.i.id, cy = r.y + 6;
      r.ring = shift(cached(REM.rings, id, () => loop(0, 0, 12, 12, { pad: 0, r: 6, over: 0.1 })), x + 18, y + cy);
      r.check = shift(cached(REM.checks, id, () => handLine([2.5, 6], [5.5, 9.5], { jitter: 0.3 }).concat(handLine([5.5, 9.5], [10.5, 2.5], { jitter: 0.3 }))), x + 18, y + cy);
      r.strikes = r.lines.map((ln, k) => { const lw = textW(ln, BODY); return shift(cached(REM.strikes, `${id}:${k}:${Math.round(lw)}`, () => handLine([0, 0], [lw + 4, 0], { jitter: 0.6 })), x + 38, y + r.y + 13 + k * 19); });
    }
    return { rows, h: yy + 10 };
  }
  function remDraw(b, l, t) {
    const x = this.x, y = this.y, w = REM_W, h = this.h, cw = this.ready ? w : this.cw, ch = this.ready ? h : this.ch;
    if (cw < 4) return;
    chrome(b, x, y, cw, ch);
    if (!this.ready) return;
    b.fillStyle = 'rgba(120,255,226,0.06)'; b.fillRect(x + 2, y + 2, w - 4, 24);
    b.fillStyle = DEEP; b.fillRect(x + 2, y + 26, w - 4, 1);
    [0, 1].forEach((k) => { b.fillStyle = k ? DEEP : ACC; b.fillRect(x + 12 + k * 12, y + 11, 5, 5); });
    typed(b, 'reminders', x + w / 2, y + 17, `500 10px ${MONO}`, DIM, (t - this.opened) / 0.4, { anchor: 'middle' });
    pinIcon(b, x + w - 44, y + 13, this);
    const cx = x + w - 18, cyy = y + 13;
    b.fillStyle = this.hoverClose ? HOT : DIM; for (let k = -3; k <= 3; k++) { b.fillRect(cx + k - 1, cyy + k - 1, 2, 2); b.fillRect(cx + k - 1, cyy - k - 1, 2, 2); }
    for (const c of [b, l]) { c.save(); c.beginPath(); c.rect(x + 2, y + 27, w - 4, h - 29); c.clip(); }
    try {
      for (const r of this.rows) {
        const ry = y + r.y;
        if (r.head) {
          if (r.gap) { b.fillStyle = DEEP; for (let gx = x + 18; gx < x + w - 18; gx += 6) b.fillRect(gx, ry - 5, 3, 1.5); }
          const hw = typed(b, r.head, x + 18, ry + 19, HEADF, TEXT, (t - this.opened) / 0.3);
          if (r.n) typed(b, String(r.n), x + 18 + hw + 8, ry + 18, SMALL, DIM, (t - this.opened - 0.1) / 0.2);
          continue;
        }
        if (r.note || r.more) { typed(b, r.note || r.more, x + (r.note ? 40 : 18), ry + 17, SMALL, DIM, (t - this.opened - 0.15) / 0.4); continue; }
        const it = r.i, a = t - (REM.shown.get(it.id) ?? this.opened);
        if (a <= 0) continue;
        if (this.hoverId === it.id) { b.fillStyle = rgba(ACC, 0.07); b.fillRect(x + 4, ry, w - 8, r.h); }
        const ink = it.done ? MID : it.overdue ? TONES.coral : this.color;
        pen(b, l, this, r.ring, clamp(a / 0.3, 0, 1), ink, { key: 'r' + it.id, w: 2.4 });
        wrapped(b, r.lines, x + 40, ry + 18, 19, BODY, it.done ? DIM : TEXT, (a - 0.1) / 0.4);
        if (r.when) typed(b, r.when, x + w - 16, ry + 18, SMALL, it.overdue && !it.done ? TONES.coral : DIM, (a - 0.2) / 0.3, { anchor: 'end' });
        if (it.done) {
          const tk = REM.ticked.get(it.id), u = tk != null ? t - tk : 9;
          pen(b, l, this, r.check, clamp(u / 0.2, 0, 1), HOT, { key: 'c' + it.id, w: 2.2 });
          r.strikes.forEach((s, k) => pen(b, l, this, s, clamp((u - 0.1 - k * 0.2) / 0.3, 0, 1), MID, { key: `s${it.id}:${k}`, w: 1.8 }));
        }
        // The item that just changed: its ring pulses once.
        if (REM.flash === it.id && t >= REM.flashAt && t - REM.flashAt < 0.7) {
          const u = (t - REM.flashAt) / 0.7;
          l.save(); l.globalAlpha *= 1 - u; l.strokeStyle = u < 0.3 ? HOT : ink; l.lineWidth = 2; l.beginPath(); l.arc(x + 24, ry + 12, 8 + u * 12, 0, Math.PI * 2); l.stroke(); l.restore();
        }
      }
    } finally { b.restore(); l.restore(); }
  }
  function remRelayout() {
    const c = REM.m, S = scr(), L = remLayout(c.x, c.y);
    // Grown taller than the room below it: up a little, then laid out again where it now sits.
    const y = clamp(c.y, S[1] + 4, Math.max(S[1] + 4, S[3] - L.h - 64));
    if (y !== c.y) { c.y = y; Object.assign(c, remLayout(c.x, c.y)); } else Object.assign(c, L);
    c.__ol = {};
    touch(1.2);
  }
  async function remShow(secs) {
    REM.until = Math.max(REM.until, now() + secs);
    if (remOpen()) { remRelayout(); return; }
    await fontsReady();
    if (remOpen()) { remRelayout(); return; }
    const L0 = remLayout(0, 0), [x, y] = place(REM_W, L0.h, REM_PART);
    const c = REM.m = add({ z: 2, part: REM_PART, local: true, card: true, kind: 'reminders', x, y, cw: 0, ch: 0, p: 1, ready: false, opened: Infinity,
      box() { return [this.x - 4, this.y - 4, REM_W + 8, this.h + 14]; },
      draw: remDraw,
      hits() {
        const { x: cx, y: cy } = this;
        return [...this.rows.filter((r) => r.i).map((r) => ({ rect: [cx, cy + r.y, REM_W, r.h], kind: 'tick', id: r.i.id, done: r.i.done, part: REM_PART })),
          { rect: [cx + REM_W - 28, cy + 2, 26, 22], kind: 'close', part: REM_PART }, { rect: [cx + REM_W - 56, cy + 2, 24, 22], kind: 'pin', part: REM_PART }, { rect: [cx, cy, REM_W - 58, 26], kind: 'drag', part: REM_PART }, { rect: [cx, cy, REM_W, this.h], kind: 'card', part: REM_PART }];
      },
    });
    Object.assign(c, remLayout(x, y));
    sfx('page');
    clearInterval(REM.timer);
    // Stays while the pointer rests on it (or it's being dragged), then fades.
    REM.timer = setInterval(() => {
      if (!remOpen()) { clearInterval(REM.timer); return; }
      if (drag?.part === REM_PART || (G.ptr && inside(markBox(c), G.ptr[0], G.ptr[1]))) REM.until = Math.max(REM.until, now() + 2.5);
      if (now() > REM.until && !c.pinned) remClose(); // pinned: it stays until its ×
    }, 250);
    await tween(0.35, (u) => { const e = ease(u); c.cw = REM_W * e; c.ch = c.h * e; });
    c.ready = true; c.opened = now();
    REM.shown.clear();
    c.rows.filter((r) => r.i).forEach((r, k) => REM.shown.set(r.i.id, c.opened + 0.15 + k * 0.08));
    if (REM.flashAt === -1) REM.flashAt = (REM.shown.get(REM.flash) ?? c.opened) + 0.3;
    touch(2 + c.rows.length * 0.08); syncClearAll();
  }
  function remClose(sound) { if (!remOpen()) return; clearInterval(REM.timer); if (sound) sfx('poof'); REM.until = 0; fadeOut([REM.m]); }
  function reminders(msg = {}) {
    const today = msg.today ?? [], later = msg.later ?? [], all = [...today, ...later], t = now();
    const before = new Map([...REM.data.today, ...REM.data.later].map((i) => [i.id, i]));
    REM.data = { today, later };
    let fresh = false;
    for (const i of all) {
      const was = before.get(i.id);
      if (REM.known && !was) { fresh = true; REM.shown.set(i.id, t); }
      if (was && was.done !== i.done) { if (i.done) { REM.ticked.set(i.id, t); sfx('done'); } else REM.ticked.delete(i.id); }
    }
    const ids = new Set(all.map((i) => i.id));
    for (const map of [REM.shown, REM.ticked, REM.rings, REM.checks]) for (const id of [...map.keys()]) if (!ids.has(id)) map.delete(id);
    for (const key of [...REM.strikes.keys()]) if (!ids.has(key.split(':')[0])) REM.strikes.delete(key);
    if (fresh && remOpen()) sfx('scribble');
    REM.known = true;
    // Not open yet: it pulses once its row has come in.
    if (msg.flash != null) { REM.flash = String(msg.flash); REM.flashAt = remOpen() ? t : -1; }
    if (msg.toggle && remOpen()) return remClose(true);
    if (msg.seconds > 0) return remShow(msg.seconds);
    if (remOpen()) remRelayout();
  }

  // ---------------------------------------------------------------- hit areas: buttons, card close, card drag, links
  let drag = null, hovered = null, sizing = null;
  // Zoom limits for a card: never smaller than 60 %, never bigger than the screen.
  const maxK = (m) => { const S = scr(); return Math.max(1, Math.min((S[2] - S[0] - 16) / (m.w + 8), (S[3] - S[1] - 16) / (m.h + 14))); };
  // Save as image: the card drawn again on its own, at twice the size, glow and all, as a PNG. It's copied to the
  // clipboard where the webview allows it, and always sent to the sidecar, which saves it to Downloads.
  function cardImage(m, scale = 2) {
    const [bx, by, bw, bh] = typeof m.box === 'function' ? m.box() : m.box, pad = 12;
    const make = () => { const c = document.createElement('canvas'); c.width = Math.ceil((bw + pad * 2) * scale); c.height = Math.ceil((bh + pad * 2) * scale); return c; };
    const base = make(), lit = make(), B = base.getContext('2d'), L = lit.getContext('2d');
    for (const c of [B, L]) c.setTransform(scale, 0, 0, scale, (pad - bx) * scale, (pad - by) * scale);
    const keep = { alpha: m.alpha, hover: m.hover, hoverSave: m.hoverSave, hoverClose: m.hoverClose, hoverFull: m.hoverFull, hoverGrip: m.hoverGrip, hoverPin: m.hoverPin };
    Object.assign(m, { alpha: 1, hover: false, hoverSave: false, hoverClose: false, hoverFull: false, hoverGrip: false, hoverPin: false });
    try { m.draw(B, L, now()); } finally { Object.assign(m, keep); }
    B.setTransform(1, 0, 0, 1, 0, 0);
    if (hasFilter) { B.globalAlpha = 0.75; B.filter = `blur(${4 * scale}px)`; B.drawImage(lit, 0, 0); B.filter = 'none'; B.globalAlpha = 1; }
    B.drawImage(lit, 0, 0);
    return base;
  }
  async function saveCard(m, title) {
    sfx('pip');
    let copied = false;
    try {
      const png = cardImage(m), blob = await new Promise((r) => png.toBlob(r, 'image/png'));
      try { if (navigator.clipboard?.write && window.ClipboardItem) { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); copied = true; } } catch { /* the webview didn't allow it */ }
      const data = png.toDataURL('image/png').slice('data:image/png;base64,'.length);
      R.ink.send?.({ type: 'card_image', title: String(title ?? 'card').slice(0, 60), data, copied });
      m.saved = now(); touch(1.3);
    } catch (e) { console.error('ink save', e); }
  }
  // Full screen: the card zooms to fill the screen, centred; again, and it goes back where and how big it was.
  async function toggleFull(m) {
    const from = { k: m.k ?? 1, dx: m.dx, dy: m.dy };
    let to;
    if (m.full) { to = m.before ?? { k: 1, dx: 0, dy: 0 }; m.full = false; m.before = null; }
    else {
      const S = scr(), k = Math.min((S[2] - S[0] - 48) / m.w, (S[3] - S[1] - 48) / m.h);
      m.before = from; m.full = true;
      to = { k, dx: S[0] + (S[2] - S[0] - m.w * k) / 2 - m.ox, dy: S[1] + (S[3] - S[1] - m.h * k) / 2 - m.oy };
    }
    m.z = m.full ? 4 : 2; // full: above the other cards
    sfx(m.full ? 'expand' : 'tick');
    await tween(0.3, (u) => { const e = ease(u); m.k = from.k + (to.k - from.k) * e; m.dx = from.dx + (to.dx - from.dx) * e; m.dy = from.dy + (to.dy - from.dy) * e; });
  }
  const hitAt = (x, y) => {
    for (const m of [...marks].sort((a, b) => b.z - a.z)) {
      if (!m.alive || !m.hits || m.alpha < 0.5) continue;
      for (const h of m.hits()) { const r = xf(m, h.rect); if (inside(r, x, y)) return { ...h, m }; }
    }
    return null;
  };
  const setHover = (h) => {
    const m = h?.m ?? null;
    if (hovered && hovered !== m) { hovered.hover = false; hovered.hoverClose = false; hovered.hoverFull = false; hovered.hoverSave = false; hovered.hoverPin = false; hovered.hoverGrip = false; hovered.hoverId = null; hovered.setHover?.(false); }
    if (m) { m.hover = h.kind === 'button' || h.kind === 'link' || h.kind === 'clearall'; m.hoverClose = h.kind === 'close'; m.hoverFull = h.kind === 'full'; m.hoverSave = h.kind === 'save'; m.hoverPin = h.kind === 'pin'; m.hoverGrip = h.kind === 'resize'; m.hoverId = h.kind === 'tick' || h.kind === 'pick' ? h.id : null; m.setHover?.(h.kind === 'button'); }
    if (hovered !== m || m) touch(0.2);
    hovered = m;
    document.documentElement.style.cursor = h && (h.kind === 'button' || h.kind === 'close' || h.kind === 'full' || h.kind === 'save' || h.kind === 'pin' || h.kind === 'link' || h.kind === 'clearall' || h.kind === 'tick' || h.kind === 'pick') ? 'pointer' : h?.kind === 'drag' ? 'grab' : h?.kind === 'resize' ? 'nwse-resize' : 'default';
  };
  const ours = (e) => !!hitAt(e.clientX, e.clientY) || !!drag || !!sizing;
  addEventListener('pointerdown', (e) => {
    const h = hitAt(e.clientX, e.clientY);
    if (!h) return;
    e.stopPropagation(); e.preventDefault();
    if (h.kind === 'pin') { pinPart(h.part, !h.m.pinned); return; }
    if (h.kind === 'close') { sfx('tick'); if (!h.m.local) R.ink.send?.({ type: 'ink_closed', part: h.part }); fadeOut(partMarks(h.part)); }
    else if (h.kind === 'tick') { sfx(h.done ? 'tick' : 'pip'); REM.until = Math.max(REM.until, now() + 4); R.ink.send?.({ type: 'list_toggle', id: h.id }); }
    else if (h.kind === 'button') { h.m.down = now(); h.m.press?.(); sfx('pip'); touch(0.3); R.ink.send?.({ type: 'ink_action', part: h.part }); }
    else if (h.kind === 'link') { sfx('pip'); R.ink.send?.({ type: 'open_link', url: h.url }); }
    else if (h.kind === 'pick') { h.m.pick?.(h.id); touch(1); }
    else if (h.kind === 'clearall') clearEverything();
    else if (h.kind === 'full') toggleFull(h.m);
    else if (h.kind === 'save') saveCard(h.m, h.title);
    else if (h.kind === 'resize') { sizing = { m: h.m }; sfx('grab'); touch(); }
    // A full-screen card stays up when its body is clicked (there's nothing under it to be after).
    else if (h.kind === 'card' && h.m.full) return;
    // A click on a card's body: they're after what's under it, so the drawing goes, as it does when another window
    // comes to the front (cards move by their top bar). Not a quiz (a click between two options isn't "go away"),
    // and not the reminders card or a drawing that goes by itself, which still move by the body.
    else if (h.kind === 'card' && h.m.keep) return;
    else if (h.kind === 'card' && !h.m.local && !drawnBy.has(h.part)) clearDrawing();
    else if (h.kind === 'drag' || h.kind === 'card') { drag = { part: h.part, x: e.clientX, y: e.clientY, ms: partMarks(h.part), start: partMarks(h.part).map((m) => [m.dx, m.dy]) }; sfx('grab'); touch(); }
  }, true);
  addEventListener('pointermove', (e) => {
    if (drag) { const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.ms.forEach((m, i) => { m.dx = drag.start[i][0] + dx; m.dy = drag.start[i][1] + dy; }); touch(0.2); return; }
    // Resizing: the corner follows the pointer, keeping the card's shape (it zooms from its top left).
    if (sizing) {
      const m = sizing.m, left = m.ox + m.dx, top = m.oy + m.dy;
      m.k = clamp(Math.max((e.clientX - left) / m.w, (e.clientY - top) / m.h), 0.6, maxK(m));
      touch(0.2); return;
    }
    setHover(hitAt(e.clientX, e.clientY));
  }, true);
  addEventListener('pointerup', (e) => { if (drag || sizing) { drag = null; sizing = null; e.stopPropagation(); touch(0.2); } }, true);
  addEventListener('wheel', (e) => {
    if (!ours(e)) return;
    e.stopPropagation();
    // Over a card too tall for the screen: scroll its insides.
    const m = hitAt(e.clientX, e.clientY)?.m;
    if (m?.scrollMax > 0) { e.preventDefault(); m.sy = clamp(m.sy + e.deltaY, 0, m.scrollMax); touch(0.3); }
  }, { capture: true, passive: false });

  // ---------------------------------------------------------------- the host's way in (host.js)
  R.inkHit = (x, y) => !!drag || !!sizing || !!hitAt(x, y);
  // Every clickable area as [x, y, w, h]: Linux hosts make these part of the window's click shape (host.js).
  R.inkRects = () => {
    const out = [];
    for (const m of marks) {
      if (!m.alive || !m.hits || m.alpha < 0.5) continue;
      for (const h of m.hits()) out.push(xf(m, h.rect));
    }
    return out;
  };
  R.ink = {
    send: null, invoke: null,
    // A segment of a drawing from the sidecar: { id, seg, beats, edits, last, win, busy }.
    play(e) { G.q.push(e); pump(); },
    // { screen: true } clears the screen marks (cards stay); otherwise everything but the reminders card, which
    // { all: true } (Esc) takes too. stop: also ends what's playing.
    clear(e = {}) {
      if (e.stop || !e.screen) stop();
      const gone = marks.filter((m) => m.alive && !m.pinned && (e.screen ? m.screen : e.all || !m.local));
      fadeOut(gone);
    },
    // Another window came to the front, or that window moved or closed: the drawing no longer sits on what it was
    // about, so all of it fades (cards too).
    stale() { stop(); fadeOut(marks.filter((m) => m.alive && !m.local && !m.pinned), 0.6); },
    click(x, y) { G.wait?.click(x, y); },
    ptr(x, y) { G.ptr = [x, y]; G.wait?.ptr(x, y); },
    // The reminders list from the sidecar: { today, later, seconds, flash, toggle }. seconds > 0 opens or extends it;
    // 0 only updates it if it's open; toggle closes it if it's open.
    reminders,
    get reminding() { return remOpen(); },
    // Pinned cards stay put on purpose: they don't count, so Esc still sends the Roamie away with one up.
    get busy() { return G.playing || marks.some((m) => m.alive && !m.pinned); },
    get playing() { return G.playing; },
    // Marks still on the real screen (frames, loops, arrows, labels): unlike cards they have no close button.
    get loose() { return marks.some((m) => m.alive && m.screen && !m.leaving); },
    // Resolves once nothing is being drawn (at once if nothing is).
    whenIdle: () => (G.playing || G.q.length ? new Promise((r) => G.idle.push(r)) : Promise.resolve()),
    // Where a card w × h would go now (the web answer card uses it, so it lines up with the drawn ones): [x, y, w, h].
    spot: (w, h) => place(w, h),
    // A rect from the helpers (screen points) in this overlay's coordinates, for game mode (sidebar.js).
    toLocal: (r) => locRect(r),
    sidebarChanged: () => touch(0.5),
  };
})();
