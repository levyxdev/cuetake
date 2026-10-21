/**
 * Zoom calculation engine — v2 with pan targets.
 *
 * Instead of merging overlapping events into one giant crop,
 * we create "zoom chains" that zoom in, pan between targets, then zoom out.
 *
 * Visual timeline:
 *   [full] → [zoom in] → [pan to A] → [pan to B] → [pan to C] → [zoom out] → [full]
 *
 * This produces the "cinematic product demo" look where the camera smoothly
 * follows the action across different parts of the UI.
 */

/**
 * Calculate crop region for a zoom centered on a bounding box.
 */
export function calculateCropRegion(bbox, viewport, zoomLevel = 2.0) {
  const centerX = bbox.x + bbox.width / 2;
  const centerY = bbox.y + bbox.height / 2;

  const cropW = Math.round(viewport.width / zoomLevel);
  const cropH = Math.round(viewport.height / zoomLevel);

  const cropX = Math.round(clamp(centerX - cropW / 2, 0, viewport.width - cropW));
  const cropY = Math.round(clamp(centerY - cropH / 2, 0, viewport.height - cropH));

  return { x: cropX, y: cropY, w: cropW, h: cropH };
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * Build zoom chains from the event timeline.
 *
 * A chain is a group of events that happen close together in time.
 * Within a chain, the camera stays zoomed and pans between targets.
 * Between chains, the camera zooms out to show the full viewport.
 *
 * @returns {Array<ZoomChain>} where ZoomChain = {
 *   startZoom, zoomedAt, unzoomAt, endZoom,  // timing
 *   targets: [{ time, holdUntil, crop }],     // pan targets within the chain
 *   zoomLevel
 * }
 */
export function buildZoomChains(timeline, options = {}) {
  const {
    zoomLevel = 2.0,
    transitionDuration = 0.3,  // zoom in/out easing
    panDuration = 0.25,        // pan between targets easing
    holdPerTarget = 0.8,       // hold each target before panning to next
    preLead = 0.2,             // start zoom before first event
    chainGap = 2.5,            // if gap between events > this, start a new chain
  } = options;

  const viewport = timeline.viewport;
  const zoomableActions = ['click', 'type', 'hover', 'select'];

  // Step 1: Extract zoomable events with their crop regions
  const events = [];
  for (const event of timeline.events) {
    if (!zoomableActions.includes(event.type)) continue;
    if (!event.boundingBox) continue;

    let extraHold = 0;
    if (event.type === 'type' && event.text) {
      extraHold = (event.text.length * (event.delay || 80)) / 1000;
    }

    events.push({
      time: event.timestamp,
      holdDuration: holdPerTarget + extraHold,
      crop: calculateCropRegion(event.boundingBox, viewport, zoomLevel),
      type: event.type,
    });
  }

  if (events.length === 0) return [];

  // Step 2: Group into chains based on time gaps
  const chains = [];
  let currentChain = [events[0]];

  for (let i = 1; i < events.length; i++) {
    const gap = events[i].time - (events[i - 1].time + events[i - 1].holdDuration);
    if (gap > chainGap) {
      chains.push(currentChain);
      currentChain = [events[i]];
    } else {
      currentChain.push(events[i]);
    }
  }
  chains.push(currentChain);

  // Step 3: Convert chains into timed zoom chains with pan targets
  return chains.map(chain => {
    const firstEvent = chain[0];
    const lastEvent = chain[chain.length - 1];

    // Build targets with timing
    const targets = [];
    let currentTime = firstEvent.time;

    for (let i = 0; i < chain.length; i++) {
      const event = chain[i];
      const arriveAt = i === 0 ? firstEvent.time : event.time;
      const holdUntil = arriveAt + event.holdDuration;
      targets.push({
        time: arriveAt,
        holdUntil,
        crop: event.crop,
      });
      currentTime = holdUntil;
    }

    const startZoom = Math.max(0, firstEvent.time - preLead);
    const zoomedAt = startZoom + transitionDuration;
    const lastTarget = targets[targets.length - 1];
    const unzoomAt = lastTarget.holdUntil;
    const endZoom = unzoomAt + transitionDuration;

    return {
      startZoom,
      zoomedAt,
      unzoomAt,
      endZoom,
      targets,
      zoomLevel,
      panDuration,
    };
  });
}

/**
 * Generate FFmpeg crop filter with zoom chains and panning.
 *
 * The filter has two parts:
 * 1. w/h expressions: zoom in → hold → zoom out (same for all targets in a chain)
 * 2. x/y expressions: pan between targets within each chain
 */
export function buildFFmpegZoomFilter(timeline, options = {}) {
  const chains = buildZoomChains(timeline, options);
  const vw = timeline.viewport.width;
  const vh = timeline.viewport.height;

  if (chains.length === 0) return null;

  const wExpr = buildSizeExpr(chains, 'w', vw, vh);
  const xExpr = buildPanExpr(chains, 'x', vw, vh);
  const yExpr = buildPanExpr(chains, 'y', vw, vh);

  // crop's width/height are initialized once; zoompan evaluates every frame.
  // Timeline boxes are CSS pixels, while HD capture is in device pixels.
  const perFrame = expr => expr.replace(/\bt\b/g, 'in_time').replace(/\biw\b/g, String(vw)).replace(/\bih\b/g, String(vh));
  const outputWidth = options.width || vw;
  const outputHeight = Math.round(outputWidth * vh / vw / 2) * 2;
  const fps = options.fps || 60;
  return `fps=${fps},zoompan=z='${vw}/(${perFrame(wExpr)})':x='iw/${vw}*(${perFrame(xExpr)})':y='ih/${vh}*(${perFrame(yExpr)})':d=1:s=${outputWidth}x${outputHeight}:fps=${fps}`;
}

/**
 * Build w or h expression.
 * These only change during zoom-in and zoom-out transitions.
 * During the hold phase, they stay at the zoomed value.
 */
function buildSizeExpr(chains, dim, vw, vh) {
  const fullVal = dim === 'w' ? 'iw' : 'ih';
  const full = dim === 'w' ? vw : vh;
  let expr = fullVal;

  for (let i = chains.length - 1; i >= 0; i--) {
    const chain = chains[i];
    const zoomed = dim === 'w' ? chain.targets[0].crop.w : chain.targets[0].crop.h;

    // Zoom in: [startZoom, zoomedAt]
    const inExpr = smoothInterp(fullVal, zoomed, chain.startZoom, chain.zoomedAt);
    // Hold: [zoomedAt, unzoomAt]
    const holdExpr = String(zoomed);
    // Zoom out: [unzoomAt, endZoom]
    const outExpr = smoothInterp(zoomed, fullVal, chain.unzoomAt, chain.endZoom);

    expr = `if(between(t,${f(chain.startZoom)},${f(chain.zoomedAt)}),${inExpr},` +
           `if(between(t,${f(chain.zoomedAt)},${f(chain.unzoomAt)}),${holdExpr},` +
           `if(between(t,${f(chain.unzoomAt)},${f(chain.endZoom)}),${outExpr},` +
           `${expr})))`;
  }

  return expr;
}

/**
 * Build x or y expression with panning between targets.
 * During the zoomed phase, the position smoothly pans between crop targets.
 */
function buildPanExpr(chains, dim, vw, vh) {
  const defaultPos = '0';
  let expr = defaultPos;

  for (let i = chains.length - 1; i >= 0; i--) {
    const chain = chains[i];
    const targets = chain.targets;
    const firstPos = dim === 'x' ? targets[0].crop.x : targets[0].crop.y;
    const lastPos = dim === 'x' ? targets[targets.length - 1].crop.x : targets[targets.length - 1].crop.y;

    // Zoom in: pan from 0 to first target position
    const inExpr = smoothInterp(defaultPos, firstPos, chain.startZoom, chain.zoomedAt);

    // Hold phase: build pan expressions between targets
    let holdExpr;
    if (targets.length === 1) {
      holdExpr = String(firstPos);
    } else {
      // Build nested if/between for panning between targets
      holdExpr = buildPanChainExpr(targets, dim, chain);
    }

    // Zoom out: pan from last target position back to 0
    const outExpr = smoothInterp(lastPos, defaultPos, chain.unzoomAt, chain.endZoom);

    expr = `if(between(t,${f(chain.startZoom)},${f(chain.zoomedAt)}),${inExpr},` +
           `if(between(t,${f(chain.zoomedAt)},${f(chain.unzoomAt)}),${holdExpr},` +
           `if(between(t,${f(chain.unzoomAt)},${f(chain.endZoom)}),${outExpr},` +
           `${expr})))`;
  }

  return expr;
}

/**
 * Build pan expressions within a zoom chain.
 * Smoothly interpolates x or y between consecutive targets.
 *
 * Timing: pan is timed so we ARRIVE at the next target when it fires.
 *   [hold at current] → [pan to next] → [arrive exactly at next.time]
 *
 * When events overlap (next starts before current's hold ends),
 * we start panning immediately.
 */
function buildPanChainExpr(targets, dim, chain) {
  const lastPos = dim === 'x' ? targets[targets.length - 1].crop.x : targets[targets.length - 1].crop.y;
  let expr = String(lastPos);

  for (let i = targets.length - 2; i >= 0; i--) {
    const current = targets[i];
    const next = targets[i + 1];
    const currentPos = dim === 'x' ? current.crop.x : current.crop.y;
    const nextPos = dim === 'x' ? next.crop.x : next.crop.y;

    // Pan arrives at next position exactly when next event fires
    const panEnd = next.time;
    // Pan starts panDuration before arrival, but not before current event
    const panStart = Math.max(current.time + 0.05, panEnd - chain.panDuration);

    if (panStart >= panEnd) {
      // Events are essentially simultaneous — just snap to current position until next
      expr = `if(lt(t,${f(next.time)}),${currentPos},${expr})`;
    } else if (currentPos === nextPos) {
      // Same position — just hold
      expr = `if(lt(t,${f(next.time)}),${currentPos},${expr})`;
    } else {
      // Hold at current, then pan to next
      const panExpr = smoothInterp(currentPos, nextPos, panStart, panEnd);
      expr = `if(lt(t,${f(panStart)}),${currentPos},` +
             `if(between(t,${f(panStart)},${f(panEnd)}),${panExpr},` +
             `${expr}))`;
    }
  }

  return expr;
}

/**
 * Smoothstep interpolation expression between two values over a time range.
 *
 * Uses inline smoothstep formula without st()/ld() storage variables,
 * because those are NOT thread-safe in FFmpeg's expression evaluator.
 * Multi-threaded encoding (preset slow/slower) corrupts shared storage.
 *
 * Smoothstep: p*p*(3-2*p) where p = normalized progress
 */
function smoothInterp(from, to, tStart, tEnd) {
  const duration = tEnd - tStart;
  if (duration <= 0) return String(to);
  // p = clipped progress [0,1]
  const p = `clip((t-${f(tStart)})/${f(duration)},0,1)`;
  // Inline smoothstep: p*p*(3-2*p) — repeated p is verbose but thread-safe
  const smooth = `${p}*${p}*(3-2*${p})`;
  return `${from}+(${to}-${from})*(${smooth})`;
}

/** Format number to 3 decimal places */
function f(n) {
  return n.toFixed(3);
}
