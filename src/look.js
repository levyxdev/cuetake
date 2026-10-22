import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { editFields, editSchema, frameFields, outputFields } from './edit.js';

/**
 * A Look is the part of an Edit that does not depend on one Take: everything except camera targets,
 * the address bar's url and the frame rate. Every field is optional; a Look sets only what it names.
 */
export const lookSchema = z.object({
  cursor: editFields.cursor.removeDefault().partial().strict(),
  clickEffect: editFields.clickEffect.removeDefault().partial().strict(),
  output: outputFields.partial().strict(),
  frame: z.union([z.literal(false), frameFields.omit({ url: true }).partial().strict()]),
  camera: editFields.camera.removeDefault().partial().strict(),
}).partial().strict();

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** `over` wins field by field: nested objects merge, anything else (including `frame: false`) replaces. */
export function mergeLook(base, over) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(over ?? {})) merged[key] = isObject(value) && isObject(base?.[key]) ? mergeLook(base[key], value) : value;
  return merged;
}

/** The Look an Edit carries. */
export function lookFromEdit({ cursor, clickEffect, output: { fps, ...output }, frame, camera: { targets, ...camera } }) {
  const { url, ...styling } = frame || {};
  return lookSchema.parse({ cursor, clickEffect, output, frame: frame && styling, camera });
}

/** The Edit with a Look adopted. Camera targets and the frame rate stay; the address bar keeps its url, else shows `host`. */
export function applyLook(edit, look, host) {
  const next = mergeLook(edit, look);
  if (next.frame) next.frame = { url: edit.frame?.url ?? host, ...next.frame };
  return editSchema.parse(next);
}

/** One line for listings, such as "browser · ocean · 16:9 · 2160p". */
export function summarize(look) {
  const { frame, output = {} } = look;
  const parts = frame === false ? ['no frame', output.size] : [frame?.window, frame?.background, output.aspect, output.size];
  return parts.filter(Boolean).join(' · ') || Object.keys(look).join(', ') || 'empty';
}

/** Local Looks live in the directory CueTake runs in; global ones serve every directory. */
const scopes = (cwd = process.cwd()) => ({
  local: join(cwd, '.cuetake', 'looks'),
  global: process.env.CUETAKE_LOOK_DIR || join(homedir(), '.local/share/cuetake/looks'),
});
function lookPath(name, scope, cwd) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('Use a short lowercase Look name, such as brand');
  return join(scopes(cwd)[scope], `${name}.json`);
}
function parseLook(data, path) {
  const result = lookSchema.safeParse(data);
  if (!result.success) throw new Error(`${path} is not a valid Look: ${result.error.issues.map(issue => `${issue.path.join('.') || 'look'} ${issue.message}`).join('; ')}`);
  return result.data;
}
const readIfPresent = path => fs.readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });

/** A Look by name, local before global, or from a JSON file labeled by its `name` or file name. */
export async function loadLook(ref, cwd = process.cwd()) {
  if (ref.endsWith('.json')) {
    const path = resolve(cwd, ref);
    const { name = basename(ref, '.json'), ...look } = JSON.parse(await fs.readFile(path, 'utf8'));
    return { name: String(name), look: parseLook(look, path) };
  }
  for (const scope of ['local', 'global']) {
    const path = lookPath(ref, scope, cwd), text = await readIfPresent(path);
    if (text !== null) return { name: ref, scope, look: parseLook(JSON.parse(text), path) };
  }
  const { local, global } = scopes(cwd);
  throw new Error(`No Look named '${ref}' in ${local} or ${global}`);
}

/** Every saved Look; a global Look hidden by a local one with the same name is marked shadowed. */
export async function listLooks(cwd = process.cwd()) {
  const found = [];
  for (const [scope, dir] of Object.entries(scopes(cwd))) {
    const files = await fs.readdir(dir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const file of files.filter(f => f.endsWith('.json')).sort()) {
      const name = basename(file, '.json'), path = join(dir, file);
      const summary = await fs.readFile(path, 'utf8').then(text => summarize(parseLook(JSON.parse(text), path)), error => `invalid: ${error.message}`);
      found.push({ name, scope, shadowed: scope === 'global' && found.some(l => l.scope === 'local' && l.name === name), summary, path });
    }
  }
  return found;
}

/** Saves a Look locally unless `global`; an existing Look with the name is kept unless `replace`. */
export async function saveLook(name, look, { global = false, replace = false, cwd } = {}) {
  const scope = global ? 'global' : 'local', path = lookPath(name, scope, cwd);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(lookSchema.parse(look), null, 2) + '\n', { flag: replace ? 'w' : 'wx' }).catch(error => {
    if (error.code === 'EEXIST') throw new Error(`A ${scope} Look named '${name}' already exists at ${path}; pass --replace to overwrite it`);
    throw error;
  });
  return { name, scope, path, summary: summarize(look) };
}

export async function removeLook(name, { global = false, cwd } = {}) {
  const scope = global ? 'global' : 'local', path = lookPath(name, scope, cwd);
  await fs.rm(path).catch(error => { if (error.code === 'ENOENT') throw new Error(`No ${scope} Look named '${name}' at ${path}`); throw error; });
  return { name, scope, removed: path };
}
