/** Timed, viewport-aligned interactions shared by all scenarios. */
export function createDirector(page, startedAt, fps, events) {
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
  const focus = (box, timestamp = time()) => events.push({ type: 'hover', timestamp, boundingBox: box });
  async function click(locator, duration = 450) {
    const target = typeof locator === 'string' ? page.locator(locator) : locator;
    const box = await target.boundingBox();
    if (!box) throw new Error('Click target has no visible bounding box');
    await move(box.x + box.width / 2, box.y + box.height / 2, duration);
    await target.click();
    events.push({ type: 'click', timestamp: time(), boundingBox: box });
  }
  async function type(locator, text, msPerChar = 70) {
    await click(locator);
    await page.keyboard.type(text, { delay: msPerChar });
  }
  async function drag(from, to, duration = 1200) {
    await move(from.x, from.y, 400);
    await page.mouse.down();
    try { await move(to.x, to.y, duration); }
    finally { await page.mouse.up(); }
  }
  return { page, wait, time, at: seconds => wait(seconds * 1000 - (Date.now() - startedAt)), move, click, type, drag, focus };
}
