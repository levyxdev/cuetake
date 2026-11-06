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
import { createAppDirector } from './app-director.js';
import { appLocators } from './app-locators.js';
import { startDesktop } from './app-capture.js';
import { desktopWarnings } from './desktop.js';
import { collectTimeline } from './probe.js';
import { createEdit, evenSize, merge, withDefaults } from './edit.js';
import { loadLook, resolvedLook, applyLook, lookFromEdit, saveLook, summarize } from './look.js';
import { absolute, bundle, forRender } from './styles.js';
import { burnsIn, cuesFor, isCjk, lineProblems, toSrt, toVtt } from './narration.js';
import { linesInFinal, timeMap } from './time-map.js';
import { maskWarnings } from './masks.js';
import pkg from '../package.json' with { type: 'json' };

const SCHEMA_VERSION = 4;
/**
 * Scenario config: capture settings, validated, plus styling that seeds each Take's Edit, which is not
 * (ADR 0005). A Scenario opens a start page (`url`) or starts Apps (`app`: one App, a `.app` path or
 * bundle id with its arguments, or a list of them sharing one Desktop), never both (ADR 0009); for Apps,
 * `viewport` is the Desktop's size in points.
 */
const appSchema = z.object({ path: z.string().min(1), args: z.array(z.string()).default([]) }).strict();
export const scenarioSchema = z.object({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  url: z.string().url().refine(s => /^https?:/.test(s), 'Capture requires HTTP(S)').optional(),
  app: z.union([appSchema, z.array(appSchema).min(1)]).optional(),
  viewport: z.object({ width: evenSize, height: evenSize }).default({ width: 1440, height: 900 }),
  capture: z.object({ fps: z.union([z.literal(30), z.literal(60)]).default(60), resolutionScale: z.union([z.literal(1), z.literal(2)]).default(2) }).default({}),
  director: z.object({ speed: z.number().positive().default(1), seed: z.number().int().default(1) }).strict().default({}),
}).passthrough().refine(config => !config.url !== !config.app, { message: 'A Scenario names exactly one of url or app', path: ['url'] });
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

/**
 * The resolution scale Capture uses: the one the Scenario or Look chose, else 2, or 1 when doctor found
 * Chromium drawing without a GPU, where scale 2 starves a busy page of frames.
 */
export function captureScale(chosen, gpu) {
  if (chosen !== undefined) return { resolutionScale: chosen, lowered: false };
  return gpu?.accelerated === false ? { resolutionScale: 1, lowered: true } : { resolutionScale: 2, lowered: false };
}

/**
 * The Timeline from `take` (its url, viewport and scale), what Capture observed in each Tab (`observed`,
 * the probe's by Tab id), what the Director noted and what the recorder saw: every input and page load carries the Tab it happened in,
 * in that Tab's CSS pixels, and `front` events note which Tab is in front from when. Each element a
 * Scenario masked is in `elements`, with its boxes over time, and each mask is a `mask` event.
 */
export function timelineOf(take, stopped, observed, notes, startedAtMs) {
  const t = ms => Math.round(ms - startedAtMs) / 1000, inTab = (list, tab) => list.map(item => ({ ...item, tab }));
  const pointer = [...[...observed].flatMap(([tab, seen]) => seen.pointer.map(sample => [...sample, tab])), ...notes.pointer.map(([ms, x, y, tab]) => [t(ms), x, y, tab])];
  const shapes = [...observed.values()].flatMap(seen => seen.shapes).sort((a, b) => a[0] - b[0]);
  const frameInput = { turned: [...observed.values()].flatMap(seen => seen.turned).sort((a, b) => a - b), unplaced: [...observed.values()].flatMap(seen => seen.unplaced).sort((a, b) => a - b) };
  // Each element a mask follows, with the boxes the probe in its Tab saw it at.
  const elements = (notes.elements ?? []).map(element => ({ ...element, boxes: observed.get(element.tab)?.watched?.find(watched => watched.id === element.id)?.boxes ?? [] }));
  return {
    schemaVersion: SCHEMA_VERSION, ...take, duration: stopped.durationSeconds,
    tabs: stopped.tabs.map(({ id, opener, opened, closed, viewport, url, start }) => ({ id, opener, opened, closed, viewport, url, start })),
    pointer: pointer.sort((a, b) => a[0] - b[0]), shapes, ...((frameInput.turned.length || frameInput.unplaced.length) && { frameInput }), ...(elements.length && { elements }),
    events: [
      ...[...observed].flatMap(([tab, seen]) => inTab(seen.events, tab)),
      ...notes.focus.map(f => ({ type: 'focus', ...f })), ...notes.said.map(line => ({ type: 'say', ...line })), ...notes.forwarded.map(span => ({ type: 'fastForward', ...span })), ...(notes.masks ?? []).map(mask => ({ type: 'mask', ...mask })),
      ...stopped.tabs.flatMap(tab => inTab(tab.navigations.map(load => ({ type: 'navigate', ...load })), tab.id)),
      ...stopped.fronts.filter(front => front.t > 0).map(front => ({ type: 'front', ...front })),
    ].sort((a, b) => a.t - b.t),
  };
}

/** The Apps a Scenario starts, as a list: `config.app` names one or several. */
export const appsOf = config => [config.app].flat().filter(Boolean);

/**
 * The Timeline of a Take of Apps (ADR 0009) from `take` (the Apps, the Desktop's size in points as the
 * viewport, and its scale), what the helper saw (`stopped`: the duration, the Apps' windows over time,
 * the system cursor's shapes, each element the App focused, as `focused` events the camera follows, and
 * the frames of each masked element, `watched`) and what the Director noted: its pointer path and
 * input, since the App shows none of its own, focus targets, Lines, fast-forwards and masks. Input the Director did not make never enters it. The Take has one
 * Tab, its Desktop; positions are Desktop points.
 */
export function desktopTimelineOf({ apps, viewport, scale }, stopped, notes) {
  // Each element a mask follows, with the boxes the helper read it at.
  const elements = (notes.elements ?? []).map(element => ({ ...element, boxes: stopped.watched?.find(watched => watched.id === element.id)?.boxes ?? [] }));
  return {
    schemaVersion: SCHEMA_VERSION, apps, viewport, scale, duration: stopped.duration,
    tabs: [{ id: 0, opener: null, opened: 0, closed: null, viewport, start: 0 }],
    pointer: notes.pointer.map(([t, x, y]) => [t, x, y, 0]), shapes: stopped.shapes ?? [], windows: stopped.windows, ...(elements.length && { elements }),
    events: [
      ...notes.focus.map(f => ({ type: 'focus', ...f })), ...notes.said.map(line => ({ type: 'say', ...line })), ...notes.forwarded.map(span => ({ type: 'fastForward', ...span })),
      ...notes.events.map(event => ({ ...event, tab: 0 })), ...(stopped.focused ?? []).map(f => ({ type: 'focused', ...f, tab: 0 })),
      ...(notes.masks ?? []).map(mask => ({ type: 'mask', ...mask })),
    ].sort((a, b) => a.t - b.t),
  };
}

/** The Source of each of a Take's Tabs, by Tab id. */
const sourcesOf = (dir, timeline) => Object.fromEntries(timeline.tabs.map(tab => [tab.id, join(dir, `source-${tab.id}.${timeline.windows ? 'mp4' : 'webm'}`)]));

/**
 * Refuses what does not apply to an App: an Auth profile, since the App runs with the user's own login
 * and data; and a resolution scale, since the Desktop takes its display's (ADR 0009).
 */
function refuseForApp(given, options) {
  if (options.authProfile) throw new Error('--auth-profile is for web pages: an App runs with the login and data it already has');
  if (given.capture?.resolutionScale !== undefined) throw new Error('capture.resolutionScale does not apply to an App: the Desktop records at the scale of the display it sits on');
  if (options.headed) throw new Error('--headed is for web pages: an App always shows on the screen');
}

/** Captures a start page: the Tabs' Sources, capture.json and poster.png in `dir`; returns the Timeline, the Director's notes and the evidence. */
async function capturePage(scenario, config, dir, { authState, headed, voiced }) {
  try {
    const session = await startRecording(config.url, {
      ...config.viewport, ...config.capture, outputDir: dir, deferCapture: true, storageState: authState, headed,
    });
    const page = getRecordingPage(session.sessionId);
    if (scenario.prepare) await scenario.prepare(page);
    await page.evaluate(() => document.fonts.ready);
    const capture = await beginCapture(session.sessionId);
    const startedAtMs = Date.parse(capture.startedAt);
    const notes = { focus: [], wide: [], said: [], forwarded: [], pointer: [], elements: [], masks: [] };
    const ran = new AbortController();
    const director = createDirector(capture.tabs, { startedAt: startedAtMs, fps: config.capture.fps, voiced, ...config.director, signal: ran.signal }, notes);
    const evidence = await scenario.run(director).finally(() => ran.abort());
    await capture.tabs.started();
    await capture.tabs.front.page.screenshot({ path: join(dir, 'poster.png') });
    const observed = new Map();
    for (const tab of capture.tabs.list()) if (tab.recorded) observed.set(tab.id, await collectTimeline(tab.page, startedAtMs));
    const stopped = await stopRecording(session.sessionId);
    for (const tab of stopped.tabs) await fs.rename(tab.webmPath, join(dir, `source-${tab.id}.webm`));
    await writeJson(join(dir, 'capture.json'), { tabs: stopped.tabs.map(tab => ({ tab: tab.id, ...tab.stats })) });
    const timeline = timelineOf({ url: capture.url, viewport: config.viewport, scale: config.capture.resolutionScale }, stopped, observed, notes, startedAtMs);
    return { timeline, notes, evidence };
  } finally { await cleanup(); }
}

/**
 * Captures a Desktop of the Apps (ADR 0009) through the helper: source-0.mp4, capture.json and
 * poster.png in `dir`. The Desktop records at its display's scale, which `config.capture` then holds.
 * `prepare(page, { app })` gets the first App's first window, and every App by `app(name)`, before
 * Capture starts, to wait for what the demo needs and arrange the windows with `setFrame`.
 * Returns the Timeline, the Director's notes, the evidence, and the Apps the helper could not quit.
 */
async function captureApp(scenario, config, dir, { voiced }) {
  const { fps } = config.capture, given = appsOf(config);
  process.stderr.write(`CueTake starts ${given.map(app => app.path).join(', ')} and records ${given.length > 1 ? 'them' : 'it'}. Leave the Mac alone until the Take ends: the Scenario moves the real pointer and acts on the real ${given.length > 1 ? 'Apps' : 'App'} and their data.\n`);
  const desktop = await startDesktop({ apps: given, desktop: config.viewport, fps, source: join(dir, 'source-0.mp4'), poster: join(dir, 'poster.png') });
  try {
    config.capture.resolutionScale = desktop.ready.scale;
    const apps = given.map((app, i) => ({ ...app, name: desktop.ready.apps[i].name, bundle: desktop.ready.apps[i].bundle }));
    if (scenario.prepare) {
      const arranged = appLocators(desktop, apps, { arrange: true });
      await scenario.prepare(arranged.page('first'), { app: arranged.app });
    }
    // The pointer starts at the Desktop's top-left corner, where the Director's starts.
    await desktop.request({ move: { x: 0, y: 0 } });
    const startedAtMs = await desktop.start();
    const notes = { focus: [], wide: [], said: [], forwarded: [], pointer: [], events: [], elements: [], masks: [] };
    const ran = new AbortController();
    const director = createAppDirector({ startedAt: startedAtMs, fps, voiced, ...config.director, helper: desktop, apps, signal: ran.signal }, notes);
    const evidence = await scenario.run(director).finally(() => ran.abort());
    const stopped = await desktop.stop();
    const { width, height } = stopped.size;
    await writeJson(join(dir, 'capture.json'), { tabs: [{
      tab: 0, settings: { width, height, frameRate: fps }, duration: stopped.duration, dropped: stopped.dropped, otherInput: stopped.otherInput ?? [],
      frames: stopped.frames.map(([t, scale]) => ({ timeMs: Math.round(t * 1e6) / 1000, scale })),
    }] });
    const timeline = desktopTimelineOf({ apps, viewport: config.viewport, scale: desktop.ready.scale }, stopped, notes);
    return { timeline, notes, evidence, unquit: stopped.unquit ?? [] };
  } finally { desktop.kill(); }
}

/** New take directories are exclusive: reruns never overwrite a previous take. */
export async function recordScenario(scenarioPath, outputDir, options = {}) {
  const scenario = await import(pathToFileURL(resolve(scenarioPath)).href);
  // A Look sits under the Scenario: every field the config names wins over it. File refs resolve
  // against the Look and the Scenario file, and the files are copied into the Take.
  const look = options.look ? await loadLook(options.look) : null;
  const given = merge(look ? resolvedLook(look) : {}, absolute(scenario.config, dirname(resolve(scenarioPath))));
  const config = scenarioSchema.parse(given);
  if (typeof scenario.run !== 'function') throw new Error('Scenario must export run(director)');
  if (config.app) refuseForApp(given, options);
  // A relative .app path names an App beside the Scenario.
  for (const app of appsOf(config)) if (app.path.includes('/')) app.path = resolve(dirname(resolve(scenarioPath)), app.path);
  const authState = options.authProfile ? await resolveAuthProfile(options.authProfile) : undefined;
  const ready = await doctor();
  if (!ready.ok) throw new Error(JSON.stringify(ready));
  if (config.app && !ready.apps?.ok) {
    const missing = ready.apps ? ready.checks.filter(check => !check.ok).map(check => `${check.name}: ${check.fix}`) : ['Recording an App needs macOS'];
    throw new Error(`This Mac cannot record an App yet. ${missing.join(' ')} Nothing was requested; run cuetake doctor after the change.`);
  }
  const gpu = ready.checks.find(check => check.name === 'gpu');
  const { resolutionScale, lowered } = config.app ? { resolutionScale: config.capture.resolutionScale, lowered: false } : captureScale(given.capture?.resolutionScale, gpu);
  config.capture.resolutionScale = resolutionScale;
  const dir = resolve(outputDir || join('recordings', config.name, new Date().toISOString().replace(/[:.]/g, '-')));
  await fs.mkdir(resolve(dir, '..'), { recursive: true });
  await fs.mkdir(dir); // EEXIST is intentional, including for empty existing folders.
  let project = { schemaVersion: SCHEMA_VERSION, tool: 'CueTake', version: pkg.version, createdAt: new Date().toISOString(), status: 'recording', authenticated: Boolean(authState), ...(look && { look: look.name }), config };
  await writeJson(join(dir, 'project.json'), project);
  await fs.copyFile(resolve(scenarioPath), join(dir, 'scenario.mjs'));
  let unplaced = [], unvoiced = [], captured;
  try {
    // The Narration is voiced before Capture, so d.say can hold each Line for its audio (ADR 0006).
    const imported = options.narration ? await intoTakeNarration(options.narration, dir) : null;
    const voiced = imported && new Map(Object.entries(imported.durations));
    captured = config.app ? await captureApp(scenario, config, dir, { voiced }) : await capturePage(scenario, config, dir, { authState, headed: options.headed, voiced });
    const { timeline, notes: { focus, wide }, evidence } = captured;
    await writeJson(join(dir, 'timeline.json'), timeline);
    let edit = createEdit(config, timeline, focus, wide);
    if (imported) ({ edit, unplaced } = placeLines(edit, imported.narration));
    else unvoiced = edit.narration.lines.map(line => line.id);
    await writeJson(join(dir, 'edit.json'), await intoTake(edit, dir));
    project = { ...project, status: 'captured', duration: timeline.duration, evidence: evidence ?? null };
    await writeJson(join(dir, 'project.json'), project);
  } catch (error) {
    await writeJson(join(dir, 'project.json'), { ...project, status: 'failed', error: error.message });
    throw error;
  }
  await renderTake(dir);
  const verification = await verifyTake(dir);
  return { directory: dir, final: join(dir, 'final.mp4'), verification,
    ...(lowered && { capture: { resolutionScale, note: `Chromium draws without a GPU here (${gpu.renderer}), so Capture used resolutionScale 1; set capture.resolutionScale to 2 in the Scenario to override` } }),
    ...(config.app && { capture: { resolutionScale: config.capture.resolutionScale, note: 'The Desktop records at the scale of the display it sits on' } }),
    ...(captured.unquit?.length && { app: { quit: false, unquit: captured.unquit, note: `${captured.unquit.join(', ')} did not quit after the Take; ${captured.unquit.length > 1 ? 'they' : 'it'} may be asking to save. Quit ${captured.unquit.length > 1 ? 'them' : 'it'} before the next Take.` } }),
    ...(unplaced.length && { unplaced: { lines: unplaced, note: 'These Lines were never said and have no start; add d.say or a start in edit.json' } }),
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
  const { edit: next, unplaced } = placeLines(edit, narration);
  await writeJson(join(dir, 'edit.json'), next);
  const lines = next.narration.lines.filter(line => line.id in durations).map(line => ({ ...line, duration: durations[line.id] }));
  const missing = next.narration.lines.filter(line => !(line.id in durations)).map(line => line.id);
  const map = timeMap(next.fastForward, timeline.duration), end = Math.round(map.duration * next.output.fps) / next.output.fps;
  const inFinal = linesInFinal(lines, map);
  const problems = [...inFinal.problems, ...lineProblems(inFinal.lines, end), ...missing.map(id => `Line '${id}' is placed in edit.json but the Narration has no audio for it`)];
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
 * 1080-pixel short side in each output's own proportions. `at` is seconds of the Final; without it the
 * Preview shows the last moment with the camera wide.
 */
export async function previewTake(directory, refs = [], { at } = {}) {
  const dir = resolve(directory);
  const { config, timeline, edit, narration } = await loadTake(dir);
  const length = timeMap(edit.fastForward, timeline.duration).duration;
  if (at !== undefined && !(at >= 0 && at <= length)) throw new Error(`--at must be between 0 and ${+length.toFixed(3)} seconds of the Final`);
  const host = config.url && new URL(config.url).host;
  const looks = await Promise.all(refs.map(ref => loadLook(ref)));
  const tiles = [{ name: 'current', edit }, ...looks.map(look => ({ name: look.name, edit: applyLook(edit, resolvedLook(look), host) }))];
  const files = {}, shown = tiles.map(({ name, edit }) => ({ name, edit: forRender(atShortSide(edit, 1080), dir, files).edit }));
  const png = await composePreview({ sources: sourcesOf(dir, timeline), timeline, at, tiles: shown, files, narration: narrationForRender(edit, narration, dir) });
  const preview = join(dir, 'preview.png');
  await fs.writeFile(preview, png);
  return { preview, at: at ?? 'end, camera wide', tiles: tiles.map(({ name, edit }) => ({ name, summary: summarize(lookFromEdit(edit)) })) };
}

/** Adopts a Look into the Take's edit.json; the Final changes only after the next Render. */
export async function applyLookToTake(ref, directory) {
  const dir = resolve(directory);
  const { config, edit } = await loadTake(dir);
  const look = await loadLook(ref);
  const next = await intoTake(applyLook(edit, resolvedLook(look), config.url && new URL(config.url).host), dir);
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
    const render = await renderFinal({ sources: sourcesOf(dir, timeline), finalPath: temporary, timeline, ...forRender(edit, dir), narration: spoken });
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
async function narrationProblems(dir, edit, narration, media, map, end) {
  const problems = [], fps = edit.output.fps;
  if (!media.audio) return ['no audio track, though the Edit places Lines'];
  if (media.audio.error) problems.push(`the audio track does not decode: ${media.audio.error}`);
  if (Math.abs(media.audio.duration - media.duration) > 0.1) problems.push(`audio lasts ${media.audio.duration.toFixed(3)} s, video ${media.duration.toFixed(3)} s`);
  const measured = new Map(media.lines.map(line => [line.id, line]));
  for (const line of media.lines) if (line.error) problems.push(line.error);
  if (problems.length) return problems;
  const inFinal = linesInFinal(narration.lines.map(line => ({ ...line, duration: measured.get(line.id).duration })), map), { lines } = inFinal;
  problems.push(...inFinal.problems, ...lineProblems(lines, end));
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

/** Animation frames per second below which the page in a Final visibly jumps. */
const SLOW_PAGE_FRAMES = 20;

/**
 * Warns when the browser fell behind during Capture: the page got fewer than SLOW_PAGE_FRAMES animation
 * frames in at least two whole seconds. The Source's own frames cannot tell, since a still page sends few.
 * A second that a navigation or reload touches is left out, since no document draws while one loads.
 * At resolution scale 1 the Take cannot be helped by lowering it again. `tab`, the Timeline's Tab,
 * is named in a Take with several Tabs.
 */
export function captureWarnings(capture, scale, tab = null) {
  const loading = second => (capture.navigations ?? []).some(load => load.t < second + 1 && load.end >= second);
  const whole = (capture.pageFrames ?? []).slice(0, Math.floor(capture.duration)).filter((_, second) => !loading(second));
  const slow = whole.filter(n => n < SLOW_PAGE_FRAMES);
  if (slow.length < 2) return [];
  const fix = scale > 1
    ? 'Record again with capture: { resolutionScale: 1 } in the Scenario, or close other work'
    : 'Capture already used resolutionScale 1: close other work, use a smaller viewport, or record on a machine with a GPU';
  const lead = tab ? `In Tab ${tab.id}, opened at ${tab.opened.toFixed(2)} s, the browser` : 'The browser';
  return [`${lead} fell behind during Capture: the page got fewer than ${SLOW_PAGE_FRAMES} frames per second for ${slow.length} of ${whole.length} s (lowest ${Math.min(...slow)}), so the page in the Final jumps while the Cursor moves smoothly. ${fix}.`];
}

/**
 * Warns when input landed inside an iframe Capture could not place exactly: one rotated, skewed or
 * 3D-transformed, placed as if it were only scaled, or one it could not place at all, which the Cursor
 * and camera do not follow.
 */
export function timelineWarnings(timeline) {
  const { turned = [], unplaced = [] } = timeline.frameInput ?? {};
  const at = times => times.slice(0, 5).map(t => `${t.toFixed(2)} s`).join(', ') + (times.length > 5 ? ` and ${times.length - 5} more` : '');
  return [
    turned.length && `Input at ${at(turned)} landed inside an iframe that is rotated, skewed or 3D-transformed, which Capture places as if it were only scaled, so the Cursor and camera there may sit off what the page shows. Check those moments with frame, and record again once the iframe is upright, after any opening animation.`,
    unplaced.length && `Input at ${at(unplaced)} landed inside an iframe Capture could not place, so the Cursor and camera do not follow it there. Check those moments with frame.`,
  ].filter(Boolean);
}

export async function verifyTake(directory) {
  const dir = resolve(directory);
  const { project, config, timeline, edit, narration } = await loadTake(dir);
  const spoken = narrationForRender(edit, narration, dir);
  const media = await inspectFinal(join(dir, 'final.mp4'), spoken?.lines ?? []);
  const { fps } = edit.output, map = timeMap(edit.fastForward, project.duration);
  const expected = { ...outputSize(edit), fps, frames: Math.round(map.duration * fps) };
  const problems = [
    media.width !== expected.width || media.height !== expected.height ? `size ${media.width}×${media.height}, expected ${expected.width}×${expected.height}` : null,
    Math.abs(media.fps - expected.fps) > 0.01 ? `${media.fps} fps, expected ${expected.fps}` : null,
    media.packets !== expected.frames ? `${media.packets} frames, expected ${expected.frames}` : null,
    media.decodedFrames !== media.packets ? `only ${media.decodedFrames} of ${media.packets} frames decoded` : null,
    ...(spoken ? await narrationProblems(dir, edit, spoken, media, map, expected.frames / fps) : []),
  ].filter(Boolean);
  if (problems.length) throw new Error(`Final failed verification: ${problems.join('; ')}`);
  const capture = await readJson(join(dir, 'capture.json')), several = capture.tabs.length > 1;
  const tabOf = id => timeline.tabs.find(tab => tab.id === id);
  const { lines, ...final } = media;
  const verification = {
    passed: true, checkedAt: new Date().toISOString(), media: final,
    warnings: [...capture.tabs.flatMap(stats => captureWarnings(stats, config.capture.resolutionScale, several ? tabOf(stats.tab) : null)), ...timelineWarnings(timeline), ...maskWarnings(edit.masks, timeline.elements), ...(timeline.windows ? desktopWarnings(timeline, capture.tabs[0]) : [])],
    sources: capture.tabs.map(stats => ({ tab: stats.tab, settings: stats.settings, ...summarizeFrames(stats.frames, stats.duration), ...(stats.pageFrames && { pageFramesPerSecond: stats.pageFrames }) })), fullDecode: 'passed',
    ...(spoken && { narration: { lines: spoken.lines.map(({ id, start }) => ({ id, start, duration: lines.find(line => line.id === id).duration })), subtitles: SUBTITLE_FILES.map(([name]) => name), burned: burnsIn(edit.subtitles) } }),
  };
  await writeJson(join(dir, 'verification.json'), verification);
  await writeJson(join(dir, 'project.json'), { ...project, status: 'verified' });
  return verification;
}
