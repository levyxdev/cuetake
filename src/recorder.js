import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openRecorder, startTabCapture, stopTabCapture, watchNavigations, captureArgs } from './tab-capture.js';
import { followTabs } from './follow-tabs.js';
import { installProbe } from './probe.js';

let browser = null;
const sessions = new Map();

export async function startRecording(url, options = {}) {
  const width = options.width || 1440, height = options.height || 900;
  const resolutionScale = options.resolutionScale || 2;
  // Headless by default. Chromium's new headless mode (channel 'chromium') supports tab capture,
  // but only captures at device scale when the scale is also forced on the browser.
  browser ||= await chromium.launch({
    headless: !options.headed, channel: 'chromium',
    args: [...captureArgs, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', ...(options.headed ? [] : [`--force-device-scale-factor=${resolutionScale}`])],
  });
  const { outputDir } = options;
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

/**
 * Starts the Timeline probe and the recorder on the page, and follows each Tab the demo opens from it
 * (follow-tabs.js), recording each the same way. Returns when the first Tab records, with its capture
 * and `tabs`, the Tabs followed.
 */
export async function beginCapture(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || session.tabs) throw new Error('Session is missing or already recording');
  // Preparation may navigate through login, before the probe and the recorder start; both then follow
  // the page through any navigation or reload until Capture stops.
  const recorder = await openRecorder(session.page), scale = session.resolutionScale;
  session.tabs = followTabs(session.page, {
    watch: tab => watchNavigations(tab.page),
    async start(tab) {
      await installProbe(tab.page);
      const { width, height } = tab.viewport;
      tab.capture = await startTabCapture(tab.page, recorder, { width: width * scale, height: height * scale, fps: session.options.fps || 60, bitrate: 40_000_000 });
    },
  });
  await session.tabs.ready(session.page);
  return { ...session.tabs.list()[0].capture, tabs: session.tabs };
}

/**
 * Stops recording every Tab and closes the session. Each recorded Tab's Source is written to
 * `recording-<session>-<tab>.webm` beside its stats; times are seconds since the first Tab began
 * recording, except in each Tab's stats, which count from its own start. `fronts` lists when each Tab
 * came in front.
 */
export async function stopRecording(sessionId) {
  const session = sessions.get(sessionId);
  if (!session?.tabs) throw new Error('Session has not started recording');
  // A Tab the demo opened just before the end may still be starting.
  await session.tabs.started();
  const tabs = session.tabs.list().filter(tab => tab.recorded);
  const startedAtMs = Date.parse(tabs[0].capture.startedAt), t = ms => ms === null ? null : Math.round(Math.max(0, ms - startedAtMs)) / 1000;
  const stopped = await Promise.all(tabs.map(async tab => {
    const webmPath = join(session.outputDir, `recording-${sessionId}-${tab.id}.webm`);
    const stats = await stopTabCapture(tab.page, webmPath), start = t(Date.parse(tab.capture.startedAt));
    // The stats count from the Tab's own start; its navigations join the Timeline from the start of Capture.
    const at = s => Math.max(0, Math.round((s + start) * 1000) / 1000);
    const navigations = stats.navigations.filter(load => load.end + start >= 0).map(({ t, end, commit, ...load }) => ({ t: at(t), end: at(end), ...(commit !== undefined && { commit: at(commit) }), ...load }));
    return { id: tab.id, opener: tab.opener, opened: t(tab.openedMs), closed: t(tab.closedMs), viewport: tab.viewport, url: tab.id === 0 ? tab.capture.url : tab.url, start, webmPath, stats, navigations };
  }));
  const recorded = new Set(tabs.map(tab => tab.id));
  await session.context.close();
  sessions.delete(sessionId);
  // The Take lasts until the last Tab stops, even when the first one closed before.
  const durationSeconds = Math.max(...stopped.map(tab => Math.round((tab.start + tab.stats.duration) * 1000) / 1000));
  return { durationSeconds, tabs: stopped, fronts: session.tabs.fronts.filter(front => recorded.has(front.tab)).map(front => ({ t: t(front.ms), tab: front.tab })) };
}

export async function cleanup() {
  for (const session of sessions.values()) await session.context.close().catch(() => {});
  sessions.clear();
  await browser?.close().catch(() => {});
  browser = null;
}
