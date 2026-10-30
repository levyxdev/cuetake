import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { merge } from './edit.js';
import { absolute, bundle, codeRefs, fileRefs } from './styles.js';

/**
 * A Look is the part of an Edit that does not depend on one Take: everything except camera targets,
 * the address bar's url, the frame rate, the Shortcuts, the fast-forwards and the Narration's Lines. A
 * Look sets only what it names, and is not validated.
 */
export const mergeLook = merge;

/** The Look an Edit carries. */
export function lookFromEdit(edit) {
  const { schemaVersion, narration, shortcuts, fastForward, output: { fps, ...output } = {}, frame, camera: { targets, ...camera } = {}, ...rest } = edit;
  const { url, ...styling } = frame ?? {};
  return { ...rest, output, frame: styling, camera };
}

/** The Edit with a Look adopted. Camera targets, the frame rate, the Shortcuts, the fast-forwards and the Lines stay; the address bar keeps its url, else shows `host`. */
export function applyLook(edit, look, host) {
  const next = merge(edit, look);
  next.frame = { ...next.frame, url: edit.frame?.url ?? host };
  return next;
}

const label = item => item && typeof item === 'object' ? basename(String(item.shader ?? item.draw ?? item.image ?? '')) : item === false ? 'none' : null;
/** One line for listings, such as "browser-dark · fluted · 3840×2160". */
export function summarize(look) {
  const { frame, output } = look;
  const parts = [label(frame?.chrome), ...(Array.isArray(frame?.background) ? frame.background.map(label) : []), output?.width && output?.height ? `${output.width}×${output.height}` : null];
  return parts.filter(Boolean).join(' · ') || Object.keys(look).join(', ') || 'empty';
}

/** Local Looks live in the directory CueTake runs in; global ones serve every directory. */
const scopes = (cwd = process.cwd()) => ({
  local: join(cwd, '.cuetake', 'looks'),
  global: process.env.CUETAKE_LOOK_DIR || join(homedir(), '.local/share/cuetake/looks'),
});
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
function checkName(name) {
  if (!NAME.test(name)) throw new Error('Use a short lowercase Look name, such as brand');
}
const readIfPresent = path => fs.readFile(path, 'utf8').catch(error => { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; });
const parse = (text, path) => { try { return JSON.parse(text); } catch (error) { throw new Error(`${path} is not JSON: ${error.message}`); } };

/** A saved Look is `<name>.json`, or a `<name>/` folder holding `look.json` and the files it names. */
async function readSaved(dir, name) {
  for (const path of [join(dir, `${name}.json`), join(dir, name, 'look.json')]) {
    const text = await readIfPresent(path);
    if (text !== null) return { path, dir: dirname(path), look: parse(text, path) };
  }
  return null;
}

/**
 * A Look by name, local before global, or from a JSON file labeled by its `name` or file name. `dir` is
 * where its file refs resolve.
 */
export async function loadLook(ref, cwd = process.cwd()) {
  if (ref.endsWith('.json')) {
    const path = resolve(cwd, ref);
    const { name = basename(ref, '.json'), ...look } = parse(await fs.readFile(path, 'utf8'), path);
    return { name: String(name), dir: dirname(path), look };
  }
  checkName(ref);
  for (const [scope, root] of Object.entries(scopes(cwd))) {
    const saved = await readSaved(root, ref);
    if (saved) return { name: ref, scope, dir: saved.dir, look: saved.look };
  }
  const { local, global } = scopes(cwd);
  throw new Error(`No Look named '${ref}' in ${local} or ${global}`);
}

/** A Look's styling with its file refs made absolute, ready to merge with styling from elsewhere. */
export const resolvedLook = ({ look, dir }) => absolute(look, dir);

/** Every saved Look, with the code files it runs; a global Look hidden by a local one with the same name is marked shadowed. */
export async function listLooks(cwd = process.cwd()) {
  const found = [];
  for (const [scope, root] of Object.entries(scopes(cwd))) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const names = entries.flatMap(e => e.isDirectory() ? [e.name] : e.name.endsWith('.json') ? [basename(e.name, '.json')] : []).sort();
    for (const name of new Set(names)) {
      const saved = await readSaved(root, name).catch(error => ({ error }));
      if (!saved) continue;
      const entry = { name, scope, shadowed: scope === 'global' && found.some(l => l.scope === 'local' && l.name === name), path: saved.path ?? join(root, name) };
      if (saved.error) found.push({ ...entry, summary: `invalid: ${saved.error.message}` });
      else found.push({ ...entry, summary: summarize(saved.look), code: codeRefs(absolute(saved.look, saved.dir)) });
    }
  }
  return found;
}

/**
 * Saves a Look locally unless `global`, with its file refs resolved against `from`. A Look that names
 * files becomes a folder holding copies of them. An existing Look with the name is kept unless `replace`.
 */
export async function saveLook(name, look, { global = false, replace = false, cwd, from = cwd ?? process.cwd() } = {}) {
  checkName(name);
  const scope = global ? 'global' : 'local', root = scopes(cwd)[scope];
  const existing = await readSaved(root, name);
  if (existing && !replace) throw new Error(`A ${scope} Look named '${name}' already exists at ${existing.path}; pass --replace to overwrite it`);
  await fs.rm(join(root, `${name}.json`), { force: true });
  await fs.rm(join(root, name), { recursive: true, force: true });
  const hasFiles = fileRefs(look).length > 0, dir = hasFiles ? join(root, name) : root;
  const saved = hasFiles ? await bundle(look, from, dir) : look;
  const path = hasFiles ? join(dir, 'look.json') : join(root, `${name}.json`);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(saved, null, 2) + '\n');
  return { name, scope, path, summary: summarize(saved), code: codeRefs(absolute(saved, dir)) };
}

/** The file or folder of every global Look; other files in the folder are not CueTake's. */
export async function globalLookFiles() {
  const dir = scopes().global, paths = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.json') && NAME.test(basename(entry.name, '.json'))) paths.push(path);
    else if (entry.isDirectory() && NAME.test(entry.name) && await readIfPresent(join(path, 'look.json')) !== null) paths.push(path);
  }
  return { dir, paths: paths.sort() };
}

export async function removeLook(name, { global = false, cwd } = {}) {
  checkName(name);
  const scope = global ? 'global' : 'local', root = scopes(cwd)[scope];
  const saved = await readSaved(root, name);
  if (!saved) throw new Error(`No ${scope} Look named '${name}' in ${root}`);
  const removed = saved.path === join(root, `${name}.json`) ? saved.path : saved.dir;
  await fs.rm(removed, { recursive: true, force: true });
  return { name, scope, removed };
}
