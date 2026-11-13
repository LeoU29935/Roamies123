// Game mode: while a game fills the screen, the cursor is hidden or held by it, so the Roamie can't follow it. It moves
// to a fixed panel at the right edge of the screen instead: the Roamie sits at its top, cards stack below it, and
// talking works as always. When the game leaves full screen, it's back to normal.
// macOS: Roamies already knows when a fullscreen game is in front (fullscreen.rs sets Roamie.game; clicks then go to
// the game). Windows: the sidecar reports the front window's bounds every few seconds (host.js → front()).
(() => {
  const R = window.Roamie;
  if (!R) return;
  const W_PANEL = 420, TOP = 230;
  const S = { on: false, seen: 0, enabled: true, game: false };
  const el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  Object.assign(el.style, {
    position: 'fixed', top: '0', right: '0', bottom: '0', width: `${W_PANEL}px`, pointerEvents: 'none',
    background: 'linear-gradient(90deg, rgba(12,22,24,0) 0%, rgba(12,22,24,0.72) 14%, rgba(12,22,24,0.82) 100%)',
    borderLeft: '1px solid rgba(120,255,226,0.18)', opacity: '0', transition: 'opacity 0.35s ease',
  });
  // First in the page, so the Roamie and the cards (drawn after it) are on top of it.
  const mount = () => document.body?.prepend(el);
  if (document.body) mount(); else addEventListener('DOMContentLoaded', mount);
  const safe = () => R.safe ?? {};
  // On while switched on and a game is in front (macOS), or the front window filled the screen twice running (Windows).
  const update = () => set(S.enabled && (S.game || S.seen >= 2));
  function set(on) {
    if (on === S.on) return;
    S.on = on;
    document.documentElement.classList.toggle('roamie-sidebar', on);
    R.ink?.sidebarChanged?.();
  }
  R.sidebar = {
    get on() { return S.on; },
    width: W_PANEL,
    // Where cards start, from the top of the screen: below the Roamie.
    top: TOP,
    // Where the Roamie sits while it's on, or null.
    dock: () => (S.on ? [innerWidth - (safe().right ?? 0) - W_PANEL / 2, (safe().top ?? 0) + 120] : null),
    // { rect: the front window's bounds in screen points, enabled }. Two readings in a row before it switches on, so
    // a window that only passes through full screen doesn't flip it; one to switch off.
    front(m) {
      S.enabled = m.enabled !== false;
      const r = m.rect && R.ink?.toLocal ? R.ink.toLocal(m.rect) : null;
      const full = S.enabled && !!r && r[0] <= 2 && r[1] <= 2 && r[0] + r[2] >= innerWidth - 2 && r[1] + r[3] >= innerHeight - 2;
      S.seen = full ? S.seen + 1 : 0;
      update();
    },
    set,
  };
  // The panel shows only while there's something in it: the Roamie, or cards. Roamie.game (macOS) is watched here too.
  setInterval(() => {
    if (!!R.game !== S.game) { S.game = !!R.game; update(); }
    const agent = R.tiles?.find((t) => t.creature?.agent)?.creature.agent;
    el.style.opacity = S.on && (agent?.visible || R.ink?.busy) ? '1' : '0';
  }, 250);
})();
