# Styling a Take

Everything drawn around the page is code or images you write: CueTake fills in defaults and renders what you give it, without validating. Check the result with `preview`; errors name the file and line.

## The Edit's styling

```json
{
  "output": { "width": 3840, "height": 2160, "quality": 22 },
  "frame": {
    "padding": 0.08, "radius": 12,
    "chrome": { "draw": "browser" },
    "background": [{ "shader": "fluted", "count": 36, "strength": 0.09, "angle": 0 }],
    "effects": [{ "shader": "shadow", "blur": 60, "offset": 24, "opacity": 0.5, "rim": 0.12 }]
  },
  "cursor": { "draw": "arrow", "size": 24, "color": "#ffffff", "press": 0.8, "hideAfter": 2.5 },
  "clickEffect": false,
  "subtitles": { "draw": "subtitles", "burn": true, "fontSize": 40, "weight": 600, "color": "#ffffff", "band": "#000000b3", "bottom": 72, "padding": 14 }
}
```

- `output`: any even width and height; `quality` is the H.264 quantizer, lower is sharper.
- `padding` is a fraction of the short side, one number or `[top, right, bottom, left]`; `radius` is in 1080p pixels. With `padding: 0`, `chrome: false`, `radius: 0` and an output at the viewport's proportions (2880×1800 for 1440×900), the page fills the Final.
- `background` is a list of layers, each drawn over the one before. It stays still while the camera moves the window.
- `effects` are drawn around the window every frame and follow it as the camera zooms and moves.
- `chrome`, `cursor` and `clickEffect` take `false` to show nothing.
- The Cursor takes the shape the page asked for at each moment, as the Timeline recorded it. CueTake reads `press` (the scale it shrinks to around its hotspot while a button is held, springing back on release) and `hideAfter` (seconds still before it fades out; it fades back in before it next moves) itself; `false` turns either off.
- A click shows on the Cursor, so there is no click effect by default. Name one, such as `{ "draw": "spark", "duration": 420, "radius": 32, "length": 16, "count": 8 }`, to add one.
- `subtitles` draws a Narration's Subtitles ([narration.md](narration.md)) over the Final, outside the camera. `burn: false` keeps them to the subtitle files. CueTake reads `maxChars` (characters per row), `maxRows` (rows per cue, 2) and `minDuration` (seconds, 1) itself. `files: { "font": "brand.woff2" }` sets the font, which burned-in Chinese, Japanese or Korean needs outside macOS.

An **item** names what draws it, `shader`, `draw` or `image`, as a built-in name or a file path with its extension, relative to the Look or Take. Every other key is a parameter for its code. Images also go in `files: { "photo": "photo.jpg" }`. Changing an item's parameters keeps the rest; naming a new drawing replaces the whole item.

Built-ins are ordinary files: `styles` lists their paths and starting parameters. Copy one to start your own. They are `fluted` and `shadow` (shaders), `browser`, `browser-dark`, `macos` and `macos-dark` (chrome), `arrow` (cursors: default, pointer, text, crosshair, grab, grabbing, move, not-allowed, the resize shapes, wait and progress) and `dot` (a dot whatever the page asks for), `spark` (click effect) and `subtitles`.

## Shaders: `background` and `effects`

Write only the body of a GLSL ES 3.0 fragment shader, with `main()` writing premultiplied `color`. CueTake declares:

- `uResolution` (output pixels), `uUnit` (output pixels per 1080p pixel), `uBrand` (the page's brand color, RGB 0–1).
- `uWindow` (window left, top, width, height in output pixels), `uRadius` (its corner radius), `uZoom` (camera zoom, 1 for the Background).
- `uPrevious`: the layers below for a Background layer, the whole Background for an effect. Read it with `previous(px)`.
- `uPage`: the page's first frame for the Background, the current frame for effects, sampled by 0–1 UV from the top left.
- `pixel()` (this pixel, from the top left) and `windowDistance(px)` (signed distance to the window's rounded edge).
- Each parameter as a uniform with its own name: a number or boolean is `float`, 2–4 numbers a `vec2`–`vec4`, `"#rrggbb"` a `vec3`. A parameter named like a declared uniform, such as `uBrand`, sets it instead.
- Each image in `files` as a `sampler2D` with its name, plus `<name>Size` in pixels.

Scale sizes by `uUnit` (and `uZoom` in effects), so Previews at 1080p match the 4K Final.

```glsl
// halo.glsl, used as { "shader": "halo.glsl", "tint": "#7c3aed", "spread": 0.07 }
void main() {
  float d = max(windowDistance(pixel()), 0.0) / uResolution.y;
  color = vec4(vec3(0.03) + tint * exp(-d / spread), 1.0);
}
```

## Drawing code: `chrome`, `cursor`, `clickEffect`, `subtitles`

An ES module drawing on a 2D canvas in CSS pixels. `params` holds the item's parameters, and `files` its images (as `<img>`) and fonts (`.woff2`, `.ttf`…, registered under their key as a font family).

- Chrome: `export const height` (CSS px), `export function draw(ctx, { width, height, radius, url, params, files })`. CueTake clips it to the window's rounded top.
- Cursor: `export const shapes = { default: { width, height, hotspot: [x, y] }, pointer: { … }, … }`, a box for each shape it draws, keyed by CSS cursor keyword, in its own units; `export function draw(ctx, { shape, params, files })` draws one shape in its box's units. The item's `size` sets the default shape's width in CSS px, and the other shapes share its scale. A shape the cursor does not draw shows as a close one (`progress` as `wait`, `col-resize` as `ew-resize`) or as `default`. Each shape is drawn once; CueTake scales and fades it.
- Click effect: `export const reach` (CSS px around the click, or a function of `params`), `export function draw(ctx, { progress, params, files, cursor })` with the origin at the click and `progress` from 0 to 1 over `duration` ms.
- Subtitles: `export function draw(ctx, { width, height, rows, params, files })` over the whole Final in 1080p pixels (1920×1080 for a 16:9 Final), once per cue; `rows` are the cue's lines of text. A font in `files` is its key: the built-in uses `files.font` when given.

An image works in place of code: chrome as wide as the window (`height` optional), a cursor with `hotspot` and `size` (its only shape, shown whatever the page asks for), a click effect that fades out.

## Files and the network

The render page has no network. Download any font or image the styling needs next to the Look or candidate file and name it by relative path. Files travel with the styling: `look apply` and `record --look` copy them into the Take's `styles/` folder, and `look save` keeps them in a folder Look.
