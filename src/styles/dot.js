// A round dot cursor filled with `color` and outlined in dark gray; its center is the hotspot.
// It draws only the default shape, so it stays a dot whatever the page asks for.
export const shapes = { default: { width: 24, height: 24, hotspot: [12, 12] } };

export function draw(ctx, { params }) {
  const pixels = ctx.getTransform().a;
  ctx.shadowColor = '#00000055'; ctx.shadowBlur = 2 * pixels; ctx.shadowOffsetY = pixels;
  ctx.beginPath(); ctx.arc(12, 12, 12, 0, 2 * Math.PI);
  ctx.fillStyle = params.color ?? '#ffffff'; ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 1.5; ctx.strokeStyle = '#171717'; ctx.beginPath(); ctx.arc(12, 12, 11.25, 0, 2 * Math.PI); ctx.stroke();
}
