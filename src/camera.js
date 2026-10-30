/**
 * Camera math shared by Node and the render page. Pure functions, no imports.
 *
 * Modeled on Screen Studio's auto zoom: zooms come from actions; actions close together form one
 * zoom segment, held at one zoom, that moves between them and follows the cursor only as far as they
 * need to stay in view; the camera moves on critically damped springs, so it eases in, never
 * overshoots and settles quickly enough to keep text readable. Because
 * the whole Timeline is known in advance, the camera starts moving `lead` seconds before each
 * action and every Final ends on the wide shot.
 *
 * Everything here is in CSS pixels of the captured viewport and seconds since capture start.
 */

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const SAFE_AREA = 0.8; // while zoomed, the cursor stays within this central fraction of the view

/** The zoom that frames `box` with `padding` on every side, between 1 and `maxZoom`. */
export function fitZoom(box, viewport, { maxZoom, padding }) {
  return clamp(Math.min(viewport.width / (box.width + 2 * padding), viewport.height / (box.height + 2 * padding)), 1, maxZoom);
}

/** The viewport crop centered on (x, y) at `zoom`, kept inside the viewport. */
export function cropAround(x, y, zoom, viewport) {
  zoom = Math.max(1, zoom);
  const w = viewport.width / zoom, h = viewport.height / zoom;
  return { x: clamp(x - w / 2, 0, viewport.width - w), y: clamp(y - h / 2, 0, viewport.height - h), w, h };
}

/**
 * Zoom segments: each target wants the camera from `lead` before it until `hold` after it (or after
 * its typing ends); targets whose windows touch or sit within `chainGap` share one segment. Segments
 * stop `endWide` before the Final ends, and targets that would barely zoom (below `minZoom`) stay wide.
 * A segment's zoom is the closest that fits all its targets, so the camera never zooms within one.
 */
export function zoomSegments(targets, viewport, camera, duration) {
  const { lead, hold, chainGap, minZoom, endWide } = camera;
  const last = duration - endWide;
  const segments = [];
  for (const target of targets.toSorted((a, b) => a.t - b.t)) {
    const zoom = target.zoom ?? fitZoom(target.box, viewport, camera);
    if (zoom < minZoom || target.t - lead >= last) continue;
    const shot = { t: target.t, box: target.box, zoom };
    const start = Math.max(0, target.t - lead), end = Math.min(last, Math.max(target.t, target.until ?? target.t) + hold);
    const segment = segments.at(-1);
    if (segment && start - segment.end <= chainGap) {
      segment.shots.push(shot);
      segment.end = Math.max(segment.end, end);
      segment.zoom = Math.min(segment.zoom, zoom);
    } else segments.push({ start, end, zoom, shots: [shot] });
  }
  return segments;
}

/** The center nearest `center` whose view, `half` wide on each side, holds `low` to `high`. */
const reach = (center, low, high, half) => clamp(center, high - half, low + half);

/**
 * Where the camera wants to be (center and zoom) before spring smoothing, asked frame by frame in time
 * order. It centers on a segment's first target, then moves only as far as each later target, with
 * `padding`, or the cursor needs to stay in view, so actions in one area play out under a still
 * camera. `pointerAt(t)` may be null.
 */
export function intents(segments, viewport, camera, pointerAt) {
  let framing = null;
  return t => {
    const segment = segments.find(s => t >= s.start && t < s.end);
    if (!segment) { framing = null; return { x: viewport.width / 2, y: viewport.height / 2, zoom: 1 }; }
    // Reach each shot `lead` before its action, so the camera arrives as the action happens.
    const shot = segment.shots.findLast(s => s.t - camera.lead <= t) ?? segment.shots[0];
    const { zoom } = segment, { box } = shot, pad = camera.padding;
    const half = { x: viewport.width / (2 * zoom), y: viewport.height / (2 * zoom) };
    if (framing?.segment !== segment) framing = { segment, shot, x: box.x + box.width / 2, y: box.y + box.height / 2 };
    else if (framing.shot !== shot) {
      framing.shot = shot;
      framing.x = reach(framing.x, box.x - pad, box.x + box.width + pad, half.x);
      framing.y = reach(framing.y, box.y - pad, box.y + box.height + pad, half.y);
    }
    const pointer = camera.follow ? pointerAt?.(t) : null;
    if (pointer) {
      framing.x = clamp(framing.x, pointer.x - half.x * SAFE_AREA, pointer.x + half.x * SAFE_AREA);
      framing.y = clamp(framing.y, pointer.y - half.y * SAFE_AREA, pointer.y + half.y * SAFE_AREA);
    }
    framing.x = clamp(framing.x, half.x, viewport.width - half.x);
    framing.y = clamp(framing.y, half.y, viewport.height - half.y);
    return { x: framing.x, y: framing.y, zoom };
  };
}

/**
 * The visible viewport crop for every output frame. The intent is followed by two critically damped
 * springs in series on center and log-zoom, which ease each move in and out and settle in about
 * `response` seconds.
 */
export function cameraTrack({ targets, viewport, camera, duration, fps, pointerAt }) {
  const intentAt = intents(zoomSegments(targets, viewport, camera, duration), viewport, camera, pointerAt);
  // The pair settles about as fast as one spring with omega 4 / response.
  const omega = 6.8 / camera.response, steps = 4, dt = 1 / (fps * steps);
  const start = intentAt(0);
  const spring = () => ({ position: { x: start.x, y: start.y, z: Math.log(start.zoom) }, velocity: { x: 0, y: 0, z: 0 } });
  const aim = spring(), view = spring(), state = view.position;
  const follow = ({ position, velocity }, target, key) => {
    velocity[key] += (omega * omega * (target[key] - position[key]) - 2 * omega * velocity[key]) * dt;
    position[key] += velocity[key] * dt;
  };
  const track = [];
  for (let i = 0, frames = Math.round(duration * fps); i < frames; i++) {
    const goal = intentAt(i / fps);
    const target = { x: goal.x, y: goal.y, z: Math.log(goal.zoom) };
    for (let step = 0; step < steps; step++) for (const key of ['x', 'y', 'z']) {
      follow(aim, target, key);
      follow(view, aim.position, key);
    }
    track.push(cropAround(state.x, state.y, Math.exp(state.z), viewport));
  }
  return track;
}
