/**
 * Runs inside Chromium (see render.js). Source WebM → VideoDecoder → WebGL2 → VideoEncoder (H.264) →
 * MP4, streamed back to Node in chunks.
 *
 * Each output frame is the Background (drawn once, still in output pixels), the window effects (drawn
 * every frame around the window as the camera moves it), the page, then the chrome, click effects and
 * cursor. Everything but the page is agent-written shaders, drawing code or images (ADR 0005).
 *
 * Spaces: camera crops are CSS pixels of the viewport; the Source texture is sampled by UV only;
 * "stage" is the Final's pixels at camera zoom 1, laid out by stage.js.
 */
import * as MB from '/mediabunny.js';
import { cameraTrack } from '/camera.js';
import { pointerAt, presses, sparksAt } from '/cursor.js';
import { layout, outputSize, cameraView, previewSheet, brandColor } from '/stage.js';

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
vec2 pixel() { return vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y); }
vec4 previous(vec2 px) { return texture(uPrevious, vec2(px.x, uResolution.y - px.y) / uResolution); }
float windowDistance(vec2 px) {
  vec2 q = abs(px - uWindow.xy - uWindow.zw * 0.5) - (uWindow.zw * 0.5 - uRadius);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;
}
`;
const HEADER_UNIFORMS = new Set(['uResolution', 'uUnit', 'uBrand', 'uPrevious', 'uPage', 'uWindow', 'uRadius', 'uZoom']);
// An image layer is drawn over the layers below it.
const IMAGE_LAYER = `uniform sampler2D image;
void main() { vec4 top = texture(image, pixel() / uResolution); color = top + previous(pixel()) * (1.0 - top.a); }`;
const BLIT = `#version 300 es
precision highp float;
uniform sampler2D uImage; uniform vec2 uRes; out vec4 color;
void main() { color = texture(uImage, gl_FragCoord.xy / uRes); }`;
// The page inside the window's rounded rectangle, below the chrome, under the camera.
const PAGE = `#version 300 es
precision highp float;
uniform vec2 uRes; uniform vec3 uCam; uniform vec4 uPage; uniform vec4 uWindow; uniform float uRadius;
uniform sampler2D uSource;
out vec4 color;
float roundedBox(vec2 p, vec4 rect, float r) {
  vec2 q = abs(p - rect.xy - rect.zw * 0.5) - (rect.zw * 0.5 - r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main() {
  vec2 pixel = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 stage = (pixel - uRes * 0.5) / uCam.z + uCam.xy;
  float inside = clamp(0.5 - roundedBox(stage, uWindow, uRadius) * uCam.z, 0.0, 1.0);
  if (inside <= 0.0 || stage.y < uPage.y) discard;
  color = vec4(texture(uSource, clamp((stage - uPage.xy) / uPage.zw, 0.0, 1.0)).rgb, 1.0) * inside;
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
uniform sampler2D uSprite;
in vec2 uv; out vec4 color;
void main() { color = texture(uSprite, uv); }`;

// Item keys CueTake reads itself; every other key is a parameter for the item's shader or drawing code.
const OWN_KEYS = new Set(['shader', 'draw', 'image', 'files', 'ref', 'kind', 'url']);
const SLOT_KEYS = new Set(['size', 'hotspot', 'duration', 'reach', 'height']);
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

/** The compositor for one stage: the Background drawn once, then per frame effects, page and sprites. */
function createCompositor(stage, sourceWidth, sourceHeight, brand) {
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

  // Mipmaps keep zoomed-out text from aliasing when the 2× Source is minified.
  const pageTexture = texture();
  gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(sourceWidth, sourceHeight))) + 1, gl.RGBA8, sourceWidth, sourceHeight);
  const pageProgram = program(VERTEX, PAGE);
  gl.uniform4f(pageProgram.uniform('uPage'), stage.page.x, stage.page.y, stage.page.w, stage.page.h);
  gl.uniform4f(pageProgram.uniform('uWindow'), stage.window.x, stage.window.y, stage.window.w, stage.window.h);
  gl.uniform1f(pageProgram.uniform('uRadius'), stage.radius);
  const blitProgram = program(VERTEX, BLIT);
  const spriteProgram = program(SPRITE_VERTEX, SPRITE_FRAGMENT), spriteRect = spriteProgram.uniform('uRect');

  /** An agent shader with its parameters declared and set, and its `files` bound from texture unit 2. */
  async function agentProgram(item, source) {
    const params = Object.entries(paramsOf(item)).map(([name, value]) => [name, uniformOf(value)]).filter(([name, u]) => u && /^[A-Za-z_]\w*$/.test(name));
    const images = await Promise.all(Object.entries(item.files ?? {}).map(async ([name, url]) => [name, await loadImage(item, url)]));
    const declarations = [
      ...params.filter(([name]) => !HEADER_UNIFORMS.has(name)).map(([name, [type]]) => `uniform ${type} ${name};`),
      ...images.flatMap(([name]) => [`uniform sampler2D ${name};`, `uniform vec2 ${name}Size;`]),
    ].join('\n');
    const p = program(VERTEX, `${SHADER_HEADER}${declarations}\n#line 1\n${source}`, item);
    gl.uniform1f(p.uniform('uUnit'), unit); gl.uniform3f(p.uniform('uBrand'), ...brand);
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
  const run = (p, previous, windowRect, radius, zoom) => {
    gl.useProgram(p.p);
    gl.uniform4f(p.uniform('uWindow'), ...windowRect); gl.uniform1f(p.uniform('uRadius'), radius); gl.uniform1f(p.uniform('uZoom'), zoom);
    bind(0, previous); bind(1, pageTexture);
    p.textures?.forEach((t, i) => bind(2 + i, t));
    gl.bindVertexArray(fullScreen); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.activeTexture(gl.TEXTURE0);
  };
  const checkGpu = what => { if (gl.isContextLost()) throw new Error(`${what} stopped the GPU; simplify the shader`); };

  const target = () => { const t = texture(gl.LINEAR); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height); return t; };
  const framebuffer = gl.createFramebuffer();
  let background = target(), effects = [];
  const restWindow = [stage.window.x, stage.window.y, stage.window.w, stage.window.h];
  return {
    canvas,
    gpu: (() => { const info = gl.getExtension('WEBGL_debug_renderer_info'); return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown'; })(),
    /** Frees the GPU context; a Preview makes one compositor per tile. */
    dispose() { gl.getExtension('WEBGL_lose_context')?.loseContext(); },
    upload(frame) {
      gl.bindTexture(gl.TEXTURE_2D, pageTexture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      gl.generateMipmap(gl.TEXTURE_2D);
    },
    /** Draws the Background layers in order, each over the result so far, starting from black. */
    async drawBackground(layers) {
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
        run(p, background, restWindow, stage.radius, 1);
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
    /** One frame with the camera at stage point (x, y) and `zoom`; `draw(texture, rect)` in `overlay` places sprites in stage pixels. */
    frame(x, y, zoom, overlay) {
      gl.disable(gl.BLEND);
      gl.useProgram(blitProgram.p); bind(0, background); gl.bindVertexArray(fullScreen); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.enable(gl.BLEND);
      const shown = [(stage.window.x - x) * zoom + width / 2, (stage.window.y - y) * zoom + height / 2, stage.window.w * zoom, stage.window.h * zoom];
      for (const p of effects) run(p, background, shown, stage.radius * zoom, zoom);
      gl.useProgram(pageProgram.p); gl.uniform3f(pageProgram.camera, x, y, zoom);
      bind(0, pageTexture); gl.bindVertexArray(fullScreen); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.useProgram(spriteProgram.p); gl.uniform3f(spriteProgram.camera, x, y, zoom); gl.bindVertexArray(unitQuad);
      overlay((t, rect) => { gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform4f(spriteRect, ...rect); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); });
      if (effects.length) checkGpu('A window effect');
    },
  };
}

/**
 * The chrome bar: drawing code exporting `height` (CSS px) and `draw(ctx, { width, height, radius, url,
 * params, files })`, or an image as wide as the window. `paint(scale, radius)` rasterizes it, clipped to
 * the window's rounded top.
 */
async function loadChrome(item, width, url) {
  let height, paint;
  if (item.kind === 'image') {
    const image = await loadImage(item, item.url);
    height = item.height ?? image.naturalHeight * width / image.naturalWidth;
    paint = ctx => ctx.drawImage(image, 0, 0, width, height);
  } else {
    const module = await loadModule(item), files = await loadFiles(item), params = paramsOf(item);
    height = item.height ?? (typeof module.height === 'function' ? module.height(params) : module.height) ?? 0;
    paint = (ctx, radius) => module.draw(ctx, { width, height, radius, url, params, files });
  }
  return {
    height,
    canvas(scale, radius) {
      const ctx = canvas2d(width * scale, height * scale);
      ctx.scale(scale, scale);
      ctx.beginPath(); ctx.roundRect(0, 0, width, height + radius, [radius, radius, 0, 0]); ctx.clip();
      try { paint(ctx, radius); } catch (error) { throw fail(item, error); }
      return ctx.canvas;
    },
  };
}

/**
 * The cursor: drawing code exporting `box` ({ width, height, hotspot: [x, y] } in its own units) and
 * `draw(ctx, { params, files })` in those units, or an image whose `hotspot` the item names. It is shown
 * `size` CSS px wide, with a margin of a quarter box around it for shadows.
 */
async function loadCursor(item) {
  let box, paint;
  if (item.kind === 'image') {
    const image = await loadImage(item, item.url);
    box = { width: image.naturalWidth || 32, height: image.naturalHeight || 32, hotspot: item.hotspot ?? [0, 0] };
    paint = ctx => ctx.drawImage(image, 0, 0, box.width, box.height);
  } else {
    const module = await loadModule(item), files = await loadFiles(item), params = paramsOf(item);
    box = { ...module.box, ...(item.hotspot && { hotspot: item.hotspot }) };
    paint = ctx => module.draw(ctx, { params, files });
  }
  const k = (item.size ?? 24) / box.width, margin = Math.max(box.width, box.height) / 4;
  return {
    /** Where the sprite's top-left sits relative to the pointer, and its size, in CSS px. */
    offset: { x: -(box.hotspot[0] + margin) * k, y: -(box.hotspot[1] + margin) * k },
    size: { w: (box.width + 2 * margin) * k, h: (box.height + 2 * margin) * k },
    canvas(scale) {
      const ctx = canvas2d((box.width + 2 * margin) * k * scale, (box.height + 2 * margin) * k * scale);
      ctx.scale(k * scale, k * scale); ctx.translate(margin, margin);
      try { paint(ctx); } catch (error) { throw fail(item, error); }
      return ctx.canvas;
    },
  };
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

/**
 * Everything Render draws for one Edit (as forRender in styles.js serves it). `firstFrame` is the
 * Source's first frame: Background layers see it, and it picks the brand color.
 */
async function createScene(edit, viewport, { pointer, events }, firstFrame, sourceWidth, sourceHeight) {
  const { camera, cursor, clickEffect, frame } = edit;
  const chrome = frame.chrome ? await loadChrome(frame.chrome, viewport.width, frame.url ?? '') : null;
  const stage = layout(edit, viewport, chrome?.height ?? 0);
  const compositor = createCompositor(stage, sourceWidth, sourceHeight, brandOf(firstFrame));
  compositor.upload(firstFrame);
  await compositor.drawBackground(frame.background ?? []);
  await compositor.loadEffects(frame.effects ?? []);
  // Page CSS pixels → stage pixels; sprites are rasterized for the closest zoom and mipmapped below it.
  const at = (x, y) => [stage.page.x + x * stage.scale, stage.page.y + y * stage.scale];
  const sharpest = stage.scale * camera.maxZoom * 2;
  const chromeTexture = chrome ? compositor.sprite(chrome.canvas(sharpest, stage.radius / stage.scale)) : null;
  const pointerSprite = cursor ? await loadCursor(cursor) : null;
  const pointerTexture = pointerSprite && compositor.sprite(pointerSprite.canvas(sharpest));
  const effect = clickEffect ? await loadClickEffect(clickEffect, cursor ? Object.fromEntries(Object.entries(cursor).filter(([key]) => !['ref', 'kind', 'url', 'files'].includes(key))) : {}) : null;
  const pressList = presses(events);
  let effectTexture = null;
  return {
    stage, compositor,
    /** Draws output time `t` with the camera showing `crop`, a viewport rectangle in CSS pixels. */
    draw(t, crop) {
      const view = cameraView(crop, stage, viewport);
      compositor.frame(view.x, view.y, view.zoom, draw => {
        if (chromeTexture) draw(chromeTexture, [stage.window.x, stage.window.y, stage.window.w, stage.chrome]);
        for (const press of effect ? sparksAt(pressList, clickEffect, t) : []) {
          // Each click effect is drawn at its on-screen scale so thin strokes stay crisp.
          const scale = stage.scale * view.zoom, ctx = canvas2d(2 * effect.reach * scale, 2 * effect.reach * scale);
          ctx.scale(scale, scale); ctx.translate(effect.reach, effect.reach);
          effect.paint(ctx, press.progress);
          effectTexture = compositor.sprite(ctx.canvas, effectTexture, false);
          draw(effectTexture, [...at(press.x - effect.reach, press.y - effect.reach), 2 * effect.reach * stage.scale, 2 * effect.reach * stage.scale]);
        }
        const point = pointerSprite && pointerAt(pointer, t);
        if (point) draw(pointerTexture, [...at(point.x + pointerSprite.offset.x, point.y + pointerSprite.offset.y), pointerSprite.size.w * stage.scale, pointerSprite.size.h * stage.scale]);
      });
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

window.cuetakeRender = async ({ sourceUrl, finalUrl, duration, viewport, pointer, events, edit }) => {
  const { camera } = edit, { quality, fps } = edit.output;
  const { width, height } = outputSize(edit);
  const started = performance.now();
  const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.UrlSource(sourceUrl) });
  const track = await input.getPrimaryVideoTrack();
  const reader = frameReader(track, await track.getDecoderConfig());
  const frameCount = Math.round(duration * fps);
  const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'reserve' }), target: new MB.StreamTarget(uploadStream(finalUrl), { chunked: true }) });
  const packets = new MB.EncodedVideoPacketSource('avc');
  output.addVideoTrack(packets, { frameRate: fps, maximumPacketCount: frameCount });
  await output.start();
  const { config, quantizer } = await encoderConfig(width, height, fps, quality);
  let failure = null, muxed = Promise.resolve();
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

  let current = await reader.next(), next = await reader.next(), uploaded = null;
  if (!current) throw new Error('Source has no video frames');
  const scene = await createScene(edit, viewport, { pointer, events }, current, track.codedWidth, track.codedHeight), { compositor } = scene;
  const cameraPath = cameraTrack({ targets: camera.targets, viewport, camera, duration, fps, pointerAt: t => pointerAt(pointer, t) });
  const origin = current.timestamp;
  try {
    for (let i = 0; i < frameCount; i++) {
      if (failure) throw failure;
      // Sample and hold: show the latest Source frame at or before this output time (VFR → CFR).
      const due = origin + Math.round(i * 1e6 / fps);
      while (next && next.timestamp <= due) { current.close(); current = next; next = await reader.next(); }
      if (uploaded !== current) { compositor.upload(current); uploaded = current; }
      scene.draw(i / fps, cameraPath[i]);
      const videoFrame = new VideoFrame(compositor.canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(videoFrame, { keyFrame: i % (fps * 2) === 0, ...(quantizer ? { avc: { quantizer } } : {}) });
      videoFrame.close();
      while (encoder.encodeQueueSize > 4) await new Promise(resolve => encoder.addEventListener('dequeue', resolve, { once: true }));
    }
    await encoder.flush();
    await muxed;
    if (failure) throw failure;
    await output.finalize();
  } finally {
    current?.close(); next?.close(); reader.close();
    if (encoder.state !== 'closed') encoder.close();
  }
  return {
    width, height, frames: frameCount, sourceFrames: reader.stats().decoded, codec: config.codec,
    rateControl: quantizer ? `quantizer ${quantizer}` : `variable ${config.bitrate} bps`, gpu: compositor.gpu,
    seconds: +((performance.now() - started) / 1000).toFixed(2),
  };
};

/** Reads a Final's container metadata and decodes every frame. */
window.cuetakeInspect = async url => {
  const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.UrlSource(url) });
  const track = await input.getPrimaryVideoTrack();
  const stats = await track.computePacketStats();
  const reader = frameReader(track, await track.getDecoderConfig());
  let frames = 0;
  try { for (let frame; (frame = await reader.next());) { frames++; frame.close(); } }
  finally { reader.close(); }
  return {
    codec: await track.getCodecParameterString(), width: track.displayWidth, height: track.displayHeight,
    duration: await input.computeDuration(), fps: +stats.averagePacketRate.toFixed(3), packets: stats.packetCount, decodedFrames: frames,
  };
};

/**
 * A Preview as a base64 PNG: each tile's Edit composed by the same scene as Render, over the Source at
 * `at` seconds with the Final's camera, or (`at` null) over the last moment with the camera wide.
 */
window.cuetakePreview = async ({ sourceUrl, duration, viewport, pointer, events, tiles, at }) => {
  const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.UrlSource(sourceUrl) });
  const track = await input.getPrimaryVideoTrack();
  const sink = new MB.VideoSampleSink(track), origin = await track.getFirstTimestamp();
  const t = at ?? duration;
  const firstSample = await sink.getSample(origin), sample = await sink.getSample(origin + t);
  if (!firstSample || !sample) throw new Error('Source has no video frames');
  const firstFrame = firstSample.toVideoFrame(), frame = sample.toVideoFrame();
  try {
    const sheet = previewSheet(tiles.map(({ edit }) => outputSize(edit)));
    const ctx = new OffscreenCanvas(sheet.width, sheet.height).getContext('2d');
    ctx.fillStyle = '#111114'; ctx.fillRect(0, 0, sheet.width, sheet.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.font = '600 22px system-ui, -apple-system, sans-serif'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#e5e7eb';
    for (const [i, { name, edit }] of tiles.entries()) {
      const scene = await createScene(edit, viewport, { pointer, events }, firstFrame, track.codedWidth, track.codedHeight);
      let crop = { x: 0, y: 0, w: viewport.width, h: viewport.height };
      if (at !== null) {
        const { fps } = edit.output, path = cameraTrack({ targets: edit.camera.targets, viewport, camera: edit.camera, duration, fps, pointerAt: s => pointerAt(pointer, s) });
        crop = path[Math.min(Math.round(at * fps), path.length - 1)] ?? crop;
      }
      scene.compositor.upload(frame);
      scene.draw(t, crop);
      // Copy before yielding: the WebGL canvas does not keep its drawing buffer.
      const tile = sheet.tiles[i];
      ctx.drawImage(scene.compositor.canvas, tile.x, tile.y, tile.w, tile.h);
      if (tile.label) ctx.fillText(name, tile.label.x, tile.label.y);
      scene.compositor.dispose();
    }
    return await pngBase64(ctx.canvas);
  } finally { firstFrame.close(); frame.close(); firstSample.close(); sample.close(); }
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
