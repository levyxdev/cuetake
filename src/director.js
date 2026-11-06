import { landing, pauseMs, random, reach, typingDelays } from './motion.js';
import { boxOnPage } from './frames.js';
import { carried, seenBy, windowMaps } from './tabs.js';
import { EFFECT_NAMES, MASK_EFFECTS } from './masks.js';

/** Milliseconds between the Director's checks of what a mask's locator matches, so a replaced element is followed. */
const REWATCH_MS = 100;

/** Refuses a mask effect masks.js does not draw. */
export function effectOf(effect) {
  if (!(effect in MASK_EFFECTS)) throw new Error(`d.mask needs effect ${EFFECT_NAMES}, not '${effect}'`);
}

/**
 * Notes a mask of the element `id` (in `notes.elements` and `notes.masks`) from `t`, and calls `watch`
 * every REWATCH_MS until `signal` aborts, unless `skip()`, so the element is followed when its page or
 * App replaces it. Returns the mask's handle, whose `end()` ends it at `time()`.
 */
export function followMask({ id, tab, name, t, effect, params }, notes, { watch, skip = () => false, signal, time }) {
  notes.elements.push({ id, tab, name });
  const entry = { t, end: null, element: id, effect, ...params };
  notes.masks.push(entry);
  let busy = false;
  const timer = setInterval(() => {
    if (busy || skip()) return;
    busy = true;
    watch().catch(() => {}).finally(() => { busy = false; });
  }, REWATCH_MS);
  timer.unref?.();
  signal?.addEventListener('abort', () => clearInterval(timer), { once: true });
  if (signal?.aborted) clearInterval(timer);
  return { end() { entry.end ??= time(); } };
}

/** Options may be a bare number for the action's main timing; `focus: false` keeps the camera wide. */
export const options = (value, key) => typeof value === 'number' ? { [key]: value } : value ?? {};

/**
 * The Director's clock, shared by pages and Apps: waits, camera focus targets, Lines and fast-forwarded
 * waits, timed from `startedAt` (epoch ms) and noted in `notes`. `front()` is the Tab a focus target is
 * in. `state.waited` turns true once the Scenario first waits.
 */
export function clockOf({ startedAt, voiced = null }, { focus: focusTargets, said, forwarded }, front) {
  const state = { waited: false, forwarding: null };
  // Node's clock, not a page's, since the page in front may close mid-wait.
  const wait = ms => { state.waited = true; return new Promise(resolve => setTimeout(resolve, Math.max(0, ms))); };
  const time = () => (Date.now() - startedAt) / 1000;
  const focus = (box, t = time()) => focusTargets.push({ t, box, tab: front() });
  /**
   * Runs `action`, a wait the viewer need not sit through, such as `() => reply.waitFor()`;
   * the Final plays it `rate` times faster. Speech cannot speed up with it, so no Line is said inside.
   */
  async function fastForward(action, opts) {
    const { rate = 4 } = options(opts, 'rate');
    if (typeof action !== 'function') throw new Error('d.fastForward needs a function that waits, such as () => reply.waitFor()');
    if (!(typeof rate === 'number' && rate >= 1)) throw new Error(`d.fastForward needs a rate of at least 1, not ${rate}`);
    if (state.forwarding) throw new Error(`d.fastForward was called inside the one from ${state.forwarding.t.toFixed(2)} s`);
    state.waited = true;
    state.forwarding = { t: time(), rate };
    try { return await action(); }
    finally { forwarded.push({ t: state.forwarding.t, end: time(), rate }); state.forwarding = null; }
  }
  /** Starts a Line. With a Narration it holds for the Line's audio, so the picture follows the voice. */
  async function say(id, text) {
    const t = time(), earlier = said.find(line => line.id === id);
    if (earlier) throw new Error(`Line '${id}' was already said at ${earlier.t.toFixed(2)} s`);
    if (state.forwarding) throw new Error(`Line '${id}' is said inside d.fastForward, which the Final plays faster than speech; say it before the wait`);
    if (voiced) {
      if (!voiced.has(id)) throw new Error(`The Narration has no Line '${id}'; its Lines are ${[...voiced.keys()].join(', ')}`);
      said.push({ t, id });
      await wait((t + voiced.get(id)) * 1000 - (Date.now() - startedAt));
    } else {
      if (typeof text !== 'string' || !text) throw new Error(`d.say('${id}') needs the Line's text when recording without --narration`);
      said.push({ t, id, text });
    }
  }
  return { state, wait, time, at: seconds => wait(seconds * 1000 - (Date.now() - startedAt)), focus, fastForward, say };
}

/**
 * Timed, viewport-aligned interactions shared by all scenarios, moving like a person (see motion.js).
 * `tabs` are the Tabs Capture follows (follow-tabs.js); the Director acts only on the one in front.
 * `notes` collects the camera's focus targets and `wide` windows, where each Line starts (`said`),
 * each fast-forwarded wait (`forwarded`) and the pointer path no Tab could see (`pointer`, as
 * [epoch ms, x, y, tab]), and each element masked (`elements`, { id, tab, name }) with its mask
 * (`masks`). `voiced` maps the Narration's Line ids to their audio's seconds, or is null
 * without one. `speed` scales every move, pause and typing delay it chooses; `seed` picks one of many
 * equally human ways to move. `signal` aborts once the Scenario has run, when masks stop following.
 */
export function createDirector(tabs, { startedAt, fps, voiced = null, speed = 1, seed = 1, signal }, notes) {
  const { wide: wideWindows, pointer, elements = [], masks = [] } = notes;
  Object.assign(notes, { elements, masks });
  let cursor = { x: 0, y: 0, tab: tabs.front.id };
  const rand = random(seed);
  const clock = clockOf({ startedAt, voiced }, notes, () => tabs.front.id), { wait, time, focus, fastForward, say } = clock;
  const pause = name => wait(pauseMs(name, speed, rand));
  /** Moves the front Tab's mouse; where its page cannot see the pointer, the Director notes the path itself. */
  async function point(front, x, y) {
    if (!seenBy({ x, y }, front.viewport)) pointer.push([Date.now(), x, y, front.id]);
    // A popup may close itself while the cursor is on its way; the next action carries the cursor on.
    await front.page.mouse.move(x, y).catch(error => { if (!front.page.isClosed()) throw error; });
  }
  /**
   * The Tab in front, once it records. The cursor follows a change of Tab: it stays where it was over
   * the window, so the new page's mouse is moved there, as converted through where a popup sits.
   */
  async function inFront() {
    const front = tabs.front;
    await tabs.ready(front.page);
    if (cursor.tab !== front.id) {
      const all = tabs.list(), at = carried(cursor, cursor.tab, front.id, windowMaps(all, all[0].viewport));
      cursor = { ...at, tab: front.id };
      await point(front, at.x, at.y);
    }
    return front;
  }
  async function glide(to, { size, duration, drag } = {}) {
    const front = await inFront();
    const path = reach(cursor, to, { size, duration, speed, drag, rand });
    // Progress follows the clock, so a page slow to take each move cannot stretch the move.
    const start = Date.now();
    for (let i = 1, t = 0; t < 1; i++) {
      await wait(start + i * 1000 / fps - Date.now());
      t = path.duration ? Math.min(1, (Date.now() - start) / path.duration) : 1;
      const { x, y } = path.at(t);
      await point(front, x, y);
    }
    cursor = { x: to.x, y: to.y, tab: front.id };
  }
  const move = (x, y, duration) => glide({ x, y }, { duration });
  // Clicks, typing, drags and cursor shapes are recorded by the in-page probe; only deliberate camera choices live here.
  async function act({ focus: follow = true }, action) {
    const start = time();
    try { return await action(); }
    finally { if (follow === false) wideWindows.push({ start, end: time() }); }
  }
  /** The located target, refused unless it is in the Tab in front: a person can't click a tab they can't see. */
  async function located(locator, action) {
    const front = await inFront();
    const target = typeof locator === 'string' ? front.page.locator(locator) : locator;
    if (target.page() !== front.page) {
      const tab = tabs.of(target.page());
      throw new Error(tab
        ? `${action} target is in Tab ${tab.id}, behind the one in front; bring it in front first with d.switchTo(page)`
        : `${action} target is on a page Capture does not follow; act on d.page, or on a page the demo opened`);
    }
    return target;
  }
  /**
   * Moves onto a target, landing a little off its center, measured through any iframes it is in.
   * Returns the target and the `position` that makes Playwright press where it landed: Playwright
   * counts it from the padding edge of its own box, which is off inside a cross-origin iframe. Where
   * Playwright's box is off, it would also check the wrong spot for what the press hits, so `share`,
   * where it landed as a share of the box, is returned for the Director to check instead.
   */
  async function approach(locator, duration, action) {
    const target = await located(locator, action);
    const [box, seen, border] = await Promise.all([
      boxOnPage(target), target.boundingBox(),
      target.evaluate(e => { const style = getComputedStyle(e); return { left: parseInt(style.borderLeftWidth, 10) || 0, top: parseInt(style.borderTopWidth, 10) || 0 }; }),
    ]);
    if (!box || !seen) throw new Error(`${action} target has no visible bounding box`);
    const point = landing(box, rand);
    await glide(point, { size: Math.min(box.width, box.height), duration });
    const placed = ['x', 'y', 'width', 'height'].every(key => Math.abs(seen[key] - box[key]) < 0.5);
    return { target, position: { x: point.x - seen.x - border.left, y: point.y - seen.y - border.top }, share: !placed && { x: (point.x - box.x) / box.width, y: (point.y - box.y) / box.height } };
  }
  /** Waits until the target is enabled and is what a press at `share` of its box hits, as Playwright's click waits. */
  async function unblocked(target, share, action) {
    for (const deadline = Date.now() + 10_000; ;) {
      const blocker = await target.evaluate((e, share) => {
        if (e.matches(':disabled')) return 'disabled';
        const r = e.getBoundingClientRect(), hit = e.getRootNode().elementFromPoint(r.x + share.x * r.width, r.y + share.y * r.height);
        return !hit || hit === e || e.contains(hit) ? null : `covered by <${hit.localName}${hit.id ? `#${hit.id}` : ''}>`;
      }, share);
      if (!blocker) return;
      if (Date.now() > deadline) throw new Error(`${action} target is ${blocker} where the Director landed`);
      await wait(100);
    }
  }
  /** `button: 'right'` opens the page's context menu instead. */
  function click(locator, opts) {
    const { duration, button = 'left', ...rest } = options(opts, 'duration');
    return act(rest, async () => {
      const { target, position, share } = await approach(locator, duration, 'Click');
      await pause('beforePress');
      if (share) await unblocked(target, share, 'Click');
      // A person holds the button for a moment, so the Cursor's press shows. A popup may close itself on the click.
      await target.click({ position, button, delay: pauseMs('press', speed, rand), force: !!share }).catch(error => { if (!target.page().isClosed()) throw error; });
      await pause('afterRelease');
    });
  }
  /** Presses a key or combination, such as 'Meta+K', on whatever has focus; the Final shows it as keycaps. */
  function press(keys, opts) {
    return act(options(opts), async () => {
      const { page } = await inFront();
      await pause('beforeKey');
      await page.keyboard.press(keys, { delay: pauseMs('press', speed, rand) }).catch(error => { if (!page.isClosed()) throw error; });
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
      const { page } = await inFront(), chars = [...text], delays = typingDelays(text, msPerChar, rand);
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
      const { page } = await inFront();
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
   * Masks every element `locator` matches, in any Tab, from now until `end()` is called or the Take
   * ends: `blur` and `cover` hide it, `spotlight` dims the page around it. Capture records each
   * element's box as it moves; a blur or cover made before the Director first waits or acts covers the
   * Take from its first frame. Other options are the effect's parameters (masks.js).
   */
  async function mask(locator, opts = {}) {
    const { effect = 'blur', ...params } = opts;
    effectOf(effect);
    const target = typeof locator === 'string' ? tabs.front.page.locator(locator) : locator, tab = tabs.of(target.page());
    if (!tab) throw new Error('d.mask target is on a page Capture does not follow; mask on d.page, or on a page the demo opened');
    const t = effect !== 'spotlight' && !clock.state.waited ? 0 : time();
    await tabs.ready(tab.page);
    const id = elements.length;
    const watch = () => target.evaluateAll((found, id) => window.__cuetakeProbe?.watch(id, found) ?? false, id);
    if (!await watch()) throw new Error(`d.mask could not follow ${target} in Tab ${tab.id}: Capture's probe is not running in its frame`);
    // The page may replace the element, or navigate; watching again follows what the locator matches now.
    return followMask({ id, tab: tab.id, name: String(target), t, effect, params }, notes, { watch, skip: () => target.page().isClosed(), signal, time });
  }
  /** Brings a Tab back in front, such as the one a closed tab's demo continues in; the cursor stays where it was. */
  async function switchTo(page) {
    await tabs.switchTo(page);
    await inFront();
  }
  return {
    /** The Tab in front. */
    get page() { return tabs.front.page; },
    wait, time, at: clock.at, move, hover, click, press, type, drag, focus, say, fastForward, mask, switchTo,
  };
}
