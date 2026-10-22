/**
 * Cursor and click-effect state at a moment of a Take, derived from the Timeline.
 * Pure functions shared by Node and the render page; CSS pixels and seconds throughout.
 */

/** The pointer position at `t`, interpolated between samples; null before the first sample. */
export function pointerAt(pointer, t) {
  if (!pointer.length || t < pointer[0][0]) return null;
  let low = 0, high = pointer.length - 1;
  while (low < high) { const mid = (low + high + 1) >> 1; if (pointer[mid][0] <= t) low = mid; else high = mid - 1; }
  const [t0, x0, y0] = pointer[low], next = pointer[low + 1];
  if (!next || next[0] === t0) return { x: x0, y: y0 };
  const k = (t - t0) / (next[0] - t0);
  return { x: x0 + (next[1] - x0) * k, y: y0 + (next[2] - y0) * k };
}

/** Presses that spark: clicks at their point, drags where they start. */
export function presses(events) {
  return events.flatMap(event => event.type === 'click' ? [{ t: event.t, x: event.x, y: event.y }]
    : event.type === 'drag' ? [{ t: event.t, ...event.from }] : []);
}

/** Click effects alive at `t`, each with its progress from 0 to 1; `clickEffect: false` shows none. */
export function sparksAt(pressList, clickEffect, t) {
  if (!clickEffect) return [];
  const life = (clickEffect.duration ?? 400) / 1000;
  return pressList.filter(p => t >= p.t && t < p.t + life).map(p => ({ x: p.x, y: p.y, progress: (t - p.t) / life }));
}
