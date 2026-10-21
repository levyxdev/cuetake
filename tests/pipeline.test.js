import { test, expect } from 'bun:test';
import { scenarioSchema, summarizeFrames } from '../src/pipeline.js';
import { cameraTargets, createEdit } from '../src/edit.js';
import { fitZoom, cropFor, buildChains, cropAt } from '../src/camera.js';
import { pointerAt, presses, sparksAt } from '../src/cursor.js';

test('rejects unsupported capture rates and odd H.264 output dimensions', () => {
  const base = { name: 'demo', url: 'https://example.com' };
  expect(scenarioSchema.safeParse({ ...base, capture: { fps: 45 } }).success).toBe(false);
  expect(scenarioSchema.safeParse({ ...base, output: { width: 1919 } }).success).toBe(false);
  expect(scenarioSchema.parse(base).capture.fps).toBe(60);
});

test('reports sparse static capture honestly rather than labeling it 60 unique fps', () => {
  const stats = summarizeFrames([{ timeMs: 0 }, { timeMs: 17 }, { timeMs: 34 }, { timeMs: 1034 }], 2);
  expect(stats.maxIntervalMs).toBe(1000);
  expect(stats.perSecond.map(s => s.callbacks)).toEqual([3, 1]);
});

test('camera follows explicit focus, otherwise observed clicks, typing and drags', () => {
  const box = { x: 1, y: 2, width: 3, height: 4 };
  const timeline = { events: [
    { type: 'click', t: 1, x: 2, y: 3, box },
    { type: 'type', t: 2, end: 3, box },
    { type: 'drag', t: 4, end: 5, from: { x: 50, y: 10 }, to: { x: 10, y: 40 } },
  ] };
  expect(cameraTargets(timeline, [])).toEqual([
    { t: 1, box }, { t: 2, box, until: 3 }, { t: 4, box: { x: 10, y: 10, width: 40, height: 30 }, until: 5 },
  ]);
  expect(cameraTargets(timeline, [{ t: 9, box }])).toEqual([{ t: 9, box }]);
  const edit = createEdit(scenarioSchema.parse({ name: 'demo', url: 'https://example.com' }), timeline, []);
  expect(edit.schemaVersion).toBe(2);
  expect(edit.camera).toMatchObject({ maxZoom: 2, targets: expect.any(Array) });
  expect(cameraTargets(timeline, [], [{ start: 1.5, end: 4.5 }]).map(target => target.t)).toEqual([1]);
});

const viewport = { width: 320, height: 240 };
const camera = { maxZoom: 2, minZoom: 1.2, padding: 0, transitionDuration: 0.1, panDuration: 0.2, preLead: 0.1, holdPerTarget: 2, chainGap: 1 };

test('a crop centers its CSS box at the zoom level and stays inside the viewport', () => {
  expect(cropFor({ x: 240, y: 100, width: 20, height: 20 }, viewport, 2)).toEqual({ x: 160, y: 50, w: 160, h: 120 });
  expect(cropFor({ x: 0, y: 0, width: 10, height: 10 }, viewport, 2)).toEqual({ x: 0, y: 0, w: 160, h: 120 });
});

test('the camera zooms in before a target, holds it, then zooms out once', () => {
  const chains = buildChains([{ t: 0.2, box: { x: 240, y: 100, width: 20, height: 20 } }], viewport, camera);
  const full = { x: 0, y: 0, w: 320, h: 240 };
  expect(cropAt(chains, viewport, 0)).toEqual(full);
  const halfway = cropAt(chains, viewport, 0.15);
  for (const [key, value] of Object.entries({ x: 80, y: 25, w: 240, h: 180 })) expect(halfway[key]).toBeCloseTo(value, 6);
  expect(cropAt(chains, viewport, 1)).toEqual({ x: 160, y: 50, w: 160, h: 120 });
  expect(cropAt(chains, viewport, 3)).toEqual(full);
});

test('within a chain the camera pans to arrive exactly when the next target fires', () => {
  const left = { x: 0, y: 100, width: 20, height: 20 }, right = { x: 300, y: 100, width: 20, height: 20 };
  const chains = buildChains([{ t: 0.2, box: left }, { t: 1, box: right }], viewport, camera);
  expect(chains).toHaveLength(1);
  expect(cropAt(chains, viewport, 0.7).x).toBe(0);
  expect(cropAt(chains, viewport, 0.9).x).toBe(80);
  expect(cropAt(chains, viewport, 1).x).toBe(160);
  expect(buildChains([{ t: 0.2, box: left }, { t: 5, box: right }], viewport, camera)).toHaveLength(2);
});

test('typing holds the camera for the whole burst', () => {
  const [chain] = buildChains([{ t: 1, box: { x: 0, y: 0, width: 10, height: 10 }, until: 4 }], viewport, camera);
  expect(chain.unzoomAt).toBe(6);
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

test('each target zooms to fit its box with padding, capped, and large boxes stay wide', () => {
  const fit = { maxZoom: 2, padding: 10 };
  expect(fitZoom({ x: 0, y: 0, width: 20, height: 20 }, viewport, fit)).toBe(2);
  expect(fitZoom({ x: 0, y: 0, width: 180, height: 50 }, viewport, fit)).toBe(1.6);
  expect(fitZoom({ x: 0, y: 0, width: 400, height: 300 }, viewport, fit)).toBe(1);
  expect(buildChains([{ t: 1, box: { x: 0, y: 0, width: 300, height: 220 } }], viewport, camera)).toEqual([]);
  expect(buildChains([{ t: 1, box: { x: 0, y: 0, width: 300, height: 220 }, zoom: 1.5 }], viewport, camera)).toHaveLength(1);
});

test('the camera changes zoom while moving between targets of different size', () => {
  const small = { x: 0, y: 100, width: 20, height: 20 }, medium = { x: 100, y: 50, width: 200, height: 150 };
  const chains = buildChains([{ t: 0.2, box: small }, { t: 1, box: medium }], viewport, camera);
  expect(cropAt(chains, viewport, 0.7).w).toBe(160);
  expect(cropAt(chains, viewport, 1).w).toBe(200);
  expect(cropAt(chains, viewport, 2.5).w).toBe(200);
});
