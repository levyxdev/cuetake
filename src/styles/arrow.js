// The arrow cursor and its family of shapes: filled with `color`, outlined in dark gray, with a soft shadow.
// The pictures are Phosphor icons (https://phosphoricons.com), drawn in their 256-unit grid; each shape's box
// is the part of the grid it covers. CueTake scales the arrow's box to the cursor's size and the others with it.
//
// Phosphor Icons: Copyright (c) 2023 Phosphor Icons. Permission is hereby granted, free of charge, to any person
// obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software
// without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so,
// subject to the following conditions: The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE
// AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
// SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

// Where each shape sits in the grid, as [x, y, width, height], its hotspot in grid units, and the frames of a shape that turns.
const GRID = {
  default: [[28, 28, 200, 200], [37, 37]],
  pointer: [[24, 10, 206, 236], [116, 18]],
  text: [[56, 24, 144, 208], [128, 128]],
  crosshair: [[22, 22, 212, 212], [128, 128]],
  grab: [[16, 10, 206, 236], [128, 140]],
  grabbing: [[36, 58, 186, 188], [128, 150]],
  move: [[6, 6, 244, 244], [128, 128]],
  'not-allowed': [[18, 18, 220, 220], [128, 128]],
  'ew-resize': [[6, 84, 244, 88], [128, 128]],
  'ns-resize': [[84, 6, 88, 244], [128, 128]],
  'nwse-resize': [[30, 30, 196, 196], [128, 128]],
  'nesw-resize': [[30, 30, 196, 196], [128, 128]],
  wait: [[34, 34, 188, 188], [128, 128], 24],
  progress: [[28, 28, 236, 200], [37, 37], 24],
};
export const shapes = Object.fromEntries(Object.entries(GRID).map(([name, [[x, y, width, height], [hx, hy], frames]]) =>
  [name, { width, height, hotspot: [hx - x, hy - y], ...frames && { frames } }]));

const OUTLINE = '#171717';
const path = d => new Path2D(d);
// Outlined pictures: the duotone weight's area, filled, under the regular weight's lines, or the light weight's when thin.
const FRAMED = {
  default: [
    path('M213.66,201,201,213.66a8,8,0,0,1-11.31,0l-51.31-51.31a8,8,0,0,0-13,2.46l-17.82,46.41a8,8,0,0,1-14.85-.71L40.41,50.44a8,8,0,0,1,10-10L210.51,92.68a8,8,0,0,1,.71,14.85l-46.41,17.82a8,8,0,0,0-2.46,13l51.31,51.31A8,8,0,0,1,213.66,201Z'),
    path('M168,132.69,214.08,115l.33-.13A16,16,0,0,0,213,85.07L52.92,32.8A15.95,15.95,0,0,0,32.8,52.92L85.07,213a15.82,15.82,0,0,0,14.41,11l.78,0a15.84,15.84,0,0,0,14.61-9.59l.13-.33L132.69,168,184,219.31a16,16,0,0,0,22.63,0l12.68-12.68a16,16,0,0,0,0-22.63ZM195.31,208,144,156.69a16,16,0,0,0-26,4.93c0,.11-.09.22-.13.32l-17.65,46L48,48l159.85,52.2-45.95,17.64-.32.13a16,16,0,0,0-4.93,26h0L208,195.31Z'),
    path('M166.59,134.1a1.91,1.91,0,0,1-.55-1.79,2,2,0,0,1,1.08-1.42l46.25-17.76.24-.1A14,14,0,0,0,212.38,87L52.29,34.7A13.95,13.95,0,0,0,34.7,52.29L87,212.38a13.82,13.82,0,0,0,12.6,9.6c.23,0,.46,0,.69,0A13.84,13.84,0,0,0,113,213.61a2.44,2.44,0,0,0,.1-.24l17.76-46.25a2,2,0,0,1,3.21-.53l51.31,51.31a14,14,0,0,0,19.8,0l12.69-12.69a14,14,0,0,0,0-19.8Zm42.82,62.63-12.68,12.68a2,2,0,0,1-2.83,0L142.59,158.1a14,14,0,0,0-22.74,4.32,2.44,2.44,0,0,0-.1.24L102,208.91a2,2,0,0,1-3.61-.26L46.11,48.57a1.87,1.87,0,0,1,.47-2A1.92,1.92,0,0,1,47.93,46a2.22,2.22,0,0,1,.64.1L208.65,98.38a2,2,0,0,1,.26,3.61l-46.25,17.76-.24.1a14,14,0,0,0-4.32,22.74h0l51.31,51.31A2,2,0,0,1,209.41,196.73Z'),
  ],
  pointer: [
    path('M216,116v36a80,80,0,0,1-80,80c-44.18,0-55.81-24-93.32-90a20,20,0,0,1,34.64-20L96,152V44a20,20,0,0,1,40,0v56a20,20,0,0,1,40,0v16a20,20,0,0,1,40,0Z'),
    path('M196,88a27.86,27.86,0,0,0-13.35,3.39A28,28,0,0,0,144,74.7V44a28,28,0,0,0-56,0v80l-3.82-6.13A28,28,0,0,0,35.73,146l4.67,8.23C74.81,214.89,89.05,240,136,240a88.1,88.1,0,0,0,88-88V116A28,28,0,0,0,196,88Zm12,64a72.08,72.08,0,0,1-72,72c-37.63,0-47.84-18-81.68-77.68l-4.69-8.27,0-.05A12,12,0,0,1,54,121.61a11.88,11.88,0,0,1,6-1.6,12,12,0,0,1,10.41,6,1.76,1.76,0,0,0,.14.23l18.67,30A8,8,0,0,0,104,152V44a12,12,0,0,1,24,0v68a8,8,0,0,0,16,0V100a12,12,0,0,1,24,0v20a8,8,0,0,0,16,0v-4a12,12,0,0,1,24,0Z'),
    path('M196,90a25.87,25.87,0,0,0-14.59,4.49A26,26,0,0,0,142,78.1V44a26,26,0,0,0-52,0v87l-7.53-12.1a26,26,0,0,0-45,26.07l4.67,8.25c34,60,48.07,84.77,93.86,84.77a86.1,86.1,0,0,0,86-86V116A26,26,0,0,0,196,90Zm14,62a74.09,74.09,0,0,1-74,74c-38.8,0-50-19.83-83.42-78.69L47.89,139l0,0A14,14,0,0,1,53,119.88,13.87,13.87,0,0,1,60,118a14,14,0,0,1,12.15,7l.1.17,18.68,30A6,6,0,0,0,102,152V44a14,14,0,0,1,28,0v68a6,6,0,0,0,12,0V100a14,14,0,0,1,28,0v20a6,6,0,0,0,12,0v-4a14,14,0,0,1,28,0Z'),
  ],
  grab: [
    path('M208,76v76a80,80,0,0,1-80,80c-44.18,0-60.75-21.28-93.32-90a20,20,0,0,1,34.64-20L88,152V60a20,20,0,0,1,40,0V44a20,20,0,0,1,40,0V76a20,20,0,0,1,40,0Z'),
    path('M188,48a27.75,27.75,0,0,0-12,2.71V44a28,28,0,0,0-54.65-8.6A28,28,0,0,0,80,60v64l-3.82-6.13a28,28,0,0,0-48.6,27.82c16,33.77,28.93,57.72,43.72,72.69C86.24,233.54,103.2,240,128,240a88.1,88.1,0,0,0,88-88V76A28,28,0,0,0,188,48Zm12,104a72.08,72.08,0,0,1-72,72c-20.38,0-33.51-4.88-45.33-16.85C69.44,193.74,57.26,171,41.9,138.58a6.36,6.36,0,0,0-.3-.58,12,12,0,0,1,20.79-12,1.76,1.76,0,0,0,.14.23l18.67,30A8,8,0,0,0,96,152V60a12,12,0,0,1,24,0v60a8,8,0,0,0,16,0V44a12,12,0,0,1,24,0v76a8,8,0,0,0,16,0V76a12,12,0,0,1,24,0Z'),
    path('M188,50a25.8,25.8,0,0,0-14,4.11V44a26,26,0,0,0-51.41-5.51A26,26,0,0,0,82,60v71l-7.53-12.1a26,26,0,0,0-45.11,25.87C60.76,211,78.51,238,128,238a86.1,86.1,0,0,0,86-86V76A26,26,0,0,0,188,50Zm14,102a74.09,74.09,0,0,1-74,74c-21,0-34.51-5.05-46.75-17.45C67.81,195,55.54,172,40.1,139.43l-.23-.43a14,14,0,0,1,24.25-14l.1.17,18.68,30A6,6,0,0,0,94,152V60a14,14,0,0,1,28,0v60a6,6,0,0,0,12,0V44a14,14,0,0,1,28,0v76a6,6,0,0,0,12,0V76a14,14,0,0,1,28,0Z'),
  ],
  grabbing: [
    path('M208,108v44a80,80,0,0,1-160,0V140a20,20,0,0,1,20-20H88V92a20,20,0,0,1,40,0,20,20,0,0,1,40,0v16a20,20,0,0,1,40,0Z'),
    path('M188,80a27.79,27.79,0,0,0-13.36,3.4,28,28,0,0,0-46.64-11A28,28,0,0,0,80,92v20H68a28,28,0,0,0-28,28v12a88,88,0,0,0,176,0V108A28,28,0,0,0,188,80Zm12,72a72,72,0,0,1-144,0V140a12,12,0,0,1,12-12H80v24a8,8,0,0,0,16,0V92a12,12,0,0,1,24,0v28a8,8,0,0,0,16,0V92a12,12,0,0,1,24,0v28a8,8,0,0,0,16,0V108a12,12,0,0,1,24,0Z'),
    path('M188,82a25.85,25.85,0,0,0-14.59,4.49A26,26,0,0,0,128,75.41,26,26,0,0,0,82,92v22H68a26,26,0,0,0-26,26v12a86,86,0,0,0,172,0V108A26,26,0,0,0,188,82Zm14,70a74,74,0,0,1-148,0V140a14,14,0,0,1,14-14H82v26a6,6,0,0,0,12,0V92a14,14,0,0,1,28,0v28a6,6,0,0,0,12,0V92a14,14,0,0,1,28,0v28a6,6,0,0,0,12,0V108a14,14,0,0,1,28,0Z'),
  ],
  'not-allowed': [
    path('M224,128a96,96,0,1,1-96-96A96,96,0,0,1,224,128Z'),
    path('M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm88,104a87.56,87.56,0,0,1-20.41,56.28L71.72,60.4A88,88,0,0,1,216,128ZM40,128A87.56,87.56,0,0,1,60.41,71.72L184.28,195.6A88,88,0,0,1,40,128Z'),
    path('M128,26A102,102,0,1,0,230,128,102.12,102.12,0,0,0,128,26Zm90,102a89.6,89.6,0,0,1-22.29,59.22L68.78,60.29A89.95,89.95,0,0,1,218,128ZM38,128A89.6,89.6,0,0,1,60.29,68.78L187.22,195.71A89.95,89.95,0,0,1,38,128Z'),
  ],
};
// Line pictures, filled and ringed with the outline: the I-beam and cross from the regular weight, arrows from the fill
// weight, with the move arrows' shafts joined in the middle.
const RINGED = {
  text: path('M184,208a8,8,0,0,1-8,8H160a40,40,0,0,1-32-16,40,40,0,0,1-32,16H80a8,8,0,0,1,0-16H96a24,24,0,0,0,24-24V136H104a8,8,0,0,1,0-16h16V80A24,24,0,0,0,96,56H80a8,8,0,0,1,0-16H96a40,40,0,0,1,32,16,40,40,0,0,1,32-16h16a8,8,0,0,1,0,16H160a24,24,0,0,0-24,24v40h16a8,8,0,0,1,0,16H136v40a24,24,0,0,0,24,24h16A8,8,0,0,1,184,208Z'),
  crosshair: path('M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z'),
  move: [path('M96,136H64v24a8,8,0,0,1-13.66,5.66l-32-32a8,8,0,0,1,0-11.32l32-32A8,8,0,0,1,64,96v24H96a8,8,0,0,1,0,16Zm0-72h24V96a8,8,0,0,0,16,0V64h24a8,8,0,0,0,5.66-13.66l-32-32a8,8,0,0,0-11.32,0l-32,32A8,8,0,0,0,96,64Zm141.66,58.34-32-32A8,8,0,0,0,192,96v24H160a8,8,0,0,0,0,16h32v24a8,8,0,0,0,13.66,5.66l32-32A8,8,0,0,0,237.66,122.34ZM160,192H136V160a8,8,0,0,0-16,0v32H96a8,8,0,0,0-5.66,13.66l32,32a8,8,0,0,0,11.32,0l32-32A8,8,0,0,0,160,192Z'), path('M120,64h16v128h-16Z'), path('M64,120h128v16h-128Z')],
};
// The resize shapes are one double arrow, turned by degrees.
const DOUBLE_ARROW = path('M237.66,133.66l-32,32A8,8,0,0,1,192,160V136H64v24a8,8,0,0,1-13.66,5.66l-32-32a8,8,0,0,1,0-11.32l32-32A8,8,0,0,1,64,96v24H192V96a8,8,0,0,1,13.66-5.66l32,32A8,8,0,0,1,237.66,133.66Z');
const RESIZE = { 'ew-resize': 0, 'ns-resize': 90, 'nwse-resize': 45, 'nesw-resize': -45 };
// The busy shapes show a ball turning once a second, as macOS does, in its own colors whatever the cursor's `color`.
const BALL = ['#f5c400', '#f7862a', '#e8374f', '#a144c4', '#2f80ed', '#3dba4e'];

/** Paints `under` with a soft shadow, then `over` without; shadow sizes are device pixels, so they follow the box's scale on screen. */
function shadowed(ctx, under, over) {
  const { a, b } = ctx.getTransform(), pixels = Math.hypot(a, b) * 8; // about one CSS pixel at the default size
  ctx.save();
  ctx.lineJoin = 'round'; ctx.strokeStyle = OUTLINE;
  ctx.shadowColor = '#00000055'; ctx.shadowBlur = 2 * pixels; ctx.shadowOffsetY = pixels;
  under();
  ctx.shadowColor = 'transparent';
  over();
  ctx.restore();
}
const framed = (ctx, [area, regular, light], color, thin) => shadowed(ctx, () => { ctx.fillStyle = color; ctx.fill(area); }, () => { ctx.fillStyle = OUTLINE; ctx.fill(thin ? light : regular); });
/** The spinning ball at (x, y) with radius r, turned by `phase` of a turn: swirled wedges under a soft highlight. */
function ball(ctx, x, y, r, phase) {
  const swirl = 0.9, step = 2 * Math.PI / BALL.length, disc = new Path2D();
  disc.arc(x, y, r, 0, 2 * Math.PI);
  shadowed(ctx, () => { ctx.fillStyle = BALL[0]; ctx.fill(disc); }, () => {
    BALL.forEach((fill, i) => {
      const a = (i + phase * BALL.length) * step, wedge = new Path2D(), bend = angle => [x + r * 0.6 * Math.cos(angle - swirl), y + r * 0.6 * Math.sin(angle - swirl)];
      wedge.moveTo(x, y); wedge.quadraticCurveTo(...bend(a), x + r * Math.cos(a), y + r * Math.sin(a));
      wedge.arc(x, y, r, a, a + step + 0.02);
      wedge.quadraticCurveTo(...bend(a + step + 0.02), x, y);
      ctx.fillStyle = fill; ctx.fill(wedge);
    });
    const shine = ctx.createRadialGradient(x - r * 0.35, y - r * 0.45, 0, x - r * 0.35, y - r * 0.45, r * 1.1);
    shine.addColorStop(0, '#ffffff99'); shine.addColorStop(1, '#ffffff00');
    ctx.fillStyle = shine; ctx.fill(disc);
  });
}
/** Line pictures (one path or overlapping parts) with a dark edge `edge` grid units wide outside them. */
function ringed(ctx, lines, color, edge) {
  // One stroke for every part, so their shadows do not darken each other; each part fills on its own, whatever its winding.
  const parts = [lines].flat(), whole = new Path2D();
  parts.forEach(p => whole.addPath(p));
  shadowed(ctx, () => { ctx.lineWidth = edge * 2; ctx.stroke(whole); }, () => { ctx.fillStyle = color; parts.forEach(p => ctx.fill(p)); });
}

/**
 * `thin` draws every dark edge 12 grid units wide, as the light weight's lines are, instead of 16 as the
 * regular weight's are; either way the line pictures' edges match the outlined pictures'.
 */
export function draw(ctx, { shape, phase = 0, params }) {
  const color = params.color ?? '#ffffff', thin = Boolean(params.thin), edge = thin ? 12 : 16, [[x, y]] = GRID[shape];
  ctx.translate(-x, -y);
  if (shape in FRAMED) return framed(ctx, FRAMED[shape], color, thin);
  if (shape in RINGED) return ringed(ctx, RINGED[shape], color, edge);
  if (shape in RESIZE) {
    ctx.translate(128, 128); ctx.rotate(RESIZE[shape] * Math.PI / 180); ctx.translate(-128, -128);
    return ringed(ctx, DOUBLE_ARROW, color, edge);
  }
  if (shape === 'wait') return ball(ctx, 128, 128, 88, phase);
  // progress: the arrow with a small ball beside its tail, as macOS shows it.
  framed(ctx, FRAMED.default, color, thin);
  ball(ctx, 226, 178, 34, phase);
}
