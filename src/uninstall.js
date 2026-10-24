import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authProfileFiles } from './auth.js';
import { globalLookFiles } from './look.js';
import { uninstallBrowser } from './environment.js';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

/**
 * The npx folders made for CueTake alone, in any version. The one this CLI runs from is
 * `<cache>/_npx/<hash>/node_modules/cuetake`; npx folders that also hold other packages are not CueTake's.
 */
export async function npxFolders({ cache = process.env.npm_config_cache || join(homedir(), '.npm'), packageDir = PACKAGE_DIR } = {}) {
  const own = dirname(dirname(packageDir)), roots = new Set([join(cache, '_npx')]);
  if (basename(dirname(own)) === '_npx' && basename(packageDir) === 'cuetake') roots.add(dirname(own));
  const found = [];
  for (const root of roots) {
    const names = await fs.readdir(root).catch(error => { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return []; throw error; });
    for (const name of names) {
      const manifest = await fs.readFile(join(root, name, 'package.json'), 'utf8').then(JSON.parse, () => null);
      if (manifest && Object.keys(manifest.dependencies ?? {}).join() === 'cuetake') found.push(join(root, name));
    }
  }
  return found.sort();
}

/**
 * Removes what CueTake put on this machine outside the user's projects: its npx folders and, through
 * Playwright, the browser unless another Playwright installation still uses it. Auth profiles and global
 * Looks are the user's and go only when asked. Take folders and local Looks are never touched.
 */
export async function uninstall({ auth = false, looks = false, dryRun = false, removeBrowser = uninstallBrowser } = {}) {
  const npx = await npxFolders(), profiles = await authProfileFiles(), globalLooks = await globalLookFiles();
  const removed = [], kept = [];
  const remove = async (item, paths) => {
    for (const path of paths) {
      if (!dryRun) await fs.rm(path, { recursive: true, force: true });
      removed.push({ item, path });
    }
  };
  const own = dirname(dirname(PACKAGE_DIR));
  // Old CueTake versions go first so Playwright no longer counts their claim on the browser.
  await remove('npx cache', npx.filter(path => path !== own));
  const browser = await removeBrowser({ dryRun });
  if (browser.existed && dryRun) removed.push({ item: 'browser', path: browser.path, note: 'kept if another Playwright installation still uses it' });
  else if (browser.removed) removed.push({ item: 'browser', path: browser.path });
  else if (browser.existed) kept.push({ item: 'browser', path: browser.path, reason: 'another Playwright installation still uses it' });
  for (const [item, flag, wanted, { dir, paths }] of [['Auth profile', '--auth', auth, profiles], ['global Look', '--looks', looks, globalLooks]]) {
    if (wanted) await remove(item, paths);
    else if (paths.length) kept.push({ item, path: dir, count: paths.length, reason: `pass ${flag} to remove` });
    if (wanted && !dryRun) await fs.rmdir(dir).catch(() => {});
  }
  // This CLI's own npx folder goes last, once nothing else needs its files.
  await remove('npx cache', npx.filter(path => path === own));
  if (!dryRun) await fs.rmdir(join(homedir(), '.local/share/cuetake')).catch(() => {});
  return {
    dryRun, [dryRun ? 'wouldRemove' : 'removed']: removed, kept,
    note: 'Take folders and local Looks (.cuetake/looks) stay in your projects. The skill is removed by the tool that installed it.',
  };
}
