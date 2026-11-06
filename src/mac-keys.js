/**
 * Keys the App Director presses, as macOS posts them. Pure, no imports.
 *
 * A Scenario names keys as Playwright does ('Meta+K', 'Enter', 'Shift+ArrowUp', 'ControlOrMeta+Z').
 * Each names the virtual key code to post, by its place on an ANSI keyboard, the modifiers to hold, and
 * the keydown a page would see for it, so the Timeline records the same Shortcut a page would.
 */

// [macOS virtual key code, DOM key, DOM code] for the keys that are not a letter or digit.
const NAMED = {
  Enter: [36, 'Enter', 'Enter'], Tab: [48, 'Tab', 'Tab'], Space: [49, ' ', 'Space'], Backspace: [51, 'Backspace', 'Backspace'],
  Escape: [53, 'Escape', 'Escape'], Delete: [117, 'Delete', 'Delete'], Home: [115, 'Home', 'Home'], End: [119, 'End', 'End'],
  PageUp: [116, 'PageUp', 'PageUp'], PageDown: [121, 'PageDown', 'PageDown'],
  ArrowLeft: [123, 'ArrowLeft', 'ArrowLeft'], ArrowRight: [124, 'ArrowRight', 'ArrowRight'], ArrowDown: [125, 'ArrowDown', 'ArrowDown'], ArrowUp: [126, 'ArrowUp', 'ArrowUp'],
  F1: [122, 'F1', 'F1'], F2: [120, 'F2', 'F2'], F3: [99, 'F3', 'F3'], F4: [118, 'F4', 'F4'], F5: [96, 'F5', 'F5'], F6: [97, 'F6', 'F6'],
  F7: [98, 'F7', 'F7'], F8: [100, 'F8', 'F8'], F9: [101, 'F9', 'F9'], F10: [109, 'F10', 'F10'], F11: [103, 'F11', 'F11'], F12: [111, 'F12', 'F12'],
  '-': [27, '-', 'Minus'], '=': [24, '=', 'Equal'], '[': [33, '[', 'BracketLeft'], ']': [30, ']', 'BracketRight'], '\\': [42, '\\', 'Backslash'],
  ';': [41, ';', 'Semicolon'], "'": [39, "'", 'Quote'], ',': [43, ',', 'Comma'], '.': [47, '.', 'Period'], '/': [44, '/', 'Slash'], '`': [50, '`', 'Backquote'],
};
const LETTERS = { A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7, C: 8, V: 9, B: 11, Q: 12, W: 13, E: 14, R: 15, Y: 16, T: 17, O: 31, U: 32, I: 34, P: 35, L: 37, J: 38, K: 40, N: 45, M: 46 };
const DIGITS = { 1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, 9: 25, 7: 26, 8: 28, 0: 29 };
// Modifiers in macOS order, each with the keydown flag a page sees.
const MODIFIERS = [['Control', 'control', 'ctrlKey'], ['Alt', 'option', 'altKey'], ['Shift', 'shift', 'shiftKey'], ['Meta', 'command', 'metaKey']];

/** The key code and DOM key and code for one key name, or null. */
function keyOf(name) {
  const letter = name.length === 1 ? name.toUpperCase() : /^Key[A-Z]$/.test(name) ? name.slice(3) : null;
  if (letter in LETTERS) return [LETTERS[letter], letter.toLowerCase(), `Key${letter}`];
  const digit = /^\d$/.test(name) ? name : /^Digit\d$/.test(name) ? name.slice(5) : null;
  if (digit !== null) return [DIGITS[digit], digit, `Digit${digit}`];
  return NAMED[name] ?? null;
}

/** `keys`, such as 'Meta+K', as `{ keyCode, modifiers, down }`: what to post, what to hold, and the keydown a page would see. */
export function macKeys(keys) {
  // Every part before the last '+' is a modifier; the rest is the key.
  const [, prefix, name] = String(keys).match(/^((?:[^+]+\+)*)(.*)$/);
  const held = new Set(prefix.split('+').filter(Boolean).map(part => part === 'ControlOrMeta' ? 'Meta' : part));
  for (const part of held) if (!MODIFIERS.some(([modifier]) => modifier === part)) throw new Error(`d.press does not know the modifier '${part}'; use Control, Alt, Shift, Meta or ControlOrMeta`);
  const key = keyOf(name);
  if (!key) throw new Error(`d.press does not know the key '${name}'; use names such as Enter, Escape, Tab, Space, ArrowUp, a letter or a digit, as in 'Meta+K'`);
  const [keyCode, domKey, code] = key, on = MODIFIERS.filter(([modifier]) => held.has(modifier));
  return {
    keyCode, modifiers: on.map(([, mac]) => mac),
    down: { key: domKey, code, ...Object.fromEntries(MODIFIERS.map(([modifier, , flag]) => [flag, held.has(modifier)])) },
  };
}
