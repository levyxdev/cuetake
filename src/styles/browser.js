// A browser window's top bar: traffic lights and a centered address field showing the url.
// Parameters: dark (a dark bar). Drawn in CSS pixels; CueTake clips it to the window's rounded top.
export const height = 44;

export function draw(ctx, { width, height, url, params }) {
  const t = params.dark
    ? { bar: '#2a2a2e', line: '#111113', field: '#3a3a40', fieldLine: '#4a4a52', text: '#d4d4d8', lock: '#a1a1aa' }
    : { bar: '#f3f3f5', line: '#d4d4d8', field: '#ffffff', fieldLine: '#e4e4e7', text: '#52525b', lock: '#71717a' };
  ctx.fillStyle = t.bar; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = t.line; ctx.fillRect(0, height - 1, width, 1);
  ['#ff5f57', '#febc2e', '#28c840'].forEach((light, i) => {
    ctx.beginPath(); ctx.arc(20 + i * 20, height / 2, 6, 0, 2 * Math.PI);
    ctx.fillStyle = light; ctx.fill(); ctx.strokeStyle = '#0000001f'; ctx.lineWidth = 0.5; ctx.stroke();
  });
  const w = 420, h = 28, x = (width - w) / 2, y = (height - h) / 2;
  ctx.beginPath(); ctx.roundRect(x, y, w, h, h / 2);
  ctx.fillStyle = t.field; ctx.fill(); ctx.strokeStyle = t.fieldLine; ctx.lineWidth = 0.8; ctx.stroke();
  ctx.font = '13px system-ui, -apple-system, sans-serif'; ctx.textBaseline = 'middle';
  const left = width / 2 - (ctx.measureText(url).width + 16) / 2;
  ctx.fillStyle = t.lock;   // padlock
  ctx.beginPath(); ctx.roundRect(left, y + 13, 9, 7, 1.5); ctx.fill();
  ctx.strokeStyle = t.lock; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.arc(left + 4.5, y + 13, 2.8, Math.PI, 0); ctx.stroke();
  ctx.fillStyle = t.text; ctx.fillText(url, left + 16, height / 2 + 0.5);
}
