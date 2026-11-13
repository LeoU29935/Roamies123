// The panel that opens from the menu bar or tray icon: a sidebar of pages. Home (what's going on) and Memory,
// then a page per group of settings: Model, Appearance, Voice, Behavior and About, and What's new.
// The sidecar owns every value: it sends the whole state when the panel opens and after each change, and the
// panel sends back the same actions the menu used ({type:'menu', id}). Opened in a plain browser it shows a
// labelled preview with sample data instead.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const TAURI = window.__TAURI__?.core?.invoke;
  const invoke = TAURI ?? preview();
  const send = (msg) => invoke('sidecar_send', { msg }).catch(() => {});
  const hide = () => invoke('panel_hide').catch(() => {});
  // An action from the menu's list. away: it happens on the desktop, so the panel steps aside first.
  const act = (id, away = false) => { if (away) hide(); send({ type: 'menu', id }); };

  let state = null, tab = 'home', deferred = false;
  // What's open in the panel itself: a key field (provider id, 'fish' or 'gemini'), the row action waiting for its
  // Confirm, each long list's page (pg) and how many rows fit on one (per, measured), Memory's tab and its search.
  const ui = { key: null, kind: {}, arm: null, pg: {}, per: {}, mtab: 'facts', q: '', bindShown: new Set() };
  let armTimer = 0;
  const disarm = () => { clearTimeout(armTimer); if (ui.arm) { ui.arm = null; return true; } return false; };

  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'on') for (const [ev, f] of Object.entries(v)) n.addEventListener(ev, f);
      else if (k.startsWith('aria-') || k === 'role' || k.startsWith('data-')) n.setAttribute(k, String(v));
      else n[k] = v;
    }
    n.append(...kids.flat().filter((c) => c != null && c !== false));
    return n;
  };
  const btn = (label, onclick, { kind = 'ghost', k, disabled, wide, aria, title } = {}) =>
    el('button', { className: `px btn ${kind}${wide ? ' wide' : ''}`, type: 'button', textContent: label, disabled, title, 'data-k': k, 'aria-label': aria, on: { click: onclick } });
  const link = (label, onclick, { k, danger, aria, disabled } = {}) =>
    el('button', { className: `link${danger ? ' danger' : ''}`, type: 'button', textContent: label, 'data-k': k, 'aria-label': aria, disabled, on: { click: onclick } });
  // A row's action, played out: the row steps out, then the action goes. Re-rendering brings the list in line.
  // A block opening in place grows into its room and fades in; closing, the reverse. Marked with data-anim (its id).
  const shown = (n) => !n.hidden && n.getClientRects().length > 0;
  function grow(n, open) {
    if (REDUCED.matches || !shown(n)) return Promise.resolve();
    const h = n.offsetHeight, gap = parseFloat(getComputedStyle(n.parentElement).rowGap) || 0;
    n.classList.remove('appear', 'vanish'); void n.offsetWidth; n.classList.add(open ? 'appear' : 'vanish');
    const shut = { height: '0px', marginTop: `${-gap}px` }, full = { height: `${h}px`, marginTop: '0px' };
    n.style.overflow = 'hidden';
    return n.animate(open ? [shut, full] : [full, shut], { duration: open ? 200 : 160, easing: 'cubic-bezier(.2, .8, .2, 1)', fill: open ? 'none' : 'forwards' })
      .finished.catch(() => {}).then(() => { n.style.overflow = ''; if (open) n.classList.remove('appear'); });
  }
  // Closes the open block `id` (animated), then runs then().
  const shutBlock = (id, then) => { const n = document.querySelector(`.pane [data-anim="${CSS.escape(id)}"]`); return n && shown(n) ? grow(n, false).then(then) : then(); };
  // The key field under a row: opens (closing another first), or closes if it's the one open.
  function toggleKey(id) {
    const prev = ui.key;
    if (prev === id) return closeKey();
    const open = () => { ui.key = id; render(`key-${id}`); };
    return prev ? shutBlock(`key-${prev}`, open) : open();
  }
  function closeKey() {
    const id = ui.key;
    if (!id) return;
    shutBlock(`key-${id}`, () => { if (ui.key === id) { ui.key = null; render(`addkey:${id}`); } });
  }
  const leave = (from, id) => { from.closest('.item')?.classList.add('leaving'); setTimeout(() => act(id), REDUCED.matches ? 0 : 190); };
  // Asks first in the same spot: the first press turns it into Confirm (for 4 s), the second does it.
  const armed = (label, yes, k, id, aria) => {
    const on = ui.arm === k;
    const b = el('button', { className: 'link danger arm', type: 'button', 'data-k': k, 'aria-pressed': String(on), 'aria-label': on ? `Confirm: ${aria}` : aria },
      el('span', { className: 'no', textContent: label, 'aria-hidden': 'true' }), el('span', { className: 'yes', textContent: yes, 'aria-hidden': 'true' }));
    b.addEventListener('click', () => {
      if (ui.arm === k) { disarm(); b.setAttribute('aria-pressed', 'false'); return leave(b, id); }
      clearTimeout(armTimer); ui.arm = k; render(k);
      armTimer = setTimeout(() => { if (ui.arm === k) { ui.arm = null; render(); } }, 4000);
    });
    return b;
  };
  // A row's tick (done) or X (forget, drop) asks first, like Quit: pressed, it turns into Confirm in place while the
  // row's other button steps aside; pressed again it goes, left alone for 4 s it goes back.
  const PIX = {
    tick: [[0, 3], [1, 4], [2, 5], [3, 4], [4, 3], [5, 2], [6, 1]],
    x: [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [6, 0], [5, 1], [4, 2], [2, 4], [1, 5], [0, 6]],
  };
  const pix = (name) => `<svg viewBox="0 0 14 14" width="14" height="14" shape-rendering="crispEdges" fill="currentColor">${PIX[name].map(([x, y]) => `<rect x="${x * 2}" y="${y * 2}" width="2" height="2"/>`).join('')}</svg>`;
  // Asking, it has no tooltip: the word on it says what it does.
  const armIcon = (b, on) => { b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', on ? `Confirm: ${b.dataset.aria}` : b.dataset.aria); if (on) b.removeAttribute('data-tip'); else b.dataset.tip = b.dataset.name; };
  const calmIcons = () => { for (const o of document.querySelectorAll('.pane .ibtn[aria-pressed="true"]')) armIcon(o, false); };
  function iconArmed(icon, tip, k, id, aria) {
    const no = el('span', { className: 'no', 'aria-hidden': 'true' });
    no.innerHTML = pix(icon);
    const b = el('button', { className: `link ibtn${icon === 'x' ? ' danger' : ''}`, type: 'button', 'data-k': k, 'data-name': tip, 'data-aria': aria },
      no, el('span', { className: 'yes', textContent: 'Confirm', 'aria-hidden': 'true' }));
    armIcon(b, ui.arm === k);
    b.addEventListener('click', () => {
      if (ui.arm === k) { disarm(); return leave(b, id); }
      const text = document.querySelector('.pane .arm[aria-pressed="true"]');
      disarm(); calmIcons(); if (text) render(k);
      const me = document.querySelector(`.pane [data-k="${CSS.escape(k)}"]`) ?? b;
      ui.arm = k; armIcon(me, true); hideTip();
      armTimer = setTimeout(() => { if (ui.arm !== k) return; ui.arm = null; const n = document.querySelector(`.pane [data-k="${CSS.escape(k)}"]`); if (n) armIcon(n, false); }, 4000);
    });
    return b;
  }
  const group = (title, desc, n, ...kids) => el('div', { className: 'group' },
    el('div', { className: 'ghead' }, el('h2', {}, title, n != null ? el('span', { className: 'n', textContent: String(n) }) : null), desc ? el('p', { textContent: desc }) : null),
    ...kids);
  const toggle = (label, hint, on, onflip, k) => el('div', { className: 'setting' },
    el('span', { id: `lbl-${k}` }, label, hint ? el('small', { textContent: hint }) : null),
    el('button', { className: 'px switch', type: 'button', role: 'switch', 'aria-checked': String(!!on), 'aria-labelledby': `lbl-${k}`, 'data-k': k, on: { click: onflip } }));
  // tips: { value: text } shown in a tooltip on hover or keyboard focus, and read out as the option's description.
  const picks = (label, list, value, pick, k, tips = null) => el('div', { className: 'picks', role: 'radiogroup', 'aria-label': label },
    list.map(([v, text]) => el('button', {
      className: 'px chord', type: 'button', role: 'radio', 'aria-checked': String(v === value), tabIndex: v === value ? 0 : -1, 'data-k': `${k}:${v}`,
      'data-tip': tips?.[v] ?? null, 'aria-describedby': tips?.[v] ? `tip-${k}-${v}` : null,
      on: { click: () => v !== value && pick(v) },
    }, el('span', { className: 'px cap', textContent: text }), tips?.[v] ? el('span', { className: 'sr-only', id: `tip-${k}-${v}`, textContent: tips[v] }) : null)));

  // ---- tooltip: one box, by whatever has a data-tip under the pointer or keyboard focus ----
  // It can be hovered (it sits right against its control), Esc closes it, and it never covers its control.
  let tipFor = null, tipTimer = 0;
  const tipBox = () => $('tip');
  function showTip(target) {
    clearTimeout(tipTimer);
    const t = tipBox(), text = target.dataset.tip;
    if (!text) return;
    if (tipFor !== target) { t.textContent = text; t.classList.remove('in'); void t.offsetWidth; t.classList.add('in'); }
    tipFor = target; t.hidden = false;
    const r = target.getBoundingClientRect(), gut = 12;
    // Fit the text, up to 300px (or the window): a one-word tip gets a small card.
    t.style.maxWidth = `${Math.min(300, innerWidth - gut * 2)}px`;
    const w = t.offsetWidth, h = t.offsetHeight, below = r.bottom + 6 + h <= innerHeight - 8;
    const x = Math.round(Math.min(Math.max(r.left, gut), innerWidth - gut - w)), y = Math.round(below ? r.bottom + 6 : r.top - 6 - h);
    t.style.left = `${x}px`; t.style.top = `${y}px`;
    // The frame can be what "fixed" is measured from (its open/close effects): correct by where it actually landed.
    const at = t.getBoundingClientRect();
    t.style.left = `${x + (x - Math.round(at.left))}px`; t.style.top = `${y + (y - Math.round(at.top))}px`;
  }
  function hideTip(soon = false) {
    clearTimeout(tipTimer);
    if (soon) { tipTimer = setTimeout(() => hideTip(), 120); return; }
    tipFor = null; const t = tipBox(); if (t) t.hidden = true;
  }
  document.addEventListener('pointerover', (e) => { const x = e.target.closest?.('[data-tip]'); if (x) showTip(x); else if (e.target.closest?.('#tip')) clearTimeout(tipTimer); });
  document.addEventListener('pointerout', (e) => { if (e.target.closest?.('[data-tip], #tip') && !e.relatedTarget?.closest?.('[data-tip], #tip')) hideTip(true); });
  document.addEventListener('focusin', (e) => { const x = e.target.closest?.('[data-tip]'); if (x && x.matches(':focus-visible')) showTip(x); else hideTip(); });
  document.addEventListener('focusout', () => hideTip(true));

  const ago = (at) => {
    const s = Math.max(0, (Date.now() - at) / 1000);
    if (s < 45) return 'now';
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
  const tokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  // Why pick each voice model: a line under the choice, and more in its tooltip with the cost.
  const WHY = { 'drama-3': 'More emotion. Slower, and costs more.', 's2.1-pro': 'Natural pace. Less emotion, costs less.' };
  const WHY_LONG = {
    'drama-3': 'The most expressive: whispers, laughs and real excitement. It talks slower, with pauses between sentences.',
    's2.1-pro': 'A natural, quicker pace. Feelings only come through lightly.',
  };
  // A spoken reply is about 200 characters (1 to 3 short sentences), so 100 replies are about 20,000. The offer's
  // last day is shown in Pacific time, as Fish states it (it ends Dec 1, 00:00 PT).
  const price = (c) => {
    const per100 = (perM) => `$${(perM * 0.02).toFixed(2)}`;
    const promo = c.promo && Date.now() < Date.parse(c.promo.until)
      ? ` (${per100(c.promo.perM)} until ${new Date(Date.parse(c.promo.until) - 1).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'America/Los_Angeles' })})` : '';
    return `$${c.perM} per million characters: about ${per100(c.perM)} per 100 replies${promo}. Billed to your Fish Audio account.`;
  };
  // Gemini's two: a reply is about 12 seconds of speech, so 100 replies are about 20 minutes.
  const GEMINI_WHY = { 'gemini-3.8-flash-lite-tts': 'Quick. Costs less.', 'gemini-3.8-flash-tts': 'Studio quality. Costs more.' };
  const GEMINI_WHY_LONG = {
    'gemini-3.8-flash-lite-tts': 'The quick, cheaper one: good for everyday replies.',
    'gemini-3.8-flash-tts': "Google's best voice quality, with more feeling in it.",
  };
  const geminiPrice = (c) => `About $${(c.per10s * 120).toFixed(2)} per 100 replies, billed to your Google AI Studio account (it has a free tier).`;
  const where = () => (state?.os === 'mac' ? 'your Keychain' : state?.os === 'win' ? 'Windows, encrypted for your account' : state?.os === 'linux' ? 'your keyring' : 'this computer');

  // ---------------------------------------------------------------- header
  function head() {
    const s = state.status;
    $('led').className = `led${s.state === 'ready' ? ' on' : s.state === 'busy' ? ' busy' : ''}`;
    const now = $('now');
    now.replaceChildren(el('b', { textContent: s.text }), state.model ? ` · ${state.model.name}` : s.state === 'off' ? ' · Sign in on the Model page' : '');
    now.title = now.textContent;
    $('ver').textContent = `v${state.version}`;
    updateButton();
    react();
    // The sidebar marks a page that needs you: no account to answer with.
    mark('model', s.state === 'off' ? 'not signed in' : null);
  }
  // One button for updates, updated in place (not rebuilt) so it keeps focus: Check for updates, then Update to x
  // (it downloads, installs and restarts), then Done. "Up to date" shows for a few seconds after a check.
  const FRESH = 6000;
  let freshTimer = 0;
  function updateButton() {
    const u = state.update, b = $('head-update'), v = u.available;
    const fresh = u.result?.ok && Date.now() - (u.result.at ?? 0) < FRESH;
    const [label, aria, kind, off] =
      u.done ? ['Done', `Roamies ${u.done} is installed. Restarting`, 'ghost', true]
      : u.installing ? ['Updating…', `Installing Roamies ${v}`, 'ghost', true]
      : v ? (u.page ? [`Get ${v}`, `Open the download page for Roamies ${v}`, 'primary', false] : [`Update to ${v}`, `Install Roamies ${v} and restart`, 'primary', false])
      : u.checking ? ['Checking…', 'Checking for updates', 'ghost', true]
      : fresh ? ['Up to date', `Roamies ${state.version} is up to date`, 'ghost', true]
      : u.result ? ['Check again', "Couldn't check for updates. Check again", 'ghost', false]
      : ['Check for updates', 'Check for updates', 'ghost', false];
    b.hidden = false; b.textContent = label; b.disabled = off;
    b.className = `px btn mini ${kind}`;
    b.setAttribute('aria-label', aria);
    b.title = u.result && !u.result.ok && !v && !u.checking ? u.result.error ?? "Couldn't check for updates." : '';
    clearTimeout(freshTimer);
    if (fresh) freshTimer = setTimeout(() => state && updateButton(), FRESH - (Date.now() - u.result.at) + 50);
  }
  $('head-update').addEventListener('click', () => act(state?.update?.available ? 'install_update' : 'update'));
  // Quit asks first: the first press turns it into Confirm for 4 s, the second quits.
  const quitB = $('head-quit');
  let quitTimer = 0;
  const unarmQuit = () => { clearTimeout(quitTimer); quitB.setAttribute('aria-pressed', 'false'); quitB.setAttribute('aria-label', 'Quit Roamies'); };
  quitB.addEventListener('click', () => {
    if (quitB.getAttribute('aria-pressed') === 'true') { unarmQuit(); act('quit'); return; }
    quitB.setAttribute('aria-pressed', 'true'); quitB.setAttribute('aria-label', 'Confirm: quit Roamies');
    quitTimer = setTimeout(unarmQuit, 4000);
  });
  function mark(page, why) {
    const b = $(`nav-${page}`);
    b.classList.toggle('flag', !!why);
    let sr = b.querySelector('.sr-only');
    if (why && !sr) b.append(sr = el('span', { className: 'sr-only' }));
    if (sr) { if (why) sr.textContent = ` (${why})`; else sr.remove(); }
  }

  // ---------------------------------------------------------------- live Roamies
  // The same LED renderer as on the desktop and in the setup guide, drawn small: one in the header (the Roamie
  // you have, reacting to what's going on) and one per look on the Appearance page. One loop draws them all,
  // only while the panel is up and each canvas is on screen.
  const LED = [[4, 16, 18], [14, 92, 96], [40, 196, 184], [120, 255, 226], [230, 255, 250]];
  const live = new Set();
  let pointer = null; // the cursor in page px, for their eyes
  addEventListener('pointermove', (e) => { pointer = [e.clientX, e.clientY]; }, { passive: true });
  document.addEventListener('mouseleave', () => { pointer = null; });
  const ACT_SECS = { hype: 2.8, upset: 3.4, wave: 3.1, remind: 3.1, motivate: 3.1 };
  const POSES = {
    think: (t) => ({ arms: 1, tl: [-0.08, 0.5 + Math.sin(t * 2) * 0.03], tr: [0.98, 0.34], mouth: Math.sin(t * 0.9) > 0.6 ? 'o' : 'flat', brow: 'raised' }),
    concerned: () => ({ arms: 0.7, tl: [-0.45, 0.95], tr: [0.45, 0.95], mouth: 'frown', brow: 'raised' }),
  };
  // A Roamie on a canvas of w×h CSS px: the one on screen at half scale (the app's unit, every dot half size), so
  // each size shows its own art (the full face, the small one, the pointer) at its real size next to the others.
  const ZOOM = 0.5, UNIT = 340;
  function liveRoamie(canvas, w, h, { look = 'classic', y = 0.56, form = 'default' } = {}) {
    if (!window.Roamie?.ditherKit) return null;
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    const z = ZOOM, unit = UNIT;
    w /= z; h /= z;
    const env = {
      w, h, dpr, t: 0, unit, transparent: true, spawn: { x: w / 2, y: h * y },
      safe: { left: 0, right: 0, top: 0, bottom: 0 }, mouse: { x: w / 2, y: h * y, inside: false, active: false }, sleepy: 0, reduced: REDUCED.matches,
    };
    let K = null, clock = 0, actUntil = 0;
    const me = {
      pose: null, look, form,
      kit: Roamie.ditherKit({
        id: 'panel', label: 'Panel', matrix: true, pixel: 1.3, glow: 0.55, speed: 80, pal: LED,
        // busy: no acts of its own; pose: whatever's going on, except while it's acting something out.
        plugin: (kit) => { K = kit; return { busy: () => true, pose: () => (clock < actUntil ? null : POSES[me.pose]?.(clock) ?? null) }; },
      }).create(env),
      act(name) { if (!K || REDUCED.matches) return; K.startAct(name); actUntil = clock + (ACT_SECS[name] ?? 3); },
      setLook(l) { if (l === me.look) return; me.look = l; me.kit.setLook(l); },
      setForm(f) { if (f === me.form) return; me.form = f; me.kit.setForm(f); },
      appear(v = 'materialize') { me.kit.appear(REDUCED.matches ? 'crt' : v, w / 2, h * y); },
      step(dt) {
        clock += dt; env.t += dt; env.reduced = REDUCED.matches;
        // Eyes on the cursor, wherever it is in the panel; looking ahead when it's away.
        const r = canvas.getBoundingClientRect();
        if (pointer) Object.assign(env.mouse, { x: (pointer[0] - r.left) / z, y: (pointer[1] - r.top) / z, inside: true, active: true });
        else Object.assign(env.mouse, { x: w * 1.6, y: h * y, inside: true, active: true });
        me.kit.update(dt, env);
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(dpr * z, 0, 0, dpr * z, 0, 0);
        ctx.save(); me.kit.draw(ctx, env); ctx.restore();
      },
    };
    me.kit.setLook(look); me.kit.setForm(form); me.kit.resize(env);
    me.kit.mover.anchor = { x: w / 2, y: h * y, r: 1.5 };
    me.kit.vanish(null, true);
    live.add({ me, canvas });
    return me;
  }
  let lastFrame = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(1 / 30, (now - (lastFrame || now)) / 1000); lastFrame = now;
    if (document.hidden || $('frame').classList.contains('shut')) return;
    for (const { me, canvas } of live) if (canvas.isConnected && canvas.offsetParent) me.step(dt);
  }
  requestAnimationFrame(loop);

  // The header's Roamie: your look, reacting to what's going on. A short line beside it when something changes.
  // The same size and detail as the look tiles (fewer dots than that and the faces turn to noise).
  const avatar = liveRoamie($('avatar'), 100, 74, { y: 0.55 });
  const QUIPS = { classic: 'Classic me!', jarvis: 'At your service.', anime: 'Yay, hi hi!', sarah: 'Hey, nice to meet you!', adrian: "Alright, let's do this.", rita: 'Shall we get to work?' };
  let quipTimer = 0, seen = { look: null, update: null, opened: 0 };
  function quip(text, secs = 2.6) {
    const q = $('saying'), n = $('by');
    clearTimeout(quipTimer);
    q.textContent = text; q.classList.add('on'); n.classList.add('quiet');
    quipTimer = setTimeout(() => { q.classList.remove('on'); n.classList.remove('quiet'); }, secs * 1000);
  }
  function react() {
    if (!avatar) return;
    avatar.pose = state.busy ? 'think' : state.status.state === 'off' ? 'concerned' : null;
    if (seen.look && state.look !== seen.look) { avatar.setLook(state.look); avatar.act('wave'); quip(QUIPS[state.look] ?? 'Hi!'); }
    else avatar.setLook(state.look);
    avatar.setForm(state.size);
    if (state.update.available && state.update.available !== seen.update && seen.look) { avatar.act('hype'); quip(`Roamies ${state.update.available} is here!`); }
    seen.look = state.look; seen.update = state.update.available;
  }

  // ---------------------------------------------------------------- Home
  function home() {
    const u = state.update;
    const mac = state.os === 'mac';
    return [
      el('div', { className: 'group' },
        el('h2', { className: 'sr-only', textContent: 'Actions' }),
        el('div', { className: 'actions' },
          // askKeys: the type-to-ask shortcut (a tap of two modifier keys), so it can be learnt from the button.
          btn('Ask', () => act('ask', true), { kind: u.available ? 'ghost' : 'primary', k: 'ask', disabled: state.busy,
            aria: state.askKeys ? `Ask ${state.name}, or tap ${state.askKeys} anywhere` : `Ask ${state.name}`, title: state.askKeys ? `Or tap ${state.askKeys} anywhere` : null }),
          btn('Show list', () => act('list', true), { k: 'list' }),
          state.snap ?? mac ? btn('Ask about an area', () => act('snap', true), { k: 'snap' }) : null,
          state.busy ? btn('Stop', () => act('stop'), { k: 'stop' }) : btn('New chat', () => act('new'), { k: 'new', disabled: !state.canNew, aria: 'Start a new conversation' }),
          mac ? null : btn(`Show ${state.name}`, () => act('show', true), { k: 'show' }))),
      recentList(),
    ].flat();
  }
  function recentList() {
    const { box, nav } = paged('recent', state.recent, (r) => el('li', { className: `item ${r.kind}` },
      el('span', { className: 'mark', 'aria-hidden': 'true' }),
      el('span', { className: 'text', textContent: r.kind === 'ask' ? `“${r.text}”` : r.text, title: r.text }),
      el('span', { className: 'meta', textContent: ago(r.at) })), { label: 'Recent' });
    return [
      el('div', { className: 'group paged' }, el('div', { className: 'ghead' }, el('h2', { textContent: 'Recent' })), box),
      foot(state.usage ? el('p', { className: 'usage', textContent: `Today: ${state.usage.requests} request${state.usage.requests === 1 ? '' : 's'} · ${tokens(state.usage.tokens)} tokens` }) : null, nav),
    ];
  }

  // ---------------------------------------------------------------- pages of a long list
  // As many rows as fit (measured after drawing, see fit()), the rest a page away with the arrows in the footer.
  const EMPTY = 'Nothing yet…';
  // pin: the index of a row that must stay in view (an open key field), whatever page that puts it on.
  function paged(key, items, row, { label, empty = EMPTY, id, pin = -1 } = {}) {
    const per = ui.per[key] ?? 8, pages = Math.max(1, Math.ceil(items.length / per));
    if (pin >= 0) ui.pg[key] = Math.floor(pin / per);
    const pg = ui.pg[key] = Math.min(Math.max(0, ui.pg[key] ?? 0), pages - 1);
    const shown = items.slice(pg * per, pg * per + per);
    const box = el('div', { className: 'pagebox', 'data-pager': key, id },
      shown.length ? el('ul', { className: 'list', 'aria-label': label }, shown.map(row)) : el('p', { className: 'empty', textContent: empty }));
    return { box, nav: pages > 1 ? pager(key, pg, pages, label) : null };
  }
  function pager(key, pg, pages, label) {
    const go = (d) => {
      ui.pg[key] = pg + d; disarm();
      // Keep focus on an arrow that still works at the end of the list.
      const edge = pg + d === 0 || pg + d === pages - 1;
      refresh(`${key}:${edge ? (d < 0 ? 'next' : 'prev') : d < 0 ? 'prev' : 'next'}`);
    };
    return el('div', { className: 'pager', role: 'group', 'aria-label': `${label}: page ${pg + 1} of ${pages}` },
      btn('‹', () => go(-1), { kind: 'ghost mini', k: `${key}:prev`, disabled: pg === 0, aria: 'Previous page' }),
      el('span', { className: 'pnum', textContent: `${pg + 1} / ${pages}`, 'aria-hidden': 'true' }),
      btn('›', () => go(1), { kind: 'ghost mini', k: `${key}:next`, disabled: pg === pages - 1, aria: 'Next page' }));
  }
  // The page's footer: something about the whole list on the left, the arrows on the right; none when both are empty.
  const foot = (left, nav, id) => (left || nav ? el('div', { className: 'pfoot', id }, el('div', { className: 'pfoot-l' }, left), nav) : null);
  // How many rows fit in each list's box now; true when that changed (so it's drawn again). An open row (a key
  // field) takes its extra room off the page instead of setting the size of every row.
  function fit() {
    let changed = false;
    for (const box of document.querySelectorAll(`#pane-${tab} .pagebox`)) {
      const rows = [...box.querySelectorAll('.list > li')];
      if (!rows.length || !box.clientHeight) continue;
      const shut = rows.filter((r) => !r.classList.contains('open'));
      const unit = Math.max(...(shut.length ? shut : rows).map((r) => r.offsetHeight));
      const extra = rows.filter((r) => r.classList.contains('open')).reduce((n, r) => n + Math.max(0, r.offsetHeight - unit), 0);
      const per = Math.max(3, Math.floor((box.clientHeight - extra) / unit));
      if (per !== ui.per[box.dataset.pager]) { ui.per[box.dataset.pager] = per; changed = true; }
    }
    return changed;
  }

  // ---------------------------------------------------------------- Memory
  // Two tabs, What I remember and Commitments, each a page at a time; Get to know me at the end of the tab row.
  function memory() {
    const on = ui.mtab;
    const tabBtn = (id, label) => el('button', {
      className: 'tab', type: 'button', role: 'tab', id: `tab-${id}`, 'aria-selected': String(on === id), 'aria-controls': 'mem-panel', tabIndex: on === id ? 0 : -1, 'data-k': `tab-${id}`,
      on: { click: () => { if (ui.mtab !== id) { ui.mtab = id; disarm(); render(`tab-${id}`); } } },
    }, label);
    return [
      el('div', { className: 'mhead' },
        el('div', { className: 'tabs', role: 'tablist', 'aria-label': 'Memory' }, tabBtn('facts', 'What I remember'), tabBtn('commits', 'Commitments')),
        link('Get to know me', () => act('intro', true), { k: 'intro', disabled: state.intro })),
      ...(on === 'commits' ? commitList() : factList()),
    ];
  }
  function factList() {
    const f = state.facts, q = ui.q.trim().toLowerCase();
    const hits = q ? f.filter((x) => x.text.toLowerCase().includes(q)) : f;
    const { box, nav } = paged('facts', hits, (x) => el('li', { className: 'item mem' },
      el('span', { className: 'text', textContent: x.text, title: x.text }),
      el('span', { className: 'row-btns icons' }, iconArmed('x', 'Forget', `forget:${x.id}`, `forget:${x.id}`, `Forget: ${x.text}`))), { label: 'What I remember', empty: q ? `No match for "${ui.q.trim()}".` : EMPTY, id: 'facts-box' });
    // Search once there's more than a page: it looks through all of them, and the pages follow the matches.
    const search = f.length > (ui.per.facts ?? 8) || q ? el('div', { className: 'find' }, el('span', { className: 'px field' },
      el('input', { type: 'search', id: 'find-facts', value: ui.q, placeholder: `Search ${f.length} memories`, 'aria-label': 'Search what I remember', autocomplete: 'off', spellcheck: false,
        on: { input: (e) => { ui.q = e.target.value; ui.pg.facts = 0; refreshFacts(); }, keydown: (e) => { if (e.key === 'Escape' && ui.q) { e.preventDefault(); e.stopPropagation(); e.target.value = ui.q = ''; refreshFacts(); } } } }))) : null;
    return [
      el('div', { className: 'group paged', role: 'tabpanel', id: 'mem-panel', 'aria-labelledby': 'tab-facts' }, search, box),
      foot(f.length ? armed('Forget everything', `Forget all ${f.length}`, 'forget-all', 'forgetall:yes', `Forget all ${f.length} things I remember`) : null, nav, 'facts-foot'),
    ];
  }
  // Searching redraws just the list and its footer, so the search field keeps its focus and caret.
  function refreshFacts() {
    const [panel, ft] = factList(), box = $('facts-box');
    if (!box) return render();
    box.replaceWith(panel.querySelector('#facts-box'));
    const old = $('facts-foot');
    if (old && ft) old.replaceWith(ft); else if (old) old.remove(); else if (ft) $('mem-panel').after(ft);
    if (fit()) refreshFacts();
  }
  function commitList() {
    const { box, nav } = paged('commits', state.commitments, (x) => el('li', { className: 'item mem' },
      el('span', { className: 'text', title: x.text }, x.text, x.when ? el('small', { className: x.overdue ? 'late' : '', textContent: x.overdue ? `Overdue · ${x.when}` : x.when }) : null),
      el('span', { className: 'row-btns icons' },
        iconArmed('tick', 'Done', `done:${x.id}`, `done:${x.id}`, `Done: ${x.text}`),
        iconArmed('x', 'Drop', `drop:${x.id}`, `drop:${x.id}`, `Drop: ${x.text}`))), { label: 'Commitments' });
    const n = state.commitments.length;
    return [el('div', { className: 'group paged', role: 'tabpanel', id: 'mem-panel', 'aria-labelledby': 'tab-commits' }, box), foot(n ? el('p', { className: 'usage', textContent: `${n} open` }) : null, nav)];
  }
  // A page arrow: the search field (if it has focus) is kept by redrawing only the list.
  const refresh = (focusKey) => (tab === 'memory' && ui.mtab === 'facts' && document.activeElement?.id === 'find-facts' ? refreshFacts() : render(focusKey));

  // ---------------------------------------------------------------- Settings
  // A masked key field that opens in place. id: a provider, or a voice service ('fish', 'gemini'). kinds: the kinds of key it takes
  // (Kimi and Xiaomi: a plan key or a pay-per-token key), picked above the field; onsave gets the kind's id.
  function keyForm(id, label, onsave, kinds = null) {
    const kind = kinds?.find((x) => x.id === ui.kind[id]) ?? kinds?.[0];
    const name = kind?.label ?? label;
    const input = el('input', { type: 'password', id: `key-${id}`, autocomplete: 'off', spellcheck: false, placeholder: `${name} key`, 'aria-label': `${name} API key`, maxLength: 1000 });
    const save = () => { const v = input.value.trim(); if (!v) return input.focus(); onsave(v, kind?.id); input.value = ''; closeKey(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') { e.stopPropagation(); closeKey(); } });
    const row = el('div', { className: 'keyform', hidden: ui.key !== id, 'data-anim': `key-${id}` }, el('span', { className: 'px field' }, input), btn('Save', save, { k: `save:${id}` }));
    if (!kinds) return row;
    row.hidden = false; delete row.dataset.anim;
    return el('div', { className: 'keykinds', hidden: ui.key !== id, 'data-anim': `key-${id}` },
      picks(`${label} key type`, kinds.map((x) => [x.id, x.label]), kind.id, (v) => { ui.kind[id] = v; render(`kind-${id}:${v}`); }, `kind-${id}`,
        Object.fromEntries(kinds.map((x) => [x.id, x.billing]))),
      row);
  }

  const signIn = (p) => link('Sign in', () => act(`login:${p.id}`), { k: `login:${p.id}`, aria: `Sign in to ${p.label}`, disabled: !!state.loggingIn });
  const connect = (p) => link('Connect', () => act('local:connect'), { k: 'local:connect', aria: `Connect ${p.label}` });
  const addKey = (p) => link(ui.key === p.id ? 'Cancel' : 'Add key', () => toggleKey(p.id), { k: `addkey:${p.id}`, aria: `Add ${p.label} API key` });

  // A connected account's key: replace it (saving under the same kind overwrites it), or add one next to a sign-in.
  const changeKey = (p) => link(ui.key === p.id ? 'Cancel' : p.keySaved ? 'Change key' : 'Add key', () => toggleKey(p.id),
    { k: `addkey:${p.id}`, aria: `${p.keySaved ? 'Change the' : 'Add a'} ${p.label} API key` });

  // Settings, one page per concern.
  function modelPage() {
    const on = state.providers.filter((p) => p.on);
    const model = state.model ? `${state.model.provider}:${state.model.id}` : '';
    const select = on.length ? el('span', { className: 'px field select' },
      el('select', { 'aria-label': 'Model', 'data-k': 'model', on: { change: (e) => act(`model:${e.target.value}`) } },
        model ? null : el('option', { value: '', textContent: 'Pick a model', disabled: true, selected: true }),
        on.map((p) => el('optgroup', { label: p.label }, p.models.map((m) => el('option', { value: `${p.id}:${m.id}`, textContent: m.name, selected: `${p.id}:${m.id}` === model })))))) : null;
    const accounts = state.providers.filter((p) => p.on || p.method);
    const { box, nav } = paged('accounts', accounts, (p) => el('li', { className: `acct${ui.key === p.id ? ' open' : ''}` },
      el('div', { className: 'setting' },
        // Connected: a lit dot by the name, its word in a tooltip (and for screen readers).
        el('span', { className: 'acct-name' }, p.label, p.on ? el('span', { className: 'led on', role: 'img', 'aria-label': p.method === 'local' ? 'Connected' : 'Signed in', 'data-tip': p.method === 'local' ? 'Connected' : 'Signed in' }) : null),
        p.on ? el('span', { className: 'row-btns' },
          p.key ? changeKey(p) : null,
          ui.key === p.id ? null : armed(p.signedIn && !p.keySaved ? 'Sign out' : 'Remove', 'Confirm', `signout:${p.id}`, `signout:${p.id}`, `Remove ${p.label} from Roamies`))
          : state.loggingIn === p.id ? el('span', { className: 'waiting', textContent: 'Signing in…' })
          : p.method === 'local' ? connect(p)
          : p.method === 'oauth' ? (p.key ? el('span', { className: 'links' }, signIn(p), addKey(p)) : signIn(p))
          : addKey(p)),
      // Ollama: why its models aren't in the Model menu (not running, or none can see images).
      p.note ? el('p', { className: 'empty note', textContent: p.note }) : null,
      p.method === 'key' || p.key ? keyForm(p.id, p.label, (key, kind) => send({ type: 'panel_key', provider: p.id, kind, key }), p.kinds) : null),
    { label: 'Accounts', pin: accounts.findIndex((p) => p.id === ui.key) });
    return [
      group('Model', 'Which AI answers you.', null,
        select ?? el('p', { className: 'empty', textContent: 'Sign in to an account below first.' })),
      el('div', { className: 'group paged' }, el('div', { className: 'ghead' }, el('h2', { textContent: 'Accounts' }), el('p', { textContent: 'Sign in to use their models.' })), box),
      foot(null, nav),
    ];
  }
  function appearancePage() {
    return [
      group('Look', 'Each look has its own name and voice.', null, lookTiles()),
      group('Size', 'How big I am on your screen.', null, picks('Size', state.sizes, state.size, (x) => act(`size:${x}`), 'size')),
    ];
  }
  // The looks as live tiles: each one's character, playing, at the size picked below. Kept between renders (a state update mustn't restart
  // them); hovering or focusing one makes it wave; picking it makes it cheer.
  const tiles = new Map();
  function lookTiles() {
    const g = tiles.get('_group') ?? el('div', { className: 'looks', role: 'radiogroup', 'aria-label': 'Look' });
    tiles.set('_group', g);
    g.replaceChildren(...state.looks.map(([id, name]) => {
      let t = tiles.get(id);
      if (!t) {
        const cv = el('canvas', { 'aria-hidden': 'true' });
        const b = el('button', { className: 'px looktile', type: 'button', role: 'radio', 'data-k': `look:${id}` }, cv, el('span', { className: 'name', textContent: name }));
        const r = liveRoamie(cv, 104, 76, { look: id, y: 0.55, form: state.size });
        t = { b, r, waved: 0 };
        const wave = () => { if (r && Date.now() - t.waved > 3500) { t.waved = Date.now(); r.act('wave'); } };
        b.addEventListener('pointerenter', wave);
        b.addEventListener('focus', () => b.matches(':focus-visible') && wave());
        b.addEventListener('click', () => { if (state.look !== id) { r?.act('hype'); act(`look:${id}`); } });
        tiles.set(id, t);
        r?.appear('crt');
      }
      t.r?.setForm(state.size);
      const on = state.look === id;
      t.b.setAttribute('aria-checked', String(on)); t.b.tabIndex = on ? 0 : -1;
      return t.b;
    }));
    return g;
  }
  // VoiceStudio on this computer: whether it's ready (or exactly why not), its engine, the voice, and Check again.
  function studioRows() {
    const vs = state.studio ?? { checking: true };
    const status = vs.checking ? 'Checking VoiceStudio…' : vs.ok ? `Connected${vs.engine ? ` · ${vs.engine}` : ''}` : vs.message || "VoiceStudio isn't available.";
    const voices = vs.voices ?? [];
    return [
      el('div', { className: 'setting' },
        el('span', {}, 'VoiceStudio', el('small', { className: vs.ok || vs.checking ? '' : 'bad', textContent: status, role: vs.ok || vs.checking ? null : 'alert' })),
        el('span', { className: 'row-btns' }, link('Check again', () => act('voicestudio_check'), { k: 'voicestudio_check', aria: 'Check VoiceStudio again' }))),
      vs.ok ? el('div', { className: 'reveal', 'data-anim': 'studio-voice' },
        el('p', { className: 'sub', textContent: `Voice for ${state.name}` }),
        el('span', { className: 'px field select' },
          el('select', { 'aria-label': 'VoiceStudio voice', 'data-k': 'studiovoice', on: { change: (e) => act(`studiovoice:${e.target.value}`) } },
            el('option', { value: 'default', textContent: 'Engine default', selected: !vs.voice || !voices.some((x) => x.id === vs.voice) }),
            voices.map((x) => el('option', { value: x.id, textContent: x.name, selected: x.id === vs.voice })))),
        voices.length ? null : el('p', { className: 'why', textContent: 'Save a voice in VoiceStudio (clone or design one) to pick it here.' }),
      ) : null,
    ];
  }
  const TTS_NAMES = { fish: 'Fish Audio', gemini: 'Gemini', voicestudio: 'VoiceStudio' };
  function voicePage() {
    const v = state.voice;
    // The service that speaks, each with its own key: Fish Audio's voice is the look's and it has models to pick
    // from; Gemini has a list of voices and two models; VoiceStudio runs on this computer and needs no key.
    const tts = TTS_NAMES[state.tts] ? state.tts : 'fish', T = TTS_NAMES[tts], local = tts === 'voicestudio', hasKey = local || !!state[`${tts}Key`];
    // Gemini can speak with the key the AI already has (the Model page), until the voice gets one of its own.
    const shared = tts === 'gemini' && hasKey && !!state.geminiShared;
    return [
      group('Spoken replies', 'Hear me as well as read me.', null,
        picks('Replies', [['text', 'Text only'], ['voice', 'Voice and text']], state.replies, (x) => {
          if (x === 'voice' && !hasKey) { ui.key = tts; render(`key-${tts}`); note(`Add a ${T} key to hear me talk.`); return; }
          act(`replies:${x}`);
        }, 'replies'),
        el('p', { className: 'sub', textContent: 'Voice provider' }),
        picks('Voice provider', Object.entries(TTS_NAMES), tts, (x) => {
          if (x !== 'voicestudio' && !state[`${x}Key`]) { ui.key = x; note(`Add a ${TTS_NAMES[x]} key to hear me talk.`); } // its key field opens with it
          act(`tts:${x}`);
        }, 'tts', { fish: 'A voice for each look, acted out with feeling. Billed to your Fish Audio account.', gemini: "Google's voices: pick one of 30. Billed to your Google AI Studio account.", voicestudio: 'The free VoiceStudio app on this computer, in the engine and voices you set up there. Nothing leaves your computer.' }),
        local ? el('div', { className: 'reveal', 'data-anim': 'studio' }, studioRows()) : null,
        tts === 'gemini' && hasKey && state.geminiVoices?.length ? el('div', { className: 'reveal', 'data-anim': 'gemini-voice' },
          el('p', { className: 'sub', textContent: `Voice for ${state.name}` }),
          el('span', { className: 'px field select' },
            el('select', { 'aria-label': 'Gemini voice', 'data-k': 'geminivoice', on: { change: (e) => act(`geminivoice:${e.target.value}`) } },
              state.geminiVoices.map((g) => el('option', { value: g.id, textContent: `${g.id} · ${g.style}`, selected: g.id === state.geminiVoice })))),
        ) : null,
        tts === 'gemini' && hasKey && state.geminiModels?.length ? el('div', { className: 'reveal', 'data-anim': 'gemini-model' },
          el('p', { className: 'sub', textContent: 'Voice model' }),
          picks('Voice model', state.geminiModels.map((c) => [c.id, c.name]), state.geminiModel, (x) => act(`geminimodel:${x}`), 'geminimodel',
            Object.fromEntries(state.geminiModels.map((c) => [c.id, `${GEMINI_WHY_LONG[c.id] ?? ''} ${geminiPrice(c)}`.trim()]))),
          el('p', { className: 'why', textContent: GEMINI_WHY[state.geminiModel] ?? '' }),
        ) : null,
        tts === 'fish' && state.replies === 'voice' && state.fishModels?.length ? el('div', { className: 'reveal', 'data-anim': 'fish-model' },
          el('p', { className: 'sub', textContent: 'Voice model' }),
          picks('Voice model', state.fishModels.map((c) => [c.id, c.name]), state.fishModel, (x) => act(`fishmodel:${x}`), 'fishmodel',
            Object.fromEntries(state.fishModels.map((c) => [c.id, `${WHY_LONG[c.id] ?? ''} ${price(c)}`.trim()]))),
          el('p', { className: `why${state.fishFree ? ' late' : ''}`, textContent: state.fishFree ? "No credit left, so it's on Fish's free tier" : WHY[state.fishModel] ?? '' }),
        ) : null,
        local ? null : el('div', { className: 'setting' },
          el('span', {}, `${T} key`, el('small', { textContent: shared ? 'Shared with the Model page' : hasKey ? `Saved in ${where()}` : 'Needed for spoken replies' })),
          el('span', { className: 'row-btns' },
            link(ui.key === tts ? 'Cancel' : shared ? 'Use another' : hasKey ? 'Change' : 'Add', () => toggleKey(tts), { k: `addkey:${tts}`, aria: hasKey ? `Change the ${T} key` : `Add a ${T} key` }),
            hasKey && !shared && ui.key !== tts ? armed('Remove', 'Confirm', `${tts}key-remove`, `${tts}key_remove`, `Remove the ${T} key`) : null)),
        local ? null : keyForm(tts, T, (key) => send({ type: `panel_${tts}key`, key }))),
      v ? group('Talking to me', 'Speak instead of typing.', null,
        toggle('Voice control', v.download
          ? (v.download.status === 'downloading' ? `Downloading the voice model… ${v.download.pct}%` : v.download.status === 'error' ? 'The download failed' : `Needs a ${v.download.size} download`)
          : v.keys ? `Hold ${v.keys} to talk` : 'Press your talk shortcut to talk', v.on, () => act('voice'), 'voice'),
        v.download && v.download.status !== 'downloading' ? el('div', { className: 'links' }, link(v.download.status === 'error' ? 'Retry the download' : `Download (${v.download.size})`, () => act('voicedl'), { k: 'voicedl' })) : null,
        v.mac ? toggle('Mute Mac while talking', 'Other sounds go quiet while you talk', v.mute, () => act('mutetalk'), 'mutetalk') : null) : null,
    ];
  }
  // Wayland: the commands to bind to keys in the desktop's settings (no app may hold its own shortcuts there).
  // A command shows only after copying it failed, so it can be copied by hand.
  const BIND_ROWS = [['talk', 'Talk to me'], ['summon', 'Show or hide me'], ['ask', 'Ask me'], ['list', 'Your list'], ['panel', 'This panel']];
  function behaviorPage() {
    const b = state.bind;
    return [
      group('Behavior', 'What I may do, and when I start.', null,
        toggle('Sound effects', null, state.sound, () => act('sound'), 'sound'),
        state.focus ? el('div', { className: 'setting' },
          el('span', {}, state.focus.until ? 'Focus block running' : 'Focus distractions',
            el('small', { textContent: state.focus.until ? `Until ${new Date(state.focus.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${state.focus.task ? ` · ${state.focus.task}` : ''}` : `Say “focus for 30 minutes”. I watch for: ${state.focus.list.slice(0, 4).join(', ')}${state.focus.list.length > 4 ? '…' : ''}` })),
          state.focus.until ? link('Stop', () => act('focusstop'), { k: 'focusstop', aria: 'Stop the focus block' }) : link('Edit', () => act('distractions'), { k: 'distractions', aria: 'Edit the distraction list' })) : null,
        state.brief ? toggle('Morning briefing', 'The first time you talk to me each day, I start with what’s due.', state.brief.on, () => act('morningbrief'), 'morningbrief') : null,
        state.brief?.on && state.brief.canTodoist ? toggle('Include Todoist', 'I read your Todoist window (opening it if needed). Stay signed in.', state.brief.todoist, () => act('brieftodoist'), 'brieftodoist') : null,
        toggle('Allow file edits and commands', 'Change files and run commands', state.actions, () => act('actions'), 'actions'),
        state.voice ? toggle('Auto-listen', state.voice.on ? 'Mic opens when I ask you something.' : 'Needs Voice control on', state.voice.autoListen, () => act('autolisten'), 'autolisten') : null,
        state.voice?.mac ? toggle('Wake word', state.voice.on ? `Say “Hey ${state.voice.wakeName || 'Roamies'}” to talk. Mic stays on.` : 'Needs Voice control on', state.voice.wakeWord, () => act('wakeword'), 'wakeword') : null,
        state.voice?.mac ? el('div', { className: 'setting' }, el('span', {}, 'Wake word name', el('small', { textContent: `Hey ${state.voice.wakeName || 'Roamies'}` })),
          link('Change', () => act('wakename'), { k: 'wakename', aria: 'Change the wake word name' })) : null,
        state.voice?.mac ? toggle('Clap to wake', state.voice.on ? 'Clap twice to talk. Mic stays on.' : 'Needs Voice control on', state.voice.wakeClaps, () => act('wakeclaps'), 'wakeclaps') : null,
        state.login ? toggle('Open at login', null, state.login.on, () => act('login'), 'login') : null),
      b ? group('Shortcuts', 'Add these as custom shortcuts in your keyboard settings, with any keys you like.', null,
        BIND_ROWS.filter(([k]) => b[k]).map(([k, label]) => el('div', { className: 'setting' },
          el('span', {}, label, ui.bindShown.has(k) ? el('small', { className: 'cmd', textContent: b[k] }) : null),
          link('Copy', () => send({ type: 'copy_bind', which: k }), { k: `bind-${k}`, aria: `Copy the command for ${label.toLowerCase()}` })))) : null,
    ];
  }
  // Who made Roamies: Ken, live (he's drawn like the looks but isn't one), and where to find him.
  const KEN = [
    ['Skool', 'Learn with Ken, or support him', 'https://www.skool.com/kenkai', "Open Ken Kai's Skool community"],
    ['YouTube', '@kenkaidoesai', 'https://www.youtube.com/@kenkaidoesai', "Open Ken Kai's YouTube channel"],
    ['TikTok', '@ggkenkai', 'https://www.tiktok.com/@ggkenkai', "Open Ken Kai's TikTok"],
    ['Source code', 'Open source under AGPL-3.0', 'https://github.com/KenKaiii/Roamies', 'Open the Roamies source code on GitHub'],
  ];
  let ken = null;
  function maker() {
    if (!ken) {
      const cv = el('canvas', { 'aria-hidden': 'true' });
      const r = liveRoamie(cv, 100, 74, { look: 'ken', y: 0.55 });
      const card = el('div', { className: 'maker' }, cv, el('span', {}, 'Ken Kai', el('small', { textContent: 'Creator of Roamies' })));
      let waved = 0;
      card.addEventListener('pointerenter', () => { if (r && Date.now() - waved > 3500) { waved = Date.now(); r.act('wave'); } });
      r?.appear('crt');
      ken = card;
    }
    return ken;
  }
  function aboutPage() {
    return [
      group('Made by', null, null, maker(),
        KEN.map(([label, hint, url, aria]) => el('div', { className: 'setting' },
          el('span', {}, label, el('small', { textContent: hint })),
          link('Open', () => send({ type: 'open_link', url }), { k: `ken-${label.toLowerCase()}`, aria })))),
      group('Help', null, null,
        el('div', { className: 'links' },
          link('Setup guide', () => act('setup', true), { k: 'setup' }),
          link('Show logs', () => act('logs'), { k: 'logs' }),
          link('Save diagnostics', () => act('diagnostics'), { k: 'diagnostics', aria: 'Save a diagnostics file to send when something goes wrong' }),
          // Only once there is one: the latest error anyone saw, in full, for pasting into a report.
          state.problem ? link('Copy last error', copyProblem, { k: 'copy-problem' }) : null)),
    ];
  }

  // ---------------------------------------------------------------- What's new
  // One change per row, from whatsnew.json (written with each commit): this update's first, lit, then the rest.
  // This update: everything since the version they updated from (whatsNewFrom), else this version's own.
  let news = null;
  fetch('whatsnew.json').then((r) => r.json()).then((d) => { news = Array.isArray(d?.updates) ? d.updates : []; })
    .catch(() => { news = []; }).finally(() => { if (state && tab === 'whatsnew') render(); });
  const KIND = { new: 'New', improved: 'Improved', fixed: 'Fixed', removed: 'Removed' };
  const later = (a, b) => {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    return false;
  };
  function whatsNewPage() {
    if (!news) return [];
    const from = state.whatsNewFrom, now = state.version;
    const fresh = (u) => u.version == null || (from ? later(u.version, from) && !later(u.version, now) : u.version === now);
    const all = news.flatMap((u) => (u.items ?? []).map((it) => ({ ...it, version: u.version, date: u.date, fresh: fresh(u) })));
    all.sort((a, b) => b.fresh - a.fresh);
    const lit = all.filter((r) => r.fresh).length;
    const day = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    const { box, nav } = paged('whatsnew', all, (r) => el('li', { className: `item wn${r.fresh ? ' fresh' : ''}` },
        el('div', { className: 'wn-top' },
          el('span', { className: 'wn-title', textContent: r.title }),
          el('span', { className: `wn-kind k-${r.kind}`, textContent: KIND[r.kind] ?? r.kind })),
        el('span', { className: 'wn-date', textContent: `${day(r.date)} · ${r.version ? `v${r.version}` : 'Not out yet'}` }),
        el('p', { className: 'wn-text', textContent: r.text }),
        r.fresh ? el('span', { className: 'sr-only', textContent: 'In this update.' }) : null),
    { label: "What's new", empty: 'Nothing here yet.' });
    return [
      el('div', { className: 'group paged' }, el('div', { className: 'ghead' },
        el('h2', {}, "What's new", el('span', { className: 'n', textContent: `v${now}` })),
        el('p', { textContent: lit ? `The lit ${lit === 1 ? 'one is' : `${lit} are`} what's new in this update.` : 'Everything I changed lately, newest first.' })), box),
      foot(null, nav),
    ];
  }

  // ---------------------------------------------------------------- render
  const PANES = { home, memory, model: modelPage, appearance: appearancePage, voice: voicePage, behavior: behaviorPage, about: aboutPage, whatsnew: whatsNewPage };
  // focusKey: what to focus after (a data-k, or an element id); otherwise whatever had focus keeps it.
  function render(focusKey, animate = false) {
    if (!state) return;
    const active = document.activeElement;
    // Never rebuild under someone typing a key: catch up when they leave the field.
    if (!focusKey && !animate && active?.tagName === 'INPUT' && active.closest('.pane')) { deferred = true; return; }
    deferred = false;
    const keep = focusKey ?? active?.dataset?.k ?? (active?.id?.startsWith('key-') ? active.id : null);
    hideTip();
    const scroll = $('pane-' + tab).closest('.body').scrollTop;
    head();
    const pane = $(`pane-${tab}`);
    const same = render.tab === tab; render.tab = tab;
    const before = new Set([...pane.querySelectorAll('[data-anim]')].filter(shown).map((n) => n.dataset.anim));
    const draw = () => { pane.replaceChildren(...PANES[tab]().flat().filter(Boolean)); pane.classList.toggle('paged', !!pane.querySelector('.pagebox')); };
    draw();
    // Lists show as many rows as fit: drawn once to measure, again if a different number fits.
    if (fit()) draw();
    pane.closest('.body').scrollTop = scroll;
    if (same && !animate) for (const n of pane.querySelectorAll('[data-anim]')) if (shown(n) && !before.has(n.dataset.anim)) grow(n, true);
    // Rows fill in one after another (a page's worth; the rest come with the last), only when it opens or
    // the tab changes, never on the updates that arrive while it's open.
    pane.classList.toggle('enter', animate);
    if (animate) {
      let i = 0;
      for (const n of pane.children) { n.style.setProperty('--i', Math.min(i++, 10)); for (const li of n.querySelectorAll('.list > li')) li.style.setProperty('--i', Math.min(i++, 10)); }
      clearTimeout(render.t); render.t = setTimeout(() => pane.classList.remove('enter'), 600);
    }
    if (keep) (document.querySelector(`.pane [data-k="${CSS.escape(keep)}"]`) ?? document.getElementById(keep))?.focus();
  }
  document.addEventListener('focusout', (e) => { if (deferred && e.target.tagName === 'INPUT') setTimeout(() => deferred && render(), 0); });
  // The window changes size with the screen it opens on: as many rows as fit there.
  let resizeTimer = 0;
  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => state && render(), 120); });

  // copy: the app has the full error behind this line; Copy details puts it on the clipboard (and the note stays
  // up longer, to leave time to press it).
  const copyProblem = () => send({ type: 'copy_problem', from: 'panel' });
  let noteTimer = 0;
  function note(text, bad = false, copy = false) {
    const n = $('note');
    n.replaceChildren(el('span', { textContent: text, title: text }), ...(copy ? [link('Copy details', copyProblem, { k: 'note-copy' })] : []));
    n.removeAttribute('title'); n.className = `note${bad ? ' bad' : ''}`; n.hidden = false;
    clearTimeout(noteTimer); noteTimer = setTimeout(() => { n.hidden = true; }, copy ? 20000 : bad ? 9000 : 5000);
  }

  // ---------------------------------------------------------------- sidebar and keys
  const TABS = Object.keys(PANES);
  const navi = (t) => $(`nav-${t}`);
  function show(name, focus = false) {
    if (!PANES[name]) name = name === 'settings' ? 'model' : 'home';
    const changed = name !== tab;
    if (!changed && !focus) return;
    tab = name;
    disarm(); ui.key = null;
    for (const t of TABS) {
      if (t === name) navi(t).setAttribute('aria-current', 'page'); else navi(t).removeAttribute('aria-current');
      $(`pane-${t}`).hidden = t !== name;
    }
    $('pane-' + name).closest('.body').scrollTop = 0;
    render(null, changed);
    const t = navi(name);
    if (changed) { t.classList.remove('ping'); void t.offsetWidth; t.classList.add('ping'); }
    if (focus) t.focus();
  }
  document.querySelector('.side').addEventListener('animationend', (e) => e.target.classList.remove('ping'));
  for (const t of TABS) navi(t).addEventListener('click', () => show(t));
  // Up and down walk the sidebar (Home and End jump to its ends); Tab goes on into the page.
  document.querySelector('.side').addEventListener('keydown', (e) => {
    const i = TABS.indexOf(e.target.dataset?.page);
    if (i < 0) return;
    const n = TABS.length;
    const j = e.key === 'ArrowDown' ? (i + 1) % n : e.key === 'ArrowUp' ? (i + n - 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (j >= 0) { e.preventDefault(); show(TABS[j], true); }
  });
  // Radio groups: arrows move the choice, like the setup guide's.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && tipFor) { e.preventDefault(); hideTip(); return; }
    if (e.key === 'Escape' && !e.defaultPrevented) { const was = ui.arm; if (ui.key) closeKey(); else if (disarm()) render(was ?? undefined); else hide(); return; }
    const tl = e.target.closest?.('[role="tablist"]');
    if (tl && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      const all = [...tl.querySelectorAll('[role="tab"]')], i = all.indexOf(e.target);
      all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length]?.click();
      return;
    }
    const g = e.target.closest?.('[role="radiogroup"]');
    if (!g || !['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const all = [...g.querySelectorAll('[role="radio"]')], i = all.indexOf(e.target);
    const next = all[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length];
    next?.click();
    // Focus follows the choice (the group may be redrawn when the new state arrives).
    const k = next?.dataset.k;
    if (k) { next.focus(); setTimeout(() => document.querySelector(`[data-k="${CSS.escape(k)}"]`)?.focus(), 200); }
  });
  // The recent list's "2m ago" stays true while it's open.
  setInterval(() => { if (tab === 'home' && !document.hidden) render(); }, 30000);

  // Switching on and off. main.rs calls these as it shows the window and before it hides it. One listener, and it
  // only acts on the animation that's playing now: a close cut short (the window hides on the last frame, which
  // pauses it) must never finish later and blank the panel it just reopened.
  const body = $('frame');
  body.addEventListener('animationend', (e) => {
    if (e.target !== body) return;
    if (e.animationName === 'crt-on' && body.classList.contains('opening')) body.classList.remove('opening');
    else if (e.animationName === 'crt-off' && body.classList.contains('shutting')) { body.classList.remove('shutting'); body.classList.add('shut'); }
  });
  window.__panelOpen = (fromBottom = false) => {
    body.classList.remove('shut', 'shutting', 'opening');
    // The Roamie switches on with the panel, and waves if it's been a while.
    if (avatar) { avatar.kit.vanish(null, true); setTimeout(() => { avatar.appear(); if (Date.now() - seen.opened > 10 * 60e3) setTimeout(() => avatar.act('wave'), 500); seen.opened = Date.now(); }, REDUCED.matches ? 0 : 120); }
    body.classList.toggle('from-bottom', !!fromBottom);
    if (REDUCED.matches) return render(null, false);
    void body.offsetWidth;
    body.classList.add('opening');
    render(null, true);
  };
  window.__panelShut = () => {
    disarm(); ui.key = null; unarmQuit();
    body.classList.remove('opening');
    if (REDUCED.matches) { body.classList.add('shut'); return; }
    body.classList.add('shutting');
  };
  // A click anywhere else puts an armed Confirm back.
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest?.('#head-quit')) unarmQuit();
    if (ui.arm && !e.target.closest?.('.arm[aria-pressed="true"], .ibtn[aria-pressed="true"]')) {
      const text = document.querySelector('.pane .arm[aria-pressed="true"]');
      disarm(); calmIcons(); if (text) render(); // a tick or X goes back in place, so it can ease back
    }
  }, true);

  window.__panel = (m) => {
    if (m.kind === 'state') {
      const first = !state; state = m.state;
      if (ui.arm && !document.querySelector(`[data-k="${CSS.escape(ui.arm)}"]`)) ui.arm = null;
      render(null, first);
      if (m.state.tab) show(m.state.tab, true); // opened for a reason (asked with nothing signed in: the Model page)
    }
    else if (m.kind === 'note') note(m.text, m.bad, m.copy);
    else if (m.kind === 'copied' && m.which === 'problem') note(m.ok ? 'Copied the error details. Paste them into your report.' : "Couldn't copy the error details. Try Save diagnostics.", !m.ok);
    else if (m.kind === 'copied') {
      if (!m.ok && state?.bind?.[m.which]) { ui.bindShown.add(m.which); render(`bind-${m.which}`); }
      note(m.ok ? 'Copied. Paste it into a new custom shortcut.' : "Couldn't copy it. Select the command and copy it instead.", !m.ok);
    }
  };
  send({ type: 'panel_open' });
  // The first show: the window was made hidden, so the switch-on is played here (main.rs's call may land
  // before this script has run).
  window.__panelOpen();

  // ---------------------------------------------------------------- browser preview
  function preview() {
    document.title = 'Roamies panel (preview with sample data)';
    const at = Date.now();
    const s = {
      version: '0.9.0', os: /Win/.test(navigator.platform) ? 'win' : 'mac',
      status: { state: 'ready', text: 'Ready' }, busy: false, canNew: true,
      model: { provider: 'anthropic', id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', providerLabel: 'Anthropic' },
      providers: [
        { id: 'anthropic', label: 'Anthropic', on: true, method: 'oauth', key: true, signedIn: true, models: [{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }, { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }] },
        { id: 'openai', label: 'OpenAI', on: false, method: 'oauth', key: true, models: [] },
        { id: 'gemini', label: 'Gemini', on: true, method: 'key', key: true, keySaved: true, models: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }] },
        { id: 'moonshot', label: 'Kimi (Moonshot)', on: false, method: 'key', models: [], kinds: [
          { id: 'kimi-code', label: 'Kimi Code', billing: 'Uses your Kimi Code plan. Create the key in the Kimi Code Console.' },
          { id: 'moonshot', label: 'Moonshot', billing: 'Pay-per-token from platform.moonshot.ai.' }] },
        { id: 'local', label: 'Ollama (on this computer)', on: false, method: 'local', models: [] },
        ...['xAI', 'GLM (Z.ai)', 'MiniMax', 'Xiaomi', 'DeepSeek', 'Sakana', 'OpenRouter', 'Hugging Face'].map((label) => ({ id: label.toLowerCase().replace(/\W/g, ''), label, on: false, method: 'key', models: [] })),
      ],
      loggingIn: null,
      recent: [
        { at: at - 20e3, kind: 'did', text: 'Saved to memory' },
        { at: at - 25e3, kind: 'did', text: 'Searched the web' },
        { at: at - 30e3, kind: 'ask', text: "what's a good name for the new release?" },
        { at: at - 9 * 60e3, kind: 'bad', text: "Couldn't finish: read budget.xlsx" },
        { at: at - 9.2 * 60e3, kind: 'did', text: 'Looked at your screen' },
        { at: at - 9.4 * 60e3, kind: 'ask', text: 'what does this error mean' },
      ],
      usage: { requests: 14, tokens: 31240 },
      facts: [{ id: 'f1', text: 'Prefers short answers in the morning' }, { id: 'f2', text: 'Working on the Roamies 1.0 launch, due end of month' }, { id: 'f3', text: 'Has a cat called Miso' }],
      commitments: [{ id: 'c1', text: 'Send the launch email', when: 'Fri 7 Nov, 10:00', overdue: false }, { id: 'c2', text: 'Book the dentist', when: 'Mon 3 Nov, 09:00', overdue: true }],
      name: 'Roamie', look: 'classic', looks: [['classic', 'Roamie'], ['jarvis', 'JARVIS'], ['anime', 'Anime Girl'], ['sarah', 'Sarah'], ['adrian', 'Adrian'], ['rita', 'Rita X']],
      size: 'default', sizes: [['default', 'Default'], ['small', 'Small'], ['cursor', 'Cursor']],
      replies: 'voice', fishKey: true, fishModel: 'drama-3', fishFree: false,
      // ?tts=gemini: Gemini as the voice, its key saved.
      tts: new URLSearchParams(location.search).get('tts') === 'gemini' ? 'gemini' : 'fish', geminiKey: new URLSearchParams(location.search).get('tts') === 'gemini', geminiVoice: 'Kore',
      geminiVoices: [['Zephyr', 'Bright'], ['Puck', 'Upbeat'], ['Charon', 'Informative'], ['Kore', 'Firm']].map(([id, style]) => ({ id, style })),
      // &shared: speaking with the AI's Gemini key, none saved for the voice.
      geminiShared: new URLSearchParams(location.search).has('shared'), geminiModel: 'gemini-3.8-flash-lite-tts',
      geminiModels: [{ id: 'gemini-3.8-flash-lite-tts', name: 'Flash Lite', per10s: 0.0015 }, { id: 'gemini-3.8-flash-tts', name: 'Flash', per10s: 0.00225 }],
      fishModels: [{ id: 'drama-3', name: 'Drama 3', perM: 50, promo: { perM: 10, until: '2026-12-01T08:00:00Z' } }, { id: 's2.1-pro', name: 'S2.1 Pro', perM: 15 }],
      voice: { on: true, keys: '⌃⌥', ready: true, mac: true, mute: true, wakeWord: false, wakeClaps: false, wakeName: 'Roamies', download: null }, askKeys: '⌥⌘',
      sound: true, actions: false, login: { on: true },
      update: { available: new URLSearchParams(location.search).has('update') && new URLSearchParams(location.search).get('update') !== 'failed' ? '0.9.1' : null, installing: false, checking: false, result: null },
      intro: false,
    };
    const q = new URLSearchParams(location.search);
    if (q.has('busy')) Object.assign(s, { busy: true, status: { state: 'busy', text: 'Reading notes.md' } });
    if (q.has('empty')) Object.assign(s, { recent: [], facts: [], commitments: [], usage: null });
    if (q.has('many')) {
      const things = ['Prefers short answers', 'Drinks oat flat whites', 'Works late on Thursdays', 'Has a cat called Miso', 'Training for a 10k in March', 'Learning Japanese', 'Uses Figma for design', 'Ships on Fridays', 'Allergic to peanuts', 'Sister is called Ana'];
      s.facts = Array.from({ length: 100 }, (_, i) => ({ id: `f${i}`, text: `${things[i % things.length]}${i >= things.length ? ` (${Math.floor(i / things.length) + 1})` : ''}` }));
      s.commitments = Array.from({ length: 14 }, (_, i) => ({ id: `c${i}`, text: `Follow up on item ${i + 1}`, when: 'Fri 7 Nov, 10:00', overdue: i < 2 }));
      s.recent = Array.from({ length: 30 }, (_, i) => ({ ...s.recent[i % s.recent.length], at: at - i * 70e3 }));
    }
    // ?problem: an error was shown earlier (About gets Copy last error). ?note=bad: a failed save, with Copy details.
    // ?update=failed: the last check for updates failed (the button's tooltip says why).
    if (q.has('problem') || q.get('note') === 'bad') s.problem = { code: 'E30', at };
    if (q.get('note') === 'bad') setTimeout(() => window.__panel({ kind: 'note', text: "That key didn't save (E30). Try again.", bad: true, copy: true }), 400);
    if (q.get('update') === 'failed') s.update.result = { ok: false, error: "Couldn't check for updates. Check your internet." };
    if (q.has('checking')) s.update.checking = true;
    // ?studio: VoiceStudio is the voice provider (?studio=off: it isn't running; ?studio=engine: its engine isn't ready; ?studio=empty: no saved voices).
    const STUDIO = {
      on: { ok: true, engine: 'OmniVoice', voices: [{ id: 'a642d572', name: 'Ben' }, { id: 'fa08aff1', name: 'British · Female · Young Adult · High' }], voice: 'fa08aff1' },
      empty: { ok: true, engine: 'KittenTTS', voices: [], voice: null },
      off: { ok: false, reason: 'offline', message: 'Run VoiceStudio first.' },
      engine: { ok: false, reason: 'engine', message: "VoiceStudio's voice engine isn't ready (CosyVoice): not installed. Pick or install an engine in VoiceStudio, then press Check again." },
    };
    if (q.has('studio')) Object.assign(s, { tts: 'voicestudio', studio: STUDIO[q.get('studio')] ?? STUDIO.on });
    if (q.has('uptodate')) s.update.result = { ok: true, at: Date.now() + 60e3 };
    // ?v=0.1.36&from=0.1.35: What's new as it looks just after updating from one version to the other.
    if (q.get('v')) s.version = q.get('v');
    if (q.get('from')) s.whatsNewFrom = q.get('from');
    if (q.get('tab')) setTimeout(() => { if (q.get('mtab')) ui.mtab = q.get('mtab'); show(q.get('tab')); }, 0);
    setTimeout(() => window.__panel({ kind: 'state', state: s }), 0);
    return async (cmd, args) => {
      if (cmd !== 'sidecar_send') return null;
      console.log('[preview] would send', JSON.stringify(args.msg));
      // A look change comes back as new state, as from the sidecar, so the Roamie's reaction can be seen.
      if (args.msg?.type === 'copy_problem') setTimeout(() => window.__panel({ kind: 'copied', which: 'problem', ok: q.get('copy') !== 'fail' }), 150);
      const id = args.msg?.id ?? '';
      if (id.startsWith('size:')) { s.size = id.slice(5); setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      if (id.startsWith('tts:')) { s.tts = id.slice(4); s.studio = s.tts === 'voicestudio' ? STUDIO[q.get('studio')] ?? STUDIO.on : null; setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      if (id.startsWith('studiovoice:') && s.studio) { s.studio.voice = id.slice(12) === 'default' ? null : id.slice(12); setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      if (id.startsWith('look:')) { s.look = id.slice(5); s.name = s.looks.find(([v]) => v === s.look)?.[1] ?? s.name; setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      return null;
    };
  }
})();
