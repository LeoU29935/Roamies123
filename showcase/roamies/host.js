// Tauri host bridge. The shell calls __roamiePtr(x, y) with the real cursor each frame and
// __roamieHost(msg) with messages from the sidekick's brain (the gg-agent sidecar).
// The page answers through set_hot (click-through; set_hit_rects on Linux), set_typing (keyboard focus) and sidecar_send.
// A no-op outside Tauri.
(() => {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return;
  const send = (msg) => invoke('sidecar_send', { msg }).catch(() => {});
  const typing = (on) => invoke('set_typing', { on }).catch(() => {});
  // Drawings (ink.js) talk to the sidecar (started, waits done, buttons, closed cards) and arm the shell's click watch.
  if (Roamie.ink) { Roamie.ink.send = send; Roamie.ink.invoke = (cmd, args) => invoke(cmd, args).catch(() => {}); }
  // The agents' corner (agent-home.js): Stop, Allow, file tiles and Open folder go to the sidecar.
  if (Roamie.agentHome) Roamie.agentHome.send = send;
  window.__roamieClick = (x, y) => Roamie.ink?.click(x, y);

  window.__roamieSafe = (s) => Roamie.setSafe?.(s);
  // macOS: the voice helper can draw the cursor-form sidekick while it just follows the cursor (agent.js nativeStep,
  // voice/buddy.swift). Not available (Windows, helper not running): the page keeps drawing it.
  let buddyOff = /Mac/.test(navigator.platform) ? 0 : Infinity;
  const buddyGone = (ms) => { buddyOff = performance.now() + ms; Roamie.buddy.onEvent?.({ state: 'gone' }); };
  Roamie.buddy = {
    onEvent: null,
    available: () => performance.now() > buddyOff,
    show: (msg) => invoke('buddy', { msg: { ...msg, on: true } }).then((ok) => { if (!ok) buddyGone(10000); }, () => buddyGone(60000)),
    hide: () => invoke('buddy', { msg: { on: false } }).catch(() => {}),
  };
  window.__roamieBuddy = (m) => { Roamie.wake?.(); Roamie.buddy.onEvent?.(m); };
  // handsBusy: Roamies is acting in another app (it may take the real cursor), so clicks always go through.
  let hot = null, cursor = null, handsBusy = false;
  // Linux ("x11" or "wayland", set by the shell): clicks are let through by region instead (below).
  const LINUX = !!window.ROAMIE_LINUX;
  const setHot = (h) => { if (!LINUX && h !== hot) { hot = h; invoke('set_hot', { hot: h }).catch(() => { hot = null; }); } };
  window.__roamiePtr = (x, y, t) => {
    if (!window.Roamie?.ptr) return;
    cursor = [x, y];
    Roamie.ink?.ptr(x, y);
    Roamie.askBar?.ptr(x, y);
    const h = Roamie.ptr(x, y, t);
    setHot(h && !handsBusy && !Roamie.game);
  };
  // macOS: a fullscreen game is in front (fullscreen.rs). It holds the cursor, so every click is its own and the
  // Sidekick stops following the cursor (agent.js).
  window.__roamieGame = (on) => { if (!window.Roamie) return; Roamie.game = !!on; if (on) setHot(false); };

  // Linux: click-through by region. On Wayland the cursor can't be followed over other apps, so instead of flipping
  // the whole window as the cursor comes and goes, the page says which rectangles take clicks (the Roamie, its
  // bubbles, cards and buttons) and the shell makes them the window's input shape. X11 sessions work the same way.
  if (LINUX) {
    let sent = '', sentAt = 0;
    setInterval(() => {
      if (!window.Roamie?.hitTest) return;
      const rects = [];
      const grown = (r) => rects.push(Math.floor(r[0]) - 8, Math.floor(r[1]) - 8, Math.ceil(r[2]) + 16, Math.ceil(r[3]) + 16);
      for (const r of Roamie.inkRects?.() ?? []) grown(r);
      const card = Roamie.panelRect?.();
      if (card) grown(card);
      const bar = Roamie.askBarRect?.();
      if (bar) grown(bar);
      for (const r of Roamie.homeRects?.() ?? []) grown(r);
      // Sampled a little past the canvas: hit areas can reach beyond what's drawn.
      const box = Roamie.hitBox();
      if (box) rects.push(...Roamie.hitRects(Roamie.hitTest, [box[0] - 48, box[1] - 48, box[2] + 96, box[3] + 96]));
      const key = rects.join(','), now = performance.now();
      // Sent when it changes, and again every couple of seconds in case the window's shape was reset under it.
      if (key === sent && now - sentAt < 2000) return;
      sent = key; sentAt = now;
      invoke('set_hit_rects', { rects }).catch(() => { sent = ''; });
    }, 120);
  }

  let agent = null;
  const getAgent = () => (agent ??= Roamie.tiles?.find((t) => t.creature?.agent)?.creature.agent ?? null);

  // ---------- typing: an input bubble, or the field beside the cursor ----------
  // The bubble (API keys, Allow/Decline, the area follow-up): a real (invisible) input collects keys, so paste, IME
  // and key repeat all just work. Type to ask (m.bar) shows its own field beside the cursor instead (ask-bar.js).
  const field = document.createElement('input');
  Object.assign(field.style, { position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
  // Its name is its look's (the sidecar's LOOKS).
  const NAMES = { classic: 'Roamie', jarvis: 'JARVIS', anime: 'Anime Girl', sarah: 'Sarah', adrian: 'Adrian', rita: 'Rita X' };
  field.setAttribute('aria-label', 'Message for Roamie');
  field.autocomplete = 'off'; field.spellcheck = false;
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(field));
  if (document.body) document.body.appendChild(field);

  let ask = null;
  const bar = Roamie.askBar;
  const focusField = () => { typing(true); setTimeout(() => (ask?.bar ? bar.focus() : field.focus()), 30); ask?.h.focus(true); };
  // Enter sends and Esc closes, in the bubble's hidden input and in the field (where Shift+Enter adds a line).
  const askKey = (e, text, lines = false) => {
    if (e.key === 'Enter' && !e.isComposing && !(lines && e.shiftKey)) { e.preventDefault(); finishAsk(text); }
    else if (e.key === 'Escape') { e.preventDefault(); finishAsk(null); }
  };
  const finishAsk = (text) => {
    if (!ask) return;
    const { id, h, label } = ask;
    ask = null;
    if (label != null) field.setAttribute('aria-label', label);
    field.blur(); field.value = '';
    typing(false);
    h.close();
    if (id) send({ type: 'answer', id, text });
  };
  const openAsk = (m) => {
    const a = getAgent();
    if (!a) return;
    if (ask) finishAsk(null);
    if (m.bar && bar && !m.mask && !m.choices) {
      // What it's saying stays up while you type: only what's sent interrupts it.
      ask = { id: m.id, bar: true, h: { close: () => bar.close(), focus() {} }, choices: null, sel: -1, label: null };
      bar.open({
        placeholder: m.prompt || m.placeholder || '', label: field.getAttribute('aria-label'), cursor,
        onKey: (e) => askKey(e, bar.value, true), onPress: focusField, onLeft: () => finishAsk(null),
      });
      focusField();
      return;
    }
    endTalk();
    field.value = '';
    field.type = m.mask ? 'password' : 'text';
    // The question goes in the placeholder, so the bubble reads "Paste your API key…" until you type.
    const question = m.prompt || m.placeholder || '';
    // A yes/no: Allow answers yes, any other button no. The field only takes keys then (Y, N, Tab, arrows, Enter).
    const choices = Array.isArray(m.choices) && m.choices.length ? m.choices.map(String) : null;
    const h = a.prompt({ placeholder: question, mask: m.mask, onPress: focusField, choices, onChoose: (i) => finishAsk(i === 0 ? 'yes' : null) });
    ask = { id: m.id, h, choices, sel: -1, label: null };
    if (choices) { ask.label = field.getAttribute('aria-label'); field.setAttribute('aria-label', `${question} Press Y to allow or N to decline.`); }
    focusField();
  };
  // The bubble draws the caret where the field has it, so moving back to fix a word shows where typing goes.
  const syncField = () => ask && !ask.bar && !ask.choices && ask.h.set(field.value, field.selectionDirection === 'backward' ? field.selectionStart : field.selectionEnd);
  field.addEventListener('input', syncField);
  field.addEventListener('select', syncField);
  field.addEventListener('keyup', syncField);
  field.addEventListener('keydown', (e) => {
    if (!ask || ask.bar) return;
    if (ask.choices) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      e.preventDefault();
      const n = ask.choices.length, key = e.key.toLowerCase();
      if (key === 'y') finishAsk('yes');
      else if (key === 'n' || key === 'escape') finishAsk(null);
      else if (key === 'tab' || key === 'arrowright' || key === 'arrowleft') {
        const back = key === 'arrowleft' || (key === 'tab' && e.shiftKey);
        ask.sel = ask.sel < 0 ? (back ? n - 1 : 0) : (ask.sel + (back ? n - 1 : 1)) % n;
        ask.h.select(ask.sel);
      } else if ((key === 'enter' || key === ' ') && ask.sel >= 0) finishAsk(ask.sel === 0 ? 'yes' : null);
      return;
    }
    setTimeout(syncField, 0); // arrows, Home and End move the caret without an input event
    askKey(e, field.value);
  });
  field.addEventListener('blur', () => ask?.h.focus(false));

  // ---------- agent events -> body language ----------
  let speech = null, thought = null, nextMood = null, listen = null, heard = null, responding = false;
  // waveTurn: a spoken question whose "thinking" shows as dots beside the cursor (macOS), so the Sidekick
  // shows no thought cloud of its own. research: this turn's answer broke down into points, so it goes on the card.
  let hearing = false; // a voice take is open (the mic is on), so Esc can cancel it
  let waveTurn = false, research = false, heardText = false, spoken = '', fromWeb = false;
  // agentish: they asked for an agent, so the agents' corner hatches one instead of the thought cloud.
  let agentish = false;
  // An answer that turns into points (or cites sources) reads better on the card than in a bubble.
  const LISTY = /\n\s*(?:[-*•]|\d+[.)])\s+\S|\n\s*sources?\s*:/i;
  const panel = () => {
    const p = Roamie.panel;
    if (p && !p.onLink) p.onLink = (url) => send({ type: 'open_link', url });
    return p;
  };
  // The card opens just past the cursor and the Sidekick beside it.
  const near = () => (cursor ? { cursor, buddy: getAgent()?.pos } : null);
  const webStatus = (anim) => (anim.variant === 'fetch' && anim.detail ? `Reading ${anim.detail}` : 'Searching the web');
  const jobs = [];
  let current = null;
  const MOODS = { hype: 'happy', wave: 'happy', upset: 'annoyed', remind: 'concerned', motivate: 'determined' };
  const endTalk = () => { speech?.end(); thought?.end(); speech = thought = null; };
  // Auto-listen: a spoken question answered with a question. Once the bubble has typed it out and the voice has said
  // it, and a short pause, the mic opens hands-free. Anything the user does first drops it.
  let autoListen = null;
  const dropAutoListen = () => { if (autoListen) { clearInterval(autoListen.t); autoListen = null; } };
  function waitThenListen(l) {
    dropAutoListen();
    const t0 = Date.now(), me = { quietAt: 0 };
    me.t = setInterval(() => {
      if (autoListen !== me) return;
      if (Date.now() - t0 > 90_000 || ask) return dropAutoListen();
      const done = !getAgent()?.typing() && (Roamie.voiceOut ? Roamie.voiceOut.finished(l.speech) : true);
      if (!done) { me.quietAt = 0; return; }
      me.quietAt ||= Date.now();
      if (Date.now() - me.quietAt < 400) return;
      dropAutoListen();
      send({ type: 'auto_listen', turn: l.turn });
    }, 100);
    autoListen = me;
  }

  // Wake word: once a reply has been typed out and said, the sidecar may listen for "Hey Roamies" again.
  let saidWatch = null;
  function reportSaid(rid) {
    clearInterval(saidWatch);
    const t0 = Date.now();
    saidWatch = setInterval(() => {
      const done = !getAgent()?.typing() && (Roamie.voiceOut ? Roamie.voiceOut.finished(rid) : true);
      if (!done && Date.now() - t0 < 90_000) return;
      clearInterval(saidWatch); saidWatch = null;
      send({ type: 'reply_said' });
    }, 200);
  }

  async function playTools() {
    if (current) return;
    while (jobs.length) {
      // Falling behind (lots of quick parallel calls): skip ones that already finished.
      while (jobs.length > 2 && jobs[0].result !== undefined) jobs.shift();
      const job = jobs.shift(), a = getAgent();
      if (!a) break;
      current = job;
      job.h = a.tool(job.anim.tool, { variant: job.anim.variant, label: job.anim.label, detail: job.anim.detail, live: true, rect: job.target, rectName: job.targetName });
      if (job.image) job.h.state.image = job.image;
      if (job.result !== undefined) job.h.done(!job.result);
      await job.h.closed;
      current = null;
    }
  }
  const settle = (id, isError) => {
    const job = current?.id === id ? current : jobs.find((j) => j.id === id);
    if (!job) return;
    job.result = isError;
    job.h?.done(!isError);
  };

  // While a drawing plays, the rest of the answer (its last line, the end of the turn) waits for it, so the reply's
  // bubble doesn't ride along on the drawing cursor. Drawings themselves, and a new request or an error, never wait.
  let deferred = null;
  const PASS = new Set(['draw', 'ink_clear', 'ink_stale', 'start', 'error', 'tool_target', 'tool_image']);
  function onAgent(e) {
    if (e.type === 'start' || e.type === 'error') flushDeferred();
    if (deferred && !PASS.has(e.type)) { deferred.push(e); return; }
    if (!PASS.has(e.type) && ['text', 'done', 'emote', 'trail'].includes(e.type) && Roamie.ink?.playing) {
      deferred = [e];
      // Never held for good, even if a drawing gets stuck.
      Promise.race([Roamie.ink.whenIdle(), new Promise((r) => setTimeout(r, 150_000))]).then(flushDeferred);
      return;
    }
    agentEvent(e);
  }
  function flushDeferred() { const q = deferred; deferred = null; for (const e of q ?? []) agentEvent(e); }
  function agentEvent(e) {
    const a = getAgent();
    if (!a) return;
    switch (e.type) {
      case 'start':
        dropAutoListen();
        // A new request: no tool of an earlier one is still running, whatever was missed (a cut-off call). Its tag
        // ends instead of staying up, with this request's tags queued behind it.
        for (const j of [current, ...jobs]) if (j && j.result === undefined) { j.result = false; j.h?.done(true); }
        // Nor is it still working in another app, even if that work's end was missed.
        a.hand?.end();
        responding = true;
        heard = null;
        research = false; fromWeb = false; spoken = '';
        agentish = !!e.agentish;
        if (agentish) {
          const p = a.visible ? [a.pos.x, a.pos.y - a.pos.r - 28] : cursor ? [cursor[0] + 30, cursor[1] + 26] : [innerWidth / 2, innerHeight / 3];
          Roamie.agentHome?.hatch(p);
        } else if (!listen?.open && !waveTurn) thought = a.think('', { stream: true });
        break;
      case 'thinking':
        if (speech || listen?.open || waveTurn || research || agentish) break;
        if (!thought) thought = a.think('', { stream: true, quiet: true });
        thought.append(e.text);
        break;
      case 'text': {
        if (listen?.open) break;
        if (research) {
          if (research === 'looking') { research = 'writing'; panel()?.status('Writing it up'); }
          panel()?.append(e.text);
          break;
        }
        if (speech && LISTY.test(spoken + e.text)) {
          // Move what's been said so far onto the card and carry on there.
          const so = (spoken + e.text).replace(/^\s+/, '');
          speech.end(); a.hush(); speech = null; spoken = '';
          research = 'writing';
          panel()?.open({ status: 'Writing it up', near: near() }).append(so);
          break;
        }
        let text = e.text;
        if (!speech) {
          // A fresh bubble never starts with the space that joins a follow-up turn.
          text = text.replace(/^\s+/, '');
          if (!text) break;
          // say() morphs an open thought cloud into the speech bubble, so drop the thought handle.
          thought = null;
          speech = a.say('', { stream: true, mood: nextMood });
          nextMood = null;
        }
        speech.append(text);
        spoken += text;
        break;
      }
      case 'tool':
        if (listen?.open) break;
        // Tools with nothing to show (listing commitments) don't interrupt the bubble.
        if (!e.anim) break;
        endTalk();
        // The web: just the task tag ("searching the web"), and the answer is said in the bubble. The card is for an
        // answer that breaks down into points (LISTY), not every lookup; one already open this turn says what it checks.
        if (e.anim.tool === 'web') {
          fromWeb = true;
          if (research) { research = 'looking'; panel()?.status(webStatus(e.anim)); break; }
        }
        jobs.push({ id: e.id, anim: e.anim }); playTools();
        break;
      case 'tool_end':
        settle(e.id, e.isError);
        break;
      // A drawing's next segment (beats with their places already on screen), or clearing what's drawn.
      case 'draw':
        endTalk();
        Roamie.ink?.play(e);
        break;
      case 'ink_clear': Roamie.ink?.clear(e); break;
      case 'ink_stale': Roamie.ink?.stale(); break;
      case 'tool_target': {
        // The real window being captured, in global screen points → this overlay's coordinates.
        const job = current?.id === e.id ? current : jobs.find((j) => j.id === e.id);
        if (!job || !e.window?.bounds) break;
        const [x, y, w, h] = e.window.bounds, o = Roamie.origin ?? { x: 0, y: 0 };
        const rect = [x - o.x, y - o.y, x - o.x + w, y - o.y + h];
        job.target = rect; job.targetName = e.window.app;
        job.h?.target(rect, e.window.app);
        break;
      }
      case 'tool_image': {
        // The shot it actually took: the screenshot prints it into its frame and onto the photo it carries back.
        const job = current?.id === e.id ? current : jobs.find((j) => j.id === e.id);
        if (!job || !e.src) break;
        const img = new Image();
        img.onload = () => { job.image = img; if (job.h?.state) job.h.state.image = img; };
        img.src = e.src;
        break;
      }
      // The parts of a "do this, then that" request, ticking off.
      case 'trail': a.cards?.trail(e); break;
      case 'emote':
        nextMood = MOODS[e.action] ?? null;
        a.act(e.action);
        break;
      case 'done':
        responding = false;
        if (agentish) { agentish = false; Roamie.agentHome?.hatchOff(); }
        if (research) panel()?.end(fromWeb ? 'From the web' : 'Answer');
        research = waveTurn = false;
        endTalk();
        if (e.listen) waitThenListen(e.listen);
        reportSaid(e.speech);
        break;
      case 'error':
        dropAutoListen();
        responding = false;
        if (agentish) { agentish = false; Roamie.agentHome?.hatchOff(); }
        if (research) panel()?.fail(e.message);
        research = waveTurn = false;
        endTalk();
        reportSaid(e.speech);
        for (const j of [current, ...jobs]) if (j && j.result === undefined) settle(j.id, true);
        a.say(e.message, { mood: 'concerned' });
        break;
    }
  }

  // ---------- voice (⌃⌥) ----------
  function onVoice(m) {
    // Windows: the pen trail while the talk keys are held (pen.js).
    if (m.type === 'ink') { Roamie.pen?.(m); return; }
    const a = getAgent();
    if (!a) return;
    if ((m.type === 'state' && m.state !== 'listening') || m.type === 'final') hearing = false;
    if (m.type === 'state' && m.state === 'listening') {
      hearing = true;
      dropAutoListen();
      if (ask) finishAsk(null);
      endTalk();
      heard = null;
      panel()?.close();
      // macOS: the listening shows as voice bars beside the cursor, so the sidekick steps away until it answers.
      if (m.wave) {
        waveTurn = true;
        thought?.end(); thought = null;
        if (a.visible) a.hide();
        Roamie.sfx?.play('listen');
        return;
      }
      listen = a.listen({ placeholder: m.mode === 'handsfree' ? 'Listening… tap again to send' : 'Listening…' });
    } else if (m.type === 'partial') listen?.set(m.text);
    else if (m.type === 'level') listen?.level(m.v);
    else if (m.type === 'state' && m.state === 'processing') listen?.processing();
    else if (m.type === 'final') {
      heardText = true;
      // Keep what was heard on screen until the agent starts thinking.
      if (listen) { listen.set(m.text).processing(); heard = listen; listen = null; }
      Roamie.sfx?.play('heard');
    } else if (m.type === 'state' && m.state === 'idle') {
      // Nothing was heard (or it was cancelled): no answer is coming for that talk.
      if (m.cancelled || !heardText) waveTurn = false;
      heardText = false;
      listen?.close(); listen = null;
      if (heard) { const h = heard; setTimeout(() => { if (heard === h) { h.close(); heard = null; } }, 4000); }
    }
  }

  // Moved to the screen the cursor is on: drop the sidekick from its old spot and hold messages until
  // the page has its new size and the cursor's new position, so it appears right beside the cursor.
  let held = null;
  const flush = () => {
    if (!held) return;
    const q = held.q; clearTimeout(held.t); held = null;
    dispatchEvent(new Event('resize')); // the screen's scale may differ even when its size doesn't
    for (const m of q) window.__roamieHost(m);
  };
  window.__roamieMoved = () => {
    dropAutoListen();
    const a = getAgent();
    if (ask) finishAsk(null);
    endTalk(); listen?.close(); listen = null;
    if (a?.visible) a.hide({ instant: true });
    if (held) return;
    held = { q: [], t: setTimeout(flush, 300) };
    addEventListener('resize', () => requestAnimationFrame(() => requestAnimationFrame(flush)), { once: true });
  };

  window.__roamieHost = (m) => {
    Roamie.wake?.(); // the frame loop naps while the sidekick is hidden
    if (m.kind === 'speech') { Roamie.voiceOut?.handle(m); return; } // plays on, even while it changes screens
    if (held) { held.q.push(m); return; }
    if (m.kind === 'sound') { if (Roamie.sfx) Roamie.sfx.enabled = m.on; return; }
    if (m.kind === 'size') { for (const t of Roamie.tiles ?? []) t.creature.setForm?.(m.size); return; }
    if (m.kind === 'look') {
      for (const t of Roamie.tiles ?? []) t.creature.setLook?.(m.look);
      field.setAttribute('aria-label', `Message for ${NAMES[m.look] ?? NAMES.classic}`);
      return;
    }
    if (!getAgent()) return;
    if (m.kind === 'agents') {
      // A launch flies out of the visible Roamie (or from the cursor); the hatch, when there is one, wins.
      const a = getAgent();
      Roamie.agentHome?.event(m.e, { from: a.visible ? [a.pos.x, a.pos.y] : cursor });
      return;
    }
    if (m.kind === 'hands') {
      // on/off: it is acting in another app. In between: where each step lands (global screen points) and when a
      // step takes the real cursor; the Sidekick hops there in its cursor form instead of chasing the cursor.
      const hand = getAgent().hand;
      if (m.step) {
        const [x, y, w, h] = m.step.bounds, o = Roamie.origin ?? { x: 0, y: 0 }, px = x + w / 2 - o.x, py = y + h / 2 - o.y;
        // A spot on another display isn't this overlay's to show.
        if (px >= 0 && py >= 0 && px <= innerWidth && py <= innerHeight) { hand?.begin(); hand?.at(px, py); }
      } else if (m.borrow) hand?.begin();
      else { handsBusy = !!m.on; if (handsBusy) setHot(false); else hand?.end(); }
      return;
    }
    if (m.kind === 'greet') { getAgent().act('wave'); return; }
    if (m.kind === 'intro') { getAgent().intro(m.x, m.text); return; }
    if (m.kind === 'esc') { onEsc(); return; }
    if (m.kind === 'summon') {
      // ⌃⌥S toggles; the menu's Show Sidekick only ever shows.
      const a = getAgent();
      if (m.show || !a.visible) { if (a.show({ summoned: true })) a.act('wave'); }
      else a.hide();
      return;
    }
    if (m.kind === 'say') { if (!ask || ask.bar) getAgent().say(m.text, { mood: m.mood ?? null }); } // the field leaves the bubble free
    else if (m.kind === 'ask') openAsk(m);
    else if (m.kind === 'cancel_ask') { if (ask?.id === m.id) { ask.id = null; finishAsk(null); } }
    else if (m.kind === 'agent') onAgent(m.e);
    else if (m.kind === 'voice') onVoice(m);
    else if (m.kind === 'list') Roamie.ink?.reminders(m);
    else if (m.kind === 'front_window') Roamie.sidebar?.front(m);
  };

  // ---------- Esc ----------
  // While it's on screen, Esc stops an answer (and the voice), or sends it away when it's idle. The shell holds a
  // global Esc only meanwhile (other apps don't get Esc while it does), so this overlay says when it's up.
  // A drawing counts while it plays and while its marks are still on the screen (frames, loops: Esc is their only
  // way out once the Roamie has gone). Cards left on screen have their own close button and don't hold Esc. The
  // reminders card does while it shows (it goes by itself in a few seconds).
  // A voice turn counts too: on macOS the sidekick steps away while the mic is on and until the answer shows.
  const up = () => !!(getAgent()?.visible || ask || Roamie.panel?.isOpen || Roamie.ink?.playing || Roamie.ink?.loose || Roamie.ink?.reminding || hearing || waveTurn || Roamie.voiceOut?.playing());
  function onEsc() {
    dropAutoListen();
    const a = getAgent();
    if (!a || !up()) return;
    if (ask) { finishAsk(null); return; }
    if (hearing) { hearing = false; send({ type: 'listen_cancel' }); return; }
    if (responding || Roamie.voiceOut?.playing()) { send({ type: 'menu', id: 'stop', via: 'esc' }); Roamie.voiceOut?.stop(); return; }
    // A drawing on screen: Esc takes it all away (and the sidecar forgets its parts).
    if (Roamie.ink?.busy) { Roamie.ink.clear({ all: true }); send({ type: 'ink_cleared' }); return; }
    if (Roamie.panel?.isOpen) Roamie.panel.close();
    endTalk(); listen?.close(); listen = null;
    if (a.visible) a.hide();
  }
  let escUp = null;
  setInterval(() => {
    const on = up();
    if (on !== escUp) { escUp = on; invoke('esc_watch', { on }).catch(() => { escUp = null; }); }
  }, 150);

  // Start hidden in auto mode and tell the brain we're listening. It replies with the sound setting,
  // and a greeting wave unless the setup guide is about to open.
  const ready = () => {
    const a = getAgent();
    if (!a) return setTimeout(ready, 150);
    a.setAuto(true);
    a.hide({ instant: true });
    send({ type: 'ui_ready' });
  };
  ready();
})();
