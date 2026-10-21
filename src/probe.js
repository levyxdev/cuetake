/**
 * In-page Timeline probe. It records input exactly as the page receives it, so
 * director actions and raw Playwright input are captured alike. All positions
 * are CSS pixels; times are epoch milliseconds until collectTimeline rebases them.
 * Input inside cross-origin iframes never reaches this document and is not seen.
 */
export async function installProbe(page) {
  await page.evaluate(() => {
    window.__cuetakeProbe?.dispose();
    const abort = new AbortController();
    const on = (type, fn) => document.addEventListener(type, fn, { capture: true, passive: true, signal: abort.signal });
    const at = event => performance.timeOrigin + event.timeStamp;
    const interactive = 'a,button,input,textarea,select,label,summary,[role],[tabindex],[contenteditable]';
    const box = element => {
      const target = element?.closest?.(interactive) || element;
      const r = target?.getBoundingClientRect?.();
      return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    };
    const state = { pointer: [], downs: [], ups: [], keys: [] };
    on('pointermove', e => state.pointer.push([at(e), e.clientX, e.clientY]));
    on('pointerdown', e => {
      state.pointer.push([at(e), e.clientX, e.clientY]);
      if (e.button === 0) state.downs.push({ ms: at(e), x: e.clientX, y: e.clientY, box: box(e.target) });
    });
    on('pointerup', e => { if (e.button === 0) state.ups.push({ ms: at(e), x: e.clientX, y: e.clientY }); });
    on('keydown', e => state.keys.push({ ms: at(e), box: box(document.activeElement) }));
    // The tab capture never shows the OS pointer; Render draws the cursor instead.
    const css = document.createElement('style');
    css.textContent = '* { cursor:none !important; }';
    document.documentElement.append(css);
    window.__cuetakeProbe = { state, dispose() { abort.abort(); css.remove(); } };
  });
}

const CLICK_SLOP = 6; // CSS px a press may travel and still count as a click

/** Rebases probe records to seconds since capture start and derives clicks, drags and typing. */
export async function collectTimeline(page, startedAtMs) {
  const raw = await page.evaluate(() => window.__cuetakeProbe.state);
  const t = ms => Math.round(ms - startedAtMs) / 1000;
  const pointer = raw.pointer.filter(([ms]) => ms >= startedAtMs).map(([ms, x, y]) => [t(ms), x, y]);
  const events = [];
  for (const down of raw.downs.filter(d => d.ms >= startedAtMs)) {
    const up = raw.ups.find(u => u.ms >= down.ms);
    const moved = up && Math.hypot(up.x - down.x, up.y - down.y) > CLICK_SLOP;
    events.push(moved
      ? { type: 'drag', t: t(down.ms), end: t(up.ms), from: { x: down.x, y: down.y }, to: { x: up.x, y: up.y } }
      : { type: 'click', t: t(down.ms), x: down.x, y: down.y, box: down.box });
  }
  // Consecutive keys into the same field within a second form one typing burst.
  for (const key of raw.keys.filter(k => k.ms >= startedAtMs)) {
    const last = events.at(-1);
    if (last?.type === 'type' && t(key.ms) - last.end <= 1 && JSON.stringify(last.box) === JSON.stringify(key.box)) last.end = t(key.ms);
    else events.push({ type: 'type', t: t(key.ms), end: t(key.ms), box: key.box });
  }
  return { pointer, events: events.sort((a, b) => a.t - b.t) };
}
