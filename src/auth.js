import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
const root = () => process.env.CUETAKE_AUTH_DIR || join(homedir(), '.local/share/cuetake/auth');
function profilePath(profile) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(profile)) throw new Error('Use a short lowercase profile name, such as product-demo');
  return join(root(), `${profile}.json`);
}
export async function resolveAuthProfile(profile) {
  const path = profilePath(profile);
  await fs.access(path).catch(() => { throw new Error(`Auth profile '${profile}' is missing. Run: cuetake login ${profile} <login-url>`); });
  return path;
}
/** Accepts a browser context or an already-read storage state. */
export async function saveAuthState(source, profile) {
  const path = profilePath(profile);
  await fs.mkdir(root(), { recursive: true, mode: 0o700 });
  const state = typeof source.storageState === 'function' ? await source.storageState({ indexedDB: true }) : source;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(temporary, path);
  } finally { await fs.rm(temporary, { force: true }); }
  return { profile, saved: true, note: 'Auth profile saved locally. Confirm authentication against the target page before recording.' };
}
/** Opens a headed login window and saves its state when the user closes the window. */
export async function login(url, profile) {
  profilePath(profile);
  if (!/^https?:$/.test(new URL(url).protocol)) throw new Error('Login requires HTTP(S)');
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    console.error('Complete login in the opened browser, then close its window. No recording is active.');
    // The window can close at any moment, so keep the latest readable state and save that.
    let state, open = true;
    const closed = new Promise(resolve => { page.once('close', resolve); browser.once('disconnected', resolve); }).then(() => { open = false; });
    while (open) {
      state = await context.storageState({ indexedDB: true }).catch(() => state);
      await Promise.race([closed, sleep(1000)]);
    }
    return await saveAuthState(state, profile);
  } finally { await browser.close().catch(() => {}); }
}
