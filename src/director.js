/**
 * Timed, viewport-aligned interactions shared by all scenarios. `said` collects where each Line
 * starts; `voiced` maps the Narration's Line ids to their audio's seconds, or is null without one.
 */
export function createDirector(page, startedAt, fps, focusTargets, wideWindows, said = [], voiced = null) {
  let cursor = { x: 0, y: 0 };
  const wait = ms => page.waitForTimeout(Math.max(0, ms));
  const time = () => (Date.now() - startedAt) / 1000;
  async function move(x, y, duration = 500) {
    const from = { ...cursor };
    const start = Date.now();
    const frames = Math.max(1, Math.round(duration * fps / 1000));
    for (let i = 1; i <= frames; i++) {
      const t = i / frames;
      const k = t * t * (3 - 2 * t);
      await page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k);
      await wait(start + i * duration / frames - Date.now());
    }
    cursor = { x, y };
  }
  // Clicks, typing and drags are recorded by the in-page probe; only deliberate camera choices live here.
  const focus = (box, t = time()) => focusTargets.push({ t, box });
  /** Options may be a bare number for the action's main timing; `focus: false` keeps the camera wide. */
  const options = (value, key) => typeof value === 'number' ? { [key]: value } : value ?? {};
  async function act({ focus: follow = true }, action) {
    const start = time();
    try { return await action(); }
    finally { if (follow === false) wideWindows.push({ start, end: time() }); }
  }
  function click(locator, opts) {
    const { duration = 450, ...rest } = options(opts, 'duration');
    return act(rest, async () => {
      const target = typeof locator === 'string' ? page.locator(locator) : locator;
      const box = await target.boundingBox();
      if (!box) throw new Error('Click target has no visible bounding box');
      await move(box.x + box.width / 2, box.y + box.height / 2, duration);
      await target.click();
    });
  }
  function type(locator, text, opts) {
    const { msPerChar = 70, ...rest } = options(opts, 'msPerChar');
    return act(rest, async () => {
      await click(locator, rest);
      await page.keyboard.type(text, { delay: msPerChar });
    });
  }
  function drag(from, to, opts) {
    const { duration = 1200, ...rest } = options(opts, 'duration');
    return act(rest, async () => {
      await move(from.x, from.y, 400);
      await page.mouse.down();
      try { await move(to.x, to.y, duration); }
      finally { await page.mouse.up(); }
    });
  }
  /** Starts a Line. With a Narration it holds for the Line's audio, so the picture follows the voice. */
  async function say(id, text) {
    const t = time(), earlier = said.find(line => line.id === id);
    if (earlier) throw new Error(`Line '${id}' was already said at ${earlier.t.toFixed(2)} s`);
    if (voiced) {
      if (!voiced.has(id)) throw new Error(`The Narration has no Line '${id}'; its Lines are ${[...voiced.keys()].join(', ')}`);
      said.push({ t, id });
      await wait((t + voiced.get(id)) * 1000 - (Date.now() - startedAt));
    } else {
      if (typeof text !== 'string' || !text) throw new Error(`d.say('${id}') needs the Line's text when recording without --narration`);
      said.push({ t, id, text });
    }
  }
  return { page, wait, time, at: seconds => wait(seconds * 1000 - (Date.now() - startedAt)), move, click, type, drag, focus, say };
}
