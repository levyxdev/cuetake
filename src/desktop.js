/**
 * The Desktop of a Take of Apps (ADR 0009), shared by Node and the render page. Pure functions, no imports.
 *
 * The Source shows the Desktop: the windows of the Take's Apps where they are, in their real order, on
 * nothing. The Timeline's `windows` lists which show over time, each state `{ t, shown }` lasting until
 * the next, `shown` back to front as `{ id, app, layer, x, y, width, height, radius }` (`app` indexes
 * the Timeline's `apps`) in Desktop points from its top-left corner,
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

// The narrowest empty stretch of a title bar a person would aim a click at, in points.
const TITLE_BAR_MIN = 12;

/**
 * Where to click a window's title bar to bring it in front, as a person would: the middle of the widest
 * stretch where nothing lies, no control, no title and no window over it, from `bar`, the helper's
 * samples along the title bar's middle (`{ y, samples: [[x, empty], ...] }`, Desktop points, left to
 * right). Returns `{ x, y, width }`, the stretch's width as the target's size, or null where no stretch
 * is wide enough.
 */
export function titleBarSpot(bar) {
  let best = null, from = null;
  const samples = bar?.samples ?? [];
  samples.forEach(([x, empty], i) => {
    if (empty && from === null) from = x;
    const last = empty && (i === samples.length - 1 || !samples[i + 1][1]);
    if (last && (!best || x - from > best.width)) best = { from, width: x - from };
    if (!empty) from = null;
  });
  if (!best || best.width < TITLE_BAR_MIN) return null;
  return { x: best.from + best.width / 2, y: bar.y, width: best.width };
}

// How long macOS animates a window closing: TextEdit's shrank for about 70 ms.
const CLOSING_S = 0.3;
const at = t => `${t.toFixed(2)} s`;
const size = w => `${w.width}×${w.height}`;
const inside = (w, viewport) => w.x >= 0 && w.y >= 0 && w.x + w.width <= viewport.width && w.y + w.height <= viewport.height;

const OTHER_INPUT = { pointer: 'the pointer', key: 'a key', scroll: 'a scroll' };
const listed = times => times.slice(0, 5).map(at).join(', ') + (times.length > 5 ? ` and ${times.length - 5} more` : '');

/**
 * What a Final of Apps shows other than as recorded: the first App's first window (the largest at the
 * start) not filling the Desktop, when the Take has one App (with several, `prepare` arranges them), or
 * moving or resizing later; any other window reaching outside the Desktop, which is cut off there; a
 * Desktop recorded at scale 1 or across a change of scale; frames the encoder dropped; and input the
 * Director did not make (`otherInput`, as [t, kind]), which the Timeline leaves out but the App may have
 * reacted to. `capture` is the Tab's stats in capture.json.
 */
export function desktopWarnings({ viewport, windows = [], duration = Infinity, apps = [] }, { frames = [], dropped = 0, otherInput = [] }) {
  // The first window is the largest of the first App's first layer-0 windows to show: a dialog may show before it.
  const layer0 = state => state.shown.filter(w => w.layer === 0 && !w.app);
  const several = apps.length > 1, ofApp = w => several ? apps[w.app ?? 0]?.name ?? 'an App' : 'the App';
  const warnings = [], first = layer0(windows.find(state => layer0(state).length) ?? { shown: [] }).sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const same = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  if (first && !several && !same(first, { x: 0, y: 0, ...viewport })) warnings.push(`The App's first window is ${size(first)} points, not the Desktop's ${size(viewport)}, so the Background shows around it: the App may limit its size; choose a viewport it can fill.`);
  // A closing window shrinks for a moment before it goes; a change it leaves within CLOSING_S of is that, not a move,
  // and so is one within CLOSING_S of the Take's end, which may come before the window goes.
  const showsFirst = state => state.shown.some(w => w.id === first.id);
  const closing = state => duration - state.t <= CLOSING_S || windows.some(later => later.t > state.t && later.t - state.t <= CLOSING_S && !showsFirst(later));
  const moved = first && windows.find(state => state.shown.some(w => w.id === first.id && !same(w, first)) && !closing(state));
  if (moved) {
    const w = moved.shown.find(w => w.id === first.id);
    warnings.push(`At ${at(moved.t)} ${several ? `the first window of ${ofApp(w)}` : "the App's first window"} moved or resized, to ${w.x}, ${w.y}, ${size(w)} points; Render does not correct it, so leave it where the Take put it.`);
  }
  const reported = new Set([first?.id]);
  for (const state of windows) for (const w of state.shown) {
    if (reported.has(w.id) || inside(w, viewport)) continue;
    reported.add(w.id);
    warnings.push(`At ${at(state.t)} a window of ${ofApp(w)} (${size(w)} points) reached outside the Desktop, so the Final shows it cut off.`);
  }
  const scales = new Set(frames.map(frame => frame.scale));
  if (scales.has(1)) warnings.push('The Desktop was recorded at scale 1, so the Final is half as sharp; record on a Retina display.');
  if (scales.size > 1) warnings.push(`The Desktop's scale changed during the Take (${[...scales].join(', ')}), as when a window moves to another display; record again with the App on one display.`);
  if (otherInput.length) {
    const kinds = Object.keys(OTHER_INPUT).filter(kind => otherInput.some(([, k]) => k === kind));
    const what = kinds.map(kind => `${OTHER_INPUT[kind]} at ${listed(otherInput.filter(([, k]) => k === kind).map(([t]) => t))}`).join('; ');
    warnings.push(`Someone used the Mac during the Take: ${what}. The Final's Cursor follows only the Scenario, but the App may have reacted; check those moments with frame, or record again and leave the Mac alone.`);
  }
  if (dropped) warnings.push(`The encoder could not keep up and ${dropped} frames were dropped from the Source; close other work and record again.`);
  return warnings;
}
