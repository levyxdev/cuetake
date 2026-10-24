import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import pkg from '../package.json' with { type: 'json' };
import { scenarioSchema, summarizeFrames } from '../src/pipeline.js';
import { fitZoom, cropAround, zoomSegments, cameraTrack } from '../src/camera.js';
import { cameraTargets, createEdit, DEFAULT_STYLE, withDefaults } from '../src/edit.js';
import { pointerAt, presses, sparksAt } from '../src/cursor.js';
import { atShortSide, layout, cameraView, brandHue, brandColor, previewSheet } from '../src/stage.js';
import { lookFromEdit, applyLook, mergeLook, summarize, saveLook, loadLook, listLooks, removeLook, resolvedLook } from '../src/look.js';
import { bundle, codeRefs, forRender, BUILTIN_DIR } from '../src/styles.js';
import { npxFolders, uninstall } from '../src/uninstall.js';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('validates capture settings but passes styling through untouched', () => {
  const base = { name: 'demo', url: 'https://example.com' };
  expect(scenarioSchema.safeParse({ ...base, capture: { fps: 45 } }).success).toBe(false);
  expect(scenarioSchema.safeParse({ ...base, viewport: { width: 1441, height: 900 } }).success).toBe(false);
  expect(scenarioSchema.parse(base).capture.fps).toBe(60);
  const styling = { output: { width: 1234, height: 4 }, frame: { glow: 'anything' } };
  expect(scenarioSchema.parse({ ...base, ...styling })).toMatchObject(styling);
});

test('reports sparse static capture honestly rather than labeling it 60 unique fps', () => {
  const stats = summarizeFrames([{ timeMs: 0 }, { timeMs: 17 }, { timeMs: 34 }, { timeMs: 1034 }], 2);
  expect(stats.maxIntervalMs).toBe(1000);
  expect(stats.perSecond.map(s => s.callbacks)).toEqual([3, 1]);
});

const viewport = { width: 320, height: 240 };
const box = { x: 1, y: 2, width: 3, height: 4 };
const small = (x, y) => ({ x, y, width: 20, height: 20 });
const camera = { ...DEFAULT_STYLE.camera, padding: 0 };
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
  expect(edit.schemaVersion).toBe(3);
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
  const effect = { draw: 'spark', duration: 400 };
  expect(sparksAt(list, effect, 1.2)).toEqual([{ x: 5, y: 6, progress: expect.closeTo(0.5, 6) }]);
  expect(sparksAt(list, effect, 1.5)).toEqual([]);
  expect(sparksAt(list, false, 1.2)).toEqual([]);
});

test('the skill launcher pins the version being released', () => {
  const launcher = readFileSync(new URL('../skills/cuetake/scripts/cuetake', import.meta.url), 'utf8');
  expect(launcher).toContain(`cuetake@${pkg.version}`);
});

const pageViewport = { width: 1440, height: 900 };
const framed = (frame = {}, output = {}) => ({ output: { width: 3840, height: 2160, ...output }, frame: { padding: 0.08, radius: 12, ...frame } });

test('Previews scale the output to a short side, keeping its proportions and even sizes', () => {
  expect(atShortSide(framed(), 1080).output).toMatchObject({ width: 1920, height: 1080 });
  expect(atShortSide(framed({}, { width: 1080, height: 1350 }), 1080).output).toMatchObject({ width: 1080, height: 1350 });
  expect(atShortSide(framed({}, { width: 2160, height: 3841 }), 1080).output).toMatchObject({ width: 1080, height: 1920 });
});

test('the window sits centered inside the padding with its chrome above the page', () => {
  const stage = layout(framed(), pageViewport, 44);
  const pad = 2160 * 0.08;
  expect(stage.window.y).toBeGreaterThanOrEqual(pad - 0.001);
  expect(stage.window.x + stage.window.w / 2).toBeCloseTo(1920, 6);
  expect(stage.chrome).toBeCloseTo(44 * stage.scale, 6);
  expect(stage.page.y).toBeCloseTo(stage.window.y + stage.chrome, 6);
  expect(stage.page.w / stage.page.h).toBeCloseTo(1440 / 900, 6);
  expect(stage.radius).toBe(24);
  // Padding per side, as [top, right, bottom, left]: the window shifts away from the larger side.
  const shifted = layout(framed({ padding: [0.05, 0.05, 0.05, 0.3] }), pageViewport);
  expect(shifted.window.x).toBeGreaterThan(0.3 * 2160 - 0.001);
  // Without padding or chrome at the viewport's own proportions, the page fills the output.
  expect(layout(framed({ padding: 0 }, { width: 2880, height: 1800 }), pageViewport).page).toEqual({ x: 0, y: 0, w: 2880, h: 1800 });
});

test('at zoom 1 the camera shows the whole stage; zoomed views stay inside it', () => {
  const stage = layout(framed(), pageViewport, 44);
  expect(cameraView({ x: 0, y: 0, w: 1440, h: 900 }, stage, pageViewport)).toEqual({ x: 1920, y: 1080, zoom: 1 });
  const corner = cameraView({ x: 0, y: 0, w: 720, h: 450 }, stage, pageViewport);
  expect(corner.zoom).toBe(2);
  expect(corner.x).toBeCloseTo(stage.page.x + 360 * stage.scale, 6);
  expect(corner.y).toBeCloseTo(stage.page.y + 225 * stage.scale, 6);
  expect(corner.x - 3840 / 4).toBeGreaterThanOrEqual(0);
});

test('the brand color comes from the brand hue among neutral pixels, or is a neutral gray', () => {
  const pixels = [];
  for (let i = 0; i < 90; i++) pixels.push(245, 245, 245, 255);
  for (let i = 0; i < 10; i++) pixels.push(79, 70, 229, 255);
  expect(brandHue(pixels)).toBeCloseTo(243, 0);
  const [r, g, b] = brandColor(pixels);
  expect(b).toBeGreaterThan(r); expect(r).toBeGreaterThan(g);
  expect(brandHue([250, 250, 250, 255])).toBeNull();
  expect(brandColor([250, 250, 250, 255])).toEqual([0.55, 0.56, 0.6]);
});

const takeEdit = () => createEdit(scenarioSchema.parse({ name: 'demo', url: 'https://app.example.com/editor', capture: { fps: 30 } }), { events: [{ type: 'click', t: 1, x: 0, y: 0, box }] }, []);

test('a Look keeps only the choices that do not depend on one Take', () => {
  const look = lookFromEdit(takeEdit());
  expect(look.frame).not.toHaveProperty('url');
  expect(look.camera).not.toHaveProperty('targets');
  expect(look.output).not.toHaveProperty('fps');
  expect(look).not.toHaveProperty('schemaVersion');
  expect(look.frame).toMatchObject({ chrome: { draw: 'browser' }, background: [{ shader: 'fluted' }], effects: [{ shader: 'shadow' }] });
});

test('adopting a Look keeps camera targets, the frame rate and the address bar', () => {
  const edit = takeEdit();
  const next = applyLook(edit, { frame: { padding: 0.04, background: [{ image: 'photo.jpg' }] }, output: { width: 1080, height: 1920 } }, 'app.example.com');
  expect(next.frame).toMatchObject({ chrome: { draw: 'browser' }, padding: 0.04, background: [{ image: 'photo.jpg' }], url: 'app.example.com' });
  expect(next.output).toMatchObject({ width: 1080, height: 1920, fps: 30, quality: 22 });
  expect(next.camera.targets).toEqual(edit.camera.targets);
  // Changing an item's parameters merges; naming a new drawing replaces the item.
  expect(applyLook(edit, { cursor: { size: 40 } }).cursor).toEqual({ draw: 'arrow', size: 40, color: '#ffffff' });
  expect(applyLook(edit, { cursor: { image: 'hand.png', hotspot: [4, 2] } }).cursor).toEqual({ image: 'hand.png', hotspot: [4, 2] });
  expect(applyLook(edit, { clickEffect: false }).clickEffect).toBe(false);
});

test('fields the Scenario config names win over a Look', () => {
  const merged = mergeLook({ frame: { radius: 20, chrome: { draw: 'macos' } }, cursor: { size: 32 } }, { name: 'demo', url: 'https://example.com', frame: { radius: 4 } });
  const config = scenarioSchema.parse(merged);
  expect(config.frame).toMatchObject({ chrome: { draw: 'macos' }, radius: 4 });
  expect(config.cursor.size).toBe(32);
  expect(withDefaults({ frame: { chrome: false } }).frame).toMatchObject({ chrome: false, padding: 0.08 });
});

test('summaries name the chrome, Background layers and output size', () => {
  expect(summarize(lookFromEdit(takeEdit()))).toBe('browser · fluted · 3840×2160');
  expect(summarize({ frame: { chrome: false, background: [{ image: 'styles/photo.jpg' }, { shader: 'glass.glsl' }] } })).toBe('none · photo.jpg · glass.glsl');
  expect(summarize({ cursor: { size: 30 } })).toBe('cursor');
});

const tmp = prefix => fs.mkdtemp(join(tmpdir(), prefix));

test('file refs are copied beside their Take or Look, with a suffix when a different file has the name', async () => {
  const from = await tmp('cuetake-from-'), to = await tmp('cuetake-to-');
  try {
    await fs.writeFile(join(from, 'glass.glsl'), 'void main() {}');
    await fs.mkdir(join(from, 'other'));
    await fs.writeFile(join(from, 'other', 'glass.glsl'), 'void main() { }');
    await fs.writeFile(join(from, 'font.woff2'), 'font');
    const style = { frame: { background: [{ shader: 'glass.glsl' }, { shader: 'other/glass.glsl' }, { shader: 'fluted' }], chrome: { draw: 'browser', files: { font: 'font.woff2' } } } };
    const copied = await bundle(style, from, join(to, 'styles'), 'styles/');
    expect(copied.frame.background.map(layer => layer.shader)).toEqual(['styles/glass.glsl', 'styles/glass-2.glsl', 'fluted']);
    expect(copied.frame.chrome.files.font).toBe('styles/font.woff2');
    expect(await fs.readFile(join(to, 'styles', 'glass-2.glsl'), 'utf8')).toBe('void main() { }');
    // Files already in place stay where they are.
    expect(await bundle(copied, to, join(to, 'styles'), 'styles/')).toEqual(copied);
    expect(codeRefs(copied)).toEqual(['styles/glass.glsl', 'styles/glass-2.glsl']);
  } finally { await fs.rm(from, { recursive: true, force: true }); await fs.rm(to, { recursive: true, force: true }); }
});

test('Render reads built-ins with their parameters under the item and every file by URL', () => {
  const files = {};
  const { edit } = forRender(withDefaults({ frame: { background: [{ shader: 'fluted', count: 12 }, { image: 'bg.svg' }], chrome: { draw: 'browser-dark' } } }), '/take', files);
  expect(edit.frame.background[0]).toMatchObject({ count: 12, strength: 0.09, kind: 'shader', ref: 'fluted' });
  expect(edit.frame.chrome).toMatchObject({ dark: true, kind: 'draw' });
  expect(files[edit.frame.background[1].url.slice('/files/'.length)]).toBe('/take/bg.svg');
  expect(files[edit.frame.background[0].url.slice('/files/'.length)]).toBe(join(BUILTIN_DIR, 'fluted.glsl'));
  expect(() => forRender(withDefaults({ cursor: { draw: 'hand' } }), '/take')).toThrow('No built-in named');
});

test('local Looks hide global ones with the same name; saving never overwrites unless asked', async () => {
  const cwd = await tmp('cuetake-look-'), global = await tmp('cuetake-look-global-');
  const old = process.env.CUETAKE_LOOK_DIR;
  process.env.CUETAKE_LOOK_DIR = global;
  try {
    await saveLook('brand', { frame: { chrome: { draw: 'macos' } } }, { global: true, cwd });
    await saveLook('minimal', { frame: { chrome: false } }, { global: true, cwd });
    expect((await loadLook('brand', cwd)).look.frame.chrome.draw).toBe('macos');
    await saveLook('brand', { frame: { chrome: { draw: 'browser-dark' } } }, { cwd });
    expect(await loadLook('brand', cwd)).toMatchObject({ scope: 'local', look: { frame: { chrome: { draw: 'browser-dark' } } } });
    await expect(saveLook('brand', { cursor: { size: 30 } }, { cwd })).rejects.toThrow('--replace');
    await saveLook('brand', { frame: { chrome: { draw: 'macos-dark' } } }, { cwd, replace: true });
    const listed = await listLooks(cwd);
    expect(listed.map(({ name, scope, shadowed }) => [name, scope, shadowed])).toEqual([['brand', 'local', false], ['brand', 'global', true], ['minimal', 'global', false]]);
    expect(listed[0].summary).toBe('macos-dark');
    await fs.writeFile(join(cwd, 'try.json'), JSON.stringify({ name: 'try-portrait', output: { width: 1080, height: 1920 } }));
    expect(await loadLook('try.json', cwd)).toEqual({ name: 'try-portrait', dir: cwd, look: { output: { width: 1080, height: 1920 } } });
    await expect(loadLook('missing', cwd)).rejects.toThrow(global);
    await expect(saveLook('../escape', {}, { cwd })).rejects.toThrow();
    await removeLook('brand', { cwd });
    expect((await loadLook('brand', cwd)).scope).toBe('global');
  } finally {
    if (old === undefined) delete process.env.CUETAKE_LOOK_DIR; else process.env.CUETAKE_LOOK_DIR = old;
    await fs.rm(cwd, { recursive: true, force: true }); await fs.rm(global, { recursive: true, force: true });
  }
});

test('a Look that names files is saved as a folder with copies of them, and lists its code', async () => {
  const cwd = await tmp('cuetake-look-'), take = await tmp('cuetake-take-');
  try {
    await fs.mkdir(join(take, 'styles'));
    await fs.writeFile(join(take, 'styles', 'glow.glsl'), 'void main() { color = vec4(1.0); }');
    await fs.writeFile(join(take, 'styles', 'photo.png'), 'png');
    const look = { frame: { background: [{ image: 'styles/photo.png' }, { shader: 'styles/glow.glsl', amount: 0.4 }] } };
    const saved = await saveLook('glow', look, { cwd, from: take });
    expect(saved.path).toBe(join(cwd, '.cuetake', 'looks', 'glow', 'look.json'));
    const loaded = await loadLook('glow', cwd);
    expect(loaded.look.frame.background).toEqual([{ image: 'photo.png' }, { shader: 'glow.glsl', amount: 0.4 }]);
    expect(resolvedLook(loaded).frame.background[1].shader).toBe(join(cwd, '.cuetake', 'looks', 'glow', 'glow.glsl'));
    expect((await listLooks(cwd))[0].code).toEqual([join(cwd, '.cuetake', 'looks', 'glow', 'glow.glsl')]);
    await removeLook('glow', { cwd });
    expect(await listLooks(cwd)).toEqual([]);
  } finally { await fs.rm(cwd, { recursive: true, force: true }); await fs.rm(take, { recursive: true, force: true }); }
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

const withEnv = async (vars, run) => {
  const old = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try { return await run(); } finally { for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
};
const writeJson = async (path, data) => { await fs.mkdir(join(path, '..'), { recursive: true }); await fs.writeFile(path, JSON.stringify(data)); };

test('npx folders made for CueTake alone are found, including the one the CLI runs from', async () => {
  const cache = await tmp('cuetake-npm-'), other = await tmp('cuetake-npm-other-');
  try {
    await writeJson(join(cache, '_npx', 'old', 'package.json'), { dependencies: { cuetake: '^0.2.0' } });
    await writeJson(join(cache, '_npx', 'mixed', 'package.json'), { dependencies: { cuetake: '^0.3.0', zod: '^3' } });
    await writeJson(join(cache, '_npx', 'tool', 'package.json'), { dependencies: { prettier: '^3' } });
    await fs.mkdir(join(cache, '_npx', 'broken'));
    await writeJson(join(other, '_npx', 'own', 'package.json'), { dependencies: { cuetake: '^0.3.0' } });
    const packageDir = join(other, '_npx', 'own', 'node_modules', 'cuetake');
    expect(await npxFolders({ cache, packageDir })).toEqual([join(cache, '_npx', 'old'), join(other, '_npx', 'own')]);
    expect(await npxFolders({ cache: join(cache, 'missing'), packageDir: '/src/cuetake' })).toEqual([]);
  } finally { await fs.rm(cache, { recursive: true, force: true }); await fs.rm(other, { recursive: true, force: true }); }
});

test('uninstall removes caches and the browser, and keeps Auth profiles and global Looks unless asked', async () => {
  const home = await tmp('cuetake-uninstall-');
  const auth = join(home, 'auth'), looks = join(home, 'looks'), cache = join(home, 'npm');
  const browser = { path: '/cache/chromium/chrome', existed: true, removed: true };
  const removeBrowser = async ({ dryRun }) => ({ ...browser, removed: !dryRun });
  try {
    await withEnv({ CUETAKE_AUTH_DIR: auth, CUETAKE_LOOK_DIR: looks, npm_config_cache: cache }, async () => {
      await writeJson(join(cache, '_npx', 'old', 'package.json'), { dependencies: { cuetake: '^0.2.0' } });
      await writeJson(join(auth, 'product-demo.json'), {});
      await writeJson(join(auth, 'product-demo.json.0b6c1a2e-0000-4000-8000-000000000000.tmp'), {});
      await fs.writeFile(join(auth, 'notes.txt'), 'not CueTake\'s');
      await saveLook('brand', { cursor: { size: 30 } }, { global: true, cwd: home });
      await writeJson(join(looks, 'ocean', 'look.json'), {});
      await fs.mkdir(join(looks, 'scratch'));

      const plan = await uninstall({ dryRun: true, removeBrowser });
      expect(plan.wouldRemove.map(r => r.item)).toEqual(['npx cache', 'browser']);
      expect(plan.kept).toMatchObject([{ item: 'Auth profile', count: 2, reason: 'pass --auth to remove' }, { item: 'global Look', count: 2, reason: 'pass --looks to remove' }]);
      await fs.access(join(cache, '_npx', 'old'));

      const done = await uninstall({ removeBrowser });
      expect(done.removed).toEqual([{ item: 'npx cache', path: join(cache, '_npx', 'old') }, { item: 'browser', path: browser.path }]);
      expect((await fs.readdir(auth)).length).toBe(3);

      const all = await uninstall({ auth: true, looks: true, removeBrowser: async () => ({ ...browser, removed: false }) });
      expect(all.kept).toEqual([{ item: 'browser', path: browser.path, reason: 'another Playwright installation still uses it' }]);
      expect(all.removed.map(r => r.path)).toEqual([join(auth, 'product-demo.json'), join(auth, 'product-demo.json.0b6c1a2e-0000-4000-8000-000000000000.tmp'), join(looks, 'brand.json'), join(looks, 'ocean')]);
      expect(await fs.readdir(auth)).toEqual(['notes.txt']);
      expect(await fs.readdir(looks)).toEqual(['scratch']);
    });
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
