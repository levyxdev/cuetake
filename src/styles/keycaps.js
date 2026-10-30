// Keycaps: one rounded cap per key of a Shortcut, in a row at the bottom right of the Final, level with the Subtitles.
// Parameters: symbols (macOS symbols such as ⌘ ⇧ ⌥ ⌃, or words such as Ctrl), fontSize, color, cap, edge, right, bottom.
// Drawn in 1080p pixels over the whole Final, outside the camera; `count` is how many times the keys were pressed.
const SYMBOLS = {
  Meta: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧', Enter: '↩', Escape: 'esc', Backspace: '⌫', Delete: '⌦', Tab: '⇥', CapsLock: '⇪',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', PageUp: '⇞', PageDown: '⇟', Home: '↖', End: '↘', Space: 'space',
};
const WORDS = {
  Meta: 'Cmd', Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Enter: 'Enter', Escape: 'Esc', Backspace: 'Backspace', Delete: 'Del', Tab: 'Tab',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', PageUp: 'PgUp', PageDown: 'PgDn', Space: 'Space',
};

export function draw(ctx, { width, height, keys, count, params, files }) {
  const { symbols = true, fontSize: size = 34, color = '#ffffff', cap = '#1f1f23e6', edge = '#ffffff40', right = 80, bottom = 80 } = params;
  const family = files.font ? `"${files.font}"` : '-apple-system, "SF Pro Text", "Helvetica Neue", "DejaVu Sans", system-ui, sans-serif';
  const labels = keys.map(key => (symbols ? SYMBOLS : WORDS)[key] ?? key);
  ctx.font = `600 ${size}px ${family}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const h = size * 1.9, gap = size * 0.3, padding = size * 0.55;
  const widths = labels.map(label => Math.max(h, ctx.measureText(label).width + 2 * padding));
  const times = count > 1 ? `×${count}` : '';
  const total = widths.reduce((sum, w) => sum + w, 0) + gap * (labels.length - 1) + (times ? gap + ctx.measureText(times).width : 0);
  let x = width - right - total;
  const y = height - bottom - h;
  labels.forEach((label, i) => {
    ctx.beginPath(); ctx.roundRect(x, y, widths[i], h, size * 0.35);
    ctx.shadowColor = '#00000059'; ctx.shadowBlur = size * 0.5; ctx.shadowOffsetY = size * 0.1;
    ctx.fillStyle = cap; ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 2; ctx.strokeStyle = edge; ctx.stroke();
    ctx.fillStyle = color; ctx.fillText(label, x + widths[i] / 2, y + h / 2);
    x += widths[i] + gap;
  });
  if (times) {
    ctx.textAlign = 'left'; ctx.lineWidth = 6; ctx.strokeStyle = cap; ctx.lineJoin = 'round';
    ctx.strokeText(times, x, y + h / 2); ctx.fillText(times, x, y + h / 2);
  }
}
