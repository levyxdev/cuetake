// Subtitles: centered rows of text in the space below the window, by default white with a black outline
// and a light shadow, so they read over any page without a band.
// Parameters: fontSize, weight, color, stroke (outline color, '' for none), strokeWidth (outline width
// outside the letters), shadow (#rrggbbaa, '' for none), shadowBlur, shadowOffset (downward),
// band (#rrggbbaa, '' for none: a rounded band behind the rows), padding (space between the band's edge
// and the rows).
// Drawn in 1080p pixels over the whole Final, outside the camera; a `font` in files replaces the system font.
export function draw(ctx, { width, height, below, rows, params, files }) {
  const {
    fontSize: size = 48, weight = 600, color = '#ffffff', stroke = '#000000', strokeWidth = 4,
    shadow = '#00000066', shadowBlur = 8, shadowOffset = 2, band = '', padding = 14,
  } = params;
  const family = files.font ? `"${files.font}"` : '-apple-system, "PingFang SC", "Helvetica Neue", system-ui, sans-serif';
  ctx.font = `${weight} ${size}px ${family}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const line = size * 1.3, w = Math.max(...rows.map(row => ctx.measureText(row).width)) + 2 * padding * 1.6;
  const h = rows.length * line + 2 * padding, y = height - (below + h) / 2;
  if (band) {
    ctx.fillStyle = band;
    ctx.beginPath(); ctx.roundRect((width - w) / 2, y, w, h, Math.min(12, h / 2)); ctx.fill();
  }
  const at = i => y + padding + line * (i + 0.5), outlined = Boolean(stroke) && strokeWidth > 0;
  // The shadow falls from the outermost pass only, so the outline and the letters do not cast it twice.
  const shadowed = paint => {
    if (shadow) Object.assign(ctx, { shadowColor: shadow, shadowBlur, shadowOffsetX: 0, shadowOffsetY: shadowOffset });
    paint();
    Object.assign(ctx, { shadowColor: 'transparent', shadowBlur: 0, shadowOffsetY: 0 });
  };
  if (outlined) {
    // A stroke is centered on the letters' edge; the fill drawn over it hides the inner half.
    Object.assign(ctx, { strokeStyle: stroke, lineWidth: 2 * strokeWidth, lineJoin: 'round' });
    shadowed(() => rows.forEach((row, i) => ctx.strokeText(row, width / 2, at(i))));
  }
  ctx.fillStyle = color;
  const fill = () => rows.forEach((row, i) => ctx.fillText(row, width / 2, at(i)));
  if (outlined) fill(); else shadowed(fill);
}
