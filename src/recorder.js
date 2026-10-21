import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startTabCapture, stopTabCapture } from './tab-capture.js';
import { injectDemoOverlay } from './overlay.js';
import { installProbe } from './probe.js';

let browser = null;
const sessions = new Map();

export async function startRecording(url, options = {}) {
  browser ||= await chromium.launch({ headless: false, args: ['--auto-accept-this-tab-capture', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] });
  const width = options.width || 1440, height = options.height || 900;
  const resolutionScale = options.resolutionScale || 2;
  const outputDir = options.outputDir || './recordings';
  await mkdir(outputDir, { recursive: true });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: resolutionScale, ...(options.storageState ? { storageState: options.storageState } : {}) });
  const sessionId = randomUUID().slice(0, 8);
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    sessions.set(sessionId, { context, page, width, height, resolutionScale, options, outputDir });
    if (!options.deferCapture) await beginCapture(sessionId);
    return { sessionId, url };
  } catch (error) { sessions.delete(sessionId); await context.close(); throw error; }
}

export function getRecordingPage(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown session ${sessionId}`);
  return session.page;
}

export async function beginCapture(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || session.capture) throw new Error('Session is missing or already recording');
  // Preparation may navigate through login; install the overlay only at the final document.
  await injectDemoOverlay(session.page, session.options);
  await installProbe(session.page);
  const capture = await startTabCapture(session.page, { width: session.width * session.resolutionScale, height: session.height * session.resolutionScale, fps: session.options.fps || 60, bitrate: 40_000_000 });
  session.capture = capture;
  return capture;
}

export async function stopRecording(sessionId) {
  const session = sessions.get(sessionId);
  if (!session?.capture) throw new Error('Session has not started recording');
  const webmPath = join(session.outputDir, `recording-${sessionId}.webm`);
  const stats = await stopTabCapture(session.page, webmPath);
  await session.context.close();
  sessions.delete(sessionId);
  return { webmPath, durationSeconds: stats.duration };
}

export async function cleanup() {
  for (const session of sessions.values()) await session.context.close().catch(() => {});
  sessions.clear();
  await browser?.close().catch(() => {});
  browser = null;
}
