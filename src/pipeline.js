import fs from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { doctor } from './environment.js';
import { z } from 'zod';
import { startRecording, getRecordingPage, beginCapture, stopRecording, cleanup } from './recorder.js';
import { renderFinal, inspectFinal, composePreview, measureLines } from './render.js';
import { outputSize, atShortSide } from './stage.js';
import { resolveAuthProfile } from './auth.js';
import { createDirector } from './director.js';
import { collectTimeline } from './probe.js';
import { createEdit, evenSize, merge, withDefaults } from './edit.js';
import { loadLook, resolvedLook, applyLook, lookFromEdit, saveLook, summarize } from './look.js';
import { absolute, bundle, forRender } from './styles.js';
import { burnsIn, cuesFor, isCjk, lineProblems, toSrt, toVtt } from './narration.js';
import pkg from '../package.json' with { type: 'json' };

const SCHEMA_VERSION = 3;
/** Scenario config: capture settings, validated, plus styling that seeds each Take's Edit, which is not (ADR 0005). */
export const scenarioSchema = z.object({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  url: z.string().url().refine(s => /^https?:/.test(s), 'Capture requires HTTP(S)'),
  viewport: z.object({ width: evenSize, height: evenSize }).default({ width: 1440, height: 900 }),
  capture: z.object({ fps: z.union([z.literal(30), z.literal(60)]).default(60), resolutionScale: z.union([z.literal(1), z.literal(2)]).default(2) }).default({}),
  director: z.object({ speed: z.number().positive().default(1), seed: z.number().int().default(1) }).strict().default({}),
}).passthrough();
/**
 * A Narration file: Lines in one language, each with its text, its audio (relative to the file) and
 * optionally word timings from the speech tool and a start in seconds. Any duration it states is
 * ignored: CueTake measures each Line from its audio.
 */
export const narrationSchema = z.object({
  language: z.string().min(2),
  lines: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, 'Use a short Line id of letters, digits, dots, dashes and underscores'),
    text: z.string().min(1),
    audio: z.string().min(1),
    start: z.number().min(0).optional(),
    words: z.array(z.object({ text: z.string(), start: z.number().min(0), end: z.number().min(0) }).refine(word => word.end >= word.start, 'A word ends before it starts')).optional(),
  })).min(1).refine(lines => new Set(lines.map(line => line.id)).size === lines.length, 'Line ids must be unique'),
});
const SUBTITLE_FILES = [['subtitles.srt', toSrt], ['subtitles.vtt', toVtt]];
const writeJson = (path, data) => fs.writeFile(path, JSON.stringify(data, null, 2) + '\n');
const readJson = async path => JSON.parse(await fs.readFile(path, 'utf8'));
const readIfPresent = path => readJson(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });

/**
 * Copies a Narration file and its audio into the Take's narration/ folder, replacing any earlier one,
 * and measures each Line. The audio is renamed after its Line.
 */
async function intoTakeNarration(file, dir) {
  const path = resolve(file), parsed = narrationSchema.safeParse(await readJson(path));
  if (!parsed.success) throw new Error(`${path} is not a Narration file: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'file'}: ${issue.message}`).join('; ')}`);
  // Read everything first: the file may already be the Take's own.
  const lines = await Promise.all(parsed.data.lines.map(async line => {
    const from = resolve(dirname(path), line.audio);
    const bytes = await fs.readFile(from).catch(error => { throw error.code === 'ENOENT' ? new Error(`Line '${line.id}': no audio at ${from}`) : error; });
    return { line: { ...line, audio: line.id + extname(from).toLowerCase() }, bytes };
  }));
  const folder = join(dir, 'narration');
  await fs.rm(folder, { recursive: true, force: true });
  await fs.mkdir(folder, { recursive: true });
  for (const { line, bytes } of lines) await fs.writeFile(join(folder, line.audio), bytes);
  const narration = { language: parsed.data.language, lines: lines.map(({ line }) => line) };
  await writeJson(join(folder, 'narration.json'), narration);
  return { narration, durations: await measureLines(narration.lines.map(line => ({ id: line.id, path: join(folder, line.audio) }))) };
}

/** The Edit with a Line added at its `start` for each Narration Line that has one and is not placed yet; also names the Lines left unplaced. */
function placeLines(edit, narration) {
  const placed = new Set(edit.narration.lines.map(line => line.id));
  const added = narration.lines.filter(line => !placed.has(line.id) && line.start !== undefined).map(line => ({ id: line.id, start: line.start }));
  const lines = [...edit.narration.lines, ...added].sort((a, b) => a.start - b.start);
  return { edit: { ...edit, narration: { ...edit.narration, lines } }, unplaced: narration.lines.filter(line => !placed.has(line.id) && line.start === undefined).map(line => line.id) };
}

/**
 * The Edit's Lines joined with the Narration's text, audio and word timings, as Render takes them.
 * A Line the Narration does not voice stops the Render.
 */
function voicedLines(edit, narration, dir) {
  const byId = new Map(narration.lines.map(line => [line.id, line]));
  return edit.narration.lines.map(line => {
    const voiced = byId.get(line.id);
    if (!voiced) throw new Error(`Line '${line.id}' has no audio in the Take's Narration; import one with cuetake narrate import ${dir} <narration.json>`);
    return { ...line, text: voiced.text, words: voiced.words, path: join(dir, 'narration', voiced.audio) };
  });
}

/** New take directories are exclusive: reruns never overwrite a previous take. */
export async function recordScenario(scenarioPath, outputDir, options = {}) {
  const scenario = await import(pathToFileURL(resolve(scenarioPath)).href);
  // A Look sits under the Scenario: every field the config names wins over it. File refs resolve
  // against the Look and the Scenario file, and the files are copied into the Take.
  const look = options.look ? await loadLook(options.look) : null;
  const config = scenarioSchema.parse(merge(look ? resolvedLook(look) : {}, absolute(scenario.config, dirname(resolve(scenarioPath)))));
  if (typeof scenario.run !== 'function') throw new Error('Scenario must export run(director)');
  const authState = options.authProfile ? await resolveAuthProfile(options.authProfile) : undefined;
  const ready = await doctor();
  if (!ready.ok) throw new Error(JSON.stringify(ready));
  const dir = resolve(outputDir || join('recordings', config.name, new Date().toISOString().replace(/[:.]/g, '-')));
  await fs.mkdir(resolve(dir, '..'), { recursive: true });
  await fs.mkdir(dir); // EEXIST is intentional, including for empty existing folders.
  let project = { schemaVersion: SCHEMA_VERSION, tool: 'CueTake', version: pkg.version, createdAt: new Date().toISOString(), status: 'recording', authenticated: Boolean(authState), ...(look && { look: look.name }), config };
  await writeJson(join(dir, 'project.json'), project);
  await fs.copyFile(resolve(scenarioPath), join(dir, 'scenario.mjs'));
  let unplaced = [], unvoiced = [];
  try {
    // The Narration is voiced before Capture, so d.say can hold each Line for its audio (ADR 0006).
    const imported = options.narration ? await intoTakeNarration(options.narration, dir) : null;
    const session = await startRecording(config.url, {
      ...config.viewport, ...config.capture, outputDir: dir, deferCapture: true, storageState: authState, headed: options.headed,
    });
    const page = getRecordingPage(session.sessionId);
    if (scenario.prepare) await scenario.prepare(page);
    await page.evaluate(() => document.fonts.ready);
    const capture = await beginCapture(session.sessionId);
    const startedAtMs = Date.parse(capture.startedAt);
    const focus = [], wide = [], said = [];
    const director = createDirector(page, startedAtMs, config.capture.fps, focus, wide, said, imported && new Map(Object.entries(imported.durations)), config.director);
    const evidence = await scenario.run(director);
    await page.screenshot({ path: join(dir, 'poster.png') });
    const observed = await collectTimeline(page, startedAtMs);
    const stopped = await stopRecording(session.sessionId);
    await fs.rename(stopped.webmPath, join(dir, 'source.webm'));
    await fs.rename(stopped.webmPath.replace(/\.webm$/, '-capture.json'), join(dir, 'capture.json'));
    const timeline = {
      schemaVersion: SCHEMA_VERSION, viewport: config.viewport, scale: config.capture.resolutionScale, duration: stopped.durationSeconds,
      pointer: observed.pointer, shapes: observed.shapes, events: [...observed.events, ...focus.map(f => ({ type: 'focus', ...f })), ...said.map(line => ({ type: 'say', ...line }))].sort((a, b) => a.t - b.t),
    };
    await writeJson(join(dir, 'timeline.json'), timeline);
    let edit = createEdit(config, timeline, focus, wide);
    if (imported) ({ edit, unplaced } = placeLines(edit, imported.narration));
    else unvoiced = edit.narration.lines.map(line => line.id);
    await writeJson(join(dir, 'edit.json'), await intoTake(edit, dir));
    project = { ...project, status: 'captured', duration: stopped.durationSeconds, evidence: evidence ?? null };
    await writeJson(join(dir, 'project.json'), project);
  } catch (error) {
    await writeJson(join(dir, 'project.json'), { ...project, status: 'failed', error: error.message });
    throw error;
  } finally { await cleanup(); }
  await renderTake(dir);
  const verification = await verifyTake(dir);
  return { directory: dir, final: join(dir, 'final.mp4'), verification, ...(unplaced.length && { unplaced: { lines: unplaced, note: 'These Lines were never said and have no start; add d.say or a start in edit.json' } }),
    ...(unvoiced.length && { unvoiced: { lines: unvoiced, note: `These Lines have no audio yet; voice them and run cuetake narrate import ${dir} <narration.json>` } }) };
}

/**
 * Imports a Narration into a recorded Take, replacing its earlier one. Lines keep their place in the
 * Edit; a new Line is placed at its `start`, if the file gives one. Problems are reported here and
 * stop the next Render.
 */
export async function importNarration(directory, file) {
  const dir = resolve(directory);
  const { timeline, edit } = await loadTake(dir);
  const { narration, durations } = await intoTakeNarration(file, dir);
  const end = Math.round(timeline.duration * edit.output.fps) / edit.output.fps;
  const { edit: next, unplaced } = placeLines(edit, narration);
  await writeJson(join(dir, 'edit.json'), next);
  const lines = next.narration.lines.filter(line => line.id in durations).map(line => ({ ...line, duration: durations[line.id] }));
  const missing = next.narration.lines.filter(line => !(line.id in durations)).map(line => line.id);
  const problems = [...lineProblems(lines, end), ...missing.map(id => `Line '${id}' is placed in edit.json but the Narration has no audio for it`)];
  return { narration: join(dir, 'narration', 'narration.json'), lines, unplaced, problems, next: `cuetake render ${dir}` };
}

/** The Edit with every file it names copied into the Take's styles/ folder, so the Take stands alone (ADR 0002). */
const intoTake = (edit, dir) => bundle(edit, dir, join(dir, 'styles'), 'styles/');

/** Reads a Take's project.json, Timeline and Edit, refusing Takes from an older schema. */
async function loadTake(dir) {
  const project = await readJson(join(dir, 'project.json'));
  if (project.schemaVersion !== SCHEMA_VERSION) throw new Error(`${dir} was recorded by an older CueTake (schema ${project.schemaVersion ?? 1}); record it again`);
  return {
    project, config: scenarioSchema.parse(project.config), timeline: await readJson(join(dir, 'timeline.json')),
    edit: withDefaults(await readJson(join(dir, 'edit.json'))), narration: await readIfPresent(join(dir, 'narration', 'narration.json')),
  };
}

/**
 * The Narration as Render takes it, or null for a Take without Lines or without a Narration yet (a
 * draft whose Lines `d.say` placed before any audio existed). Burned-in Chinese, Japanese or Korean
 * Subtitles drawn by the built-in need a font: macOS has PingFang SC; elsewhere the Edit or Look names one.
 */
function narrationForRender(edit, narration, dir) {
  if (!edit.narration.lines.length || !narration) return null;
  const lines = voicedLines(edit, narration, dir), { subtitles } = edit;
  const builtin = burnsIn(subtitles) && subtitles.draw === 'subtitles' && !subtitles.files?.font;
  if (builtin && process.platform !== 'darwin' && lines.some(line => isCjk(line.text, narration.language))) {
    throw new Error('Burned-in Subtitles in this language need a font outside macOS: add one to the Edit or Look as subtitles.files.font (a .woff2, .ttf or .otf file), or set subtitles.burn to false');
  }
  return { language: narration.language, volume: edit.narration.volume, lines };
}

/**
 * Writes preview.png: the Take's current Edit beside each Look (names or JSON files), composed with a
 * 1080-pixel short side in each output's own proportions. Without `at` it shows the last moment with the camera wide.
 */
export async function previewTake(directory, refs = [], { at } = {}) {
  const dir = resolve(directory);
  const { config, timeline, edit, narration } = await loadTake(dir);
  if (at !== undefined && !(at >= 0 && at <= timeline.duration)) throw new Error(`--at must be between 0 and ${timeline.duration} seconds`);
  const host = new URL(config.url).host;
  const looks = await Promise.all(refs.map(ref => loadLook(ref)));
  const tiles = [{ name: 'current', edit }, ...looks.map(look => ({ name: look.name, edit: applyLook(edit, resolvedLook(look), host) }))];
  const files = {}, shown = tiles.map(({ name, edit }) => ({ name, edit: forRender(atShortSide(edit, 1080), dir, files).edit }));
  const png = await composePreview({ sourcePath: join(dir, 'source.webm'), timeline, at, tiles: shown, files, narration: narrationForRender(edit, narration, dir) });
  const preview = join(dir, 'preview.png');
  await fs.writeFile(preview, png);
  return { preview, at: at ?? 'end, camera wide', tiles: tiles.map(({ name, edit }) => ({ name, summary: summarize(lookFromEdit(edit)) })) };
}

/** Adopts a Look into the Take's edit.json; the Final changes only after the next Render. */
export async function applyLookToTake(ref, directory) {
  const dir = resolve(directory);
  const { config, edit } = await loadTake(dir);
  const look = await loadLook(ref);
  const next = await intoTake(applyLook(edit, resolvedLook(look), new URL(config.url).host), dir);
  await writeJson(join(dir, 'edit.json'), next);
  return { look: look.name, edit: join(dir, 'edit.json'), summary: summarize(lookFromEdit(next)), next: `cuetake render ${dir}` };
}

/** Saves the Take's styling as a Look, locally unless `global`. */
export async function saveLookFromTake(name, directory, options) {
  const dir = resolve(directory), { edit } = await loadTake(dir);
  return saveLook(name, lookFromEdit(edit), { ...options, from: dir });
}

/** Writes subtitles.srt and subtitles.vtt for the cues Render drew from, or removes them for a Take without Lines. */
async function writeSubtitles(dir, cues) {
  for (const [name, format] of SUBTITLE_FILES) {
    if (cues) await fs.writeFile(join(dir, name), format(cues)); else await fs.rm(join(dir, name), { force: true });
  }
}

export async function renderTake(directory) {
  const dir = resolve(directory);
  const { project, timeline, edit, narration } = await loadTake(dir);
  const spoken = narrationForRender(edit, narration, dir);
  // Render to a temporary output; preserve the last complete final if encoding fails.
  const temporary = join(dir, 'final.pending.mp4');
  try {
    const render = await renderFinal({ sourcePath: join(dir, 'source.webm'), finalPath: temporary, timeline, ...forRender(edit, dir), narration: spoken });
    await fs.rename(temporary, join(dir, 'final.mp4'));
    await writeSubtitles(dir, render.subtitles?.map(({ frames, ...cue }) => cue) ?? null);
    await writeJson(join(dir, 'render.json'), render);
    await fs.rm(join(dir, 'verification.json'), { force: true });
    await writeJson(join(dir, 'project.json'), { ...project, status: 'rendered' });
  } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  return join(dir, 'final.mp4');
}

/**
 * What stops the Final from playing the Narration as placed: a missing or undecodable audio track or
 * Line, Lines that do not fit, subtitle files that do not match the Lines, and burned-in Subtitles
 * Render did not draw for a Line.
 */
async function narrationProblems(dir, edit, narration, media, end) {
  const problems = [], fps = edit.output.fps;
  if (!media.audio) return ['no audio track, though the Edit places Lines'];
  if (media.audio.error) problems.push(`the audio track does not decode: ${media.audio.error}`);
  if (Math.abs(media.audio.duration - media.duration) > 0.1) problems.push(`audio lasts ${media.audio.duration.toFixed(3)} s, video ${media.duration.toFixed(3)} s`);
  const measured = new Map(media.lines.map(line => [line.id, line]));
  for (const line of media.lines) if (line.error) problems.push(line.error);
  if (problems.length) return problems;
  const lines = narration.lines.map(line => ({ ...line, duration: measured.get(line.id).duration }));
  problems.push(...lineProblems(lines, end));
  if (problems.length) return problems;
  const cues = cuesFor(lines, narration.language, edit.subtitles, end);
  for (const [name, format] of SUBTITLE_FILES) {
    const text = await fs.readFile(join(dir, name), 'utf8').catch(() => null);
    if (text !== format(cues)) problems.push(`${name} ${text === null ? 'is missing' : 'does not match the Lines'}; render again`);
  }
  if (burnsIn(edit.subtitles)) {
    const drawn = (await readIfPresent(join(dir, 'render.json')))?.subtitles ?? [];
    for (const line of lines) {
      const own = drawn.filter(cue => cue.id === line.id);
      if (!own.length || own.some(cue => !cue.frames || cue.frames[0] > Math.ceil(cue.start * fps) + 1 || cue.frames[1] < Math.floor(cue.end * fps) - 2)) problems.push(`Subtitles for Line '${line.id}' were not drawn while it is spoken`);
    }
  }
  return problems;
}

export function summarizeFrames(frames, duration) {
  const intervals = frames.slice(1).map((f, i) => f.timeMs - frames[i].timeMs);
  const sorted = intervals.toSorted((a, b) => a - b);
  const seconds = Array.from({ length: Math.ceil(duration) }, (_, second) => ({ second, callbacks: frames.filter(f => f.timeMs >= second * 1000 && f.timeMs < (second + 1) * 1000).length }));
  return { callbacks: frames.length, medianIntervalMs: sorted[Math.floor(sorted.length / 2)] ?? null, maxIntervalMs: sorted.at(-1) ?? null, perSecond: seconds, note: 'Source capture is variable frame rate. Static sections reduce cadence; callback counts are observations, not a guarantee of unique encoded frames. Final output uses constant frame rate without motion interpolation.' };
}

export async function verifyTake(directory) {
  const dir = resolve(directory);
  const { project, edit, narration } = await loadTake(dir);
  const spoken = narrationForRender(edit, narration, dir);
  const media = await inspectFinal(join(dir, 'final.mp4'), spoken?.lines ?? []);
  const { fps } = edit.output;
  const expected = { ...outputSize(edit), fps, frames: Math.round(project.duration * fps) };
  const problems = [
    media.width !== expected.width || media.height !== expected.height ? `size ${media.width}×${media.height}, expected ${expected.width}×${expected.height}` : null,
    Math.abs(media.fps - expected.fps) > 0.01 ? `${media.fps} fps, expected ${expected.fps}` : null,
    media.packets !== expected.frames ? `${media.packets} frames, expected ${expected.frames}` : null,
    media.decodedFrames !== media.packets ? `only ${media.decodedFrames} of ${media.packets} frames decoded` : null,
    ...(spoken ? await narrationProblems(dir, edit, spoken, media, expected.frames / fps) : []),
  ].filter(Boolean);
  if (problems.length) throw new Error(`Final failed verification: ${problems.join('; ')}`);
  const capture = await readJson(join(dir, 'capture.json'));
  const { lines, ...final } = media;
  const verification = {
    passed: true, checkedAt: new Date().toISOString(), media: final, source: { settings: capture.settings, ...summarizeFrames(capture.frames, capture.duration) }, fullDecode: 'passed',
    ...(spoken && { narration: { lines: spoken.lines.map(({ id, start }) => ({ id, start, duration: lines.find(line => line.id === id).duration })), subtitles: SUBTITLE_FILES.map(([name]) => name), burned: burnsIn(edit.subtitles) } }),
  };
  await writeJson(join(dir, 'verification.json'), verification);
  await writeJson(join(dir, 'project.json'), { ...project, status: 'verified' });
  return verification;
}
