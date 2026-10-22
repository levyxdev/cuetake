// A spark: `count` rays burst out from the click to `radius` CSS px, shrinking from `length` and fading.
// Rays are the cursor's color unless `color` is set, with a dark edge so they read on any page.
export const reach = ({ radius, length }) => radius + length + 8;

export function draw(ctx, { progress, params, cursor }) {
  const { radius, length: rayLength, count } = params, color = params.color ?? cursor.color ?? '#ffffff';
  const eased = 1 - (1 - progress) ** 3;
  const distance = 5 + eased * radius, length = rayLength * (1 - eased);
  ctx.globalAlpha = 1 - progress;
  ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const angle = 2 * Math.PI * i / count + Math.PI / 8;
    ctx.beginPath();
    ctx.moveTo(distance * Math.cos(angle), distance * Math.sin(angle));
    ctx.lineTo((distance + length) * Math.cos(angle), (distance + length) * Math.sin(angle));
    ctx.strokeStyle = '#171717'; ctx.lineWidth = 4.5; ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.stroke();
  }
}
