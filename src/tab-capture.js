import { writeFile } from 'node:fs/promises';

// Capture Chromium's current tab at its device-pixel resolution. Unlike
// Playwright recordVideo, this does not use the 25 fps / 1 Mbps VP8 encoder.
// A full-document navigation ends this recorder; SPA navigation is supported.
export async function startTabCapture(page, options) {
  let timeout;
  try {
    return await Promise.race([page.evaluate(async ({ fps, width, height, bitrate }) => {
    // The stage names the step a stalled start is waiting on.
    window.__cuetakeCaptureStage = 'getDisplayMedia';
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps, max: fps } },
      audio: false,
      preferCurrentTab: true,
    });
    // Headless Chromium paints only on change, so a settled page sends no frame and play() never
    // resolves. A near-invisible pixel flickers until recording starts to force paints.
    const nudge = Object.assign(document.createElement('div'), { style: 'position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none;z-index:2147483647' });
    document.documentElement.append(nudge);
    let flip = false;
    const nudging = setInterval(() => { flip = !flip; nudge.style.background = flip ? 'rgba(0,0,0,0.004)' : 'rgba(0,0,0,0.002)'; }, 50);
    const stopNudging = () => { clearInterval(nudging); nudge.remove(); };
    try {
      const track = stream.getVideoTracks()[0];
      window.__cuetakeCaptureStage = 'applyConstraints';
      await track.applyConstraints({ width, height, frameRate: fps });
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      // Subscribe before play: a static tab may never produce a second frame.
      const firstFrame = new Promise(resolve => video.requestVideoFrameCallback(resolve));
      window.__cuetakeCaptureStage = 'play';
      await video.play();
      window.__cuetakeCaptureStage = 'first frame';
      await firstFrame;
      const mimeType = 'video/webm;codecs=vp9';
      if (!MediaRecorder.isTypeSupported(mimeType)) throw new Error('VP9 tab capture unavailable');
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
      const state = { stream, video, recorder, chunks: [], frames: [], pageFrames: [], settings: track.getSettings(), error: null };
      window.__cuetakeCapture = state;
      const tick = (now, metadata) => {
        if (recorder.state !== 'recording') return;
        state.frames.push({ timeMs: performance.timeOrigin + now - state.startedAtMs, mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames });
        video.requestVideoFrameCallback(tick);
      };
      // Animation frames per second of Capture. A still page sends few Source frames, but its animation
      // frames keep the display rate while the browser keeps up, so a shortfall means the machine fell behind.
      const animate = now => {
        if (recorder.state !== 'recording') return;
        const second = Math.floor((performance.timeOrigin + now - state.startedAtMs) / 1000);
        if (second >= 0) state.pageFrames[second] = (state.pageFrames[second] ?? 0) + 1;
        requestAnimationFrame(animate);
      };
      recorder.ondataavailable = event => { if (event.data.size) state.chunks.push(event.data); };
      recorder.onerror = event => { state.error = event.error?.message || 'MediaRecorder error'; };
      window.__cuetakeCaptureStage = 'MediaRecorder start';
      await new Promise(resolve => {
        recorder.onstart = () => { state.startedAtMs = Date.now(); stopNudging(); video.requestVideoFrameCallback(tick); requestAnimationFrame(animate); resolve(); };
        recorder.start(1000);
      });
      return { startedAt: new Date(state.startedAtMs).toISOString(), settings: state.settings };
    } catch (error) {
      stopNudging();
      stream.getTracks().forEach(track => track.stop());
      throw error;
    }
  }, options), new Promise((_, reject) => {
    timeout = setTimeout(async () => {
      const stage = await page.evaluate(() => window.__cuetakeCaptureStage).catch(() => 'unknown');
      reject(new Error(`Tab capture did not start within 15 seconds (waiting on: ${stage})`));
    }, 15_000);
  })]);
  } finally { clearTimeout(timeout); }
}

export async function stopTabCapture(page, outputPath) {
  const result = await page.evaluate(async () => {
    const state = window.__cuetakeCapture;
    if (!state) throw new Error('Tab recorder lost: full-document navigation is unsupported in hd-tab mode');
    const stoppedAtMs = Date.now();
    await new Promise(resolve => { state.recorder.onstop = resolve; state.recorder.stop(); });
    state.stream.getTracks().forEach(track => track.stop());
    state.video.srcObject = null;
    if (state.error) throw new Error(state.error);
    const bytes = new Uint8Array(await new Blob(state.chunks).arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    const stats = { settings: state.settings, duration: (stoppedAtMs - state.startedAtMs) / 1000, frames: state.frames, pageFrames: Array.from(state.pageFrames, n => n ?? 0) };
    delete window.__cuetakeCapture;
    return { data: btoa(binary), stats };
  });
  await writeFile(outputPath, Buffer.from(result.data, 'base64'));
  await writeFile(outputPath.replace(/\.webm$/, '-capture.json'), JSON.stringify(result.stats, null, 2));
  return result.stats;
}
