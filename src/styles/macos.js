// A macOS app window's title bar: traffic lights only. Parameters: dark (a dark bar).
// Drawn in CSS pixels; CueTake clips it to the window's rounded top.
export const height = 28;

export function draw(ctx, { width, height, params }) {
  ctx.fillStyle = params.dark ? '#2a2a2e' : '#ececef'; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = params.dark ? '#111113' : '#d4d4d8'; ctx.fillRect(0, height - 1, width, 1);
  ['#ff5f57', '#febc2e', '#28c840'].forEach((light, i) => {
    ctx.beginPath(); ctx.arc(16 + i * 20, height / 2, 6, 0, 2 * Math.PI);
    ctx.fillStyle = light; ctx.fill(); ctx.strokeStyle = '#0000001f'; ctx.lineWidth = 0.5; ctx.stroke();
  });
}
