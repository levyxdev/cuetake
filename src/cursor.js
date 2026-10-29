/**
 * Cursor and click-effect state at a moment of a Take, derived from the Timeline.
 * Pure functions shared by Node and the render page; CSS pixels and seconds throughout.
 */

const PRESS_IN = 0.08, PRESS_OUT = 0.3; // seconds to shrink when a button goes down and to spring back after it is released
const FADE = 0.3; // seconds the idle Cursor takes to fade out, and to fade back in before it moves
const MOVED = 0.5; // CSS px a pointer sample must differ from the one before to count as a move
const STEP = 0.05; // seconds before a moved sample that the move shows, however long the pointer rested before it

/** The index of the last entry of `list` (sorted by `time(entry)`) at or before `t`, or -1. */
function lastAt(list, t, time) {
  let low = 0, high = list.length - 1, found = -1;
  while (low <= high) { const mid = (low + high) >> 1; if (time(list[mid]) <= t) { found = mid; low = mid + 1; } else high = mid - 1; }
  return found;
}

/** The pointer position at `t`, interpolated between samples; null before the first sample. */
export function pointerAt(pointer, t) {
  const low = lastAt(pointer, t, sample => sample[0]);
  if (low < 0) return null;
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

/** When a button is held: each click and drag from press to release. */
export const heldSpans = events => events.filter(event => event.type === 'click' || event.type === 'drag').map(event => ({ t: event.t, end: event.end ?? event.t }));

const easeOut = u => 1 - (1 - u) ** 3;
const springBack = u => { const c = 1.70158; return 1 + (c + 1) * (u - 1) ** 3 + c * (u - 1) ** 2; };

/** The Cursor's scale at `t`: down to `press` while a button is held, springing back after; `press: false` keeps 1. */
export function pressScale(spans, press, t) {
  if (typeof press !== 'number') return 1;
  const span = spans[lastAt(spans, t, s => s.t)];
  if (!span) return 1;
  const down = held => 1 - (1 - press) * easeOut(Math.min(1, held / PRESS_IN));
  if (t <= span.end) return down(t - span.t);
  const u = (t - span.end) / PRESS_OUT, from = down(span.end - span.t);
  return u >= 1 ? 1 : from + (1 - from) * springBack(u);
}

/** Times the Cursor shows activity: its first sample, the start and end of each move, and each press and release. */
export function activityTimes(pointer, spans) {
  const moves = pointer.flatMap(([t, x, y], i) => {
    if (i === 0) return [t];
    const [t0, x0, y0] = pointer[i - 1];
    return Math.hypot(x - x0, y - y0) > MOVED ? [Math.max(t0, t - STEP), t] : [];
  });
  return [...moves, ...spans.flatMap(s => [s.t, s.end])].sort((a, b) => a - b);
}

/**
 * The Cursor's opacity at `t`: it fades out once it has been still `hideAfter` seconds, and fades back
 * in to be fully shown when it next moves; `hideAfter: false` keeps it shown.
 */
export function idleOpacity(activity, hideAfter, t) {
  if (typeof hideAfter !== 'number' || !activity.length) return 1;
  const i = lastAt(activity, t, time => time), last = activity[i], next = activity[i + 1];
  const fading = i < 0 ? 0 : 1 - (t - last - hideAfter) / FADE;
  const returning = next === undefined ? 0 : 1 - (next - t) / FADE;
  return Math.min(1, Math.max(0, fading, returning));
}

/** The cursor shape the page asked for at `t`, as a CSS keyword; `default` before the first. */
export function shapeAt(shapes, t) {
  return shapes[lastAt(shapes, t, entry => entry[0])]?.[1] ?? 'default';
}

// Keywords that name the same picture as one a cursor is more likely to draw.
const ALIASES = {
  progress: 'wait', 'all-scroll': 'move', 'no-drop': 'not-allowed',
  'col-resize': 'ew-resize', 'e-resize': 'ew-resize', 'w-resize': 'ew-resize',
  'row-resize': 'ns-resize', 'n-resize': 'ns-resize', 's-resize': 'ns-resize',
  'ne-resize': 'nesw-resize', 'sw-resize': 'nesw-resize', 'nw-resize': 'nwse-resize', 'se-resize': 'nwse-resize',
};

/** The shape a cursor drawing `drawn` (a Set of names) shows for `keyword`: itself, its alias, or `default`. */
export const drawnShape = (keyword, drawn) => drawn.has(keyword) ? keyword : drawn.has(ALIASES[keyword]) ? ALIASES[keyword] : 'default';

/**
 * The Cursor through a Take: `at(t)` gives its point, scale, opacity and the shape the page asked for,
 * or null before the first pointer sample. `cursor` is the Edit's cursor item.
 */
export function cursorTrack({ pointer, shapes = [], events }, cursor) {
  const spans = heldSpans(events), activity = activityTimes(pointer, spans);
  return {
    at(t) {
      const point = pointerAt(pointer, t);
      if (!point) return null;
      return { ...point, scale: pressScale(spans, cursor.press, t), opacity: idleOpacity(activity, cursor.hideAfter, t), shape: shapeAt(shapes, t) };
    },
  };
}
