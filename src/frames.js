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
    let box = await handle.evaluate(e => e.getClientRects().length ? e.getBoundingClientRect().toJSON() : null);
    for (let frame = await handle.ownerFrame(); box && frame?.parentFrame(); frame = frame.parentFrame()) {
      const element = await frame.frameElement();
      const content = await element.evaluate(contentOf).finally(() => element.dispose());
      box = { x: content.x + box.x * content.sx, y: content.y + box.y * content.sy, width: box.width * content.sx, height: box.height * content.sy };
    }
    return box && { x: box.x, y: box.y, width: box.width, height: box.height };
  } finally { await handle.dispose(); }
}
