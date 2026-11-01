/**
 * Tabs, shared by Node and the render page. Pure functions, no imports.
 *
 * A Take shows one Tab or more: the start page and each page the demo opened (ADR 0008). A Tab the
 * size of the viewport is a tab of the same window; any other is a popup window over the Tab that
 * opened it. Each Tab's input is in its own CSS pixels; the window's are those of the viewport, which
 * the camera and the Cursor use.
 *
 * Tabs are the Timeline's `{ id, opener, opened, closed, viewport, start }`, times in Source seconds.
 */

/** Whether a Tab is drawn as a popup window rather than as a tab of the window. */
export const isPopup = (tab, viewport) => tab.viewport.width !== viewport.width || tab.viewport.height !== viewport.height;

/**
 * Where each Tab's CSS pixels sit in the window's, as `{ x, y, scale }` by Tab id. A popup's page is
 * centered over its opener's page and scaled down to fit it, unless the Edit's `placement` ([{ tab, x,
 * y }], in the opener's CSS pixels) names where; the popups it opened move with it.
 */
export function windowMaps(tabs, viewport, placement = []) {
  const byId = new Map(tabs.map(tab => [tab.id, tab])), maps = new Map();
  const mapOf = (tab, depth = 0) => {
    if (maps.has(tab.id)) return maps.get(tab.id);
    let map = { x: 0, y: 0, scale: 1 };
    const opener = byId.get(tab.opener);
    if (isPopup(tab, viewport) && opener && depth < 32) {
      const outer = mapOf(opener, depth + 1), room = opener.viewport, { width, height } = tab.viewport;
      const scale = Math.min(1, room.width / width, room.height / height);
      const placed = placement.find(p => p.tab === tab.id);
      const x = placed?.x ?? (room.width - width * scale) / 2, y = placed?.y ?? (room.height - height * scale) / 2;
      map = { x: outer.x + x * outer.scale, y: outer.y + y * outer.scale, scale: scale * outer.scale };
    }
    maps.set(tab.id, map);
    return map;
  };
  for (const tab of tabs) mapOf(tab);
  return maps;
}

/**
 * What the Final shows of the Tabs through the Take. `at(t)` lists, at Final time `t`, what to draw in
 * order, each as `{ tab, popup, opacity, scale }`: the tab the window shows (two while one fades into
 * the next), then each popup window over it, opener first. The window shows the Tab in front, or, while
 * a popup is in front, the tab beneath it; the popups between them show over it. `cuts` are the Final
 * times the window starts showing another tab, where the camera cuts to wide.
 *
 * Tabs switch in Source time (the Timeline's `front` events; the first Tab is in front until one) and
 * their transitions keep their pace in Final time: `style` is the Edit's `tabs`, whose `transition` is
 * 'cut' or `{ fade }` seconds, and whose `popupAnimation` (`{ duration, scale }`, or false) scales and
 * fades a popup window in as it comes to show and out as it goes.
 */
export function tabTrack({ tabs, events = [], viewport }, style, map) {
  const byId = new Map(tabs.map(tab => [tab.id, tab]));
  const popup = id => byId.has(id) && isPopup(byId.get(id), viewport);
  // The Tabs shown with `front` in front: the tab beneath it, then the popups up to it.
  const stackOf = front => {
    const chain = [front];
    for (let id = front; popup(id) && byId.has(byId.get(id).opener) && chain.length < 32;) chain.unshift(id = byId.get(id).opener);
    return chain;
  };
  const fronts = events.filter(event => event.type === 'front').toSorted((a, b) => a.t - b.t);
  const states = [{ t: 0, stack: stackOf(tabs[0]?.id ?? 0) }, ...fronts.map(event => ({ t: map.outputAt(event.t), stack: stackOf(event.tab) }))];
  // Each time the window shows another tab, with the one it showed before.
  const switches = states.flatMap((state, i) => i && state.stack[0] !== states[i - 1].stack[0] ? [{ t: state.t, before: states[i - 1].stack[0] }] : []);
  // Each popup's spans of the Final while it shows: [from, until), until Infinity while still showing.
  const spans = new Map();
  states.forEach((state, i) => {
    const until = states[i + 1]?.t ?? Infinity;
    for (const id of state.stack.slice(1)) {
      const list = spans.get(id) ?? [], last = list.at(-1);
      if (last && last.until === state.t) last.until = until; else list.push({ from: state.t, until });
      spans.set(id, list);
    }
  });
  const depth = id => stackOf(id).length;
  const fade = typeof style?.transition === 'object' ? style.transition.fade ?? 0 : 0;
  const animation = style?.popupAnimation || null, duration = animation?.duration ?? 0, smallest = animation?.scale ?? 1;
  return {
    cuts: switches.map(({ t }) => t),
    at(t) {
      const k = states.findLastIndex(state => state.t <= t), shown = [];
      const switched = switches.findLast(({ t: at }) => at <= t);
      if (fade > 0 && switched && t - switched.t < fade) {
        shown.push({ tab: switched.before, popup: false, opacity: 1, scale: 1 }, { tab: states[k].stack[0], popup: false, opacity: (t - switched.t) / fade, scale: 1 });
      } else shown.push({ tab: states[k].stack[0], popup: false, opacity: 1, scale: 1 });
      const popups = [];
      for (const [id, list] of spans) for (const { from, until } of list) {
        const progress = duration > 0 ? Math.min(1, (t - from) / duration, (until + duration - t) / duration) : t < until ? 1 : 0;
        if (t >= from && progress > 0) popups.push({ tab: id, popup: true, opacity: progress, scale: smallest + (1 - smallest) * progress, from });
      }
      popups.sort((a, b) => depth(a.tab) - depth(b.tab) || a.from - b.from);
      return [...shown, ...popups.map(({ from, ...drawn }) => drawn)];
    },
  };
}

/**
 * The Timeline's pointer path and events, and the camera's targets, moved from each Tab's CSS pixels
 * to the window's by `maps` (windowMaps). A sample or item without a `tab` is the first Tab's.
 */
export function inWindow({ pointer = [], events = [] }, targets = [], maps) {
  const mapOf = tab => maps.get(tab ?? 0) ?? { x: 0, y: 0, scale: 1 };
  const point = (m, p) => p && { ...p, x: m.x + p.x * m.scale, y: m.y + p.y * m.scale };
  const box = (m, b) => b && { x: m.x + b.x * m.scale, y: m.y + b.y * m.scale, width: b.width * m.scale, height: b.height * m.scale };
  const placed = item => {
    const m = mapOf(item.tab), moved = { ...item };
    if (typeof item.x === 'number') Object.assign(moved, point(m, { x: item.x, y: item.y }));
    for (const key of ['from', 'to']) if (item[key]) moved[key] = point(m, item[key]);
    if (item.box) moved.box = box(m, item.box);
    return moved;
  };
  return {
    pointer: pointer.map(([t, x, y, tab]) => { const m = mapOf(tab); return [t, m.x + x * m.scale, m.y + y * m.scale]; }),
    events: events.map(placed),
    targets: targets.map(placed),
  };
}

/** A point in one Tab's CSS pixels as it sits in another's, through the window (`maps`: windowMaps). */
export function carried(point, from, to, maps) {
  const a = maps.get(from), b = maps.get(to);
  return { x: (a.x + point.x * a.scale - b.x) / b.scale, y: (a.y + point.y * a.scale - b.y) / b.scale };
}

/** Whether a Tab's page sees the pointer at `point`, which it does only over its viewport. */
export const seenBy = (point, viewport) => point.x >= 0 && point.y >= 0 && point.x < viewport.width && point.y < viewport.height;
