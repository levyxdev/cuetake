/**
 * Stage layout shared by Node and the render page. Pure functions, no imports.
 *
 * The stage is the Final's pixel grid. With a frame, the page sits in a window (optional chrome
 * bar above it) centered on a background, inset by padding. Without one, the page fills the stage.
 */

const even = n => Math.round(n / 2) * 2;
const SHORT_SIDE = { '1080p': 1080, '1440p': 1440, '2160p': 2160 };
/** Chrome bar heights in page CSS pixels. */
export const CHROME_HEIGHT = { none: 0, macos: 28, browser: 44 };

/** The Final's pixel size. `size` names the short side; `aspect` is ignored without a frame. */
export function outputSize(edit, viewport) {
  const short = SHORT_SIDE[edit.output.size] ?? edit.output.size;
  if (!edit.frame) return viewport.width >= viewport.height
    ? { width: even(short * viewport.width / viewport.height), height: short }
    : { width: short, height: even(short * viewport.height / viewport.width) };
  const long = even(short * 16 / 9);
  return { '16:9': { width: long, height: short }, '9:16': { width: short, height: long }, '1:1': { width: short, height: short } }[edit.output.aspect];
}

/** Where the window, its chrome and the page sit on the stage, in stage pixels. `scale` is stage px per CSS px. */
export function layout(edit, viewport) {
  const { width, height } = outputSize(edit, viewport);
  if (!edit.frame) {
    const scale = width / viewport.width;
    return { width, height, scale, chrome: 0, radius: 0, page: { x: 0, y: 0, w: width, h: height }, window: { x: 0, y: 0, w: width, h: height } };
  }
  const pad = Math.min(width, height) * edit.frame.padding;
  const chromeCss = CHROME_HEIGHT[edit.frame.window];
  const scale = Math.min((width - 2 * pad) / viewport.width, (height - 2 * pad) / (viewport.height + chromeCss));
  const w = viewport.width * scale, h = (viewport.height + chromeCss) * scale;
  const window = { x: (width - w) / 2, y: (height - h) / 2, w, h };
  const chrome = chromeCss * scale;
  return {
    width, height, scale, chrome, radius: edit.frame.radius * Math.min(width, height) / 1080,
    window, page: { x: window.x, y: window.y + chrome, w, h: h - chrome },
  };
}

/**
 * The camera for a viewport crop: the stage point at the Final's center and the zoom. Zoom 1 shows
 * the whole stage; zooming keeps the view inside the stage, so background shows near page edges.
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

/** Mesh backgrounds: a base color under soft radial blobs [x, y, radius] as fractions of the stage. */
export const BACKGROUNDS = {
  aurora: { base: '#1e1b4b', blobs: [[0.15, 0.2, 0.7, '#7c3aed'], [0.85, 0.15, 0.6, '#db2777'], [0.7, 0.9, 0.75, '#2563eb'], [0.2, 0.85, 0.55, '#0ea5e9']] },
  sunset: { base: '#431407', blobs: [[0.1, 0.15, 0.7, '#f97316'], [0.9, 0.25, 0.65, '#e11d48'], [0.6, 0.95, 0.7, '#a21caf'], [0.25, 0.8, 0.45, '#facc15']] },
  ocean: { base: '#082f49', blobs: [[0.2, 0.1, 0.65, '#14b8a6'], [0.85, 0.3, 0.7, '#0284c7'], [0.4, 0.95, 0.75, '#1e3a8a'], [0.95, 0.9, 0.4, '#22d3ee']] },
  graphite: { base: '#0a0a0a', blobs: [[0.3, 0.2, 0.7, '#3f3f46'], [0.8, 0.8, 0.7, '#27272a']] },
  paper: { base: '#f4f4f5', blobs: [[0.5, 0, 0.8, '#ffffff'], [0.5, 1.1, 0.7, '#e4e4e7']] },
};

const hsl = (h, s, l) => {
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return '#' + [f(0), f(8), f(4)].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
};

/** A mesh around a brand hue, as picked by `brandHue`. */
export function autoBackground(hue) {
  return { base: hsl(hue, 0.55, 0.12), blobs: [[0.15, 0.2, 0.7, hsl(hue, 0.8, 0.55)], [0.85, 0.15, 0.6, hsl((hue + 40) % 360, 0.75, 0.55)], [0.7, 0.9, 0.75, hsl((hue + 330) % 360, 0.8, 0.5)], [0.2, 0.85, 0.55, hsl((hue + 20) % 360, 0.7, 0.35)]] };
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
