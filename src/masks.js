/**
 * Masks, shared by Node and the render page. Pure functions, no imports.
 *
 * A Mask hides or points at a region of a Tab's page for a span of the Take: `blur` blurs it past
 * reading, `cover` fills it with a solid color, and `spotlight` dims everything outside it. A mask
 * names either a fixed `box` in its Tab's CSS pixels, or an `element`: one of the Timeline's
 * `elements`, whose boxes Capture recorded over time. Its `start` and `end` are Source seconds; without
 * them it runs from the start or to the end of the Take. Masks sit on the page under the camera.
 */

/**
 * Each effect's parameters: `padding`, `radius` (corner), `blur` and `feather` (how far the light
 * falls off across the region's edge) in CSS px; `color` as '#rrggbb'; `dim`, the share of light taken
 * from the rest of the frame; `ease` in Final seconds.
 */
export const MASK_EFFECTS = {
  blur: { blur: 16, padding: 4, radius: 6 },
  cover: { color: '#000000', padding: 4, radius: 6 },
  spotlight: { dim: 0.6, padding: 8, radius: 10, feather: 16, ease: 0.3 },
};

/** The effects, as messages list them: "blur, cover or spotlight". */
export const EFFECT_NAMES = Object.keys(MASK_EFFECTS).join(', ').replace(/, (\w+)$/, ' or $1');

// Seconds before and after a moment whose boxes a blur or cover also hides. Tab capture shows a
// change tens of milliseconds after the page made it, more on a busy machine, so the Source can still
// show an element where it was after its box has moved. Capture sees an element the page replaced
// elsewhere, or one in a new document, only when the Director next watches it (director.js).
const SLACK = { before: 0.2, after: 0.25 };

/** Below this many CSS px, a blur leaves body text readable. */
const LEAST_BLUR = 8;

const isColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const isBox = box => box && ['x', 'y', 'width', 'height'].every(key => typeof box[key] === 'number' && Number.isFinite(box[key])) && box.width > 0 && box.height > 0;

/** A mask as messages name it, such as "Mask 2 (blur from 1.20 s)". */
const nameOf = (mask, i) => `Mask ${i} (${mask.effect}${typeof mask.start === 'number' ? ` from ${mask.start.toFixed(2)} s` : ''})`;

/**
 * What stops Render from masking as the Edit asks, each naming its mask: an unknown effect, a mask
 * with neither or both of a box and an element the Timeline recorded (`elements`), a box on a Tab the
 * Take does not show (`tabs`, their ids, when given), an empty span, a color that is not '#rrggbb', or
 * a blur too weak to hide text. A mask Render cannot draw would show what it hides, so any of these stops it.
 */
export function maskProblems(masks = [], elements = [], tabs = null) {
  if (!Array.isArray(masks)) return ['masks must be a list of masks'];
  const ids = new Set(elements.map(element => element.id));
  return masks.flatMap((mask, i) => {
    if (!(mask?.effect in MASK_EFFECTS)) return [`Mask ${i} has effect '${mask?.effect}'; use ${EFFECT_NAMES}`];
    const name = nameOf(mask, i), problems = [];
    if (mask.element !== undefined && mask.box !== undefined) problems.push(`${name} names both a box and an element; keep one`);
    else if (mask.element !== undefined) { if (!ids.has(mask.element)) problems.push(`${name} follows element ${mask.element}, which the Timeline does not record`); }
    else if (!isBox(mask.box)) problems.push(`${name} needs a box { x, y, width, height } in CSS pixels, or the element a Scenario masked`);
    else if (tabs && !tabs.includes(mask.tab ?? 0)) problems.push(`${name} is on Tab ${mask.tab}, which the Take does not show; its Tabs are ${tabs.join(', ')}`);
    if (mask.color !== undefined && !isColor(mask.color)) problems.push(`${name} has color '${mask.color}'; use '#rrggbb'`);
    const { start = 0, end = Infinity } = mask;
    if (!(typeof start === 'number' && typeof end === 'number' && end > start)) problems.push(`${name} needs a start before its end, in seconds`);
    const blur = mask.blur ?? MASK_EFFECTS.blur.blur;
    if (mask.effect === 'blur' && !(blur >= LEAST_BLUR)) problems.push(`${name} blurs ${blur} CSS px, too little to hide text; use at least ${LEAST_BLUR}`);
    return problems;
  });
}

const padded = ({ x, y, width, height }, p) => ({ x: x - p, y: y - p, width: width + 2 * p, height: height + 2 * p });
const rectOf = ([x, y, width, height]) => ({ x, y, width, height });

/** The index of the last sample at or before Source time `s`, or the first: a box holds until the next one, and back to the start. */
function heldAt(boxes, s) {
  let low = 0, high = boxes.length - 1, found = 0;
  while (low <= high) { const mid = (low + high) >> 1; if (boxes[mid][0] <= s) { found = mid; low = mid + 1; } else high = mid - 1; }
  return found;
}

/**
 * An element's boxes at Source time `s`, as rects: those it held then, or with `slack`, every box it
 * held from `slack.before` seconds before to `slack.after` after. A sample `[t, ...boxes]` lists each
 * element the locator matched, as [x, y, width, height]; one without boxes means none showed.
 */
export function elementBoxesAt(boxes, s, slack = { before: 0, after: 0 }) {
  if (!boxes?.length) return [];
  const from = heldAt(boxes, s - slack.before), to = heldAt(boxes, s + slack.after), seen = new Set(), rects = [];
  for (const sample of boxes.slice(from, to + 1)) for (const box of sample.slice(1)) {
    const key = box.join();
    if (!seen.has(key)) { seen.add(key); rects.push(rectOf(box)); }
  }
  return rects;
}

/**
 * The masks through the Final: `at(t)` lists those showing at Final time `t`, each with its index in
 * `masks`, its Tab, its effect and parameters, its `opacity` and its `rects`, padded, in its Tab's CSS
 * pixels. `map` is the Take's time map (time-map.js).
 */
export function maskTrack(masks = [], elements = [], map) {
  const byId = new Map(elements.map(element => [element.id, element]));
  const placed = masks.map((mask, index) => {
    const { effect, box, element: id, start = 0, end = Infinity, tab = 0, ...rest } = mask;
    const params = { ...MASK_EFFECTS[effect], ...rest }, element = byId.get(id), slack = effect === 'spotlight' ? undefined : SLACK;
    const rects = element ? s => elementBoxesAt(element.boxes, s, slack) : () => [box];
    return { index, tab: element ? element.tab : tab, effect, params, from: map.outputAt(start), until: end === Infinity ? map.duration : map.outputAt(end), rects };
  });
  return {
    at(t) {
      const s = map.sourceAt(t);
      // A spotlight eases in after its start and out before its end, in Final time; a blur or cover is whole at once.
      const opacity = ({ effect, params: { ease }, from, until }) => effect !== 'spotlight' || !(ease > 0) ? 1 : Math.max(0, Math.min(1, (t - from) / ease, (until - t) / ease));
      return placed.filter(mask => t >= mask.from && t < mask.until).map(({ index, tab, effect, params, rects, ...mask }) => ({
        index, tab, effect, opacity: opacity({ effect, params, ...mask }), rects: rects(s).map(r => padded(r, params.padding)), ...params,
      })).filter(mask => mask.rects.length);
    },
  };
}

/**
 * At most `n` of `items` (each `{ rect, ... }`), the rest merged: past `n`, they become one item, the
 * first of them with a rect around them all, so a box that does not fit one pass is hidden more widely, never shown.
 */
export function mergedPast(items, n) {
  if (items.length <= n) return items;
  const rest = items.slice(n - 1);
  const left = Math.min(...rest.map(({ rect }) => rect.x)), top = Math.min(...rest.map(({ rect }) => rect.y));
  const right = Math.max(...rest.map(({ rect }) => rect.x + rect.width)), bottom = Math.max(...rest.map(({ rect }) => rect.y + rect.height));
  return [...items.slice(0, n - 1), { ...rest[0], rect: { x: left, y: top, width: right - left, height: bottom - top } }];
}

/**
 * Warnings for masks that drew nothing: each that follows an element its locator never matched on the
 * page during its span, which usually means a locator that misses or a span before the element shows.
 */
export function maskWarnings(masks = [], elements = []) {
  const byId = new Map(elements.map(element => [element.id, element]));
  return masks.flatMap((mask, i) => {
    const element = byId.get(mask.element);
    if (!element) return [];
    const { start = 0, end = Infinity } = mask, { boxes } = element;
    const seen = boxes.length && (boxes[heldAt(boxes, start)].length > 1 || boxes.some(([t, ...shown]) => t > start && t < end && shown.length));
    return seen ? [] : [`${nameOf(mask, i)} found no ${element.name} on the page during its span, so it drew nothing; check the locator, or when the element shows`];
  });
}
