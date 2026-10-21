import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const sessions = new Map();
const root = () => process.env.CUETAKE_AUTH_DIR || join(homedir(), '.local/share/cuetake/auth');
function profilePath(profile) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(profile)) throw new Error('Use a short lowercase profile name, such as product-demo');
  return join(root(), `${profile}.json`);
}
export async function resolveAuthProfile(profile) {
  const path = profilePath(profile);
  await fs.access(path).catch(() => { throw new Error(`Login profile '${profile}' is missing. Open and save a login session first.`); });
  return path;
}
export async function saveAuthState(context, profile) {
  const path = profilePath(profile);
  await fs.mkdir(root(), { recursive: true, mode: 0o700 });
  const state = await context.storageState({ indexedDB: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(temporary, path);
  } finally { await fs.rm(temporary, { force: true }); }
  return { profile, saved: true, note: 'Login state saved locally. Confirm authentication against the target page before recording.' };
}
export async function openAuth(url, profile) {
  profilePath(profile);
  if (!/^https?:$/.test(new URL(url).protocol)) throw new Error('Login requires HTTP(S)');
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const sessionId = randomUUID();
    sessions.set(sessionId, { browser, context, profile });
    return { sessionId, profile, state: 'awaiting_login', note: 'Complete login in the opened browser. Save only after login is complete. No recording is active.' };
  } catch (error) { await browser.close(); throw error; }
}
export async function finishAuth(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('Login session not found; it belongs to the MCP process that opened it');
  const result = await saveAuthState(session.context, session.profile);
  await session.browser.close();
  sessions.delete(sessionId);
  return result;
}
export async function closeAuthSessions() {
  for (const session of sessions.values()) await session.browser.close().catch(() => {});
  sessions.clear();
}
