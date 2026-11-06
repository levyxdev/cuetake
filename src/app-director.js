import { clockOf, options } from './director.js';
import { appLocators, isAppLocator, resolveOne } from './app-locators.js';
import { landing, pauseMs, random, reach, typingDelays } from './motion.js';
import { macKeys } from './mac-keys.js';
import { shortcutKeys } from './shortcuts.js';

// The AX roles of an element that takes typing, where a key pressed alone is typing, not a Shortcut.
const FIELDS = new Set(['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField']);
// Characters typed as their key, since a text field takes them as a key press, not as text.
const TYPED_AS_KEYS = { '\n': 'Enter', '\t': 'Tab' };

/**
 * The Director of a Take of Apps (ADR 0009). It keeps time, says Lines, fast-forwards waits and adds
 * camera focus targets as the page Director does, in Desktop points, and locates the App's elements by
 * Accessibility role and name (app-locators.js). It acts with real input at a human pace (motion.js):
 * it moves the real pointer at `fps`, presses, releases and posts keys through `helper`, whose
 * `request` also answers:
 *   { move: { x, y } }                       moves the pointer there, dragging while a button is down
 *   { down: { x, y, button } }               presses there, unless another app's window lies over the
 *                                            point, when it presses nothing and answers { covered: name },
 *                                            or nothing does, { nothing: true }
 *   { up: { x, y, button } }                 releases there
 *   { key: { keyCode, modifiers, down } }    presses or releases a key with modifiers held
 *   { text: char }                           types one character
 *   { focused: {} }                          the focused element's { role, subrole }
 * Since the App draws no pointer of its own, the Director notes in `notes` everything Render draws:
 * the pointer path (`pointer`, as [seconds, x, y]) and the clicks, drags, typing and Shortcuts (`events`).
 * The pointer starts at the Desktop's top-left corner, where Capture puts it.
 */
export function createAppDirector({ startedAt, fps = 60, voiced = null, speed = 1, seed = 1, helper }, notes) {
  const clock = clockOf({ startedAt, voiced }, notes, () => 0), { wait, time } = clock, locators = appLocators(helper);
  const rand = random(seed), pause = name => wait(pauseMs(name, speed, rand));
  // What the Director notes is rounded to the millisecond and to a hundredth of a point.
  const now = () => Math.round(time() * 1000) / 1000, round = v => Math.round(v * 100) / 100;
  let cursor = { x: 0, y: 0 };

  async function point(x, y) {
    notes.pointer.push([now(), round(x), round(y)]);
    await helper.request({ move: { x: round(x), y: round(y) } });
  }
  async function glide(to, { size, duration, drag } = {}) {
    const path = reach(cursor, to, { size, duration, speed, drag, rand });
    const start = Date.now();
    for (let i = 1, t = 0; t < 1; i++) {
      await wait(start + i * 1000 / fps - Date.now());
      t = path.duration ? Math.min(1, (Date.now() - start) / path.duration) : 1;
      const { x, y } = path.at(t);
      await point(x, y);
    }
    cursor = { x: to.x, y: to.y };
  }
  async function act({ focus: follow = true }, action) {
    const start = time();
    try { return await action(); }
    finally { if (follow === false) notes.wide.push({ start, end: time() }); }
  }
  /** Where a target lies: an App locator's element, waited for, or a point or box in Desktop points. */
  async function boxOf(target, action) {
    if (isAppLocator(target)) return (await resolveOne(target)).frame;
    if (typeof target?.x === 'number' && typeof target?.y === 'number') return { width: 0, height: 0, ...target };
    throw new Error(`d.${action} needs a locator of the App, such as d.page.getByRole('button', { name: 'Save' }), or a point { x, y } in Desktop points`);
  }
  /** Moves onto a target, landing a little off its center; returns its box and where it landed. */
  async function approach(target, duration, action) {
    const box = await boxOf(target, action);
    const land = box.width && box.height ? landing(box, rand) : box, at = { x: round(land.x), y: round(land.y) };
    await glide(at, { size: Math.min(box.width, box.height) || undefined, duration });
    return { box, at };
  }
  /** Presses at `at`, refused when another app's window, or nothing, lies there: the App would never get the press. */
  async function down(at, button, action, target) {
    const { covered, nothing } = await helper.request({ down: { ...at, button } }) ?? {}, where = `${Math.round(at.x)}, ${Math.round(at.y)}`;
    const named = `d.${action} target${target ? `, ${target},` : ''}`;
    if (covered) throw new Error(`${named} is covered by a window of ${covered} at ${where}; close or move that window, then record again`);
    if (nothing) throw new Error(`${named} lands at ${where}, where no window shows; it may lie outside the Desktop`);
  }
  /** `button: 'right'` opens the App's context menu instead. */
  function click(target, opts) {
    const { duration, button = 'left', ...rest } = options(opts, 'duration');
    return act(rest, async () => {
      const { box, at } = await approach(target, duration, 'click');
      await pause('beforePress');
      await down(at, button, 'click', isAppLocator(target) && String(target));
      const t = now();
      // A person holds the button for a moment, so the Cursor's press shows.
      await wait(pauseMs('press', speed, rand));
      await helper.request({ up: { ...at, button } });
      notes.events.push({ type: 'click', t, end: now(), x: at.x, y: at.y, box, ...(button === 'right' && { button }) });
      await pause('afterRelease');
    });
  }
  async function key(keys, hold) {
    const { keyCode, modifiers } = macKeys(keys);
    await helper.request({ key: { keyCode, modifiers, down: true } });
    await wait(hold);
    await helper.request({ key: { keyCode, modifiers, down: false } });
  }
  /** Presses a key or combination, such as 'Meta+K', on whatever has focus; the Final shows a Shortcut as keycaps. */
  function press(keys, opts) {
    return act(options(opts), async () => {
      const { down: keydown } = macKeys(keys);
      await pause('beforeKey');
      const { role, subrole } = await helper.request({ focused: {} }) ?? {}, t = now();
      await key(keys, pauseMs('press', speed, rand));
      const shown = shortcutKeys({ ...keydown, field: FIELDS.has(role) || FIELDS.has(subrole) });
      if (shown) notes.events.push({ type: 'shortcut', t, keys: shown });
      await pause('afterKey');
    });
  }
  /** Rests the pointer on a target without pressing, so the App shows its hover state. */
  async function hover(target, opts) {
    const { duration, ...rest } = options(opts, 'duration');
    await act(rest, () => approach(target, duration, 'hover'));
  }
  function type(target, text, opts) {
    const { msPerChar = 70 / speed, ...rest } = options(opts, 'msPerChar');
    return act(rest, async () => {
      await click(target, rest);
      const { box } = notes.events.at(-1), chars = [...text], delays = typingDelays(text, msPerChar, rand), t = now();
      for (let i = 0; i < chars.length; i++) {
        if (i) await wait(delays[i - 1]);
        if (TYPED_AS_KEYS[chars[i]]) await key(TYPED_AS_KEYS[chars[i]], 0);
        else await helper.request({ text: chars[i] });
      }
      notes.events.push({ type: 'type', t, end: now(), box });
    });
  }
  function drag(from, to, opts) {
    const { duration, ...rest } = options(opts, 'duration');
    const point = p => !isAppLocator(p) && typeof p?.x === 'number' && typeof p?.y === 'number';
    if (!point(from) || !point(to)) return Promise.reject(new Error('d.drag goes from one point { x, y } to another, in Desktop points'));
    return act(rest, async () => {
      await glide(from);
      await pause('beforePress');
      await down(from, 'left', 'drag');
      const t = now();
      try {
        await pause('afterGrab');
        await glide(to, { duration, drag: true });
        await pause('beforeDrop');
      } finally { await helper.request({ up: { x: to.x, y: to.y, button: 'left' } }); }
      notes.events.push({ type: 'drag', t, end: now(), from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } });
      await pause('afterRelease');
    });
  }
  const refuse = (name, why) => () => { throw new Error(`d.${name} does not work in a Take of an App${why}`); };
  return {
    /** The window in front, offering Accessibility locators. */
    get page() { return locators.page('front'); },
    app: { window: locators.window },
    wait, time, at: clock.at, focus: clock.focus, say: clock.say, fastForward: clock.fastForward,
    move: (x, y, duration) => glide({ x, y }, { duration }), hover, click, press, type, drag,
    mask: refuse('mask', ' yet'), switchTo: refuse('switchTo', ' until it can record several Apps'),
  };
}
