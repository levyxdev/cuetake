import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/**
 * Capture of a Desktop of macOS Apps (ADR 0009), through cuetake-capture, the Swift helper shipped in
 * the package (helper/). The helper runs as a child process, uses the grants of the process
 * responsible for CueTake, and talks in JSON lines over stdio; runtime code here stays Node-only.
 */
export const HELPER = fileURLToPath(new URL('../helper/bin/cuetake-capture', import.meta.url));
const MISSING = 'This CueTake has no cuetake-capture helper, so it cannot record Apps. In a source checkout, run bun run build:helper on a Mac.';

/** The helper's path, made executable if packing lost the bit, or null when this CueTake has none. */
async function helper() {
  try {
    const { mode } = await fs.stat(HELPER);
    if (!(mode & 0o111)) await fs.chmod(HELPER, mode | 0o755);
    return HELPER;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** What the helper prints for `args`, parsed, or an error naming its output. */
function run(path, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      try { resolve(JSON.parse(out)); } catch { reject(new Error(`cuetake-capture ${args.join(' ')} exited with ${code}: ${(err || out).trim()}`)); }
    });
  });
}

/**
 * The doctor checks a Take of Apps needs, each `for: 'Apps'`: the helper, and the Screen Recording and
 * Accessibility grants of the app responsible for CueTake, read without prompting. Each fix names that app.
 */
export async function appChecks() {
  const path = await helper();
  if (!path) return [{ name: 'helper', for: 'Apps', ok: false, fix: MISSING }];
  let granted;
  try { granted = await run(path, ['preflight']); }
  catch (error) { return [{ name: 'helper', for: 'Apps', ok: false, error: error.message, fix: 'Reinstall CueTake; its cuetake-capture helper does not run here.' }]; }
  const { app, path: responsible } = granted.responsible;
  const grant = (name, ok, pane) => ({ name, for: 'Apps', ok, app, ...(ok ? {} : { path: responsible, fix: `Allow ${app} in System Settings > Privacy & Security > ${pane}, then restart it. Ask the user first.` }) });
  return [grant('screen-recording', granted.screenRecording, 'Screen Recording'), grant('accessibility', granted.accessibility, 'Accessibility')];
}

/**
 * Starts `app` ({ path, args }) on a Desktop `desktop` points large ({ width, height }), recording at
 * `fps` into `source` (an MP4) from `start()` on, and writing the last frame to `poster`. Resolves once the
 * App's first window fills the Desktop, with `ready` (the App, its scale, the Desktop on the screen and
 * the first window in Desktop points) and:
 * - `start()`, which records and resolves with the wall-clock ms of the first frame;
 * - `stop()`, which ends the Source, quits the App and resolves with the sidecar: `duration`, `frames`
 *   ([t, scale] per frame), `windows` (the App's windows over time) and whether the App `quit`;
 * - `request(message)`, which asks the helper to read the App's Accessibility tree or post input for
 *   the Director (app-locators.js, app-director.js), in Desktop points, and resolves with its reply;
 * - `kill()`, which ends it all, for a failure; the helper then quits the App.
 * The helper's refusals (a running App, a missing grant) reject with its message.
 */
export async function startDesktop({ app, desktop, fps, source, poster }) {
  const path = await helper();
  if (!path) throw new Error(MISSING);
  const child = spawn(path, ['record'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const waiting = [], requests = new Map();
  let ended = null, next = 0;
  const settle = (key, value) => { const i = waiting.findIndex(w => w.key === key || key === 'error'); if (i >= 0) waiting.splice(i, 1)[0][key === 'error' ? 'reject' : 'resolve'](value); };
  const failed = message => {
    ended = new Error(message);
    for (const w of [...waiting.splice(0), ...requests.values()]) w.reject(ended);
    requests.clear();
  };
  createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.error) failed(message.error.message);
    else if (requests.has(message.id)) {
      const { resolve, reject } = requests.get(message.id);
      requests.delete(message.id);
      if ('failed' in message) reject(new Error(message.failed)); else resolve(message.reply);
    }
    else for (const key of ['ready', 'started', 'stopped']) if (message[key]) settle(key, message[key]);
  });
  child.on('error', error => failed(error.message));
  child.on('close', code => failed(`cuetake-capture stopped (exit ${code})${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
  const reply = key => new Promise((resolve, reject) => { if (ended) reject(ended); else waiting.push({ key, resolve, reject }); });
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  const ready = reply('ready');
  send({ app: { path: app.path, args: app.args ?? [] }, desktop, fps, source, poster });
  try { await ready; } catch (error) { child.kill(); throw error; }
  return {
    ready: await ready,
    async start() { const started = reply('started'); send({ start: true }); return (await started).epochMs; },
    async stop() { const stopped = reply('stopped'); send({ stop: true }); return stopped; },
    request(message) {
      if (ended) return Promise.reject(ended);
      const id = ++next;
      return new Promise((resolve, reject) => { requests.set(id, { resolve, reject }); send({ id, ...message }); });
    },
    kill() { if (child.exitCode === null) child.stdin.end(); },
  };
}

/**
 * The Accessibility tree of a running App (`app`: its bundle id, name or .app path), as the helper lists
 * it, for writing a Scenario's locators. It only reads, so it may look at an App the user started.
 */
export async function appTree(app) {
  const path = await helper();
  if (!path) throw new Error(MISSING);
  const tree = await run(path, ['tree', app]);
  if (tree.error) throw new Error(tree.error.message);
  return tree;
}
