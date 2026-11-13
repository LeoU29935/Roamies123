// The wake word's name, chosen by the user ("Hey Jarvis"). The voice helper (voice/main.swift, WakeWord.setName) applies
// the same rule; this one turns a typed name into one to save, or says why not, before it gets that far.
export const DEFAULT_WAKE_NAME = 'Roamies';
// Words people say all the time: as a wake name, "Hey there"-style chatter would wake Roamies.
const COMMON = new Set(['hello', 'there', 'okay', 'yeah', 'thanks', 'sorry', 'right', 'what', 'this', 'that', 'with', 'have',
  'just', 'like', 'about', 'would', 'could', 'really', 'maybe', 'guys', 'everyone', 'everybody', 'buddy', 'listen', 'look',
  'siri', 'alexa', 'google']);

/** Typed text → { ok: true, name } (name '' means back to Roamies) or { ok: false, why }. */
export function cleanWakeName(raw) {
  const t = String(raw ?? '').trim().replace(/^(hey|hi)[\s,]+/i, '');
  if (!t || /^roamies?$/i.test(t)) return { ok: true, name: '' };
  if (/\s/.test(t)) return { ok: false, why: 'Just one word, please, like Jarvis.' };
  const w = t.replace(/[^\p{L}]/gu, '');
  if (w.length !== t.length) return { ok: false, why: 'Letters only, please.' };
  if (w.length < 4) return { ok: false, why: 'At least 4 letters, so it isn\'t heard by mistake.' };
  if (w.length > 20) return { ok: false, why: 'That\'s a bit long. 20 letters at most.' };
  if (COMMON.has(w.toLowerCase())) return { ok: false, why: `"${w}" comes up in everyday talk (or wakes another assistant), so I'd wake by mistake. Pick a name.` };
  return { ok: true, name: w[0].toUpperCase() + w.slice(1).toLowerCase() };
}

export const wakeName = (config) => config?.wakeName || DEFAULT_WAKE_NAME;
