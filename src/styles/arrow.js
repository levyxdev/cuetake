// The arrow cursor and its family of shapes: filled with `color`, outlined in dark gray, with a soft shadow.
// Each shape is drawn in its own box, in units where the 28×36 arrow has its tip at (2, 2); CueTake scales
// the arrow's box to the cursor's size and the other shapes with it.
export const shapes = {
  default: { width: 28, height: 36, hotspot: [2, 2] },
  pointer: { width: 26, height: 29, hotspot: [9.5, 2] },
  text: { width: 10, height: 22, hotspot: [5, 11] },
  crosshair: { width: 22, height: 22, hotspot: [11, 11] },
  grab: { width: 26, height: 28, hotspot: [13, 15] },
  grabbing: { width: 26, height: 27, hotspot: [13, 15] },
  move: { width: 24, height: 24, hotspot: [12, 12] },
  'not-allowed': { width: 22, height: 22, hotspot: [11, 11] },
  'ew-resize': { width: 24, height: 24, hotspot: [12, 12] },
  'ns-resize': { width: 24, height: 24, hotspot: [12, 12] },
  'nwse-resize': { width: 24, height: 24, hotspot: [12, 12] },
  'nesw-resize': { width: 24, height: 24, hotspot: [12, 12] },
  wait: { width: 22, height: 22, hotspot: [11, 11] },
  progress: { width: 34, height: 36, hotspot: [2, 2] },
};

const OUTLINE = '#171717';
const ARROW = new Path2D('M2 2 L2 27 L8.5 21 L14 33 L19 30.5 L13.5 19 L23 19 Z');
const rounded = (x, y, w, h, r) => { const p = new Path2D(); p.roundRect(x, y, w, h, r); return p; };
const polygon = (...points) => new Path2D(`M${points.map(p => p.join(' ')).join(' L')} Z`);
const ellipse = (x, y, rx, ry, angle) => { const p = new Path2D(); p.ellipse(x, y, rx, ry, angle, 0, 2 * Math.PI); return p; };
const bar = (x, y, w, h) => { const p = new Path2D(); p.rect(x, y, w, h); return p; };
// Solid shapes as overlapping parts; fingers sit a hair apart, so their outlines meet in a dark line between them.
const SOLIDS = {
  pointer: [rounded(7, 1.5, 5, 15.5, 2.5), rounded(12.3, 9, 4.2, 9, 2.1), rounded(16.8, 10, 4, 8.5, 2), rounded(21.1, 11.5, 3.6, 7.5, 1.8),
    rounded(8, 14, 16.7, 13, [2, 3, 6, 6]), ellipse(5.2, 17.5, 2.4, 4.8, -0.6)],
  grab: [rounded(6, 4.5, 3.9, 12, 1.95), rounded(10.3, 2.5, 4, 13, 2), rounded(14.7, 3.5, 3.9, 12, 1.95), rounded(19, 6.5, 3.6, 10, 1.8),
    rounded(6, 12, 16.6, 14, [3, 3, 6, 6]), ellipse(4.2, 16.5, 2.3, 5, -0.7)],
  grabbing: [rounded(6.5, 8.5, 3.9, 7, 1.95), rounded(10.8, 7.5, 4, 7, 2), rounded(15.2, 8, 3.9, 7, 1.95), rounded(19.5, 9.5, 3.6, 6, 1.8),
    rounded(6, 11, 16.8, 14, [3, 3, 6, 6]), ellipse(5, 16.5, 2.3, 4.3, -0.4)],
  move: [bar(10.8, 4, 2.4, 16), bar(4, 10.8, 16, 2.4), polygon([12, 0.5], [15.6, 5], [8.4, 5]), polygon([12, 23.5], [8.4, 19], [15.6, 19]),
    polygon([0.5, 12], [5, 8.4], [5, 15.6]), polygon([23.5, 12], [19, 15.6], [19, 8.4])],
};
// The resize shapes are one double arrow, turned by degrees.
const DOUBLE_ARROW = [bar(5, 10.8, 14, 2.4), polygon([0.5, 12], [6, 6.5], [6, 17.5]), polygon([23.5, 12], [18, 17.5], [18, 6.5])];
const RESIZE = { 'ew-resize': 0, 'ns-resize': 90, 'nwse-resize': 45, 'nesw-resize': -45 };
const I_BEAM = new Path2D('M2 2 Q5 2 5 5 V17 Q5 20 2 20 M8 2 Q5 2 5 5 M5 17 Q5 20 8 20');
const CROSS = new Path2D('M11 1 V21 M1 11 H21');

/** Paints `under` with a soft shadow, then `over` without; shadow sizes are device pixels, so they follow the box's scale on screen. */
function outlined(ctx, under, over) {
  const { a, b } = ctx.getTransform(), pixels = Math.hypot(a, b);
  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.strokeStyle = OUTLINE;
  ctx.shadowColor = '#00000055'; ctx.shadowBlur = 2 * pixels; ctx.shadowOffsetY = pixels;
  under();
  ctx.shadowColor = 'transparent';
  over();
  ctx.restore();
}
/** A solid shape made of overlapping parts, outlined around the whole. */
function solid(ctx, parts, color) {
  outlined(ctx, () => { ctx.lineWidth = 3.4; parts.forEach(p => ctx.stroke(p)); }, () => { ctx.fillStyle = color; parts.forEach(p => ctx.fill(p)); });
}
/** A drawn line: a thin stroke in `color` inside a wider dark one. */
function line(ctx, path, color, width = 1.6) {
  outlined(ctx, () => { ctx.lineWidth = width + 2; ctx.stroke(path); }, () => { ctx.lineWidth = width; ctx.strokeStyle = color; ctx.stroke(path); });
}
function arrow(ctx, color) {
  outlined(ctx, () => { ctx.fillStyle = color; ctx.fill(ARROW); }, () => { ctx.lineWidth = 1.7; ctx.stroke(ARROW); });
}
function ring(ctx, x, y, r, color) {
  const whole = new Path2D(), arc = new Path2D();
  whole.arc(x, y, r, 0, 2 * Math.PI); arc.arc(x, y, r, -Math.PI / 2, Math.PI);
  outlined(ctx, () => { ctx.lineWidth = 5; ctx.stroke(whole); }, () => { ctx.lineWidth = 2.4; ctx.strokeStyle = color; ctx.stroke(arc); });
}

export function draw(ctx, { shape, params }) {
  const color = params.color ?? '#ffffff';
  if (shape in SOLIDS) return solid(ctx, SOLIDS[shape], color);
  if (shape in RESIZE) {
    ctx.translate(12, 12); ctx.rotate(RESIZE[shape] * Math.PI / 180); ctx.translate(-12, -12);
    return solid(ctx, DOUBLE_ARROW, color);
  }
  if (shape === 'text') return line(ctx, I_BEAM, color);
  if (shape === 'crosshair') return line(ctx, CROSS, color);
  if (shape === 'not-allowed') {
    const sign = new Path2D();
    sign.arc(11, 11, 8, 0, 2 * Math.PI); sign.moveTo(5.4, 5.4); sign.lineTo(16.6, 16.6);
    return line(ctx, sign, color, 2.4);
  }
  if (shape === 'wait') return ring(ctx, 11, 11, 8, color);
  arrow(ctx, color);
  if (shape === 'progress') ring(ctx, 26, 28, 5, color);
}
