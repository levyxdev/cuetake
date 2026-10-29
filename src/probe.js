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
    const state = { pointer: [], downs: [], ups: [], keys: [], shapes: [] };
    // The tab capture never shows the pointer, so the page keeps its cursor and Render draws the shape it
    // asks for, as the browser would show it: `auto` is text over editable fields and selectable text,
    // otherwise default; an image cursor gives way to its fallback keyword.
    const deepest = (x, y) => {
      let element = document.elementFromPoint(x, y);
      for (let inner; element?.shadowRoot && (inner = element.shadowRoot.elementFromPoint(x, y)) && inner !== element;) element = inner;
      return element;
    };
    const editable = element => element.isContentEditable
      || element.matches('textarea:not(:disabled), input:not(:disabled):not([type=button],[type=submit],[type=reset],[type=checkbox],[type=radio],[type=range],[type=color],[type=file],[type=image])');
    const overText = (element, x, y) => {
      const caret = document.caretPositionFromPoint?.(x, y), node = caret?.offsetNode;
      const parent = node?.nodeType === Node.TEXT_NODE && node.data.trim() && element.contains(node) && node.parentElement;
      if (!parent || parent.closest('button, select') || getComputedStyle(parent).userSelect === 'none') return false;
      const range = document.createRange();
      range.selectNodeContents(node);
      return [...range.getClientRects()].some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
    };
    const shapeAt = (x, y) => {
      const element = deepest(x, y);
      if (!element) return 'default';
      const keyword = getComputedStyle(element).cursor.match(/([a-z-]+)\s*$/)?.[1] ?? 'auto';
      return keyword !== 'auto' ? keyword : editable(element) || overText(element, x, y) ? 'text' : 'default';
    };
    // Read after the page's own handlers have run, since they often set the cursor themselves.
    let point = null, due = null;
    const sampleShape = ms => {
      if (!point || due !== null) return;
      due = ms;
      setTimeout(() => {
        try {
          const shape = shapeAt(point.x, point.y);
          if (shape !== state.shapes.at(-1)?.[1]) state.shapes.push([due, shape]);
        } finally { due = null; }
      });
    };
    const moved = e => { point = { x: e.clientX, y: e.clientY }; sampleShape(at(e)); };
    on('pointermove', e => { state.pointer.push([at(e), e.clientX, e.clientY]); moved(e); });
    on('pointerdown', e => {
      state.pointer.push([at(e), e.clientX, e.clientY]); moved(e);
      if (e.button === 0) state.downs.push({ ms: at(e), x: e.clientX, y: e.clientY, box: box(e.target) });
    });
    on('pointerup', e => { moved(e); if (e.button === 0) state.ups.push({ ms: at(e), x: e.clientX, y: e.clientY }); });
    on('keydown', e => { state.keys.push({ ms: at(e), box: box(document.activeElement) }); sampleShape(at(e)); });
    on('keyup', e => sampleShape(at(e)));
    on('scroll', e => sampleShape(at(e)));
    window.__cuetakeProbe = { state, dispose() { abort.abort(); } };
  });
}

const CLICK_SLOP = 6; // CSS px a press may travel and still count as a click

/**
 * Rebases probe records to seconds since capture start and derives clicks and drags (from press to
 * release), typing, and the cursor shapes: each change as [t, keyword], starting with the one shown
 * when Capture began.
 */
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
      : { type: 'click', t: t(down.ms), end: t(up?.ms ?? down.ms), x: down.x, y: down.y, box: down.box });
  }
  // Consecutive keys into the same field within a second form one typing burst.
  for (const key of raw.keys.filter(k => k.ms >= startedAtMs)) {
    const last = events.at(-1);
    if (last?.type === 'type' && t(key.ms) - last.end <= 1 && JSON.stringify(last.box) === JSON.stringify(key.box)) last.end = t(key.ms);
    else events.push({ type: 'type', t: t(key.ms), end: t(key.ms), box: key.box });
  }
  const before = raw.shapes.filter(([ms]) => ms < startedAtMs).at(-1);
  const shapes = [...(before ? [[0, before[1]]] : []), ...raw.shapes.filter(([ms]) => ms >= startedAtMs).map(([ms, shape]) => [t(ms), shape])];
  return { pointer, shapes, events: events.sort((a, b) => a.t - b.t) };
}
