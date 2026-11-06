import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import pkg from '../package.json' with { type: 'json' };
import { scenarioSchema, summarizeFrames, captureWarnings, timelineWarnings, captureScale, narrationSchema, timelineOf, desktopTimelineOf } from '../src/pipeline.js';
import { placeRecords } from '../src/probe.js';
import { captureSeconds } from '../src/tab-capture.js';
import { drawsWithGpu } from '../src/environment.js';
import { fitZoom, cropAround, zoomSegments, cameraTrack } from '../src/camera.js';
import { cameraTargets, createEdit, DEFAULT_STYLE, withDefaults, addressBar, addressOf, merge } from '../src/edit.js';
import { pointerAt, presses, sparksAt, heldSpans, pressScale, shapeAt, drawnShape, cursorTrack } from '../src/cursor.js';
import { random, reachMs, reach, landing, pauseMs, typingDelays } from '../src/motion.js';
import { atShortSide, layout, cameraView, brandHue, brandColor, previewSheet } from '../src/stage.js';
import { exposure, moments, cropAt, shutterOf } from '../src/shutter.js';
import { lookFromEdit, applyLook, mergeLook, summarize, saveLook, loadLook, listLooks, removeLook, resolvedLook } from '../src/look.js';
import { bundle, codeRefs, forRender, BUILTIN_DIR } from '../src/styles.js';
import { npxFolders, uninstall } from '../src/uninstall.js';
import { subtitleRows, subtitleCues, lineProblems, toSrt, toVtt } from '../src/narration.js';
import { shortcutKeys, keycapShows, keycapTrack } from '../src/shortcuts.js';
import { timeMap, fastForwardProblems, retimed, linesInFinal, badgeAt } from '../src/time-map.js';
import { windowMaps, tabTrack, inWindow, carried, seenBy } from '../src/tabs.js';
import { maskTrack, maskProblems, maskWarnings, mergedPast } from '../src/masks.js';
import { windowsAt, drawnWindows, desktopWarnings } from '../src/desktop.js';
import { createAppDirector } from '../src/app-director.js';
import { macKeys } from '../src/mac-keys.js';
import { treeLines } from '../src/app-locators.js';
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
  // A navigation noted before the start, such as a popup's first, counts back from it; one still loading at the stop ends there.
  expect(counted.navigations).toEqual([
    { t: -1, end: -0.5, url: 'https://cuetake.test/before' }, { t: 0.8, end: 1.65, commit: 1.1, url: 'https://cuetake.test/next' }, { t: 2.9, end: 3.3, url: 'https://cuetake.test/slow' },
  ]);
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
  expect(addressBar(config, timeline)).toEqual({ url: 'localhost:3000', urls: [{ t: 3.2, url: 'checkout.stripe.test', tab: 0 }, { t: 6.5, url: 'localhost:3000', tab: 0 }] });
  // A url the Scenario names stands for the host Capture started on, also when the page comes back to it.
  const named = scenarioSchema.parse({ name: 'demo', url: 'http://localhost:3000/login', frame: { url: 'app.acme.com' } });
  expect(addressBar(named, timeline)).toEqual({ url: 'app.acme.com', urls: [{ t: 3.2, url: 'checkout.stripe.test', tab: 0 }, { t: 6.5, url: 'app.acme.com', tab: 0 }] });
  // Without the start address, a Take of an older version starts from the Scenario's url.
  expect(addressBar(config, { events: [] })).toEqual({ url: 'localhost:3000', urls: [] });
  expect(addressOf('about:blank')).toBe('about:blank');
  const edit = createEdit(config, timeline, []);
  expect(edit.frame).toMatchObject({ url: 'localhost:3000', urls: [{ t: 3.2 }, { t: 6.5 }], chrome: { draw: 'browser' } });
  // The changes belong to the Take: a Look leaves them out, and applying one keeps them.
  expect(lookFromEdit(edit).frame).not.toHaveProperty('urls');
  expect(applyLook(edit, lookFromEdit(withDefaults({})), 'localhost:3000').frame.urls).toEqual(edit.frame.urls);
});

test('each Tab\'s address bar shows its own host, and stays empty until a new Tab\'s first document commits', () => {
  const config = scenarioSchema.parse({ name: 'demo', url: 'http://localhost:3000/', frame: { url: 'app.acme.com' } });
  const timeline = {
    url: 'http://localhost:3000/', viewport: { width: 1440, height: 900 },
    tabs: [
      { id: 0, opener: null, opened: 0, url: 'http://localhost:3000/' },
      { id: 1, opener: 0, opened: 2, url: 'https://accounts.example.test/oauth' },
      { id: 2, opener: 0, opened: 5, url: 'about:blank' },
      { id: 3, opener: 0, opened: 6, url: 'http://localhost:3000/help' },
    ],
    events: [
      { type: 'navigate', t: 2.8, end: 3.2, commit: 3, url: 'https://accounts.example.test/consent', tab: 1 },
      { type: 'navigate', t: 5.2, end: 5.6, commit: 5.4, url: 'https://pay.example.test/x', tab: 2 },
      { type: 'navigate', t: 6.2, end: 6.6, commit: 6.4, url: 'http://localhost:3000/done', tab: 0 },
    ],
  };
  expect(addressBar(config, timeline)).toEqual({ url: 'app.acme.com', urls: [
    { t: 2, url: 'accounts.example.test', tab: 1 },
    { t: 5.4, url: 'pay.example.test', tab: 2 },
    { t: 6, url: 'app.acme.com', tab: 3 },
  ] });
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
  // In a Take with several Tabs, each is judged over its own seconds and named.
  const [inTab] = captureWarnings({ duration: 3, pageFrames: [9, 8, 7] }, 2, { id: 2, opened: 4.25 });
  expect(inTab).toStartWith('In Tab 2, opened at 4.25 s, the browser fell behind');
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

test('the camera frames a popup as it opens and follows input in its Tab; Tabs switch with a cut by default', () => {
  const timeline = { viewport: { width: 1440, height: 900 },
    tabs: [{ id: 0, opener: null, viewport: { width: 1440, height: 900 } }, { id: 1, opener: 0, viewport: { width: 1440, height: 900 } }, { id: 2, opener: 0, viewport: { width: 500, height: 600 } }],
    events: [
      { type: 'front', t: 1, tab: 1 }, { type: 'click', t: 1.5, x: 2, y: 3, box, tab: 1 }, { type: 'front', t: 2, tab: 0 },
      { type: 'front', t: 3, tab: 2 }, { type: 'type', t: 4, end: 5, box, tab: 2 }, { type: 'front', t: 6, tab: 0 },
      { type: 'front', t: 7, tab: 2 },
    ] };
  expect(cameraTargets(timeline, [{ t: 9, box, tab: 0 }])).toEqual([
    { t: 1.5, box, tab: 1 }, { t: 3, box: { x: 0, y: 0, width: 500, height: 600 }, tab: 2 }, { t: 4, box, until: 5, tab: 2 }, { t: 9, box, tab: 0 },
  ]);
  const edit = createEdit(scenarioSchema.parse({ name: 'demo', url: 'https://example.com' }), timeline, []);
  expect(edit.tabs).toEqual({ transition: 'cut', popupAnimation: { duration: 0.2, scale: 0.9 }, placement: [] });
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

const main = { width: 1440, height: 900 };
const tab = (id, opener, width, height, more = {}) => ({ id, opener, opened: id, closed: null, viewport: { width, height }, start: id, ...more });

test('a popup window sits centered over its opener\'s page, scaled down only when it does not fit', () => {
  const tabs = [tab(0, null, 1440, 900), tab(1, 0, 1440, 900), tab(2, 0, 500, 600), tab(3, 0, 800, 1200), tab(4, 2, 200, 100)];
  const maps = windowMaps(tabs, main);
  // A Tab the size of the viewport is a tab of the same window.
  expect(maps.get(0)).toEqual({ x: 0, y: 0, scale: 1 });
  expect(maps.get(1)).toEqual({ x: 0, y: 0, scale: 1 });
  expect(maps.get(2)).toEqual({ x: 470, y: 150, scale: 1 });
  // Too tall for the opener's page: scaled to its height, then centered.
  expect(maps.get(3)).toEqual({ x: 420, y: 0, scale: 0.75 });
  // A popup a popup opened sits over that popup.
  expect(maps.get(4)).toEqual({ x: 620, y: 400, scale: 1 });
  // The Edit places a popup in its opener's CSS pixels; the popups it opened move with it.
  const placed = windowMaps(tabs, main, [{ tab: 2, x: 100, y: 50 }, { tab: 3, x: 10, y: 20 }]);
  expect(placed.get(2)).toEqual({ x: 100, y: 50, scale: 1 });
  expect(placed.get(3)).toEqual({ x: 10, y: 20, scale: 0.75 });
  expect(placed.get(4)).toEqual({ x: 250, y: 300, scale: 1 });
  // Inside a scaled popup, a nested one scales with it.
  const nested = windowMaps([tab(0, null, 1440, 900), tab(1, 0, 800, 1200), tab(2, 1, 400, 200)], main);
  expect(nested.get(2)).toEqual({ x: 570, y: 375, scale: 0.75 });
});

test('the Timeline joins each Tab\'s input with the path the Director wrote where no Tab saw the pointer, and notes which Tab is in front', () => {
  const startedAtMs = 50_000, popup = { width: 500, height: 600 };
  // Tab 1 closed before it could record, so the Tabs recorded are 0 and 2.
  const stopped = { durationSeconds: 5, fronts: [{ t: 2, tab: 2 }, { t: 4, tab: 0 }], tabs: [
    { id: 0, opener: null, opened: 0, closed: null, viewport: main, url: 'https://app.test/', start: 0, navigations: [] },
    { id: 2, opener: 0, opened: 2, closed: 4, viewport: popup, url: 'about:blank', start: 2.1, navigations: [{ t: 2.05, end: 2.4, commit: 2.2, url: 'https://pay.test/' }] },
  ] };
  const observed = new Map([
    [0, { pointer: [[1, 720, 100]], shapes: [[0, 'default']], events: [{ type: 'click', t: 1, x: 720, y: 100 }], turned: [], unplaced: [] }],
    [2, { pointer: [[3, 40, 50]], shapes: [[3, 'pointer']], events: [{ type: 'click', t: 3, x: 40, y: 50 }], turned: [], unplaced: [] }],
  ]);
  const notes = { focus: [{ t: 3.5, box, tab: 2 }], wide: [], said: [], forwarded: [], pointer: [[startedAtMs + 2500, 250, -50, 2]] };
  const timeline = timelineOf({ url: 'https://app.test/', viewport: main, scale: 2 }, stopped, observed, notes, startedAtMs);
  expect(timeline.tabs.map(t => t.id)).toEqual([0, 2]);
  expect(timeline.tabs[1]).toEqual({ id: 2, opener: 0, opened: 2, closed: 4, viewport: popup, url: 'about:blank', start: 2.1 });
  expect(timeline.pointer).toEqual([[1, 720, 100, 0], [2.5, 250, -50, 2], [3, 40, 50, 2]]);
  expect(timeline.shapes).toEqual([[0, 'default'], [3, 'pointer']]);
  expect(timeline.events.map(({ type, t, tab }) => [type, t, tab])).toEqual([
    ['click', 1, 0], ['front', 2, 2], ['navigate', 2.05, 2], ['click', 3, 2], ['focus', 3.5, 2], ['front', 4, 0],
  ]);
  // Over the window, the written path comes down into the popup from above it.
  const placed = inWindow(timeline, [], windowMaps(timeline.tabs, main));
  expect(placed.pointer.slice(1)).toEqual([[2.5, 720, 100], [3, 510, 200]]);
});

test('Render shows the Tab in front: a tab of the window replaces the page, a popup sits over its opener and animates', () => {
  const tabs = [tab(0, null, 1440, 900), tab(1, 0, 1440, 900, { opened: 2 }), tab(2, 0, 500, 600, { opened: 5, closed: 7 })];
  const events = [{ type: 'click', t: 1, tab: 0 }, { type: 'front', t: 2, tab: 1 }, { type: 'front', t: 4, tab: 0 }, { type: 'front', t: 5, tab: 2 }, { type: 'front', t: 7, tab: 0 }];
  const style = { transition: 'cut', popupAnimation: { duration: 0.2, scale: 0.9 } };
  const track = tabTrack({ tabs, events, viewport: main }, style, timeMap([], 9));
  const shown = t => track.at(t).map(({ tab, opacity, scale }) => [tab, +opacity.toFixed(3), +scale.toFixed(3)]);
  expect(shown(1)).toEqual([[0, 1, 1]]);
  expect(shown(2)).toEqual([[1, 1, 1]]);
  expect(shown(4.5)).toEqual([[0, 1, 1]]);
  // The popup scales and fades in over its opener, which keeps playing behind it, and out as it closes.
  expect(shown(5.1)).toEqual([[0, 1, 1], [2, 0.5, 0.95]]);
  expect(shown(6)).toEqual([[0, 1, 1], [2, 1, 1]]);
  expect(shown(7.1)).toEqual([[0, 1, 1], [2, 0.5, 0.95]]);
  expect(shown(7.3)).toEqual([[0, 1, 1]]);
  expect(track.at(6)[1]).toMatchObject({ popup: true });
  // The camera cuts to wide where the window shows another tab.
  expect(track.cuts).toEqual([2, 4]);
  // A fade lays the next tab over the last; without a popup animation a popup simply appears.
  const faded = tabTrack({ tabs, events, viewport: main }, { transition: { fade: 0.2 }, popupAnimation: false }, timeMap([], 9));
  expect(faded.at(2.1).map(({ tab, opacity }) => [tab, +opacity.toFixed(3)])).toEqual([[0, 1], [1, 0.5]]);
  expect(faded.at(5).map(({ tab, opacity, scale }) => [tab, opacity, scale])).toEqual([[0, 1, 1], [2, 1, 1]]);
  expect(faded.at(7).map(({ tab }) => tab)).toEqual([0]);
  // Switches happen in Source time; their transitions keep their pace in Final time.
  const forwarded = tabTrack({ tabs, events, viewport: main }, style, timeMap([{ start: 2.5, end: 4.5, rate: 4 }], 9));
  expect(forwarded.cuts[1]).toBeLessThan(3.5);
  expect(forwarded.at(forwarded.cuts[1] + 0.05).map(({ tab }) => tab)).toEqual([0]);
});

test('input in each Tab is placed in the window\'s CSS pixels, through where its popup sits', () => {
  const maps = windowMaps([tab(0, null, 1440, 900), tab(1, 0, 1440, 900), tab(2, 0, 800, 1200)], main, [{ tab: 2, x: 100, y: 0 }]);
  const timeline = {
    pointer: [[1, 10, 20, 0], [2, 10, 20, 1], [3, 0, 100, 2], [4, 400, 400, 2]],
    events: [
      { type: 'click', t: 1, x: 10, y: 20, box: { x: 0, y: 0, width: 40, height: 40 }, tab: 1 },
      { type: 'drag', t: 3, end: 4, from: { x: 0, y: 100 }, to: { x: 400, y: 400 }, tab: 2 },
      { type: 'type', t: 5, end: 6, box: { x: 40, y: 40, width: 400, height: 40 }, tab: 2 },
      { type: 'shortcut', t: 7, keys: ['Meta', 'K'], tab: 2 },
    ],
  };
  const targets = [{ t: 3, box: { x: 0, y: 0, width: 800, height: 1200 }, tab: 2 }, { t: 8, box: { x: 1, y: 2, width: 3, height: 4 } }];
  const placed = inWindow(timeline, targets, maps);
  expect(placed.pointer).toEqual([[1, 10, 20], [2, 10, 20], [3, 100, 75], [4, 400, 300]]);
  expect(placed.events[0]).toMatchObject({ x: 10, y: 20, box: { x: 0, y: 0, width: 40, height: 40 } });
  expect(placed.events[1]).toMatchObject({ from: { x: 100, y: 75 }, to: { x: 400, y: 300 } });
  expect(placed.events[2].box).toEqual({ x: 130, y: 30, width: 300, height: 30 });
  expect(placed.events[3]).toEqual(timeline.events[3]);
  // A popup framed whole, and a target with no Tab, which is the first one's.
  expect(placed.targets).toEqual([{ t: 3, box: { x: 100, y: 0, width: 600, height: 900 }, tab: 2 }, targets[1]]);
});

test('the Director carries its cursor between Tabs, and writes the part of its path the Tab in front cannot see', () => {
  const tabs = [tab(0, null, 1440, 900), tab(1, 0, 1440, 900), tab(2, 0, 500, 600)];
  const maps = windowMaps(tabs, main);
  // Into a tab of the same window it stays where it was; into a popup, it is where the popup sits over it.
  expect(carried({ x: 300, y: 200 }, 0, 1, maps)).toEqual({ x: 300, y: 200 });
  expect(carried({ x: 300, y: 200 }, 0, 2, maps)).toEqual({ x: -170, y: 50 });
  expect(carried({ x: 10, y: 10 }, 2, 0, maps)).toEqual({ x: 480, y: 160 });
  // A popup sees the pointer only over its page; the Director writes the rest of a glide into it itself.
  const glide = [[-170, 50], [-60, 80], [0, 100], [120, 150], [499.5, 599.5], [500, 300]];
  expect(glide.map(([x, y]) => seenBy({ x, y }, tabs[2].viewport))).toEqual([false, false, true, true, true, false]);
});

test('the camera cuts to wide where the window shows another tab, then follows the next action as usual', () => {
  const targets = [{ t: 2, box: small(240, 100) }, { t: 3, box: small(40, 100) }];
  const track = cameraTrack({ targets, viewport, camera, duration: 8, fps: 60, cuts: [2.5] });
  expect(zoomAt(track, 2.4)).toBeGreaterThan(1.9);
  expect(zoomAt(track, 2.5)).toBe(1);
  // The next action's zoom starts at the cut, not `lead` before its action, and eases in.
  expect(zoomAt(track, 2.55)).toBeLessThan(1.05);
  expect(zoomAt(track, 3.6)).toBeGreaterThan(1.9);
  expect(centerAt(track, 3.6).x).toBeLessThan(100);
  expect(zoomSegments(targets, viewport, camera, 8, [2.5]).map(s => [s.start, s.end])).toEqual([[1.4, 2.5], [2.5, 4.5]]);
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

test('a frame exposes the last `shutter` of its time, and shows one sharp instant on the first frame, with no shutter, or across a cut', () => {
  const half = exposure(1, 30, 0.5);
  expect(half.start).toBeCloseTo(0.98333, 5);
  expect(half.end).toBe(1);
  expect(exposure(0, 30, 0.5)).toBeNull();
  expect(exposure(1, 30, 0)).toBeNull();
  // A cut since the frame before jumps the camera, so nothing is blurred across it.
  expect(exposure(1, 30, 0.5, [0.99])).toBeNull();
  expect(exposure(1, 30, 0.5, [1])).toBeNull();
  expect(exposure(1, 30, 0.5, [0.95, 1.2])).not.toBeNull();
  // A shutter past a whole frame exposes the whole frame; anything that is not a positive number is off.
  expect(exposure(1, 30, 3).start).toBeCloseTo(0.96667, 5);
  expect([3, 0.25, -1, '0.5', undefined].map(shutterOf)).toEqual([1, 0.25, 0, 0, 0]);
});

test('a frame averages one moment per `step` output pixels its content moves, up to 16, ending on its own moment', () => {
  const span = { start: 0.98, end: 1 };
  expect(moments(1, null, 50, 2)).toEqual([1]);
  // Moving less than a step stays one sharp instant.
  expect(moments(1, span, 1.5, 2)).toEqual([1]);
  const four = moments(1, span, 6, 2);
  expect(four).toHaveLength(4);
  [0.98, 0.986667, 0.993333, 1].forEach((t, i) => expect(four[i]).toBeCloseTo(t, 5));
  const fast = moments(1, span, 400, 2);
  expect(fast).toHaveLength(16);
  expect(fast[0]).toBeCloseTo(0.98, 9);
  expect(fast.at(-1)).toBe(1);
});

test('between two frames the camera is part way from one frame\'s crop to the next', () => {
  const crops = [{ x: 0, y: 0, w: 100, h: 50 }, { x: 10, y: 20, w: 80, h: 40 }];
  expect(cropAt(crops, 30, 0)).toEqual(crops[0]);
  expect(cropAt(crops, 30, 1 / 30)).toEqual(crops[1]);
  const between = cropAt(crops, 30, 0.25 / 30);
  [['x', 2.5], ['y', 5], ['w', 95], ['h', 47.5]].forEach(([key, value]) => expect(between[key]).toBeCloseTo(value, 9));
  expect(cropAt(crops, 30, 2)).toEqual(crops[1]);
});

test('the Final blurs motion over half a frame by default; an Edit or Look can change or turn off the shutter', () => {
  expect(withDefaults({}).output.shutter).toBe(0.5);
  expect(withDefaults({ output: { shutter: 0 } }).output).toMatchObject({ shutter: 0, width: 3840, fps: 60 });
  expect(lookFromEdit(withDefaults({ output: { shutter: 0.25 } })).output.shutter).toBe(0.25);
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

test('a Look carries how Tabs switch and popups animate, but not where this Take\'s popups sit', () => {
  const edit = merge(takeEdit(), { tabs: { transition: { fade: 0.3 }, placement: [{ tab: 2, x: 10, y: 20 }] } });
  expect(lookFromEdit(edit).tabs).toEqual({ transition: { fade: 0.3 }, popupAnimation: { duration: 0.2, scale: 0.9 } });
  const next = applyLook(edit, { tabs: { popupAnimation: false, placement: [] } }, 'app.example.com');
  expect(next.tabs).toEqual({ transition: { fade: 0.3 }, popupAnimation: false, placement: [{ tab: 2, x: 10, y: 20 }] });
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

test('a fixed mask covers its box, padded, only during its span', () => {
  const masks = [{ effect: 'cover', box: { x: 100, y: 50, width: 200, height: 40 }, start: 1, end: 3 }];
  const track = maskTrack(masks, [], timeMap([], 5));
  expect(track.at(0.5)).toEqual([]);
  expect(track.at(1)).toEqual([{ index: 0, tab: 0, effect: 'cover', opacity: 1, rects: [{ x: 96, y: 46, width: 208, height: 48 }], color: '#000000', padding: 4, radius: 6 }]);
  expect(track.at(2.99)).toHaveLength(1);
  expect(track.at(3)).toEqual([]);
});

test('a mask on an element follows the boxes Capture recorded, and covers where it just was or is about to be', () => {
  // The element scrolls up between 0.5 s and 2 s, and is hidden from 1.5 s to 2 s.
  const elements = [{ id: 0, tab: 1, name: "getByTestId('email')", boxes: [[0.5, [10, 100, 50, 20]], [1, [10, 60, 50, 20]], [1.5], [2, [10, 20, 50, 20]]] }];
  const at = (masks, t) => maskTrack(masks, elements, timeMap([], 3)).at(t).map(mask => [mask.tab, mask.rects.map(r => r.y)]);
  const cover = [{ effect: 'cover', element: 0, padding: 0 }];
  // Before the first box it holds that box, so a mask made first thing covers the Take from its first frame.
  expect(at(cover, 0.2)).toEqual([[1, [100]]]);
  expect(at(cover, 0.7)).toEqual([[1, [100]]]);
  // Around a move both boxes are covered: for a while after it, since the Source shows a change later than
  // the page made it, and before it, since Capture may see a replaced element a little late.
  expect(at(cover, 0.91)).toEqual([[1, [100, 60]]]);
  expect(at(cover, 1.15)).toEqual([[1, [100, 60]]]);
  expect(at(cover, 1.25)).toEqual([[1, [60]]]);
  expect(at(cover, 1.6)).toEqual([[1, [60]]]);
  // Hidden, nothing is drawn, until shortly before it shows again.
  expect(at(cover, 1.72)).toEqual([]);
  expect(at(cover, 1.8)).toEqual([[1, [20]]]);
  expect(at(cover, 2.5)).toEqual([[1, [20]]]);
  // A spotlight shows exactly where the element is.
  expect(at([{ effect: 'spotlight', element: 0, padding: 0, ease: 0 }], 0.97)).toEqual([[1, [100]]]);
});

test('a spotlight eases in and out over Final seconds, while a blur or cover shows fully from its first frame', () => {
  const box = { x: 0, y: 0, width: 10, height: 10 };
  const opacity = (masks, map, t) => maskTrack(masks, [], map).at(t).map(mask => +mask.opacity.toFixed(3));
  const spotlight = [{ effect: 'spotlight', box, start: 1, end: 3, ease: 0.4 }];
  expect([0.9, 1, 1.2, 2, 2.8, 3].map(t => opacity(spotlight, timeMap([], 5), t))).toEqual([[], [0], [0.5], [1], [0.5], []]);
  // The ease keeps its pace in the Final, though the span ends in a fast-forward.
  const map = timeMap([{ start: 2, end: 6, rate: 4 }], 8), end = map.outputAt(6);
  expect(opacity([{ ...spotlight[0], end: 6 }], map, end - 0.2)).toEqual([0.5]);
  expect(opacity([{ effect: 'blur', box, start: 1, end: 3 }], timeMap([], 5), 1)).toEqual([1]);
  // One never ended eases out before the Final ends.
  expect(opacity([{ effect: 'spotlight', box, start: 1, ease: 0.4 }], timeMap([], 5), 4.8)).toEqual([0.5]);
});

test('masks Render cannot draw safely are named: unknown effects, missing boxes or elements, empty spans and blurs too weak to hide text', () => {
  const box = { x: 0, y: 0, width: 10, height: 10 }, elements = [{ id: 0, tab: 0, boxes: [] }];
  expect(maskProblems([{ effect: 'blur', element: 0 }, { effect: 'spotlight', box, start: 1, end: 2 }, { effect: 'cover', box, tab: 1, color: '#18181b' }], elements, [0, 1])).toEqual([]);
  expect(maskProblems([
    { effect: 'pixelate', box },
    { effect: 'cover' },
    { effect: 'cover', box: { x: 0, y: 0, width: 0, height: 10 } },
    { effect: 'blur', element: 3, start: 2 },
    { effect: 'cover', box, start: 3, end: 3 },
    { effect: 'blur', box, blur: 4 },
    { effect: 'cover', box, tab: 5 },
    { effect: 'cover', box, element: 0 },
    { effect: 'cover', box, color: '#f00' },
  ], elements, [0, 1])).toEqual([
    "Mask 0 has effect 'pixelate'; use blur, cover or spotlight",
    'Mask 1 (cover) needs a box { x, y, width, height } in CSS pixels, or the element a Scenario masked',
    'Mask 2 (cover) needs a box { x, y, width, height } in CSS pixels, or the element a Scenario masked',
    'Mask 3 (blur from 2.00 s) follows element 3, which the Timeline does not record',
    'Mask 4 (cover from 3.00 s) needs a start before its end, in seconds',
    'Mask 5 (blur) blurs 4 CSS px, too little to hide text; use at least 8',
    'Mask 6 (cover) is on Tab 5, which the Take does not show; its Tabs are 0, 1',
    'Mask 7 (cover) names both a box and an element; keep one',
    "Mask 8 (cover) has color '#f00'; use '#rrggbb'",
  ]);
  expect(maskProblems({ effect: 'blur' }, elements)).toEqual(['masks must be a list of masks']);
});

test('the Timeline keeps the boxes of each element the Scenario masked, and the first Edit masks it for the span, which a Look leaves out', () => {
  const stopped = { durationSeconds: 5, fronts: [], tabs: [{ id: 0, opener: null, opened: 0, closed: null, viewport: main, url: 'https://app.test/', start: 0, navigations: [] }] };
  const boxes = [[0, [10, 100, 50, 20]], [1.2, [10, 60, 50, 20]]];
  const observed = new Map([[0, { pointer: [], shapes: [], events: [], turned: [], unplaced: [], watched: [{ id: 0, boxes }] }]]);
  const notes = {
    focus: [], wide: [], said: [], forwarded: [], pointer: [],
    elements: [{ id: 0, tab: 0, name: "getByTestId('email')" }, { id: 1, tab: 0, name: "getByRole('button', { name: 'Pay' })" }],
    masks: [{ t: 0, end: null, element: 0, effect: 'blur' }, { t: 2, end: 4, element: 1, effect: 'spotlight', dim: 0.7 }],
  };
  const timeline = timelineOf({ url: 'https://app.test/', viewport: main, scale: 2 }, stopped, observed, notes, 50_000);
  // An element the probe never saw has no boxes, and its mask draws nothing.
  expect(timeline.elements).toEqual([{ id: 0, tab: 0, name: "getByTestId('email')", boxes }, { id: 1, tab: 0, name: "getByRole('button', { name: 'Pay' })", boxes: [] }]);
  expect(timeline.events.map(({ type, t }) => [type, t])).toEqual([['mask', 0], ['mask', 2]]);
  const edit = createEdit(scenarioSchema.parse({ name: 'demo', url: 'https://app.test/' }), timeline, []);
  // A mask the Scenario never ended lasts to the end of the Take.
  expect(edit.masks).toEqual([{ effect: 'blur', element: 0, start: 0 }, { effect: 'spotlight', element: 1, start: 2, end: 4, dim: 0.7 }]);
  expect(withDefaults({}).masks).toEqual([]);
  expect(lookFromEdit(edit)).not.toHaveProperty('masks');
  expect(applyLook(edit, lookFromEdit(withDefaults({}))).masks).toEqual(edit.masks);
  // A Timeline without masked elements stays as it was.
  expect(timelineOf({ url: 'https://app.test/', viewport: main, scale: 2 }, stopped, observed, { ...notes, elements: [], masks: [] }, 50_000)).not.toHaveProperty('elements');
});

test('places the boxes of a masked element in top-level CSS pixels, moving them when an iframe holding it moves', () => {
  const records = [
    { kind: 'top', frame: 0 },
    { kind: 'link', frame: 1, parent: 0, element: 0 },
    { kind: 'frames', frame: 0, ms: 100, rects: [{ id: 0, x: 50, y: 200, sx: 0.5, sy: 0.5, turned: false }] },
    // The page scrolls 40 px at 300 ms, carrying the iframe and the element in it up, though the element's own box stays.
    { kind: 'frames', frame: 0, ms: 300, rects: [{ id: 0, x: 50, y: 160, sx: 0.5, sy: 0.5, turned: false }] },
    { kind: 'box', frame: 1, ms: 150, watch: 0, boxes: [{ x: 20, y: 20, width: 40, height: 10 }] },
    // Element 1 is on the top page and stops showing at 400 ms.
    { kind: 'box', frame: 0, ms: 120, watch: 1, boxes: [{ x: 5, y: 6, width: 7, height: 8 }, { x: 15, y: 6, width: 7, height: 8 }] },
    { kind: 'box', frame: 0, ms: 400, watch: 1, boxes: [] },
    // A box from a frame never linked cannot be placed.
    { kind: 'box', frame: 2, ms: 160, watch: 2, boxes: [{ x: 0, y: 0, width: 1, height: 1 }] },
  ];
  const placed = placeRecords(records.toReversed());
  expect(placed.boxes).toEqual([
    { ms: 120, watch: 1, boxes: [[5, 6, 7, 8], [15, 6, 7, 8]] },
    { ms: 150, watch: 0, boxes: [[60, 210, 20, 5]] },
    { ms: 300, watch: 0, boxes: [[60, 170, 20, 5]] },
    { ms: 400, watch: 1, boxes: [] },
  ]);
  expect(placed.pointer).toEqual([]);
});

test('boxes past what one pass draws are merged into one box around them, never dropped', () => {
  const box = (x, y) => ({ rect: { x, y, width: 10, height: 10 }, effect: 'cover' });
  const boxes = [box(0, 0), box(100, 0), box(50, 200), box(300, 40)];
  expect(mergedPast(boxes, 4)).toEqual(boxes);
  expect(mergedPast(boxes, 2)).toEqual([box(0, 0), { rect: { x: 50, y: 0, width: 260, height: 210 }, effect: 'cover' }]);
});

test('verification warns about a mask whose element never showed during its span, since it hid nothing', () => {
  const elements = [
    { id: 0, tab: 0, name: "getByTestId('email')", boxes: [[0, [10, 10, 50, 20]], [2], [4, [10, 10, 50, 20]]] },
    { id: 1, tab: 0, name: "getByText('Total')", boxes: [] },
  ];
  expect(maskWarnings([{ effect: 'blur', element: 0 }, { effect: 'blur', element: 0, start: 1, end: 3 }, { effect: 'cover', box: { x: 0, y: 0, width: 1, height: 1 } }], elements)).toEqual([]);
  expect(maskWarnings([{ effect: 'blur', element: 0, start: 2.5, end: 3.5 }, { effect: 'spotlight', element: 1 }], elements)).toEqual([
    "Mask 0 (blur from 2.50 s) found no getByTestId('email') on the page during its span, so it drew nothing; check the locator, or when the element shows",
    "Mask 1 (spotlight) found no getByText('Total') on the page during its span, so it drew nothing; check the locator, or when the element shows",
  ]);
});

// A Take of Apps (ADR 0009): a sidecar as cuetake-capture writes it, for a 1200×760-point Desktop.
const desktopViewport = { width: 1200, height: 760 };
const appWindow = { id: 7, layer: 0, x: 0, y: 0, width: 1200, height: 760, radius: 16 };
const contextMenu = { id: 9, layer: 101, x: 1100, y: 300, width: 230, height: 593, radius: 0 };
const sidecarWindows = [{ t: 0, shown: [appWindow] }, { t: 2.3, shown: [appWindow, contextMenu] }, { t: 4.2, shown: [appWindow] }];

test('Render draws the App windows showing at each moment, back to front, clipped to the Desktop where it is on the stage, with effects only around those over no other', () => {
  expect(windowsAt(sidecarWindows, 0).map(w => w.id)).toEqual([7]);
  expect(windowsAt(sidecarWindows, 3).map(w => w.id)).toEqual([7, 9]);
  expect(windowsAt(sidecarWindows, 9).map(w => w.id)).toEqual([7]);
  expect(windowsAt([], 1)).toEqual([]);
  // The Desktop fills a 2400×1520 page at stage scale 2, at 100, 50: a window fills it, with its corners at stage scale;
  // the menu is cut where it leaves the Desktop. The menu lies over the window, where the Source already shows its
  // own shadow, so only the window gets the window effects around it.
  const page = { x: 100, y: 50, w: 2400, h: 1520 };
  expect(drawnWindows(windowsAt(sidecarWindows, 3), desktopViewport, page)).toEqual([
    { id: 7, window: { x: 100, y: 50, w: 2400, h: 1520 }, radius: 32, effects: true },
    { id: 9, window: { x: 2300, y: 650, w: 200, h: 920 }, radius: 0, effects: false },
  ]);
  // A window wholly outside the Desktop is not drawn; a radius never passes half the side it rounds; a window over
  // the Background has its effects.
  expect(drawnWindows([{ ...appWindow, x: 1300 }, { ...appWindow, width: 20, height: 10, radius: 16 }], desktopViewport, page)).toEqual([
    { id: 7, window: { x: 100, y: 50, w: 40, h: 20 }, radius: 10, effects: true },
  ]);
});

test('verification warns when a window leaves the Desktop, the first window moves or resizes, or the Desktop is not at scale 2', () => {
  const frames = scale => [{ timeMs: 0, scale }, { timeMs: 16.7, scale }];
  const timeline = (windows, more = {}) => ({ viewport: desktopViewport, windows, ...more });
  expect(desktopWarnings(timeline([{ t: 0, shown: [appWindow] }]), { frames: frames(2), dropped: 0 })).toEqual([]);
  expect(desktopWarnings(timeline(sidecarWindows), { frames: frames(2), dropped: 0 })).toEqual([
    'At 2.30 s a window of the App (230×593 points) reached outside the Desktop, so the Final shows it cut off.',
  ]);
  const moved = [{ t: 0, shown: [appWindow] }, { t: 3, shown: [{ ...appWindow, x: 40, y: 20 }] }];
  expect(desktopWarnings(timeline(moved), { frames: frames(2), dropped: 0 })).toEqual([
    'At 3.00 s the App\'s first window moved or resized, to 40, 20, 1200×760 points; Render does not correct it, so leave it where the Take put it.',
  ]);
  // A window shrinks for a moment as it closes, as TextEdit's did after Meta+W; that is no move.
  const closed = [{ t: 0, shown: [appWindow] }, { t: 10.717, shown: [{ ...appWindow, x: 3, y: 1, width: 1194, height: 758 }] },
    { t: 10.75, shown: [{ ...appWindow, x: 9, y: 6, width: 1182, height: 748 }] }, { t: 10.767, shown: [] }];
  expect(desktopWarnings(timeline(closed), { frames: frames(2), dropped: 0 })).toEqual([]);
  // A move the window then stays at is still reported, even when the window closes later.
  expect(desktopWarnings(timeline([...moved, { t: 9, shown: [] }]), { frames: frames(2), dropped: 0 })).toHaveLength(1);
  // The first window is the first layer-0 window to show, even when a dialog shows before it.
  const late = [{ t: 0, shown: [{ ...appWindow, id: 3, layer: 8, width: 260, height: 266 }] }, { t: 20.9, shown: [{ ...appWindow, width: 586, height: 488 }] }];
  expect(desktopWarnings(timeline(late), { frames: frames(2), dropped: 0 })[0]).toBe(
    'The App\'s first window is 586×488 points, not the Desktop\'s 1200×760, so the Background shows around it: the App may limit its size; choose a viewport it can fill.');
  const small = [{ t: 0, shown: [{ ...appWindow, width: 800, height: 600 }] }];
  expect(desktopWarnings(timeline(small), { frames: frames(1), dropped: 3 })).toEqual([
    'The App\'s first window is 800×600 points, not the Desktop\'s 1200×760, so the Background shows around it: the App may limit its size; choose a viewport it can fill.',
    'The Desktop was recorded at scale 1, so the Final is half as sharp; record on a Retina display.',
    'The encoder could not keep up and 3 frames were dropped from the Source; close other work and record again.',
  ]);
});

test('a Scenario names exactly one of a start page or an App, given by path or bundle id with arguments', () => {
  expect(scenarioSchema.parse({ name: 'notes', app: { path: 'com.apple.TextEdit' } }).app).toEqual({ path: 'com.apple.TextEdit', args: [] });
  expect(scenarioSchema.parse({ name: 'notes', app: { path: '/Applications/LocalSend.app', args: ['--hidden'] } }).app.args).toEqual(['--hidden']);
  expect(() => scenarioSchema.parse({ name: 'notes' })).toThrow('exactly one of url or app');
  expect(() => scenarioSchema.parse({ name: 'notes', url: 'https://example.com', app: { path: 'com.apple.TextEdit' } })).toThrow('exactly one of url or app');
  expect(() => scenarioSchema.parse({ name: 'notes', app: { path: '' } })).toThrow();
});

test('a Take of Apps has no browser chrome or address bar by default, unless the Scenario names a chrome', () => {
  const app = scenarioSchema.parse({ name: 'notes', app: { path: 'com.apple.TextEdit' } });
  const edit = createEdit(app, { viewport: desktopViewport, windows: sidecarWindows, events: [] }, []);
  expect(edit.frame.chrome).toBe(false);
  expect(edit.frame.url).toBeUndefined();
  expect(edit.frame.effects).toEqual(DEFAULT_STYLE.frame.effects);
  const named = createEdit({ ...app, frame: { chrome: { draw: 'macos' } } }, { viewport: desktopViewport, windows: sidecarWindows, events: [] }, []);
  expect(named.frame.chrome).toEqual({ draw: 'macos' });
});

test('the Director of a Take of Apps keeps time, says Lines, fast-forwards and focuses, and refuses what needs a page or several Apps', async () => {
  const notes = { focus: [], wide: [], said: [], forwarded: [], pointer: [], events: [] };
  const d = createAppDirector({ startedAt: Date.now(), helper: fakeHelper(textEdit()) }, notes);
  d.focus({ x: 10, y: 20, width: 300, height: 40 }, 1);
  await d.say('open', 'Open a document');
  expect(await d.fastForward(async () => 'done', 3)).toBe('done');
  expect(notes.focus).toEqual([{ t: 1, box: { x: 10, y: 20, width: 300, height: 40 }, tab: 0 }]);
  expect(notes.said).toMatchObject([{ id: 'open', text: 'Open a document' }]);
  expect(notes.forwarded).toMatchObject([{ rate: 3 }]);
  expect(() => d.mask()).toThrow('d.mask does not work in a Take of an App');
  expect(() => d.switchTo()).toThrow('d.switchTo does not work in a Take of an App until it can record several Apps');
});

test('the Timeline of a Take of Apps has one Tab, its Desktop, with the windows the helper saw and what the Director noted', () => {
  const click = { type: 'click', t: 3.2, end: 3.3, x: 140, y: 22, box: { x: 100, y: 10, width: 80, height: 24 } };
  const notes = { focus: [{ t: 1, box: { x: 10, y: 20, width: 300, height: 40 }, tab: 0 }], said: [{ t: 0.5, id: 'open', text: 'Open' }], forwarded: [{ t: 2, end: 3, rate: 4 }], pointer: [[1, 120, 20], [1.1, 140, 22]], events: [click, { type: 'shortcut', t: 4, keys: ['Meta', 'S'] }] };
  const timeline = desktopTimelineOf({ app: { path: 'com.apple.TextEdit', args: [] }, viewport: desktopViewport, scale: 2 }, { duration: 5.04, windows: sidecarWindows }, notes);
  expect(timeline).toMatchObject({
    app: { path: 'com.apple.TextEdit' }, viewport: desktopViewport, scale: 2, duration: 5.04, windows: sidecarWindows, pointer: [[1, 120, 20, 0], [1.1, 140, 22, 0]], shapes: [],
    tabs: [{ id: 0, opener: null, opened: 0, closed: null, viewport: desktopViewport, start: 0 }],
  });
  // The Director's input is in the Desktop's one Tab, where Render draws the Cursor and keycaps and the camera follows it.
  expect(timeline.events.map(event => event.type)).toEqual(['say', 'focus', 'fastForward', 'click', 'shortcut']);
  expect(timeline.events[3]).toEqual({ ...click, tab: 0 });
  // The first Edit of such a Take keeps the Director's camera target, Line and fast-forward.
  const edit = createEdit(scenarioSchema.parse({ name: 'notes', app: { path: 'com.apple.TextEdit' } }), timeline, notes.focus);
  expect(edit.camera.targets).toEqual([notes.focus[0], { t: 3.2, box: click.box, tab: 0 }]);
  expect(edit.shortcuts).toMatchObject([{ t: 4, keys: ['Meta', 'S'] }]);
  expect(edit.narration.lines).toEqual([{ id: 'open', start: 0.5 }]);
  expect(edit.fastForward).toEqual([{ start: 2, end: 3, rate: 4 }]);
});

test('a key or combination names the macOS key code to post, the modifiers to hold, and the keydown a page would see', () => {
  // Letters and digits by their place on an ANSI keyboard; a letter's case never adds Shift, so Meta+K is not Meta+Shift+K.
  expect(macKeys('Meta+K')).toEqual({ keyCode: 40, modifiers: ['command'], down: { key: 'k', code: 'KeyK', ctrlKey: false, altKey: false, shiftKey: false, metaKey: true } });
  expect(macKeys('k')).toEqual(macKeys('K'));
  expect(macKeys('Enter')).toMatchObject({ keyCode: 36, modifiers: [], down: { key: 'Enter', code: 'Enter' } });
  expect(macKeys('Control+Alt+Shift+Meta+ArrowUp')).toMatchObject({ keyCode: 126, modifiers: ['control', 'option', 'shift', 'command'] });
  // ControlOrMeta presses Meta on the Mac, where Apps record; codes such as KeyZ work too.
  expect(macKeys('ControlOrMeta+KeyZ')).toMatchObject({ keyCode: 6, modifiers: ['command'] });
  expect(macKeys('Space').keyCode).toBe(49);
  expect(macKeys('Escape').keyCode).toBe(53);
  expect(macKeys('Backspace').keyCode).toBe(51);
  expect(macKeys('Meta+,')).toMatchObject({ keyCode: 43, down: { key: ',', code: 'Comma' } });
  expect(macKeys('7').keyCode).toBe(26);
  expect(macKeys('F5').keyCode).toBe(96);
  // The keydown shows as the same Shortcut a page would record for it.
  expect(shortcutKeys({ ...macKeys('Meta+Shift+Z').down, field: true })).toEqual(['Shift', 'Meta', 'Z']);
  expect(shortcutKeys({ ...macKeys('Space').down, field: false })).toEqual(['Space']);
  expect(() => macKeys('Meta+Hyperdrive')).toThrow("d.press does not know the key 'Hyperdrive'");
  expect(() => macKeys('Meta+')).toThrow("d.press does not know the key ''");
});

/**
 * A stand-in for the helper's Accessibility and input requests during a Take of Apps: `windows` back to front,
 * each element `{ role, subrole, title, description, label, identifier, value, text, frame, children }` in
 * Desktop points. It notes what it posted, and `covered` names the app whose window lies over a point.
 */
function fakeHelper(windows, { covered = () => null, focused = { role: 'AXTextArea' } } = {}) {
  const refs = [], posted = [];
  const ref = element => { if (!refs.includes(element)) refs.push(element); return refs.indexOf(element); };
  const summary = e => ({ ref: ref(e), role: e.role, subrole: e.subrole ?? null, title: e.title ?? '', description: e.description ?? '', label: e.label ?? '', identifier: e.identifier ?? '', frame: e.frame });
  const descendants = e => (e.children ?? []).flatMap(child => [child, ...descendants(child)]);
  return {
    posted, windows,
    async request(message) {
      const [[kind, body]] = Object.entries(message);
      if (kind === 'windows') return windows.map(w => ({ ...summary(w), focused: !!w.focused }));
      if (kind === 'find') return descendants(refs[body.within]).filter(e => (!body.roles || body.roles.some(r => r.role === e.role && (!r.subrole || r.subrole === e.subrole))) && (!body.identifier || e.identifier === body.identifier)).map(summary);
      if (kind === 'read') { const e = refs[body.ref]; return { value: e.value ?? null, text: e.text ?? '', frame: e.frame }; }
      if (kind === 'focused') return focused;
      // `covered` gives the covering app's name, or true where nothing at all lies under the point.
      if (kind === 'down' && covered(body)) return covered(body) === true ? { nothing: true } : { covered: covered(body) };
      posted.push({ [kind]: body });
      return {};
    },
  };
}
const field = (more = {}) => ({ role: 'AXTextArea', frame: { x: 20, y: 60, width: 1160, height: 680 }, value: 'Hello', ...more });
const button = (title, more = {}) => ({ role: 'AXButton', title, frame: { x: 100, y: 10, width: 80, height: 24 }, ...more });
const textEdit = () => [
  { role: 'AXWindow', subrole: 'AXStandardWindow', title: 'Untitled', focused: true, frame: { x: 0, y: 0, width: 1200, height: 760 }, children: [
    { role: 'AXToolbar', frame: { x: 0, y: 0, width: 1200, height: 52 }, children: [button('Bold'), button('Italic', { frame: { x: 200, y: 10, width: 80, height: 24 } })] },
    { role: 'AXScrollArea', frame: { x: 20, y: 60, width: 1160, height: 680 }, children: [field({ identifier: 'body' })] },
  ] },
  { role: 'AXWindow', subrole: 'AXStandardWindow', title: 'Fonts', frame: { x: 800, y: 100, width: 300, height: 400 }, children: [
    button('', { description: 'Close fonts' }), button('Done', { description: 'Dismiss' }), { role: 'AXTextField', label: 'Size', frame: { x: 820, y: 140, width: 60, height: 22 }, value: '12' },
  ] },
];
const appDirector = (helper, notes = { focus: [], wide: [], said: [], forwarded: [], pointer: [], events: [] }) => createAppDirector({ startedAt: Date.now(), fps: 120, helper }, notes);

test('an App is located by Accessibility role and name in the window in front, as with getByRole, chained to narrow it', async () => {
  const d = appDirector(fakeHelper(textEdit()));
  // ARIA roles map to AX roles: a textbox is a text field or a text area; a name matches the title, a part of it, any case.
  expect(await d.page.getByRole('textbox').value()).toBe('Hello');
  expect(await d.page.getByRole('button', { name: 'bol' }).isVisible()).toBe(true);
  expect(await d.page.getByRole('button', { name: 'bol', exact: true }).isVisible()).toBe(false);
  expect(await d.page.getByRole('button', { name: /^Ital/ }).isVisible()).toBe(true);
  expect(await d.page.getByRole('AXToolbar').getByRole('button', { name: 'Bold' }).isVisible()).toBe(true);
  expect(await d.page.getByTestId('body').value()).toBe('Hello');
  // Another window by its title; the name is the title, else the description, else the label.
  expect(await d.app.window('Fonts').getByRole('button', { name: 'Close fonts' }).isVisible()).toBe(true);
  expect(await d.app.window('Fonts').getByRole('button', { name: 'Dismiss' }).isVisible()).toBe(false);
  expect(await d.app.window('Fonts').getByRole('textbox', { name: 'Size' }).value()).toBe('12');
  expect(await d.page.getByRole('button', { name: 'Close fonts' }).isVisible()).toBe(false);
  // Several matches fail at once, naming them, as Playwright's strict mode does.
  await expect(d.page.getByRole('button').value()).rejects.toThrow("d.page.getByRole('button') matches 2 elements: AXButton 'Bold' at 100, 10, 80×24; AXButton 'Italic' at 200, 10, 80×24");
  await expect(d.page.getByRole('link').waitFor({ timeout: 50 })).rejects.toThrow("d.page.getByRole('link') did not become visible within 50 ms");
  await d.page.getByRole('link').waitFor({ state: 'hidden', timeout: 50 });
  // Only Accessibility locators work; Playwright's other methods throw, naming those that do.
  expect(() => d.page.locator('#body')).toThrow('d.page.locator does not work in a Take of an App: use getByRole, getByTestId');
  expect(() => d.page.getByRole('textbox').fill('x')).toThrow('fill does not work on a locator of an App: use getByRole, getByTestId, value, text, isVisible and waitFor, and act with d.click, d.type');
  expect(() => d.page.getByRole('blink')).toThrow("getByRole does not know the role 'blink'");
});

test('the App Director glides the real pointer at the capture rate, presses where it landed and notes it all in Desktop points', async () => {
  const helper = fakeHelper(textEdit()), notes = { focus: [], wide: [], said: [], forwarded: [], pointer: [], events: [] };
  const d = createAppDirector({ startedAt: Date.now(), fps: 60, speed: 4, helper }, notes);
  await d.click(d.page.getByRole('button', { name: 'Bold' }));
  const moves = helper.posted.filter(p => p.move).map(p => p.move), down = helper.posted.find(p => p.down).down, up = helper.posted.find(p => p.up).up;
  // The pointer starts at the Desktop's top-left corner and arrives a little off the button's center, in several steps.
  expect(moves.length).toBeGreaterThan(5);
  expect(moves.at(-1)).toEqual({ x: down.x, y: down.y });
  expect(Math.abs(down.x - 140)).toBeLessThanOrEqual(8);
  expect(Math.abs(down.y - 22)).toBeLessThanOrEqual(4);
  expect(down.button).toBe('left');
  expect(up).toEqual(down);
  expect(notes.pointer.length).toBe(moves.length);
  expect(notes.pointer.at(-1).slice(1)).toEqual([down.x, down.y]);
  const [click] = notes.events;
  expect(click).toMatchObject({ type: 'click', x: down.x, y: down.y, box: { x: 100, y: 10, width: 80, height: 24 } });
  expect(click.end).toBeGreaterThan(click.t);

  // Typing clicks the field, then posts each character; Return and Tab go as their keys.
  await d.type(d.page.getByRole('textbox'), 'Hi\n', { msPerChar: 5 });
  expect(helper.posted.filter(p => p.text || p.key).map(p => p.text ?? p.key)).toEqual(['H', 'i', { keyCode: 36, modifiers: [], down: true }, { keyCode: 36, modifiers: [], down: false }]);
  expect(notes.events.map(e => e.type)).toEqual(['click', 'click', 'type']);
  expect(notes.events[2]).toMatchObject({ box: { x: 20, y: 60, width: 1160, height: 680 } });

  // A Shortcut is noted as a page would note it; a key alone in a text field is typing, not a Shortcut.
  await d.press('Meta+B');
  await d.press('ArrowLeft');
  expect(helper.posted.filter(p => p.key).slice(-4).map(p => p.key)).toEqual([
    { keyCode: 11, modifiers: ['command'], down: true }, { keyCode: 11, modifiers: ['command'], down: false },
    { keyCode: 123, modifiers: [], down: true }, { keyCode: 123, modifiers: [], down: false },
  ]);
  expect(notes.events.filter(e => e.type === 'shortcut').map(e => e.keys)).toEqual([['Meta', 'B']]);

  // A point in Desktop points works where the App exposes no element; a drag notes where it went.
  await d.click({ x: 600, y: 400 });
  expect(helper.posted.filter(p => p.down).at(-1).down).toMatchObject({ x: 600, y: 400 });
  await d.drag({ x: 300, y: 300 }, { x: 500, y: 320 });
  expect(notes.events.at(-1)).toMatchObject({ type: 'drag', from: { x: 300, y: 300 }, to: { x: 500, y: 320 } });
  expect(helper.posted.at(-1)).toEqual({ up: { x: 500, y: 320, button: 'left' } });
  // focus: false keeps the camera wide for an action.
  await d.hover(d.page.getByRole('button', { name: 'Italic' }), { focus: false });
  expect(notes.wide.length).toBe(1);
});

test('a press over another app\'s window fails the Take, naming that app, and presses nothing', async () => {
  const helper = fakeHelper(textEdit(), { covered: ({ x }) => x > 150 ? 'Finder' : null });
  const d = createAppDirector({ startedAt: Date.now(), fps: 60, speed: 8, helper }, { focus: [], wide: [], said: [], forwarded: [], pointer: [], events: [] });
  await expect(d.click(d.page.getByRole('button', { name: 'Italic' }))).rejects.toThrow("d.click target, d.page.getByRole('button', { name: 'Italic' }), is covered by a window of Finder");
  expect(helper.posted.some(p => p.down)).toBe(false);
  // Where nothing lies under the point, as off the Desktop, the press is refused as missing the App.
  const empty = createAppDirector({ startedAt: Date.now(), fps: 60, speed: 8, helper: fakeHelper(textEdit(), { covered: () => true }) }, { focus: [], wide: [], said: [], forwarded: [], pointer: [], events: [] });
  await expect(empty.click({ x: 1300, y: 20 })).rejects.toThrow('d.click target lands at 1300, 20, where no window shows; it may lie outside the Desktop');
  // A drag goes between points; a locator there is refused, not moved to as NaN.
  await expect(empty.drag(empty.page.getByRole('textbox'), { x: 1, y: 1 })).rejects.toThrow('d.drag goes from one point { x, y } to another, in Desktop points');
});

test('an App\'s Accessibility tree lists each element with the locator that names it and its frame from its window\'s corner', () => {
  const at = (x, y, width, height) => ({ x, y, width, height });
  const tree = { app: 'LocalSend', bundle: 'org.localsend.localsend_app', truncated: false, windows: [
    { role: 'AXWindow', subrole: 'AXStandardWindow', title: 'LocalSend', frame: at(405, 239, 900, 600), children: [
      { role: 'AXStaticText', value: 'Send\nTab 2 of 3', frame: at(405, 417, 256, 44), children: [] },
      { role: 'AXButton', title: '', description: 'Receive via link', frame: at(897, 754, 172, 40), children: [] },
      { role: 'AXTextField', identifier: 'alias', label: 'Alias', value: 'Mystic', frame: at(713, 301, 300, 24), children: [] },
      { role: 'AXGroup', identifier: '_NS:6', frame: at(405, 271, 900, 568), children: [{ role: 'AXSplitter', frame: at(661, 271, 1, 568), children: [] }] },
      { role: 'AXMenuButton', title: 'list style', frame: at(930, 278, 48, 22), children: [] },
    ] },
  ] };
  expect(treeLines(tree)).toEqual([
    "LocalSend (org.localsend.localsend_app): frames in points from each window's top-left corner, which are Desktop points for the window that fills the Desktop",
    "window 'LocalSend' 900×600: d.app.window('LocalSend')",
    "  text 'Send\\nTab 2 of 3' 0, 178, 256×44: getByRole('text', { name: 'Send' })",
    "  button 'Receive via link' 492, 515, 172×40: getByRole('button', { name: 'Receive via link' })",
    "  textbox 'Alias' = 'Mystic' 308, 62, 300×24: getByTestId('alias')",
    '  group 0, 32, 900×568',
    '    AXSplitter 256, 32, 1×568',
    "  AXMenuButton 'list style' 525, 39, 48×22: getByRole('AXMenuButton', { name: 'list style' })",
  ]);
  expect(treeLines({ ...tree, truncated: true }).at(-1)).toBe('… the tree is longer than 5000 elements; the rest is left out');
});
