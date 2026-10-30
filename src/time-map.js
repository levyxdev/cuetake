/**
 * The time map between the Final and the Source, shared by Node and the render page. Pure functions,
 * no imports.
 *
 * Every time in the Timeline and the Edit is Source time: seconds since Capture started. The Edit's
 * `fastForward` spans (`{ start, end, rate }`, Source seconds) play `rate` times faster in the Final;
 * the rest plays as recorded. A span eases to its rate and back inside itself, over about `EASE`
 * seconds of the Final each way, so the page never jumps to speed and the moments around the span stay
 * as recorded.
 */

const EASE = 0.3; // seconds of the Final a span takes to reach its rate, and to leave it
const BADGE_IN = 0.15, BADGE_OUT = 0.2; // seconds of the Final a fast-forward badge takes to appear and to go
const EPSILON = 0.005;

// A ramp's speed rises from 1 to `rate` as smoothstep(u); `rise(u)` is that share integrated over u.
const rise = u => u * u * u - u * u * u * u / 2;

/** What stops the spans from playing: a rate below 1, an empty span, or spans that overlap. Each problem names its span. */
export function fastForwardProblems(spans = []) {
  const problems = [], sorted = [...spans].sort((a, b) => a.start - b.start);
  const name = span => `The fast-forward ${typeof span.start === 'number' ? `from ${span.start.toFixed(2)} s` : JSON.stringify(span)}`;
  for (const [i, span] of sorted.entries()) {
    if (!(typeof span.start === 'number' && typeof span.end === 'number' && span.end > span.start)) problems.push(`${name(span)} needs a start before its end, in seconds`);
    if (!(typeof span.rate === 'number' && span.rate >= 1)) problems.push(`${name(span)} needs a rate of at least 1`);
    const next = sorted[i + 1];
    if (next && next.start < span.end - EPSILON) problems.push(`${name(span)} overlaps the one from ${next.start.toFixed(2)} s`);
  }
  return problems;
}

/**
 * The map for a Source `duration` seconds long: the Final's `duration`, `sourceAt(t)` for a moment of
 * the Final, `outputAt(s)` for a moment of the Source, and each span's place in the Final as
 * `spans: [{ start, end, rate }]`. Spans are clipped to the Source; invalid ones stop it.
 */
export function timeMap(spans = [], duration) {
  const problems = fastForwardProblems(spans);
  if (problems.length) throw new Error(`The fast-forward spans do not fit: ${problems.join('; ')}`);
  // Pieces of the Final in order, each `seconds` long from Final time `t` and Source time `s`.
  const pieces = [];
  let t = 0, s = 0;
  const add = (seconds, source, at, rate = 1) => { if (seconds > 0) pieces.push({ t, s, seconds, at, rate }); t += seconds; s += source; };
  const shown = [];
  const clipped = spans.map(span => ({ ...span, start: Math.max(0, span.start), end: Math.min(duration, span.end) })).filter(span => span.end > span.start);
  for (const { start, end, rate } of clipped.sort((a, b) => a.start - b.start)) {
    add(start - s, start - s, u => u);
    const from = t, length = end - start, ease = Math.min(EASE, length / (1 + rate)), steady = length - ease * (1 + rate);
    add(ease, ease * (1 + rate) / 2, u => u + (rate - 1) * ease * rise(u / ease), null);
    add(steady / rate, steady, u => u * rate, rate);
    add(ease, ease * (1 + rate) / 2, u => rate * u - (rate - 1) * ease * rise(u / ease), null);
    s = end; // no drift from the ramps' arithmetic
    shown.push({ start: from, end: t, rate });
  }
  add(Math.max(0, duration - s), Math.max(0, duration - s), u => u);
  if (!pieces.length) pieces.push({ t: 0, s: 0, seconds: 0, at: u => u, rate: 1 });
  const last = (list, key, value) => list.findLast(piece => piece[key] <= value) ?? list[0];
  return {
    duration: t,
    spans: shown,
    sourceAt(time) {
      const piece = last(pieces, 't', time), u = Math.min(Math.max(time - piece.t, 0), piece.seconds);
      // Past the last piece, or before the first, the Final plays the Source as recorded.
      return piece.s + piece.at(u) + (time - piece.t - u);
    },
    outputAt(source) {
      const piece = last(pieces, 's', source), offset = source - piece.s;
      if (piece.rate !== null || offset <= 0) return piece.t + offset / (piece.rate ?? 1);
      // A ramp: its Source time rises monotonically, so halve the interval until it pins `offset`.
      let low = 0, high = piece.seconds;
      if (piece.at(high) <= offset) return piece.t + high + (offset - piece.at(high));
      for (let i = 0; i < 48; i++) { const mid = (low + high) / 2; if (piece.at(mid) < offset) low = mid; else high = mid; }
      return piece.t + (low + high) / 2;
    },
  };
}

/** The fast-forward badge at Final time `t`: the index of the span showing, its rate and the badge's opacity, or null. */
export function badgeAt(map, t) {
  const index = map.spans.findIndex(span => t >= span.start && t < span.end);
  if (index < 0) return null;
  const { start, end, rate } = map.spans[index];
  return { index, rate, opacity: Math.max(0, Math.min(1, (t - start) / BADGE_IN, (end - t) / BADGE_OUT)) };
}

/** `items` with the times named by `keys` moved from the Source to the Final, as Shortcuts and camera targets are. */
export const retimed = (items, map, keys = ['t']) => items.map(item => {
  const moved = { ...item };
  for (const key of keys) if (typeof item[key] === 'number') moved[key] = map.outputAt(item[key]);
  return moved;
});

/**
 * Lines placed in the Final: each `start` moved to Final time. A Line still speaking while the Final
 * fast-forwards is a problem naming it, since speech cannot play faster with the picture.
 */
export function linesInFinal(lines, map) {
  const problems = [], seconds = s => `${s.toFixed(2)} s`;
  const placed = lines.map(line => {
    const start = map.outputAt(line.start), stops = start + (line.duration ?? 0);
    const span = map.spans.find(span => start < span.end - EPSILON && stops > span.start + EPSILON);
    if (span) problems.push(`Line '${line.id}' is spoken from ${seconds(start)} to ${seconds(stops)} of the Final, while it fast-forwards from ${seconds(span.start)} to ${seconds(span.end)}; move the Line out of it or shorten the fast-forward`);
    return { ...line, start };
  });
  return { lines: placed, problems };
}
