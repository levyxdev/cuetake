// Subtitles: centered rows of text on a rounded band near the bottom of the Final.
// Parameters: fontSize, weight, color, band (#rrggbbaa, '' for none), bottom (gap below the band), padding.
// Drawn in 1080p pixels over the whole Final, outside the camera; a `font` in files replaces the system font.
export function draw(ctx, { width, height, rows, params, files }) {
  const { fontSize: size = 40, weight = 600, color = '#ffffff', band = '#000000b3', bottom = 72, padding = 14 } = params;
  const family = files.font ? `"${files.font}"` : '-apple-system, "PingFang SC", "Helvetica Neue", system-ui, sans-serif';
  ctx.font = `${weight} ${size}px ${family}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const line = size * 1.3, w = Math.max(...rows.map(row => ctx.measureText(row).width)) + 2 * padding * 1.6;
  const h = rows.length * line + 2 * padding, y = height - bottom - h;
  if (band) {
    ctx.fillStyle = band;
    ctx.beginPath(); ctx.roundRect((width - w) / 2, y, w, h, Math.min(12, h / 2)); ctx.fill();
  }
  ctx.fillStyle = color;
  rows.forEach((row, i) => ctx.fillText(row, width / 2, y + padding + line * (i + 0.5)));
}
