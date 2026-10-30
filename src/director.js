import { landing, pauseMs, random, reach, typingDelays } from './motion.js';

/**
 * Timed, viewport-aligned interactions shared by all scenarios, moving like a person (see motion.js).
 * `said` collects where each Line starts and `forwarded` each fast-forwarded wait; `voiced` maps the
 * Narration's Line ids to their audio's seconds, or is null without one. `speed` scales every move,
 * pause and typing delay it chooses; `seed` picks one of many equally human ways to move.
 */
export function createDirector(page, startedAt, fps, focusTargets, wideWindows, said = [], forwarded = [], voiced = null, { speed = 1, seed = 1 } = {}) {
  let cursor = { x: 0, y: 0 }, forwarding = null;
  const rand = random(seed);
  const wait = ms => page.waitForTimeout(Math.max(0, ms));
  const time = () => (Date.now() - startedAt) / 1000;
  const pause = name => wait(pauseMs(name, speed, rand));
  async function glide(to, { size, duration, drag } = {}) {
    const path = reach(cursor, to, { size, duration, speed, drag, rand });
    // Progress follows the clock, so a page slow to take each move cannot stretch the move.
    const start = Date.now();
    for (let i = 1, t = 0; t < 1; i++) {
      await wait(start + i * 1000 / fps - Date.now());
      t = path.duration ? Math.min(1, (Date.now() - start) / path.duration) : 1;
      const { x, y } = path.at(t);
      await page.mouse.move(x, y);
    }
    cursor = { ...to };
  }
  const move = (x, y, duration) => glide({ x, y }, { duration });
  // Clicks, typing, drags and cursor shapes are recorded by the in-page probe; only deliberate camera choices live here.
  const focus = (box, t = time()) => focusTargets.push({ t, box });
  /** Options may be a bare number for the action's main timing; `focus: false` keeps the camera wide. */
  const options = (value, key) => typeof value === 'number' ? { [key]: value } : value ?? {};
  async function act({ focus: follow = true }, action) {
    const start = time();
    try { return await action(); }
    finally { if (follow === false) wideWindows.push({ start, end: time() }); }
  }
  /** Moves onto a target, landing a little off its center; returns the target and where it landed inside its box. */
  async function approach(locator, duration, action) {
    const target = typeof locator === 'string' ? page.locator(locator) : locator;
    const box = await target.boundingBox();
    if (!box) throw new Error(`${action} target has no visible bounding box`);
    const point = landing(box, rand);
    await glide(point, { size: Math.min(box.width, box.height), duration });
    return { target, position: { x: point.x - box.x, y: point.y - box.y } };
  }
  /** `button: 'right'` opens the page's context menu instead. */
  function click(locator, opts) {
    const { duration, button = 'left', ...rest } = options(opts, 'duration');
    return act(rest, async () => {
      const { target, position } = await approach(locator, duration, 'Click');
      await pause('beforePress');
      // A person holds the button for a moment, so the Cursor's press shows.
      await target.click({ position, button, delay: pauseMs('press', speed, rand) });
      await pause('afterRelease');
    });
  }
  /** Presses a key or combination, such as 'Meta+K', on whatever has focus; the Final shows it as keycaps. */
  function press(keys, opts) {
    return act(options(opts), async () => {
      await pause('beforeKey');
      await page.keyboard.press(keys, { delay: pauseMs('press', speed, rand) });
      await pause('afterKey');
    });
  }
  /** Rests the cursor on a target without pressing, so the page shows its hover state. */
  async function hover(locator, opts) {
    const { duration } = options(opts, 'duration');
    await approach(locator, duration, 'Hover');
  }
  function type(locator, text, opts) {
    const { msPerChar = 70 / speed, ...rest } = options(opts, 'msPerChar');
    return act(rest, async () => {
      await click(locator, rest);
      const chars = [...text], delays = typingDelays(text, msPerChar, rand);
      for (let i = 0; i < chars.length; i++) {
        if (i) await wait(delays[i - 1]);
        await page.keyboard.type(chars[i]);
      }
    });
  }
  function drag(from, to, opts) {
    const { duration, ...rest } = options(opts, 'duration');
    return act(rest, async () => {
      await glide(from);
      await pause('beforePress');
      await page.mouse.down();
      try {
        await pause('afterGrab');
        await glide(to, { duration, drag: true });
        await pause('beforeDrop');
      } finally { await page.mouse.up(); }
      await pause('afterRelease');
    });
  }
  /**
   * Runs `action`, a wait the viewer need not sit through, such as `() => reply.waitFor()`;
   * the Final plays it `rate` times faster. Speech cannot speed up with it, so no Line is said inside.
   */
  async function fastForward(action, opts) {
    const { rate = 4 } = options(opts, 'rate');
    if (typeof action !== 'function') throw new Error('d.fastForward needs a function that waits, such as () => reply.waitFor()');
    if (!(typeof rate === 'number' && rate >= 1)) throw new Error(`d.fastForward needs a rate of at least 1, not ${rate}`);
    if (forwarding) throw new Error(`d.fastForward was called inside the one from ${forwarding.t.toFixed(2)} s`);
    forwarding = { t: time(), rate };
    try { return await action(); }
    finally { forwarded.push({ t: forwarding.t, end: time(), rate }); forwarding = null; }
  }
  /** Starts a Line. With a Narration it holds for the Line's audio, so the picture follows the voice. */
  async function say(id, text) {
    const t = time(), earlier = said.find(line => line.id === id);
    if (earlier) throw new Error(`Line '${id}' was already said at ${earlier.t.toFixed(2)} s`);
    if (forwarding) throw new Error(`Line '${id}' is said inside d.fastForward, which the Final plays faster than speech; say it before the wait`);
    if (voiced) {
      if (!voiced.has(id)) throw new Error(`The Narration has no Line '${id}'; its Lines are ${[...voiced.keys()].join(', ')}`);
      said.push({ t, id });
      await wait((t + voiced.get(id)) * 1000 - (Date.now() - startedAt));
    } else {
      if (typeof text !== 'string' || !text) throw new Error(`d.say('${id}') needs the Line's text when recording without --narration`);
      said.push({ t, id, text });
    }
  }
  return { page, wait, time, at: seconds => wait(seconds * 1000 - (Date.now() - startedAt)), move, hover, click, press, type, drag, focus, say, fastForward };
}
