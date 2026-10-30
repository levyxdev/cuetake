// Fast-forward badge: two arrowheads and the span's rate on a rounded band at the top right of the Final.
// Parameters: fontSize, color, band (#rrggbbaa, '' for none), right, top.
// Drawn in 1080p pixels over the whole Final, outside the camera, while it fast-forwards; `rate` is the span's rate.
export function draw(ctx, { width, rate, params, files }) {
  const { fontSize: size = 30, color = '#ffffff', band = '#000000a6', right = 80, top = 72 } = params;
  const family = files.font ? `"${files.font}"` : '-apple-system, "SF Pro Text", "Helvetica Neue", "DejaVu Sans", system-ui, sans-serif';
  const label = `${+rate.toFixed(2)}×`;
  ctx.font = `600 ${size}px ${family}`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const h = size * 1.8, padding = size * 0.6, arrow = size * 0.5, gap = size * 0.35;
  const w = padding + 2 * arrow + gap + ctx.measureText(label).width + padding;
  const x = width - right - w, y = top, middle = y + h / 2;
  if (band) {
    ctx.fillStyle = band;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, h / 2); ctx.fill();
  }
  ctx.fillStyle = color;
  for (const left of [x + padding, x + padding + arrow]) {
    ctx.beginPath(); ctx.moveTo(left, middle - arrow * 0.7); ctx.lineTo(left + arrow, middle); ctx.lineTo(left, middle + arrow * 0.7); ctx.closePath(); ctx.fill();
  }
  ctx.fillText(label, x + padding + 2 * arrow + gap, middle);
}
