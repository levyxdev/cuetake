import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { doctor } from './environment.js';
import { z } from 'zod';
import { startRecording, getRecordingPage, beginCapture, stopRecording, cleanup } from './recorder.js';
import { renderFinal, inspectFinal } from './render.js';
import { outputSize } from './stage.js';
import { resolveAuthProfile } from './auth.js';
import { createDirector } from './director.js';
import { collectTimeline } from './probe.js';
import { editFields, editSchema, createEdit } from './edit.js';
import pkg from '../package.json' with { type: 'json' };

const SCHEMA_VERSION = 2;
const evenSize = z.number().int().min(240).max(7680).refine(n => n % 2 === 0, 'Must be an even pixel count');
/** Scenario config: capture settings plus the defaults that seed each Take's Edit. */
export const scenarioSchema = z.object({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  url: z.string().url().refine(s => /^https?:/.test(s), 'Capture requires HTTP(S)'),
  viewport: z.object({ width: evenSize, height: evenSize }).default({ width: 1440, height: 900 }),
  capture: z.object({ fps: z.union([z.literal(30), z.literal(60)]).default(60), resolutionScale: z.union([z.literal(1), z.literal(2)]).default(2) }).default({}),
  ...editFields,
});
const writeJson = (path, data) => fs.writeFile(path, JSON.stringify(data, null, 2) + '\n');
const readJson = async path => JSON.parse(await fs.readFile(path, 'utf8'));

/** New take directories are exclusive: reruns never overwrite a previous take. */
export async function recordScenario(scenarioPath, outputDir, options = {}) {
  const scenario = await import(pathToFileURL(resolve(scenarioPath)).href);
  const config = scenarioSchema.parse(scenario.config);
  if (typeof scenario.run !== 'function') throw new Error('Scenario must export run(director)');
  const authState = options.authProfile ? await resolveAuthProfile(options.authProfile) : undefined;
  const ready = await doctor();
  if (!ready.ok) throw new Error(JSON.stringify(ready));
  const dir = resolve(outputDir || join('recordings', config.name, new Date().toISOString().replace(/[:.]/g, '-')));
  await fs.mkdir(resolve(dir, '..'), { recursive: true });
  await fs.mkdir(dir); // EEXIST is intentional, including for empty existing folders.
  let project = { schemaVersion: SCHEMA_VERSION, tool: 'CueTake', version: pkg.version, createdAt: new Date().toISOString(), status: 'recording', authenticated: Boolean(authState), config };
  await writeJson(join(dir, 'project.json'), project);
  await fs.copyFile(resolve(scenarioPath), join(dir, 'scenario.mjs'));
  try {
    const session = await startRecording(config.url, {
      ...config.viewport, ...config.capture, outputDir: dir, deferCapture: true, storageState: authState, headed: options.headed,
    });
    const page = getRecordingPage(session.sessionId);
    if (scenario.prepare) await scenario.prepare(page);
    await page.evaluate(() => document.fonts.ready);
    const capture = await beginCapture(session.sessionId);
    const startedAtMs = Date.parse(capture.startedAt);
    const focus = [], wide = [];
    const director = createDirector(page, startedAtMs, config.capture.fps, focus, wide);
    const evidence = await scenario.run(director);
    await page.screenshot({ path: join(dir, 'poster.png') });
    const observed = await collectTimeline(page, startedAtMs);
    const stopped = await stopRecording(session.sessionId);
    await fs.rename(stopped.webmPath, join(dir, 'source.webm'));
    await fs.rename(stopped.webmPath.replace(/\.webm$/, '-capture.json'), join(dir, 'capture.json'));
    const timeline = {
      schemaVersion: SCHEMA_VERSION, viewport: config.viewport, scale: config.capture.resolutionScale, duration: stopped.durationSeconds,
      pointer: observed.pointer, events: [...observed.events, ...focus.map(f => ({ type: 'focus', ...f }))].sort((a, b) => a.t - b.t),
    };
    await writeJson(join(dir, 'timeline.json'), timeline);
    await writeJson(join(dir, 'edit.json'), createEdit(config, timeline, focus, wide));
    project = { ...project, status: 'captured', duration: stopped.durationSeconds, evidence: evidence ?? null };
    await writeJson(join(dir, 'project.json'), project);
  } catch (error) {
    await writeJson(join(dir, 'project.json'), { ...project, status: 'failed', error: error.message });
    throw error;
  } finally { await cleanup(); }
  await renderTake(dir);
  const verification = await verifyTake(dir);
  return { directory: dir, final: join(dir, 'final.mp4'), verification };
}

/** Reads a Take's project, Timeline and Edit, refusing Takes from an older schema. */
async function loadTake(dir) {
  const project = await readJson(join(dir, 'project.json'));
  if (project.schemaVersion !== SCHEMA_VERSION) throw new Error(`${dir} was recorded by an older CueTake (schema ${project.schemaVersion ?? 1}); record it again`);
  return { project, config: scenarioSchema.parse(project.config), timeline: await readJson(join(dir, 'timeline.json')), edit: editSchema.parse(await readJson(join(dir, 'edit.json'))) };
}

export async function renderTake(directory) {
  const dir = resolve(directory);
  const { project, config, timeline, edit } = await loadTake(dir);
  // Render to a temporary output; preserve the last complete final if encoding fails.
  const temporary = join(dir, 'final.pending.mp4');
  try {
    const render = await renderFinal({ sourcePath: join(dir, 'source.webm'), outputPath: temporary, timeline, edit, fps: config.capture.fps });
    await fs.rename(temporary, join(dir, 'final.mp4'));
    await writeJson(join(dir, 'render.json'), render);
    await fs.rm(join(dir, 'verification.json'), { force: true });
    await writeJson(join(dir, 'project.json'), { ...project, status: 'rendered' });
  } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  return join(dir, 'final.mp4');
}

export function summarizeFrames(frames, duration) {
  const intervals = frames.slice(1).map((f, i) => f.timeMs - frames[i].timeMs);
  const sorted = intervals.toSorted((a, b) => a - b);
  const seconds = Array.from({ length: Math.ceil(duration) }, (_, second) => ({ second, callbacks: frames.filter(f => f.timeMs >= second * 1000 && f.timeMs < (second + 1) * 1000).length }));
  return { callbacks: frames.length, medianIntervalMs: sorted[Math.floor(sorted.length / 2)] ?? null, maxIntervalMs: sorted.at(-1) ?? null, perSecond: seconds, note: 'Source capture is variable frame rate. Static sections reduce cadence; callback counts are observations, not a guarantee of unique encoded frames. Final output uses constant frame rate without motion interpolation.' };
}

export async function verifyTake(directory) {
  const dir = resolve(directory);
  const { project, config, timeline, edit } = await loadTake(dir);
  const media = await inspectFinal(join(dir, 'final.mp4'));
  const expected = { ...outputSize(edit, timeline.viewport), fps: config.capture.fps, frames: Math.round(project.duration * config.capture.fps) };
  const problems = [
    media.width !== expected.width || media.height !== expected.height ? `size ${media.width}×${media.height}, expected ${expected.width}×${expected.height}` : null,
    Math.abs(media.fps - expected.fps) > 0.01 ? `${media.fps} fps, expected ${expected.fps}` : null,
    media.packets !== expected.frames ? `${media.packets} frames, expected ${expected.frames}` : null,
    media.decodedFrames !== media.packets ? `only ${media.decodedFrames} of ${media.packets} frames decoded` : null,
  ].filter(Boolean);
  if (problems.length) throw new Error(`Final failed verification: ${problems.join('; ')}`);
  const capture = await readJson(join(dir, 'capture.json'));
  const verification = { passed: true, checkedAt: new Date().toISOString(), media, source: { settings: capture.settings, ...summarizeFrames(capture.frames, capture.duration) }, fullDecode: 'passed' };
  await writeJson(join(dir, 'verification.json'), verification);
  await writeJson(join(dir, 'project.json'), { ...project, status: 'verified' });
  return verification;
}
