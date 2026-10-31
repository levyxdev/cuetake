import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import pkg from '../package.json' with { type: 'json' };
import { scenarioSchema, summarizeFrames, captureWarnings, timelineWarnings, captureScale, narrationSchema } from '../src/pipeline.js';
import { placeRecords } from '../src/probe.js';
import { captureSeconds } from '../src/tab-capture.js';
import { drawsWithGpu } from '../src/environment.js';
import { fitZoom, cropAround, zoomSegments, cameraTrack } from '../src/camera.js';
import { cameraTargets, createEdit, DEFAULT_STYLE, withDefaults, addressBar, addressOf } from '../src/edit.js';
import { pointerAt, presses, sparksAt, heldSpans, pressScale, shapeAt, drawnShape, cursorTrack } from '../src/cursor.js';
import { random, reachMs, reach, landing, pauseMs, typingDelays } from '../src/motion.js';
import { atShortSide, layout, cameraView, brandHue, brandColor, previewSheet } from '../src/stage.js';
import { lookFromEdit, applyLook, mergeLook, summarize, saveLook, loadLook, listLooks, removeLook, resolvedLook } from '../src/look.js';
import { bundle, codeRefs, forRender, BUILTIN_DIR } from '../src/styles.js';
import { npxFolders, uninstall } from '../src/uninstall.js';
import { subtitleRows, subtitleCues, lineProblems, toSrt, toVtt } from '../src/narration.js';
import { shortcutKeys, keycapShows, keycapTrack } from '../src/shortcuts.js';
import { timeMap, fastForwardProblems, retimed, linesInFinal, badgeAt } from '../src/time-map.js';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('validates capture settings but passes styling through untouched', () => {
  const base = { name: 'demo', url: 'https://example.com' };
  expect(scenarioSchema.safeParse({ ...base, capture: { fps: 45 } }).success).toBe(false);
  expect(scenarioSchema.safeParse({ ...base, viewport: { width: 1441, height: 900 } }).success).toBe(false);
  expect(scenarioSchema.parse(base).capture.fps).toBe(60);
  expect(scenarioSchema.parse(base).director).toEqual({ speed: 1, seed: 1 });
  expect(scenarioSchema.safeParse({ ...base, director: { speed: 0 } }).success).toBe(false);
  expect(scenarioSchema.safeParse({ ...base, director: { pace: 2 } }).success).toBe(false);
  const styling = { output: { width: 1234, height: 4 }, frame: { glow: 'anything' } };
  expect(scenarioSchema.parse({ ...base, ...styling })).toMatchObject(styling);
});

test('reports sparse static capture honestly rather than labeling it 60 unique fps', () => {
  const stats = summarizeFrames([{ timeMs: 0 }, { timeMs: 17 }, { timeMs: 34 }, { timeMs: 1034 }], 2);
  expect(stats.maxIntervalMs).toBe(1000);
  expect(stats.perSecond.map(s => s.callbacks)).toEqual([3, 1]);
});

test('does not count a page load as falling behind, since no document draws while one loads', () => {
  const capture = { duration: 6.5, pageFrames: [60, 8, 3, 60, 60, 60], navigations: [{ t: 1.4, end: 2.6, url: 'https://cuetake.test/next' }] };
  expect(captureWarnings(capture, 2)).toEqual([]);
  // Slow seconds away from the load still count.
  const [behind] = captureWarnings({ ...capture, pageFrames: [60, 8, 3, 60, 9, 7] }, 2);
  expect(behind).toContain('for 2 of 4 s (lowest 7)');
});

test('places animation frames and navigations in seconds since Capture started', () => {
  const startedAtMs = 10_000;
  const counted = captureSeconds({
    startedAtMs,
    paints: [9_990, 10_000, 10_500, 10_999, 11_000, 12_200, 13_400],
    navigations: [
      { ms: 9_000, end: 9_500, url: 'https://cuetake.test/before' },
      { ms: 10_800, end: 11_650, commit: 11_100, url: 'https://cuetake.test/next' },
      { ms: 12_900, end: null, url: 'https://cuetake.test/slow' },
    ],
  }, 13_300);
  // A paint before the start or after the stop is not counted; a second with none counts as zero.
  expect(counted.pageFrames).toEqual([3, 1, 1]);
  // A navigation finished before the start is left out; one still loading at the stop ends there.
  expect(counted.navigations).toEqual([{ t: 0.8, end: 1.65, commit: 1.1, url: 'https://cuetake.test/next' }, { t: 2.9, end: 3.3, url: 'https://cuetake.test/slow' }]);
});

test('the address bar shows the host the page is on, changing when a navigation commits on another', () => {
  const config = scenarioSchema.parse({ name: 'demo', url: 'http://localhost:3000/login' });
  const navigate = (commit, url) => ({ type: 'navigate', t: commit - 0.2, end: commit + 0.3, commit, url });
  const timeline = { url: 'http://localhost:3000/orders', events: [
    { type: 'click', t: 1, x: 0, y: 0 },
    navigate(1.4, 'http://localhost:3000/orders/1'),         // same host: no change
    navigate(3.2, 'https://checkout.stripe.test/pay?id=1'),
    { type: 'navigate', t: 4, end: 4.1, url: 'https://files.example/report.pdf' }, // never committed: a download
    navigate(6.5, 'http://localhost:3000/orders/1?paid=1'),
  ] };
  expect(addressBar(config, timeline)).toEqual({ url: 'localhost:3000', urls: [{ t: 3.2, url: 'checkout.stripe.test' }, { t: 6.5, url: 'localhost:3000' }] });
  // A url the Scenario names stands for the host Capture started on, also when the page comes back to it.
  const named = scenarioSchema.parse({ name: 'demo', url: 'http://localhost:3000/login', frame: { url: 'app.acme.com' } });
  expect(addressBar(named, timeline)).toEqual({ url: 'app.acme.com', urls: [{ t: 3.2, url: 'checkout.stripe.test' }, { t: 6.5, url: 'app.acme.com' }] });
  // Without the start address, a Take of an older version starts from the Scenario's url.
  expect(addressBar(config, { events: [] })).toEqual({ url: 'localhost:3000', urls: [] });
  expect(addressOf('about:blank')).toBe('about:blank');
  const edit = createEdit(config, timeline, []);
  expect(edit.frame).toMatchObject({ url: 'localhost:3000', urls: [{ t: 3.2 }, { t: 6.5 }], chrome: { draw: 'browser' } });
  // The changes belong to the Take: a Look leaves them out, and applying one keeps them.
  expect(lookFromEdit(edit).frame).not.toHaveProperty('urls');
  expect(applyLook(edit, lookFromEdit(withDefaults({})), 'localhost:3000').frame.urls).toEqual(edit.frame.urls);
});

test('warns when the page got too few animation frames during Capture, not when it merely sat still', () => {
  // A still page sends few Source frames but keeps its animation frames at the display rate.
  expect(captureWarnings({ duration: 4.5, frames: [{ timeMs: 0 }], pageFrames: [60, 59, 60, 58, 20] }, 2)).toEqual([]);
  // One slow second, such as the last partial one or a single hitch, is not enough.
  expect(captureWarnings({ duration: 4.5, pageFrames: [60, 12, 60, 60, 3] }, 2)).toEqual([]);
  const [behind] = captureWarnings({ duration: 5.2, pageFrames: [55, 9, 11, 6, 40, 2] }, 2);
  expect(behind).toContain('for 3 of 5 s (lowest 6)');
  expect(behind).toContain('resolutionScale: 1');
  const [atOne] = captureWarnings({ duration: 3, pageFrames: [9, 8, 7] }, 1);
  expect(atOne).toContain('already used resolutionScale 1');
  expect(atOne).toContain('GPU');
  // Takes recorded before the page's frames were counted are not judged.
  expect(captureWarnings({ duration: 3, frames: [] }, 2)).toEqual([]);
});

test('places input from nested iframes in top-level CSS pixels, as each parent measured its iframe at the moment', () => {
  // Frame 0 is the top; frame 1 sits in it and frame 2 in frame 1, shown at half size.
  const records = [
    { kind: 'top', frame: 0 },
    { kind: 'link', frame: 1, parent: 0, element: 0 },
    { kind: 'link', frame: 2, parent: 1, element: 3 },
    { kind: 'frames', frame: 0, ms: 100, rects: [{ id: 0, x: 50, y: 200, sx: 1, sy: 1, turned: false }] },
    // The page scrolls 40 px down at 300 ms, carrying frame 1 up.
    { kind: 'frames', frame: 0, ms: 300, rects: [{ id: 0, x: 50, y: 160, sx: 1, sy: 1, turned: false }] },
    { kind: 'frames', frame: 1, ms: 120, rects: [{ id: 3, x: 10, y: 20, sx: 0.5, sy: 0.5, turned: false }] },
    { kind: 'move', frame: 0, ms: 90, x: 5, y: 5, shape: 'default' },
    // Before frame 1's first measure, its first one holds.
    { kind: 'move', frame: 1, ms: 95, x: 1, y: 2, shape: 'default' },
    { kind: 'move', frame: 2, ms: 200, x: 40, y: 60, shape: 'pointer' },
    { kind: 'down', frame: 2, ms: 210, button: 'left', x: 40, y: 60, box: { x: 20, y: 40, width: 100, height: 40 } },
    { kind: 'up', frame: 2, ms: 260, button: 'left', x: 40, y: 60 },
    { kind: 'key', frame: 2, ms: 400, key: 'a', code: 'KeyA', field: true, box: { x: 0, y: 100, width: 200, height: 20 } },
  ];
  const placed = placeRecords(records.toReversed());
  expect(placed.pointer).toEqual([[90, 5, 5], [95, 51, 202], [200, 50 + 10 + 20, 200 + 20 + 30], [210, 80, 250]]);
  expect(placed.downs).toEqual([{ ms: 210, button: 'left', x: 80, y: 250, box: { x: 70, y: 240, width: 50, height: 20 } }]);
  expect(placed.ups).toEqual([{ ms: 260, button: 'left', x: 80, y: 250 }]);
  // After the scroll, the key's field box moves up with its frames.
  expect(placed.keys).toEqual([{ ms: 400, key: 'a', code: 'KeyA', field: true, box: { x: 60, y: 160 + 20 + 50, width: 100, height: 10 } }]);
  expect(placed.shapes).toEqual([[90, 'default'], [200, 'pointer']]);
  expect(placed.turned).toEqual([]);
  expect(placed.unplaced).toEqual([]);
});

test('counts a frame\'s cursor shape only while the pointer is over it, and notes input it cannot place exactly', () => {
  const records = [
    { kind: 'top', frame: 0 },
    { kind: 'link', frame: 1, parent: 0, element: 0 },
    { kind: 'frames', frame: 0, ms: 0, rects: [{ id: 0, x: 100, y: 100, sx: 1, sy: 1, turned: true }] },
    { kind: 'move', frame: 1, ms: 10, x: 5, y: 5, shape: 'text' },
    { kind: 'move', frame: 0, ms: 20, x: 5, y: 5, shape: 'default' },
    // Frame 1 resamples on a key while the pointer is over the top: not shown.
    { kind: 'shape', frame: 1, ms: 30, shape: 'pointer' },
    { kind: 'key', frame: 1, ms: 30, key: 'Enter', code: 'Enter', field: false, box: null },
    { kind: 'down', frame: 1, ms: 40, button: 'left', x: 6, y: 6, box: null },
    // Frame 2 was never linked to its iframe.
    { kind: 'move', frame: 2, ms: 50, x: 1, y: 1, shape: 'grab' },
    { kind: 'down', frame: 2, ms: 60, button: 'left', x: 1, y: 1, box: null },
  ];
  const placed = placeRecords(records);
  expect(placed.shapes).toEqual([[10, 'text'], [20, 'default'], [50, 'grab']]);
  expect(placed.turned).toEqual([30, 40]);
  expect(placed.unplaced).toEqual([60]);
  expect(placed.pointer.map(([ms]) => ms)).toEqual([10, 20, 40]);
});

test('warns about input Capture could not place exactly inside an iframe', () => {
  expect(timelineWarnings({ pointer: [], events: [] })).toEqual([]);
  const [turned, unplaced] = timelineWarnings({ frameInput: { turned: [1.2, 1.5, 2, 2.5, 3, 4, 5], unplaced: [6.25] } });
  expect(turned).toContain('1.20 s, 1.50 s, 2.00 s, 2.50 s, 3.00 s and 2 more');
  expect(turned).toContain('rotated');
  expect(unplaced).toContain('6.25 s');
  expect(timelineWarnings({ frameInput: { turned: [], unplaced: [3] } })).toHaveLength(1);
});

test('tells a software renderer from a GPU by the name Chromium reports', () => {
  expect(drawsWithGpu('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)')).toBe(false);
  expect(drawsWithGpu('ANGLE (Mesa, llvmpipe (LLVM 15.0.7, 256 bits), OpenGL 4.5)')).toBe(false);
  expect(drawsWithGpu('ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(false);
  expect(drawsWithGpu('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)')).toBe(true);
  expect(drawsWithGpu('ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3060/PCIe/SSE2, OpenGL 4.5.0)')).toBe(true);
  expect(drawsWithGpu(null)).toBe(null);
});

test('lowers the resolution scale only when Chromium has no GPU and nothing chose a scale', () => {
  const software = { name: 'gpu', ok: true, accelerated: false, renderer: 'SwiftShader' };
  expect(captureScale(undefined, software)).toEqual({ resolutionScale: 1, lowered: true });
  expect(captureScale(2, software)).toEqual({ resolutionScale: 2, lowered: false });
  expect(captureScale(undefined, { ...software, accelerated: true })).toEqual({ resolutionScale: 2, lowered: false });
  expect(captureScale(undefined, { ...software, accelerated: null })).toEqual({ resolutionScale: 2, lowered: false });
  expect(captureScale(1, undefined)).toEqual({ resolutionScale: 1, lowered: false });
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

test('a segment holds one zoom, the closest that fits all its targets', () => {
  const targets = [{ t: 1, box: small(40, 100) }, { t: 2.5, box: { x: 150, y: 100, width: 60, height: 20 }, zoom: 1.5 }];
  expect(zoomSegments(targets, viewport, camera, 10)[0].zoom).toBe(1.5);
  const track = cameraTrack({ targets, viewport, camera, duration: 8, fps: 60 });
  expect(zoomAt(track, 1.5)).toBeCloseTo(1.5, 2);
  expect(zoomAt(track, 3)).toBeCloseTo(1.5, 2);
});

test('the camera stays still for a target already in view and moves only as far as one outside needs', () => {
  const inView = cameraTrack({ targets: [{ t: 1, box: small(100, 100) }, { t: 2.5, box: small(150, 120) }], viewport, camera, duration: 8, fps: 60 });
  for (const t of [2.5, 3, 4]) {
    expect(centerAt(inView, t).x).toBeCloseTo(centerAt(inView, 2).x, 1);
    expect(centerAt(inView, t).y).toBeCloseTo(centerAt(inView, 2).y, 1);
  }
  // Centered on x 110 at 2×, the view spans 30 to 190; reaching 200 to 220 brings its edge to 220, not its center to 210.
  const outside = cameraTrack({ targets: [{ t: 1, box: small(100, 100) }, { t: 2.5, box: small(200, 100) }], viewport, camera, duration: 8, fps: 60 });
  expect(centerAt(outside, 3.5).x).toBeCloseTo(140, 0);
});

test('the camera follows the cursor only near the edge of the view, and stays where it left off', () => {
  const pointerAt = edge => t => ({ x: t < 2.5 ? 30 : t < 3.5 ? edge : 60, y: 120 });
  const target = [{ t: 2, box: small(20, 110), until: 5 }];
  // The view spans 0 to 160; the cursor at 130 stays inside its central 80%, at 150 it does not.
  expect(centerAt(cameraTrack({ targets: target, viewport, camera, duration: 9, fps: 60, pointerAt: pointerAt(130) }), 3.4).x).toBeCloseTo(80, 0);
  const pushed = cameraTrack({ targets: target, viewport, camera, duration: 9, fps: 60, pointerAt: pointerAt(150) });
  expect(centerAt(pushed, 3.4).x).toBeGreaterThan(85);
  expect(centerAt(pushed, 4.5).x).toBeCloseTo(centerAt(pushed, 3.5).x, 0);
});

test('the camera eases into each move', () => {
  const track = cameraTrack({ targets: [{ t: 2, box: small(240, 100) }], viewport, camera, duration: 8, fps: 60 });
  // The move starts `lead` before the action, at 1.4 s; a lone spring would already be at 1.05×.
  expect(zoomAt(track, 1.45)).toBeLessThan(1.01);
  const speeds = track.slice(84, 96).map((c, i, all) => i ? Math.abs(c.w - all[i - 1].w) : 0).slice(1);
  for (let i = 1; i < speeds.length; i++) expect(speeds[i]).toBeGreaterThan(speeds[i - 1]);
});

const speedAt = (map, t) => (map.sourceAt(t + 1e-4) - map.sourceAt(t - 1e-4)) / 2e-4;

test('a fast-forward shortens the Final by what its rate saves, and plays the rest as recorded', () => {
  const map = timeMap([{ start: 5, end: 13, rate: 4 }], 20);
  // 0.3 s easing in and out covers 0.75 s of Source each; the other 6.5 s play at 4×.
  expect(map.duration).toBeCloseTo(5 + 0.6 + 6.5 / 4 + 7, 9);
  expect(map.spans).toEqual([{ start: 5, end: expect.closeTo(7.225, 9), rate: 4 }]);
  expect(map.sourceAt(3)).toBe(3);
  expect(map.sourceAt(map.duration)).toBeCloseTo(20, 9);
  expect(map.sourceAt(map.duration - 2)).toBeCloseTo(18, 9);
  expect(timeMap([], 20)).toMatchObject({ duration: 20, spans: [] });
  expect(timeMap([], 20).sourceAt(7.5)).toBe(7.5);
});

test('a fast-forward eases to its rate and back, never jumping, and maps both ways', () => {
  const map = timeMap([{ start: 5, end: 13, rate: 4 }], 20);
  expect(speedAt(map, 4.99)).toBeCloseTo(1, 2);
  expect(speedAt(map, 5.01)).toBeLessThan(1.1);
  expect(speedAt(map, 6)).toBeCloseTo(4, 6);
  expect(speedAt(map, 7.22)).toBeLessThan(1.1);
  expect(speedAt(map, 7.3)).toBeCloseTo(1, 6);
  let previous = -1;
  for (let t = 0; t <= map.duration; t += 0.01) {
    const s = map.sourceAt(t);
    expect(s).toBeGreaterThanOrEqual(previous);
    expect(map.outputAt(s)).toBeCloseTo(t, 9);
    previous = s;
  }
});

test('a fast-forward too short to ease fully still keeps its length exact, and spans clip to the Source', () => {
  const map = timeMap([{ start: 1, end: 1.5, rate: 4 }], 3);
  expect(map.duration).toBeCloseTo(1 + 0.2 + 1.5, 9);
  expect(map.sourceAt(1.2)).toBeCloseTo(1.5, 9);
  expect(timeMap([{ start: 2, end: 9, rate: 2 }], 3).sourceAt(timeMap([{ start: 2, end: 9, rate: 2 }], 3).duration)).toBeCloseTo(3, 9);
});

test('fast-forwards that overlap, are empty or slow down are named, and stop the time map', () => {
  expect(fastForwardProblems([{ start: 1, end: 3, rate: 2 }, { start: 2, end: 4, rate: 2 }])).toEqual(['The fast-forward from 1.00 s overlaps the one from 2.00 s']);
  expect(fastForwardProblems([{ start: 3, end: 3, rate: 2 }, { start: 5, end: 6, rate: 0.5 }])).toEqual([
    'The fast-forward from 3.00 s needs a start before its end, in seconds', 'The fast-forward from 5.00 s needs a rate of at least 1',
  ]);
  expect(fastForwardProblems([{ start: 1, end: 2, rate: 2 }, { start: 2, end: 3, rate: 3 }])).toEqual([]);
  expect(() => timeMap([{ start: 1, end: 2 }], 5)).toThrow('The fast-forward spans do not fit: The fast-forward from 1.00 s needs a rate of at least 1');
});

test('Shortcuts and camera targets move to Final time, so the camera keeps its pace across a fast-forward', () => {
  const map = timeMap([{ start: 1, end: 9, rate: 4 }], 12);
  const [target] = retimed([{ t: 10, until: 10.5, box: small(240, 100) }], map, ['t', 'until']);
  expect(target.t).toBeCloseTo(10 - (9 - map.spans[0].end), 9);
  expect(target.until - target.t).toBeCloseTo(0.5, 9);
  expect(retimed([{ t: 0.5, keys: ['Meta', 'K'] }], map)).toEqual([{ t: 0.5, keys: ['Meta', 'K'] }]);
  // Around the moved action the camera moves exactly as it would around the same action without the fast-forward.
  const track = cameraTrack({ targets: [target], viewport, camera, duration: map.duration, fps: 60 });
  const plain = cameraTrack({ targets: [{ t: 10, until: 10.5, box: small(240, 100) }], viewport, camera, duration: 12, fps: 60 });
  for (const offset of [-0.6, -0.3, 0, 0.5, 1.5]) expect(zoomAt(track, target.t + offset)).toBeCloseTo(zoomAt(plain, 10 + offset), 1);
  expect(zoomAt(track, target.t)).toBeGreaterThan(1.85);
});

test('Lines move to Final time, and one spoken while the Final fast-forwards is named', () => {
  const map = timeMap([{ start: 2, end: 6, rate: 4 }], 10);
  const { lines, problems } = linesInFinal([{ id: 'before', start: 0.5, duration: 1.5 }, { id: 'after', start: 7, duration: 1 }], map);
  expect(problems).toEqual([]);
  expect(lines.map(line => line.start)).toEqual([0.5, expect.closeTo(7 - (6 - map.spans[0].end), 9)]);
  expect(linesInFinal([{ id: 'late', start: 1.5, duration: 1 }], map).problems).toEqual([
    expect.stringMatching(/^Line 'late' is spoken from 1\.50 s to 2\.50 s of the Final, while it fast-forwards from 2\.00 s to 3\.\d\d s; move the Line out of it or shorten the fast-forward$/),
  ]);
  expect(linesInFinal([{ id: 'inside', start: 4, duration: 0.1 }], map).problems).toHaveLength(1);
});

test('a fast-forward badge shows only while the Final fast-forwards, fading in and out with its span', () => {
  const map = timeMap([{ start: 2, end: 6, rate: 4 }], 10), [span] = map.spans;
  expect(badgeAt(map, 1.9)).toBeNull();
  expect(badgeAt(map, span.end)).toBeNull();
  expect(badgeAt(map, 2.075)).toEqual({ index: 0, rate: 4, opacity: expect.closeTo(0.5, 6) });
  expect(badgeAt(map, 2.5).opacity).toBe(1);
  expect(badgeAt(map, span.end - 0.1).opacity).toBeCloseTo(0.5, 6);
  expect(badgeAt(timeMap([], 10), 3)).toBeNull();
});

test('the fast-forward badge is off by default; Render reads the built-in with its parameters, and a Look keeps it', () => {
  expect(withDefaults({}).fastForwardBadge).toBe(false);
  const { edit } = forRender(withDefaults({ fastForwardBadge: { draw: 'fast-forward', y: 0.2 } }), tmpdir());
  expect(edit.fastForwardBadge).toMatchObject({ kind: 'draw', ref: 'fast-forward', x: 0.5, y: 0.2, fontSize: 44, url: expect.stringMatching(/^\/files\//) });
  const take = withDefaults({ fastForwardBadge: { draw: 'fast-forward' }, fastForward: [{ start: 1, end: 2, rate: 4 }] });
  expect(lookFromEdit(take).fastForwardBadge).toEqual({ draw: 'fast-forward' });
  expect(applyLook(withDefaults({}), lookFromEdit(take)).fastForwardBadge).toEqual({ draw: 'fast-forward' });
});

test('the first Edit fast-forwards the waits the Scenario marked, and a Look keeps them out', () => {
  const timeline = { events: [{ type: 'click', t: 1, x: 0, y: 0, box }, { type: 'fastForward', t: 1.5, end: 6, rate: 4 }] };
  const edit = createEdit(scenarioSchema.parse({ name: 'demo', url: 'https://example.com' }), timeline, []);
  expect(edit.fastForward).toEqual([{ start: 1.5, end: 6, rate: 4 }]);
  expect(withDefaults({}).fastForward).toEqual([]);
  expect(lookFromEdit(edit)).not.toHaveProperty('fastForward');
  expect(applyLook(edit, lookFromEdit(withDefaults({}))).fastForward).toEqual(edit.fastForward);
});

test('the cursor interpolates the pointer path and is hidden before the first sample', () => {
  const pointer = [[1, 0, 0], [2, 100, 50], [3, 100, 50]];
  expect(pointerAt(pointer, 0.5)).toBeNull();
  expect(pointerAt(pointer, 1.5)).toEqual({ x: 50, y: 25 });
  expect(pointerAt(pointer, 9)).toEqual({ x: 100, y: 50 });
});

test('a press shrinks the Cursor while the button is held and springs back after release', () => {
  const spans = heldSpans([{ type: 'click', t: 1, end: 1.1, x: 5, y: 6 }, { type: 'type', t: 2, end: 3 }, { type: 'drag', t: 4, end: 5, from: { x: 7, y: 8 }, to: { x: 9, y: 9 } }]);
  expect(spans).toEqual([{ t: 1, end: 1.1 }, { t: 4, end: 5 }]);
  const scale = t => pressScale(spans, 0.8, t);
  expect(scale(0.99)).toBe(1);
  expect(scale(1.02)).toBeLessThan(1);
  expect(scale(1.02)).toBeGreaterThan(0.8);
  expect(scale(1.1)).toBeCloseTo(0.8);
  // After release it springs back past full size for a moment, then rests at 1.
  const after = Array.from({ length: 30 }, (_, i) => scale(1.1 + i / 100));
  expect(Math.max(...after)).toBeGreaterThan(1);
  expect(Math.max(...after)).toBeLessThan(1.05);
  expect(scale(1.5)).toBe(1);
  // A drag stays pressed from grab to drop.
  for (const t of [4.2, 4.6, 5]) expect(scale(t)).toBeCloseTo(0.8);
  expect(scale(5.5)).toBe(1);
  expect(pressScale(spans, false, 1.1)).toBe(1);
  expect(pressScale([], 0.8, 1.1)).toBe(1);
});

test('the Cursor takes the shape the page asked for, its alias, or default', () => {
  const shapes = [[0, 'default'], [1, 'pointer'], [2, 'col-resize'], [3, 'zoom-in']];
  expect(shapeAt(shapes, 0.5)).toBe('default');
  expect(shapeAt(shapes, 1.5)).toBe('pointer');
  expect(shapeAt([], 1.5)).toBe('default');
  const arrow = new Set(['default', 'pointer', 'text', 'ew-resize', 'wait']), dot = new Set(['default']);
  expect(drawnShape(shapeAt(shapes, 1.5), arrow)).toBe('pointer');
  expect(drawnShape(shapeAt(shapes, 2.5), arrow)).toBe('ew-resize');
  expect(drawnShape('progress', arrow)).toBe('wait');
  expect(drawnShape(shapeAt(shapes, 3.5), arrow)).toBe('default');
  expect(drawnShape('pointer', dot)).toBe('default');
});

test('the Cursor track puts point, press and shape together, is hidden before the first sample and shown to the end', () => {
  const track = cursorTrack({ pointer: [[1, 10, 20], [2, 30, 40]], shapes: [[1.5, 'text']], events: [{ type: 'click', t: 2, end: 2.1 }] }, { press: 0.8 });
  expect(track.at(0.5)).toBeNull();
  expect(track.at(1)).toEqual({ x: 10, y: 20, scale: 1, shape: 'default' });
  expect(track.at(2.1)).toMatchObject({ x: 30, y: 40, scale: expect.closeTo(0.8, 6), shape: 'text' });
  expect(track.at(30)).toEqual({ x: 30, y: 40, scale: 1, shape: 'text' });
});

test('the default Edit shows clicks on the Cursor, without a click effect', () => {
  expect(DEFAULT_STYLE.clickEffect).toBe(false);
  expect(DEFAULT_STYLE.cursor).toEqual({ draw: 'arrow', size: 24, color: '#ffffff', press: 0.8 });
});

test('clicks and drag starts spark for the click effect duration', () => {
  const list = presses([{ type: 'click', t: 1, x: 5, y: 6 }, { type: 'type', t: 2, end: 3 }, { type: 'drag', t: 4, end: 5, from: { x: 7, y: 8 }, to: { x: 9, y: 9 } }]);
  expect(list).toEqual([{ t: 1, x: 5, y: 6 }, { t: 4, x: 7, y: 8 }]);
  const effect = { draw: 'spark', duration: 400 };
  expect(sparksAt(list, effect, 1.2)).toEqual([{ x: 5, y: 6, progress: expect.closeTo(0.5, 6) }]);
  expect(sparksAt(list, effect, 1.5)).toEqual([]);
  expect(sparksAt(list, false, 1.2)).toEqual([]);
});

test('a key shows outside a text field, or with Control, Alt or Meta inside one; typing, lone modifiers and repeats do not', () => {
  const down = (key, code, more = {}) => ({ key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false, field: false, ...more });
  expect(shortcutKeys(down('k', 'KeyK', { metaKey: true }))).toEqual(['Meta', 'K']);
  expect(shortcutKeys(down('r', 'KeyR'))).toEqual(['R']);
  expect(shortcutKeys(down('Escape', 'Escape'))).toEqual(['Escape']);
  expect(shortcutKeys(down(' ', 'Space'))).toEqual(['Space']);
  // Modifiers come in macOS order, and a letter is named by its key whatever the modifiers made of it.
  expect(shortcutKeys(down('Π', 'KeyP', { metaKey: true, shiftKey: true, altKey: true, ctrlKey: true }))).toEqual(['Control', 'Alt', 'Shift', 'Meta', 'P']);
  expect(shortcutKeys(down('!', 'Digit1', { shiftKey: true }))).toEqual(['Shift', '1']);
  // In a text field only Control, Alt or Meta make a key a Shortcut; Shift is typing a capital.
  expect(shortcutKeys(down('a', 'KeyA', { field: true }))).toBeNull();
  expect(shortcutKeys(down('A', 'KeyA', { field: true, shiftKey: true }))).toBeNull();
  expect(shortcutKeys(down('Enter', 'Enter', { field: true }))).toBeNull();
  expect(shortcutKeys(down('a', 'KeyA', { field: true, metaKey: true }))).toEqual(['Meta', 'A']);
  expect(shortcutKeys(down('z', 'KeyZ', { field: true, ctrlKey: true }))).toEqual(['Control', 'Z']);
  expect(shortcutKeys(down('Meta', 'MetaLeft', { metaKey: true }))).toBeNull();
  expect(shortcutKeys(down('Shift', 'ShiftLeft', { shiftKey: true }))).toBeNull();
  expect(shortcutKeys(down('k', 'KeyK', { metaKey: true, repeat: true }))).toBeNull();
  expect(shortcutKeys(down('Process', ''))).toBeNull();
});

test('keycaps show for their duration, count repeated presses, and a new Shortcut replaces the one showing', () => {
  const k = ['Meta', 'K'], z = ['Meta', 'Z'];
  expect(keycapShows([{ t: 1, keys: k }, { t: 4, keys: k }], 1.5).map(show => [show.t, show.end])).toEqual([[1, 2.5], [4, 5.5]]);
  const repeats = keycapShows([{ t: 1, keys: z }, { t: 1.4, keys: z }, { t: 1.8, keys: z }], 1.5);
  expect(repeats).toEqual([{ t: 1, end: 3.3, keys: z, presses: [1, 1.4, 1.8], replacing: false, replaced: false }]);
  const swapped = keycapShows([{ t: 1, keys: k }, { t: 1.5, keys: z }], 1.5);
  expect(swapped.map(({ t, end, replacing, replaced }) => ({ t, end, replacing, replaced }))).toEqual([
    { t: 1, end: 1.5, replacing: false, replaced: true }, { t: 1.5, end: 3, replacing: true, replaced: false },
  ]);

  const track = keycapTrack([{ t: 1, keys: z }, { t: 1.4, keys: z }, { t: 3, keys: k }, { t: 3.5, keys: ['Escape'] }], { duration: 1.5, singleKeys: true });
  expect(track.at(0.9)).toBeNull();
  // Easing in, it fades up and rises into place.
  expect(track.at(1.06)).toMatchObject({ index: 0, keys: z, count: 1, opacity: expect.closeTo(0.5, 6) });
  expect(track.at(1.06).rise).toBeGreaterThan(0);
  expect(track.at(1.2)).toEqual({ index: 0, keys: z, count: 1, opacity: 1, rise: 0 });
  expect(track.at(1.5)).toMatchObject({ count: 2, opacity: 1 });
  // It fades out over the end of its duration, from the last press.
  expect(track.at(2.775).opacity).toBeCloseTo(0.5);
  expect(track.at(2.95)).toBeNull();
  // A replacement appears at once, without fading the one before out.
  expect(track.at(3.49)).toMatchObject({ index: 1, opacity: 1 });
  expect(track.at(3.5)).toEqual({ index: 2, keys: ['Escape'], count: 1, opacity: 1, rise: 0 });
  expect(track.at(5.1)).toBeNull();
  expect(keycapTrack([{ t: 1, keys: k }], false).at(1.2)).toBeNull();
  expect(keycapTrack([{ t: 1, keys: k }], {}).at(2.4)).not.toBeNull();
});

test('keycaps leave out a key pressed alone unless singleKeys is set', () => {
  const shortcuts = [{ t: 1, keys: ['Meta', 'K'] }, { t: 3, keys: ['Escape'] }, { t: 5, keys: ['Shift', 'Tab'] }];
  expect(DEFAULT_STYLE.keycaps.singleKeys).toBe(false);
  const track = keycapTrack(shortcuts, DEFAULT_STYLE.keycaps);
  expect(track.shows.map(show => show.keys)).toEqual([['Meta', 'K'], ['Shift', 'Tab']]);
  expect(track.at(3.2)).toBeNull();
  expect(keycapTrack(shortcuts, { ...DEFAULT_STYLE.keycaps, singleKeys: true }).at(3.2)).toMatchObject({ keys: ['Escape'] });
});

test('the first Edit shows the Shortcuts the Timeline recorded, and a Look keeps the keycap styling but not them', () => {
  const timeline = { events: [{ type: 'click', t: 1, x: 0, y: 0, box }, { type: 'shortcut', t: 2, keys: ['Meta', 'K'] }, { type: 'type', t: 2, end: 2, box }] };
  const edit = createEdit(scenarioSchema.parse({ name: 'demo', url: 'https://example.com', keycaps: { symbols: false } }), timeline, []);
  expect(edit.shortcuts).toEqual([{ t: 2, keys: ['Meta', 'K'] }]);
  expect(edit.keycaps).toEqual({ draw: 'keycaps', duration: 1.5, singleKeys: false, symbols: false });
  expect(withDefaults({}).shortcuts).toEqual([]);
  const look = lookFromEdit(edit);
  expect(look).not.toHaveProperty('shortcuts');
  expect(look.keycaps).toEqual(edit.keycaps);
  expect(applyLook(edit, { keycaps: false })).toMatchObject({ keycaps: false, shortcuts: edit.shortcuts });
  const { edit: served } = forRender(edit, '/take');
  expect(served.keycaps).toMatchObject({ kind: 'draw', ref: 'keycaps', symbols: false, fontSize: 34, duration: 1.5, url: expect.stringMatching(/^\/files\//) });
});

/** A move sampled the way the Director plays it: one point per frame at 60 fps. */
function sampled(from, to, opts) {
  const path = reach(from, to, { rand: random(1), ...opts }), frames = Math.max(1, Math.round(path.duration * 60 / 1000));
  const points = Array.from({ length: frames + 1 }, (_, i) => path.at(i / frames));
  const speeds = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y) * 60);
  return { duration: path.duration, points, speeds, peak: Math.max(...speeds) };
}

test('moves take longer the farther and smaller the target, slower while dragging, scaled by speed', () => {
  expect(reachMs(0)).toBe(0);
  expect(reachMs(100, 40)).toBeLessThan(reachMs(400, 40));
  expect(reachMs(400, 40)).toBeLessThan(reachMs(400, 10));
  expect(reachMs(400, 40, { drag: true })).toBeGreaterThan(reachMs(400, 40));
  expect(reachMs(400, 40, { speed: 2 })).toBeCloseTo(reachMs(400, 40) / 2);
  for (const [distance, size] of [[60, 80], [300, 32], [1058, 32], [1600, 24]]) {
    const ms = reachMs(distance, size);
    expect(ms).toBeGreaterThan(250);
    expect(ms).toBeLessThan(1600);
  }
});

test('a move peaks at a human speed early, settles long into its target and arcs slightly', () => {
  const from = { x: 100, y: 800 }, to = { x: 1158, y: 800 };
  const move = sampled(from, to, { size: 32 });
  expect(move.peak).toBeLessThan(2000);
  expect(move.peak).toBeGreaterThan(1000);
  const peakAt = move.speeds.indexOf(move.peak) / move.speeds.length;
  expect(peakAt).toBeGreaterThan(0.2);
  expect(peakAt).toBeLessThan(0.45);
  expect(move.points.at(-1)).toEqual(to);
  const sideways = Math.max(...move.points.map(p => Math.abs(p.y - 800)));
  expect(sideways).toBeGreaterThan(10);
  expect(sideways).toBeLessThanOrEqual(80);
  const across = sampled({ x: 0, y: 0 }, { x: 1440, y: 900 }, { size: 24 });
  expect(across.peak).toBeLessThan(2000);
  expect(sampled(from, to, { size: 32, duration: 450 }).duration).toBe(450);
});

test('the same seed moves the same way; another seed moves differently', () => {
  const run = seed => { const rand = random(seed); return [reach({ x: 0, y: 0 }, { x: 500, y: 300 }, { rand }).at(0.5), landing({ x: 0, y: 0, width: 100, height: 40 }, rand), typingDelays('hello', 70, rand)]; };
  expect(run(1)).toEqual(run(1));
  expect(run(2)).not.toEqual(run(1));
});

test('a click lands a little off the center of its box, at most 8 px however large the box', () => {
  const rand = random(3), box = { x: 10, y: 20, width: 1000, height: 30 };
  const points = Array.from({ length: 200 }, () => landing(box, rand));
  for (const p of points) {
    expect(Math.abs(p.x - 510)).toBeLessThanOrEqual(8);
    expect(Math.abs(p.y - 35)).toBeLessThanOrEqual(4.5);
  }
  expect(points.some(p => p.x !== 510)).toBe(true);
});

test('a click holds the button about a tenth of a second, unevenly, scaled by speed', () => {
  const rand = random(5), holds = Array.from({ length: 100 }, () => pauseMs('press', 1, rand));
  expect(Math.min(...holds)).toBeGreaterThanOrEqual(75);
  expect(Math.max(...holds)).toBeLessThanOrEqual(125);
  expect(new Set(holds.map(Math.round)).size).toBeGreaterThan(10);
  expect(pauseMs('press', 2, random(5))).toBeCloseTo(pauseMs('press', 1, random(5)) / 2);
});

test('typing is uneven, pauses longer after a word, and keeps its average pace', () => {
  const text = 'ada lovelace wrote the first program', delays = typingDelays(text, 70, random(1));
  expect(delays).toHaveLength(text.length);
  expect(delays.reduce((sum, d) => sum + d, 0) / delays.length).toBeCloseTo(70);
  expect(new Set(delays.map(Math.round)).size).toBeGreaterThan(5);
  const mean = list => list.reduce((sum, d) => sum + d, 0) / list.length;
  const afterSpace = delays.filter((_, i) => text[i] === ' '), others = delays.filter((_, i) => text[i] !== ' ');
  expect(mean(afterSpace)).toBeGreaterThan(mean(others));
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
  expect(applyLook(edit, { cursor: { size: 40 } }).cursor).toEqual({ draw: 'arrow', size: 40, color: '#ffffff', press: 0.8 });
  expect(applyLook(edit, { cursor: { image: 'hand.png', hotspot: [4, 2] } }).cursor).toEqual({ image: 'hand.png', hotspot: [4, 2] });
  expect(edit.clickEffect).toBe(false);
  expect(applyLook(edit, { clickEffect: { draw: 'spark' } }).clickEffect).toEqual({ draw: 'spark' });
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
    expect(await npxFolders({ cache, packageDir })).toEqual([join(cache, '_npx', 'old'), join(other, '_npx', 'own')].sort());
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

test('subtitle rows break at sentence and clause ends, then between words, within the row width', () => {
  expect(subtitleRows('Open the editor. Then pick a color for the title, and press save.', 42))
    .toEqual(['Open the editor.', 'Then pick a color for the title,', 'and press save.']);
  expect(subtitleRows('Hi. This one is the longer sentence of the two.', 42)).toEqual(['Hi. This one is the longer', 'sentence of the two.']);
  expect(subtitleRows('先打开编辑器，然后给标题选一个颜色，再点击保存。', 16)).toEqual(['先打开编辑器，', '然后给标题选一个颜色，', '再点击保存。']);
  expect(subtitleRows('点击 Preview 按钮，就能看到效果。', 16)).toEqual(['点击 Preview 按钮，', '就能看到效果。']);
  for (const row of subtitleRows('A very long sentence that keeps going without any punctuation at all for quite a while', 42)) expect(row.length).toBeLessThanOrEqual(42);
});

const sentences = 'Open the editor from the dashboard menu. Then pick a color and press save.';
const wordsOf = (text, from, to) => { const list = text.split(' '), step = (to - from) / list.length; return list.map((word, i) => ({ text: word, start: from + i * step, end: from + (i + 1) * step })); };

test('cues share a Line by its spoken characters, or by its word timings when it has them', () => {
  const line = { id: 'intro', text: sentences, start: 2, duration: 4 };
  const even = subtitleCues([line]);
  expect(even.map(c => c.rows)).toEqual([['Open the editor from the dashboard menu.'], ['Then pick a color and press save.']]);
  expect(even[0]).toMatchObject({ id: 'intro', start: 2, end: expect.closeTo(2 + 4 * 33 / 59, 6) });
  expect(even[1].end).toBe(6);
  const words = [...wordsOf('Open the editor from the dashboard menu', 0.1, 1.5), ...wordsOf('Then pick a color and press save', 2, 3.2)];
  const timed = subtitleCues([{ ...line, words }]);
  expect(timed[0].start).toBeCloseTo(2.1, 6);
  expect(timed[0].end).toBeCloseTo(3.5, 6);
  expect(timed[1].start).toBeCloseTo(4, 6);
});

test('Chinese Lines break at about 16 characters and two rows make a cue', () => {
  const cues = subtitleCues([{ id: 'a', text: '先打开编辑器然后给标题选一个颜色再点击保存按钮就能看到效果', start: 0, duration: 6 }], { language: 'zh-CN' });
  expect(cues[0].rows).toHaveLength(2);
  for (const row of cues.flatMap(c => c.rows)) expect(Array.from(row).length).toBeLessThanOrEqual(16);
});

test('a short cue stays at least a second, taking time from the next cue or the silence after', () => {
  const words = [...wordsOf('Open the editor from the dashboard menu', 0, 0.5), ...wordsOf('Then pick a color and press save', 0.5, 3)];
  const [first, second] = subtitleCues([{ id: 'a', text: sentences, start: 0, duration: 3, words }]);
  expect(first.end).toBeCloseTo(1, 6);
  expect(second.start).toBeCloseTo(1, 6);
  const [alone] = subtitleCues([{ id: 'a', text: 'Hi.', start: 0, duration: 0.3 }, { id: 'b', text: 'Next.', start: 0.8, duration: 1 }]);
  expect(alone.end).toBe(0.8);
});

test('Lines that overlap, start early or run past the end are named with the seconds involved', () => {
  const lines = [{ id: 'b', start: 3, duration: 2 }, { id: 'a', start: 1, duration: 2.5 }, { id: 'c', start: 9, duration: 2 }];
  expect(lineProblems(lines, 10)).toEqual(["Line 'a' overlaps 'b' by 0.50 s", "Line 'c' runs 1.00 s past the end of the Final"]);
  expect(lineProblems([{ id: 'a', start: -0.2, duration: 1 }], 10)).toEqual(["Line 'a' starts 0.20 s before the Take"]);
  expect(lineProblems([{ id: 'a', start: 0, duration: 1 }, { id: 'b', start: 1, duration: 1 }], 2)).toEqual([]);
});

test('subtitle files time each cue to the millisecond', () => {
  const cues = [{ id: 'a', start: 1.5, end: 3.25, rows: ['Open the editor.'] }, { id: 'b', start: 3661.001, end: 3662, rows: ['Two', 'rows'] }];
  expect(toSrt(cues)).toBe('1\n00:00:01,500 --> 00:00:03,250\nOpen the editor.\n\n2\n01:01:01,001 --> 01:01:02,000\nTwo\nrows\n');
  expect(toVtt(cues)).toBe('WEBVTT\n\n00:00:01.500 --> 00:00:03.250\nOpen the editor.\n\n01:01:01.001 --> 01:01:02.000\nTwo\nrows\n');
});

test('the first Edit starts each Line where the Scenario said it; a Look keeps Subtitle styling but no Lines', () => {
  const timeline = { events: [{ type: 'say', t: 0.5, id: 'intro' }, { type: 'click', t: 1, x: 0, y: 0, box }, { type: 'say', t: 2.25, id: 'save', text: 'Save it.' }] };
  const edit = createEdit(scenarioSchema.parse({ name: 'demo', url: 'https://example.com', subtitles: { fontSize: 48 } }), timeline, []);
  expect(edit.narration).toEqual({ volume: 1, lines: [{ id: 'intro', start: 0.5 }, { id: 'save', start: 2.25 }] });
  expect(edit.camera.targets.map(target => target.t)).toEqual([1]);
  expect(edit.subtitles).toEqual({ draw: 'subtitles', burn: true, fontSize: 48 });
  const look = lookFromEdit(edit);
  expect(look).not.toHaveProperty('narration');
  expect(look.subtitles).toEqual(edit.subtitles);
  expect(applyLook(edit, { subtitles: { burn: false } })).toMatchObject({ narration: edit.narration, subtitles: { draw: 'subtitles', burn: false, fontSize: 48 } });
  expect(withDefaults({}).narration).toEqual({ volume: 1, lines: [] });
});

test('a Narration file needs unique Line ids, text and audio, and its stated durations are ignored', () => {
  const line = { id: 'intro', text: 'Hello.', audio: 'intro.wav' };
  expect(narrationSchema.parse({ language: 'zh-CN', lines: [{ ...line, duration: 9 }] }).lines[0]).toEqual(line);
  expect(narrationSchema.safeParse({ language: 'en', lines: [line, line] }).success).toBe(false);
  expect(narrationSchema.safeParse({ language: 'en', lines: [{ ...line, id: '../x' }] }).success).toBe(false);
  expect(narrationSchema.safeParse({ language: 'en', lines: [{ ...line, audio: '' }] }).success).toBe(false);
});

test('Render and Looks read the built-in Subtitles with their parameters, and bundle a font they name', async () => {
  const dir = await tmp('cuetake-subtitles-');
  try {
    await fs.writeFile(join(dir, 'brand.woff2'), 'font');
    const { edit } = forRender(withDefaults({ subtitles: { fontSize: 50, files: { font: 'brand.woff2' } } }), dir);
    expect(edit.subtitles).toMatchObject({ kind: 'draw', ref: 'subtitles', fontSize: 50, band: '#000000b3', url: expect.stringMatching(/^\/files\//) });
    expect(edit.subtitles.files.font).toMatch(/^\/files\/style-\d+\.woff2$/);
    const take = join(dir, 'take');
    expect((await bundle({ subtitles: { draw: 'subtitles', files: { font: 'brand.woff2' } } }, dir, join(take, 'styles'), 'styles/')).subtitles.files.font).toBe('styles/brand.woff2');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
