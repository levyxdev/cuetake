/**
 * Motion blur, shared by Node and the render page. Pure functions, no imports.
 *
 * Each output frame of the Final is exposed over the last `shutter` of its time, a fraction of a frame
 * like a film camera's shutter: Render composes the moving parts of the frame at several moments of
 * that exposure and averages them. Times are Final seconds.
 */

/** The shutter Render uses for the Edit's `output.shutter`: between 0 and 1, and 0 for anything that is not a number. */
export const shutterOf = shutter => typeof shutter === 'number' && shutter > 0 ? Math.min(1, shutter) : 0;

/**
 * The exposure of the frame at Final time `t`, as { start, end }, or null where the frame shows one
 * sharp instant: with no shutter, on the first frame, and on a frame the camera cuts on, since `cuts`
 * jump the camera and the Tab shown.
 */
export function exposure(t, fps, shutter, cuts = []) {
  const frame = 1 / fps;
  if (!shutterOf(shutter) || t < frame - 1e-9 || cuts.some(cut => cut > t - frame + 1e-9 && cut <= t + 1e-9)) return null;
  return { start: t - shutterOf(shutter) * frame, end: t };
}

/** The camera's crop at Final time `t`, part way between the crops of the frames on either side (`crops` has one per frame). */
export function cropAt(crops, fps, t) {
  const at = Math.max(0, Math.min(crops.length - 1, t * fps)), nearest = Math.round(at);
  if (Math.abs(at - nearest) < 1e-6) return crops[nearest];
  const low = Math.floor(at), a = crops[low], b = crops[low + 1], u = at - low;
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, w: a.w + (b.w - a.w) * u, h: a.h + (b.h - a.h) * u };
}

const MAX_MOMENTS = 16;

/**
 * The moments a frame at `t` averages for content that moves `distance` output pixels on screen over
 * its exposure `span`: evenly spaced, at most `step` pixels of movement apart, ending on `t` itself. A
 * frame without an exposure, or whose content moves less than a step, shows the one moment `t`.
 */
export function moments(t, span, distance, step) {
  if (!span || !(distance >= step)) return [t];
  const count = Math.min(MAX_MOMENTS, Math.ceil(distance / step) + 1);
  return Array.from({ length: count }, (_, i) => i === count - 1 ? t : span.start + (span.end - span.start) * i / (count - 1));
}
