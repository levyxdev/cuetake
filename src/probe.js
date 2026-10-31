import { shortcutKeys } from './shortcuts.js';
import { contentOf } from './frames.js';

/**
 * The Timeline probe. It records input exactly as the page receives it, so director actions and raw
 * Playwright input are captured alike, in every frame of the page: cross-origin and nested iframes,
 * and frames that load after Capture starts. Each frame sends its records to Node as they happen, so a
 * frame removed during the Take (a checkout that closes once paid) keeps what it saw.
 *
 * A frame sees only its own coordinates, and a cross-origin frame cannot ask where it sits. Its parent
 * can: each document measures the iframes Node links to it, once per animation frame, and sends where
 * their content starts and how much they are scaled whenever that changes. Node maps a frame's
 * coordinates up through its parents to top-level CSS pixels, so scrolling, fixed and sticky
 * positioning, translation and scaling are all followed. A rotated, skewed or 3D-transformed iframe is
 * placed as if it were only scaled, and noted.
 * Times are epoch milliseconds until collectTimeline rebases them. `contentOf` is frames.js's, passed
 * in because the probe runs as page source.
 */
function probe(contentOf) {
  window.__cuetakeProbe?.dispose();
  const abort = new AbortController();
  const send = record => { try { window.__cuetakeRecord?.(record)?.catch?.(() => {}); } catch {} };
  const on = (type, fn) => document.addEventListener(type, fn, { capture: true, passive: true, signal: abort.signal });
  const at = event => performance.timeOrigin + event.timeStamp;
  const interactive = 'a,button,input,textarea,select,label,summary,[role],[tabindex],[contenteditable]';
  const box = element => {
    const target = element?.closest?.(interactive) || element;
    const r = target?.getBoundingClientRect?.();
    return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
  };
  const BUTTONS = { 0: 'left', 2: 'right' };
  const where = e => ({ x: e.clientX, y: e.clientY });
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
  // Read after the page's own handlers have run, since they often set the cursor themselves. A move
  // carries the shape it found, since the pointer may have left this frame and come back to the same
  // one; other samples are sent only when the shape changed.
  let point = null, due = null, last = null;
  const later = fn => setTimeout(() => { try { fn(); } catch {} });
  const sampleShape = ms => {
    if (!point || due !== null) return;
    due = ms;
    later(() => {
      try {
        const shape = shapeAt(point.x, point.y);
        if (shape !== last) { last = shape; send({ kind: 'shape', ms: due, shape }); }
      } finally { due = null; }
    });
  };
  on('pointermove', e => {
    point = { x: e.clientX, y: e.clientY };
    const record = { kind: 'move', ms: at(e), ...where(e) };
    later(() => { record.shape = last = shapeAt(record.x, record.y); });
    later(() => send(record));
  });
  // Presses and releases are sent at once: a frame may be removed right after the click it took.
  on('pointerdown', e => {
    point = { x: e.clientX, y: e.clientY };
    send(BUTTONS[e.button] ? { kind: 'down', ms: at(e), button: BUTTONS[e.button], ...where(e), box: box(e.target) } : { kind: 'move', ms: at(e), ...where(e) });
    sampleShape(at(e));
  });
  on('pointerup', e => {
    point = { x: e.clientX, y: e.clientY };
    if (BUTTONS[e.button]) send({ kind: 'up', ms: at(e), button: BUTTONS[e.button], ...where(e) });
    sampleShape(at(e));
  });
  // Each key with what Node needs to tell typing from a Shortcut (shortcuts.js); only Shortcuts reach the Timeline.
  const focused = () => { let element = document.activeElement; while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement; return element; };
  on('keydown', e => {
    const element = focused();
    const { key, code, ctrlKey, altKey, shiftKey, metaKey, repeat } = e;
    send({ kind: 'key', ms: at(e), box: box(element), key, code, ctrlKey, altKey, shiftKey, metaKey, repeat, field: Boolean(element && editable(element)) });
    sampleShape(at(e));
  });
  on('keyup', e => sampleShape(at(e)));
  on('scroll', e => sampleShape(at(e)));
  // Child iframes Node has linked to this document, measured each animation frame and sent on change.
  const ids = new WeakMap(), tracked = new Map();
  let nextId = 0, looping = false;
  const turned = element => {
    for (let node = element; node; node = node.parentElement ?? node.getRootNode().host) {
      const style = getComputedStyle(node);
      if (style.rotate !== 'none') return true;
      if (style.transform === 'none') continue;
      const m = new DOMMatrixReadOnly(style.transform);
      if (!m.is2D || m.b || m.c) return true;
    }
    return false;
  };
  const sampleFrames = () => {
    const rects = [];
    for (const [element, entry] of tracked) {
      if (!element.isConnected) { tracked.delete(element); continue; }
      const rect = contentOf(element), key = [rect.x, rect.y, rect.sx, rect.sy].map(v => v.toFixed(2)).join();
      if (key === entry.key) continue;
      entry.key = key;
      rects.push({ id: entry.id, ...rect, turned: turned(element) });
    }
    if (rects.length) send({ kind: 'frames', ms: performance.timeOrigin + performance.now(), rects });
  };
  const loop = () => {
    if (abort.signal.aborted || !tracked.size) { looping = false; return; }
    try { sampleFrames(); } finally { requestAnimationFrame(loop); }
  };
  const track = element => {
    if (!(element instanceof Element)) return null;
    let id = ids.get(element);
    if (id === undefined) ids.set(element, id = nextId++);
    if (!tracked.has(element)) tracked.set(element, { id, key: null });
    sampleFrames();
    if (!looping) { looping = true; requestAnimationFrame(loop); }
    return id;
  };
  window.__cuetakeProbe = { track, dispose() { abort.abort(); } };
  // Announced at once, so Node links this frame before any input reaches it.
  send({ kind: 'hello' });
}

const collectors = new WeakMap(), script = `(${probe})(${contentOf})`;

/**
 * Installs the probe in every frame of the page, now and in frames that load later, and starts
 * collecting what it sends. Calling it again on the same page starts the collection over.
 */
export async function installProbe(page) {
  let collector = collectors.get(page);
  if (!collector) {
    collector = { pending: new Set() };
    collectors.set(page, collector);
    await page.exposeBinding('__cuetakeRecord', ({ frame }, record) => {
      if (!record || typeof record !== 'object') return;
      collector.records.push({ ...record, frame: collector.idOf(frame) });
      collector.link(frame);
    });
    await page.addInitScript(script);
  }
  const ids = new WeakMap(), linked = new WeakSet(), records = [];
  let count = 0;
  const idOf = frame => { let id = ids.get(frame); if (id === undefined) ids.set(frame, id = count++); return id; };
  // A subframe is linked to its iframe element when its probe starts, so its parent starts measuring it;
  // a record that finds it unlinked tries again.
  const link = frame => {
    const parent = frame.parentFrame();
    if (!parent || linked.has(frame)) return;
    linked.add(frame);
    const linking = (async () => {
      const element = await frame.frameElement();
      const id = await element.evaluate(e => window.__cuetakeProbe?.track(e) ?? null);
      // The parent's probe may not be running yet; the frame's next record tries again.
      if (id === null) { linked.delete(frame); return; }
      records.push({ kind: 'link', frame: idOf(frame), parent: idOf(parent), element: id });
      link(parent);
    })().catch(() => linked.delete(frame));
    collector.pending.add(linking);
    linking.finally(() => collector.pending.delete(linking));
  };
  records.push({ kind: 'top', frame: idOf(page.mainFrame()) });
  Object.assign(collector, { idOf, link, records });
  // Parents first (frames() lists them in tree order), so each child finds its parent's probe to link to.
  for (const frame of page.frames()) await frame.evaluate(script).catch(() => {});
}

/** The entry of `list`, sorted by `ms`, last at or before `ms`, or its first. */
function latest(list, ms) {
  let low = 0, high = list.length - 1, found = 0;
  while (low <= high) { const mid = (low + high) >> 1; if (list[mid].ms <= ms) { found = mid; low = mid + 1; } else high = mid - 1; }
  return list[found];
}

/**
 * Places the probe's records from every frame in top-level CSS pixels. A subframe's point goes up
 * through each iframe holding it, by where that iframe's content started and how it was scaled at the
 * moment (the parent's last measure before it, or its first). Each frame's cursor shape counts only
 * while the pointer is over it. Returns the records as the top frame alone would have made them, plus
 * the times of presses and keys inside a rotated, skewed or 3D-transformed iframe (`turned`) and in a
 * frame that could not be placed (`unplaced`).
 */
export function placeRecords(records) {
  const top = new Set(), links = new Map(), measures = new Map();
  for (const r of records) {
    if (r.kind === 'top') top.add(r.frame);
    if (r.kind === 'link') links.set(r.frame, r);
    if (r.kind === 'frames') for (const rect of r.rects) {
      const key = `${r.frame}:${rect.id}`;
      if (!measures.has(key)) measures.set(key, []);
      measures.get(key).push({ ms: r.ms, ...rect });
    }
  }
  for (const list of measures.values()) list.sort((a, b) => a.ms - b.ms);
  // The map from a frame's coordinates to the top level at `ms`: an offset and a scale.
  const toTop = (frame, ms) => {
    let map = { x: 0, y: 0, sx: 1, sy: 1, turned: false };
    for (let f = frame, depth = 0; !top.has(f); depth++) {
      const link = links.get(f), list = link && measures.get(`${link.parent}:${link.element}`);
      if (!list?.length || depth > 32) return null;
      const m = latest(list, ms);
      map = { x: m.x + map.x * m.sx, y: m.y + map.y * m.sy, sx: map.sx * m.sx, sy: map.sy * m.sy, turned: map.turned || m.turned };
      f = link.parent;
    }
    return map;
  };
  const placed = { pointer: [], downs: [], ups: [], keys: [], shapes: [] }, turned = [], unplaced = [];
  let over = null;
  for (const r of records.filter(r => typeof r.ms === 'number' && r.kind !== 'frames').toSorted((a, b) => a.ms - b.ms)) {
    if (r.kind === 'move') over = r.frame;
    if (r.shape) {
      if (r.frame === over && r.shape !== placed.shapes.at(-1)?.[1]) placed.shapes.push([r.ms, r.shape]);
      if (r.kind === 'shape') continue;
    }
    const map = toTop(r.frame, r.ms), pressed = r.kind === 'down' || r.kind === 'key';
    if (!map) { if (pressed) unplaced.push(r.ms); continue; }
    if (map.turned && pressed) turned.push(r.ms);
    const box = b => b && { x: map.x + b.x * map.sx, y: map.y + b.y * map.sy, width: b.width * map.sx, height: b.height * map.sy };
    if (r.kind === 'key') { const { kind, frame, ms, box: own, ...key } = r; placed.keys.push({ ms, box: box(own), ...key }); continue; }
    const x = map.x + r.x * map.sx, y = map.y + r.y * map.sy;
    over = r.frame;
    if (r.kind === 'move' || r.kind === 'down') placed.pointer.push([r.ms, x, y]);
    if (r.kind === 'down') placed.downs.push({ ms: r.ms, button: r.button, x, y, box: box(r.box) });
    if (r.kind === 'up') placed.ups.push({ ms: r.ms, button: r.button, x, y });
  }
  return { ...placed, turned, unplaced };
}

const CLICK_SLOP = 6; // CSS px a press may travel and still count as a click

/**
 * Rebases probe records to seconds since capture start and derives clicks and drags (from press to
 * release; a right click is marked `button: 'right'`), typing, Shortcuts with their keys, and the
 * cursor shapes: each change as [t, keyword], starting with the one shown when Capture began.
 * `turned` lists when a press or key landed in a rotated, skewed or 3D-transformed iframe, placed as
 * if it were only scaled, and `unplaced` when one landed in a frame that could not be placed at all.
 */
export async function collectTimeline(page, startedAtMs) {
  const collector = collectors.get(page);
  if (!collector) throw new Error('The Timeline probe was never installed on this page');
  // Records a frame sent before this call arrive before its answer to an evaluate.
  await Promise.all(page.frames().map(frame => frame.evaluate(() => 0).catch(() => {})));
  while (collector.pending.size) await Promise.all(collector.pending);
  const raw = placeRecords(collector.records);
  const t = ms => Math.round(ms - startedAtMs) / 1000;
  const pointer = raw.pointer.filter(([ms]) => ms >= startedAtMs).map(([ms, x, y]) => [t(ms), x, y]);
  const events = [];
  for (const down of raw.downs.filter(d => d.ms >= startedAtMs)) {
    const up = raw.ups.find(u => u.ms >= down.ms && u.button === down.button);
    // Only the left button drags; a right click opens a context menu wherever it is released.
    const moved = down.button === 'left' && up && Math.hypot(up.x - down.x, up.y - down.y) > CLICK_SLOP;
    events.push(moved
      ? { type: 'drag', t: t(down.ms), end: t(up.ms), from: { x: down.x, y: down.y }, to: { x: up.x, y: up.y } }
      : { type: 'click', t: t(down.ms), end: t(up?.ms ?? down.ms), x: down.x, y: down.y, box: down.box, ...(down.button === 'right' && { button: 'right' }) });
  }
  // Consecutive keys into the same field within a second form one typing burst.
  const keys = raw.keys.filter(k => k.ms >= startedAtMs), typing = [];
  for (const key of keys) {
    const last = typing.at(-1);
    if (last && t(key.ms) - last.end <= 1 && JSON.stringify(last.box) === JSON.stringify(key.box)) last.end = t(key.ms);
    else typing.push({ type: 'type', t: t(key.ms), end: t(key.ms), box: key.box });
  }
  events.push(...typing);
  for (const key of keys) {
    const shown = shortcutKeys(key);
    if (shown) events.push({ type: 'shortcut', t: t(key.ms), keys: shown });
  }
  const before = raw.shapes.filter(([ms]) => ms < startedAtMs).at(-1);
  const shapes = [...(before ? [[0, before[1]]] : []), ...raw.shapes.filter(([ms]) => ms >= startedAtMs).map(([ms, shape]) => [t(ms), shape])];
  const times = list => [...new Set(list.filter(ms => ms >= startedAtMs).map(t))];
  return { pointer, shapes, events: events.sort((a, b) => a.t - b.t), turned: times(raw.turned), unplaced: times(raw.unplaced) };
}
