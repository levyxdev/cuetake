/**
 * Runs inside Chromium (see render.js). Source WebM → VideoDecoder → one WebGL2 pass per output
 * frame → VideoEncoder (H.264) → MP4, streamed back to Node in chunks.
 *
 * Spaces: camera crops are CSS pixels of the viewport; the Source texture is sampled by UV only;
 * "stage" is the Final's pixels at camera zoom 1, laid out by stage.js.
 */
import * as MB from '/mediabunny.js';
import { cameraTrack } from '/camera.js';
import { pointerAt, presses, sparksAt, cursorGeometry, drawSpark, ARROW_PATH } from '/cursor.js';
import { layout, cameraView, BACKGROUNDS, autoBackground, brandHue } from '/stage.js';

const VERTEX = `#version 300 es
in vec2 p; void main() { gl_Position = vec4(p, 0, 1); }`;
const FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 uRes;        // output size
uniform vec3 uCam;        // stage point at the output center, and zoom
uniform vec4 uPage;       // page rectangle in stage pixels
uniform vec4 uWindow;     // window rectangle (chrome + page) in stage pixels
uniform float uRadius;    // window corner radius, stage pixels
uniform float uFramed;    // 0: page fills the stage
uniform float uShadow;    // drop shadow strength
uniform float uBlur;      // 1: background is the blurred page
uniform vec3 uBase;       // mesh background: base color under up to four blobs
uniform vec4 uBlobs[4];   // x, y, radius as stage fractions
uniform vec3 uBlobColors[4];
uniform int uBlobCount;
uniform sampler2D uSource;
out vec4 color;

float roundedBox(vec2 p, vec4 rect, float r) {
  vec2 q = abs(p - rect.xy - rect.zw * 0.5) - (rect.zw * 0.5 - r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float noise(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 pixel = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 stage = (pixel - uRes * 0.5) / uCam.z + uCam.xy;
  vec2 pageUv = clamp((stage - uPage.xy) / uPage.zw, 0.0, 1.0);
  if (uFramed < 0.5) { color = vec4(texture(uSource, pageUv).rgb, 1.0); return; }

  vec3 c;
  if (uBlur > 0.5) {
    // Cover the stage with the page, then read a coarse mip level as a cheap wide blur.
    float r = (uRes.x / uRes.y) / (uPage.z / uPage.w);
    vec2 uv = 0.5 + (stage / uRes - 0.5) * vec2(min(1.0, r), min(1.0, 1.0 / r)) / 1.2;
    c = textureLod(uSource, uv, 6.0).rgb * 0.8;
  } else {
    c = uBase;
    for (int i = 3; i >= 0; i--) {
      if (i >= uBlobCount) continue;
      float d = length((stage / uRes - uBlobs[i].xy) / uBlobs[i].z);
      c = mix(c, uBlobColors[i], 1.0 - smoothstep(0.0, 0.7, d));
    }
  }
  // Grain dithers the gradients so H.264 does not band them.
  c += (noise(pixel) - 0.5) * 0.035;

  float unit = min(uRes.x, uRes.y) / 1080.0;
  float shadow = uShadow * (1.0 - smoothstep(-60.0 * unit, 60.0 * unit, roundedBox(stage - vec2(0.0, 24.0 * unit), uWindow, uRadius)));
  c = mix(c, vec3(0.0), shadow * 0.55);

  float edge = roundedBox(stage, uWindow, uRadius) * uCam.z;   // output pixels from the window edge
  float inside = clamp(0.5 - edge, 0.0, 1.0);
  if (stage.y >= uPage.y) c = mix(c, texture(uSource, pageUv).rgb, inside);
  c = mix(c, vec3(1.0), 0.18 * (1.0 - smoothstep(0.0, 1.0, abs(edge))));   // hairline rim
  color = vec4(c, 1.0);
}`;
// Sprites (cursor, sparks) are premultiplied textures placed by a stage rectangle under the same camera.
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

/** `look` is the static part of the frame: stage layout, background and shadow. */
function createCompositor(stage, look, sourceWidth, sourceHeight) {
  const { width, height } = stage;
  const canvas = new OffscreenCanvas(width, height);
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false });
  const shader = (type, text) => {
    const s = gl.createShader(type); gl.shaderSource(s, text); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const program = (vertex, fragment) => {
    const p = gl.createProgram();
    gl.attachShader(p, shader(gl.VERTEX_SHADER, vertex)); gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fragment));
    gl.bindAttribLocation(p, 0, 'p');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    gl.useProgram(p);
    gl.uniform2f(gl.getUniformLocation(p, 'uRes'), width, height);
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
  const pageProgram = program(VERTEX, FRAGMENT);
  const set = (name, ...v) => gl[`uniform${v.length}f`](pageProgram.uniform(name), ...v);
  set('uPage', stage.page.x, stage.page.y, stage.page.w, stage.page.h);
  set('uWindow', stage.window.x, stage.window.y, stage.window.w, stage.window.h);
  set('uRadius', stage.radius); set('uFramed', look.framed ? 1 : 0); set('uShadow', look.shadow ? 1 : 0); set('uBlur', look.background ? 0 : 1);
  if (look.background) {
    const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
    set('uBase', ...rgb(look.background.base));
    const blobs = look.background.blobs.slice(0, 4);
    gl.uniform1i(pageProgram.uniform('uBlobCount'), blobs.length);
    gl.uniform4fv(pageProgram.uniform('uBlobs'), blobs.flatMap(([x, y, r]) => [x, y, r, 0]).concat(Array(16).fill(0)).slice(0, 16));
    gl.uniform3fv(pageProgram.uniform('uBlobColors'), blobs.flatMap(b => rgb(b[3])).concat(Array(12).fill(0)).slice(0, 12));
  }
  const spriteProgram = program(SPRITE_VERTEX, SPRITE_FRAGMENT);
  const spriteRect = spriteProgram.uniform('uRect');
  const fullScreen = quad([-1, -1, 1, -1, -1, 1, 1, 1]), unit = quad([0, 0, 1, 0, 0, 1, 1, 1]);
  // Mipmaps keep zoomed-out text from aliasing when the 2× Source is minified.
  const pageTexture = texture();
  gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(sourceWidth, sourceHeight))) + 1, gl.RGBA8, sourceWidth, sourceHeight);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.viewport(0, 0, width, height);
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    canvas,
    gpu: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown',
    upload(frame) {
      gl.bindTexture(gl.TEXTURE_2D, pageTexture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      gl.generateMipmap(gl.TEXTURE_2D);
    },
    /** A sprite texture from a 2D canvas; pass `into` to reuse one. */
    sprite(image, into, mipmaps = true) {
      const t = into ?? texture(mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
      return t;
    },
    /** Draws the page under the camera; `draw(texture, rect)` in `overlay` then places sprites in stage pixels. */
    frame(x, y, zoom, overlay) {
      gl.disable(gl.BLEND);
      gl.useProgram(pageProgram.p); gl.uniform3f(pageProgram.camera, x, y, zoom);
      gl.bindTexture(gl.TEXTURE_2D, pageTexture); gl.bindVertexArray(fullScreen);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.enable(gl.BLEND);
      gl.useProgram(spriteProgram.p); gl.uniform3f(spriteProgram.camera, x, y, zoom); gl.bindVertexArray(unit);
      overlay((t, rect) => { gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform4f(spriteRect, ...rect); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); });
    },
  };
}

/** The cursor drawn once at `scale` device pixels per CSS pixel, with room for its shadow. */
function cursorSprite(cursor, scale) {
  const { width, height } = cursorGeometry(cursor);
  const margin = 4;
  const canvas = new OffscreenCanvas(Math.ceil((width + 2 * margin) * scale), Math.ceil((height + 2 * margin) * scale));
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.translate(margin, margin);
  ctx.shadowColor = '#00000055'; ctx.shadowBlur = 2 * scale; ctx.shadowOffsetY = 1 * scale;
  if (cursor.style === 'arrow') {
    ctx.scale(width / 28, height / 36);
    const path = new Path2D(ARROW_PATH);
    ctx.fillStyle = cursor.color; ctx.fill(path);
    ctx.shadowColor = 'transparent';
    ctx.lineJoin = 'round'; ctx.lineWidth = 1.7; ctx.strokeStyle = '#171717'; ctx.stroke(path);
  } else {
    ctx.beginPath(); ctx.arc(width / 2, height / 2, width / 2, 0, 2 * Math.PI);
    ctx.fillStyle = cursor.color; ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#171717'; ctx.beginPath(); ctx.arc(width / 2, height / 2, width / 2 - 0.75, 0, 2 * Math.PI); ctx.stroke();
  }
  // Size in CSS pixels, including the shadow margin.
  return { canvas, margin, width: canvas.width / scale, height: canvas.height / scale };
}

/** The window's chrome bar at `scale` pixels per CSS pixel: traffic lights, and for `browser` an address field. */
function chromeSprite(frame, viewportWidth, heightCss, radiusCss, scale) {
  const canvas = new OffscreenCanvas(Math.ceil(viewportWidth * scale), Math.ceil(heightCss * scale));
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.beginPath(); ctx.roundRect(0, 0, viewportWidth, heightCss + radiusCss, [radiusCss, radiusCss, 0, 0]);
  ctx.fillStyle = frame.window === 'browser' ? '#f3f3f5' : '#ececef'; ctx.fill();
  ctx.fillStyle = '#d4d4d8'; ctx.fillRect(0, heightCss - 1, viewportWidth, 1);
  ['#ff5f57', '#febc2e', '#28c840'].forEach((light, i) => {
    ctx.beginPath(); ctx.arc(20 + i * 20, heightCss / 2, 6, 0, 2 * Math.PI);
    ctx.fillStyle = light; ctx.fill(); ctx.strokeStyle = '#0000001f'; ctx.lineWidth = 0.5; ctx.stroke();
  });
  if (frame.window === 'browser') {
    const w = 420, h = 28, x = (viewportWidth - w) / 2, y = (heightCss - h) / 2;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, h / 2);
    ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.strokeStyle = '#e4e4e7'; ctx.lineWidth = 0.8; ctx.stroke();
    ctx.font = '13px system-ui, -apple-system, sans-serif'; ctx.textBaseline = 'middle';
    const text = frame.url ?? '', textWidth = ctx.measureText(text).width, left = viewportWidth / 2 - (textWidth + 16) / 2;
    ctx.fillStyle = '#71717a';   // padlock
    ctx.beginPath(); ctx.roundRect(left, y + 13, 9, 7, 1.5); ctx.fill();
    ctx.strokeStyle = '#71717a'; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.arc(left + 4.5, y + 13, 2.8, Math.PI, 0); ctx.stroke();
    ctx.fillStyle = '#52525b'; ctx.fillText(text, left + 16, heightCss / 2 + 0.5);
  }
  return canvas;
}

/** The background: a mesh preset, a mesh around the page's brand hue, or null for the blurred page. */
function backgroundFor(frame, firstFrame) {
  if (frame.background === 'blur') return null;
  if (frame.background !== 'auto') return BACKGROUNDS[frame.background];
  const ctx = new OffscreenCanvas(96, 60).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(firstFrame, 0, 0, 96, 60);
  const hue = brandHue(ctx.getImageData(0, 0, 96, 60).data);
  return hue === null ? BACKGROUNDS.aurora : autoBackground(hue);
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

/** A WritableStream that posts each positioned chunk to Node, which writes it into the Final. */
const uploadStream = url => new WritableStream({
  async write(chunk) {
    const response = await fetch(`${url}?position=${chunk.position}`, { method: 'POST', body: chunk.data });
    if (!response.ok) throw new Error(`Writing the Final failed: ${response.status}`);
  },
});

window.cuetakeRender = async ({ sourceUrl, finalUrl, duration, viewport, pointer, events, edit }) => {
  const { camera, cursor, clickEffect, frame } = edit, { quality, fps } = edit.output;
  const stage = layout(edit, viewport), { width, height } = stage;
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
  const compositor = createCompositor(stage, { framed: Boolean(frame), shadow: frame && frame.shadow, background: frame && backgroundFor(frame, current) }, track.codedWidth, track.codedHeight);
  const cameraPath = cameraTrack({ targets: camera.targets, viewport, camera, duration, fps, pointerAt: t => pointerAt(pointer, t) });
  // Page CSS pixels → stage pixels; sprites are rasterized for the closest zoom and mipmapped below it.
  const at = (x, y) => [stage.page.x + x * stage.scale, stage.page.y + y * stage.scale];
  const sharpest = stage.scale * camera.maxZoom * 2;
  const geometry = cursorGeometry(cursor);
  const pointerSprite = cursorSprite(cursor, sharpest);
  const pointerTexture = compositor.sprite(pointerSprite.canvas);
  const chromeTexture = stage.chrome ? compositor.sprite(chromeSprite(frame, viewport.width, stage.chrome / stage.scale, stage.radius / stage.scale, sharpest)) : null;
  const pressList = presses(events);
  const sparkReach = clickEffect.radius + clickEffect.length + 8;
  let sparkTexture = null;
  const origin = current.timestamp;
  try {
    for (let i = 0; i < frameCount; i++) {
      if (failure) throw failure;
      // Sample and hold: show the latest Source frame at or before this output time (VFR → CFR).
      const due = origin + Math.round(i * 1e6 / fps);
      while (next && next.timestamp <= due) { current.close(); current = next; next = await reader.next(); }
      if (uploaded !== current) { compositor.upload(current); uploaded = current; }
      const t = i / fps, view = cameraView(cameraPath[i], stage, viewport);
      compositor.frame(view.x, view.y, view.zoom, draw => {
        if (chromeTexture) draw(chromeTexture, [stage.window.x, stage.window.y, stage.window.w, stage.chrome]);
        for (const spark of sparksAt(pressList, clickEffect, t)) {
          // Each spark is drawn at its on-screen scale so the thin rays stay crisp.
          const scale = stage.scale * view.zoom, size = Math.ceil(2 * sparkReach * scale);
          const ctx = new OffscreenCanvas(size, size).getContext('2d');
          ctx.scale(scale, scale);
          drawSpark(ctx, sparkReach, sparkReach, spark.progress, clickEffect, cursor.color);
          sparkTexture = compositor.sprite(ctx.canvas, sparkTexture, false);
          draw(sparkTexture, [...at(spark.x - sparkReach, spark.y - sparkReach), 2 * sparkReach * stage.scale, 2 * sparkReach * stage.scale]);
        }
        const point = pointerAt(pointer, t);
        if (point) draw(pointerTexture, [...at(point.x - geometry.hotspot.x - pointerSprite.margin, point.y - geometry.hotspot.y - pointerSprite.margin), pointerSprite.width * stage.scale, pointerSprite.height * stage.scale]);
      });
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

/** One Final frame at `seconds`, as a base64 PNG. */
window.cuetakeFrame = async (url, seconds) => {
  const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.UrlSource(url) });
  const wrapped = await new MB.CanvasSink(await input.getPrimaryVideoTrack()).getCanvas(seconds);
  if (!wrapped) throw new Error(`No frame at ${seconds} s`);
  const { canvas } = wrapped;
  const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/png' }) : await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
};
