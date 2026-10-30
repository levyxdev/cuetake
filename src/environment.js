import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

/** Checks what CueTake needs; installs nothing. Each failed check names the exact fix. */
export async function doctor() {
  const checks = [];
  const [major, minor] = process.versions.node.split('.').map(Number);
  checks.push(major > 20 || (major === 20 && minor >= 10)
    ? { name: 'node', ok: true, version: process.versions.node }
    : { name: 'node', ok: false, version: process.versions.node, fix: 'Install Node 20.10 or newer.' });
  const browserPath = chromium.executablePath();
  try { await fs.access(browserPath); checks.push({ name: 'chromium', ok: true, path: browserPath }); }
  catch { checks.push({ name: 'chromium', ok: false, fix: 'cuetake install-browser (downloads about 150 MB; ask the user first)' }); }
  if (checks.at(-1).ok) checks.push(await gpu());
  const platform = process.platform === 'darwin'
    ? { name: 'platform', ok: true, value: 'macOS' }
    : { name: 'platform', ok: true, value: process.platform, note: 'Only macOS is verified; capture and Render may behave differently here.' };
  checks.push(platform);
  return { ok: checks.every(c => c.ok), checks };
}

/** Whether a WebGL renderer name is a GPU; null when Chromium reports none. */
export const drawsWithGpu = renderer => renderer ? !/swiftshader|llvmpipe|softpipe|software|basic render driver/i.test(renderer) : null;

/**
 * Asks the headless Chromium Capture runs in what draws its pages. Without a GPU it rasterizes and encodes
 * on the CPU, and at resolution scale 2 a busy page then gets far fewer frames than it draws. Informational:
 * Capture still works, so the check never fails.
 */
async function gpu() {
  let renderer = null;
  try {
    const browser = await chromium.launch({ headless: true, channel: 'chromium' });
    try {
      renderer = await (await browser.newPage()).evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl'), info = gl?.getExtension('WEBGL_debug_renderer_info');
        return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null;
      });
    } finally { await browser.close(); }
  } catch {}
  const accelerated = drawsWithGpu(renderer);
  return { name: 'gpu', ok: true, accelerated, renderer,
    ...(accelerated === false && { note: 'Chromium draws without a GPU here, so record captures at resolutionScale 1 unless the Scenario sets one.' }),
    ...(accelerated === null && { note: 'Chromium did not report a renderer.' }) };
}

function playwright(args) {
  const cli = join(dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
  return new Promise((resolve, reject) => {
    // Progress goes to stderr so stdout stays the JSON result.
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 2, 2] });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`playwright ${args[0]} exited with ${code}`)));
  });
}

/**
 * Downloads the Chromium build that CueTake's own Playwright version drives. Running
 * `npx playwright install` instead may resolve a newer Playwright and fetch a build CueTake never uses.
 */
export async function installBrowser() {
  await playwright(['install', 'chromium', '--no-shell']);
  return { installed: true, path: chromium.executablePath() };
}

/**
 * Unregisters CueTake's Playwright from the shared browser cache, which deletes each browser no other
 * Playwright installation still uses. Browsers other tools need stay.
 */
export async function uninstallBrowser({ dryRun = false } = {}) {
  const path = chromium.executablePath(), exists = () => fs.access(path).then(() => true, () => false);
  const existed = await exists();
  if (existed && !dryRun) await playwright(['uninstall']);
  return { path, existed, removed: existed && !dryRun && !await exists() };
}
