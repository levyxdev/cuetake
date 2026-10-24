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
  const platform = process.platform === 'darwin'
    ? { name: 'platform', ok: true, value: 'macOS' }
    : { name: 'platform', ok: true, value: process.platform, note: 'Only macOS is verified; capture and Render may behave differently here.' };
  checks.push(platform);
  return { ok: checks.every(c => c.ok), checks };
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
