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

/** Sparks alive at `t`, each with its progress from 0 to 1. */
export function sparksAt(pressList, clickEffect, t) {
  if (clickEffect.style === 'none') return [];
  const life = clickEffect.duration / 1000;
  return pressList.filter(p => t >= p.t && t < p.t + life).map(p => ({ x: p.x, y: p.y, progress: (t - p.t) / life }));
}

/** Arrow outline in its 28×36 design box; the hotspot is the tip at (2, 2). */
export const ARROW_PATH = 'M2 2 L2 27 L8.5 21 L14 33 L19 30.5 L13.5 19 L23 19 Z';

/** Cursor sprite geometry in CSS pixels: drawn size and the hotspot offset from its top-left. */
export function cursorGeometry(cursor) {
  return cursor.style === 'arrow'
    ? { width: cursor.size, height: cursor.size * 36 / 28, hotspot: { x: cursor.size * 2 / 28, y: cursor.size * 2 / 28 } }
    : { width: cursor.size, height: cursor.size, hotspot: { x: cursor.size / 2, y: cursor.size / 2 } };
}

/** Draws one spark centered in a 2D context whose unit is one CSS pixel. */
export function drawSpark(ctx, x, y, progress, clickEffect, color) {
  const eased = 1 - (1 - progress) ** 3;
  const distance = 5 + eased * clickEffect.radius;
  const length = clickEffect.length * (1 - eased);
  ctx.globalAlpha = 1 - progress;
  ctx.lineCap = 'round';
  for (let i = 0; i < clickEffect.count; i++) {
    const angle = 2 * Math.PI * i / clickEffect.count + Math.PI / 8;
    ctx.beginPath();
    ctx.moveTo(x + distance * Math.cos(angle), y + distance * Math.sin(angle));
    ctx.lineTo(x + (distance + length) * Math.cos(angle), y + (distance + length) * Math.sin(angle));
    // A dark edge under a cursor-colored core stays legible on light and dark pages.
    ctx.strokeStyle = '#171717'; ctx.lineWidth = 4.5; ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
