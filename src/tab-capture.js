import { writeFile } from 'node:fs/promises';

// Capture Chromium's current tab at its device-pixel resolution. Unlike
// Playwright recordVideo, this does not use the 25 fps / 1 Mbps VP8 encoder.
// A full-document navigation ends this recorder; SPA navigation is supported.
export async function startTabCapture(page, options) {
  let timeout;
  try {
    return await Promise.race([page.evaluate(async ({ fps, width, height, bitrate }) => {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps, max: fps } },
      audio: false,
      preferCurrentTab: true,
    });
    try {
      const track = stream.getVideoTracks()[0];
      await track.applyConstraints({ width, height, frameRate: fps });
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      // Subscribe before play: a static tab may never produce a second frame.
      const firstFrame = new Promise(resolve => video.requestVideoFrameCallback(resolve));
      await video.play();
      await firstFrame;
      const mimeType = 'video/webm;codecs=vp9';
      if (!MediaRecorder.isTypeSupported(mimeType)) throw new Error('VP9 tab capture unavailable');
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
      const state = { stream, video, recorder, chunks: [], frames: [], settings: track.getSettings(), error: null };
      window.__cuetakeCapture = state;
      const tick = (now, metadata) => {
        if (recorder.state !== 'recording') return;
        state.frames.push({ timeMs: performance.timeOrigin + now - state.startedAtMs, mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames });
        video.requestVideoFrameCallback(tick);
      };
      recorder.ondataavailable = event => { if (event.data.size) state.chunks.push(event.data); };
      recorder.onerror = event => { state.error = event.error?.message || 'MediaRecorder error'; };
      await new Promise(resolve => {
        recorder.onstart = () => { state.startedAtMs = Date.now(); video.requestVideoFrameCallback(tick); resolve(); };
        recorder.start(1000);
      });
      return { startedAt: new Date(state.startedAtMs).toISOString(), settings: state.settings };
    } catch (error) {
      stream.getTracks().forEach(track => track.stop());
      throw error;
    }
  }, options), new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Tab capture did not start within 15 seconds')), 15_000);
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
    const stats = { settings: state.settings, duration: (stoppedAtMs - state.startedAtMs) / 1000, frames: state.frames };
    delete window.__cuetakeCapture;
    return { data: btoa(binary), stats };
  });
  await writeFile(outputPath, Buffer.from(result.data, 'base64'));
  await writeFile(outputPath.replace(/\.webm$/, '-capture.json'), JSON.stringify(result.stats, null, 2));
  return result.stats;
}
