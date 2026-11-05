/**
 * Runs inside Chromium (see render.js). Source WebM → VideoDecoder → WebGL2 → VideoEncoder (H.264) →
 * MP4, streamed back to Node in chunks.
 *
 * Each output frame is the Background (drawn once, still in output pixels), the window effects (drawn
 * every frame around the window as the camera moves it), the page, then the chrome; each popup window
 * over it the same way; then click effects and the Cursor, and outside the camera the Subtitles and
 * keycaps. Masks (masks.js) blur or cover parts of a page as it is drawn, and spotlights dim around
 * part of one over its chrome. Everything but the pages and masks is agent-written shaders, drawing code or images (ADR 0005). Each
 * Tab has its own Source (ADR 0008); tabs.js says which show at each moment.
 *
 * Spaces: camera crops are CSS pixels of the viewport, the window's, which each Tab's input is moved
 * into (tabs.js); the Source textures are sampled by UV only;
 * "stage" is the Final's pixels at camera zoom 1, laid out by stage.js.
 *
 * Times: the Timeline and the Edit are in Source time, the Final in its own, and time-map.js maps
 * between them. The page's own motion (the Source, the Cursor, click effects) plays at the Final
 * moment's Source time, so it fast-forwards with the page; the camera, keycaps, Subtitles and audio
 * keep their pace in Final time.
 */
import * as MB from '/mediabunny.js';
import { cameraTrack } from '/camera.js';
import { cursorTrack, drawnShape, pointerAt, presses, sparksAt } from '/cursor.js';
import { layout, outputSize, cameraView, previewSheet, brandColor } from '/stage.js';
import { burnsIn, cuesFor, lineProblems } from '/narration.js';
import { keycapTrack } from '/shortcuts.js';
import { badgeAt, linesInFinal, retimed, timeMap } from '/time-map.js';
import { inWindow, tabTrack, windowMaps } from '/tabs.js';
import { cropAt, exposure, moments, shutterOf } from '/shutter.js';
import { mergedPast, maskProblems, maskTrack } from '/masks.js';

const VERTEX = `#version 300 es
in vec2 p; void main() { gl_Position = vec4(p, 0, 1); }`;
/** Prepended to every agent shader, whose own source then starts at line 1. */
const SHADER_HEADER = `#version 300 es
precision highp float;
uniform vec2 uResolution;      // output pixels
uniform float uUnit;           // output pixels per 1080p pixel
uniform vec3 uBrand;           // the page's brand color, RGB 0–1
uniform sampler2D uPrevious;   // Background layers: the layers below; window effects: the Background
uniform sampler2D uPage;       // the page: its first frame for Background layers, the current one for window effects
uniform vec4 uWindow;          // the window (chrome + page) in output pixels: left, top, width, height
uniform float uRadius;         // the window's corner radius in output pixels
uniform float uZoom;           // the camera zoom; 1 for Background layers
out vec4 color;                // premultiplied RGBA
#define main cuetakeMain
vec2 pixel() { return vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y); }
vec4 previous(vec2 px) { return texture(uPrevious, vec2(px.x, uResolution.y - px.y) / uResolution); }
float windowDistance(vec2 px) {
  vec2 q = abs(px - uWindow.xy - uWindow.zw * 0.5) - (uWindow.zw * 0.5 - uRadius);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;
}
`;
const HEADER_UNIFORMS = new Set(['uResolution', 'uUnit', 'uBrand', 'uPrevious', 'uPage', 'uWindow', 'uRadius', 'uZoom', 'uOpacity']);
/** Appended to every agent shader: CueTake fades its output, such as a popup window's shadow as it opens. */
const SHADER_FOOTER = `
#undef main
uniform float uOpacity;
void main() { cuetakeMain(); color *= uOpacity; }`;
// An image layer is drawn over the layers below it.
const IMAGE_LAYER = `uniform sampler2D image;
void main() { vec4 top = texture(image, pixel() / uResolution); color = top + previous(pixel()) * (1.0 - top.a); }`;
const BLIT = `#version 300 es
precision highp float;
uniform sampler2D uImage; uniform vec2 uRes; uniform float uAlpha; out vec4 color;
void main() { color = texture(uImage, gl_FragCoord.xy / uRes) * uAlpha; }`;
// Rounded boxes in stage pixels, shared by the page and the spotlight.
const ROUNDED_BOX = `
float roundedBox(vec2 p, vec4 rect, float r) {
  vec2 q = abs(p - rect.xy - rect.zw * 0.5) - (rect.zw * 0.5 - r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}`;
/** How many boxes one pass of the page or a spotlight takes; more are merged into the last (masks.js). */
const MASK_BOXES = 32;
// A page inside its window's rounded rectangle, below the chrome, under the camera. Its blurred and
// covered masks are drawn with it, replacing the page where they sit, so a page fading in or out never
// shows what they hide. Each hidden box has a style: its corner radius, 0 to blur or 1 to cover, and
// the blur's mip level; covers have a color.
const PAGE = `#version 300 es
precision highp float;
uniform vec2 uRes; uniform vec3 uCam; uniform vec4 uPage; uniform vec4 uWindow; uniform float uRadius; uniform float uAlpha;
uniform sampler2D uSource;
uniform int uHidden; uniform vec4 uHideRect[${MASK_BOXES}]; uniform vec4 uHideStyle[${MASK_BOXES}]; uniform vec4 uHideColor[${MASK_BOXES}];
out vec4 color;
${ROUNDED_BOX}
// A Gaussian over 7×7 taps of a mip level, two taps to a standard deviation: unreadable, and cheap at any size.
vec3 blurred(vec2 uv, float lod) {
  vec2 step = exp2(lod) / vec2(textureSize(uSource, 0));
  vec3 sum = vec3(0.0); float total = 0.0;
  for (int i = -3; i <= 3; i++) for (int j = -3; j <= 3; j++) {
    float w = exp(-float(i * i + j * j) / 8.0);
    sum += textureLod(uSource, clamp(uv + vec2(i, j) * step, 0.0, 1.0), lod).rgb * w; total += w;
  }
  return sum / total;
}
void main() {
  vec2 pixel = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 stage = (pixel - uRes * 0.5) / uCam.z + uCam.xy;
  float inside = clamp(0.5 - roundedBox(stage, uWindow, uRadius) * uCam.z, 0.0, 1.0);
  if (inside <= 0.0 || stage.y < uPage.y) discard;
  vec2 uv = clamp((stage - uPage.xy) / uPage.zw, 0.0, 1.0);
  vec3 rgb = texture(uSource, uv).rgb;
  for (int i = 0; i < ${MASK_BOXES}; i++) {
    if (i >= uHidden) break;
    vec4 r = uHideRect[i], style = uHideStyle[i];
    float hidden = clamp(0.5 - roundedBox(stage, r, min(style.x, 0.5 * min(r.z, r.w))) * uCam.z, 0.0, 1.0);
    if (hidden > 0.0) rgb = mix(rgb, style.y > 0.5 ? uHideColor[i].rgb : blurred(uv, style.z), hidden);
  }
  color = vec4(rgb, 1.0) * inside * uAlpha;
}`;
// A spotlight: everything outside its boxes dimmed, the light falling off over `uFeather` stage pixels across their edge.
const SPOTLIGHT = `#version 300 es
precision highp float;
uniform vec2 uRes; uniform vec3 uCam; uniform int uCount; uniform vec4 uRects[${MASK_BOXES}];
uniform float uCorner; uniform float uFeather; uniform vec4 uColor; uniform float uAlpha;
out vec4 color;
${ROUNDED_BOX}
void main() {
  vec2 pixel = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 stage = (pixel - uRes * 0.5) / uCam.z + uCam.xy;
  float d = 1e9;
  for (int i = 0; i < ${MASK_BOXES}; i++) {
    if (i >= uCount) break;
    vec4 r = uRects[i];
    d = min(d, roundedBox(stage, r, min(uCorner, 0.5 * min(r.z, r.w))));
  }
  // The light falls off across the region's edge, half inside it and half out.
  float soft = max(uFeather, 1.0 / uCam.z) * 0.5;
  float a = uColor.a * uAlpha * smoothstep(-soft, soft, d);
  color = vec4(uColor.rgb * a, a);
}`;
// Sprites (chrome, cursor, click effects) are premultiplied textures placed by a stage rectangle under the camera.
const SPRITE_VERTEX = `#version 300 es
in vec2 p;
uniform vec2 uRes; uniform vec3 uCam; uniform vec4 uRect;
out vec2 uv;
void main() {
  vec2 pixel = (uRect.xy + p * uRect.zw - uCam.xy) * uCam.z + uRes * 0.5;
  gl_Position = vec4(pixel.x / uRes.x * 2.0 - 1.0, 1.0 - pixel.y / uRes.y * 2.0, 0, 1);
  uv = p;
}`;
const SPRITE_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uSprite; uniform float uAlpha;
in vec2 uv; out vec4 color;
void main() { color = texture(uSprite, uv) * uAlpha; }`;

// Item keys CueTake reads itself; every other key is a parameter for the item's shader or drawing code.
const OWN_KEYS = new Set(['shader', 'draw', 'image', 'files', 'ref', 'kind', 'url']);
const SLOT_KEYS = new Set(['size', 'hotspot', 'press', 'duration', 'singleKeys', 'reach', 'height', 'burn', 'maxChars', 'maxRows', 'minDuration']);
const paramsOf = item => Object.fromEntries(Object.entries(item).filter(([key]) => !OWN_KEYS.has(key) && (item.kind === 'shader' || !SLOT_KEYS.has(key))));
const fail = (item, error) => new Error(`${item.ref}: ${error?.message ?? error}`);

/** A parameter as a GLSL uniform: numbers and booleans are floats, 2–4 numbers a vector, '#rrggbb(aa)' a color. */
function uniformOf(value) {
  if (typeof value === 'number') return ['float', [value]];
  if (typeof value === 'boolean') return ['float', [value ? 1 : 0]];
  if (Array.isArray(value) && value.length >= 2 && value.length <= 4 && value.every(n => typeof n === 'number')) return [`vec${value.length}`, value];
  if (typeof value === 'string' && /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) {
    const channels = value.slice(1).match(/../g).map(h => parseInt(h, 16) / 255);
    return [`vec${channels.length}`, channels];
  }
  return null;
}

async function loadImage(item, url) {
  const image = new Image();
  image.src = url;
  try { await image.decode(); } catch { throw fail(item, `${url.split('/').pop()} is not an image the browser can open`); }
  return image;
}
const FONT = /\.(woff2?|ttf|otf)$/i;
/** An item's `files` for drawing code: images as <img> elements, fonts registered under their key. */
async function loadFiles(item) {
  const loaded = {};
  for (const [name, url] of Object.entries(item.files ?? {})) {
    if (FONT.test(url)) {
      const face = new FontFace(name, `url(${url})`);
      try { await face.load(); } catch (error) { throw fail(item, error); }
      document.fonts.add(face); loaded[name] = name;
    } else loaded[name] = await loadImage(item, url);
  }
  return loaded;
}
async function loadModule(item) {
  try { return await import(item.url); } catch (error) { throw fail(item, error); }
}
const canvas2d = (width, height) => {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width)); canvas.height = Math.max(1, Math.ceil(height));
  return canvas.getContext('2d');
};

/** The compositor for one stage: the Background drawn once, then per frame each window's effects, page and chrome, and sprites. */
function createCompositor(stage, brand) {
  const { width, height } = stage, unit = Math.min(width, height) / 1080;
  const canvas = new OffscreenCanvas(width, height);
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false });
  const compile = (type, text, item) => {
    const s = gl.createShader(type); gl.shaderSource(s, text); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw item ? fail(item, gl.getShaderInfoLog(s).trim()) : new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const program = (vertex, fragment, item) => {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vertex, item)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragment, item));
    gl.bindAttribLocation(p, 0, 'p');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw item ? fail(item, gl.getProgramInfoLog(p)) : new Error(gl.getProgramInfoLog(p));
    gl.useProgram(p);
    for (const name of ['uRes', 'uResolution']) gl.uniform2f(gl.getUniformLocation(p, name), width, height);
    return { p, camera: gl.getUniformLocation(p, 'uCam'), uniform: name => gl.getUniformLocation(p, name) };
  };
  const quad = corners => {
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(corners), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    return vao;
  };
  const texture = (filter = gl.LINEAR_MIPMAP_LINEAR) => {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const imageTexture = image => {
    const t = texture(); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image); gl.generateMipmap(gl.TEXTURE_2D);
    return t;
  };
  const bind = (unitIndex, t) => { gl.activeTexture(gl.TEXTURE0 + unitIndex); gl.bindTexture(gl.TEXTURE_2D, t); };
  const fullScreen = quad([-1, -1, 1, -1, -1, 1, 1, 1]), unitQuad = quad([0, 0, 1, 0, 0, 1, 1, 1]);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.viewport(0, 0, width, height);

  const pageProgram = program(VERTEX, PAGE), spotlightProgram = program(VERTEX, SPOTLIGHT);
  const blitProgram = program(VERTEX, BLIT);
  const spriteProgram = program(SPRITE_VERTEX, SPRITE_FRAGMENT), spriteRect = spriteProgram.uniform('uRect'), spriteAlpha = spriteProgram.uniform('uAlpha');

  /** An agent shader with its parameters declared and set, and its `files` bound from texture unit 2. */
  async function agentProgram(item, source) {
    const params = Object.entries(paramsOf(item)).map(([name, value]) => [name, uniformOf(value)]).filter(([name, u]) => u && /^[A-Za-z_]\w*$/.test(name));
    const images = await Promise.all(Object.entries(item.files ?? {}).map(async ([name, url]) => [name, await loadImage(item, url)]));
    const declarations = [
      ...params.filter(([name]) => !HEADER_UNIFORMS.has(name)).map(([name, [type]]) => `uniform ${type} ${name};`),
      ...images.flatMap(([name]) => [`uniform sampler2D ${name};`, `uniform vec2 ${name}Size;`]),
    ].join('\n');
    const p = program(VERTEX, `${SHADER_HEADER}${declarations}\n#line 1\n${source}\n${SHADER_FOOTER}`, item);
    gl.uniform1f(p.uniform('uUnit'), unit); gl.uniform3f(p.uniform('uBrand'), ...brand); gl.uniform1f(p.uniform('uOpacity'), 1);
    gl.uniform1i(p.uniform('uPrevious'), 0); gl.uniform1i(p.uniform('uPage'), 1);
    for (const [name, [type, values]] of params) gl[`uniform${type === 'float' ? 1 : type.at(-1)}fv`](p.uniform(name), values);
    const textures = images.map(([name, image], i) => {
      gl.useProgram(p.p); gl.uniform1i(p.uniform(name), 2 + i); gl.uniform2f(p.uniform(`${name}Size`), image.naturalWidth, image.naturalHeight);
      return imageTexture(image);
    });
    return { ...p, textures };
  }
  const shaderSource = async item => {
    const response = await fetch(item.url);
    if (!response.ok) throw fail(item, `could not be read (${response.status})`);
    return response.text();
  };
  /** Draws one program over the full screen with uPrevious and uPage bound; window uniforms in output pixels. */
  const run = (p, previous, page, windowRect, radius, zoom, opacity = 1) => {
    gl.useProgram(p.p);
    gl.uniform4f(p.uniform('uWindow'), ...windowRect); gl.uniform1f(p.uniform('uRadius'), radius); gl.uniform1f(p.uniform('uZoom'), zoom); gl.uniform1f(p.uniform('uOpacity'), opacity);
    bind(0, previous); bind(1, page);
    p.textures?.forEach((t, i) => bind(2 + i, t));
    gl.bindVertexArray(fullScreen); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.activeTexture(gl.TEXTURE0);
  };
  const checkGpu = what => { if (gl.isContextLost()) throw new Error(`${what} stopped the GPU; simplify the shader`); };

  const target = (format = gl.RGBA8) => { const t = texture(gl.LINEAR); gl.texStorage2D(gl.TEXTURE_2D, 1, format, width, height); return t; };
  const framebuffer = gl.createFramebuffer();
  let background = target(), effects = [];
  const restWindow = [stage.window.x, stage.window.y, stage.window.w, stage.window.h];
  const blit = (image, alpha = 1) => { gl.useProgram(blitProgram.p); gl.uniform1f(blitProgram.uniform('uAlpha'), alpha); bind(0, image); gl.bindVertexArray(fullScreen); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); };
  const drawInto = (buffer, image) => { gl.bindFramebuffer(gl.FRAMEBUFFER, buffer); if (buffer) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, image, 0); };

  // Motion blur averages moments in a half-float buffer, so many faint moments add up without banding.
  // Without float render targets the Final shows one sharp moment per frame. The buffers are made on
  // the first blurred frame, so a Final without blur holds no extra GPU memory.
  const blurs = !!gl.getExtension('EXT_color_buffer_float');
  const momentBuffer = gl.createFramebuffer(), sumBuffer = gl.createFramebuffer();
  let layer = null, sum = null;
  /**
   * Draws `count` moments of premultiplied content over the frame so far, averaged: each moment over a
   * clear layer, the layers summed at 1/count each, the sum drawn over the frame. Averaging the layers
   * then drawing them over is the average of drawing each over, since the frame below is the same for
   * all. `area`, [x, y, w, h] in output pixels with y down, bounds what the moments draw.
   */
  const averaged = (count, drawMoment, area) => {
    if (count === 1) return drawMoment(0);
    layer ??= target(); sum ??= target(gl.RGBA16F);
    if (area) { gl.enable(gl.SCISSOR_TEST); gl.scissor(Math.floor(area[0]), Math.floor(height - area[1] - area[3]), Math.ceil(area[2]) + 1, Math.ceil(area[3]) + 1); }
    drawInto(sumBuffer, sum); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    for (let i = 0; i < count; i++) {
      drawInto(momentBuffer, layer); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); drawMoment(i);
      drawInto(sumBuffer, sum); gl.blendFunc(gl.ONE, gl.ONE); blit(layer, 1 / count);
    }
    drawInto(null); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); blit(sum);
    gl.disable(gl.SCISSOR_TEST);
  };
  return {
    canvas,
    /** Whether the GPU can average moments for motion blur. */
    blurs,
    gpu: (() => { const info = gl.getExtension('WEBGL_debug_renderer_info'); return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown'; })(),
    /** The widest and tallest texture the GPU holds; a larger sprite would draw black. */
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    /** Frees the GPU context; a Preview makes one compositor per tile. */
    dispose() { gl.getExtension('WEBGL_lose_context')?.loseContext(); },
    /** A texture for a Source `width` × `height`, which `upload` fills with each frame. */
    pageTexture(width, height) {
      // Mipmaps keep zoomed-out text from aliasing when the 2× Source is minified.
      const t = texture();
      gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(width, height))) + 1, gl.RGBA8, width, height);
      return t;
    },
    upload(page, frame) {
      gl.bindTexture(gl.TEXTURE_2D, page);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      gl.generateMipmap(gl.TEXTURE_2D);
    },
    /** Draws the Background layers in order, each over the result so far, starting from black; they see `page`. */
    async drawBackground(layers, page) {
      let other = target();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, background, 0);
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      for (const item of layers) {
        let p;
        if (item.kind === 'image') {
          // Cover the output, centered, at full resolution (SVG rasterizes at this size).
          const image = await loadImage(item, item.url), w = image.naturalWidth || width, h = image.naturalHeight || height;
          const k = Math.max(width / w, height / h), ctx = canvas2d(width, height);
          ctx.drawImage(image, (width - w * k) / 2, (height - h * k) / 2, w * k, h * k);
          p = await agentProgram({ ref: item.ref, kind: 'shader' }, IMAGE_LAYER);
          p.textures = [imageTexture(ctx.canvas)]; gl.uniform1i(p.uniform('image'), 2);
        } else if (item.kind === 'shader') p = await agentProgram(item, await shaderSource(item));
        else throw fail(item, 'Background layers are shaders or images');
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, other, 0);
        gl.disable(gl.BLEND);
        run(p, background, page, restWindow, stage.radius, 1);
        [background, other] = [other, background];
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      checkGpu('A Background layer');
    },
    async loadEffects(items) {
      effects = [];
      for (const item of items) {
        if (item.kind !== 'shader') throw fail(item, 'window effects are shaders');
        effects.push(await agentProgram(item, await shaderSource(item)));
      }
    },
    /** A sprite texture from a 2D canvas; pass `into` to reuse one. */
    sprite(image, into, mipmaps = true) {
      const t = into ?? texture(mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
      return t;
    },
    /**
     * One frame over the Background. Under each of `views`, the camera ({ x, y, zoom }: the stage point
     * at the Final's center) at the moments the frame averages, each of `windows` is drawn in order, each
     * `{ page, pageRect, window, radius, opacity, effects, chrome: { texture, rect }, hidden, spotlights }`
     * in stage pixels, with the window effects around it when `effects`, its blurred and covered boxes
     * (`hidden`: `{ count, rects, styles, colors }`) drawn with the page and its `spotlights` (`{ count,
     * rects, corner, feather, color, opacity }`) over it and its chrome, and `draw(texture, rect, opacity)` in `overlay`
     * places sprites in stage pixels. Then each of `cursors`, `{ view, texture, rect }` at the moments
     * the Cursor averages, within `cursorArea` in output pixels; and `screen` places sprites in output
     * pixels, outside the camera. Several views or cursors need `blurs`.
     */
    frame(views, windows, overlay, cursors, cursorArea, screen) {
      drawInto(null);
      gl.disable(gl.BLEND); blit(background); gl.enable(gl.BLEND);
      const place = (t, rect, opacity = 1) => { gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform4f(spriteRect, ...rect); gl.uniform1f(spriteAlpha, opacity); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); };
      const sprites = ({ x, y, zoom }) => { gl.useProgram(spriteProgram.p); gl.uniform3f(spriteProgram.camera, x, y, zoom); gl.bindVertexArray(unitQuad); };
      averaged(views.length, i => {
        const view = views[i], { x, y, zoom } = view;
        for (const w of windows) {
          const shown = [(w.window.x - x) * zoom + width / 2, (w.window.y - y) * zoom + height / 2, w.window.w * zoom, w.window.h * zoom];
          if (w.effects) for (const p of effects) run(p, background, w.page, shown, w.radius * zoom, zoom, w.opacity);
          gl.useProgram(pageProgram.p); gl.uniform3f(pageProgram.camera, x, y, zoom);
          gl.uniform4f(pageProgram.uniform('uPage'), w.pageRect.x, w.pageRect.y, w.pageRect.w, w.pageRect.h);
          gl.uniform4f(pageProgram.uniform('uWindow'), w.window.x, w.window.y, w.window.w, w.window.h);
          gl.uniform1f(pageProgram.uniform('uRadius'), w.radius); gl.uniform1f(pageProgram.uniform('uAlpha'), w.opacity);
          gl.uniform1i(pageProgram.uniform('uHidden'), w.hidden?.count ?? 0);
          if (w.hidden?.count) {
            gl.uniform4fv(pageProgram.uniform('uHideRect'), w.hidden.rects); gl.uniform4fv(pageProgram.uniform('uHideStyle'), w.hidden.styles); gl.uniform4fv(pageProgram.uniform('uHideColor'), w.hidden.colors);
          }
          bind(0, w.page); gl.bindVertexArray(fullScreen); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          if (w.chrome) { sprites(view); place(w.chrome.texture, w.chrome.rect, w.opacity); }
          for (const light of w.spotlights ?? []) {
            gl.useProgram(spotlightProgram.p); gl.uniform3f(spotlightProgram.camera, x, y, zoom);
            gl.uniform1i(spotlightProgram.uniform('uCount'), light.count); gl.uniform4fv(spotlightProgram.uniform('uRects'), light.rects);
            gl.uniform1f(spotlightProgram.uniform('uCorner'), light.corner); gl.uniform1f(spotlightProgram.uniform('uFeather'), light.feather);
            gl.uniform4f(spotlightProgram.uniform('uColor'), ...light.color); gl.uniform1f(spotlightProgram.uniform('uAlpha'), light.opacity * w.opacity);
            gl.bindVertexArray(fullScreen); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          }
        }
        sprites(view);
        overlay(place);
      });
      if (cursors.length) averaged(cursors.length, i => { sprites(cursors[i].view); place(cursors[i].texture, cursors[i].rect); }, cursorArea);
      if (screen) { sprites({ x: width / 2, y: height / 2, zoom: 1 }); screen(place); }
      if (effects.length) checkGpu('A window effect');
    },
  };
}

/**
 * The chrome bar: drawing code exporting `height` (CSS px) and `draw(ctx, { width, height, radius, url,
 * params, files })`, or an image as wide as the window. `canvas(width, scale, radius, url)` rasterizes
 * it `width` CSS px wide, the window's or a popup window's, with the address bar showing `url`, clipped
 * to the window's rounded top.
 */
async function loadChrome(item, windowWidth) {
  let height, paint;
  if (item.kind === 'image') {
    const image = await loadImage(item, item.url);
    height = item.height ?? image.naturalHeight * windowWidth / image.naturalWidth;
    paint = (ctx, width) => ctx.drawImage(image, 0, 0, width, height);
  } else {
    const module = await loadModule(item), files = await loadFiles(item), params = paramsOf(item);
    height = item.height ?? (typeof module.height === 'function' ? module.height(params) : module.height) ?? 0;
    paint = (ctx, width, radius, url) => module.draw(ctx, { width, height, radius, url, params, files });
  }
  return {
    height,
    canvas(width, scale, radius, url) {
      const ctx = canvas2d(width * scale, height * scale);
      ctx.scale(scale, scale);
      ctx.beginPath(); ctx.roundRect(0, 0, width, height + radius, [radius, radius, 0, 0]); ctx.clip();
      try { paint(ctx, width, radius, url); } catch (error) { throw fail(item, error); }
      return ctx.canvas;
    },
  };
}

/**
 * The cursor: drawing code exporting `shapes` (each shape's { width, height, hotspot: [x, y] } in the
 * code's own units, `default` among them, with `frames` for one that loops each second) and
 * `draw(ctx, { shape, phase, params, files })` in those units, or an image of the default shape whose
 * `hotspot` the item names. The default shape is `size` CSS px wide and the others share its scale;
 * each sprite has a margin of a quarter box around it for shadows.
 */
async function loadCursor(item) {
  let boxes, paint;
  if (item.kind === 'image') {
    const image = await loadImage(item, item.url);
    boxes = { default: { width: image.naturalWidth || 32, height: image.naturalHeight || 32, hotspot: item.hotspot ?? [0, 0] } };
    paint = ctx => ctx.drawImage(image, 0, 0, boxes.default.width, boxes.default.height);
  } else {
    const module = await loadModule(item), files = await loadFiles(item), params = paramsOf(item);
    boxes = module.shapes;
    if (!boxes?.default) throw fail(item, 'a cursor exports `shapes` with a `default` box');
    paint = (ctx, shape, phase) => module.draw(ctx, { shape, phase, params, files });
  }
  const k = (item.size ?? 24) / boxes.default.width;
  return Object.fromEntries(Object.entries(boxes).map(([shape, box]) => {
    const margin = Math.max(box.width, box.height) / 4;
    return [shape, {
      /** Where the sprite's top-left sits relative to the pointer, and its size, in CSS px. */
      offset: { x: -(box.hotspot[0] + margin) * k, y: -(box.hotspot[1] + margin) * k },
      size: { w: (box.width + 2 * margin) * k, h: (box.height + 2 * margin) * k },
      /** The shape's pictures through one second, or its only one. */
      canvases(scale) {
        return Array.from({ length: Math.max(1, Math.round(box.frames ?? 1)) }, (_, frame, frames = box.frames ?? 1) => {
          const ctx = canvas2d((box.width + 2 * margin) * k * scale, (box.height + 2 * margin) * k * scale);
          ctx.scale(k * scale, k * scale); ctx.translate(margin, margin);
          try { paint(ctx, shape, frame / frames); } catch (error) { throw fail(item, error); }
          return ctx.canvas;
        });
      },
    }];
  }));
}

/**
 * A click effect: drawing code exporting `reach` (CSS px it may draw from the click, or a function of
 * its parameters) and `draw(ctx, { progress, params, files, cursor })` with the origin at the click,
 * or an image that fades out over the effect.
 */
async function loadClickEffect(item, cursor) {
  if (item.kind === 'image') {
    const image = await loadImage(item, item.url), w = item.size ?? (image.naturalWidth || 48), h = w * (image.naturalHeight / image.naturalWidth || 1);
    return { reach: Math.max(w, h) / 2, paint: (ctx, progress) => { ctx.globalAlpha = 1 - progress; ctx.drawImage(image, -w / 2, -h / 2, w, h); } };
  }
  const module = await loadModule(item), files = await loadFiles(item), params = paramsOf(item);
  const reach = item.reach ?? (typeof module.reach === 'function' ? module.reach(params) : module.reach) ?? 64;
  return { reach, paint: (ctx, progress) => { try { module.draw(ctx, { progress, params, files, cursor }); } catch (error) { throw fail(item, error); } } };
}

/**
 * Drawing code over the whole Final in 1080p pixels, outside the camera, such as Subtitles and keycaps:
 * `draw(ctx, { width, height, ...what, params, files })`. `canvas(width, height, what)` rasterizes it at output size.
 */
async function loadScreenDrawing(item, name) {
  if (item.kind !== 'draw') throw fail(item, `${name} are drawing code`);
  const module = await loadModule(item), files = await loadFiles(item), params = paramsOf(item);
  return {
    canvas(width, height, what) {
      const unit = Math.min(width, height) / 1080, ctx = canvas2d(width, height);
      ctx.scale(unit, unit);
      try { module.draw(ctx, { width: width / unit, height: height / unit, ...what, params, files }); } catch (error) { throw fail(item, error); }
      return ctx.canvas;
    },
  };
}

const SAMPLE_RATE = 48000, AUDIO_BITRATE = 128000;
/** WebCodecs microseconds as samples at SAMPLE_RATE. */
const samplesIn = microseconds => Math.round(microseconds * SAMPLE_RATE / 1e6);
/** Each Line's audio decoded at 48 kHz; the error names a Line whose audio cannot be read. */
async function decodeLines(lines) {
  const context = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  return Promise.all(lines.map(async line => {
    const response = await fetch(line.url);
    if (!response.ok) throw new Error(`Line '${line.id}': its audio ${line.audio} could not be read (${response.status})`);
    try { return await context.decodeAudioData(await response.arrayBuffer()); }
    catch { throw new Error(`Line '${line.id}': its audio ${line.audio} is not a format the browser decodes; use WAV, MP3, M4A, Ogg or FLAC`); }
  }));
}

/**
 * The Narration as Render plays it: each Line's decoded audio and measured duration, placed in Final
 * time by `map`, and its subtitle cues. Lines that overlap, run past `seconds`, the Final's length, or
 * speak while it fast-forwards stop the Render.
 */
async function prepareNarration(narration, subtitles, seconds, map) {
  if (!narration?.lines.length) return null;
  const buffers = await decodeLines(narration.lines);
  const { lines: placed, problems: forwarded } = linesInFinal(narration.lines.map((line, i) => ({ ...line, duration: buffers[i].duration })), map);
  const problems = [...forwarded, ...lineProblems(placed, seconds)];
  if (problems.length) throw new Error(`The Narration does not fit: ${problems.join('; ')}`);
  return { placed, buffers, cues: cuesFor(placed, narration.language, subtitles, seconds) };
}

/** The Lines mixed into one mono track `seconds` long, each at its start and volume. */
function mixLines({ placed, buffers }, volume, seconds) {
  const context = new OfflineAudioContext(1, Math.max(1, Math.round(seconds * SAMPLE_RATE)), SAMPLE_RATE);
  placed.forEach((line, i) => {
    const source = new AudioBufferSourceNode(context, { buffer: buffers[i] });
    source.connect(new GainNode(context, { gain: (volume ?? 1) * (line.volume ?? 1) })).connect(context.destination);
    source.start(line.start);
  });
  return context.startRendering();
}

/** The first audio encoder config the browser supports: AAC where the platform encodes it (macOS, Windows), else Opus. */
async function audioConfig() {
  for (const [codec, codecString] of [['aac', 'mp4a.40.2'], ['opus', 'opus']]) {
    const config = { codec: codecString, numberOfChannels: 1, sampleRate: SAMPLE_RATE, bitrate: AUDIO_BITRATE };
    if ((await AudioEncoder.isConfigSupported(config).catch(() => ({}))).supported) return { codec, config };
  }
  throw new Error('This browser encodes neither AAC nor Opus audio');
}

/**
 * How many samples `config`'s encoder delays its input, measured: a burst of noise is encoded, decoded
 * and lined up against itself. AAC encoders start with priming (2112 samples on macOS) yet stamp the
 * first packet 0; Opus declares its own pre-skip, so it measures 0. Lengths here are in samples.
 */
async function encoderDelay(config) {
  const burst = 4096, longest = 8192, sent = new Float32Array(burst + longest + 2048);
  for (let i = 0, seed = 1; i < burst; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; sent[i] = seed / 2 ** 32 - 0.5; }
  const chunks = [];
  let decoderConfig = null, failure = null;
  const encoder = new AudioEncoder({ output: (chunk, meta) => { chunks.push(chunk); decoderConfig ??= meta?.decoderConfig; }, error: error => { failure ??= error; } });
  const received = new Float32Array(sent.length + longest);
  const decoder = new AudioDecoder({
    output: data => {
      // Each decoded sample goes where its timestamp says, so a delay the encoder declares itself counts as none.
      const at = samplesIn(data.timestamp), samples = new Float32Array(data.numberOfFrames);
      data.copyTo(samples, { planeIndex: 0, format: 'f32-planar' });
      data.close();
      const from = Math.max(0, -at);
      received.set(samples.subarray(from, Math.max(from, received.length - at)), at + from);
    },
    error: error => { failure ??= error; },
  });
  try {
    encoder.configure(config);
    const input = new AudioData({ format: 'f32-planar', sampleRate: SAMPLE_RATE, numberOfFrames: sent.length, numberOfChannels: 1, timestamp: 0, data: sent });
    encoder.encode(input); input.close();
    await encoder.flush();
    decoder.configure(decoderConfig);
    for (const chunk of chunks) decoder.decode(chunk);
    await decoder.flush();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
    if (decoder.state !== 'closed') decoder.close();
  }
  if (failure) throw failure;
  let best = 0, delay = -1;
  for (let lag = 0; lag <= longest; lag++) {
    let sum = 0;
    for (let i = 0; i < burst; i++) sum += sent[i] * received[i + lag];
    if (sum > best) { best = sum; delay = lag; }
  }
  const energy = sent.reduce((sum, v) => sum + v * v, 0);
  if (best < energy / 2) throw new Error(`Could not measure the ${config.codec} encoder's delay`);
  return delay;
}

/** The page's brand color from the Source's first frame. */
function brandOf(firstFrame) {
  const ctx = new OffscreenCanvas(96, 60).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(firstFrame, 0, 0, 96, 60);
  return brandColor(ctx.getImageData(0, 0, 96, 60).data);
}

/** Smallest H.264 High level whose frame-size and macroblock-rate limits fit. */
export function avcCodec(width, height, fps) {
  const frame = Math.ceil(width / 16) * Math.ceil(height / 16), rate = frame * fps;
  const levels = [[42, 8704, 522240], [50, 22080, 589824], [51, 36864, 983040], [52, 36864, 2073600], [60, 139264, 4177920], [61, 139264, 8355840], [62, 139264, 16711680]];
  const [level] = levels.find(([, maxFrame, maxRate]) => frame <= maxFrame && rate <= maxRate) ?? levels.at(-1);
  return `avc1.6400${level.toString(16).toUpperCase().padStart(2, '0')}`;
}

/** Decodes a track with bounded look-ahead so memory stays flat on long Takes. */
function frameReader(track, decoderConfig) {
  const ready = [], waiting = [];
  let failure = null, submitted = 0, decoded = 0, ended = false;
  const wake = () => waiting.splice(0).forEach(resolve => resolve());
  const decoder = new VideoDecoder({ output: frame => { decoded++; ready.push(frame); wake(); }, error: error => { failure = error; wake(); } });
  decoder.configure(decoderConfig);
  const packets = new MB.EncodedPacketSink(track).packets();
  return {
    stats: () => ({ submitted, decoded }),
    async next() {
      while (!ready.length) {
        if (failure) throw failure;
        if (ended) return null;
        if (submitted - decoded >= 6) { await new Promise(resolve => waiting.push(resolve)); continue; }
        const packet = await packets.next();
        if (packet.done) { await decoder.flush(); ended = true; continue; }
        decoder.decode(packet.value.toEncodedVideoChunk());
        submitted++;
      }
      return ready.shift();
    },
    close() { ready.splice(0).forEach(frame => frame.close()); if (decoder.state !== 'closed') decoder.close(); },
  };
}


/** Prefers constant-quality hardware encoding; software encoders only offer a bitrate. */
async function encoderConfig(width, height, fps, quality) {
  const base = { codec: avcCodec(width, height, fps), width, height, framerate: fps, latencyMode: 'quality', avc: { format: 'avc' } };
  const quantizer = { ...base, hardwareAcceleration: 'prefer-hardware', bitrateMode: 'quantizer' };
  if ((await VideoEncoder.isConfigSupported(quantizer)).supported) return { config: quantizer, quantizer: quality };
  const bitrate = { ...base, bitrateMode: 'variable', bitrate: Math.round(width * height * fps * 0.07) };
  if ((await VideoEncoder.isConfigSupported(bitrate)).supported) return { config: bitrate };
  throw new Error(`No H.264 encoder supports ${width}×${height} at ${fps} fps`);
}

/**
 * Everything Render draws for one Edit (as forRender in styles.js serves it). `timeline` holds the
 * pointer path, cursor shapes, events, Tabs and the boxes of masked elements; `sizes` maps each Tab to its Source's size. `firstFrame`
 * is the first Tab's first frame: Background layers see it, and it picks the brand color. `map` is the
 * Take's time map. Each Tab's input is moved into the window's CSS pixels by where its popup sits.
 */
async function createScene(edit, viewport, { pointer, shapes, events, tabs, elements = [] }, sizes, firstFrame, cues, map) {
  const { camera, cursor, clickEffect, keycaps, shortcuts, frame, subtitles, fastForwardBadge } = edit;
  // A mask Render cannot draw would show what it hides, so it stops the Render.
  const maskIssues = maskProblems(edit.masks, elements, tabs.map(tab => tab.id));
  if (maskIssues.length) throw new Error(`The masks cannot be drawn: ${maskIssues.join('; ')}`);
  const masks = maskTrack(edit.masks, elements, map);
  const chrome = frame.chrome ? await loadChrome(frame.chrome, viewport.width) : null;
  const stage = layout(edit, viewport, chrome?.height ?? 0);
  const compositor = createCompositor(stage, brandOf(firstFrame));
  const pages = new Map();
  const upload = (tab, videoFrame) => {
    if (!pages.has(tab)) pages.set(tab, compositor.pageTexture(sizes.get(tab).width, sizes.get(tab).height));
    compositor.upload(pages.get(tab), videoFrame);
  };
  upload(tabs[0].id, firstFrame);
  await compositor.drawBackground(frame.background ?? [], pages.get(tabs[0].id));
  await compositor.loadEffects(frame.effects ?? []);
  const maps = windowMaps(tabs, viewport, edit.tabs.placement), placed = inWindow({ pointer, events }, camera.targets, maps);
  const shownTabs = tabTrack({ tabs, events, viewport }, edit.tabs, map), byId = new Map(tabs.map(tab => [tab.id, tab]));
  // Window CSS pixels → stage pixels; sprites are rasterized for the closest zoom and mipmapped below it.
  const at = (x, y) => [stage.page.x + x * stage.scale, stage.page.y + y * stage.scale];
  const sharpest = stage.scale * camera.maxZoom * 2;
  // A sprite past the GPU's texture limit draws black, so a large one is rasterized only as sharp as fits.
  const fitting = (w, h) => Math.min(sharpest, compositor.maxTextureSize / Math.max(w, h, 1));
  // Each Tab's address bar shows its text from `frame.urls` at each Source time; the first Tab starts on
  // `frame.url`, any other empty. One sprite per width and text.
  const addresses = (frame.urls ?? []).toSorted((a, b) => a.t - b.t);
  const addressAt = (tab, source) => addresses.findLast(address => (address.tab ?? 0) === tab && address.t <= source)?.url ?? (tab === tabs[0].id ? frame.url ?? '' : '');
  const chromeTextures = new Map();
  const chromeFor = (width, url) => {
    const key = `${width} ${url}`;
    if (!chromeTextures.has(key)) chromeTextures.set(key, compositor.sprite(chrome.canvas(width, fitting(width, chrome.height), stage.radius / stage.scale, url)));
    return chromeTextures.get(key);
  };
  /** A window as the compositor draws it: the window's own tab, or a popup window where it sits, scaled by its animation. */
  const windowOf = ({ tab, popup, opacity, scale }, source, effects) => {
    const url = addressAt(tab, source);
    if (!popup) return { page: pages.get(tab), pageRect: stage.page, window: stage.window, radius: stage.radius, opacity, effects, chrome: chrome && { texture: chromeFor(viewport.width, url), rect: [stage.window.x, stage.window.y, stage.window.w, stage.chrome] } };
    const m = maps.get(tab), { width, height } = byId.get(tab).viewport, bar = chrome ? chrome.height * m.scale : 0;
    const [x, y] = at(m.x, m.y - bar), w = width * m.scale * stage.scale, h = (height * m.scale + bar) * stage.scale;
    const window = { x: x + w * (1 - scale) / 2, y: y + h * (1 - scale) / 2, w: w * scale, h: h * scale }, top = bar * stage.scale * scale;
    return {
      page: pages.get(tab), pageRect: { x: window.x, y: window.y + top, w: window.w, h: window.h - top }, window, radius: stage.radius * m.scale * scale, opacity, effects,
      chrome: chrome && { texture: chromeFor(width, url), rect: [window.x, window.y, window.w, top] },
    };
  };
  /**
   * A window with the masks on its Tab (`shown`, maskTrack's) in stage pixels: blurs and covers hidden
   * with its page, a blur at the mip level of its strength in the Tab's Source, and its spotlights.
   */
  const masked = (w, tab, now) => {
    const own = now.filter(mask => mask.tab === tab);
    if (!own.length) return w;
    const { width, height } = byId.get(tab).viewport, sx = w.pageRect.w / width, sy = w.pageRect.h / height, devicePerCss = sizes.get(tab).width / width;
    const toStage = r => [w.pageRect.x + r.x * sx, w.pageRect.y + r.y * sy, r.width * sx, r.height * sy];
    const hidden = mergedPast(own.filter(mask => mask.effect !== 'spotlight').flatMap(mask => mask.rects.map(rect => ({ rect, mask }))), MASK_BOXES);
    const color = value => uniformOf(value)?.[1] ?? [0, 0, 0];
    return {
      ...w, masks: own.map(mask => mask.index),
      hidden: hidden.length ? {
        count: hidden.length, rects: new Float32Array(hidden.flatMap(({ rect }) => toStage(rect))),
        styles: new Float32Array(hidden.flatMap(({ mask }) => [mask.radius * sx, mask.effect === 'cover' ? 1 : 0, Math.max(0, Math.log2(mask.blur * devicePerCss / 2) || 0), 0])),
        colors: new Float32Array(hidden.flatMap(({ mask }) => [...(mask.effect === 'cover' ? color(mask.color) : [0, 0, 0]), 1])),
      } : null,
      spotlights: own.filter(mask => mask.effect === 'spotlight').map(mask => {
        const rects = mergedPast(mask.rects.map(rect => ({ rect })), MASK_BOXES);
        return { count: rects.length, rects: new Float32Array(rects.flatMap(({ rect }) => toStage(rect))), corner: mask.radius * sx, feather: mask.feather * sx, color: [...color(mask.color), mask.dim], opacity: mask.opacity };
      }),
    };
  };
  const cursorSprites = cursor ? await loadCursor(cursor) : {};
  const cursorTextures = Object.fromEntries(Object.entries(cursorSprites).map(([shape, sprite]) => [shape, sprite.canvases(fitting(sprite.size.w, sprite.size.h)).map(canvas => compositor.sprite(canvas))]));
  const drawn = new Set(Object.keys(cursorSprites)), track = cursor && cursorTrack({ pointer: placed.pointer, shapes, events: placed.events }, cursor);
  const effect = clickEffect ? await loadClickEffect(clickEffect, cursor ? Object.fromEntries(Object.entries(cursor).filter(([key]) => !['ref', 'kind', 'url', 'files'].includes(key))) : {}) : null;
  const pressList = presses(placed.events);
  const subtitleDrawing = burnsIn(subtitles) && cues.length ? await loadScreenDrawing(subtitles, 'Subtitles') : null;
  const keys = keycapTrack(retimed(shortcuts, map), keycaps), keycapDrawing = keys.shows.length ? await loadScreenDrawing(keycaps, 'Keycaps') : null;
  const badgeDrawing = fastForwardBadge && map.spans.length ? await loadScreenDrawing(fastForwardBadge, 'Fast-forward badges') : null;
  const unit = Math.min(stage.width, stage.height) / 1080, spacing = 2 * unit; // on-screen pixels between the moments a frame averages
  /** Where stage point `p` shows on screen, in output pixels, under the camera `view`. */
  const onScreen = (p, view) => [(p[0] - view.x) * view.zoom + stage.width / 2, (p[1] - view.y) * view.zoom + stage.height / 2];
  const apart = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]); // the distance between two points
  const corners = [[0, 0], [stage.width, 0], [0, stage.height], [stage.width, stage.height]];
  /** How far, in output pixels, what the camera shows at view `to` has moved on screen since view `from`: the most at any corner of the Final. */
  const cameraMoved = (from, to) => Math.max(...corners.map(c => apart(onScreen([(c[0] - stage.width / 2) / to.zoom + to.x, (c[1] - stage.height / 2) / to.zoom + to.y], from), c)));
  /** The Cursor at Final time `time` under `view`, as the compositor places it, with its tip in stage pixels; null before the first pointer sample. */
  const cursorAt = (time, view) => {
    const now = track && track.at(map.sourceAt(time));
    if (!now) return null;
    // The Cursor scales around its hotspot, so a press keeps its tip on the target.
    const shape = drawnShape(now.shape, drawn), sprite = cursorSprites[shape], k = now.scale, frames = cursorTextures[shape];
    return { view, tip: at(now.x, now.y), texture: frames[Math.floor(time * frames.length) % frames.length], rect: [...at(now.x + sprite.offset.x * k, now.y + sprite.offset.y * k), sprite.size.w * k * stage.scale, sprite.size.h * k * stage.scale] };
  };
  /** The output pixels the Cursor covers at its moments, [x, y, w, h], inside the Final. */
  const areaOf = cursors => {
    const points = cursors.flatMap(({ view, rect: [x, y, w, h] }) => [onScreen([x, y], view), onScreen([x + w, y + h], view)]);
    const left = Math.max(0, Math.min(...points.map(p => p[0]))), top = Math.max(0, Math.min(...points.map(p => p[1])));
    return [left, top, Math.max(0, Math.min(stage.width, Math.max(...points.map(p => p[0]))) - left), Math.max(0, Math.min(stage.height, Math.max(...points.map(p => p[1]))) - top)];
  };
  const effectTextures = [];
  let subtitleTexture = null, shown = -1, keycapTexture = null, keycapsShown = null, badgeTexture = null, badgeShown = null;
  return {
    stage, compositor, keycapShows: keys.shows,
    /** The Tabs shown at Final time `t`, in drawing order. */
    shown: t => shownTabs.at(t),
    /** Fills a Tab's page with a frame of its Source. */
    upload,
    /**
     * The camera's crop for every frame of the Final: its targets move to the window's CSS pixels and to
     * Final time, it follows the pointer at each moment's Source time, and it cuts to wide where the
     * window shows another tab.
     */
    crops() {
      const targets = retimed(placed.targets, map, ['t', 'until']);
      return cameraTrack({ targets, viewport, camera, duration: map.duration, fps: edit.output.fps, pointerAt: t => pointerAt(placed.pointer, map.sourceAt(t)), cuts: shownTabs.cuts });
    },
    /**
     * Draws Final time `t` with the camera showing `camera(time)`, a viewport rectangle in CSS pixels at
     * any Final time; returns the index of the cue it shows, or -1, the keycap show, or null, the
     * fast-forward badge, or null, the indexes of the masks it drew, and how many moments the camera
     * and the Cursor averaged (`averaged`).
     *
     * Motion blur: over the frame's exposure (shutter.js) the window and what moves with it are composed
     * under the camera at several moments, and the Cursor at several points of its path, each one moment
     * per two 1080p pixels it moves on screen. The Background stays still, and the page shows one Source
     * frame, so motion inside the page is not blurred.
     */
    draw(t, camera) {
      const viewAt = time => cameraView(camera(time), stage, viewport), view = viewAt(t), source = map.sourceAt(t);
      const span = compositor.blurs ? exposure(t, edit.output.fps, edit.output.shutter, shownTabs.cuts) : null, startView = span && viewAt(span.start);
      const views = moments(t, span, span ? cameraMoved(startView, view) : 0, spacing).map(time => time === t ? view : viewAt(time));
      const cursorEnd = cursorAt(t, view), cursorStart = span && cursorEnd && cursorAt(span.start, startView);
      const cursors = moments(t, cursorStart ? span : null, cursorStart ? apart(onScreen(cursorStart.tip, startView), onScreen(cursorEnd.tip, view)) : 0, spacing)
        .map(time => time === t ? cursorEnd : cursorAt(time, viewAt(time))).filter(Boolean);
      // The window's effects are drawn once, under the tab it shows first. Each window carries the masks on its Tab.
      const maskedNow = masks.at(t);
      const windows = shownTabs.at(t).filter(({ tab }) => pages.has(tab)).map((shownTab, i) => masked(windowOf(shownTab, source, i === 0 || shownTab.popup), shownTab.tab, maskedNow));
      const cue = subtitleDrawing ? cues.findIndex(c => t >= c.start && t < c.end) : -1;
      if (cue >= 0 && cue !== shown) subtitleTexture = compositor.sprite(subtitleDrawing.canvas(stage.width, stage.height, { rows: cues[cue].rows }), subtitleTexture, false);
      shown = cue;
      // Each show is drawn once, and again when its count goes up; CueTake fades it and lifts it into place.
      const keycap = keycapDrawing && keys.at(t), drawnAs = keycap && `${keycap.index}×${keycap.count}`;
      if (keycap && drawnAs !== keycapsShown) keycapTexture = compositor.sprite(keycapDrawing.canvas(stage.width, stage.height, { keys: keycap.keys, count: keycap.count }), keycapTexture, false);
      keycapsShown = drawnAs ?? keycapsShown;
      // A badge is drawn once per rate; CueTake fades it in and out with its span.
      const badge = badgeDrawing && badgeAt(map, t);
      if (badge && badge.rate !== badgeShown) badgeTexture = compositor.sprite(badgeDrawing.canvas(stage.width, stage.height, { rate: badge.rate }), badgeTexture, false);
      badgeShown = badge ? badge.rate : badgeShown;
      // Each click effect is drawn once a frame, at its on-screen scale so thin strokes stay crisp, then placed under each view.
      const sparks = (effect ? sparksAt(pressList, clickEffect, source) : []).map((press, i) => {
        const scale = stage.scale * view.zoom, ctx = canvas2d(2 * effect.reach * scale, 2 * effect.reach * scale);
        ctx.scale(scale, scale); ctx.translate(effect.reach, effect.reach);
        effect.paint(ctx, press.progress);
        effectTextures[i] = compositor.sprite(ctx.canvas, effectTextures[i], false);
        return [effectTextures[i], [...at(press.x - effect.reach, press.y - effect.reach), 2 * effect.reach * stage.scale, 2 * effect.reach * stage.scale]];
      });
      compositor.frame(views, windows, draw => { for (const [texture, rect] of sparks) draw(texture, rect); }, cursors, cursors.length > 1 ? areaOf(cursors) : null, cue >= 0 || keycap || badge ? draw => {
        if (cue >= 0) draw(subtitleTexture, [0, 0, stage.width, stage.height]);
        if (keycap) draw(keycapTexture, [0, keycap.rise * unit, stage.width, stage.height], keycap.opacity);
        if (badge) draw(badgeTexture, [0, 0, stage.width, stage.height], badge.opacity);
      } : null);
      return { cue, keycap, badge, masks: [...new Set(windows.flatMap(w => w.masks ?? []))], averaged: { camera: views.length, cursor: cursors.length } };
    },
  };
}

/** A WritableStream that posts each positioned chunk to Node, which writes it into the Final. */
const uploadStream = url => new WritableStream({
  async write(chunk) {
    const response = await fetch(`${url}?position=${chunk.position}`, { method: 'POST', body: chunk.data });
    if (!response.ok) throw new Error(`Writing the Final failed: ${response.status}`);
  },
});

/**
 * Each Tab's Source read in order, for sample and hold: `at(seconds)` gives the latest frame at or
 * before that Source time of the Take, or the first before it. A Tab that records nothing is left out.
 */
async function openSources(sources, tabs) {
  const opened = new Map();
  for (const { tab, url } of sources) {
    const track = await new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.UrlSource(url) }).getPrimaryVideoTrack();
    const reader = frameReader(track, await track.getDecoderConfig());
    const current = await reader.next();
    if (!current) { reader.close(); continue; }
    const start = tabs.find(t => t.id === tab)?.start ?? 0, state = { current, next: await reader.next(), origin: current.timestamp };
    opened.set(tab, {
      reader, size: { width: track.codedWidth, height: track.codedHeight }, first: current,
      async at(seconds) {
        const due = state.origin + Math.round((seconds - start) * 1e6);
        while (state.next && state.next.timestamp <= due) {
          if (state.current !== current) state.current.close();
          state.current = state.next; state.next = await reader.next();
        }
        return state.current;
      },
      close() { if (state.current !== current) state.current.close(); state.next?.close(); current.close(); reader.close(); },
    });
  }
  if (!opened.has(tabs[0].id)) throw new Error('Source has no video frames');
  return opened;
}

window.cuetakeRender = async ({ sources: sourceUrls, finalUrl, duration, viewport, pointer, shapes, events, tabs, elements, edit, narration }) => {
  const { quality, fps } = edit.output;
  const { width, height } = outputSize(edit);
  const started = performance.now();
  const sources = await openSources(sourceUrls, tabs);
  const map = timeMap(edit.fastForward, duration);
  const frameCount = Math.round(map.duration * fps), seconds = frameCount / fps;
  const voice = await prepareNarration(narration, edit.subtitles, seconds, map);
  const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'reserve' }), target: new MB.StreamTarget(uploadStream(finalUrl), { chunked: true }) });
  const packets = new MB.EncodedVideoPacketSource('avc');
  output.addVideoTrack(packets, { frameRate: fps, maximumPacketCount: frameCount });
  let failure = null, muxed = Promise.resolve();
  // The mix is fed a second ahead of the video.
  let audio = null;
  if (voice) {
    const { codec, config } = await audioConfig(), source = new MB.EncodedAudioPacketSource(codec);
    // Mediabunny's bound: a packet per 10 ms at most, plus a third for safety.
    output.addAudioTrack(source, { maximumPacketCount: Math.ceil(seconds * 100 * 4 / 3) + 16 });
    // Both in samples: the encoder's delay, and the mix, as long as the video.
    const delay = await encoderDelay(config), mix = await mixLines(voice, narration.volume, seconds);
    const encoder = new AudioEncoder({
      output(chunk, meta) {
        // Each packet is stamped by the input it encodes: the priming falls before 0, which the MP4's
        // edit list then skips, and packets that start after the video are left out.
        const start = samplesIn(chunk.timestamp) - delay;
        if (start >= mix.length) return;
        const packet = MB.EncodedPacket.fromEncodedChunk(chunk).clone({ timestamp: start / SAMPLE_RATE, duration: samplesIn(chunk.duration) / SAMPLE_RATE });
        muxed = muxed.then(() => source.add(packet, meta)).catch(error => { failure ??= error; });
      },
      error(error) { failure ??= error; },
    });
    encoder.configure(config);
    audio = { codec, delay, encoder, mix, fed: 0 };
  }
  const feedAudio = async until => {
    const end = Math.min(audio.mix.length, Math.round(until * SAMPLE_RATE));
    if (end <= audio.fed) return;
    const data = new AudioData({ format: 'f32-planar', sampleRate: SAMPLE_RATE, numberOfFrames: end - audio.fed, numberOfChannels: 1, timestamp: Math.round(audio.fed * 1e6 / SAMPLE_RATE), data: audio.mix.getChannelData(0).slice(audio.fed, end) });
    audio.fed = end;
    audio.encoder.encode(data); data.close();
    while (audio.encoder.encodeQueueSize > 2) await new Promise(resolve => audio.encoder.addEventListener('dequeue', resolve, { once: true }));
  };
  await output.start();
  const { config, quantizer } = await encoderConfig(width, height, fps, quality);
  const encoder = new VideoEncoder({
    output(chunk, meta) {
      // Chromium tags the stream sRGB; the pixels are BT.709, so label them as such.
      const colorSpace = meta?.decoderConfig?.colorSpace;
      if (colorSpace) meta = { ...meta, decoderConfig: { ...meta.decoderConfig, colorSpace: { ...colorSpace, transfer: 'bt709' } } };
      const packet = MB.EncodedPacket.fromEncodedChunk(chunk);
      muxed = muxed.then(() => packets.add(packet, meta)).catch(error => { failure ??= error; });
    },
    error(error) { failure ??= error; },
  });
  encoder.configure(config);

  const cues = voice?.cues ?? [], shownFrames = cues.map(() => null), keycapFrames = [], badgeFrames = [], maskFrames = [];
  const sizes = new Map([...sources].map(([tab, source]) => [tab, source.size]));
  const recorded = tabs.filter(tab => sources.has(tab.id)), uploaded = new Map();
  const scene = await createScene(edit, viewport, { pointer, shapes, events, tabs: recorded, elements }, sizes, sources.get(recorded[0].id).first, cues, map), { compositor } = scene;
  const crops = scene.crops(), camera = time => cropAt(crops, fps, time), blurred = { camera: 0, cursor: 0 };
  try {
    for (let i = 0; i < frameCount; i++) {
      if (failure) throw failure;
      // Sample and hold: each Tab shown shows the latest frame of its Source at or before this moment's Source time (VFR → CFR).
      for (const { tab } of scene.shown(i / fps)) {
        const frame = await sources.get(tab)?.at(map.sourceAt(i / fps));
        if (frame && uploaded.get(tab) !== frame) { scene.upload(tab, frame); uploaded.set(tab, frame); }
      }
      if (audio && i % fps === 0) await feedAudio(i / fps + 1);
      const { cue, keycap, badge, masks, averaged } = scene.draw(i / fps, camera);
      for (const index of masks) maskFrames[index] = [maskFrames[index]?.[0] ?? i, i];
      if (averaged.camera > 1) blurred.camera++;
      if (averaged.cursor > 1) blurred.cursor++;
      if (cue >= 0) shownFrames[cue] = [shownFrames[cue]?.[0] ?? i, i];
      if (keycap) keycapFrames[keycap.index] = [keycapFrames[keycap.index]?.[0] ?? i, i];
      if (badge) badgeFrames[badge.index] = [badgeFrames[badge.index]?.[0] ?? i, i];
      const videoFrame = new VideoFrame(compositor.canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(videoFrame, { keyFrame: i % (fps * 2) === 0, ...(quantizer ? { avc: { quantizer } } : {}) });
      videoFrame.close();
      while (encoder.encodeQueueSize > 4) await new Promise(resolve => encoder.addEventListener('dequeue', resolve, { once: true }));
    }
    await encoder.flush();
    if (failure) throw failure;
    if (audio) { await feedAudio(Infinity); await audio.encoder.flush(); }
    await muxed;
    if (failure) throw failure;
    await output.finalize();
  } finally {
    for (const source of sources.values()) source.close();
    if (encoder.state !== 'closed') encoder.close();
    if (audio && audio.encoder.state !== 'closed') audio.encoder.close();
  }
  return {
    width, height, frames: frameCount, sourceFrames: [...sources.values()].reduce((sum, source) => sum + source.reader.stats().decoded, 0), codec: config.codec,
    rateControl: quantizer ? `quantizer ${quantizer}` : `variable ${config.bitrate} bps`, gpu: compositor.gpu,
    // How many frames blurred the camera's and the Cursor's motion; a GPU without float render targets blurs none.
    motionBlur: { shutter: compositor.blurs ? shutterOf(edit.output.shutter) : 0, ...(!compositor.blurs && shutterOf(edit.output.shutter) > 0 && { note: 'This GPU cannot render to float textures, so the Final has no motion blur' }), frames: blurred },
    seconds: +((performance.now() - started) / 1000).toFixed(2),
    // Each keycap show with the first and last output frame it was drawn on.
    // Each fast-forward in Final seconds, with the first and last frame its badge was drawn on (null without a badge).
    ...(map.spans.length && { fastForwards: map.spans.map((span, i) => ({ ...span, frames: badgeFrames[i] ?? null })) }),
    // Each mask with its span in Final seconds and the first and last frame it was drawn on (null when its element never showed).
    ...(edit.masks?.length && { masks: edit.masks.map(({ effect, element, box, start = 0, end }, i) => ({ effect, ...(element !== undefined ? { element } : { box }), start: map.outputAt(start), end: end === undefined ? seconds : map.outputAt(end), frames: maskFrames[i] ?? null })) }),
    ...(scene.keycapShows.length && { keycaps: scene.keycapShows.map((show, i) => ({ t: show.t, keys: show.keys, presses: show.presses.length, frames: keycapFrames[i] ?? null })) }),
    ...(voice && {
      // `encoderDelay`: the samples the encoder delays its input by (AAC's priming), which the MP4's edit list skips.
      audio: { codec: audio.codec, sampleRate: SAMPLE_RATE, channels: 1, bitrate: AUDIO_BITRATE, encoderDelay: audio.delay },
      lines: voice.placed.map(({ id, start, duration }) => ({ id, start, duration })),
      // Each cue with the first and last output frame it was drawn on (null when Subtitles are not burned in).
      subtitles: cues.map((cue, i) => ({ ...cue, frames: shownFrames[i] })),
    }),
  };
};

/** Decodes every packet of an audio track; returns how many packets and how many decoded chunks it saw. */
async function decodeAudioTrack(track) {
  let decoded = 0, packets = 0, failure = null;
  const decoder = new AudioDecoder({ output: data => { decoded++; data.close(); }, error: error => { failure = error; } });
  decoder.configure(await track.getDecoderConfig());
  try {
    for await (const packet of new MB.EncodedPacketSink(track).packets()) {
      decoder.decode(packet.toEncodedAudioChunk()); packets++;
      while (decoder.decodeQueueSize > 16) await new Promise(resolve => decoder.addEventListener('dequeue', resolve, { once: true }));
    }
    await decoder.flush();
  } finally { if (decoder.state !== 'closed') decoder.close(); }
  if (failure) throw failure;
  return { packets, decoded };
}

/**
 * Reads a Final's container metadata and decodes every frame and audio packet. `lines` ([{ id, url,
 * audio }]) are decoded too, giving each Line's duration or the reason it cannot be read.
 */
window.cuetakeInspect = async (url, lines = []) => {
  const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.UrlSource(url) });
  const track = await input.getPrimaryVideoTrack();
  const stats = await track.computePacketStats();
  const reader = frameReader(track, await track.getDecoderConfig());
  let frames = 0;
  try { for (let frame; (frame = await reader.next());) { frames++; frame.close(); } }
  finally { reader.close(); }
  const audioTrack = await input.getPrimaryAudioTrack();
  let audio = null;
  if (audioTrack) {
    audio = { codec: await audioTrack.getCodecParameterString(), sampleRate: audioTrack.sampleRate, channels: audioTrack.numberOfChannels, duration: await audioTrack.computeDuration() };
    try { audio = { ...audio, ...await decodeAudioTrack(audioTrack) }; } catch (error) { audio.error = error.message; }
  }
  const measured = await Promise.all(lines.map(line => decodeLines([line]).then(([buffer]) => ({ id: line.id, duration: buffer.duration }), error => ({ id: line.id, error: error.message }))));
  return {
    codec: await track.getCodecParameterString(), width: track.displayWidth, height: track.displayHeight,
    duration: await track.computeDuration(), fps: +stats.averagePacketRate.toFixed(3), packets: stats.packetCount, decodedFrames: frames,
    audio, lines: measured,
  };
};

/** Each Line's audio duration in seconds, for the Director to hold each Line while it is spoken. */
window.cuetakeMeasure = async lines => {
  const buffers = await decodeLines(lines);
  return Object.fromEntries(lines.map((line, i) => [line.id, buffers[i].duration]));
};

/**
 * A Preview as a base64 PNG: each tile's Edit composed by the same scene as Render, over the Sources at
 * `at` seconds with the Final's camera, or (`at` null) over the last moment with the camera wide.
 */
window.cuetakePreview = async ({ sources: sourceUrls, duration, viewport, pointer, shapes, events, tabs, elements, tiles, at, narration }) => {
  const map = timeMap(tiles[0]?.edit.fastForward, duration), t = at ?? map.duration, source = map.sourceAt(t);
  // Each Tab's first frame, and its frame at `t`, the latest at or before it or else its first.
  const frames = new Map(), samples = [];
  for (const { tab, url } of sourceUrls) {
    const track = await new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.UrlSource(url) }).getPrimaryVideoTrack();
    const sink = new MB.VideoSampleSink(track), origin = await track.getFirstTimestamp(), start = tabs.find(other => other.id === tab)?.start ?? 0;
    const first = await sink.getSample(origin);
    if (!first) continue;
    const latest = await sink.getSample(origin + Math.max(0, source - start)) ?? first;
    samples.push(first, latest);
    frames.set(tab, { size: { width: track.codedWidth, height: track.codedHeight }, first: first.toVideoFrame(), now: latest.toVideoFrame() });
  }
  try {
    if (!frames.has(tabs[0].id)) throw new Error('Source has no video frames');
    const recorded = tabs.filter(tab => frames.has(tab.id)), sizes = new Map([...frames].map(([tab, { size }]) => [tab, size]));
    const sheet = previewSheet(tiles.map(({ edit }) => outputSize(edit)));
    const ctx = new OffscreenCanvas(sheet.width, sheet.height).getContext('2d');
    ctx.fillStyle = '#111114'; ctx.fillRect(0, 0, sheet.width, sheet.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.font = '600 22px system-ui, -apple-system, sans-serif'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#e5e7eb';
    for (const [i, { name, edit }] of tiles.entries()) {
      const voice = await prepareNarration(narration, edit.subtitles, Math.round(map.duration * edit.output.fps) / edit.output.fps, map);
      const scene = await createScene(edit, viewport, { pointer, shapes, events, tabs: recorded, elements }, sizes, frames.get(recorded[0].id).first, voice?.cues ?? [], map);
      // At `at` the camera moves as in the Final, blurred the same way; otherwise it is wide and still.
      const wide = { x: 0, y: 0, w: viewport.width, h: viewport.height }, path = at === null ? [] : scene.crops();
      for (const { tab } of scene.shown(t)) scene.upload(tab, frames.get(tab).now);
      scene.draw(t, path.length ? time => cropAt(path, edit.output.fps, time) : () => wide);
      // Copy before yielding: the WebGL canvas does not keep its drawing buffer.
      const tile = sheet.tiles[i];
      ctx.drawImage(scene.compositor.canvas, tile.x, tile.y, tile.w, tile.h);
      if (tile.label) ctx.fillText(name, tile.label.x, tile.label.y);
      scene.compositor.dispose();
    }
    return await pngBase64(ctx.canvas);
  } finally {
    for (const { first, now } of frames.values()) { first.close(); now.close(); }
    for (const sample of samples) sample.close();
  }
};

async function pngBase64(canvas) {
  const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/png' }) : await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}

/** One Final frame at `seconds`, as a base64 PNG. */
window.cuetakeFrame = async (url, seconds) => {
  const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.UrlSource(url) });
  const wrapped = await new MB.CanvasSink(await input.getPrimaryVideoTrack()).getCanvas(seconds);
  if (!wrapped) throw new Error(`No frame at ${seconds} s`);
  return pngBase64(wrapped.canvas);
};
