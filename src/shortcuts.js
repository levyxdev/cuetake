/**
 * Shortcuts and their keycaps, shared by Node and the render page. Pure functions, no imports; seconds throughout.
 *
 * A Shortcut is a key pressed outside a text field, or with Control, Alt or Meta held inside one: typing
 * into a field already shows on the page, a shortcut does not. Its `keys` are the held modifiers in
 * macOS order (Control, Alt, Shift, Meta), then the key, named as the DOM names it (`K`, `Enter`,
 * `ArrowUp`, `Space`), so the same press reads the same on every keyboard layout Playwright plays.
 */

const MODIFIERS = [['ctrlKey', 'Control'], ['altKey', 'Alt'], ['shiftKey', 'Shift'], ['metaKey', 'Meta']];
// Keys that only change another key, or carry no key of their own.
const NOT_SHOWN = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'Symbol', 'SymbolLock', 'OS', 'Process', 'Dead', 'Unidentified', '']);
const FADE_IN = 0.12, FADE_OUT = 0.25; // seconds keycaps take to appear and to go
const RISE = 12; // 1080p pixels keycaps rise as they appear

/** The key a keydown names: a letter or digit by its place on the keyboard, so held modifiers do not change it. */
function keyName({ key, code = '' }) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (key === ' ') return 'Space';
  return key?.length === 1 ? key.toUpperCase() : key;
}

/**
 * The keys a keydown shows, or null for one that is typing, a modifier on its own or the key repeating.
 * `down` holds the event's `key`, `code`, modifier flags and `repeat`, and `field`: whether a text field had focus.
 */
export function shortcutKeys(down) {
  const key = keyName(down);
  if (down.repeat || NOT_SHOWN.has(key ?? '')) return null;
  if (down.field && !down.ctrlKey && !down.altKey && !down.metaKey) return null;
  return [...MODIFIERS.filter(([flag]) => down[flag]).map(([, name]) => name), key];
}

const sameKeys = (a, b) => a.length === b.length && a.every((key, i) => key === b[i]);

/**
 * When each Shortcut's keycaps show: from its press until `duration` after, joined by later presses of
 * the same keys while it shows, which count up. A new Shortcut replaces the one showing at once, without fading.
 */
export function keycapShows(shortcuts, duration) {
  const shows = [];
  for (const { t, keys } of shortcuts.toSorted((a, b) => a.t - b.t)) {
    const last = shows.at(-1);
    if (last && t < last.end && sameKeys(last.keys, keys)) { last.presses.push(t); last.end = t + duration; continue; }
    const replacing = Boolean(last && t < last.end);
    if (replacing) { last.end = t; last.replaced = true; }
    shows.push({ t, end: t + duration, keys, presses: [t], replacing, replaced: false });
  }
  return shows;
}

const easeOut = u => 1 - (1 - u) ** 3;

/**
 * The keycaps through a Take: `at(t)` gives the index of the show on screen, its keys, how many times
 * they have been pressed, its opacity and how far below its place it is (1080p pixels), or null.
 * `keycaps` is the Edit's keycaps item; `false` shows none.
 */
export function keycapTrack(shortcuts, keycaps) {
  const shows = keycaps ? keycapShows(shortcuts ?? [], keycaps.duration ?? 1.5) : [];
  return {
    shows,
    at(t) {
      const index = shows.findIndex(show => t >= show.t && t < show.end);
      if (index < 0) return null;
      const show = shows[index], appear = show.replacing ? 1 : Math.min(1, (t - show.t) / FADE_IN);
      const leave = show.replaced ? 1 : Math.min(1, (show.end - t) / FADE_OUT);
      return { index, keys: show.keys, count: show.presses.filter(p => p <= t).length, opacity: Math.max(0, Math.min(appear, leave)), rise: RISE * (1 - easeOut(appear)) };
    },
  };
}
