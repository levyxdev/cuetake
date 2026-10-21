/**
 * Runs inside Chromium (see render.js). Source WebM → VideoDecoder → one WebGL2 pass per output
 * frame → VideoEncoder (H.264) → MP4, streamed back to Node in chunks.
 *
 * Spaces: camera crops are CSS pixels of the viewport; the Source texture is sampled by UV only;
 * "stage" is output pixels with the page filling it at camera zoom 1.
 */
import * as MB from '/mediabunny.js';
import { buildChains, cropAt } from '/camera.js';
import { pointerAt, presses, sparksAt, cursorGeometry, drawSpark, ARROW_PATH } from '/cursor.js';

const VERTEX = `#version 300 es
in vec2 p; void main() { gl_Position = vec4(p, 0, 1); }`;
const FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 uRes;    // output size
uniform vec4 uWin;    // page rectangle in stage pixels
uniform vec3 uCam;    // stage point at the output center, and zoom
uniform sampler2D uPage;
out vec4 color;
void main() {
  vec2 pixel = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 stage = (pixel - uRes * 0.5) / uCam.z + uCam.xy;
  color = vec4(texture(uPage, clamp((stage - uWin.xy) / uWin.zw, 0.0, 1.0)).rgb, 1.0);
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

function createCompositor(width, height, sourceWidth, sourceHeight) {
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
  gl.uniform4f(pageProgram.uniform('uWin'), 0, 0, width, height);
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

window.cuetakeRender = async ({ sourceUrl, finalUrl, width, height, fps, duration, quality, viewport, camera, pointer, events, cursor, clickEffect }) => {
  const started = performance.now();
  const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.UrlSource(sourceUrl) });
  const track = await input.getPrimaryVideoTrack();
  const reader = frameReader(track, await track.getDecoderConfig());
  const compositor = createCompositor(width, height, track.codedWidth, track.codedHeight);
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

  const chains = buildChains(camera.targets, viewport, camera);
  const toStage = width / viewport.width; // page fills the stage at zoom 1
  const geometry = cursorGeometry(cursor);
  // Rasterize the cursor for the closest zoom, oversampled; mipmaps cover smaller sizes.
  const arrow = cursorSprite(cursor, toStage * camera.zoomLevel * 2);
  const arrowTexture = compositor.sprite(arrow.canvas);
  const pressList = presses(events);
  const sparkReach = clickEffect.radius + clickEffect.length + 8;
  let sparkTexture = null;
  let current = await reader.next(), next = await reader.next(), uploaded = null;
  if (!current) throw new Error('Source has no video frames');
  const origin = current.timestamp;
  try {
    for (let i = 0; i < frameCount; i++) {
      if (failure) throw failure;
      // Sample and hold: show the latest Source frame at or before this output time (VFR → CFR).
      const at = origin + Math.round(i * 1e6 / fps);
      while (next && next.timestamp <= at) { current.close(); current = next; next = await reader.next(); }
      if (uploaded !== current) { compositor.upload(current); uploaded = current; }
      const t = i / fps, crop = cropAt(chains, viewport, t), zoom = viewport.width / crop.w;
      compositor.frame((crop.x + crop.w / 2) * toStage, (crop.y + crop.h / 2) * toStage, zoom, draw => {
        for (const spark of sparksAt(pressList, clickEffect, t)) {
          // Each spark is drawn at its on-screen scale so the thin rays stay crisp.
          const scale = toStage * zoom, size = Math.ceil(2 * sparkReach * scale);
          const ctx = new OffscreenCanvas(size, size).getContext('2d');
          ctx.scale(scale, scale);
          drawSpark(ctx, sparkReach, sparkReach, spark.progress, clickEffect, cursor.color);
          sparkTexture = compositor.sprite(ctx.canvas, sparkTexture, false);
          draw(sparkTexture, [(spark.x - sparkReach) * toStage, (spark.y - sparkReach) * toStage, 2 * sparkReach * toStage, 2 * sparkReach * toStage]);
        }
        const point = pointerAt(pointer, t);
        if (point) draw(arrowTexture, [(point.x - geometry.hotspot.x - arrow.margin) * toStage, (point.y - geometry.hotspot.y - arrow.margin) * toStage, arrow.width * toStage, arrow.height * toStage]);
      });
      const frame = new VideoFrame(compositor.canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0, ...(quantizer ? { avc: { quantizer } } : {}) });
      frame.close();
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
    frames: frameCount, sourceFrames: reader.stats().decoded, codec: config.codec,
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
