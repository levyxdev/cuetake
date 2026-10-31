import { test, expect } from 'bun:test';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { saveAuthState, resolveAuthProfile } from '../src/auth.js';
import { installProbe, collectTimeline } from '../src/probe.js';
import { createDirector } from '../src/director.js';
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
 * 127.0.0.2 are three sites and Chromium puts each one's iframes in its own process.
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
      <div style="position:fixed;left:50%;top:70%;transform:translate(-50%,-50%)"><iframe id="modal" src="http://127.0.0.2:PORT/checkout" style="border:0;width:200px;height:120px"></iframe></div></body>`,
    '/outer': '<body style="margin:0;height:1000px"><div style="height:40px"></div><iframe id="inner" src="http://127.0.0.2:PORT/checkout" style="border:0;width:300px;height:150px;margin-left:30px"></iframe></body>',
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
    // Placed as if only scaled, so near but not exactly where it landed, and noted with both keys of Meta+K.
    expect(Math.hypot(rotated.x - (tilted.x + tilted.width / 2), rotated.y - (tilted.y + tilted.height / 2))).toBeLessThan(15);
    expect(timeline.turned).toHaveLength(3);
    expect(timeline.turned[0]).toBe(rotated.t);
    expect(timeline.turned).toContain(timeline.events.find(e => e.type === 'shortcut').t);
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
    '/outer': '<body style="margin:0"><iframe id="inner" src="http://127.0.0.2:PORT/form" style="border:2px solid;padding:5px;width:220px;height:120px;margin:10px"></iframe></body>',
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
    const d = createDirector(page, startedAtMs, 60, [], [], [], [], null, { speed: 4 });
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
    const { sessionId } = await startRecording(`http://127.0.0.1:${server.port}/`, { width: 320, height: 240, resolutionScale: 1, fps: 30, outputDir: dir, deferCapture: true });
    const recorded = getRecordingPage(sessionId);
    const startedAtMs = Date.parse((await beginCapture(sessionId)).startedAt);
    await recorded.waitForTimeout(500);
    await Promise.all([recorded.waitForURL('**/next'), recorded.mouse.click(100, 100)]);
    await recorded.waitForTimeout(500);
    await recorded.reload();
    await recorded.waitForTimeout(300);
    await recorded.mouse.move(200, 50, { steps: 4 });
    await recorded.waitForTimeout(500);
    const timeline = await collectTimeline(recorded, startedAtMs);
    const { webmPath, durationSeconds, navigations } = await stopRecording(sessionId);
    const capture = JSON.parse(await fs.readFile(webmPath.replace(/\.webm$/, '-capture.json'), 'utf8'));
    // Both loads are noted, in order, each from its request until its document loaded.
    expect(navigations.map(n => new URL(n.url).pathname)).toEqual(['/next', '/next']);
    expect(navigations[0].t).toBeGreaterThan(0.4);
    for (const n of navigations) expect(n.end).toBeGreaterThanOrEqual(n.t);
    expect(navigations[1].t).toBeGreaterThan(navigations[0].end);
    expect(capture.navigations).toEqual(navigations);
    // The probe saw input on both documents, on the one clock from the start of Capture.
    expect(timeline.events.filter(e => e.type === 'click')).toHaveLength(1);
    expect(timeline.pointer.at(-1)).toEqual([expect.any(Number), 200, 50]);
    expect(timeline.pointer.at(-1)[0]).toBeGreaterThan(navigations[1].end);
    // The Source kept recording after each load, and shows the first page, then the second.
    expect(capture.frames.some(f => f.timeMs / 1000 > navigations[1].end)).toBe(true);
    expect(capture.settings.width).toBe(320);
    expect(durationSeconds).toBeGreaterThan(navigations[1].end);
    const [before] = await pixelsAt(browser, await extractFrame(webmPath, 0.2), [[300, 220]]);
    const [after] = await pixelsAt(browser, await extractFrame(webmPath, durationSeconds - 0.2), [[300, 220]]);
    expect(before[0]).toBeGreaterThan(180);
    expect(after[1]).toBeGreaterThan(150);
    expect(after[0]).toBeLessThan(80);
    expect(capture.pageFrames.length).toBeGreaterThan(0);
  } finally { await cleanup(); await browser.close(); server.close(); await fs.rm(dir, { recursive: true, force: true }); }
}, 60_000);

test('Render maps CSS camera targets onto the 2× Source and holds the last frame to the Take duration', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'cuetake-render-'));
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const sourcePath = join(dir, 'source.webm'), outputPath = join(dir, 'final.mp4');
    await fs.writeFile(sourcePath, await syntheticSource(browser, 0.6));
    const edit = bare({ camera: { maxZoom: 2, padding: 0, lead: 0.1, response: 0.1, hold: 2, endWide: 0, follow: false, targets: [{ t: 0.2, box: { x: 240, y: 100, width: 20, height: 20 } }] } });
    await renderFinal({ sourcePath, finalPath: outputPath, timeline: { viewport: { width: 320, height: 240 }, duration: 1.5 }, ...forRender(edit, dir) });
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
    const render = await renderFinal({ sourcePath, finalPath: outputPath, timeline, ...forRender(edit, dir) });
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
    const d = createDirector(page, Date.now(), 60, [], [], said, forwarded);
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

test('Render draws the built-in cursor at the pointer and a spark around each click', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'cuetake-cursor-'));
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const sourcePath = join(dir, 'source.webm'), outputPath = join(dir, 'final.mp4');
    await fs.writeFile(sourcePath, await syntheticSource(browser, 0.6));
    const timeline = { viewport: { width: 320, height: 240 }, duration: 1, pointer: [[0, 60, 60], [1, 60, 60]], events: [{ type: 'click', t: 0.2, x: 200, y: 60 }] };
    await renderFinal({ sourcePath, finalPath: outputPath, timeline, ...forRender(bare({ clickEffect: { draw: 'spark' } }), dir) });
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
    await renderFinal({ sourcePath, finalPath: outputPath, timeline, ...forRender(bare(), dir) });
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
    const render = await renderFinal({ sourcePath, finalPath: outputPath, timeline: { viewport: { width: 320, height: 240 }, duration: 2.4 }, ...forRender(edit, dir) });
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
    await renderFinal({ sourcePath, finalPath: outputPath, timeline, ...forRender(bare(), dir) });
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
    await renderFinal({ sourcePath, finalPath: outputPath, timeline: { viewport, duration: 1 }, ...forRender(edit, dir) });
    const stage = layout(edit, viewport, 44);
    expect(await inspectFinal(outputPath)).toMatchObject({ width: 854, height: 480, decodedFrames: 30 });
    const pageCenter = [Math.round(stage.page.x + stage.page.w * 0.3), Math.round(stage.page.y + stage.page.h / 2)];
    const chrome = [Math.round(stage.window.x + stage.window.w * 0.8), Math.round(stage.window.y + stage.chrome / 2)];
    const [background, page, bar] = await pixelsAt(browser, await extractFrame(outputPath, 0.5), [[4, 4], pageCenter, chrome]);
    expect(background[0]).toBeLessThan(60); expect(background[2]).toBeGreaterThan(190);
    expect(Math.max(...page)).toBeLessThan(40);              // the black Source
    expect(Math.min(...bar)).toBeGreaterThan(220);           // light chrome bar
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
    const [red] = await pixelsAt(browser, await composePreview({ sourcePath, timeline, ...previewOf(dir, [['current', filled]]) }), [[250 * 4.5, 110 * 4.5]]);
    expect(red[0]).toBeGreaterThan(180);
    expect(red[1]).toBeLessThan(60);

    // An SVG image layer, and the default fluted glass with its soft shadow.
    await fs.writeFile(join(dir, 'paper.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"><rect width="16" height="9" fill="#f4f4f5"/></svg>');
    const framed = background => withDefaults({ output: { width: 1920, height: 1080 }, frame: { url: 'example.com', ...(background && { background }) } });
    const edits = [framed([{ image: 'paper.svg' }]), framed()];
    const png = await composePreview({ sourcePath, timeline, at: 0.5, ...previewOf(dir, edits.map((edit, i) => [`tile ${i}`, edit])) });
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
    const preview = edit => composePreview({ sourcePath, timeline, ...previewOf(dir, [['current', edit]]) });
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

/** The RMS level of a Final's audio in each [from, to] window of seconds. */
async function audioLevels(browser, path, windows) {
  const page = await browser.newPage();
  try {
    await page.route('**/*', route => route.request().url().endsWith('/final.mp4')
      ? fs.readFile(path).then(body => route.fulfill({ body, contentType: 'video/mp4' }))
      : route.fulfill({ body: '<!doctype html>', contentType: 'text/html' }));
    await page.goto('https://levels.invalid/');
    return await page.evaluate(async windows => {
      const buffer = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(await (await fetch('/final.mp4')).arrayBuffer());
      const samples = buffer.getChannelData(0);
      return windows.map(([from, to]) => {
        const part = samples.subarray(Math.round(from * buffer.sampleRate), Math.round(to * buffer.sampleRate));
        return Math.sqrt(part.reduce((sum, v) => sum + v * v, 0) / part.length);
      });
    }, windows);
  } finally { await page.close(); }
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
    const render = await renderFinal({ sourcePath, finalPath: outputPath, timeline: { viewport: { width: 320, height: 240 }, duration: 2 }, ...forRender(edit, dir), narration });
    expect(render.lines).toEqual([{ id: 'a', start: 0.3, duration: 0.5 }, { id: 'b', start: 1.4, duration: 0.4 }]);
    expect(render.subtitles.map(({ id, start, end, rows, frames }) => ({ id, start, end, rows, frames }))).toEqual([
      { id: 'a', start: 0.3, end: expect.closeTo(1.3, 6), rows: ['Open the editor.'], frames: [9, 38] },
      { id: 'b', start: 1.4, end: 2, rows: ['Done.'], frames: [42, 59] },
    ]);
    const media = await inspectFinal(outputPath, [{ id: 'a', path: join(dir, 'a.wav') }]);
    expect(media.audio).toMatchObject({ channels: 1, sampleRate: 48000 });
    expect(media.audio.duration).toBeCloseTo(2, 1);
    expect(media.audio.decoded).toBeGreaterThan(0);
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
    const render = lines => renderFinal({ sourcePath, finalPath: join(dir, 'final.mp4'), timeline: { viewport: { width: 320, height: 240 }, duration: 1 }, ...forRender(bare(), dir), narration: { language: 'en', lines } });
    const line = (id, start, file = 'a.wav') => ({ id, start, text: 'Hello.', path: join(dir, file) });
    await expect(render([line('a', 0), line('b', 0.5)])).rejects.toThrow("Line 'a' overlaps 'b' by 0.30 s; Line 'b' runs 0.30 s past the end of the Final");
    await expect(render([line('a', 0, 'bad.wav')])).rejects.toThrow("Line 'a': its audio bad.wav is not a format the browser decodes");
  } finally { await browser.close(); await fs.rm(dir, { recursive: true, force: true }); }
}, 60_000);
