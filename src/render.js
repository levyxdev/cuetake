import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { contentType } from './styles.js';

/**
 * Render runs in a headless Chromium page (ADR 0001). Files reach the page through intercepted
 * requests on a private origin, so no port is opened: the Source is served with byte ranges and
 * the Final arrives as positioned chunks written straight to disk. The page has no network: it runs
 * agent-written code (ADR 0005), and anything that code tries to fetch from elsewhere is refused.
 */
const ORIGIN = 'https://render.cuetake.invalid';
// The bundled build is a single file the page can import; the package's own entry is many modules.
const mediabunnyBundle = join(dirname(createRequire(import.meta.url).resolve('mediabunny')), 'mediabunny.min.mjs');
const pageFiles = {
  '/render.html': { body: '<!doctype html><meta charset="utf-8"><script type="module" src="/render-page.js"></script>', type: 'text/html' },
  '/render-page.js': { path: fileURLToPath(new URL('./render-page.js', import.meta.url)), type: 'text/javascript' },
  '/camera.js': { path: fileURLToPath(new URL('./camera.js', import.meta.url)), type: 'text/javascript' },
  '/cursor.js': { path: fileURLToPath(new URL('./cursor.js', import.meta.url)), type: 'text/javascript' },
  '/stage.js': { path: fileURLToPath(new URL('./stage.js', import.meta.url)), type: 'text/javascript' },
  '/narration.js': { path: fileURLToPath(new URL('./narration.js', import.meta.url)), type: 'text/javascript' },
  '/shortcuts.js': { path: fileURLToPath(new URL('./shortcuts.js', import.meta.url)), type: 'text/javascript' },
  '/mediabunny.js': { path: mediabunnyBundle, type: 'text/javascript' },
};

async function serveRange(route, path) {
  const { size } = await fs.stat(path);
  const match = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
  const start = match ? Number(match[1]) : 0;
  const end = match && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  const handle = await fs.open(path);
  try {
    const body = Buffer.alloc(end - start + 1);
    await handle.read(body, 0, body.length, start);
    await route.fulfill({ status: match ? 206 : 200, body, headers: { 'content-type': contentType(path), 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}` } });
  } finally { await handle.close(); }
}

/** Opens the render page with `files` ({ name: path }) readable and `writable` ({ name: handle }) writable. */
async function withRenderPage({ files = {}, writable = {} }, task) {
  // An unreachable proxy stops what request interception does not see, such as WebSockets.
  const browser = await chromium.launch({ headless: true, channel: 'chromium', proxy: { server: 'http://127.0.0.1:9' }, args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
  const blocked = [];
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) { blocked.push(url.href); return route.abort('blockedbyclient'); }
      const { pathname, searchParams } = url;
      const name = pathname.slice('/files/'.length);
      if (route.request().method() === 'POST' && writable[name]) {
        const body = route.request().postDataBuffer();
        await writable[name].write(body, 0, body.length, Number(searchParams.get('position')));
        return route.fulfill({ status: 204 });
      }
      if (files[name]) return serveRange(route, files[name]);
      const file = pageFiles[pathname];
      if (!file) return route.fulfill({ status: 404 });
      return route.fulfill({ body: file.body ?? await fs.readFile(file.path), contentType: file.type });
    });
    await page.goto(`${ORIGIN}/render.html`);
    await page.waitForFunction(() => window.cuetakeRender, null, { timeout: 15_000 }).catch(() => { throw new Error(`Render page failed to load: ${errors.join('; ')}`); });
    const result = await task(page).catch(error => { throw offline(fromPage(error), blocked); });
    if (blocked.length) throw offline(null, blocked);
    return result;
  } finally { await browser.close(); }
}

/** An error thrown in the render page, without Playwright's prefix and the page's stack. */
function fromPage(error) {
  const message = error.message.replace(/^page\.evaluate: (Error: )?/, '').split(/\n\s+at /)[0];
  return message === error.message ? error : new Error(message);
}

/** Names what styling code tried to fetch, which the render page cannot. */
function offline(error, blocked) {
  if (!blocked.length) return error;
  const note = `The render page has no network and refused ${[...new Set(blocked)].join(', ')}; download it next to the Look or Take and name it by its relative path in \`files\``;
  return new Error(error ? `${error.message}\n${note}` : note);
}

/**
 * Lines as the render page reads them, `{ id, audio, url, ... }`, with their audio served from `files`.
 * Each Line is `{ id, path, ... }`, `path` being its audio file.
 */
function servedLines(lines, files) {
  return lines.map(({ path, ...line }, i) => {
    const name = `line-${i}${extname(path)}`;
    files[name] = path;
    return { ...line, audio: basename(path), url: `${ORIGIN}/files/${name}` };
  });
}

/**
 * Composes the Final from a Source, Timeline and Edit; `files` serves the Edit's styling files (styles.js
 * forRender). `narration` ({ language, volume, lines }) adds its Lines' audio and Subtitles.
 */
export async function renderFinal({ sourcePath, finalPath, timeline, edit, files = {}, narration = null }) {
  const handle = await fs.open(finalPath, 'w');
  const served = { ...files, source: sourcePath };
  const spoken = narration && { ...narration, lines: servedLines(narration.lines, served) };
  try {
    return await withRenderPage({ files: served, writable: { final: handle } }, page => page.evaluate(options => window.cuetakeRender(options), {
      sourceUrl: `${ORIGIN}/files/source`, finalUrl: `${ORIGIN}/files/final`, duration: timeline.duration,
      viewport: timeline.viewport, pointer: timeline.pointer ?? [], shapes: timeline.shapes ?? [], events: timeline.events ?? [], edit, narration: spoken,
    }));
  } finally { await handle.close(); }
}

/** A Preview PNG of `tiles` ([{ name, edit }]) at `at` seconds, or at the end with the camera wide. No Final is touched. */
export async function composePreview({ sourcePath, timeline, tiles, at, files = {}, narration = null }) {
  const served = { ...files, source: sourcePath };
  const spoken = narration && { ...narration, lines: servedLines(narration.lines, served) };
  const png = await withRenderPage({ files: served }, page => page.evaluate(options => window.cuetakePreview(options), {
    sourceUrl: `${ORIGIN}/files/source`, duration: timeline.duration, viewport: timeline.viewport,
    pointer: timeline.pointer ?? [], shapes: timeline.shapes ?? [], events: timeline.events ?? [], tiles, at: at ?? null, narration: spoken,
  }));
  return Buffer.from(png, 'base64');
}

/** Container metadata of a Final plus a full decode of its video and audio, and of each Line's audio (`lines`: [{ id, path }]). */
export function inspectFinal(path, lines = []) {
  const files = { final: path };
  const served = servedLines(lines, files);
  return withRenderPage({ files }, page => page.evaluate(([url, lines]) => window.cuetakeInspect(url, lines), [`${ORIGIN}/files/final`, served]));
}

/** Each Line's audio duration in seconds (`lines`: [{ id, path }]); the error names a Line whose audio cannot be decoded. */
export function measureLines(lines) {
  const files = {};
  const served = servedLines(lines, files);
  return withRenderPage({ files }, page => page.evaluate(lines => window.cuetakeMeasure(lines), served));
}

/** A PNG of the Final at `seconds`, for agents to look at without FFmpeg. */
export async function extractFrame(path, seconds) {
  const png = await withRenderPage({ files: { final: path } }, page => page.evaluate(([url, at]) => window.cuetakeFrame(url, at), [`${ORIGIN}/files/final`, seconds]));
  return Buffer.from(png, 'base64');
}
