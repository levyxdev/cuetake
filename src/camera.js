/**
 * Camera math shared by Node and the render page. Pure functions, no imports.
 *
 * Targets close in time form one chain: the camera zooms in once, pans between
 * the chain's targets, then zooms out once.
 *
 *   [full] → [zoom in] → [pan to A] → [pan to B] → [zoom out] → [full]
 *
 * Everything here is in CSS pixels of the captured viewport and seconds since capture start.
 */

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const smoothstep = p => p * p * (3 - 2 * p);
const mix = (from, to, start, end, t) => end <= start ? to : from + (to - from) * smoothstep(clamp((t - start) / (end - start), 0, 1));

/** The viewport crop that centers `box` at `zoomLevel`, kept inside the viewport. */
export function cropFor(box, viewport, zoomLevel) {
  const w = Math.round(viewport.width / zoomLevel), h = Math.round(viewport.height / zoomLevel);
  const x = Math.round(clamp(box.x + box.width / 2 - w / 2, 0, viewport.width - w));
  const y = Math.round(clamp(box.y + box.height / 2 - h / 2, 0, viewport.height - h));
  return { x, y, w, h };
}

/** Groups Edit camera targets into timed chains. */
export function buildChains(targets, viewport, camera) {
  const { zoomLevel, transitionDuration, panDuration, holdPerTarget, preLead, chainGap } = camera;
  const shots = targets.toSorted((a, b) => a.t - b.t).map(target => ({
    time: target.t,
    holdUntil: target.t + holdPerTarget + Math.max(0, (target.until ?? target.t) - target.t),
    crop: cropFor(target.box, viewport, zoomLevel),
  }));
  const groups = [];
  for (const shot of shots) {
    const group = groups.at(-1);
    if (group && shot.time - group.at(-1).holdUntil <= chainGap) group.push(shot);
    else groups.push([shot]);
  }
  return groups.map(group => {
    const startZoom = Math.max(0, group[0].time - preLead);
    const unzoomAt = group.at(-1).holdUntil;
    return { startZoom, zoomedAt: startZoom + transitionDuration, unzoomAt, endZoom: unzoomAt + transitionDuration, targets: group, panDuration };
  });
}

/** Position inside a chain's zoomed phase: hold each target, then pan to arrive exactly when the next fires. */
function panWithin(chain, axis, t) {
  const { targets } = chain;
  for (let i = 0; i < targets.length - 1; i++) {
    const current = targets[i], next = targets[i + 1];
    const panEnd = next.time;
    const panStart = Math.max(current.time + 0.05, panEnd - chain.panDuration);
    if (t < panStart || panStart >= panEnd) { if (t < panEnd) return current.crop[axis]; continue; }
    if (t <= panEnd) return mix(current.crop[axis], next.crop[axis], panStart, panEnd, t);
  }
  return targets.at(-1).crop[axis];
}

/** The visible viewport crop at time `t`. */
export function cropAt(chains, viewport, t) {
  for (const chain of chains) {
    if (t < chain.startZoom || t > chain.endZoom) continue;
    const first = chain.targets[0].crop, last = chain.targets.at(-1).crop;
    if (t <= chain.zoomedAt) return {
      x: mix(0, first.x, chain.startZoom, chain.zoomedAt, t), y: mix(0, first.y, chain.startZoom, chain.zoomedAt, t),
      w: mix(viewport.width, first.w, chain.startZoom, chain.zoomedAt, t), h: mix(viewport.height, first.h, chain.startZoom, chain.zoomedAt, t),
    };
    if (t <= chain.unzoomAt) return { x: panWithin(chain, 'x', t), y: panWithin(chain, 'y', t), w: first.w, h: first.h };
    return {
      x: mix(last.x, 0, chain.unzoomAt, chain.endZoom, t), y: mix(last.y, 0, chain.unzoomAt, chain.endZoom, t),
      w: mix(first.w, viewport.width, chain.unzoomAt, chain.endZoom, t), h: mix(first.h, viewport.height, chain.unzoomAt, chain.endZoom, t),
    };
  }
  return { x: 0, y: 0, w: viewport.width, h: viewport.height };
}
