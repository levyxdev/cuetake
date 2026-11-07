/**
 * Where an iframe's content starts in its parent's viewport, in CSS pixels, and how much it is scaled:
 * inside its border and padding, after scrolling, positioning and transforms. It runs in the page, in
 * the iframe's parent document, so it works for a cross-origin iframe too. A rotated or skewed iframe
 * gets the scale of its bounding box, which is only near.
 */
export function contentOf(element) {
  const r = element.getBoundingClientRect(), style = getComputedStyle(element);
  const sx = element.offsetWidth ? r.width / element.offsetWidth : 1, sy = element.offsetHeight ? r.height / element.offsetHeight : 1;
  return { x: r.x + (element.clientLeft + parseFloat(style.paddingLeft)) * sx, y: r.y + (element.clientTop + parseFloat(style.paddingTop)) * sy, sx, sy };
}

/**
 * A located element's border box in top-level CSS pixels, mapped up through every iframe it is in, or
 * null when it shows no box. Playwright's own boundingBox places an element in a cross-origin iframe
 * from the iframe's outer edge, unscaled, so it misses the iframe's border, padding and scale.
 */
export async function boxOnPage(locator) {
  const handle = await locator.elementHandle();
  try {
    const box = await handle.evaluate(e => e.getClientRects().length ? e.getBoundingClientRect().toJSON() : null);
    return box && onPage(await placeOf(await handle.ownerFrame()), box);
  } finally { await handle.dispose(); }
}

/**
 * Where a frame's viewport shows in top-level CSS pixels: the offset of its origin and its scale,
 * through every iframe it is in. The top frame's is { x: 0, y: 0, sx: 1, sy: 1 }.
 */
export async function placeOf(frame) {
  let map = { x: 0, y: 0, sx: 1, sy: 1 };
  for (let f = frame; f?.parentFrame(); f = f.parentFrame()) {
    const element = await f.frameElement();
    const content = await element.evaluate(contentOf).finally(() => element.dispose());
    map = { x: content.x + map.x * content.sx, y: content.y + map.y * content.sy, sx: map.sx * content.sx, sy: map.sy * content.sy };
  }
  return map;
}

/** A box in a frame's CSS pixels placed in top-level CSS pixels by the frame's `map` (placeOf). */
export const onPage = (map, box) => ({ x: map.x + box.x * map.sx, y: map.y + box.y * map.sy, width: box.width * map.sx, height: box.height * map.sy });
