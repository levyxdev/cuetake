import { test, expect } from 'bun:test';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveAuthState, resolveAuthProfile } from '../src/auth.js';
import { installProbe, collectTimeline } from '../src/probe.js';
import { renderFinal, inspectFinal, extractFrame } from '../src/render.js';
import { editSchema } from '../src/edit.js';
import { layout } from '../src/stage.js';

test('local auth state restores cookie and localStorage without adding it to take artifacts', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'cuetake-auth-'));
  const old = process.env.CUETAKE_AUTH_DIR;
  process.env.CUETAKE_AUTH_DIR = directory;
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route('https://cuetake.test/**', route => route.fulfill({ body: '<h1>Private demo fixture</h1>', contentType: 'text/html' }));
    await page.goto('https://cuetake.test/');
    await context.addCookies([{ name: 'demo_session', value: 'fixture-only', domain: 'cuetake.test', path: '/', httpOnly: true, secure: true }]);
    await page.evaluate(() => localStorage.setItem('demo-user', 'fixture'));
    await saveAuthState(context, 'fixture');
    const path = await resolveAuthProfile('fixture');
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    const restored = await browser.newContext({ storageState: path });
    expect((await restored.cookies()).some(c => c.name === 'demo_session' && c.value === 'fixture-only')).toBe(true);
    const state = await restored.storageState();
    expect(state.origins[0].localStorage).toContainEqual({ name: 'demo-user', value: 'fixture' });
    expect((await saveAuthState(context, 'fixture')).note).not.toContain('fixture-only');
    await expect(resolveAuthProfile('../escape')).rejects.toThrow();
    await restored.close();
  } finally { await browser.close(); if (old === undefined) delete process.env.CUETAKE_AUTH_DIR; else process.env.CUETAKE_AUTH_DIR = old; await fs.rm(directory, { recursive: true, force: true }); }
}, 30_000);

test('probe records the pointer path, clicks with their target box, drags and typing bursts', async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    await page.setContent('<button style="position:fixed;left:100px;top:100px;width:80px;height:40px">Go</button><input style="position:fixed;left:300px;top:100px;width:200px;height:30px">');
    const startedAtMs = Date.now();
    await installProbe(page);
    await page.mouse.move(140, 120);
    await page.mouse.click(140, 120);
    await page.mouse.move(10, 300);
    await page.mouse.down();
    await page.mouse.move(200, 400, { steps: 5 });
    await page.mouse.up();
    await page.mouse.click(400, 115);
    await page.keyboard.type('abc', { delay: 50 });
    const timeline = await collectTimeline(page, startedAtMs);
    expect(timeline.pointer.length).toBeGreaterThan(5);
    expect(timeline.pointer.every(([t]) => t >= 0)).toBe(true);
    expect(timeline.events.map(e => e.type)).toEqual(['click', 'drag', 'click', 'type']);
    const [click, drag, , typing] = timeline.events;
    expect(click).toMatchObject({ x: 140, y: 120, box: { x: 100, y: 100, width: 80, height: 40 } });
    expect(drag).toMatchObject({ from: { x: 10, y: 300 }, to: { x: 200, y: 400 } });
    expect(drag.end).toBeGreaterThanOrEqual(drag.t);
    expect(typing.box).toMatchObject({ x: 300, width: 200 });
    expect(typing.end).toBeGreaterThan(typing.t);
  } finally { await browser.close(); }
}, 30_000);

/** A VP9 WebM of a black 640×480 stage with a red square, recorded like a real Source. */
async function syntheticSource(browser, seconds) {
  const page = await browser.newPage();
  const base64 = await page.evaluate(async ms => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 480 });
    const ctx = canvas.getContext('2d');
    const paint = () => { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 640, 480); ctx.fillStyle = '#f00'; ctx.fillRect(480, 200, 40, 40); };
    paint();
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm;codecs=vp9' });
    const chunks = [];
    recorder.ondataavailable = e => chunks.push(e.data);
    const timer = setInterval(paint, 33);
    recorder.start();
    await new Promise(r => setTimeout(r, ms));
    recorder.stop();
    await new Promise(r => { recorder.onstop = r; });
    clearInterval(timer);
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  }, seconds * 1000);
  await page.close();
  return Buffer.from(base64, 'base64');
}

/** RGB values of a PNG at the given output pixels. */
async function pixelsAt(browser, png, points) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async ([data, points]) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const ctx = Object.assign(document.createElement('canvas'), { width: image.width, height: image.height }).getContext('2d');
      ctx.drawImage(image, 0, 0);
      return points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)]);
    }, [png.toString('base64'), points]);
  } finally { await page.close(); }
}

test('Render maps CSS camera targets onto the 2× Source and holds the last frame to the Take duration', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'cuetake-render-'));
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const sourcePath = join(dir, 'source.webm'), outputPath = join(dir, 'final.mp4');
    await fs.writeFile(sourcePath, await syntheticSource(browser, 0.6));
    const edit = editSchema.parse({ schemaVersion: 2, output: { size: 240, fps: 30 }, frame: false, camera: { maxZoom: 2, padding: 0, lead: 0.1, response: 0.1, hold: 2, endWide: 0, follow: false, targets: [{ t: 0.2, box: { x: 240, y: 100, width: 20, height: 20 } }] } });
    await renderFinal({ sourcePath, finalPath: outputPath, timeline: { viewport: { width: 320, height: 240 }, duration: 1.5 }, edit });
    expect(await inspectFinal(outputPath)).toMatchObject({ width: 320, height: 240, fps: 30, packets: 45, decodedFrames: 45 });
    const pixel = await pixelsAt(browser, await extractFrame(outputPath, 0.5), [[180, 120], [250, 110]]);
    expect(pixel[0][0]).toBeGreaterThan(180);
    expect(pixel[0][1]).toBeLessThan(60);
    expect(pixel[1][0]).toBeLessThan(40);
  } finally { await browser.close(); await fs.rm(dir, { recursive: true, force: true }); }
}, 60_000);

test('Render draws the cursor at the pointer and a spark around each click', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'cuetake-cursor-'));
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const sourcePath = join(dir, 'source.webm'), outputPath = join(dir, 'final.mp4');
    await fs.writeFile(sourcePath, await syntheticSource(browser, 0.6));
    const edit = editSchema.parse({ schemaVersion: 2, output: { size: 240, fps: 30 }, frame: false });
    const timeline = { viewport: { width: 320, height: 240 }, duration: 1, pointer: [[0, 60, 60], [1, 60, 60]], events: [{ type: 'click', t: 0.2, x: 200, y: 60 }] };
    await renderFinal({ sourcePath, finalPath: outputPath, timeline, edit });
    // A spark ray sits ~26 px from the click along 22.5° at t=0.3; the arrow body lies just below-right of the tip.
    const ray = [Math.round(200 + 26 * Math.cos(Math.PI / 8)), Math.round(60 + 26 * Math.sin(Math.PI / 8))];
    const [arrow, spark, clear] = await pixelsAt(browser, await extractFrame(outputPath, 0.3), [[64, 72], ray, [120, 200]]);
    expect(Math.min(...arrow)).toBeGreaterThan(180);
    expect(Math.min(...spark)).toBeGreaterThan(110);
    expect(Math.max(...clear)).toBeLessThan(40);
    const [gone] = await pixelsAt(browser, await extractFrame(outputPath, 0.9), [ray]);
    expect(Math.max(...gone)).toBeLessThan(40);
  } finally { await browser.close(); await fs.rm(dir, { recursive: true, force: true }); }
}, 60_000);

test('Render frames the page in a browser window on the background', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'cuetake-frame-'));
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const sourcePath = join(dir, 'source.webm'), outputPath = join(dir, 'final.mp4');
    await fs.writeFile(sourcePath, await syntheticSource(browser, 0.6));
    const viewport = { width: 320, height: 240 };
    const edit = editSchema.parse({ schemaVersion: 2, output: { size: 480, fps: 30 }, frame: { url: 'example.com', shadow: false } });
    await renderFinal({ sourcePath, finalPath: outputPath, timeline: { viewport, duration: 1 }, edit });
    const stage = layout(edit, viewport);
    expect(await inspectFinal(outputPath)).toMatchObject({ width: stage.width, height: stage.height, decodedFrames: 30 });
    const pageCenter = [Math.round(stage.page.x + stage.page.w * 0.3), Math.round(stage.page.y + stage.page.h / 2)];
    const chrome = [Math.round(stage.window.x + stage.window.w * 0.8), Math.round(stage.window.y + stage.chrome / 2)];
    const [background, page, bar] = await pixelsAt(browser, await extractFrame(outputPath, 0.5), [[4, 4], pageCenter, chrome]);
    expect(background[2]).toBeGreaterThan(background[1]);    // aurora: blue-violet, not page or chrome
    expect(Math.max(...page)).toBeLessThan(40);              // the black Source
    expect(Math.min(...bar)).toBeGreaterThan(220);           // light chrome bar
  } finally { await browser.close(); await fs.rm(dir, { recursive: true, force: true }); }
}, 60_000);
