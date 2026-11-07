import { test, expect } from 'bun:test';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { saveAuthState, resolveAuthProfile } from '../src/auth.js';
import { installProbe, collectTimeline } from '../src/probe.js';
import { createDirector } from '../src/director.js';
import { followTabs } from '../src/follow-tabs.js';
import { renderFinal, inspectFinal, extractFrame, composePreview } from '../src/render.js';
import { merge, withDefaults } from '../src/edit.js';
import { layout, previewSheet, outputSize } from '../src/stage.js';
import { forRender } from '../src/styles.js';
import { startRecording, getRecordingPage, beginCapture, stopRecording, cleanup } from '../src/recorder.js';

/** Preview tiles as composePreview takes them: Edits with their files served from `dir`. */
const previewOf = (dir, tiles) => { const files = {}; return { files, tiles: tiles.map(([name, edit]) => ({ name, edit: forRender(edit, dir, files).edit })) }; };
/** An Edit for a 320×240 viewport, with the page filling the output unless `over` adds a frame. */
const bare = (over = {}) => withDefaults(merge({ output: { width: 320, height: 240, fps: 30 }, frame: { padding: 0, radius: 0, chrome: false, background: [], effects: [] } }, over));

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

test('probe records the pointer path, clicks with their target box and release, drags and typing bursts', async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    await page.setContent('<button style="position:fixed;left:100px;top:100px;width:80px;height:40px">Go</button><input style="position:fixed;left:300px;top:100px;width:200px;height:30px">');
    const startedAtMs = Date.now();
    await installProbe(page);
    await page.mouse.move(140, 120);
    await page.mouse.click(140, 120, { delay: 100 });
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
    expect(click.end - click.t).toBeGreaterThanOrEqual(0.09);
    expect(drag).toMatchObject({ from: { x: 10, y: 300 }, to: { x: 200, y: 400 } });
    expect(drag.end).toBeGreaterThanOrEqual(drag.t);
    expect(typing.box).toMatchObject({ x: 300, width: 200 });
    expect(typing.end).toBeGreaterThan(typing.t);
  } finally { await browser.close(); }
}, 30_000);

test('probe records right clicks, and Shortcuts but not typing', async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    await page.setContent('<div id="board" tabindex="0" style="position:fixed;left:20px;top:20px;width:200px;height:200px"></div><input style="position:fixed;left:300px;top:100px;width:200px;height:30px">');
    const startedAtMs = Date.now();
    await installProbe(page);
    await page.mouse.click(100, 100, { button: 'right', delay: 50 });
    await page.keyboard.press('Meta+K');
    await page.keyboard.press('r');
    await page.mouse.click(400, 115);
    await page.keyboard.type('Hi there', { delay: 20 });
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Enter');
    const timeline = await collectTimeline(page, startedAtMs);
    const [rightClick] = timeline.events;
    expect(rightClick).toMatchObject({ type: 'click', button: 'right', x: 100, y: 100 });
    expect(rightClick.end - rightClick.t).toBeGreaterThanOrEqual(0.04);
    expect(timeline.events.filter(e => e.type === 'click').map(e => e.button)).toEqual(['right', undefined]);
    const shortcuts = timeline.events.filter(e => e.type === 'shortcut');
    expect(shortcuts.map(e => e.keys)).toEqual([['Meta', 'K'], ['R'], ['Control', 'A']]);
    expect(shortcuts.every((e, i) => e.t >= 0 && (i === 0 || e.t >= shortcuts[i - 1].t))).toBe(true);
    // Typed text never reaches the Timeline.
    expect(JSON.stringify(timeline)).not.toContain('there');
  } finally { await browser.close(); }
}, 30_000);

test('probe records the cursor shape the page asks for, as the browser resolves it', async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    await page.setContent(`<style>body { margin: 0; font: 16px sans-serif } div { position: fixed }</style>
      <div style="left: 20px; top: 20px"><a href="#">A link</a></div>
      <div style="left: 20px; top: 80px">Plain paragraph text</div>
      <input style="position: fixed; left: 20px; top: 140px; width: 200px">
      <button style="position: fixed; left: 20px; top: 200px">Button text</button>
      <div id="pen" style="left: 300px; top: 20px; width: 100px; height: 100px; cursor: url(data:image/png;base64,AAAA) 4 4, crosshair"></div>
      <div id="board" style="left: 300px; top: 200px; width: 100px; height: 100px"></div>`);
    // A page that sets its cursor from its own pointer handler, as canvas apps do.
    await page.evaluate(() => document.getElementById('board').addEventListener('pointermove', e => { e.currentTarget.style.cursor = 'grab'; }));
    const startedAtMs = Date.now();
    await installProbe(page);
    const visit = async (x, y) => { await page.mouse.move(x, y); await page.waitForTimeout(50); };
    await visit(30, 28); // the link
    await visit(30, 88); // paragraph text
    await visit(500, 400); // empty page
    await visit(60, 150); // the input
    await visit(40, 210); // button text
    await visit(350, 70); // an image cursor with its fallback
    await visit(350, 250); // set by the page's handler
    const { shapes } = await collectTimeline(page, startedAtMs);
    expect(shapes.map(([, shape]) => shape)).toEqual(['pointer', 'text', 'default', 'text', 'default', 'crosshair', 'grab']);
    expect(shapes.every(([t], i) => t >= 0 && (i === 0 || t > shapes[i - 1][0]))).toBe(true);
    // A shape shown before Capture starts is where the Timeline begins.
    const later = await collectTimeline(page, Date.now());
    expect(later.shapes).toEqual([[0, 'grab']]);
  } finally { await browser.close(); }
}, 30_000);

/**
 * Serves `pages` (path → HTML, with PORT replaced) on every loopback name, so 127.0.0.1, localhost and
 * checkout.localhost are three sites and Chromium puts each one's iframes in its own process. Chromium
 * resolves every *.localhost name to loopback itself; 127.0.0.2 would not do, as macOS routes only 127.0.0.1.
 */
async function sites(pages) {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end((pages[request.url] ?? '').replaceAll('PORT', server.address().port));
  });
  await new Promise(done => server.listen(0, done));
  return { port: server.address().port, close: () => server.close() };
}

test('probe follows input inside cross-origin, nested, late and removed iframes, in top-level CSS pixels', async () => {
  const checkout = '<body style="margin:0"><button id="pay" style="margin:20px;width:100px;height:30px;cursor:pointer">Pay</button><input id="card" style="margin:10px;width:150px"></body>';
  const server = await sites({
    '/': `<body style="margin:0;height:2000px"><div style="height:150px"></div>
      <iframe id="outer" src="http://localhost:PORT/outer" style="border:5px solid;padding:3px;width:400px;height:300px;margin-left:60px"></iframe>
      <div style="position:fixed;left:50%;top:70%;transform:translate(-50%,-50%)"><iframe id="modal" src="http://checkout.localhost:PORT/checkout" style="border:0;width:200px;height:120px"></iframe></div></body>`,
    '/outer': '<body style="margin:0;height:1000px"><div style="height:40px"></div><iframe id="inner" src="http://checkout.localhost:PORT/checkout" style="border:0;width:300px;height:150px;margin-left:30px"></iframe></body>',
    '/checkout': checkout,
  });
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    const inner = page.frameLocator('#outer').frameLocator('#inner'), modal = page.frameLocator('#modal');
    await inner.locator('#pay').waitFor();
    await modal.locator('#pay').waitFor();
    const startedAtMs = Date.now();
    await installProbe(page);
    // Both the page and the outer frame are scrolled, so the inner frame sits away from where it loaded.
    await page.evaluate(() => scrollTo(0, 40));
    await page.frame({ url: /\/outer$/ }).evaluate(() => scrollTo(0, 15));
    const center = async locator => { const b = await locator.boundingBox(); return { box: b, x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
    await page.mouse.move(20, 20);
    await page.waitForTimeout(50);
    const pay = await center(inner.locator('#pay'));
    await page.mouse.move(pay.x, pay.y, { steps: 4 });
    await page.waitForTimeout(50);
    await page.mouse.click(pay.x, pay.y, { delay: 50 });
    const card = await center(inner.locator('#card'));
    await page.mouse.click(card.x, card.y);
    await page.keyboard.type('4242', { delay: 30 });
    const centered = await center(modal.locator('#pay'));
    await page.mouse.click(centered.x, centered.y);
    // A frame that loads after Capture starts and is removed right after it takes a click.
    await page.evaluate(port => document.body.append(Object.assign(document.createElement('iframe'), { id: 'late', src: `http://localhost:${port}/checkout`, style: 'position:fixed;left:500px;top:20px;border:0;width:200px;height:100px' })), server.port);
    const late = page.frameLocator('#late');
    await late.locator('#pay').waitFor();
    const latePay = await center(late.locator('#pay'));
    await page.mouse.click(latePay.x, latePay.y);
    await page.evaluate(() => document.getElementById('late').remove());
    await page.mouse.move(20, 20, { steps: 3 });
    await page.waitForTimeout(50);
    const timeline = await collectTimeline(page, startedAtMs);
    const clicks = timeline.events.filter(e => e.type === 'click');
    expect(clicks).toHaveLength(4);
    for (const [click, target] of [[clicks[0], pay], [clicks[1], card], [clicks[2], centered], [clicks[3], latePay]]) {
      expect(click.x).toBeCloseTo(target.x, 0);
      expect(click.y).toBeCloseTo(target.y, 0);
    }
    // Boxes measured from layout, frame by frame. Playwright's boundingBox leaves out the outer
    // iframe's border and padding, so it is not the reference here.
    const content = (frame, selector) => frame.evaluate(selector => {
      const e = document.querySelector(selector), r = e.getBoundingClientRect(), style = getComputedStyle(e);
      return { x: r.x + e.clientLeft + parseFloat(style.paddingLeft), y: r.y + e.clientTop + parseFloat(style.paddingTop), width: r.width, height: r.height };
    }, selector);
    const outer = await content(page.mainFrame(), '#outer'), nested = await content(page.frame({ url: /\/outer$/ }), '#inner');
    const inside = page.frames().find(frame => frame.parentFrame()?.url().endsWith('/outer'));
    const shown = async selector => {
      const r = await inside.evaluate(selector => document.querySelector(selector).getBoundingClientRect().toJSON(), selector);
      return { x: outer.x + nested.x + r.x, y: outer.y + nested.y + r.y, width: r.width, height: r.height };
    };
    const [payBox, cardBox] = [await shown('#pay'), await shown('#card')];
    for (const key of ['x', 'y', 'width', 'height']) expect(clicks[0].box[key]).toBeCloseTo(payBox[key], 0);
    const [typing] = timeline.events.filter(e => e.type === 'type');
    for (const key of ['x', 'y', 'width']) expect(typing.box[key]).toBeCloseTo(cardBox[key], 0);
    // The pointer path runs on into the frames rather than stopping at their edge.
    expect(timeline.pointer.some(([, x, y]) => Math.abs(x - pay.x) < 1 && Math.abs(y - pay.y) < 1)).toBe(true);
    // The page, the nested Pay button, the card field, then the modal's and the late frame's Pay buttons
    // (one jump apart, so one change), and the page again.
    expect(timeline.shapes.map(([, shape]) => shape)).toEqual(['default', 'pointer', 'text', 'pointer', 'default']);
    expect(timeline.turned).toEqual([]);
    expect(timeline.unplaced).toEqual([]);
  } finally { await browser.close(); server.close(); }
}, 30_000);

test('probe scales input inside a scaled iframe, and notes one that is rotated', async () => {
  const form = '<body style="margin:0"><button id="go" style="margin:40px;width:100px;height:40px">Go</button></body>';
  const server = await sites({
    '/': `<body style="margin:0">
      <iframe id="small" src="http://localhost:PORT/form" style="border:4px solid;width:400px;height:200px;transform:scale(0.5);transform-origin:0 0;margin:100px"></iframe>
      <iframe id="tilted" src="http://localhost:PORT/form" style="position:fixed;left:350px;top:250px;border:0;width:200px;height:150px;rotate:4deg"></iframe></body>`,
    '/form': form,
  });
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.frameLocator('#small').locator('#go').waitFor();
    await page.frameLocator('#tilted').locator('#go').waitFor();
    const startedAtMs = Date.now();
    await installProbe(page);
    await page.mouse.move(10, 10);
    // Where the button shows: 40 px into the frame's content, which starts inside the 4 px border, at half size.
    const frame = await page.locator('#small').boundingBox(), half = { x: frame.x + 2 + 20, y: frame.y + 2 + 20, width: 50, height: 20 };
    const small = { ...half };
    await page.mouse.click(small.x + 5, small.y + 5);
    const tilted = await page.frameLocator('#tilted').locator('#go').boundingBox();
    await page.mouse.click(tilted.x + tilted.width / 2, tilted.y + tilted.height / 2);
    await page.keyboard.press('Meta+K');
    const timeline = await collectTimeline(page, startedAtMs);
    const [scaled, rotated] = timeline.events.filter(e => e.type === 'click');
    expect(scaled.x).toBeCloseTo(small.x + 5, 0);
    expect(scaled.y).toBeCloseTo(small.y + 5, 0);
    for (const key of ['x', 'y', 'width', 'height']) expect(scaled.box[key]).toBeCloseTo(small[key], 0);
    // Placed as if only scaled, so near but not exactly where it landed, and noted with both keys of Meta+K
    // (Meta starts the typing, K is the Shortcut). The two often share a millisecond, which is noted once.
    expect(Math.hypot(rotated.x - (tilted.x + tilted.width / 2), rotated.y - (tilted.y + tilted.height / 2))).toBeLessThan(15);
    const keys = timeline.events.filter(e => e.type === 'type' || e.type === 'shortcut').map(e => e.t);
    expect(keys).toHaveLength(2);
    expect(timeline.turned).toEqual([...new Set([rotated.t, ...keys])]);
    expect(timeline.unplaced).toEqual([]);
  } finally { await browser.close(); server.close(); }
}, 30_000);

test('the Director lands inside bordered, nested and scaled cross-origin iframes, and presses where it landed', async () => {
  // The button notes where inside its border box each click arrived.
  const form = `<body style="margin:0"><button id="go" style="margin:30px;width:120px;height:40px;border:3px solid">Go</button>
    <script>window.hits = []; go.onclick = e => hits.push({ x: e.offsetX + go.clientLeft, y: e.offsetY + go.clientTop });</script></body>`;
  const server = await sites({
    '/': `<body style="margin:0">
      <iframe id="bordered" src="http://localhost:PORT/form" style="border:5px solid;padding:3px;width:240px;height:120px;margin:20px"></iframe>
      <iframe id="outer" src="http://localhost:PORT/outer" style="border:6px solid;padding:4px;width:300px;height:200px;margin:20px"></iframe>
      <iframe id="small" src="http://localhost:PORT/form" style="border:4px solid;width:400px;height:200px;transform:scale(0.5);transform-origin:0 0;position:absolute;left:20px;top:300px"></iframe>
      <iframe id="zoomed" src="http://localhost:PORT/form" style="border:4px solid;width:400px;height:200px;scale:0.5;transform-origin:0 0;position:absolute;left:300px;top:300px"></iframe></body>`,
    '/outer': '<body style="margin:0"><iframe id="inner" src="http://checkout.localhost:PORT/form" style="border:2px solid;padding:5px;width:220px;height:120px;margin:10px"></iframe></body>',
    '/form': form,
  });
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    // Playwright places each of these off, missing the iframes' borders, padding and scale, so it would check their presses at the wrong spot.
    const owners = [page.locator('#bordered'), page.frameLocator('#outer').locator('#inner'), page.locator('#small'), page.locator('#zoomed')];
    const frames = [];
    for (const owner of owners) frames.push(await (await owner.elementHandle()).contentFrame());
    for (const frame of frames) await frame.locator('#go').waitFor();
    // Where each glide ends: the Director moves with page.mouse, and Playwright presses without it.
    const moves = [], move = page.mouse.move.bind(page.mouse);
    page.mouse.move = (x, y, options) => { moves.push({ x, y, ms: Date.now() }); return move(x, y, options); };
    const startedAtMs = Date.now();
    await installProbe(page);
    const d = createDirector(followTabs(page), { startedAt: startedAtMs, fps: 60, speed: 4 }, { focus: [], wide: [], said: [], forwarded: [], pointer: [] });
    for (const frame of frames) await d.click(frame.locator('#go'));
    const timeline = await collectTimeline(page, startedAtMs);
    const clicks = timeline.events.filter(e => e.type === 'click');
    expect(clicks).toHaveLength(4);
    for (const [i, scale] of [1, 1, 0.5, 0.5].entries()) {
      const click = clicks[i], landed = moves.filter(m => m.ms <= startedAtMs + click.t * 1000).at(-1);
      // Pressed where the glide ended, so the Cursor does not jump at the press.
      expect(Math.hypot(click.x - landed.x, click.y - landed.y)).toBeLessThan(1);
      // The button took the click there: where it arrived, mapped back up, is where it was pressed.
      const hits = await frames[i].evaluate(() => hits);
      expect(hits).toHaveLength(1);
      expect(Math.abs(click.box.x + hits[0].x * scale - click.x)).toBeLessThan(1.5);
      expect(Math.abs(click.box.y + hits[0].y * scale - click.y)).toBeLessThan(1.5);
      expect(click.x - click.box.x).toBeGreaterThan(click.box.width * 0.2);
      expect(click.x - click.box.x).toBeLessThan(click.box.width * 0.8);
    }
  } finally { await browser.close(); server.close(); }
}, 30_000);

/** A VP9 WebM of a black 640×480 stage with a red square, recorded like a real Source; the square turns green `greenAt` seconds in. */
async function syntheticSource(browser, seconds, greenAt = Infinity) {
  const page = await browser.newPage();
  const base64 = await page.evaluate(async ([ms, greenMs]) => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 480 });
    const ctx = canvas.getContext('2d'), started = performance.now();
    const paint = () => { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 640, 480); ctx.fillStyle = performance.now() - started >= greenMs ? '#0f0' : '#f00'; ctx.fillRect(480, 200, 40, 40); };
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
  }, [seconds * 1000, greenAt * 1000]);
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

test('Capture keeps one Source and one Timeline through a full navigation and a reload', async () => {
  const page = color => `<title>${color}</title><body style="margin:0;background:${color}"><a href="/next" style="display:block;width:320px;height:240px">Next</a></body>`;
  const server = await sites({ '/': page('rgb(220,30,30)'), '/next': page('rgb(30,180,60)') });
  const dir = await fs.mkdtemp(join(tmpdir(), 'cuetake-navigate-'));
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const { sessionId } = await startRecording(`http://127.0.0.1:${server.port}/`, { width: 640, height: 400, resolutionScale: 1, fps: 30, outputDir: dir, deferCapture: true });
    const recorded = getRecordingPage(sessionId);
    const started = await beginCapture(sessionId), startedAtMs = Date.parse(started.startedAt), beginCaptureUrl = started.url;
    await recorded.waitForTimeout(500);
    await Promise.all([recorded.waitForURL('**/next'), recorded.mouse.click(100, 100)]);
    await recorded.waitForTimeout(500);
    await recorded.reload();
    await recorded.waitForTimeout(300);
    await recorded.mouse.move(200, 50, { steps: 4 });
    await recorded.waitForTimeout(500);
    const timeline = await collectTimeline(recorded, startedAtMs);
    const { durationSeconds, tabs: [{ webmPath, navigations, stats: capture }] } = await stopRecording(sessionId);
    // Both loads are noted, in order, each from its request until its document loaded.
    expect(navigations.map(n => new URL(n.url).pathname)).toEqual(['/next', '/next']);
    expect(navigations[0].t).toBeGreaterThan(0.4);
    for (const n of navigations) expect(n.end).toBeGreaterThanOrEqual(n.t);
    expect(navigations[1].t).toBeGreaterThan(navigations[0].end);
    expect(capture.navigations).toEqual(navigations);
    // Each took its address between its request and its load; the reload stays on /next.
    for (const n of navigations) expect(n.commit).toBeGreaterThanOrEqual(n.t);
    for (const n of navigations) expect(n.commit).toBeLessThanOrEqual(n.end);
    expect((await beginCaptureUrl)).toBe(`http://127.0.0.1:${server.port}/`);
    // The probe saw input on both documents, on the one clock from the start of Capture.
    expect(timeline.events.filter(e => e.type === 'click')).toHaveLength(1);
    expect(timeline.pointer.at(-1)).toEqual([expect.any(Number), 200, 50]);
    expect(timeline.pointer.at(-1)[0]).toBeGreaterThan(navigations[1].end);
    // The Source kept recording after each load, and shows the first page, then the second.
    // A still page may paint the reloaded document before it finishes loading.
    expect(capture.frames.some(f => f.timeMs / 1000 > navigations[1].commit)).toBe(true);
    expect(capture.settings.width).toBe(640);
    expect(durationSeconds).toBeGreaterThan(navigations[1].end);
    const [before] = await pixelsAt(browser, await extractFrame(webmPath, 0.2), [[300, 220]]);
    const [after] = await pixelsAt(browser, await extractFrame(webmPath, durationSeconds - 0.2), [[300, 220]]);
    expect(before[0]).toBeGreaterThan(180);
    expect(after[1]).toBeGreaterThan(150);
    expect(after[0]).toBeLessThan(80);
    expect(capture.pageFrames.length).toBeGreaterThan(0);
  } finally { await cleanup(); await browser.close(); server.close(); await fs.rm(dir, { recursive: true, force: true }); }
}, 60_000);

test('Capture records each Tab the demo opens; the Director acts only in the one in front and carries its cursor into a popup', async () => {
  const button = (id, onclick) => `<button id="${id}" onclick="${onclick}" style="position:fixed;left:40px;top:40px;width:120px;height:40px">${id}</button>`;
  const server = await sites({
    '/': `<body style="margin:0;background:rgb(220,30,30)"><a href="/tab" target="_blank" style="position:fixed;left:40px;top:40px;width:120px;height:40px">tab</a>${button('pop', "window.open('/pop', 'pop', 'popup,width=200,height=160')").replace('top:40px', 'top:120px')}</body>`,
    '/tab': `<body style="margin:0;background:rgb(30,180,60)">${button('done', '')}</body>`,
    '/pop': `<body style="margin:0;background:rgb(30,60,200)">${button('ok', 'setTimeout(() => window.close(), 100)')}</body>`,
  });
  const dir = await fs.mkdtemp(join(tmpdir(), 'cuetake-tabs-'));
  try {
    const { sessionId } = await startRecording(`http://127.0.0.1:${server.port}/`, { width: 640, height: 400, resolutionScale: 1, fps: 30, outputDir: dir, deferCapture: true });
    const { tabs, startedAt } = await beginCapture(sessionId);
    const notes = { focus: [], wide: [], said: [], forwarded: [], pointer: [] };
    const d = createDirector(tabs, { startedAt: Date.parse(startedAt), fps: 30, speed: 4 }, notes);
    const first = d.page;
    const opened = first.waitForEvent('popup');
    await d.click(first.getByRole('link', { name: 'tab' }));
    const tab = await opened;
    expect(d.page).toBe(tab);
    // A person can't click a tab they can't see.
    await expect(d.click(first.locator('#pop'))).rejects.toThrow(/Tab 0, behind the one in front; .*d\.switchTo/);
    await d.click(tab.locator('#done'));
    await d.switchTo(first);
    // The popup opens away from the cursor: the glide into it starts where its page cannot see the pointer.
    await d.move(600, 380);
    const popped = first.waitForEvent('popup');
    await first.locator('#pop').click();
    const popup = await popped;
    await d.click(popup.locator('#ok'));
    await first.waitForTimeout(500);
    expect(d.page).toBe(first);
    const stopped = await stopRecording(sessionId);
    expect(stopped.tabs.map(({ id, opener, viewport, closed }) => [id, opener, viewport, closed === null])).toEqual([
      [0, null, { width: 640, height: 400 }, true], [1, 0, { width: 640, height: 400 }, true], [2, 0, { width: 200, height: 160 }, false],
    ]);
    expect(stopped.tabs.map(t => [t.stats.settings.width, t.stats.settings.height])).toEqual([[640, 400], [640, 400], [200, 160]]);
    expect(stopped.fronts.map(front => front.tab)).toEqual([1, 0, 2, 0]);
    for (const t of stopped.tabs.slice(1)) expect(t.start).toBeGreaterThanOrEqual(t.opened);
    // The popup sits centered over its opener, at 220, 120; the cursor at 600, 380 is outside it.
    const unseen = notes.pointer.filter(([, , , id]) => id === 2);
    expect(unseen[0].slice(1, 3)).toEqual([380, 260]);
    for (const [, x, y] of unseen) expect(x < 0 || y < 0 || x >= 200 || y >= 160).toBe(true);
  } finally { await cleanup(); server.close(); await fs.rm(dir, { recursive: true, force: true }); }
}, 60_000);

test('Render maps CSS camera targets onto the 2× Source and holds the last frame to the Take duration', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'cuetake-render-'));
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const sourcePath = join(dir, 'source.webm'), outputPath = join(dir, 'final.mp4');
    await fs.writeFile(sourcePath, await syntheticSource(browser, 0.6));
    const edit = bare({ camera: { maxZoom: 2, padding: 0, lead: 0.1, response: 0.1, hold: 2, endWide: 0, follow: false, targets: [{ t: 0.2, box: { x: 240, y: 100, width: 20, height: 20 } }] } });
    await renderFinal({ sources: [sourcePath], finalPath: outputPath, timeline: { viewport: { width: 320, height: 240 }, duration: 1.5 }, ...forRender(edit, dir) });
    expect(await inspectFinal(outputPath)).toMatchObject({ width: 320, height: 240, fps: 30, packets: 45, decodedFrames: 45 });
    const pixel = await pixelsAt(browser, await extractFrame(outputPath, 0.5), [[180, 120], [250, 110]]);
    expect(pixel[0][0]).toBeGreaterThan(180);
    expect(pixel[0][1]).toBeLessThan(60);
    expect(pixel[1][0]).toBeLessThan(40);
  } finally { await browser.close(); await fs.rm(dir, { recursive: true, force: true }); }
}, 60_000);

test('Render plays a fast-forward faster, with the Cursor in step with the page, and the rest as recorded', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'cuetake-fast-'));
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const sourcePath = join(dir, 'source.webm'), outputPath = join(dir, 'final.mp4');
    await fs.writeFile(sourcePath, await syntheticSource(browser, 3.1, 1.5));
    // The pointer sweeps right at 80 CSS px a second of Source time.
    const timeline = { viewport: { width: 320, height: 240 }, duration: 3, pointer: [[0, 40, 200], [3, 280, 200]], events: [] };
    // A white badge band, so it shows against the black page.
    const edit = bare({ fastForward: [{ start: 0.3, end: 2.7, rate: 4 }], fastForwardBadge: { draw: 'fast-forward', band: '#ffffff' } });
    const render = await renderFinal({ sources: [sourcePath], finalPath: outputPath, timeline, ...forRender(edit, dir) });
    expect(render.fastForwards).toEqual([{ start: 0.3, end: expect.closeTo(1.125, 6), rate: 4, frames: [9, 33] }]);
    // 0.3 s as recorded, 0.6 s easing over 1.5 s of Source, 0.9 s at 4×, 0.3 s as recorded: 1.425 s.
    expect(await inspectFinal(outputPath)).toMatchObject({ fps: 30, packets: 43, decodedFrames: 43 });
    // At 0.95 s of the Final the Source is at about 2.4 s: the square has turned green and the Cursor is near x = 232.
    const [square, cursor, behind, badge] = await pixelsAt(browser, await extractFrame(outputPath, 0.95), [[250, 110], [239, 207], [123, 207], [160, 120]]);
    expect(Math.min(...badge)).toBeGreaterThan(200);
    expect(square[1]).toBeGreaterThan(180);
    expect(square[0]).toBeLessThan(60);
    expect(Math.min(...cursor)).toBeGreaterThan(180);
    expect(Math.max(...behind)).toBeLessThan(40);
    // Before the span the Final plays as recorded: still red, the Cursor near x = 56.
    const [early, start, noBadge] = await pixelsAt(browser, await extractFrame(outputPath, 0.2), [[250, 110], [63, 207], [160, 120]]);
    expect(Math.max(...noBadge)).toBeLessThan(40);
    expect(early[0]).toBeGreaterThan(180);
    expect(Math.min(...start)).toBeGreaterThan(180);
  } finally { await browser.close(); await fs.rm(dir, { recursive: true, force: true }); }
}, 60_000);

test('the Director marks a fast-forwarded wait, and refuses Lines and fast-forwards inside one', async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const page = await browser.newPage();
    const said = [], forwarded = [];
    const d = createDirector(followTabs(page), { startedAt: Date.now(), fps: 60 }, { focus: [], wide: [], said, forwarded, pointer: [] });
    await d.wait(100);
    expect(await d.fastForward(async () => { await d.wait(300); return 'ready'; }, { rate: 3 })).toBe('ready');
    expect(forwarded).toEqual([{ t: expect.any(Number), end: expect.any(Number), rate: 3 }]);
    expect(forwarded[0].t).toBeGreaterThanOrEqual(0.1);
    expect(forwarded[0].end - forwarded[0].t).toBeGreaterThanOrEqual(0.29);
    await expect(d.fastForward(() => d.say('wait', 'Waiting.'))).rejects.toThrow("Line 'wait' is said inside d.fastForward");
    await expect(d.fastForward(() => d.fastForward(() => d.wait(10)))).rejects.toThrow('d.fastForward was called inside the one from');
    await expect(d.fastForward(() => d.wait(10), { rate: 0.5 })).rejects.toThrow('d.fastForward needs a rate of at least 1, not 0.5');
    await expect(d.fastForward(Promise.resolve())).rejects.toThrow('d.fastForward needs a function that waits');
    expect(said).toEqual([]);
    expect(forwarded.map(span => span.rate)).toEqual([3, 4, 4]);
  } finally { await browser.close(); }
}, 30_000);

/** Notes each wheel event the page takes: when, by how much, and what it scrolled, as [ms, dx, dy, target id]. */
const noteWheels = () => { window.wheels = []; addEventListener('wheel', e => wheels.push([performance.now(), e.deltaX, e.deltaY, e.target.closest('[id]')?.id ?? '']), { capture: true, passive: true }); };

test('the Director scrolls like a person, a little each frame, fast first and settling long, and lands the target where asked', async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    await page.setContent(`<body style="margin:0"><div style="height:5000px;position:relative">
      <h2 id="far" style="position:absolute;top:2500px;margin:0;height:40px">Far</h2>
      <h2 id="mid" style="position:absolute;top:3200px;margin:0;height:40px">Mid</h2>
      <h2 id="last" style="position:absolute;top:4900px;margin:0;height:40px">Last</h2></div></body>`);
    await page.evaluate(noteWheels);
    const d = createDirector(followTabs(page), { startedAt: Date.now(), fps: 60, speed: 2 }, { focus: [], wide: [], said: [], forwarded: [], pointer: [] });
    await expect(d.scroll('#far', { block: 'top' })).rejects.toThrow("d.scroll needs block 'start', 'center', 'end', 'nearest', not 'top'");
    const box = await d.scroll('#far');
    // 'start' leaves a tenth of the view above the target.
    expect(box.y).toBeCloseTo(48, 0);
    expect(await page.evaluate(() => scrollY)).toBe(2452);
    const wheels = await page.evaluate(() => wheels);
    expect(wheels.length).toBeGreaterThan(10);
    expect(wheels.every(([, dx]) => dx === 0)).toBe(true);
    const span = wheels.at(-1)[0] - wheels[0][0];
    expect(span).toBeGreaterThan(300);
    // Most of the distance goes in the first half of the time; the rest settles slowly.
    const early = wheels.filter(([ms]) => ms - wheels[0][0] < span / 2).reduce((sum, [, , dy]) => sum + dy, 0);
    expect(early).toBeGreaterThan(2452 * 0.6);
    // Already where it was asked to be, a scroll does nothing.
    await d.scroll('#far');
    expect(await page.evaluate(() => wheels.length)).toBe(wheels.length);
    expect((await d.scroll('#mid', { block: 'center', duration: 800 })).y).toBeCloseTo(220, 0);
    const timed = (await page.evaluate(() => wheels)).slice(wheels.length);
    expect(timed.at(-1)[0] - timed[0][0]).toBeGreaterThan(650);
    // A target the page cannot bring to the start goes as far as the page scrolls, and no farther.
    const last = await d.scroll('#last');
    expect(await page.evaluate(() => scrollY)).toBe(5000 - 480);
    expect(last.y).toBeCloseTo(4900 - 4520, 0);
  } finally { await browser.close(); }
}, 30_000);

test('the Director scrolls the page to a container, moves onto it and scrolls it, both ways at once where it scrolls both', async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    const items = Array.from({ length: 50 }, (_, i) => `<div id="item${i}" style="height:40px">Item ${i}</div>`).join('');
    await page.setContent(`<body style="margin:0"><div style="height:1500px"></div>
      <div id="list" style="margin-left:300px;width:300px;height:200px;overflow:auto">${items}</div>
      <div style="height:300px"></div>
      <div id="wide" style="width:400px;height:120px;overflow-x:auto;overflow-y:hidden"><div style="width:3000px;height:100px;position:relative"><span id="cell" style="position:absolute;left:2000px;top:10px;width:80px">Cell</span></div></div>
      <div style="height:300px"></div>
      <div id="both" style="width:300px;height:200px;overflow:auto"><div style="width:2000px;height:2000px;position:relative"><span id="corner" style="position:absolute;left:1500px;top:1500px;width:60px;height:20px">Corner</span></div></div>
      <div style="height:1000px"></div></body>`);
    await page.evaluate(noteWheels);
    const notes = { focus: [], wide: [], said: [], forwarded: [], pointer: [] };
    const moves = [], move = page.mouse.move.bind(page.mouse);
    page.mouse.move = (x, y, options) => { moves.push({ x, y }); return move(x, y, options); };
    const d = createDirector(followTabs(page), { startedAt: Date.now(), fps: 60, speed: 4 }, notes);
    const item = await d.scroll('#item40');
    const list = await page.locator('#list').boundingBox();
    // The page brought the list into view first, then the list scrolled the item to the start of its view.
    expect(list.y).toBeGreaterThanOrEqual(0);
    expect(list.y + list.height).toBeLessThanOrEqual(480);
    expect(item.y - list.y).toBeCloseTo(20, 0);
    const wheels = await page.evaluate(() => wheels), turned = wheels.findIndex(([, , , id]) => id.startsWith('item'));
    expect(turned).toBeGreaterThan(0);
    expect(wheels.slice(0, turned).every(([, , , id]) => !id.startsWith('item'))).toBe(true);
    // The cursor moved onto the list before scrolling it, and stayed on it.
    const onList = ({ x, y }) => x >= list.x && x <= list.x + list.width && y >= list.y && y <= list.y + list.height;
    expect(onList(moves.at(-1))).toBe(true);
    // Sideways: the cell comes into view inside its container; 'nearest' scrolls the page only as far as the cell needs.
    const cell = await d.scroll('#cell', { block: 'nearest' }), wide = await page.locator('#wide').boundingBox();
    expect(cell.x).toBeGreaterThanOrEqual(wide.x);
    expect(cell.x + cell.width).toBeLessThanOrEqual(wide.x + wide.width);
    // A container passing under the resting cursor may take a few of the page's wheel events, as for a person; a scroll is corrected only past 4 px.
    expect(Math.abs(cell.y + cell.height - (480 - 48))).toBeLessThanOrEqual(4);
    // A container that scrolls both ways scrolls diagonally, in one stream of wheel events.
    const before = (await page.evaluate(() => wheels)).length;
    const corner = await d.scroll('#corner', { inline: 'center' }), both = await page.locator('#both').boundingBox();
    expect(corner.x + corner.width / 2).toBeCloseTo(both.x + both.width / 2, 0);
    const diagonal = (await page.evaluate(() => wheels)).slice(before).filter(([, , , id]) => id === 'corner' || id === 'both');
    expect(diagonal.some(([, dx, dy]) => dx > 0 && dy > 0)).toBe(true);
  } finally { await browser.close(); }
}, 30_000);

test('the Director fails a scroll that moves nothing, and one that cannot bring its target into view', async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    await page.setContent(`<body style="margin:0"><div style="height:3000px"><h2 id="far" style="margin-top:2000px">Far</h2></div>
      <script>addEventListener('wheel', e => e.preventDefault(), { passive: false })</script></body>`);
    const d = createDirector(followTabs(page), { startedAt: Date.now(), fps: 60, speed: 4 }, { focus: [], wide: [], said: [], forwarded: [], pointer: [] });
    await expect(d.scroll('#far')).rejects.toThrow('Scroll moved nothing: a wheel at (0, 0) did not scroll the page');
    // Closed, so Chromium does not throttle the next page as one behind it.
    await page.close();
    const framed = await browser.newPage({ viewport: { width: 640, height: 480 } });
    await framed.setContent(`<body style="margin:0"><div style="height:2000px"></div><iframe srcdoc="<p id=deep>Deep</p>" style="height:100px;border:0"></iframe></body>`);
    const e = createDirector(followTabs(framed), { startedAt: Date.now(), fps: 60, speed: 4 }, { focus: [], wide: [], said: [], forwarded: [], pointer: [] });
    await expect(e.scroll(e.page.frameLocator('iframe').locator('#deep'))).rejects.toThrow('Scroll could not bring the target into view');
    await e.scroll(e.page.locator('iframe'));
    expect((await e.scroll(e.page.frameLocator('iframe').locator('#deep'))).y).toBeLessThan(480);
  } finally { await browser.close(); }
}, 30_000);

test('the Director masks every element a locator matches, following it as the page scrolls, inside iframes and when it is replaced', async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    await page.setContent(`<div style="height:2000px"><input data-testid="email" style="position:absolute;left:100px;top:300px;width:200px;height:30px;margin:0;border:0;padding:0">
      <iframe srcdoc="<p id=card style='margin:0;position:absolute;left:10px;top:20px;width:50px;height:10px'>4242</p>" style="position:absolute;left:300px;top:100px;width:200px;height:100px;border:0"></iframe></div>`);
    const startedAtMs = Date.now();
    await installProbe(page);
    const notes = { focus: [], wide: [], said: [], forwarded: [], pointer: [] }, ran = new AbortController();
    const d = createDirector(followTabs(page), { startedAt: startedAtMs, fps: 60, signal: ran.signal }, notes);
    await expect(d.mask(d.page.getByTestId('email'), { effect: 'pixelate' })).rejects.toThrow("d.mask needs effect blur, cover or spotlight, not 'pixelate'");
    const email = await d.mask(d.page.getByTestId('email'));
    await d.mask(d.page.frameLocator('iframe').locator('#card'), { effect: 'cover', color: '#ff0000' });
    await d.wait(200);
    await page.evaluate(() => scrollTo(0, 100));
    await d.wait(300);
    email.end();
    // The page replaces the field with a new one, lower down; the mask follows the new one.
    await page.evaluate(() => { const old = document.querySelector('[data-testid=email]'), next = old.cloneNode(); next.style.top = '500px'; old.replaceWith(next); });
    await d.wait(600);
    ran.abort();
    const spotlight = await d.mask(d.page.getByTestId('email'), { effect: 'spotlight' });
    expect(spotlight.end).toBeFunction();
    expect(notes.elements.slice(0, 2)).toEqual([{ id: 0, tab: 0, name: "getByTestId('email')" }, { id: 1, tab: 0, name: "locator('iframe').contentFrame().locator('#card')" }]);
    // Made before the Director first waited, a blur or cover masks from the start of Capture; a spotlight from when it was made.
    expect(notes.masks.slice(0, 2)).toEqual([{ t: 0, end: expect.any(Number), element: 0, effect: 'blur' }, { t: 0, end: null, element: 1, effect: 'cover', color: '#ff0000' }]);
    expect(notes.masks[0].end).toBeGreaterThan(0.45);
    expect(notes.masks[2].t).toBeGreaterThan(1);
    const { watched } = await collectTimeline(page, startedAtMs);
    const ys = id => watched.find(w => w.id === id).boxes.map(([, ...boxes]) => boxes.map(box => box.join(' ')).join());
    expect(ys(0)[0]).toBe('100 300 200 30');
    expect(ys(0)).toContain('100 200 200 30');
    expect(ys(0).at(-1)).toBe('100 400 200 30');
    // The card is placed through its iframe, and moves up with it as the page scrolls.
    expect(ys(1)[0]).toBe('310 120 50 10');
    expect(ys(1).at(-1)).toBe('310 20 50 10');
  } finally { await browser.close(); }
}, 30_000);

test('Render covers a masked element where it moves, blurs a fixed box past reading, spotlights a box, and Previews show them', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'cuetake-masks-'));
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const sourcePath = join(dir, 'source.webm'), outputPath = join(dir, 'final.mp4');
    // A black page with a red square at 240, 100, 20 CSS px wide.
    await fs.writeFile(sourcePath, await syntheticSource(browser, 1.6));
    const elements = [{ id: 0, tab: 0, name: "getByTestId('email')", boxes: [[0, [20, 150, 40, 40]], [0.7, [100, 150, 40, 40]]] }];
    const timeline = { viewport: { width: 320, height: 240 }, duration: 1.5, elements };
    const edit = bare({ masks: [
      { effect: 'cover', element: 0, color: '#0000ff', padding: 0 },
      { effect: 'blur', box: { x: 236, y: 96, width: 28, height: 28 }, end: 0.6 },
      { effect: 'spotlight', box: { x: 230, y: 90, width: 40, height: 40 }, start: 1.2, ease: 0, feather: 0, dim: 0.5 },
    ] });
    const render = await renderFinal({ sources: [sourcePath], finalPath: outputPath, timeline, ...forRender(edit, dir) });
    expect(render.masks).toEqual([
      { effect: 'cover', element: 0, start: 0, end: 1.5, frames: [0, 44] },
      { effect: 'blur', box: { x: 236, y: 96, width: 28, height: 28 }, start: 0, end: 0.6, frames: [0, 17] },
      { effect: 'spotlight', box: { x: 230, y: 90, width: 40, height: 40 }, start: 1.2, end: 1.5, frames: [36, 44] },
    ]);
    // The cover sits on the element, and the red square's center is blurred into the black around it.
    const [covered, left, square] = await pixelsAt(browser, await extractFrame(outputPath, 0.3), [[40, 170], [120, 170], [250, 110]]);
    expect(covered[2]).toBeGreaterThan(200);
    expect(Math.max(...left)).toBeLessThan(40);
    expect(square[0]).toBeGreaterThan(15);
    expect(square[0]).toBeLessThan(150);
    // After the element moves the cover follows it, and the blur has ended.
    const [moved, gone, sharp] = await pixelsAt(browser, await extractFrame(outputPath, 1), [[120, 170], [40, 170], [250, 110]]);
    expect(moved[2]).toBeGreaterThan(200);
    expect(Math.max(...gone)).toBeLessThan(40);
    expect(sharp[0]).toBeGreaterThan(180);
    // The spotlight dims the cover outside its box, and leaves the square inside it.
    const [lit, dimmed] = await pixelsAt(browser, await extractFrame(outputPath, 1.35), [[250, 110], [120, 170]]);
    expect(lit[0]).toBeGreaterThan(180);
    expect(dimmed[2]).toBeGreaterThan(90);
    expect(dimmed[2]).toBeLessThan(170);
    // A Preview shows the masks as the Final does.
    const { files, tiles } = previewOf(dir, [['current', edit]]);
    const preview = await composePreview({ sources: [sourcePath], timeline, tiles, files, at: 0.3 });
    const [previewed] = await pixelsAt(browser, preview, [[40, 170]]);
    expect(previewed[2]).toBeGreaterThan(200);
    // A mask Render cannot draw stops it, naming the mask.
    await expect(renderFinal({ sources: [sourcePath], finalPath: outputPath, timeline, ...forRender(bare({ masks: [{ effect: 'blur', element: 4 }] }), dir) }))
      .rejects.toThrow('The masks cannot be drawn: Mask 0 (blur) follows element 4, which the Timeline does not record');
  } finally { await browser.close(); await fs.rm(dir, { recursive: true, force: true }); }
}, 60_000);

test('Render dims every window around the spotlights showing together, popups too, and lights each one\'s region', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'cuetake-spotlights-'));
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const sources = [join(dir, 'source-0.webm'), join(dir, 'source-1.webm')], outputPath = join(dir, 'final.mp4');
    // Each Source is black with a red square: at 240, 100 on the page, 20 CSS px wide, and at 120, 50 in
    // the popup, 10 wide. The popup sits centered over the page, at 80, 60, so its square is at 200, 110.
    for (const path of sources) await fs.writeFile(path, await syntheticSource(browser, 1));
    const timeline = { viewport: { width: 320, height: 240 }, duration: 0.9, events: [{ type: 'front', t: 0, tab: 1 }],
      tabs: [{ id: 0, opener: null, viewport: { width: 320, height: 240 } }, { id: 1, opener: 0, viewport: { width: 160, height: 120 } }] };
    const light = { effect: 'spotlight', start: 0.4, ease: 0, feather: 0, dim: 0.5 };
    const edit = bare({ masks: [
      { effect: 'cover', box: { x: 20, y: 20, width: 40, height: 40 }, color: '#0000ff', padding: 0 },
      { effect: 'cover', box: { x: 20, y: 180, width: 40, height: 40 }, color: '#0000ff', padding: 0 },
      { ...light, box: { x: 20, y: 20, width: 40, height: 40 } },
      { ...light, box: { x: 236, y: 96, width: 28, height: 28 } },
    ] });
    await renderFinal({ sources, finalPath: outputPath, timeline, ...forRender(edit, dir) });
    const at = [[40, 40], [250, 110], [40, 200], [205, 115]];
    const [cover, square, other, popup] = await pixelsAt(browser, await extractFrame(outputPath, 0.3), at);
    expect(cover[2]).toBeGreaterThan(200);
    expect(square[0]).toBeGreaterThan(180);
    expect(other[2]).toBeGreaterThan(200);
    expect(popup[0]).toBeGreaterThan(180);
    // Both spotlights light their own region; neither dims the other's. The rest dims, the popup with it.
    const [litCover, litSquare, dimCover, dimPopup] = await pixelsAt(browser, await extractFrame(outputPath, 0.7), at);
    expect(litCover[2]).toBeGreaterThan(200);
    expect(litSquare[0]).toBeGreaterThan(180);
    for (const [value] of [[dimCover[2]], [dimPopup[0]]]) {
      expect(value).toBeGreaterThan(90);
      expect(value).toBeLessThan(170);
    }
  } finally { await browser.close(); await fs.rm(dir, { recursive: true, force: true }); }
}, 60_000);

test('Render draws a Desktop only inside the App windows showing, each clipped to its frame, with the Background between them', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'cuetake-desktop-'));
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    // The Source is a 320×240-point Desktop at scale 2: black, with a red square at 240, 100, 20 points wide.
    const source = join(dir, 'source-0.webm'), outputPath = join(dir, 'final.mp4');
    await fs.writeFile(source, await syntheticSource(browser, 1));
    await fs.writeFile(join(dir, 'blue.glsl'), 'void main() { color = vec4(0.0, 0.0, 1.0, 1.0); }');
    const viewport = { width: 320, height: 240 }, window = { id: 1, layer: 0, x: 0, y: 0, width: 200, height: 150, radius: 0 };
    const menu = { id: 2, layer: 101, x: 220, y: 90, width: 60, height: 40, radius: 0 };
    const timeline = { viewport, duration: 0.9, tabs: [{ id: 0, opener: null, viewport }], windows: [{ t: 0, shown: [window] }, { t: 0.5, shown: [window, menu] }] };
    await renderFinal({ sources: [source], finalPath: outputPath, timeline, ...forRender(bare({ frame: { background: [{ shader: 'blue.glsl' }] } }), dir) });
    const at = [[100, 75], [250, 110], [300, 200], [210, 120]];
    const [inWindow, square, outside, between] = await pixelsAt(browser, await extractFrame(outputPath, 0.2), at);
    expect(inWindow[2]).toBeLessThan(60);
    // Before the menu opens, the square it will show is not drawn: only the Background is there.
    for (const pixel of [square, outside, between]) expect(pixel[2]).toBeGreaterThan(200);
    const [, shownSquare, stillOutside] = await pixelsAt(browser, await extractFrame(outputPath, 0.7), at);
    expect(shownSquare[0]).toBeGreaterThan(180);
    expect(shownSquare[2]).toBeLessThan(80);
    expect(stillOutside[2]).toBeGreaterThan(200);
  } finally { await browser.close(); await fs.rm(dir, { recursive: true, force: true }); }
}, 60_000);

test('Render draws the built-in cursor at the pointer and a spark around each click', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'cuetake-cursor-'));
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const sourcePath = join(dir, 'source.webm'), outputPath = join(dir, 'final.mp4');
    await fs.writeFile(sourcePath, await syntheticSource(browser, 0.6));
    const timeline = { viewport: { width: 320, height: 240 }, duration: 1, pointer: [[0, 60, 60], [1, 60, 60]], events: [{ type: 'click', t: 0.2, x: 200, y: 60 }] };
    await renderFinal({ sources: [sourcePath], finalPath: outputPath, timeline, ...forRender(bare({ clickEffect: { draw: 'spark' } }), dir) });
    // A spark ray sits ~26 px from the click along 22.5° at t=0.3; the arrow's body lies along the diagonal below-right of its tip.
    const ray = [Math.round(200 + 26 * Math.cos(Math.PI / 8)), Math.round(60 + 26 * Math.sin(Math.PI / 8))];
    const [arrow, spark, clear] = await pixelsAt(browser, await extractFrame(outputPath, 0.3), [[67, 67], ray, [120, 200]]);
    expect(Math.min(...arrow)).toBeGreaterThan(180);
    expect(Math.min(...spark)).toBeGreaterThan(110);
    expect(Math.max(...clear)).toBeLessThan(40);
    const [gone] = await pixelsAt(browser, await extractFrame(outputPath, 0.9), [ray]);
    expect(Math.max(...gone)).toBeLessThan(40);
  } finally { await browser.close(); await fs.rm(dir, { recursive: true, force: true }); }
}, 60_000);

test('Render draws the Cursor in the shape the page asked for, pressed while held, and shown while still', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'cuetake-cursor-'));
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const sourcePath = join(dir, 'source.webm'), outputPath = join(dir, 'final.mp4');
    await fs.writeFile(sourcePath, await syntheticSource(browser, 0.6));
    const timeline = {
      viewport: { width: 320, height: 240 }, duration: 2.6, pointer: [[0, 60, 60]], shapes: [[0, 'default'], [0.4, 'pointer']],
      events: [{ type: 'click', t: 0.8, end: 0.9, x: 60, y: 60 }],
    };
    await renderFinal({ sources: [sourcePath], finalPath: outputPath, timeline, ...forRender(bare(), dir) });
    const frame = async (t, points) => (await pixelsAt(browser, await extractFrame(outputPath, t), points)).map(rgb => Math.min(...rgb));
    // The arrow's body is right of its tip; the hand's thumb is left of the fingertip, and its palm reaches lower.
    const arrow = [67, 67], thumb = [54, 74], palm = [64, 82];
    const [arrowBody, noThumb] = await frame(0.1, [arrow, thumb]);
    expect(arrowBody).toBeGreaterThan(180);
    expect(noThumb).toBeLessThan(60);
    const [hand, palmUp] = await frame(0.5, [thumb, palm]);
    expect(hand).toBeGreaterThan(180);
    expect(palmUp).toBeGreaterThan(180);
    // Held, the hand shrinks toward its fingertip; released, it springs back.
    expect((await frame(0.9, [palm]))[0]).toBeLessThan(60);
    expect((await frame(1.3, [palm]))[0]).toBeGreaterThan(180);
    // Still to the end, it stays shown.
    const still = await frame(2.4, [thumb, palm]);
    expect(Math.min(...still)).toBeGreaterThan(180);
  } finally { await browser.close(); await fs.rm(dir, { recursive: true, force: true }); }
}, 60_000);

/** How wide part-lit red runs in a PNG's rows, as a sharp red edge blurred sideways over black does, and how many pixels are part-lit gray, as the white Cursor blurred is. */
async function partLit(browser, png) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async data => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const ctx = Object.assign(document.createElement('canvas'), { width: image.width, height: image.height }).getContext('2d');
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, image.width, image.height).data, counts = { red: 0, gray: 0 };
      for (let y = 0; y < image.height; y++) {
        let row = 0, lit = false;
        for (let x = 0; x < image.width; x++) {
          const i = (y * image.width + x) * 4, [r, g, b] = pixels.slice(i, i + 3);
          if (r > 50 && r < 200 && g < 30 && b < 30) row++;
          if (r >= 200 && g < 30 && b < 30) lit = true;
          if (r > 50 && r < 200 && Math.abs(r - g) < 20 && Math.abs(r - b) < 20) counts.gray++;
        }
        // Only rows through the square count, not those along its top and bottom edges.
        if (lit) counts.red = Math.max(counts.red, row);
      }
      return counts;
    }, png.toString('base64'));
  } finally { await page.close(); }
}

test('Render blurs the window while the camera moves and the Cursor while it moves, and leaves still frames sharp', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'cuetake-blur-'));
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const sourcePath = join(dir, 'source.webm');
    await fs.writeFile(sourcePath, await syntheticSource(browser, 0.6));
    // The Cursor sweeps across the page in a tenth of a second, then the camera zooms quickly onto the red square.
    const timeline = { viewport: { width: 320, height: 240 }, duration: 3, pointer: [[0, 20, 200], [0.3, 20, 200], [0.4, 300, 200]], events: [] };
    const camera = { response: 0.15, follow: false, hold: 0.5, endWide: 1, targets: [{ t: 1, box: { x: 230, y: 90, width: 40, height: 40 } }] };
    const finals = {};
    for (const shutter of [0.5, 0]) {
      const finalPath = join(dir, `final-${shutter}.mp4`);
      finals[shutter] = { path: finalPath, render: await renderFinal({ sources: [sourcePath], finalPath, timeline, ...forRender(bare({ camera, output: { shutter } }), dir) }) };
    }
    expect(finals[0.5].render.motionBlur.shutter).toBe(0.5);
    expect(finals[0.5].render.motionBlur.frames.camera).toBeGreaterThan(3);
    expect(finals[0.5].render.motionBlur.frames.cursor).toBeGreaterThan(1);
    expect(finals[0].render.motionBlur.frames).toEqual({ camera: 0, cursor: 0 });
    const lit = async (shutter, t) => partLit(browser, await extractFrame(finals[shutter].path, t));

    // Mid-sweep, the blurred Cursor leaves a gray streak where the sharp one has only its edges.
    const [sweeping, sweepingSharp] = [await lit(0.5, 0.35), await lit(0, 0.35)];
    expect(sweeping.gray).toBeGreaterThan(sweepingSharp.gray * 3 + 20);

    // Mid-zoom, the square's sharp sides spread sideways into part-lit red.
    let zooming = 0, zoomingSharp = 0;
    for (let t = 0.43; t < 0.65; t += 1 / 30) {
      zooming = Math.max(zooming, (await lit(0.5, t)).red);
      zoomingSharp = Math.max(zoomingSharp, (await lit(0, t)).red);
    }
    expect(zooming).toBeGreaterThan(zoomingSharp * 2 + 4);

    // Settled on the square with the Cursor still, the frame is as sharp as without a shutter.
    const [still, stillSharp] = [await lit(0.5, 1.2), await lit(0, 1.2)];
    expect(Math.abs(still.red - stillSharp.red)).toBeLessThan(2);
    expect(Math.abs(still.gray - stillSharp.gray)).toBeLessThan(6);
  } finally { await browser.close(); await fs.rm(dir, { recursive: true, force: true }); }
}, 90_000);

test('Render shows keycaps for each Shortcut outside the camera, fading in and out', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'cuetake-keycaps-'));
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const sourcePath = join(dir, 'source.webm'), outputPath = join(dir, 'final.mp4');
    await fs.writeFile(sourcePath, await syntheticSource(browser, 0.6));
    // An opaque red cap shows where the built-in draws; zoomed in, it must stay put.
    const edit = bare({
      keycaps: { cap: '#ff0000', edge: '#ff0000', bottom: 300 }, shortcuts: [{ t: 0.5, keys: ['Meta', 'K'] }],
      camera: { maxZoom: 2, padding: 0, lead: 0.1, response: 0.1, hold: 2, endWide: 0, follow: false, targets: [{ t: 0.2, box: { x: 240, y: 100, width: 20, height: 20 } }] },
    });
    const render = await renderFinal({ sources: [sourcePath], finalPath: outputPath, timeline: { viewport: { width: 320, height: 240 }, duration: 2.4 }, ...forRender(edit, dir) });
    expect(render.keycaps).toEqual([{ t: 0.5, keys: ['Meta', 'K'], presses: 1, frames: [15, 59] }]);
    // On a 320×240 Final a 1080p pixel is 2/9 of an output pixel: the row ends 80 from the right, so the ⌘ cap
    // spans about 271 to 286 px across and 159 to 173 px down, 300 above the bottom; this point is inside it,
    // left of the symbol.
    const cap = [273, 168];
    const red = rgb => rgb[0] > 180 && rgb[1] < 80;
    expect(red((await pixelsAt(browser, await extractFrame(outputPath, 0.4), [cap]))[0])).toBe(false);
    expect(red((await pixelsAt(browser, await extractFrame(outputPath, 1), [cap]))[0])).toBe(true);
    expect(red((await pixelsAt(browser, await extractFrame(outputPath, 2.2), [cap]))[0])).toBe(false);
  } finally { await browser.close(); await fs.rm(dir, { recursive: true, force: true }); }
}, 60_000);

test('Render turns the busy ball once a second', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'cuetake-cursor-'));
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const sourcePath = join(dir, 'source.webm'), outputPath = join(dir, 'final.mp4');
    await fs.writeFile(sourcePath, await syntheticSource(browser, 0.6));
    const timeline = { viewport: { width: 320, height: 240 }, duration: 1.2, pointer: [[0, 160, 120]], shapes: [[0, 'wait']], events: [] };
    await renderFinal({ sources: [sourcePath], finalPath: outputPath, timeline, ...forRender(bare(), dir) });
    // A point on the ball changes color as it turns, and comes back a second later.
    const colorAt = async t => (await pixelsAt(browser, await extractFrame(outputPath, t), [[166, 120]]))[0];
    const [first, turned, again] = [await colorAt(0.15), await colorAt(0.4), await colorAt(1.15)];
    const apart = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
    expect(apart(first, turned)).toBeGreaterThan(60);
    expect(apart(first, again)).toBeLessThan(30);
  } finally { await browser.close(); await fs.rm(dir, { recursive: true, force: true }); }
}, 60_000);

test('Render frames the page in the built-in chrome over an agent shader Background, with its parameters', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'cuetake-frame-'));
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const sourcePath = join(dir, 'source.webm'), outputPath = join(dir, 'final.mp4');
    await fs.writeFile(sourcePath, await syntheticSource(browser, 0.6));
    await fs.writeFile(join(dir, 'solid.glsl'), 'void main() { color = vec4(tint, 1.0); }');
    const viewport = { width: 320, height: 240 };
    const edit = bare({ output: { width: 854, height: 480 }, frame: { padding: 0.08, radius: 12, url: 'example.com', chrome: { draw: 'browser' }, background: [{ shader: 'solid.glsl', tint: '#2050e0' }] } });
    await renderFinal({ sources: [sourcePath], finalPath: outputPath, timeline: { viewport, duration: 1 }, ...forRender(edit, dir) });
    const stage = layout(edit, viewport, 44);
    expect(await inspectFinal(outputPath)).toMatchObject({ width: 854, height: 480, decodedFrames: 30 });
    const pageCenter = [Math.round(stage.page.x + stage.page.w * 0.3), Math.round(stage.page.y + stage.page.h / 2)];
    const chrome = [Math.round(stage.window.x + stage.window.w * 0.8), Math.round(stage.window.y + stage.chrome / 2)];
    const [background, page, bar] = await pixelsAt(browser, await extractFrame(outputPath, 0.5), [[4, 4], pageCenter, chrome]);
    expect(background[0]).toBeLessThan(60); expect(background[2]).toBeGreaterThan(190);
    expect(Math.max(...page)).toBeLessThan(40);              // the black Source
    expect(Math.min(...bar)).toBeGreaterThan(220);           // light chrome bar
    // The address bar changes text from the Source time a navigation committed on another host.
    const moved = { ...edit, frame: { ...edit.frame, urls: [{ t: 0.5, url: 'checkout.stripe.test/pay' }] } };
    await renderFinal({ sources: [sourcePath], finalPath: outputPath, timeline: { viewport, duration: 1 }, ...forRender(moved, dir) });
    const field = Array.from({ length: 120 }, (_, i) => [Math.round(stage.window.x + stage.window.w * (0.3 + 0.4 * i / 120)), Math.round(stage.window.y + stage.chrome / 2)]);
    const ink = rgb => Math.min(...rgb) < 200;
    const early = (await pixelsAt(browser, await extractFrame(outputPath, 0.2), field)).map(ink);
    const late = (await pixelsAt(browser, await extractFrame(outputPath, 0.8), field)).map(ink);
    const again = (await pixelsAt(browser, await extractFrame(outputPath, 0.3), field)).map(ink);
    expect(early.filter(Boolean).length).toBeGreaterThan(3);
    expect(late.filter(Boolean).length).toBeGreaterThan(early.filter(Boolean).length);  // a longer address
    expect(again).toEqual(early);
  } finally { await browser.close(); await fs.rm(dir, { recursive: true, force: true }); }
}, 60_000);

test('Render draws the chrome even when its sharpest size is past what the GPU holds in one texture', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'cuetake-wide-chrome-'));
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const sourcePath = join(dir, 'source.webm'), outputPath = join(dir, 'final.mp4');
    await fs.writeFile(sourcePath, await syntheticSource(browser, 0.4));
    // A wide viewport and a deep zoom ask for a chrome sprite over 11,000 px wide; GPUs without a
    // discrete card often hold 8192 at most.
    const viewport = { width: 1440, height: 900 };
    const edit = bare({ output: { width: 854, height: 480 }, camera: { maxZoom: 8 }, frame: { padding: 0.08, radius: 12, url: 'example.com', chrome: { draw: 'browser' }, background: [{ shader: 'fluted' }] } });
    const stage = layout(edit, viewport, 44);
    expect(viewport.width * stage.scale * 8 * 2).toBeGreaterThan(8192);
    await renderFinal({ sources: [sourcePath], finalPath: outputPath, timeline: { viewport, duration: 0.5 }, ...forRender(edit, dir) });
    const bar = [Math.round(stage.window.x + stage.window.w * 0.8), Math.round(stage.window.y + stage.chrome / 2)];
    const [pixel] = await pixelsAt(browser, await extractFrame(outputPath, 0.25), [bar]);
    expect(Math.min(...pixel)).toBeGreaterThan(220);           // the light chrome bar, not black
  } finally { await browser.close(); await fs.rm(dir, { recursive: true, force: true }); }
}, 60_000);

test('a Preview composes each Look over the Source exactly where Render would place it', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'cuetake-preview-'));
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const sourcePath = join(dir, 'source.webm');
    await fs.writeFile(sourcePath, await syntheticSource(browser, 0.6));
    const viewport = { width: 320, height: 240 }, timeline = { viewport, duration: 1, pointer: [], events: [] };
    const filled = bare({ output: { width: 1440, height: 1080 } });
    const [red] = await pixelsAt(browser, await composePreview({ sources: [sourcePath], timeline, ...previewOf(dir, [['current', filled]]) }), [[250 * 4.5, 110 * 4.5]]);
    expect(red[0]).toBeGreaterThan(180);
    expect(red[1]).toBeLessThan(60);

    // An SVG image layer, and the default fluted glass with its soft shadow.
    await fs.writeFile(join(dir, 'paper.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"><rect width="16" height="9" fill="#f4f4f5"/></svg>');
    const framed = background => withDefaults({ output: { width: 1920, height: 1080 }, frame: { url: 'example.com', ...(background && { background }) } });
    const edits = [framed([{ image: 'paper.svg' }]), framed()];
    const png = await composePreview({ sources: [sourcePath], timeline, at: 0.5, ...previewOf(dir, edits.map((edit, i) => [`tile ${i}`, edit])) });
    const sheet = previewSheet(edits.map(outputSize));
    const stage = layout(edits[0], viewport, 44);
    const corner = tile => [Math.round(tile.x + 6), Math.round(tile.y + 6)];
    const glow = tile => [Math.round(tile.x + 20), Math.round(tile.y + tile.h - 20)];   // where the brand light sits
    const page = tile => [Math.round(tile.x + (stage.page.x + stage.page.w * 0.3) / 2), Math.round(tile.y + (stage.page.y + stage.page.h / 2) / 2)];
    const [paper, fluted, paperPage, flutedPage] = await pixelsAt(browser, png, [corner(sheet.tiles[0]), glow(sheet.tiles[1]), page(sheet.tiles[0]), page(sheet.tiles[1])]);
    expect(Math.min(...paper)).toBeGreaterThan(200);
    expect(fluted[0]).toBeGreaterThan(fluted[1] + 30);   // lit by the red square's brand color
    expect(Math.max(...paperPage, ...flutedPage)).toBeLessThan(40);   // the black Source in both windows
  } finally { await browser.close(); await fs.rm(dir, { recursive: true, force: true }); }
}, 60_000);

test('styling code errors name their file and line, and the render page refuses the network', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'cuetake-errors-'));
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const sourcePath = join(dir, 'source.webm');
    await fs.writeFile(sourcePath, await syntheticSource(browser, 0.6));
    const timeline = { viewport: { width: 320, height: 240 }, duration: 1, pointer: [], events: [] };
    const preview = edit => composePreview({ sources: [sourcePath], timeline, ...previewOf(dir, [['current', edit]]) });
    await fs.writeFile(join(dir, 'bad.glsl'), 'void main() {\n  color = vec4(missing);\n}');
    await expect(preview(bare({ frame: { background: [{ shader: 'bad.glsl' }] } }))).rejects.toThrow(/bad\.glsl: .*0:2/);
    await fs.writeFile(join(dir, 'remote.js'), "export const height = 30;\nawait fetch('https://example.com/font.woff2');\nexport function draw() {}");
    await expect(preview(bare({ frame: { chrome: { draw: 'remote.js' } } }))).rejects.toThrow('no network and refused https://example.com/font.woff2');
  } finally { await browser.close(); await fs.rm(dir, { recursive: true, force: true }); }
}, 60_000);

/** A mono 16-bit WAV of a 440 Hz tone, `seconds` long. */
function toneWav(seconds, rate = 24000) {
  const n = Math.round(seconds * rate), data = Buffer.alloc(44 + n * 2);
  data.write('RIFF', 0); data.writeUInt32LE(36 + n * 2, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 16000), 44 + i * 2);
  return data;
}

/**
 * Runs `measure(samples, sampleRate, arg)` in a page over a Final's audio as the browser decodes it.
 * `measure` is sent as source, so it can use nothing from outside itself.
 */
async function finalAudio(browser, path, measure, arg) {
  const page = await browser.newPage();
  try {
    await page.route('**/*', route => route.request().url().endsWith('/final.mp4')
      ? fs.readFile(path).then(body => route.fulfill({ body, contentType: 'video/mp4' }))
      : route.fulfill({ body: '<!doctype html>', contentType: 'text/html' }));
    await page.goto('https://levels.invalid/');
    return await page.evaluate(async ([source, arg]) => {
      const buffer = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(await (await fetch('/final.mp4')).arrayBuffer());
      return (0, eval)(source)(buffer.getChannelData(0), buffer.sampleRate, arg);
    }, [measure.toString(), arg]);
  } finally { await page.close(); }
}

/** The RMS level of a Final's audio in each [from, to] window of seconds. */
function audioLevels(browser, path, windows) {
  return finalAudio(browser, path, (samples, rate, windows) => windows.map(([from, to]) => {
    const part = samples.subarray(Math.round(from * rate), Math.round(to * rate));
    return Math.sqrt(part.reduce((sum, v) => sum + v * v, 0) / part.length);
  }), windows);
}

/** The first moment at or after each of `froms` (seconds) that a Final's audio is audible. */
function audioOnsets(browser, path, froms) {
  return finalAudio(browser, path, (samples, rate, froms) => froms.map(from => {
    for (let i = Math.round(from * rate); i < samples.length; i++) if (Math.abs(samples[i]) > 0.05) return i / rate;
    return null;
  }), froms);
}

test('Render mixes each Line in at its start, as long as the video, and burns in its Subtitles outside the camera', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'cuetake-narration-'));
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const sourcePath = join(dir, 'source.webm'), outputPath = join(dir, 'final.mp4');
    await fs.writeFile(sourcePath, await syntheticSource(browser, 0.6));
    await fs.writeFile(join(dir, 'a.wav'), toneWav(0.5));
    await fs.writeFile(join(dir, 'b.wav'), toneWav(0.4));
    const narration = { language: 'en', volume: 1, lines: [
      { id: 'a', start: 0.3, text: 'Open the editor.', path: join(dir, 'a.wav') },
      { id: 'b', start: 1.4, text: 'Done.', volume: 0.5, path: join(dir, 'b.wav') },
    ] };
    // An opaque red band shows where the built-in draws; zoomed in, it must stay put.
    const edit = bare({ subtitles: { band: '#ff0000' }, camera: { maxZoom: 2, padding: 0, lead: 0.1, response: 0.1, hold: 2, endWide: 0, follow: false, targets: [{ t: 0.2, box: { x: 240, y: 100, width: 20, height: 20 } }] } });
    const render = await renderFinal({ sources: [sourcePath], finalPath: outputPath, timeline: { viewport: { width: 320, height: 240 }, duration: 2 }, ...forRender(edit, dir), narration });
    expect(render.lines).toEqual([{ id: 'a', start: 0.3, duration: 0.5 }, { id: 'b', start: 1.4, duration: 0.4 }]);
    expect(render.subtitles.map(({ id, start, end, rows, frames }) => ({ id, start, end, rows, frames }))).toEqual([
      { id: 'a', start: 0.3, end: expect.closeTo(1.3, 6), rows: ['Open the editor.'], frames: [9, 38] },
      { id: 'b', start: 1.4, end: 2, rows: ['Done.'], frames: [42, 59] },
    ]);
    const media = await inspectFinal(outputPath, [{ id: 'a', path: join(dir, 'a.wav') }]);
    expect(media.audio).toMatchObject({ channels: 1, sampleRate: 48000 });
    // The encoder's priming is declared, not played, and the audio ends within one AAC frame of the video.
    expect(media.audio.duration).toBeGreaterThanOrEqual(2);
    expect(media.audio.duration).toBeLessThan(2 + 1024 / 48000);
    expect(media.audio.decoded).toBeGreaterThan(0);
    const [aStarts, bStarts] = await audioOnsets(browser, outputPath, [0, 1.35]);
    expect(Math.abs(aStarts - 0.3)).toBeLessThan(0.005);
    expect(Math.abs(bStarts - 1.4)).toBeLessThan(0.005);
    expect(media.lines).toEqual([{ id: 'a', duration: 0.5 }]);
    const [silent, first, gap, second] = await audioLevels(browser, outputPath, [[0, 0.25], [0.4, 0.7], [0.9, 1.3], [1.5, 1.7]]);
    expect(silent).toBeLessThan(0.01);
    expect(first).toBeGreaterThan(0.25);
    expect(gap).toBeLessThan(0.01);
    expect(second).toBeGreaterThan(0.1); expect(second).toBeLessThan(first * 0.7);
    const band = [160, 207]; // the band's top padding, above the text
    const [during] = await pixelsAt(browser, await extractFrame(outputPath, 0.6), [band]);
    const [before] = await pixelsAt(browser, await extractFrame(outputPath, 0.1), [band]);
    expect(during[0]).toBeGreaterThan(200); expect(during[1]).toBeLessThan(60);
    expect(Math.max(...before)).toBeLessThan(40);
  } finally { await browser.close(); await fs.rm(dir, { recursive: true, force: true }); }
}, 60_000);

test('Render refuses Lines that overlap or run past the end, naming them, and audio it cannot decode', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'cuetake-overlap-'));
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const sourcePath = join(dir, 'source.webm');
    await fs.writeFile(sourcePath, await syntheticSource(browser, 0.6));
    await fs.writeFile(join(dir, 'a.wav'), toneWav(0.8));
    await fs.writeFile(join(dir, 'bad.wav'), 'not audio');
    const render = lines => renderFinal({ sources: [sourcePath], finalPath: join(dir, 'final.mp4'), timeline: { viewport: { width: 320, height: 240 }, duration: 1 }, ...forRender(bare(), dir), narration: { language: 'en', lines } });
    const line = (id, start, file = 'a.wav') => ({ id, start, text: 'Hello.', path: join(dir, file) });
    await expect(render([line('a', 0), line('b', 0.5)])).rejects.toThrow("Line 'a' overlaps 'b' by 0.30 s; Line 'b' runs 0.30 s past the end of the Final");
    await expect(render([line('a', 0, 'bad.wav')])).rejects.toThrow("Line 'a': its audio bad.wav is not a format the browser decodes");
  } finally { await browser.close(); await fs.rm(dir, { recursive: true, force: true }); }
}, 60_000);
