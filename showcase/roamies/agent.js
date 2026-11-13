// Agent layer for the sidekick. Speech, question and listening bubbles, the thinking tag and the task tag are drawn in
// the card look (glass.js) over the LED body; talking, thinking and tools drive the pose, face and voice blips.
// API: agent.say(text) / agent.think(text) return handles with append(), end() and a `closed` promise.
(() => {
  const R = window.Roamie;
  const { clamp, lerp } = R;

  // ---------- dot-matrix glyphs: real font, supersampled, thresholded to two brightness levels ----------
  const CW = 6, CH = 10, SS = 4;
  const glyphs = new Map();
  let gcan = null, gctx = null;
  const glyph = (ch) => {
    let g = glyphs.get(ch);
    if (g) return g;
    if (!gcan) {
      gcan = document.createElement('canvas'); gcan.width = CW * SS; gcan.height = CH * SS;
      gctx = gcan.getContext('2d', { willReadFrequently: true });
    }
    gctx.clearRect(0, 0, gcan.width, gcan.height);
    gctx.fillStyle = '#fff'; gctx.textAlign = 'center'; gctx.textBaseline = 'alphabetic';
    gctx.font = `700 ${9 * SS}px Menlo, "SF Mono", ui-monospace, monospace`;
    gctx.fillText(ch, 2.5 * SS, 8 * SS);
    const px = gctx.getImageData(0, 0, gcan.width, gcan.height).data;
    const pts = [];
    for (let y = 0; y < CH; y++) for (let x = 0; x < CW - 1; x++) {
      let a = 0;
      for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) a += px[((y * SS + j) * gcan.width + x * SS + i) * 4 + 3];
      a /= SS * SS * 255;
      if (a > 0.5) pts.push(x, y, 2); else if (a > 0.26) pts.push(x, y, 1);
    }
    g = pts; glyphs.set(ch, g);
    return g;
  };

  // Emoji: drawn as two cells of coloured LED dots. They take two UTF-16 units (a surrogate pair, or a symbol
  // plus its emoji selector), which is also two columns in the layout, so wrapping and streaming line up.
  const EMOJI = /\p{Extended_Pictographic}/u;
  const emojis = new Map();
  let ecan = null, ectx = null;
  // Returns [x, y, r, g, b, ...] dots on a (2*CW-1) x CH grid, or null if this font can't draw it.
  const emojiGlyph = (cluster) => {
    if (emojis.has(cluster)) return emojis.get(cluster);
    const EW = CW * 2 - 1, S = 8;
    if (!ecan) { ecan = document.createElement('canvas'); ecan.width = EW * S; ecan.height = CH * S; ectx = ecan.getContext('2d', { willReadFrequently: true }); }
    ectx.clearRect(0, 0, ecan.width, ecan.height);
    ectx.textAlign = 'center'; ectx.textBaseline = 'middle';
    ectx.font = `${CH * S * 0.82}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    ectx.fillText(cluster, (EW * S) / 2, (CH * S) / 2 + S * 0.3);
    const px = ectx.getImageData(0, 0, ecan.width, ecan.height).data;
    const pts = [];
    for (let y = 0; y < CH; y++) for (let x = 0; x < EW; x++) {
      let r = 0, g = 0, bl = 0, a = 0;
      for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
        const o = ((y * S + j) * ecan.width + x * S + i) * 4, al = px[o + 3] / 255;
        r += px[o] * al; g += px[o + 1] * al; bl += px[o + 2] * al; a += al;
      }
      if (a / (S * S) > 0.35) pts.push(x, y, Math.round(r / a), Math.round(g / a), Math.round(bl / a));
    }
    const g = pts.length ? pts : null;
    emojis.set(cluster, g);
    return g;
  };
  // At index j of s: the emoji that starts there and how many units it covers, or null.
  const emojiAt = (s, j) => {
    const cp = s.codePointAt(j);
    if (cp == null || !(cp > 0xffff || EMOJI.test(String.fromCodePoint(cp)))) return null;
    const len = (c) => (c > 0xffff ? 2 : 1), ri = (c) => c >= 0x1f1e6 && c <= 0x1f1ff;
    let n = len(cp);
    if (ri(cp) && ri(s.codePointAt(j + 2))) n = 4; // a flag is two regional letters
    for (;;) {
      const c = s.codePointAt(j + n);
      if (c == null) break;
      if (c === 0x200d && s.codePointAt(j + n + 1) != null) n += 1 + len(s.codePointAt(j + n + 1)); // joined: 👨‍👩‍👧
      else if (c === 0xfe0f || c === 0x20e3 || (c >= 0x1f3fb && c <= 0x1f3ff) || (c >= 0xe0020 && c <= 0xe007f)) n += len(c);
      else break;
    }
    const cluster = s.slice(j, j + n);
    if (!EMOJI.test(cluster) && cp <= 0xffff) return null;
    if (!EMOJI.test(cluster) && !ri(cp)) return null; // other astral characters (rare scripts) stay as text
    return { cluster, n };
  };

  const wrap = (text, cols) => {
    const lines = [];
    let i = 0;
    const n = text.length;
    while (i <= n) {
      let end = i, lastSpace = -1;
      while (end < n && text[end] !== '\n' && end - i < cols) { if (text[end] === ' ') lastSpace = end; end++; }
      if (end < n && text[end] !== '\n' && end - i >= cols && lastSpace > i) end = lastSpace;
      // Never cut an emoji (a surrogate pair) across two lines.
      else if (end < n && end > i + 1 && /[\ud800-\udbff]/.test(text[end - 1])) end--;
      lines.push({ start: i, s: text.slice(i, end) });
      if (end >= n) break;
      i = text[end] === ' ' || text[end] === '\n' ? end + 1 : end;
    }
    return lines;
  };
  // The typing caret (an index into the text) as a wrapped line and column, so it's drawn where the next letter goes.
  const caretAt = (lines, caret) => {
    let li = 0;
    while (li + 1 < lines.length && lines[li + 1].start <= caret) li++;
    return { li, col: Math.max(0, Math.min(lines[li]?.s.length ?? 0, caret - (lines[li]?.start ?? 0))) };
  };
  R.caretAt = caretAt;

  // Where the task tag goes: under the body and centred on it (above it when the bubble is below), 8 px inside the
  // visible screen. A bubble beside the body (a permission prompt at the small size: level with the head, growing
  // down) reaches that spot, and the tag covered its Allow button. So while a bubble is open the tag keeps that spot
  // only when it's clear of the bubble, else it takes the first clear one of: under the body moved away from the
  // bubble, above the body, just under the bubble (none clear: the one that overlaps least). The spot it had for this
  // bubble is kept while it stays clear, and an earlier one comes back only once it's clear by twice the gap, so the
  // body's small drifts can't flip it back and forth.
  // tag {w, h}; body {x, y, r}; S: the visible screen {l, t, r, b}; bubble {side, x, y, w, h} or null; had: the spot
  // it took last time for this bubble. Returns the tag's box {x, y, w, h} and its spot.
  const TAG_GAP = 8;
  const tagPlace = ({ w, h }, { x, y, r }, S, bubble, had) => {
    const fit = (tx, ty) => ({ x: clamp(tx, S.l + TAG_GAP, Math.max(S.l + TAG_GAP, S.r - w - TAG_GAP)), y: clamp(ty, S.t + TAG_GAP, Math.max(S.t + TAG_GAP, S.b - h - TAG_GAP)), w, h });
    const under = y + r * 1.32, over = y - r * 1.5 - h;
    const home = fit(x - w / 2, bubble?.side === 'below' ? over : under);
    if (!bubble) return { ...home, spot: 0 };
    const { x: bx, y: by, w: bw, h: bh } = bubble;
    const toRight = bx + bw / 2 >= x; // the bubble's side of the body: the tag moves the other way
    const spots = [
      home,
      fit(toRight ? Math.min(home.x, bx - TAG_GAP - w) : Math.max(home.x, bx + bw + TAG_GAP), under),
      fit(x - w / 2, over),
      fit(x - w / 2, by + bh + TAG_GAP),
    ];
    // How far a spot is from the bubble (negative while they overlap), and how much of it lies within the gap of it.
    const gap = (g) => Math.max(g.x - (bx + bw), bx - (g.x + w), g.y - (by + bh), by - (g.y + h));
    const near = (g) => Math.max(0, Math.min(g.x + w, bx + bw + TAG_GAP) - Math.max(g.x, bx - TAG_GAP)) * Math.max(0, Math.min(g.y + h, by + bh + TAG_GAP) - Math.max(g.y, by - TAG_GAP));
    const clear = (i, margin) => gap(spots[i]) >= margin - 1e-6;
    const kept = spots[had] !== undefined && clear(had, TAG_GAP);
    let spot = kept ? spots.findIndex((_, i) => i < had && clear(i, TAG_GAP * 2)) : spots.findIndex((_, i) => clear(i, TAG_GAP));
    if (spot < 0 && kept) spot = had;
    if (spot < 0) {
      spot = spots.reduce((best, g, i) => (near(g) < near(spots[best]) ? i : best), 0);
      if (spots[had] !== undefined && near(spots[had]) <= near(spots[spot]) + 4) spot = had;
    }
    return { ...spots[spot], spot };
  };
  R.tagPlace = tagPlace;

  const spring = (s, target, k, c, dt) => { s.v += ((target - s.x) * k - s.v * c) * dt; s.x += s.v * dt; return s.x; };
  const sp = (x = 0) => ({ x, v: 0 });
  const deferred = () => { let res; const p = new Promise((r) => (res = r)); p.resolve = res; return p; };

  R.agentPlugin = (k) => {
    const { m, face, PAL, L, th, put, setPx } = k;
    const DARK = PAL[0], EDGE = PAL[Math.max(1, L - 2)], RIM = PAL[L - 1], HOT = PAL[L];
    const css = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
    const tcan = document.createElement('canvas');
    const tctx = tcan.getContext('2d');
    let b = null, dying = [], now = 0, W = 800, H = 600, mouthT = 0, mouthMode = null, gestT = 0;
    let tool = null, lastPose = null, lookAt = null, actUntil = 0, typedAt = -9;
    // Context handed to tool performances (agent-tools.js): timing, sounds and the face; the task tag shows the rest.
    const C = {
      k, sq: k.sq, face, S: k.S,
      get P() { return k.P; }, get R() { return k.R; }, get now() { return now; }, get W() { return W; }, get H() { return H; },
      get bx() { return m.x + (lastPose?.ox ?? 0); },
      get by() { return m.y + (lastPose?.oy ?? 0); },
      look: (x, y) => { lookAt = [x, y]; },
    };

    // Presence: in auto mode the sidekick hides when idle and comes back for anything it has to do.
    const ORDER = ['materialize', 'crt', 'drop'];
    const forcedVariant = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('enter') : null;
    // ptr: the real cursor whenever it's on this screen (even when it hasn't moved for a while), else null.
    const presence = { auto: false, idle: 1.5, summonIdle: 4.5, lastActive: 0, summoned: false, cursor: null, ptr: null, n: 0 };
    let SAFE = R.safe;
    // The visible screen: overlay minus menu bar / Dock / taskbar.
    const bounds = () => ({ l: SAFE.left, t: SAFE.top, r: W - SAFE.right, b: H - SAFE.bottom });

    // Station: the sidekick keeps a home spot and idles around it. When the cursor works nearby it
    // scoots to the closest spot that's clear of the cursor; dropping it somewhere makes that home.
    // byCursor: the cursor position it popped up beside, while it's still there for that request.
    const station = { x: null, y: null, flee: 0, moving: false, quietUntil: 0, held: false, byCursor: null };
    // The pen: while a drawing holds it, the Sidekick is its cursor form and goes only where the drawing moves its
    // tip (no station, following, fleeing, idle acts or native follower). tip: the arrow's tip, in overlay px.
    // home: where it was when taken, to go back to when the cursor isn't on this screen. tw: running moves (resolved on the agent's clock). idle: a
    // little motion while parked on a control (tapping, circling).
    // speed: above 1 when a drawing has fallen behind its voice and is catching up.
    // owner: who took it, a drawing ('ink') or its work in another app ('hand').
    const pen = { held: false, owner: null, tip: [0, 0], home: null, follow: false, tw: [], idle: null, idleAt: 0, reduced: false, v: [0, 0], speed: 1 };
    const AVOID = () => k.R * 5;
    const spotOK = (x, y) => {
      const S = bounds(), r = k.R;
      return x >= S.l + r * 1.6 && x <= S.r - r * 1.6 && y >= S.t + r * 1.8 && y <= S.b - r * 1.5;
    };
    const pickSpot = (cx, cy, fromX, fromY) => {
      const S = bounds(), r = k.R, c = [];
      const xs = [S.l + r * 2.4, (S.l + S.r) / 2, S.r - r * 2.4], ys = [S.t + r * 2.4, (S.t + S.b) / 2, S.b - r * 1.9];
      for (const x of xs) for (const y of ys) if (x !== xs[1] || y !== ys[1]) c.push([x, y]);
      if (fromX != null) for (const rr of [3.5, 5, 7]) for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; c.push([fromX + Math.cos(a) * rr * r, fromY + Math.sin(a) * rr * r]); }
      // Never onto a card or button a drawing left on screen (ink.js), where it would cover what it just drew.
      const onInk = (x, y) => !!R.inkHit && [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]].some(([dx, dy]) => R.inkHit(x + dx * r * 1.2, y + dy * r * 1.2));
      const usable = c.filter(([x, y]) => spotOK(x, y) && !onInk(x, y));
      const clear = usable.filter(([x, y]) => cx == null || Math.hypot(x - cx, y - cy) >= AVOID());
      // Shortest trip from where it is; the very first spot prefers the bottom-right corner.
      const ref = fromX != null ? [fromX, fromY] : [S.r, S.b];
      if (clear.length) return clear.sort((p, q) => Math.hypot(p[0] - ref[0], p[1] - ref[1]) - Math.hypot(q[0] - ref[0], q[1] - ref[1]))[0];
      if (usable.length && cx != null) return usable.sort((p, q) => Math.hypot(q[0] - cx, q[1] - cy) - Math.hypot(p[0] - cx, p[1] - cy))[0];
      // Nowhere better (cards fill the free space): stay where it is rather than jump to the middle of the screen.
      if (fromX != null && spotOK(fromX, fromY)) return [fromX, fromY];
      return [(S.l + S.r) / 2, (S.t + S.b) / 2];
    };
    const setStation = (x, y, byCursor = null) => { station.x = x; station.y = y; station.byCursor = byCursor; m.anchor = { x, y, r: k.R * 0.35 }; };
    // Pop up right beside the cursor, like a buddy at your elbow: to its right and a little below the tip
    // (the arrow's body points down-right), else its left, else above or below. Bubbles then open on the
    // side away from the cursor, so whatever it's pointing at stays visible.
    const besideCursor = (side = 'right', at = presence.ptr) => {
      const p = at;
      if (!p) return null;
      const [cx, cy] = p, rad = m.radius, gx = rad + 22;
      const R0 = [[cx + gx, cy + rad * 0.45], [cx + gx, cy - rad * 0.9]], L0 = [[cx - gx, cy + rad * 0.45], [cx - gx, cy - rad * 0.9]];
      const c = [...(side === 'left' ? [L0[0], R0[0], L0[1], R0[1]] : [R0[0], L0[0], R0[1], L0[1]]), [cx + 10, cy + rad + 34], [cx, cy - rad - 18]];
      const ok = c.find(([x, y]) => spotOK(x, y));
      if (ok) return ok;
      const S = bounds(), r = k.R;
      return [clamp(c[0][0], S.l + r * 1.6, S.r - r * 1.6), clamp(c[0][1], S.t + r * 1.8, S.b - r * 1.5)];
    };
    // Following the cursor (after popping up beside it): every display frame it
    // aims at the cursor plus an offset and gets there through a stiff, critically damped spring, which rounds off
    // sudden flicks without wobbling. A slow, deliberate move onto it (or its bubble) holds it still.
    // side: which side of the cursor it keeps (1 right, -1 left): chosen when it
    // appears, kept through pauses (reaching for its bubble) and only swapped at a screen edge. keep: it's been
    // chosen for this appearance.
    const fol = { on: false, ox: 0, oy: 0, side: 1, keep: false, high: false, hold: 0, reach: 0, rest: 0, x: 0, y: 0, vx: 0, vy: 0 };
    const FOLLOW_W = 90;
    // The follow rules, shared with the native follower (buddy.swift) so a handover lands in the same place.
    const folRules = () => {
      const rr = m.radius, r = k.R;
      return { gx: rr + 22, room: r * 1.6, low: rr * 0.45, highY: -rr * 0.9, bot: r * 1.5, pad: rr * 0.6 };
    };
    const followHold = (p) => {
      const sp = Math.hypot(env0.mouse.vx ?? 0, env0.mouse.vy ?? 0);
      // Only the bubble counts, not the body: it sits right beside the cursor, so heading its way is just moving
      // the cursor, and holding still for that let the cursor slide past it (it then seemed to swap sides).
      const open = b && !b.closing;
      const x0 = open ? b.x.x : 0, x1 = open ? b.x.x + b.w.x : 0, y0 = open ? b.y.x : 0, y1 = open ? b.y.x + b.h.x : 0;
      const nx = open ? clamp(p[0], x0, x1) - p[0] : 1e4, ny = open ? clamp(p[1], y0, y1) - p[1] : 0, dz = Math.hypot(nx, ny);
      const typing = b?.input && !b.input.listen;
      // Reaching for a reply bubble: a slow, steady move towards it for a moment, or resting on it.
      // Thinking bubbles have nothing to click, so they never hold it.
      const toward = dz > 0 ? ((env0.mouse.vx ?? 0) * nx + (env0.mouse.vy ?? 0) * ny) / dz : 0;
      const something = (b && !b.closing && b.kind !== 'thought' && !b.input?.listen);
      fol.reach = something && dz < 100 && toward > 40 && sp < 320 ? fol.reach + env0.dt : Math.max(0, fol.reach - env0.dt * 2);
      // Resting on it for a moment (not just passing over it after a fast flick).
      fol.rest = something && dz === 0 && sp < 200 ? fol.rest + env0.dt : 0;
      const onIt = fol.rest > 0.2;
      return fol.reach > 0.15 || onIt || typing || R.panelHit?.(p[0], p[1]);
    };
    const env0 = { mouse: {}, dt: 0 };
    // From the tip to the body point: the cursor form's arrow tip sits up and left of it. The same offset in every form,
    // so the body doesn't jump when it turns into the cursor while held.
    const tipOff = () => k.tip ?? [0, 0];
    const penEase = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
    // A hand's pace: a gentle start and finish, steady in between.
    const penSmooth = (u) => { const a = 0.18; return u < a ? (u * u) / (2 * a * (1 - a)) : u > 1 - a ? 1 - ((1 - u) ** 2) / (2 * a * (1 - a)) : (u - a / 2) / (1 - a); };
    const penTween = (dur, f) => new Promise((res) => {
      // Not held (hidden with Esc, say): nothing moves it, so a move finishes at once instead of never.
      if (pen.reduced || dur <= 0 || !pen.held) { f(1); res(); return; }
      pen.tw.push({ t0: null, dur: dur / pen.speed, f, res });
    });
    const penWait = (sec) => penTween(sec, () => {});
    const penAt = (pts, u) => {
      const f = clamp(u, 0, 1) * (pts.length - 1), i = Math.floor(f), q = f - i, a = pts[i], c = pts[Math.min(i + 1, pts.length - 1)];
      return [lerp(a[0], c[0], q), lerp(a[1], c[1], q)];
    };
    // Travel: one smooth glide that speeds up and settles, curving a little like a wrist, never a snap.
    const penFly = (x, y) => {
      pen.idle = null;
      const [x0, y0] = pen.tip, d = Math.hypot(x - x0, y - y0);
      if (d < 2) return Promise.resolve();
      const dur = clamp(0.16 + d / 2600, 0.18, 0.5), c = [(x0 + x) / 2 - (y - y0) * 0.1, (y0 + y) / 2 + (x - x0) * 0.08];
      return penTween(dur, (u) => { const e = penEase(u); pen.tip = [(1 - e) ** 2 * x0 + 2 * (1 - e) * e * c[0] + e * e * x, (1 - e) ** 2 * y0 + 2 * (1 - e) * e * c[1] + e * e * y]; });
    };
    const penRelease = () => { pen.held = false; pen.owner = null; pen.idle = null; for (const t of pen.tw) t.res(); pen.tw = []; if (m.drive === penDrive) m.drive = null; };
    const penDrive = (dt) => {
      const [ox, oy] = tipOff(), x = pen.tip[0] + ox, y = pen.tip[1] + oy;
      if (dt > 0) { m.vx = (x - m.x) / dt; m.vy = (y - m.y) / dt; }
      m.x = x; m.y = y; m.tx = x; m.ty = y; m.mode = 'rest'; m.rest = 1;
    };
    const drive = (dt, env) => {
      const p = [env.mouse.x, env.mouse.y], S = bounds(), F = folRules();
      if (!fol.on) {
        fol.on = true; fol.ox = m.x - p[0]; fol.oy = m.y - p[1];
        // Starting again after a pause: back to the side it had, not whichever side the cursor left it on.
        if (!fol.keep) { fol.side = fol.ox < 0 ? -1 : 1; fol.keep = true; }
        fol.x = m.x; fol.y = m.y; fol.vx = fol.vy = 0;
      }
      // Side: stays put until that side runs out of screen, so fast moves never flip it back and forth.
      if (fol.side > 0 && p[0] + F.gx > S.r - F.room) fol.side = -1;
      else if (fol.side < 0 && p[0] - F.gx < S.l + F.room) fol.side = 1;
      if (!fol.high && p[1] + F.low > S.b - F.bot) fol.high = true;
      else if (fol.high && p[1] + F.low < S.b - F.bot - 40) fol.high = false;
      const tx = fol.side * F.gx, ty = fol.high ? F.highY : F.low;
      const k1 = 1 - Math.exp(-dt / 0.07);
      fol.ox += (tx - fol.ox) * k1; fol.oy += (ty - fol.oy) * k1;
      const gx2 = clamp(p[0] + fol.ox, S.l + F.pad, S.r - F.pad), gy2 = clamp(p[1] + fol.oy, S.t + F.pad, S.b - F.pad);
      // Exact critically damped step, so it's stable at any frame time.
      const e = Math.exp(-FOLLOW_W * dt);
      const sx = fol.x - gx2, tvx = (fol.vx + FOLLOW_W * sx) * dt;
      fol.vx = (fol.vx - FOLLOW_W * tvx) * e; fol.x = gx2 + (sx + tvx) * e;
      const sy = fol.y - gy2, tvy = (fol.vy + FOLLOW_W * sy) * dt;
      fol.vy = (fol.vy - FOLLOW_W * tvy) * e; fol.y = gy2 + (sy + tvy) * e;
      m.vx = fol.vx; m.vy = fol.vy;
      m.x = fol.x; m.y = fol.y; m.tx = gx2; m.ty = gy2; m.mode = 'rest'; m.rest = 1;
    };
    // macOS: while it only follows the cursor in its cursor form (nothing open, nothing playing), the voice helper
    // draws it on the display's clock (buddy.swift) and this page stops repainting. Anything else takes it back at once;
    // until the helper says it's drawing, the page keeps drawing too, so there's never a gap.
    const nat = { on: false, ask: 0, askAt: 0, ok: 0, back: 0, n: 0 };
    const onBuddy = (e) => {
      if (e.state === 'shown' && nat.ask && e.id === nat.ask) { nat.on = true; nat.ask = 0; m.native = true; }
      else if (e.state === 'gone') { nat.on = false; nat.ask = 0; m.native = false; nat.back = now + 5; }
      // Hidden without being asked (the page always lets go first when it asks): draw it here again.
      else if (e.state === 'hidden' && nat.on) { nat.on = false; m.native = false; nat.back = now + 1; }
    };
    const nativeStep = (dt, self) => {
      const B = R.buddy;
      if (!B) return;
      if (B.onEvent !== onBuddy) B.onEvent = onBuddy;
      const ok = B.available() && k.form === 'cursor' && k.presence === 'shown' && !!m.drive && !pen.held && !station.moving
        && !!self.quiet?.() && !!k.calmBody?.();
      nat.ok = ok ? nat.ok + dt : 0;
      if (!ok) {
        if (nat.on || nat.ask) { B.hide(); nat.on = false; nat.ask = 0; m.native = false; }
        return;
      }
      if (nat.on) return;
      if (nat.ask) {
        // No word back: draw it here, and leave the helper alone for a while.
        if (now - nat.askAt > 0.8) { B.hide(); nat.ask = 0; nat.back = now + 10; }
        return;
      }
      if (nat.ok < 0.15 || now < nat.back) return;
      const img = k.sprite?.();
      if (!img) return;
      nat.ask = ++nat.n; nat.askAt = now;
      B.show({ id: nat.ask, x: m.x, y: m.y, vx: m.vx, vy: m.vy, ox: fol.ox, oy: fol.oy, side: fol.side, high: fol.high, ...folRules(), ...bounds(), img });
    };
    const follow = (env, dt) => {
      const p = presence.ptr;
      env0.mouse = env.mouse; env0.dt = dt;
      if (followHold(p)) fol.hold = now + 0.2;
      if (now < fol.hold) { fol.on = false; m.drive = null; return; }
      m.drive = drive;
      setStation(m.x, m.y, p.slice());
      station.moving = station.rush = false;
    };

    // A new request (talking, typing, summoning): come over to the cursor if it's somewhere else now.
    const comeToCursor = () => {
      if (R.sidebar?.on) return; // game mode: it stays in its panel
      const p = presence.ptr;
      if (!p || !visible() || pen.held || m.dragging || m.flung) return;
      if (station.byCursor && Math.hypot(p[0] - station.byCursor[0], p[1] - station.byCursor[1]) < k.R * 2.5) return;
      const [x, y] = besideCursor(fol.keep && fol.side < 0 ? 'left' : 'right');
      setStation(x, y, p.slice()); m.goTo(x, y);
      station.moving = true; station.rush = true; station.flee = 0; station.quietUntil = now + 4;
    };
    const nextVariant = () => (ORDER.includes(forcedVariant) ? forcedVariant : ORDER[presence.n++ % ORDER.length]);
    // Popping up at the cursor: in place (materialize or crt), never dropping in from the top of the screen.
    const entrance = () => { let v = nextVariant(); if (v === 'drop' && station.byCursor && !forcedVariant) v = nextVariant(); return v; };
    const visible = () => k.presence === 'shown' || k.presence === 'in';
    // Bubbles and tools wait until the body has (nearly) arrived.
    const stage = () => k.presence === 'shown' || (k.presence === 'in' && k.presU > 0.72);
    // Appear beside the cursor. With the cursor on another screen: at home, unless the cursor is there
    // now, then at the nearest spot that's clear of it.
    const spot = () => {
      // Game mode (sidebar.js): at the top of the panel at the screen's edge, never beside a cursor that isn't there.
      const dock = R.sidebar?.dock?.();
      if (dock) { setStation(dock[0], dock[1]); station.atDock = true; return dock; }
      const near = besideCursor();
      if (near) { setStation(near[0], near[1], presence.ptr.slice()); station.quietUntil = now + 4; return near; }
      const [cx, cy] = presence.cursor ?? [null, null];
      const clearOf = (x, y) => cx == null || Math.hypot(x - cx, y - cy) >= AVOID();
      if (station.x != null && spotOK(station.x, station.y) && clearOf(station.x, station.y)) return [station.x, station.y];
      const p = pickSpot(cx, cy, station.x, station.y);
      setStation(p[0], p[1]);
      return p;
    };
    const ensureShown = () => {
      presence.lastActive = now;
      if (visible()) return;
      fol.keep = false; // a new appearance picks its side afresh
      const [x, y] = spot();
      k.appear(entrance(), x, y);
    };
    const MAX_COLS = 38, MAX_LINES = 7, THINK_COLS = 28, THINK_LINES = 1, METER = 7;
    // Bubble text: Martian Mono (0.7 em per letter), sized to the bubble's line grid.
    const fontPx = (t) => Math.round(CH * t * 0.64 * 2) / 2;
    const colW = (t) => fontPx(t) * 0.7 + 0.35;
    const TEXT_INK = '#dcfff6', TEXT_ACCENT = '#78ffe2';
    const T = () => clamp(k.P * 0.42, 1.4, 2.4);
    const G = R.glass;
    // Padding inside a bubble. The thinking tag is slim, one line, with its three dots before the words.
    const DOTS_W = 24;
    const padX = (bb) => (bb.kind === 'thought' ? 13 : k.P * 3), padY = (bb) => (bb.kind === 'thought' ? 5 : k.P * 3);
    const dotsDx = (bb) => (bb.kind === 'thought' && bb.text ? DOTS_W + 10 : 0);
    // Under a question: how to answer it.
    const HINT = 'enter to send · esc to skip', HINT_F = `400 11px ${G.MONO}`, HINT_H = 18;
    const hintH = (bb) => (bb.input && !bb.input.listen && !bb.input.choices ? HINT_H : 0);
    // A yes/no question: its buttons sit in a row under it instead of the hint.
    const CHOICE_GAP = 8, CHOICE_TOP = 12;
    const choicesW = (bb) => bb.input.choices.labels.reduce((s, l, i) => s + G.chipW(l) + (i ? CHOICE_GAP : 0), 0);
    const footH = (bb) => (bb.input?.choices ? CHOICE_TOP + G.CHIP_H + 4 : hintH(bb));

    const make = (kind) => ({
      kind, text: '', lines: [{ start: 0, s: '' }], shown: 0, at: [], ended: false, age: 0, wait: 0,
      x: sp(m.x - 40), y: sp(m.y - k.R * 2), w: sp(k.P * 6), h: sp(k.P * 4), pop: sp(0), cloud: sp(kind === 'thought' ? 1 : 0),
      scroll: sp(0), follow: true, expanded: false, closing: 0, dwell: 0, hover: false, trail: 0, mood: null,
      tail: { x: sp(m.x), y: sp(m.y) }, below: false, closed: deferred(), revealed: deferred(), speed: kind === 'thought' ? 75 : 38,
    });

    const handle = (bb) => ({
      append(s) {
        if (bb.ended) return this;
        // Markdown: the bubble shows the text without its markers, each letter carrying its style.
        bb.raw = (bb.raw ?? '') + s;
        const f = R.md ? R.md.flat(bb.raw) : { s: bb.raw, sty: null };
        bb.text = f.s; bb.sty = f.sty;
        bb.lines = wrap(bb.text, bb.kind === 'thought' ? THINK_COLS : MAX_COLS);
        return this;
      },
      end() { bb.ended = true; return this; },
      get closed() { return bb.closed; },
      get revealed() { return bb.revealed; },
    });

    const open = (kind, text, opts = {}) => {
      if (b && kind === 'speech' && b.kind === 'thought' && !b.closing) {
        // Morph the thought cloud straight into the speech bubble.
        b.kind = 'speech'; b.text = ''; b.raw = ''; b.sty = null; b.lines = [{ start: 0, s: '' }]; b.shown = 0; b.at = []; b.ended = false;
        b.speed = 38; b.scroll = sp(0); b.follow = true; b.dwell = 0; b.wait = 0.12;
        const old = b.closed; b.closed = deferred(); b.revealed = deferred(); old.resolve();
        b.pop.v += 4;
      } else {
        if (b) close(b);
        b = make(kind);
        const tip = tipPoint();
        b.x.x = tip.x - k.P * 4; b.y.x = tip.y - k.P * 6; b.tail.x.x = tip.x; b.tail.y.x = tip.y;
        k.S('pop');
      }
      b.mood = opts.mood ?? null;
      // point: hand target in body radii (e.g. [0.3, -1.6] points up) held while the bubble is open.
      b.point = opts.point ?? null;
      if (b.mood === 'happy') face.set('happy', 0.9);
      const h = handle(b);
      if (text) h.append(text);
      if (!opts.stream) h.end();
      return h;
    };

    const close = (bb) => {
      if (bb.closing) return;
      bb.closing = 0.0001;
      dying.push(bb);
      if (b === bb) b = null;
      k.S('poof');
    };

    const tipPoint = () => ({ x: m.x + Math.sign((b?.x.x ?? m.x) + (b?.w.x ?? 0) / 2 - m.x) * k.R * 0.25, y: b?.below ? m.y + k.R * 0.95 : m.y - k.R * 1.02 });

    // ---- layout targets ----
    const innerSize = (bb) => {
      const t = T();
      if (bb.kind === 'thought' && !bb.text) return { cols: 4, rows: 1, w: DOTS_W + 6, h: CH * t };
      const maxCols = bb.kind === 'thought' ? THINK_COLS : bb.expanded ? Math.min(72, Math.floor((W - 80) / colW(t))) : MAX_COLS;
      const maxRows = bb.kind === 'thought' ? THINK_LINES : bb.expanded ? Math.max(MAX_LINES, Math.floor((H * 0.62) / (CH * t))) : MAX_LINES;
      if (bb.input) {
        const src = bb.text ? bb.lines : wrap(bb.input.placeholder || ' ', MAX_COLS);
        // A live transcript arrives in jumps, so its bubble is full width from the start and only grows down.
        let cols = bb.input.listen ? MAX_COLS : 18;
        for (const l of src) cols = Math.max(cols, Math.min(l.s.length + 1, MAX_COLS));
        const rows = clamp(src.length, 1, MAX_LINES);
        const meter = bb.input.listen ? (METER + 1) * k.P : 0;
        const footW = bb.input.choices ? choicesW(bb) : hintH(bb) ? G.textW(HINT, HINT_F) : 0;
        return { cols, rows, maxRows: MAX_LINES, w: Math.max(cols * colW(t), footW), h: rows * CH * t + meter + footH(bb) };
      }
      const shownLines = bb.lines.filter((l) => l.start < Math.max(1, bb.shown) || l === bb.lines[0]);
      let cols = 4;
      for (const l of (bb.expanded ? bb.lines : shownLines)) cols = Math.max(cols, Math.min(l.s.length, maxCols));
      if (bb.lines.length > 1) cols = Math.max(cols, Math.min(maxCols, 18));
      const rows = clamp(bb.expanded ? bb.lines.length : shownLines.length, 1, maxRows);
      return { cols, rows, maxRows, w: cols * colW(t) + dotsDx(bb), h: rows * CH * t };
    };

    const step = (bb, dt, env) => {
      bb.age += dt;
      const P = k.P;
      // reveal
      if (bb.wait > 0) bb.wait -= dt;
      else if (bb.shown < bb.text.length) {
        const backlog = bb.text.length - bb.shown;
        const speed = bb.speed * (backlog > 120 ? 3 : backlog > 50 ? 1.6 : 1) * (bb.expanded ? 3 : 1);
        const before = Math.floor(bb.shown);
        bb.shown = Math.min(bb.text.length, bb.shown + speed * dt);
        for (let i = before; i < Math.floor(bb.shown); i++) {
          bb.at[i] = now;
          const ch = bb.text[i];
          if (bb.kind === 'speech') {
            if ('.!?'.includes(ch)) bb.wait = 0.2; else if (ch === ',') bb.wait = 0.08; else if (ch === '\n') bb.wait = 0.25;
            if (ch === '!') { k.sq.kick(3); bb.pop.v += 2.5; }
            if (/[aeiouy]/i.test(ch)) k.S('blip', 0.85 + (ch.charCodeAt(0) % 7) * 0.06);
            mouthMode = /[aeiouAEIOU]/.test(ch) ? (/[oO]/.test(ch) ? 'talk2' : 'talk1') : /\s/.test(ch) ? null : 'flat';
            mouthT = 0.09;
          } else if (i % 9 === 0) k.S('tick');
          if (bb.wait) break;
        }
      } else if (bb.text.length && Math.floor(bb.shown) >= bb.text.length) {
        bb.revealed.resolve();
      }
      const done = bb.ended && bb.shown >= bb.text.length;
      const inner = innerSize(bb);
      const tw = Math.ceil(inner.w + padX(bb) * 2), thh = Math.ceil(inner.h + padY(bb) * 2);
      // Input bubbles track their text tightly (near-critical damping) so new lines never outrun the frame. Speech
      // grows critically damped too: an overshoot as each line arrives bobbed the text up and down mid-read.
      const [sk, sc] = bb.input ? [460, 42] : [190, 28];
      spring(bb.w, tw, sk, sc, dt); spring(bb.h, thh, sk, sc, dt);
      spring(bb.pop, bb.closing ? 0 : 1, 240, 15, dt);
      spring(bb.cloud, bb.kind === 'thought' ? 1 : 0, 120, 13, dt);
      // scroll: follow the newest line while speaking
      const totalLines = bb.lines.filter((l) => l.start <= bb.shown).length;
      const maxScroll = Math.max(0, (bb.expanded ? bb.lines.length : totalLines) - inner.rows);
      if (bb.follow) bb.scrollTarget = maxScroll;
      // Typing: keep the caret's line in view, wherever it's been moved to.
      if (bb.input && !bb.input.listen && bb.text) { const { li } = caretAt(bb.lines, bb.input.caret ?? bb.text.length); bb.scrollTarget = clamp(bb.scrollTarget ?? 0, li - inner.rows + 1, li); }
      bb.scrollTarget = clamp(bb.scrollTarget ?? 0, 0, Math.max(0, bb.lines.length - inner.rows));
      spring(bb.scroll, bb.scrollTarget, bb.input ? 300 : 120, bb.input ? 34 : 18, dt);
      bb.overflow = bb.lines.length > inner.rows;
      bb.rows = inner.rows; bb.cols = inner.cols;
      // Placement: above the head, else below, else beside; always fully inside the visible screen.
      // The thinking tag sits where the reply will open, so it turns into the reply without moving.
      const S = bounds(), edge = P * 2 + 4, gap = k.R * 0.5 + P * 2;
      const w = bb.w.x, h = bb.h.x, L0 = S.l + edge, T0 = S.t + edge, R0 = S.r - edge, B0 = S.b - edge;
      // The text holds still to be read: the body's small drifts while it idles and talks don't move the bubble
      // (each one jumped the text a whole cell). It moves once the body really has, or rides with it while it's
      // carried along with the cursor.
      if (bb.ax == null || m.drive || Math.hypot(m.x - bb.ax, m.y - bb.ay) > k.R * 0.6) { bb.ax = m.x; bb.ay = m.y; }
      const ax = bb.ax, ay = bb.ay;
      const skew = clamp((ax - W / 2) * -0.15, -w * 0.3, w * 0.3);
      const place = {
        above: { x: ax - w / 2 + skew, y: ay - k.R * 1.1 - gap - h },
        below: { x: ax - w / 2 + skew, y: ay + k.R * 1.1 + gap },
        // Beside it, the top stays put level with its head and the bubble grows down: centred on it, every new
        // line pushed the whole bubble (and what you're reading) up by half a line.
        right: { x: ax + k.R * 1.2 + gap, y: ay - k.R * 0.95 },
        left: { x: ax - k.R * 1.2 - gap - w, y: ay - k.R * 0.95 },
      };
      const fits = (sd, slack = 0) => {
        const c = place[sd];
        return sd === 'above' || sd === 'below' ? c.y >= T0 - slack && c.y + h <= B0 + slack : c.x >= L0 - slack && c.x + w <= R0 + slack;
      };
      const roomRight = m.x < (S.l + S.r) / 2;
      // Beside the cursor: open away from it first, so the bubble never covers what the cursor is on. Following,
      // that's the side it keeps (fol.side), not where it is this instant: a fast flick can carry the cursor past
      // it for a moment, which used to swing the bubble across and back.
      const away = station.byCursor ? (m.drive && fol.keep ? (fol.side > 0 ? 'right' : 'left') : m.x >= station.byCursor[0] ? 'right' : 'left') : null;
      const order = away ? [away, 'above', 'below', away === 'right' ? 'left' : 'right'] : ['above', 'below', roomRight ? 'right' : 'left', roomRight ? 'left' : 'right'];
      // Keep the current side while it still fits, so the bubble doesn't flicker between sides; it changes only
      // when it would run off the screen. Pushed off its first choice by an edge, it goes back once there's clear
      // room again (not the moment it just fits, which flickered at the edge).
      if (!bb.side || bb.order !== order[0] || !fits(bb.side, P * 2)) {
        bb.order = order[0];
        bb.side = order.find((sd) => fits(sd)) ?? (m.y - T0 > B0 - m.y ? 'above' : 'below');
      } else if (bb.side !== order[0] && fits(order[0], -P * 6)) bb.side = order[0];
      bb.below = bb.side === 'below';
      const tgt = place[bb.side], maxX = Math.max(L0, R0 - w), maxY = Math.max(T0, B0 - h);
      // Following the cursor: carry the bubble along with the body exactly, so it can't trail or wobble.
      if (m.drive && bb.mx != null) {
        const ddx = m.x - bb.mx, ddy = m.y - bb.my;
        bb.x.x += ddx; bb.y.x += ddy; bb.tail.x.x += ddx; bb.tail.y.x += ddy;
      }
      bb.mx = m.x; bb.my = m.y;
      // It opens where it belongs (its pop-in is the entrance), rather than sliding there and overshooting.
      if (!bb.placed) { bb.placed = true; bb.x.x = clamp(tgt.x, L0, maxX); bb.y.x = clamp(tgt.y, T0, maxY); bb.x.v = bb.y.v = 0; }
      spring(bb.x, clamp(tgt.x, L0, maxX), 70, 17, dt); spring(bb.y, clamp(tgt.y, T0, maxY), 70, 17, dt);
      // Hard clamp after the spring: lag or overshoot must never push it past the edge.
      bb.x.x = clamp(bb.x.x, L0, maxX); bb.y.x = clamp(bb.y.x, T0, maxY);
      const beside = bb.side === 'left' || bb.side === 'right';
      const tip = beside
        ? { x: m.x + (bb.side === 'right' ? 1 : -1) * k.R * 0.92, y: m.y - k.R * 0.25 }
        : { x: m.x + clamp((bb.x.x + w / 2 - m.x) * 0.25, -k.R * 0.4, k.R * 0.4), y: bb.below ? m.y + k.R * 0.95 : m.y - k.R * 0.98 };
      spring(bb.tail.x, tip.x, 90, 9, dt); spring(bb.tail.y, tip.y, 90, 9, dt);
      bb.trail = clamp(bb.trail + dt * (bb.kind === 'thought' ? 3 : -4), 0, 1);
      // lifetime
      if (bb.closing) { bb.closing += dt; return; }
      if (done) {
        if (!bb.hover && !bb.expanded && !R.voiceOut?.playing()) bb.dwell += dt;
        const linger = clamp(1.1 + bb.text.length * 0.015, 1.3, bb.overflow ? 8 : 4.5);
        if (bb.kind === 'speech' && bb.dwell > linger) close(bb);
        if (bb.kind === 'thought' && bb.dwell > 0.4) close(bb);
      }
    };

    // ---- bubbles: the card look, with a stepped tail to the body (or, thinking, two little steps up from it) ----
    // The frame as drawn this instant: it pops in and out around the point its tail comes from.
    const bubbleBox = (bb) => {
      const pop = clamp(bb.pop.x, 0, 1.08), beside = bb.side === 'left' || bb.side === 'right';
      const ax = beside ? (bb.side === 'right' ? bb.x.x : bb.x.x + bb.w.x) : bb.tail.x.x;
      const ay = beside ? clamp(bb.tail.y.x, bb.y.x, bb.y.x + bb.h.x) : bb.below ? bb.y.x : bb.y.x + bb.h.x;
      const X = (v) => ax + (v - ax) * pop, Y = (v) => ay + (v - ay) * pop, x = X(bb.x.x), y = Y(bb.y.x);
      return { x, y, w: X(bb.x.x + bb.w.x) - x, h: Y(bb.y.x + bb.h.x) - y };
    };
    const TAIL_SIDE = { above: 'bottom', below: 'top', right: 'left', left: 'right' };
    const drawBubble = (ctx, bb) => {
      const fade = bb.closing ? clamp(1 - bb.closing / 0.3, 0, 1) : clamp(bb.age / 0.22, 0, 1);
      const f = (bb.frame = bubbleBox(bb));
      if (fade <= 0 || f.w < 12 || f.h < 10) return;
      const P = k.P, tip = [bb.tail.x.x, bb.tail.y.x], side = TAIL_SIDE[bb.side] ?? 'bottom', across = side === 'top' || side === 'bottom';
      const speechTail = 1 - bb.cloud.x;
      ctx.save();
      ctx.globalAlpha *= fade;
      if (bb.cloud.x > 0.05) {
        const base = across ? [clamp(tip[0], f.x + 12, f.x + f.w - 12), side === 'top' ? f.y : f.y + f.h] : [side === 'left' ? f.x : f.x + f.w, clamp(tip[1], f.y + 8, f.y + f.h - 8)];
        [[0.32, 8], [0.7, 5]].forEach(([u, sz], i) => {
          if (bb.trail < i * 0.3) return;
          const s = sz * bb.cloud.x, cx = base[0] + (tip[0] - base[0]) * u, cy = base[1] + (tip[1] - base[1]) * u;
          G.chrome(ctx, cx - s / 2, cy - s / 2, s, s, { corner: i ? 1 : 2, glint: false });
        });
      }
      const tail = speechTail > 0.05 ? { side, at: across ? tip[0] : tip[1], to: tip, w: 14 * speechTail } : null;
      G.chrome(ctx, f.x, f.y, f.w, f.h, { tail });
      // A light running along the top edge while words arrive or it waits for typing.
      const streaming = bb.kind !== 'thought' && (bb.shown < bb.text.length || (bb.input?.focused && !bb.input.processing && !bb.closing));
      if (streaming && f.w > 40) {
        const run = f.w - 32, u = pen.reduced ? 0.4 : (now * 0.8) % 1;
        ctx.save(); ctx.shadowColor = G.rgba(G.ACC, 0.8); ctx.shadowBlur = 6; ctx.fillStyle = G.HOT;
        ctx.fillRect(f.x + 8 + run * u, f.y - 0.25, 16, 1.5); ctx.restore();
      }
      // Thinking: three small squares, one lit at a time; before the words when there are any.
      if (bb.kind === 'thought' && bb.cloud.x > 0.3) {
        const dx = bb.text ? f.x + padX(bb) : f.x + (f.w - DOTS_W) / 2, cy = f.y + f.h / 2, lit = Math.floor(now * 5) % 3;
        for (let i = 0; i < 3; i++) {
          const on = i === lit;
          ctx.save();
          if (on) { ctx.shadowColor = G.rgba(G.ACC, 0.8); ctx.shadowBlur = 6; } else ctx.globalAlpha *= 0.55;
          ctx.fillStyle = on ? G.ACC : G.MID; ctx.fillRect(Math.round(dx + i * 10), Math.round(cy - 2 - (on ? 1.5 : 0)), 4, 4);
          ctx.restore();
        }
      }
      // Listening: the voice level as thin glowing bars under the transcript, a sweep while it's finished off.
      if (bb.input?.listen) {
        const inp = bb.input, mh = METER * P, x0 = f.x + padX(bb), x1 = f.x + f.w - padX(bb), bot = f.y + f.h - padY(bb);
        const n = Math.max(1, Math.floor((x1 - x0) / 5));
        while (inp.levels.length < n) inp.levels.unshift(0);
        if (inp.levels.length > n) inp.levels.splice(0, inp.levels.length - n);
        ctx.save(); ctx.shadowColor = G.rgba(G.ACC, 0.6); ctx.shadowBlur = 4; ctx.fillStyle = G.ACC;
        for (let i = 0; i < n; i++) {
          let v = inp.levels[i];
          if (inp.processing) v = 0.15 + 0.7 * Math.max(0, Math.sin(now * 9 - i * 0.55)) ** 3;
          const bh = Math.max(2, v * mh);
          ctx.fillRect(x0 + i * 5, bot - bh, 2, bh);
        }
        ctx.restore();
      }
      if (hintH(bb) && bb.pop.x > 0.6) G.typed(ctx, HINT, f.x + padX(bb), f.y + f.h - padY(bb) - HINT_H / 2 + 2, HINT_F, G.DIM);
      const ch = bb.input?.choices;
      if (ch) {
        ch.rects = [];
        if (bb.pop.x > 0.6 && !bb.closing) {
          let x = f.x + padX(bb);
          const y = f.y + f.h - padY(bb) - G.CHIP_H - 4;
          ch.labels.forEach((l, i) => {
            const w = G.chipW(l);
            G.chip(ctx, x, y, w, G.CHIP_H, l, { filled: i === 0, hover: ch.hover === i, focus: ch.sel === i, down: ch.down === i });
            ch.rects.push([x, y, w, G.CHIP_H]);
            x += w + CHOICE_GAP;
          });
        }
      }
      // Long text: a thin scrollbar, and a little chevron while there's more below.
      if (bb.overflow && bb.kind === 'speech') {
        const bx = f.x + f.w - 7, top = f.y + padY(bb), len = Math.max(4, f.h - padY(bb) * 2);
        const total = bb.lines.length, frac = bb.rows / total, pos = bb.scroll.x / Math.max(1, total - bb.rows);
        const tl = Math.max(6, len * frac), t0 = top + (len - tl) * clamp(pos, 0, 1);
        ctx.fillStyle = G.rgba(G.ACC, 0.15); ctx.fillRect(bx, top, 2, len);
        ctx.fillStyle = G.ACC; ctx.fillRect(bx, t0, 2, tl);
        if (bb.ended && bb.scroll.x < total - bb.rows - 0.05) {
          const cx = f.x + f.w - 20, cy = f.y + f.h - 7 + (Math.sin(now * 6) > 0 ? 1 : 0);
          ctx.fillStyle = G.HOT;
          for (const [dx, dy] of [[-4, -2], [-2, 0], [0, 2], [2, 0], [4, -2]]) ctx.fillRect(cx + dx - 1, cy + dy - 1, 2, 2);
        }
      }
      ctx.restore();
    };

    // ---- the bubble's words: real type, crisp at any size ----
    const drawText = (ctx, env, bb) => {
      const ph = bb.input && !bb.text;
      const fr = bb.frame;
      if (!fr || (!bb.text && !bb.input)) return;
      const P = k.P, t = T(), dpr = env.dpr || 1, cw = colW(t), lh = CH * t;
      const fade = bb.closing ? clamp(1 - bb.closing / 0.25, 0, 1) : clamp((bb.age - 0.08) / 0.2, 0, 1);
      if (fade <= 0 || bb.pop.x < 0.6) return;
      const ix = fr.x + padX(bb) + dotsDx(bb), iy = fr.y + padY(bb);
      const iw = bb.cols * cw, ih = bb.rows * lh;
      const pw = Math.ceil(iw * dpr) + 2, phh = Math.ceil(ih * dpr) + 2;
      if (tcan.width !== pw || tcan.height !== phh) { tcan.width = pw; tcan.height = phh; }
      tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      tctx.clearRect(0, 0, iw + 2, ih + 2);
      const dim = bb.kind === 'thought' || (ph && !bb.input.choices);
      const lines = ph ? wrap(bb.input.placeholder || '', MAX_COLS) : bb.lines;
      const s0 = ph ? 0 : bb.scroll.x, first = Math.max(0, Math.floor(s0)), last = Math.min(lines.length - 1, first + bb.rows);
      const shown = ph ? 1e9 : Math.floor(bb.shown);
      const shownLines = lines.filter((l) => l.start < shown).length;
      const fadeTop = s0 > 0.02, fadeBot = s0 + bb.rows < shownLines - 0.02;
      // Real type, not LED dots: crisp at any size, so a long answer stays easy to read.
      const fpx = fontPx(t), base = bb.kind === 'thought' ? 400 : 500, md = R.md;
      const fonts = new Map();
      const fontFor = (st) => {
        let f = fonts.get(st);
        if (!f) {
          const w = st & (md?.BOLD ?? 0) ? 700 : base, it = st & (md?.ITAL ?? 0) ? 'italic ' : '';
          f = `${it}${w} ${fpx}px "Martian Mono", Menlo, ui-monospace, monospace`; fonts.set(st, f);
        }
        return f;
      };
      let curFont = '';
      tctx.textBaseline = 'middle'; tctx.textAlign = 'left';
      const ink = dim ? css(PAL[L - 2], 0.9) : TEXT_INK, accent = dim ? ink : TEXT_ACCENT;
      for (let li = first; li <= last; li++) {
        const line = lines[li], cy = (li - s0 + 0.5) * lh;
        // Lines scrolling past the top or bottom fade out instead of being cut in half.
        const edge = Math.min(1, fadeTop ? (cy / lh) * 1.2 : 1, fadeBot ? ((ih - cy) / lh) * 1.2 : 1);
        if (edge <= 0.02) continue;
        tctx.globalAlpha = clamp(edge, 0, 1);
        for (let j = 0; j < line.s.length; j++) {
          const idx = line.start + j;
          if (idx >= shown) break;
          if (line.s[j] === ' ') {
            // A link's underline runs on under the spaces between its words.
            if (R.md && (bb.sty?.[idx] ?? 0) & R.md.LINK && (bb.sty?.[idx + 1] ?? 0) & R.md.LINK) { tctx.fillStyle = TEXT_ACCENT; tctx.fillRect(j * cw, cy + lh * 0.36, cw, Math.max(1, t * 0.4)); }
            continue;
          }
          const em = emojiAt(line.s, j);
          const ch = em ? em.cluster : line.s[j];
          // Each new letter lands white, then settles to the text colour (code and links in the accent). It lands
          // in place: a little hop per letter made the line being read shake while it streamed in.
          const st = ph ? 0 : bb.sty?.[idx] ?? 0, f = fontFor(st);
          if (f !== curFont) { tctx.font = f; curFont = f; }
          const age = ph ? 9 : now - (bb.at[idx] ?? 0), x = j * cw + (em ? cw * 0.15 : 0), y = cy;
          const marked = md && st & (md.CODE | md.LINK);
          tctx.fillStyle = age < 0.12 ? '#ffffff' : marked ? accent : ink;
          tctx.fillText(ch, x, y);
          if (md && st & md.LINK) tctx.fillRect(x, cy + lh * 0.36, cw, Math.max(1, t * 0.4));
          if (em) j += em.n - 1;
        }
      }
      tctx.globalAlpha = 1;
      if (bb.input?.focused && !bb.input.listen && !bb.input.choices && Math.floor((now - bb.input.caretAt) * 2.2) % 2 === 0) {
        // caret where the next letter goes (or at the start, over the placeholder)
        let li = 0, col = 0;
        if (bb.text) ({ li, col } = caretAt(bb.lines, bb.input.caret ?? bb.text.length));
        if (col >= bb.cols) col = bb.cols - 1;
        const cy = (li - s0) * lh;
        if (cy > -1 && cy < ih) { tctx.fillStyle = css(HOT); tctx.fillRect(col * cw + 0.5, cy + lh * 0.15, Math.max(1.5, t * 0.8), lh * 0.7); }
      }
      // Clip to the frame as it is this instant: it may still be growing, or shrinking away on close.
      const cx1 = fr.x + fr.w - padX(bb) + 2, cy1 = fr.y + fr.h - padY(bb) - (bb.input?.listen ? (METER + 1) * P : 0) - footH(bb) + 2;
      const cwid = Math.min(iw + t, cx1 - ix), chgt = Math.min(ih + t, cy1 - iy);
      if (cwid <= t || chgt <= t) return;
      ctx.save();
      ctx.beginPath(); ctx.rect(ix, iy, cwid, chgt); ctx.clip();
      ctx.globalAlpha = fade;
      ctx.drawImage(tcan, 0, 0, pw, phh, ix, iy, pw / dpr, phh / dpr);
      ctx.restore();
    };

    // ---- the task tag under the body: a spinner, what it's doing (dim) and what on (bright), then a tick or a cross ----
    const TAG_VERB = `400 12px ${G.MONO}`, TAG_THING = `500 12px ${G.MONO}`, TAG_H = 30, TAG_MAX = 340;
    // label is the verb ("running"), detail the thing ("npm test"); a label alone shows bright.
    const tagWords = (st) => {
      if (st.words) return st.words;
      const verb = st.detail ? String(st.label ?? '') : '', room = TAG_MAX - 50 - (verb ? G.textW(verb, TAG_VERB) + 7 : 0);
      let thing = String(st.detail || st.label || '');
      if (G.textW(thing, TAG_THING) > room) { while (thing.length > 1 && G.textW(`${thing}…`, TAG_THING) > room) thing = thing.slice(0, -1); thing = `${thing.trimEnd()}…`; }
      return (st.words = { verb, thing });
    };
    const tagBox = (st) => {
      const { verb, thing } = tagWords(st);
      const w = Math.round(36 + (verb ? G.textW(verb, TAG_VERB) + 7 : 0) + G.textW(thing, TAG_THING) + 14);
      // With a bubble open, placed from where the bubble holds still (its anchor), so the tag holds still with it.
      const g = tagPlace({ w, h: TAG_H }, { x: b?.ax ?? m.x, y: b?.ay ?? m.y, r: k.R }, bounds(), b && { side: b.side, x: b.x.x, y: b.y.x, w: b.w.x, h: b.h.x }, b?.tagSpot);
      if (b) b.tagSpot = g.spot;
      return g;
    };
    const drawTag = (ctx, st) => {
      const g = tagBox(st), { verb, thing } = tagWords(st), fail = st.status === 'fail';
      const u = clamp(st.age / 0.2, 0, 1), alpha = u * (1 - (st.status ? clamp((st.out - 0.45) / 0.3, 0, 1) : 0));
      if (alpha <= 0) return;
      ctx.save();
      ctx.globalAlpha *= alpha;
      // It lands in three small steps.
      ctx.translate(0, pen.reduced ? 0 : -Math.round((1 - u) * 3) * 3);
      G.chrome(ctx, g.x, g.y, g.w, g.h, { edge: fail ? G.CORAL : G.ACC });
      const sx = g.x + 20, sy = g.y + g.h / 2;
      if (!st.status) {
        const head = Math.floor(now * 14) % 8;
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2 - Math.PI / 2, d = (head - i + 8) % 8;
          ctx.fillStyle = d === 0 ? G.HOT : d < 3 ? G.ACC : G.DEEP;
          ctx.fillRect(Math.round(sx + Math.cos(a) * 5) - 1, Math.round(sy + Math.sin(a) * 5) - 1, 2, 2);
        }
        // Its progress along the bottom edge when known, else a light running along it.
        const run = g.w - 32;
        ctx.save(); ctx.shadowColor = G.rgba(G.ACC, 0.8); ctx.shadowBlur = 6; ctx.fillStyle = G.ACC;
        if (st.p != null) ctx.fillRect(g.x + 16, g.y + g.h - 1.5, run * clamp(st.p, 0, 1), 1.5);
        else ctx.fillRect(g.x + 16 + (run - 14) * (pen.reduced ? 0.3 : (now * 0.9) % 1), g.y + g.h - 1.5, 14, 1.5);
        ctx.restore();
      } else if (!fail) {
        ctx.fillStyle = G.ACC;
        for (const [dx, dy] of [[-4, 0], [-3, 1], [-2, 2], [-1, 3], [0, 4], [1, 3], [2, 2], [3, 1], [4, 0], [5, -1], [6, -2]]) ctx.fillRect(sx + dx - 1, sy + dy - 1, 2, 2);
      } else {
        ctx.fillStyle = G.CORAL;
        for (let q = -4; q <= 4; q += 2) { ctx.fillRect(sx + q - 1, sy + q - 1, 2, 2); ctx.fillRect(sx + q - 1, sy - q - 1, 2, 2); }
      }
      let tx = g.x + 36;
      if (verb) tx += G.typed(ctx, verb, tx, sy + 0.5, TAG_VERB, G.DIM, (st.age - 0.08) / 0.25) + 7;
      G.typed(ctx, thing, tx, sy + 0.5, TAG_THING, fail ? G.CORAL : G.TEXT, (st.age - 0.2) / 0.35);
      ctx.restore();
    };

    const hitBubble = (bb, x, y) => bb && !bb.closing && x >= bb.x.x && x <= bb.x.x + bb.w.x && y >= bb.y.x && y <= bb.y.x + bb.h.x;

    // Back beside the cursor wherever it is now (they may have moved on meanwhile), else where it was when taken.
    const penHome = () => R.sidebar?.dock?.() ?? (presence.ptr && besideCursor(fol.side < 0 ? 'left' : 'right', presence.ptr)) ?? pen.home ?? [m.x, m.y];
    // Working in another app (act_in_app): it turns into its cursor and blinks from spot to spot as the helper reports
    // them, then back beside the user's cursor. Held like a drawing's pen, so it no longer chases the real cursor when
    // a step borrows it. Clicks don't wait for it: when spots come faster than it hops, it skips to the newest one.
    const hand = { want: false, took: false, next: null, running: null };
    const handHolds = () => pen.held && pen.owner === 'hand';
    const handRun = async () => {
      for (;;) {
        if (hand.want && !hand.took) {
          // Once per piece of work: hidden with Esc meanwhile, it stays hidden. A drawing's pen is left alone.
          hand.took = true;
          if (!pen.held) await api.pen.take('hand');
        } else if (hand.want && hand.next && handHolds()) {
          const [x, y] = hand.next;
          hand.next = null;
          await api.pen.jump(x, y);
          if (handHolds()) await api.pen.tap(x, y);
        } else if (!hand.want && handHolds()) {
          const [hx, hy] = penHome(), [ox, oy] = tipOff();
          await api.pen.jump(hx - ox, hy - oy);
          if (handHolds()) await api.pen.release();
        } else return;
      }
    };
    const handKick = () => (hand.running ??= handRun().catch((e) => console.error('hand', e)).finally(() => { hand.running = null; }));

    const api = {
      say: (text, opts) => { ensureShown(); return open('speech', text, opts); },
      think: (text, opts = {}) => {
        ensureShown();
        const h = open('thought', text, { ...opts, stream: true });
        if (!opts.quiet) k.S('hmm');
        if (opts.dur) setTimeout(() => { h.end(); }, opts.dur * 1000);
        return h;
      },
      hush: () => { if (b) close(b); },
      // Act out an emote (wave, hype, upset, remind, motivate). Skipped while a tool is on stage.
      act: (name) => { if (tool) return false; ensureShown(); actUntil = now + (k.presence === 'in' ? 4.2 : 3.3); k.startAct(name); return true; },
      show: ({ summoned = false, variant } = {}) => {
        presence.lastActive = now; presence.summoned = summoned;
        if (visible()) { if (summoned) comeToCursor(); return false; }
        const [x, y] = spot();
        return k.appear(variant ?? entrance(), x, y);
      },
      hide: ({ instant = false, variant } = {}) => {
        if (pen.held) penRelease();
        if (b) close(b);
        if (tool) tool.finish(true);
        presence.summoned = false;
        return k.vanish(instant ? null : variant ?? nextVariant(), instant);
      },
      toggle: () => (visible() ? api.hide() : api.show({ summoned: true })),
      // First-run hello: drop in from the menu bar right under the tray icon (x in overlay px) and point up at it.
      intro: (x, text) => {
        // The raised hand (not the body) goes under the icon: the hand reaches HAND_DX radii right of
        // the body, so the body sits that much to the left. Near the right edge it can't, so it shifts
        // and the hand angles over instead.
        const S = bounds(), r = k.R, HAND_DX = 0.35;
        const px = clamp(x - HAND_DX * r, S.l + r * 1.7, S.r - r * 1.7), py = S.t + r * 2.1;
        const reach = clamp((x - px) / r, -1.2, 1.2);
        if (visible()) k.vanish(null, true);
        setStation(px, py);
        presence.summoned = true; presence.lastActive = now;
        k.appear('drop', px, py);
        return api.say(text, { mood: 'happy', point: [reach, -1.75] });
      },
      // The pen, for drawings (ink.js): take() turns it into its cursor and holds it; the tip then only moves where told
      // (move: glide there; trace: draw along points at a hand's pace, onP(u) as it goes; tap: a little press; park:
      // tap or circle on the spot while waiting); release() glides home and grows back to its own size.
      pen: {
        get held() { return pen.held; },
        set speed(v) { pen.speed = clamp(v, 1, 3); },
        get tip() { return pen.tip.slice(); },
        get home() { return pen.home?.slice() ?? null; },
        async take(owner = 'ink') {
          pen.owner = owner;
          ensureShown();
          if (b) close(b);
          k.stopAct?.();
          // Coming on screen (it hides when idle): let it land first, so the tip starts where the body really is.
          for (let i = 0; i < 40 && k.presence !== 'shown'; i++) await new Promise((r) => setTimeout(r, 50));
          if (!pen.held) {
            const [ox, oy] = tipOff();
            pen.home = [station.x ?? m.x, station.y ?? m.y]; pen.follow = !!station.byCursor; pen.tip = [m.x - ox, m.y - oy]; pen.held = true;
            presence.summoned = true; fol.on = false; station.moving = station.rush = false; m.drive = penDrive;
          }
          if (k.form !== 'cursor') await k.morph?.('cursor');
        },
        move: (x, y) => penFly(x, y),
        // A hop, not a glide: it blinks out and comes back on with its tip at (x, y).
        jump(x, y) {
          pen.idle = null;
          return k.blink?.(() => { if (pen.held) { pen.tip = [x, y]; penDrive(0); m.vx = m.vy = 0; } }) ?? Promise.resolve();
        },
        // Straight there this frame (it's dragging something: a card's corner, a part being moved).
        set(x, y) { if (pen.held && !pen.tw.length) { pen.idle = null; pen.tip = [x, y]; } },
        async trace(pts, dur, onP = () => {}) {
          if (!pts?.length) return;
          await penFly(pts[0][0], pts[0][1]); await penWait(0.03);
          await penTween(dur, (u) => { const e = penSmooth(u); pen.tip = penAt(pts, e); onP(e); });
          onP(1); await penWait(0.04);
        },
        async tap(x, y) { await penFly(x, y); k.S('pip'); await penTween(0.16, (u) => { pen.tip = [x, y + Math.sin(u * Math.PI) * 3]; }); },
        // Drift just off a finished mark (down and right of it), so the cursor never covers it.
        rest(x, y) { const [x0, y0] = pen.tip, tx = x + 16, ty = y + 14; return penTween(0.2, (u) => { const e = penEase(u); pen.tip = [lerp(x0, tx, e), lerp(y0, ty, e)]; }); },
        park(kind, x, y) {
          pen.idleAt = now;
          pen.idle = kind === 'tap' ? (t) => [x, y + Math.max(0, Math.sin(t * 4.5)) * 3]
            : kind === 'circle' ? (t) => [x + Math.cos(t * 2.4) * 6, y + Math.sin(t * 2.4) * 4] : null;
        },
        wait: (sec) => penWait(sec),
        async release() {
          if (!pen.held) return;
          pen.idle = null;
          const [hx, hy] = penHome(), [ox, oy] = tipOff();
          await penFly(hx - ox, hy - oy);
          if (!pen.held) return;
          penRelease();
          api.place(hx, hy);
          // It was following the cursor before the drawing: carry on, or it treats the cursor as in its way and hops off.
          if (pen.follow && presence.ptr) station.byCursor = presence.ptr.slice();
          presence.lastActive = now;
          if (k.userForm && k.userForm !== k.form) await k.morph?.(k.userForm);
        },
      },
      // Its work in another app: begin() when a step lands somewhere or takes the real cursor, at() for each spot
      // (overlay px), end() when the work is over (resolves once it is back to its own size beside the cursor).
      hand: {
        begin() { if (!hand.want) { hand.want = true; handKick(); } },
        at(x, y) { if (hand.want) { hand.next = [x, y]; handKick(); } },
        end() { hand.want = false; hand.took = false; hand.next = null; return handKick(); },
      },
      // Make (x, y) home and move there now, e.g. to restore where the user last left it.
      place: (x, y) => {
        setStation(x, y); m.x = x; m.y = y; m.vx = m.vy = 0; m.mode = 'rest'; m.rest = 1;
        station.moving = false; station.flee = 0; station.quietUntil = now + 1;
      },
      setAuto: (on, idle) => { presence.auto = !!on; if (idle) presence.idle = idle; presence.lastActive = now; },
      get visible() { return visible(); },
      // The speech bubble is still typing its words out.
      typing: () => !!b && b.kind === 'speech' && b.shown < b.text.length,
      get station() { return { ...station }; },
      // Where it is, or where it's arriving (an entrance can start off to the side).
      get pos() { return k.presence === 'in' && station.x != null ? { x: station.x, y: station.y, r: m.radius } : { x: m.x, y: m.y, r: m.radius }; },
      get presence() { return k.presence; },
      // A listening bubble: live transcript plus a voice meter. set() takes the latest transcript.
      listen: (opts = {}) => {
        comeToCursor();
        ensureShown();
        const h = open('speech', '', { stream: true });
        const bb = b;
        bb.input = { placeholder: opts.placeholder ?? 'Listening…', focused: true, caretAt: now, listen: true, level: 0, target: 0, levels: [], processing: false };
        bb.wait = 0;
        k.S('listen');
        return {
          set(text) {
            let i = 0;
            while (i < text.length && i < bb.text.length && text[i] === bb.text[i]) i++;
            for (let j = i; j < text.length; j++) bb.at[j] = now;
            bb.text = text; bb.sty = null; bb.lines = wrap(text, MAX_COLS); bb.shown = text.length;
            return this;
          },
          level(v) { bb.input.target = clamp(v, 0, 1); return this; },
          processing() { bb.input.processing = true; return this; },
          close() { if (b === bb) close(bb); },
          get open() { return b === bb && !bb.closing; },
          get closed() { return h.closed; },
        };
      },
      // An input bubble: the host feeds it keystrokes with set(); it never times out.
      prompt: (opts = {}) => {
        comeToCursor();
        ensureShown();
        const h = open('speech', '', { stream: true });
        const bb = b;
        bb.input = { placeholder: opts.placeholder ?? '', mask: !!opts.mask, focused: true, caretAt: now, onPress: opts.onPress };
        // choices: buttons instead of typing; onChoose(i) when one is clicked. Nothing is highlighted at first.
        if (opts.choices?.length) bb.input.choices = { labels: opts.choices.map(String), sel: -1, hover: -1, down: -1, rects: [], onChoose: opts.onChoose };
        bb.wait = 0;
        return {
          // The keyboard's highlighted button (-1: none).
          select(i) { const ch = bb.input.choices; if (ch && ch.sel !== i) { ch.sel = i; k.S('tick'); } return this; },
          // caret: where the field's own caret is (it moves with the arrow keys and clicks); the end if not given.
          set(value, caret = value.length) {
            const v = bb.input.mask ? '•'.repeat(value.length) : value;
            bb.input.caret = clamp(caret, 0, v.length);
            const prev = bb.text.length;
            if (v.length > prev) { k.S('key', 0.9 + Math.random() * 0.25); k.sq.kick(1.2); typedAt = now; }
            else if (v.length < prev) k.S('tick');
            bb.text = v; bb.sty = null; bb.lines = wrap(v, MAX_COLS); bb.shown = v.length;
            for (let i = prev; i < v.length; i++) bb.at[i] = now;
            bb.input.caretAt = now;
            return this;
          },
          focus(on) { bb.input.focused = on; bb.input.caretAt = now; return this; },
          close() { if (b === bb) close(bb); },
          get closed() { return h.closed; },
        };
      },
      tool: (name, opts = {}) => {
        const def = R.agentTools?.[name];
        if (!def) throw new Error(`unknown tool ${name}`);
        ensureShown();
        if (tool) tool.finish(true);
        const st = {
          name, def, variant: opts.variant ?? def.variants[0], label: opts.label ?? def.label, detail: opts.detail ?? '',
          age: 0, out: 0, status: null, p: null, d: {}, seed: Math.random() * 999, closed: deferred(),
        };
        st.live = !!opts.live;
        st.finish = (ok = true) => {
          if (st.status) return;
          // Live calls: when the animation reaches its end before the real tool, hold there (spinner keeps going).
          if (st.live && st.real === undefined) { st.parked = true; return; }
          const final = st.live ? st.real && ok : ok;
          st.status = final ? 'ok' : 'fail'; k.S(final ? 'done' : 'error');
        };
        tool = st;
        def.start?.(st, C);
        k.S('toolstart');
        if (opts.dur) setTimeout(() => st.finish(true), opts.dur * 1000);
        const done = (ok = true) => {
          if (!st.live) return st.finish(ok);
          if (st.real !== undefined) return;
          st.real = ok;
          // The terminal plays its own failure beat; every other tool fails on the spot.
          if (!ok && st.name === 'run') { st.variant = 'fail'; return; }
          if (st.parked || !ok) st.finish(ok);
        };
        // target(rect): the real area being worked on (e.g. the window being captured), in overlay px.
        if (opts.rect) { st.target = opts.rect; st.targetName = opts.rectName; }
        return { progress(p) { st.p = p; return this; }, target(rect, name) { st.target = rect; st.targetName = name; st.def.retarget?.(st, C); return this; }, done(ok = true) { done(ok); return this; }, get closed() { return st.closed; }, state: st };
      },
      get busy() { return !!(b || tool); },
      get bubble() { return b; },
    };

    const plugin = {
      api,
      busy: () => !!(b || tool || pen.held),
      // Held as the pen: clicks go through it to the app underneath (it may be parked right on the thing to click).
      ghost: () => pen.held,
      // A bubble is up: emotes keep their gestures but drop icons and particles, so the text stays readable.
      calm: () => !!(b && !b.closing),
      hit: (x, y) => hitBubble(b, x, y),
      press: (x, y) => {
        if (!b) return;
        const ch = b.input?.choices;
        if (ch) {
          const i = ch.rects.findIndex((r) => x >= r[0] && x <= r[0] + r[2] && y >= r[1] - 2 && y <= r[1] + r[3] + 3);
          if (i >= 0) { ch.down = i; ch.onChoose?.(i); } else b.input.onPress?.();
          return;
        }
        if (b.input) { b.input.onPress?.(); return; }
        if (b.overflow || b.expanded) { b.expanded = !b.expanded; b.follow = false; b.dwell = 0; k.S('expand'); if (!b.expanded) b.scrollTarget = 0; }
        else close(b);
      },
      wheel: (dy) => {
        if (!b) return;
        b.follow = false; b.dwell = 0;
        b.scrollTarget = (b.scrollTarget ?? 0) + dy / 40;
        if (b.scrollTarget >= b.lines.length - b.rows) b.follow = b.ended ? false : true;
      },
      pose: (dt) => {
        lookAt = null;
        if (now < actUntil && !tool) { lastPose = null; return null; }
        const tp0 = tool ? tool.def.pose(tool, C) : null, tp = tp0 && { ...tp0, arms: 0, tl: undefined, tr: undefined };
        const bp = bubblePose(dt);
        let p = tp ?? bp;
        if (tp && bp && b?.kind === 'speech' && mouthT > 0) p = { ...tp, mouth: bp.mouth };
        if (tool && tool.status && tool.out > 0.35) p = p && { ...p, arms: tool.out > 0.6 ? 0 : p.arms };
        lastPose = p;
        return p;
      },
    };
    function bubblePose(dt) {
      {
        const t = now;
        if (!b) return null;
        if (b.input?.listen) {
          const lv = b.input.level, wig = Math.sin(t * 7) * 0.04 * lv;
          return {
            arms: 1, tr: [0.98 + wig, -0.42 - lv * 0.08], tl: [-0.62, 0.88 + Math.sin(t * 2) * 0.03],
            ox: k.R * 0.05, oy: -lv * k.R * 0.06, mouth: b.input.processing ? 'o' : 'flat', brow: 'raised', mode: 'listen', heard: lv,
          };
        }
        if (b.input) {
          const typing = now - typedAt < 0.35, bob = Math.sin(t * 2.2) * 0.03;
          return { arms: 0.8, tl: [-0.42, 0.95 + bob], tr: [0.42, 0.95 - bob], oy: typing ? -k.R * 0.025 : 0, mouth: typing ? 'o' : 'flat', brow: b.text ? null : 'raised' };
        }
        if (b.kind === 'thought') {
          return {
            arms: 1, tl: [-0.08, 0.5 + Math.sin(t * 2) * 0.03], tr: [0.98, 0.34], ox: Math.sin(t * 1.3) * k.R * 0.04,
            mouth: Math.sin(t * 0.9) > 0.6 ? 'o' : 'flat', brow: 'raised', mode: 'think',
          };
        }
        const talking = b.shown < b.text.length || !!R.voiceOut?.playing();
        gestT += dt * (talking ? 1 : 0.3);
        const g = Math.sin(gestT * 3.1), g2 = Math.sin(gestT * 1.7 + 1);
        const brow = b.mood === 'annoyed' ? 'angry' : b.mood === 'concerned' ? 'raised' : b.mood === 'determined' ? 'determined' : null;
        if (b.point) {
          const bob = Math.sin(t * 5) * 0.06;
          return { arms: 1, tr: [b.point[0], b.point[1] + bob], tl: [-0.9, 0.45], mouth: mouthT > 0 ? mouthMode : 'grin', brow: 'raised', mode: talking ? 'talk' : null };
        }
        return {
          arms: talking ? 1 : 0.4,
          tr: [0.95 + g * 0.08, 0.05 - Math.max(0, g) * 0.35], tl: [-0.98 - g2 * 0.06, 0.25 - Math.max(0, g2) * 0.18],
          // No hop while it talks: the body (and the bubble and cards placed from it) stays level to be read.
          mouth: mouthT > 0 ? mouthMode : b.mood === 'annoyed' ? 'frown' : null, brow, mode: talking ? 'talk' : null,
        };
      }
    }
    const self = {
      ...plugin,
      update: (dt, env) => {
        now += dt; W = env.w; H = env.h; SAFE = env.safe ?? R.safe;
        pen.reduced = !!env.reduced;
        if (pen.held) {
          presence.lastActive = now;
          const tw = pen.tw[0];
          if (tw) {
            tw.t0 ??= now;
            const u = clamp((now - tw.t0) / tw.dur, 0, 1);
            tw.f(u);
            if (u >= 1) { pen.tw.shift(); tw.res(); }
          } else if (pen.idle) pen.tip = pen.idle(now - pen.idleAt);
        }
        // Popping up beside the cursor keeps up with it too, so it never sits still while appearing.
        const popping = k.presence === 'in' && station.byCursor && !pen.held && !m.dragging;
        if (k.presence !== 'shown' && !popping && m.drive && !pen.held) { m.drive = null; fol.on = false; }
        if (k.presence !== 'shown' && (nat.on || nat.ask)) { R.buddy?.hide(); nat.on = false; nat.ask = 0; m.native = false; }
        if (env.mouse?.active || presence.cursor == null) presence.cursor = [env.mouse?.x ?? W / 2, env.mouse?.y ?? H / 2];
        const mx = env.mouse?.x, my = env.mouse?.y;
        presence.ptr = !R.game && mx != null && mx >= 0 && my >= 0 && mx <= W && my <= H ? [mx, my] : null;
        if (popping) { if (presence.ptr) follow(env, dt); else { m.drive = null; fol.on = false; } }
        const onStage = stage();
        if (presence.auto) {
          const hover = env.mouse?.active && Math.hypot(env.mouse.x - m.x, env.mouse.y - m.y) < k.R * 1.5;
          const busyNow = b || dying.length || tool || pen.held || now < actUntil || m.dragging || m.flung || hover || k.presence === 'in' || R.panel?.working;
          if (busyNow) presence.lastActive = now;
          const idleFor = presence.summoned ? presence.summonIdle : presence.idle;
          if (k.presence === 'shown' && now - presence.lastActive > idleFor) { presence.summoned = false; k.vanish(nextVariant()); }
        }
        if (!onStage) {
          // Bubbles closed by hide() still need to finish dissolving (unseen) so their promises settle.
          for (let i = dying.length - 1; i >= 0; i--) { dying[i].closing += dt; if (dying[i].closing > 0.35) { dying[i].closed.resolve(); dying.splice(i, 1); } }
          return;
        }
        mouthT -= dt;
        if (k.presence === 'shown') {
          if (station.x == null) setStation(m.x, m.y);
          const held = m.dragging || m.flung;
          // Game mode turned on while it's up: off to the panel at the screen's edge, once (it can still be dragged).
          const dock = R.sidebar?.dock?.();
          if (dock && !station.atDock && !held && !pen.held) { setStation(dock[0], dock[1]); m.goTo(dock[0], dock[1]); station.moving = true; station.atDock = true; }
          else if (!dock && station.atDock) station.atDock = false;
          if (held && !station.held) station.from = [m.x, m.y];
          // Dropped somewhere new: that's home now, and the cursor gets a moment to move off.
          // A plain click (press without moving it) isn't a move.
          if (station.held && !held && station.from && Math.hypot(m.x - station.from[0], m.y - station.from[1]) > k.R * 0.5) {
            setStation(m.x, m.y); station.quietUntil = now + 2.5; station.moving = false;
          }
          station.held = held;
          // A fullscreen game pinned the cursor (host.js): leave the spot beside it or under it, clear of where it's pinned.
          const pinned = R.game && presence.cursor;
          if (pinned && !held && !pen.held && !station.moving && (station.byCursor || Math.hypot(m.x - pinned[0], m.y - pinned[1]) < AVOID())) {
            const [x, y] = pickSpot(presence.cursor?.[0], presence.cursor?.[1], m.x, m.y);
            setStation(x, y); m.goTo(x, y); station.moving = true; station.flee = 0;
          }
          // Popped up beside the cursor: it goes where the cursor goes (until it's dragged somewhere).
          if (pen.held) { fol.on = false; m.drive = held ? null : penDrive; station.flee = 0; }
          else if (!held && station.byCursor && presence.ptr) { follow(env, dt); station.flee = 0; }
          else { fol.on = false; m.drive = null; }
          nativeStep(dt, self);
          // While drawing, stay put: the user's cursor is supposed to come over here.
          if (!held && env.mouse && !pen.held && !station.byCursor) {
            const cx = env.mouse.x, cy = env.mouse.y, dBody = Math.hypot(cx - m.x, cy - m.y);
            // Pointing right at it or its bubble means "I want this"; hovering around it means "you're in my way".
            const onIt = dBody < m.radius * 1.1 || (b && hitBubble(b, cx, cy));
            const pad = k.R * 0.7;
            const nearBubble = b && !b.closing && cx > b.x.x - pad && cx < b.x.x + b.w.x + pad && cy > b.y.x - pad && cy < b.y.x + b.h.x + pad;
            const near = dBody < k.R * 3 || nearBubble;
            // Popped up beside the cursor for a request: stay there while it's talking, listening or working.
            const engaged = station.byCursor && ((b && !b.closing) || tool);
            station.flee = near && !onIt && !engaged && now > station.quietUntil ? station.flee + dt : Math.max(0, station.flee - dt * 2);
            if (station.flee > 0.45 && !station.moving) {
              const [x, y] = pickSpot(cx, cy, m.x, m.y);
              k.stopAct?.(); setStation(x, y); m.goTo(x, y);
              station.moving = true; station.flee = 0; k.S('hop'); k.sq.kick(4);
            }
          }
          if (station.moving && Math.hypot(m.x - station.x, m.y - station.y) < k.R * 0.4) { station.moving = station.rush = false; m.mode = 'rest'; m.rest = 0.6; }
        }
        // Called over to the cursor: get there in well under a second, even from across the screen.
        m.speedMul = station.rush ? 7 : station.moving ? 2.6 : b ? (b.kind === 'thought' ? 0.15 : 0.35) : 1;
        if (b?.input?.listen) {
          const inp = b.input;
          inp.level = R.damp(inp.level, inp.target, inp.target > inp.level ? 30 : 8, dt);
          inp.target *= Math.exp(-dt * 3);
          inp.acc = (inp.acc ?? 0) + dt;
          if (inp.acc > 0.045) { inp.acc = 0; inp.levels.push(inp.level); }
        }
        // The research card is filling up: glance over at it now and then while following the cursor.
        const card = !b && !tool ? R.panel?.center : null;
        if (card && R.panel.working && Math.sin(now * 0.9) > 0.2) {
          const dx = card.x - m.x, dy = card.y - m.y, dd = Math.hypot(dx, dy) || 1;
          face.lookX = R.damp(face.lookX, (dx / dd) * 0.9, 6, dt); face.lookY = R.damp(face.lookY, (dy / dd) * 0.9, 6, dt);
        }
        if (b) {
          b.hover = env.mouse.active && hitBubble(b, env.mouse.x, env.mouse.y);
          const ch = b.input?.choices;
          if (ch) ch.hover = b.hover ? ch.rects.findIndex((r) => env.mouse.x >= r[0] && env.mouse.x <= r[0] + r[2] && env.mouse.y >= r[1] - 2 && env.mouse.y <= r[1] + r[3] + 3) : -1;
          step(b, dt, env);
          if (b?.input?.listen && !tool) { face.lookX = R.damp(face.lookX, 0.25, 6, dt); face.lookY = R.damp(face.lookY, 0.05, 6, dt); }
          else if (b && (b.kind === 'thought' || b.input) && !tool) { face.lookX = R.damp(face.lookX, clamp((b.x.x + b.w.x / 2 - m.x) / 160, -0.9, 0.9), 6, dt); face.lookY = R.damp(face.lookY, b.below ? 0.8 : -0.85, 6, dt); }
        }
        if (tool) {
          tool.age += dt;
          tool.def.update?.(tool, C, dt);
          if (tool.status) { tool.out += dt; if (tool.out > 0.9) { tool.closed.resolve(); tool = null; } }
        }
        if (lookAt) {
          const dx = lookAt[0] - m.x, dy = lookAt[1] - m.y, dd = Math.hypot(dx, dy) || 1, s = Math.min(1, dd / 120);
          face.lookX = R.damp(face.lookX, (dx / dd) * s, 9, dt); face.lookY = R.damp(face.lookY, (dy / dd) * s, 9, dt);
        }
        for (let i = dying.length - 1; i >= 0; i--) {
          step(dying[i], dt, env);
          if (dying[i].closing > 0.35) { dying[i].closed.resolve(); dying.splice(i, 1); }
        }
      },
      gridOver: () => {},
      // The area drawn off the grid (bubbles, their tails, the task tag), so the patch on screen covers it.
      extent: () => {
        if (!stage()) return null;
        let e = null;
        const add = (x0, y0, x1, y1) => { e = e ? [Math.min(e[0], x0), Math.min(e[1], y0), Math.max(e[2], x1), Math.max(e[3], y1)] : [x0, y0, x1, y1]; };
        for (const bb of [b, ...dying]) if (bb) { add(bb.x.x - 8, bb.y.x - 8, bb.x.x + bb.w.x * 1.08 + 8, bb.y.x + bb.h.x * 1.08 + 8); add(bb.tail.x.x - 8, bb.tail.y.x - 8, bb.tail.x.x + 8, bb.tail.y.x + 8); }
        if (tool) { const g = tagBox(tool); add(g.x, g.y - 10, g.x + g.w, g.y + g.h); }
        return e;
      },
      // The body is drawn snapped to its grid cell while it follows (10-dither.js): bubbles riding with it move too.
      shift: (dx, dy) => {
        for (const bb of [b, ...dying]) {
          if (!bb) continue;
          bb.x.x += dx; bb.y.x += dy; bb.tail.x.x += dx; bb.tail.y.x += dy;
          if (bb.mx != null) { bb.mx += dx; bb.my += dy; }
          if (bb.ax != null) { bb.ax += dx; bb.ay += dy; }
        }
      },
      // Nothing drawn outside the LED grid this frame, so the grid alone decides whether the picture changed.
      quiet: () => !b && !dying.length && !tool,
      over: (ctx, env) => {
        if (!stage()) return;
        // The tag goes under every bubble, so it can never cover the words or the Allow and Don't allow buttons of the
        // open one, nor sit on one that's fading out (the tag takes its usual spot back as soon as a bubble closes).
        if (tool) drawTag(ctx, tool);
        for (const bb of dying) { drawBubble(ctx, bb); drawText(ctx, env, bb); }
        if (b) { drawBubble(ctx, b); drawText(ctx, env, b); }
      },
    };
    return self;
  };
})();
