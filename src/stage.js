/**
 * Stage layout shared by Node and the render page. Pure functions, no imports.
 *
 * The stage is the Final's pixel grid at camera zoom 1: the page sits in a window (with an optional
 * chrome bar above it) inset by padding. The Background stays in output pixels whatever the camera does.
 */

/** The Final's pixel size. */
export const outputSize = edit => ({ width: edit.output.width, height: edit.output.height });

/** The Edit with its output scaled so the short side is `short` pixels; everything else scales with it. */
export function atShortSide(edit, short) {
  const { width, height } = edit.output, k = short / Math.min(width, height), even = n => Math.round(n * k / 2) * 2;
  return { ...edit, output: { ...edit.output, width: even(width), height: even(height) } };
}

/**
 * Where the window, its chrome and the page sit on the stage, in stage pixels. `chrome` is the chrome
 * bar's height in CSS pixels; `scale` is stage px per CSS px. The window is as large as fits inside the
 * padding and centered in it.
 */
export function layout(edit, viewport, chrome = 0) {
  const { width, height } = outputSize(edit), short = Math.min(width, height);
  const padding = [edit.frame.padding ?? 0].flat();
  const [top, right, bottom, left] = (padding.length === 4 ? padding : [padding[0], padding[0], padding[0], padding[0]]).map(p => p * short);
  const scale = Math.min((width - left - right) / viewport.width, (height - top - bottom) / (viewport.height + chrome));
  const w = viewport.width * scale, h = (viewport.height + chrome) * scale;
  const window = { x: left + (width - left - right - w) / 2, y: top + (height - top - bottom - h) / 2, w, h };
  return {
    width, height, scale, chrome: chrome * scale, radius: (edit.frame.radius ?? 0) * short / 1080,
    window, page: { x: window.x, y: window.y + chrome * scale, w, h: h - chrome * scale },
  };
}

/** Where stage point `p` shows in the Final, in output pixels, under the camera `view`. */
export const onScreen = (p, view, stage) => [(p[0] - view.x) * view.zoom + stage.width / 2, (p[1] - view.y) * view.zoom + stage.height / 2];

/**
 * The camera for a viewport crop: the stage point at the Final's center and the zoom. Zoom 1 shows
 * the whole stage; zooming keeps the view inside the stage, so the Background shows beside the page near its edges.
 */
export function cameraView(crop, stage, viewport) {
  const zoom = viewport.width / crop.w;
  const half = { x: stage.width / (2 * zoom), y: stage.height / (2 * zoom) };
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  return {
    x: clamp(stage.page.x + (crop.x + crop.w / 2) * stage.scale, half.x, stage.width - half.x),
    y: clamp(stage.page.y + (crop.y + crop.h / 2) * stage.scale, half.y, stage.height - half.y),
    zoom,
  };
}

/**
 * Whether a cue's Subtitles move to the top of the Final: at the bottom, where they cover `area`
 * ([x, y, w, h] output pixels), they would cover a target while the cue shows that they would not cover
 * as far from the top, and there they would cover none they do not cover at the bottom. A target counts
 * while the camera frames it, from `lead` before its action to `hold` after it ends; its box is in window
 * CSS pixels (zero-sized for a point) and its times in Final seconds. `cropAt(t)` is the camera's
 * viewport crop at Final time `t`.
 */
export function cueOnTop(cue, targets, area, camera) {
  const [x, y, w, h] = area, top = [x, camera.stage.height - y - h, w, h];
  const covered = targets.map(target => [covers(cue, target, area, camera), covers(cue, target, top, camera)]);
  return covered.some(([bottom, top]) => bottom && !top) && !covered.some(([bottom, top]) => top && !bottom);
}

/** Whether `area` covers, on screen, the target while the camera frames it during the cue (cueOnTop). */
function covers(cue, target, area, { stage, viewport, cropAt, fps, lead, hold }) {
  const [ax, ay, aw, ah] = area;
  const covered = (box, t) => {
    const view = cameraView(cropAt(t), stage, viewport);
    const screen = (x, y) => onScreen([stage.page.x + x * stage.scale, stage.page.y + y * stage.scale], view, stage);
    const [x0, y0] = screen(box.x, box.y), [x1, y1] = screen(box.x + box.width, box.y + box.height);
    return x0 <= ax + aw && x1 >= ax && y0 <= ay + ah && y1 >= ay;
  };
  const start = Math.max(cue.start, target.t - lead), end = Math.min(cue.end, (target.until ?? target.t) + hold);
  if (start > end) return false;
  const steps = Math.ceil((end - start) * fps);
  return Array.from({ length: steps + 1 }, (_, i) => Math.min(end, start + i / fps)).some(t => covered(target.box, t));
}

const hsl = (h, s, l) => {
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map(n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)));
};

/** The brand color shaders receive, as RGB from 0 to 1: the page's brand hue, or a neutral gray for a colorless page. */
export function brandColor(rgba) {
  const hue = brandHue(rgba);
  return hue === null ? [0.55, 0.56, 0.6] : hsl(hue, 0.75, 0.55);
}

/** The hue of the most frequent saturated color in RGBA pixels, or null for a colorless page. */
export function brandHue(rgba) {
  const buckets = new Map();
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], max = Math.max(r, g, b), min = Math.min(r, g, b);
    const saturation = max ? (max - min) / max : 0;
    if (saturation < 0.35) continue;
    const key = (r >> 5) * 64 + (g >> 5) * 8 + (b >> 5);
    const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0, saturation: 0 };
    bucket.n++; bucket.r += r; bucket.g += g; bucket.b += b; bucket.saturation += saturation;
    buckets.set(key, bucket);
  }
  const top = [...buckets.values()].sort((a, b) => b.saturation - a.saturation)[0];
  if (!top) return null;
  const [r, g, b] = [top.r, top.g, top.b].map(v => v / top.n / 255), max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  const hue = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return (hue + 360) % 360;
}

/**
 * Where Preview tiles sit on one sheet, in sheet pixels. A single tile is the sheet; several are shown
 * at half size in a grid of up to three columns, each with its label above it. Each row is as tall as
 * its tallest tile, so a portrait tile does not stretch the other rows.
 */
export function previewSheet(sizes) {
  if (sizes.length === 1) return { width: sizes[0].width, height: sizes[0].height, tiles: [{ x: 0, y: 0, w: sizes[0].width, h: sizes[0].height, label: null }] };
  const scale = 0.5, gap = 32, label = 44;
  const columns = sizes.length <= 4 ? 2 : 3, cellWidth = Math.max(...sizes.map(s => s.width)) * scale;
  const rows = Array.from({ length: Math.ceil(sizes.length / columns) }, (_, row) => Math.max(...sizes.slice(row * columns, (row + 1) * columns).map(s => s.height)) * scale);
  const rowTop = rows.map((_, row) => gap + rows.slice(0, row).reduce((sum, h) => sum + label + h + gap, 0));
  return {
    width: gap + columns * (cellWidth + gap), height: rowTop.at(-1) + label + rows.at(-1) + gap,
    tiles: sizes.map(({ width, height }, i) => {
      const x = gap + (i % columns) * (cellWidth + gap) + (cellWidth - width * scale) / 2, y = rowTop[Math.floor(i / columns)];
      return { x, y: y + label, w: width * scale, h: height * scale, label: { x, y: y + label / 2 } };
    }),
  };
}
