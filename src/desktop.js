/**
 * The Desktop of a Take of Apps (ADR 0009), shared by Node and the render page. Pure functions, no imports.
 *
 * The Source shows the Desktop: the Take's App windows where they are, on nothing. The Timeline's
 * `windows` lists which show over time, each state `{ t, shown }` lasting until the next, `shown` back
 * to front as `{ id, layer, x, y, width, height, radius }` in Desktop points from its top-left corner,
 * which play the role of CSS pixels. Render draws the Source only inside these windows, so the
 * Background shows between them.
 */

/** The windows showing at Source time `t`, back to front. */
export function windowsAt(windows, t) {
  return (windows ?? []).findLast(state => state.t <= t)?.shown ?? windows?.[0]?.shown ?? [];
}

/**
 * Where `shown` windows are drawn: each clipped to the Desktop (`viewport`, in points), then placed on
 * `page`, the Desktop's rectangle in stage pixels, with its corner radius in stage pixels. A window
 * wholly outside the Desktop is left out. Only a window over no other window drawn under it has the
 * window `effects` (its shadow) around it: the Source already shows the shadow a menu, a sheet or a
 * control's own window casts on the window below.
 */
export function drawnWindows(shown, viewport, page) {
  const scale = page.w / viewport.width, drawn = [];
  for (const { id, x, y, width, height, radius } of shown) {
    const left = Math.max(0, x), top = Math.max(0, y), right = Math.min(viewport.width, x + width), bottom = Math.min(viewport.height, y + height);
    if (right <= left || bottom <= top) continue;
    const w = right - left, h = bottom - top, window = { x: page.x + left * scale, y: page.y + top * scale, w: w * scale, h: h * scale };
    const over = drawn.some(({ window: under }) => window.x >= under.x && window.y >= under.y && window.x + window.w <= under.x + under.w && window.y + window.h <= under.y + under.h);
    drawn.push({ id, window, radius: Math.min(radius, w / 2, h / 2) * scale, effects: !over });
  }
  return drawn;
}

// How long macOS animates a window closing: TextEdit's shrank for about 70 ms.
const CLOSING_S = 0.3;
const at = t => `${t.toFixed(2)} s`;
const size = w => `${w.width}×${w.height}`;
const inside = (w, viewport) => w.x >= 0 && w.y >= 0 && w.x + w.width <= viewport.width && w.y + w.height <= viewport.height;

/**
 * What a Final of Apps shows other than as recorded: the App's first window (the largest at the start)
 * not filling the Desktop, or moving or resizing later; any other window reaching outside the Desktop,
 * which is cut off there; a Desktop recorded at scale 1 or across a change of scale; and frames the
 * encoder dropped. `capture` is the Tab's stats in capture.json.
 */
export function desktopWarnings({ viewport, windows = [] }, { frames = [], dropped = 0 }) {
  // The first window is the largest of the first layer-0 windows to show: a dialog may show before it.
  const layer0 = state => state.shown.filter(w => w.layer === 0);
  const warnings = [], first = layer0(windows.find(state => layer0(state).length) ?? { shown: [] }).sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const same = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  if (first && !same(first, { x: 0, y: 0, ...viewport })) warnings.push(`The App's first window is ${size(first)} points, not the Desktop's ${size(viewport)}, so the Background shows around it: the App may limit its size; choose a viewport it can fill.`);
  // A closing window shrinks for a moment before it goes; a change it leaves within CLOSING_S of is that, not a move.
  const showsFirst = state => state.shown.some(w => w.id === first.id);
  const closing = state => windows.some(later => later.t > state.t && later.t - state.t <= CLOSING_S && !showsFirst(later));
  const moved = first && windows.find(state => state.shown.some(w => w.id === first.id && !same(w, first)) && !closing(state));
  if (moved) {
    const w = moved.shown.find(w => w.id === first.id);
    warnings.push(`At ${at(moved.t)} the App's first window moved or resized, to ${w.x}, ${w.y}, ${size(w)} points; Render does not correct it, so leave it where the Take put it.`);
  }
  const reported = new Set([first?.id]);
  for (const state of windows) for (const w of state.shown) {
    if (reported.has(w.id) || inside(w, viewport)) continue;
    reported.add(w.id);
    warnings.push(`At ${at(state.t)} a window of the App (${size(w)} points) reached outside the Desktop, so the Final shows it cut off.`);
  }
  const scales = new Set(frames.map(frame => frame.scale));
  if (scales.has(1)) warnings.push('The Desktop was recorded at scale 1, so the Final is half as sharp; record on a Retina display.');
  if (scales.size > 1) warnings.push(`The Desktop's scale changed during the Take (${[...scales].join(', ')}), as when a window moves to another display; record again with the App on one display.`);
  if (dropped) warnings.push(`The encoder could not keep up and ${dropped} frames were dropped from the Source; close other work and record again.`);
  return warnings;
}
