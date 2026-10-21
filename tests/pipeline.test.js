import { test, expect } from 'bun:test';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { scenarioSchema, summarizeFrames } from '../src/pipeline.js';
import { convertWithZoomMp4 } from '../src/converter.js';
import { cameraTargets, createEdit } from '../src/edit.js';

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

test('FFmpeg camera maps CSS focus to 2x source pixels and preserves duration/FPS', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'cuetake-camera-'));
  try {
    const input = join(dir, 'source.mp4');
    const output = join(dir, 'final.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=640x480:r=30:d=1,drawbox=x=480:y=200:w=40:h=40:color=red:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', input]);
    const timeline = { viewport: { width: 320, height: 240 }, duration: 1 };
    await convertWithZoomMp4(input, timeline, [{ t: 0.2, box: { x: 240, y: 100, width: 20, height: 20 } }], { width: 320, fps: 30, zoomLevel: 2, transitionDuration: 0.1, preLead: 0.1, holdPerTarget: 2, outputPath: output });
    const metadata = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,avg_frame_rate,nb_frames', '-show_entries', 'format=duration', '-of', 'json', output], { encoding: 'utf8' }));
    expect(metadata.streams[0]).toMatchObject({ width: 320, height: 240, avg_frame_rate: '30/1', nb_frames: '30' });
    expect(Number(metadata.format.duration)).toBeCloseTo(1, 2);
    const rgb = execFileSync('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', output, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    const pixel = (x, y) => [...rgb.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3)];
    expect(pixel(180, 120)[0]).toBeGreaterThan(180);
    expect(pixel(180, 120)[1]).toBeLessThan(40);
    expect(pixel(250, 110)[0]).toBeLessThan(40);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}, 30_000);

test('preserves a final static hold when the source ends before the take clock', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'cuetake-hold-'));
  try {
    const input = join(dir, 'source.mp4');
    const output = join(dir, 'final.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=640x480:r=30:d=0.2', '-c:v', 'libx264', '-y', input]);
    const timeline = { viewport: { width: 320, height: 240 }, duration: 1 };
    await convertWithZoomMp4(input, timeline, [], { width: 320, fps: 30, outputPath: output });
    const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', output], { encoding: 'utf8' }));
    expect(duration).toBeCloseTo(1, 2);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}, 30_000);

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
  expect(edit.camera).toMatchObject({ zoomLevel: 1.5, targets: expect.any(Array) });
});
