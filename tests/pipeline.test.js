import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import pkg from '../package.json' with { type: 'json' };
import { scenarioSchema, summarizeFrames } from '../src/pipeline.js';
import { fitZoom, cropAround, zoomSegments, cameraTrack } from '../src/camera.js';
import { cameraTargets, createEdit, editFields } from '../src/edit.js';
import { pointerAt, presses, sparksAt } from '../src/cursor.js';
import { outputSize, layout, cameraView, brandHue, previewSheet } from '../src/stage.js';
import { lookSchema, lookFromEdit, applyLook, mergeLook, summarize, saveLook, loadLook, listLooks, removeLook } from '../src/look.js';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('rejects unsupported capture rates and odd H.264 output dimensions', () => {
  const base = { name: 'demo', url: 'https://example.com' };
  expect(scenarioSchema.safeParse({ ...base, capture: { fps: 45 } }).success).toBe(false);
  expect(scenarioSchema.safeParse({ ...base, output: { size: 1079 } }).success).toBe(false);
  expect(scenarioSchema.safeParse({ ...base, output: { aspect: '4:3' } }).success).toBe(false);
  expect(scenarioSchema.parse(base).capture.fps).toBe(60);
});

test('reports sparse static capture honestly rather than labeling it 60 unique fps', () => {
  const stats = summarizeFrames([{ timeMs: 0 }, { timeMs: 17 }, { timeMs: 34 }, { timeMs: 1034 }], 2);
  expect(stats.maxIntervalMs).toBe(1000);
  expect(stats.perSecond.map(s => s.callbacks)).toEqual([3, 1]);
});

const viewport = { width: 320, height: 240 };
const box = { x: 1, y: 2, width: 3, height: 4 };
const small = (x, y) => ({ x, y, width: 20, height: 20 });
const camera = editFields.camera.parse({ padding: 0 });
const zoomAt = (track, t, fps = 60) => viewport.width / track[Math.round(t * fps)].w;
const centerAt = (track, t, fps = 60) => { const c = track[Math.round(t * fps)]; return { x: c.x + c.w / 2, y: c.y + c.h / 2 }; };

test('the camera follows observed clicks, typing and drags, except during focus: false actions', () => {
  const timeline = { events: [
    { type: 'click', t: 1, x: 2, y: 3, box },
    { type: 'type', t: 2, end: 3, box },
    { type: 'drag', t: 4, end: 5, from: { x: 50, y: 10 }, to: { x: 10, y: 40 } },
  ] };
  expect(cameraTargets(timeline, [])).toEqual([
    { t: 1, box }, { t: 2, box, until: 3 }, { t: 4, box: { x: 10, y: 10, width: 40, height: 30 }, until: 5 },
  ]);
  expect(cameraTargets(timeline, [], [{ start: 1.5, end: 4.5 }]).map(target => target.t)).toEqual([1]);
  const edit = createEdit(scenarioSchema.parse({ name: 'demo', url: 'https://example.com' }), timeline, []);
  expect(edit.schemaVersion).toBe(2);
  expect(edit.camera).toMatchObject({ maxZoom: 2, follow: true, targets: expect.any(Array) });
});

test('an explicit focus replaces only the automatic targets inside its own span', () => {
  const timeline = { events: [{ type: 'click', t: 1, x: 0, y: 0, box }, { type: 'click', t: 8, x: 0, y: 0, box }] };
  const focus = [{ t: 1.2, box: small(100, 100) }];
  expect(cameraTargets(timeline, focus, [], camera)).toEqual([focus[0], { t: 8, box }]);
});

test('each target zooms to fit its box with padding, capped, and boxes that would barely zoom stay wide', () => {
  const fit = { maxZoom: 2, padding: 10 };
  expect(fitZoom(small(0, 0), viewport, fit)).toBe(2);
  expect(fitZoom({ x: 0, y: 0, width: 180, height: 50 }, viewport, fit)).toBe(1.6);
  expect(fitZoom({ x: 0, y: 0, width: 400, height: 300 }, viewport, fit)).toBe(1);
  expect(zoomSegments([{ t: 1, box: { x: 0, y: 0, width: 300, height: 220 } }], viewport, camera, 10)).toEqual([]);
  expect(zoomSegments([{ t: 1, box: { x: 0, y: 0, width: 300, height: 220 }, zoom: 1.5 }], viewport, camera, 10)).toHaveLength(1);
  expect(cropAround(0, 0, 2, viewport)).toEqual({ x: 0, y: 0, w: 160, h: 120 });
});

test('the camera arrives as the action happens, holds, and returns wide', () => {
  const track = cameraTrack({ targets: [{ t: 2, box: small(240, 100) }], viewport, camera, duration: 8, fps: 60 });
  expect(zoomAt(track, 0)).toBe(1);
  expect(zoomAt(track, 1.3)).toBeLessThan(1.05);           // still wide before the lead
  expect(zoomAt(track, 2)).toBeGreaterThan(1.85);           // nearly arrived at the click
  expect(zoomAt(track, 3.4)).toBeCloseTo(2, 2);             // holding
  expect(zoomAt(track, 5)).toBeLessThan(1.02);              // back to wide after the hold
  for (const crop of track) expect(crop.w).toBeLessThanOrEqual(viewport.width + 1e-9);
});

test('actions close together share one zoom; far apart ones zoom out between', () => {
  const near = cameraTrack({ targets: [{ t: 1, box: small(0, 100) }, { t: 3, box: small(300, 100) }], viewport, camera, duration: 8, fps: 60 });
  expect(zoomAt(near, 2.4)).toBeGreaterThan(1.9);
  expect(centerAt(near, 3).x).toBeGreaterThan(220);
  const far = cameraTrack({ targets: [{ t: 1, box: small(0, 100) }, { t: 7, box: small(300, 100) }], viewport, camera, duration: 12, fps: 60 });
  expect(zoomAt(far, 4.5)).toBeLessThan(1.05);
});

test('typing keeps the zoom for the whole burst', () => {
  const [segment] = zoomSegments([{ t: 1, box: small(0, 0), until: 4 }], viewport, camera, 10);
  expect(segment.end).toBe(5.5);
});

test('every Final ends wide, even when the last action is near the end', () => {
  const track = cameraTrack({ targets: [{ t: 4.2, box: small(240, 100) }], viewport, camera, duration: 5, fps: 60 });
  expect(Math.max(...track.map(c => viewport.width / c.w))).toBeLessThan(1.05);
  const late = cameraTrack({ targets: [{ t: 2, box: small(240, 100) }], viewport, camera, duration: 4, fps: 60 });
  expect(zoomAt(late, 3.9)).toBeLessThan(1.05);
});

test('while zoomed the camera follows the cursor to keep it in view', () => {
  const pointerAt = t => ({ x: t < 2.5 ? 30 : 300, y: 120 });
  const track = cameraTrack({ targets: [{ t: 2, box: small(20, 110), until: 4 }], viewport, camera, duration: 8, fps: 60, pointerAt });
  expect(centerAt(track, 2).x).toBeLessThan(100);
  expect(centerAt(track, 4).x).toBeGreaterThan(200);
  const still = cameraTrack({ targets: [{ t: 2, box: small(20, 110), until: 4 }], viewport, camera: { ...camera, follow: false }, duration: 8, fps: 60, pointerAt });
  expect(centerAt(still, 4).x).toBeLessThan(100);
});

test('the cursor interpolates the pointer path and is hidden before the first sample', () => {
  const pointer = [[1, 0, 0], [2, 100, 50], [3, 100, 50]];
  expect(pointerAt(pointer, 0.5)).toBeNull();
  expect(pointerAt(pointer, 1.5)).toEqual({ x: 50, y: 25 });
  expect(pointerAt(pointer, 9)).toEqual({ x: 100, y: 50 });
});

test('clicks and drag starts spark for the click effect duration', () => {
  const list = presses([{ type: 'click', t: 1, x: 5, y: 6 }, { type: 'type', t: 2, end: 3 }, { type: 'drag', t: 4, end: 5, from: { x: 7, y: 8 }, to: { x: 9, y: 9 } }]);
  expect(list).toEqual([{ t: 1, x: 5, y: 6 }, { t: 4, x: 7, y: 8 }]);
  const effect = { style: 'spark', duration: 400 };
  expect(sparksAt(list, effect, 1.2)).toEqual([{ x: 5, y: 6, progress: expect.closeTo(0.5, 6) }]);
  expect(sparksAt(list, effect, 1.5)).toEqual([]);
  expect(sparksAt(list, { ...effect, style: 'none' }, 1.2)).toEqual([]);
});

test('the skill launcher pins the version being released', () => {
  const launcher = readFileSync(new URL('../skills/cuetake/scripts/cuetake', import.meta.url), 'utf8');
  expect(launcher).toContain(`cuetake@${pkg.version}`);
});

const pageViewport = { width: 1440, height: 900 };
const framed = (frame = {}, output = {}) => ({ output: { size: '2160p', aspect: '16:9', ...output }, frame: { window: 'browser', padding: 0.08, radius: 12, ...frame } });

test('output size names the short side; aspect applies only with a frame', () => {
  expect(outputSize(framed(), pageViewport)).toEqual({ width: 3840, height: 2160 });
  expect(outputSize(framed({}, { size: '1080p', aspect: '9:16' }), pageViewport)).toEqual({ width: 1080, height: 1920 });
  expect(outputSize({ output: { size: 240 }, frame: false }, { width: 320, height: 240 })).toEqual({ width: 320, height: 240 });
});

test('the window sits centered inside the padding with its chrome above the page', () => {
  const stage = layout(framed(), pageViewport);
  const pad = 2160 * 0.08;
  expect(stage.window.y).toBeGreaterThanOrEqual(pad - 0.001);
  expect(stage.window.x + stage.window.w / 2).toBeCloseTo(1920, 6);
  expect(stage.chrome).toBeCloseTo(44 * stage.scale, 6);
  expect(stage.page.y).toBeCloseTo(stage.window.y + stage.chrome, 6);
  expect(stage.page.w / stage.page.h).toBeCloseTo(1440 / 900, 6);
  expect(stage.radius).toBe(24);
});

test('at zoom 1 the camera shows the whole stage; zoomed views stay inside it', () => {
  const stage = layout(framed(), pageViewport);
  expect(cameraView({ x: 0, y: 0, w: 1440, h: 900 }, stage, pageViewport)).toEqual({ x: 1920, y: 1080, zoom: 1 });
  const corner = cameraView({ x: 0, y: 0, w: 720, h: 450 }, stage, pageViewport);
  expect(corner.zoom).toBe(2);
  expect(corner.x).toBeCloseTo(stage.page.x + 360 * stage.scale, 6);
  expect(corner.y).toBeCloseTo(stage.page.y + 225 * stage.scale, 6);
  expect(corner.x - 3840 / 4).toBeGreaterThanOrEqual(0);
});

test('auto backgrounds find the brand hue among neutral pixels', () => {
  const pixels = [];
  for (let i = 0; i < 90; i++) pixels.push(245, 245, 245, 255);
  for (let i = 0; i < 10; i++) pixels.push(79, 70, 229, 255);
  expect(brandHue(pixels)).toBeCloseTo(243, 0);
  expect(brandHue([250, 250, 250, 255])).toBeNull();
});

const takeEdit = () => createEdit(scenarioSchema.parse({ name: 'demo', url: 'https://app.example.com/editor', capture: { fps: 30 } }), { events: [{ type: 'click', t: 1, x: 0, y: 0, box }] }, []);

test('a Look keeps only the choices that do not depend on one Take', () => {
  const look = lookFromEdit(takeEdit());
  expect(look.frame).not.toHaveProperty('url');
  expect(look.camera).not.toHaveProperty('targets');
  expect(look.output).not.toHaveProperty('fps');
  expect(look.frame).toMatchObject({ window: 'browser', background: 'aurora' });
  for (const bad of [{ frame: { url: 'x.com' } }, { output: { fps: 30 } }, { camera: { targets: [] } }, { frame: { backgroud: 'ocean' } }, { name: 'brand' }]) {
    expect(lookSchema.safeParse(bad).success).toBe(false);
  }
  expect(lookSchema.parse({ frame: { background: 'ocean' } })).toEqual({ frame: { background: 'ocean' } });
});

test('adopting a Look keeps camera targets, the frame rate and the address bar', () => {
  const edit = takeEdit();
  const next = applyLook(edit, { frame: { background: 'ocean', padding: 0.04 }, output: { aspect: '9:16' } }, 'app.example.com');
  expect(next.frame).toMatchObject({ window: 'browser', background: 'ocean', padding: 0.04, url: 'app.example.com' });
  expect(next.output).toMatchObject({ aspect: '9:16', fps: 30, size: '2160p' });
  expect(next.camera.targets).toEqual(edit.camera.targets);
  expect(applyLook(edit, { frame: false }).frame).toBe(false);
  // A framed Look on an unframed Edit fills in defaults and shows the Scenario's host.
  expect(applyLook({ ...edit, frame: false }, { frame: { background: 'paper' } }, 'app.example.com').frame).toMatchObject({ window: 'browser', background: 'paper', url: 'app.example.com' });
});

test('fields the Scenario config names win over a Look', () => {
  const merged = mergeLook({ frame: { background: 'ocean', radius: 20 }, cursor: { size: 32 } }, { name: 'demo', url: 'https://example.com', frame: { radius: 4 } });
  const config = scenarioSchema.parse(merged);
  expect(config.frame).toMatchObject({ background: 'ocean', radius: 4 });
  expect(config.cursor.size).toBe(32);
  expect(scenarioSchema.parse(mergeLook({ frame: { background: 'ocean' } }, { name: 'demo', url: 'https://example.com', frame: false })).frame).toBe(false);
});

test('summaries name the window, background, aspect and size', () => {
  expect(summarize(lookFromEdit(takeEdit()))).toBe('browser · aurora · 16:9 · 2160p');
  expect(summarize({ frame: false, output: { size: '1080p' } })).toBe('no frame · 1080p');
  expect(summarize({ cursor: { size: 30 } })).toBe('cursor');
});

test('local Looks hide global ones with the same name; saving never overwrites unless asked', async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'cuetake-look-')), global = await fs.mkdtemp(join(tmpdir(), 'cuetake-look-global-'));
  const old = process.env.CUETAKE_LOOK_DIR;
  process.env.CUETAKE_LOOK_DIR = global;
  try {
    await saveLook('brand', { frame: { background: 'sunset' } }, { global: true, cwd });
    await saveLook('minimal', { frame: false }, { global: true, cwd });
    expect((await loadLook('brand', cwd)).look.frame.background).toBe('sunset');
    await saveLook('brand', { frame: { background: 'ocean' } }, { cwd });
    expect(await loadLook('brand', cwd)).toMatchObject({ scope: 'local', look: { frame: { background: 'ocean' } } });
    await expect(saveLook('brand', { frame: { background: 'paper' } }, { cwd })).rejects.toThrow('--replace');
    await saveLook('brand', { frame: { background: 'paper' } }, { cwd, replace: true });
    const listed = await listLooks(cwd);
    expect(listed.map(({ name, scope, shadowed }) => [name, scope, shadowed])).toEqual([['brand', 'local', false], ['brand', 'global', true], ['minimal', 'global', false]]);
    expect(listed[0].summary).toBe('paper');
    await fs.writeFile(join(cwd, 'try.json'), JSON.stringify({ name: 'try-ocean', output: { aspect: '1:1' } }));
    expect(await loadLook('try.json', cwd)).toEqual({ name: 'try-ocean', look: { output: { aspect: '1:1' } } });
    await expect(loadLook('missing', cwd)).rejects.toThrow(global);
    await expect(saveLook('../escape', {}, { cwd })).rejects.toThrow();
    await removeLook('brand', { cwd });
    expect((await loadLook('brand', cwd)).scope).toBe('global');
  } finally {
    if (old === undefined) delete process.env.CUETAKE_LOOK_DIR; else process.env.CUETAKE_LOOK_DIR = old;
    await fs.rm(cwd, { recursive: true, force: true }); await fs.rm(global, { recursive: true, force: true });
  }
});

test('a Preview shows one tile as is and several at half size, labeled, in up to three columns', () => {
  expect(previewSheet([{ width: 1920, height: 1080 }])).toMatchObject({ width: 1920, height: 1080, tiles: [{ x: 0, y: 0, w: 1920, h: 1080, label: null }] });
  const sheet = previewSheet([{ width: 1920, height: 1080 }, { width: 1080, height: 1920 }, { width: 1920, height: 1080 }]);
  expect(sheet.width).toBe(32 + 2 * (960 + 32));
  expect(sheet.tiles[1]).toMatchObject({ w: 540, h: 960, x: 32 + 992 + 210 });
  expect(sheet.tiles[2].y).toBeGreaterThan(sheet.tiles[1].y + 960);
  const landscapeFirst = previewSheet([{ width: 1920, height: 1080 }, { width: 1920, height: 1080 }, { width: 1080, height: 1920 }]);
  expect(landscapeFirst.tiles[2].y).toBe(32 + 44 + 540 + 32 + 44);   // the landscape row stays 540 tall
  expect(landscapeFirst.height).toBe(landscapeFirst.tiles[2].y + 960 + 32);
  expect(previewSheet(Array(5).fill({ width: 1920, height: 1080 })).tiles[2].y).toBe(sheet.tiles[0].y);
});
