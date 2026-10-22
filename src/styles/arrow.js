// The arrow cursor: filled with `color`, outlined in dark gray, with a soft shadow.
// Drawn in a 28×36 box whose tip at (2, 2) is the hotspot; CueTake scales the box to the cursor's size.
export const box = { width: 28, height: 36, hotspot: [2, 2] };
const ARROW = new Path2D('M2 2 L2 27 L8.5 21 L14 33 L19 30.5 L13.5 19 L23 19 Z');

export function draw(ctx, { params }) {
  // Shadow sizes are in device pixels, so scale them by the box's current size on screen.
  const pixels = ctx.getTransform().a;
  ctx.shadowColor = '#00000055'; ctx.shadowBlur = 2 * pixels; ctx.shadowOffsetY = pixels;
  ctx.fillStyle = params.color ?? '#ffffff'; ctx.fill(ARROW);
  ctx.shadowColor = 'transparent';
  ctx.lineJoin = 'round'; ctx.lineWidth = 1.7; ctx.strokeStyle = '#171717'; ctx.stroke(ARROW);
}
