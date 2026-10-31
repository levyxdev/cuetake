import { writeFile } from 'node:fs/promises';

/** The title the demo page wears for an instant, so Chromium hands its tab to the recorder. */
const CAPTURE_TITLE = '__cuetake_capture__';
/** Chromium flags Capture needs: pick the tab with that title without asking. */
export const captureArgs = [`--auto-select-tab-capture-source-by-title=${CAPTURE_TITLE}`];
/** The recorder's page, answered by its own route so it is a secure context that loads nothing. */
const RECORDER_URL = 'https://recorder.cuetake.invalid/';

const captures = new WeakMap(), counting = new WeakSet();

/**
 * Counts the page's animation frames in its top document, sending their times to Node a few times a
 * second and as the document goes away. A still page sends few Source frames, but its animation frames
 * keep the display rate while the browser keeps up, so a shortfall means the machine fell behind.
 */
function countAnimationFrames() {
  if (window !== window.top || window.__cuetakeAnimationFrames) return;
  window.__cuetakeAnimationFrames = true;
  let times = [];
  const flush = () => { if (!times.length) return; const sent = times; times = []; try { window.__cuetakePaint?.(sent)?.catch?.(() => {}); } catch {} };
  const animate = now => { times.push(performance.timeOrigin + now); requestAnimationFrame(animate); };
  requestAnimationFrame(animate);
  setInterval(flush, 250);
  addEventListener('pagehide', flush);
}

/**
 * Captures the page's tab at its device-pixel resolution from a recorder page of its own, so the
 * Source keeps recording across full navigations and reloads of the page. Unlike Playwright
 * recordVideo, this does not use the 25 fps / 1 Mbps VP8 encoder. Each main-frame navigation is noted,
 * from its request until the new document has loaded, with when the page took its new address (`commit`).
 * Returns the page's address when Capture started as `url`.
 */
export async function startTabCapture(page, options) {
  const state = { paints: [], navigations: [] };
  // A page that captured before keeps its binding and init script; only the collection starts over.
  if (!counting.has(page)) {
    counting.add(page);
    await page.exposeBinding('__cuetakePaint', (_, times) => { if (Array.isArray(times)) captures.get(page)?.paints.push(...times); });
    await page.addInitScript(countAnimationFrames);
  }
  // A redirect, or a navigation started before the last one committed, continues it.
  const onRequest = request => {
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
    const last = state.navigations.at(-1);
    if (last?.end === null && !last.commit) { last.url = request.url(); return; }
    // One that starts after the last committed, such as a script's redirect while loading, is its own.
    if (last?.end === null) last.end = Date.now();
    state.navigations.push({ ms: Date.now(), url: request.url(), end: null });
  };
  // A navigation that fails or turns into a download never loads a document.
  const onEnd = () => { const last = state.navigations.at(-1); if (last?.end === null) last.end = Date.now(); };
  // The page takes its new address when the new document commits, after any redirect. A same-document
  // navigation (pushState, a fragment) also reports here, but finds no navigation waiting for one.
  const onCommit = frame => {
    const last = state.navigations.at(-1);
    if (frame !== page.mainFrame() || last?.end !== null || last.commit) return;
    last.commit = Date.now();
    last.url = frame.url();
  };
  const onFailed = request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) onEnd(); };
  page.on('request', onRequest);
  page.on('load', onEnd);
  page.on('requestfailed', onFailed);
  page.on('download', onEnd);
  page.on('framenavigated', onCommit);
  state.detach = () => { page.off('request', onRequest); page.off('load', onEnd); page.off('requestfailed', onFailed); page.off('download', onEnd); page.off('framenavigated', onCommit); };
  const recorder = await page.context().newPage();
  state.recorder = recorder;
  captures.set(page, state);
  let timeout;
  try {
    await recorder.route(RECORDER_URL, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>CueTake recorder</title>' }));
    await recorder.goto(RECORDER_URL);
    await page.bringToFront();
    await page.evaluate(countAnimationFrames);
    // Headless Chromium paints only on change, so a settled page sends no frame and play() never
    // resolves. A near-invisible pixel flickers until recording starts to force paints.
    const named = await page.evaluate(title => {
      const nudge = Object.assign(document.createElement('div'), { style: 'position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none;z-index:2147483647' });
      document.documentElement.append(nudge);
      let flip = false;
      const nudging = setInterval(() => { flip = !flip; nudge.style.background = flip ? 'rgba(0,0,0,0.004)' : 'rgba(0,0,0,0.002)'; }, 50);
      window.__cuetakeStopNudging = () => { clearInterval(nudging); nudge.remove(); delete window.__cuetakeStopNudging; };
      const had = Boolean(document.querySelector('title')), old = document.title;
      document.title = title;
      return { had, old };
    }, CAPTURE_TITLE);
    const restore = () => page.evaluate(({ had, old }) => {
      window.__cuetakeStopNudging?.();
      if (had) document.title = old; else document.querySelector('title')?.remove();
    }, named).catch(() => {});
    try {
      return await Promise.race([recorder.evaluate(async ({ fps, width, height, bitrate }) => {
        // The stage names the step a stalled start is waiting on.
        window.__cuetakeCaptureStage = 'getDisplayMedia';
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps, max: fps } },
          audio: false,
          selfBrowserSurface: 'exclude',
        });
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
          const state = { stream, video, recorder, chunks: [], frames: [], settings: track.getSettings(), error: null };
          window.__cuetakeCapture = state;
          const tick = (now, metadata) => {
            if (recorder.state !== 'recording') return;
            state.frames.push({ timeMs: performance.timeOrigin + now - state.startedAtMs, mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames });
            video.requestVideoFrameCallback(tick);
          };
          recorder.ondataavailable = event => { if (event.data.size) state.chunks.push(event.data); };
          recorder.onerror = event => { state.error = event.error?.message || 'MediaRecorder error'; };
          window.__cuetakeCaptureStage = 'MediaRecorder start';
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
        timeout = setTimeout(async () => {
          const stage = await recorder.evaluate(() => window.__cuetakeCaptureStage).catch(() => 'unknown');
          reject(new Error(`Tab capture did not start within 15 seconds (waiting on: ${stage})`));
        }, 15_000);
      })]).then(started => { state.startedAtMs = Date.parse(started.startedAt); return { ...started, url: page.url() }; });
    } finally { clearTimeout(timeout); await restore(); }
  } catch (error) {
    await stopListening(page);
    throw error;
  }
}

async function stopListening(page) {
  const state = captures.get(page);
  if (!state) return null;
  captures.delete(page);
  state.detach();
  await state.recorder.close().catch(() => {});
  return state;
}

/**
 * Seconds since Capture started of each animation frame's second, and of each navigation, from its
 * request until its document loaded (or Capture stopped), with when it committed, if it did.
 */
export function captureSeconds({ paints, navigations, startedAtMs }, stoppedAtMs) {
  const pageFrames = [];
  for (const ms of paints) {
    if (ms < startedAtMs || ms >= stoppedAtMs) continue;
    const second = Math.floor((ms - startedAtMs) / 1000);
    pageFrames[second] = (pageFrames[second] ?? 0) + 1;
  }
  const t = ms => Math.round(Math.max(0, Math.min(ms, stoppedAtMs) - startedAtMs)) / 1000;
  return {
    pageFrames: Array.from(pageFrames, n => n ?? 0),
    navigations: navigations.filter(n => (n.end ?? stoppedAtMs) >= startedAtMs && n.ms < stoppedAtMs).map(n => ({ t: t(n.ms), end: t(n.end ?? stoppedAtMs), url: n.url, ...(n.commit && n.commit < stoppedAtMs && { commit: t(n.commit) }) })),
  };
}

export async function stopTabCapture(page, outputPath) {
  const state = captures.get(page);
  if (!state) throw new Error('This page is not being captured');
  try {
    // Animation frames the page counted before the stop arrive before its answer to an evaluate.
    await page.evaluate(() => 0).catch(() => {});
    const result = await state.recorder.evaluate(async () => {
      const state = window.__cuetakeCapture;
      const stoppedAtMs = Date.now();
      await new Promise(resolve => { state.recorder.onstop = resolve; state.recorder.stop(); });
      state.stream.getTracks().forEach(track => track.stop());
      state.video.srcObject = null;
      if (state.error) throw new Error(state.error);
      const bytes = new Uint8Array(await new Blob(state.chunks).arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      return { data: btoa(binary), stoppedAtMs, stats: { settings: state.settings, duration: (stoppedAtMs - state.startedAtMs) / 1000, frames: state.frames } };
    });
    const stats = { ...result.stats, ...captureSeconds(state, result.stoppedAtMs) };
    await writeFile(outputPath, Buffer.from(result.data, 'base64'));
    await writeFile(outputPath.replace(/\.webm$/, '-capture.json'), JSON.stringify(stats, null, 2));
    return stats;
  } finally { await stopListening(page); }
}
