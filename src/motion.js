/**
 * How the Director's hand moves: durations from Fitts's law, a quick start and a long settle, a
 * slight arc, pauses around presses and uneven typing. Pure and seeded, so a Scenario moves the
 * same way on every recording. CSS pixels and milliseconds throughout.
 */

const REACH_MS = 250, REACH_MS_PER_BIT = 150; // Fitts's law: REACH_MS + REACH_MS_PER_BIT * log2(distance / size + 1)
const MAX_AVERAGE_SPEED = 1100; // CSS px/s; with the ease's 1.8× peak, a move at speed 1 stays under about 2000 px/s
const DRAG_SLOWDOWN = 1.5; // a held button makes people slower
const POINT_SIZE = 24; // target size for moves to a bare point
const BEND = 0.1, MAX_BEND = 80; // the arc's sideways offset, as a share of the distance and in CSS px
const LANDING = 0.15, MAX_LANDING = 8; // a click lands at most this share of its box's size, and CSS px, from the center
const PAUSES = { beforePress: 120, afterRelease: 150, afterGrab: 100, beforeDrop: 100 };
const PAUSE_JITTER = 0.25, TYPING_JITTER = 0.4, WORD_BREAK = 1.5;

/** A deterministic source of numbers in [0, 1) (mulberry32). */
export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How long a person takes to move `distance` onto a target `size` across. */
export function reachMs(distance, size = POINT_SIZE, { speed = 1, drag = false } = {}) {
  if (distance < 1) return 0;
  const fitts = REACH_MS + REACH_MS_PER_BIT * Math.log2(distance / Math.max(1, size) + 1);
  return Math.max(fitts, distance / MAX_AVERAGE_SPEED * 1000) * (drag ? DRAG_SLOWDOWN : 1) / speed;
}

/** Progress along a move at time share `t`: minimum-jerk, warped so it peaks early and settles long. */
const ease = t => { const u = t ** 0.75; return u * u * u * (10 - 15 * u + 6 * u * u); };

/** A move from `from` to `to`: its duration and its point at time share `t`, along a slight arc. */
export function reach(from, to, { size, duration, speed, drag, rand }) {
  const dx = to.x - from.x, dy = to.y - from.y, distance = Math.hypot(dx, dy);
  const bend = Math.min(distance * BEND, MAX_BEND) * (0.5 + rand() / 2) * (rand() < 0.5 ? -1 : 1);
  const control = { x: from.x + dx / 2 - dy / (distance || 1) * bend, y: from.y + dy / 2 + dx / (distance || 1) * bend };
  return {
    duration: duration ?? reachMs(distance, size, { speed, drag }),
    at(t) {
      const k = ease(t), j = 1 - k;
      return { x: j * j * from.x + 2 * j * k * control.x + k * k * to.x, y: j * j * from.y + 2 * j * k * control.y + k * k * to.y };
    },
  };
}

/** Where a click lands: a little off the center of its box, never more than a few pixels. */
export function landing(box, rand) {
  const off = size => (rand() * 2 - 1) * Math.min(LANDING * size, MAX_LANDING);
  return { x: box.x + box.width / 2 + off(box.width), y: box.y + box.height / 2 + off(box.height) };
}

/** A named pause, a little uneven. */
export const pauseMs = (name, speed, rand) => PAUSES[name] * (1 + (rand() * 2 - 1) * PAUSE_JITTER) / speed;

/** The delay after each typed character: uneven, longer after a word, averaging `msPerChar`. */
export function typingDelays(text, msPerChar, rand) {
  const chars = [...text];
  const raw = chars.map(c => (1 + (rand() * 2 - 1) * TYPING_JITTER) * (/[\s.,;:!?，。；：！？]/.test(c) ? WORD_BREAK : 1));
  const total = raw.reduce((sum, d) => sum + d, 0);
  return raw.map(d => d / total * msPerChar * chars.length);
}
