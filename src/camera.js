/**
 * Camera math shared by Node and the render page. Pure functions, no imports.
 *
 * Modeled on Screen Studio's auto zoom: zooms come from actions; actions close together form one
 * zoom segment that moves between them and follows the cursor; the camera moves on a critically
 * damped spring, so it never overshoots and settles quickly enough to keep text readable. Because
 * the whole Timeline is known in advance, the camera starts moving `lead` seconds before each
 * action and every Final ends on the wide shot.
 *
 * Everything here is in CSS pixels of the captured viewport and seconds since capture start.
 */

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const SAFE_AREA = 0.7; // while zoomed, the cursor stays within this central fraction of the view

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
    if (segment && start - segment.end <= chainGap) { segment.shots.push(shot); segment.end = Math.max(segment.end, end); }
    else segments.push({ start, end, shots: [shot] });
  }
  return segments;
}

/** Where the camera wants to be at `t` (center and zoom) before spring smoothing. `pointerAt(t)` may be null. */
export function intentAt(segments, viewport, camera, t, pointerAt) {
  const segment = segments.find(s => t >= s.start && t < s.end);
  if (!segment) return { x: viewport.width / 2, y: viewport.height / 2, zoom: 1 };
  // Move to each shot `lead` before its action, so the camera arrives as the action happens.
  const shot = segment.shots.findLast(s => s.t - camera.lead <= t) ?? segment.shots[0];
  const { zoom } = shot;
  const half = { x: viewport.width / (2 * zoom), y: viewport.height / (2 * zoom) };
  let x = shot.box.x + shot.box.width / 2, y = shot.box.y + shot.box.height / 2;
  const pointer = camera.follow ? pointerAt?.(t) : null;
  if (pointer) {
    x = clamp(x, pointer.x - half.x * SAFE_AREA, pointer.x + half.x * SAFE_AREA);
    y = clamp(y, pointer.y - half.y * SAFE_AREA, pointer.y + half.y * SAFE_AREA);
  }
  return { x: clamp(x, half.x, viewport.width - half.x), y: clamp(y, half.y, viewport.height - half.y), zoom };
}

/**
 * The visible viewport crop for every output frame. The intent is followed by a critically damped
 * spring on center and log-zoom that settles in about `response` seconds.
 */
export function cameraTrack({ targets, viewport, camera, duration, fps, pointerAt }) {
  const segments = zoomSegments(targets, viewport, camera, duration);
  const omega = 4 / camera.response, steps = 4, dt = 1 / (fps * steps);
  const start = intentAt(segments, viewport, camera, 0, pointerAt);
  const state = { x: start.x, y: start.y, z: Math.log(start.zoom) }, velocity = { x: 0, y: 0, z: 0 };
  const track = [];
  for (let i = 0, frames = Math.round(duration * fps); i < frames; i++) {
    const goal = intentAt(segments, viewport, camera, i / fps, pointerAt);
    const target = { x: goal.x, y: goal.y, z: Math.log(goal.zoom) };
    for (let step = 0; step < steps; step++) for (const key of ['x', 'y', 'z']) {
      velocity[key] += (omega * omega * (target[key] - state[key]) - 2 * omega * velocity[key]) * dt;
      state[key] += velocity[key] * dt;
    }
    track.push(cropAround(state.x, state.y, Math.exp(state.z), viewport));
  }
  return track;
}
