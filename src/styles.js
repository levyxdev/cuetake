import fs from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The files an Edit or Look draws with (ADR 0005). A ref with an extension is a file, relative to the
 * Take, Look or Scenario that names it; a ref without one is a built-in from src/styles, with the
 * parameters it starts from. Built-ins are ordinary files agents can read and copy.
 */
export const BUILTIN_DIR = fileURLToPath(new URL('./styles/', import.meta.url));
export const BUILTINS = {
  fluted: { file: 'fluted.glsl', params: { count: 36, strength: 0.09, angle: 0 } },
  shadow: { file: 'shadow.glsl', params: { blur: 60, offset: 24, opacity: 0.5, rim: 0.12 } },
  browser: { file: 'browser.js', params: { dark: false } },
  'browser-dark': { file: 'browser.js', params: { dark: true } },
  macos: { file: 'macos.js', params: { dark: false } },
  'macos-dark': { file: 'macos.js', params: { dark: true } },
  arrow: { file: 'arrow.js', params: {} },
  dot: { file: 'dot.js', params: {} },
  spark: { file: 'spark.js', params: { radius: 32, length: 16, count: 8 } },
};
export const KINDS = ['shader', 'draw', 'image'];
export const isFile = ref => typeof ref === 'string' && extname(ref) !== '';

/** Every drawn item an Edit or (partial) Look holds. */
function items(style) {
  const { frame, cursor, clickEffect } = style ?? {};
  return [...(Array.isArray(frame?.background) ? frame.background : []), ...(Array.isArray(frame?.effects) ? frame.effects : []), frame?.chrome, cursor, clickEffect]
    .filter(item => item && typeof item === 'object');
}

/** A copy of `style` with every file ref (an item's drawing and its `files`) replaced by `map(ref)`. */
export function mapFiles(style, map) {
  const copy = structuredClone(style);
  for (const item of items(copy)) {
    for (const key of KINDS) if (isFile(item[key])) item[key] = map(item[key]);
    if (item.files) item.files = Object.fromEntries(Object.entries(item.files).map(([name, ref]) => [name, isFile(ref) ? map(ref) : ref]));
  }
  return copy;
}

/** The file refs `style` names, in order, without repeats. */
export function fileRefs(style) {
  const refs = new Set();
  mapFiles(style, ref => refs.add(ref));
  return [...refs];
}

/** The shader and drawing-code files `style` runs, for an agent to review before using a Look. */
export function codeRefs(style) {
  return [...new Set(items(style).flatMap(item => ['shader', 'draw'].map(key => item[key]).filter(isFile)))];
}

/** Refs made absolute against `dir`, so styling from several places can be merged. */
export const absolute = (style, dir) => mapFiles(style, ref => resolve(dir, ref));

/**
 * Copies every file `style` names (resolved against `fromDir`) into `toDir` and points the refs at the
 * copies as `prefix + name`. Files already inside `toDir` stay; a different file with a taken name gets a suffix.
 */
export async function bundle(style, fromDir, toDir, prefix = '') {
  const copies = new Map();
  for (const ref of fileRefs(style)) {
    const source = resolve(fromDir, ref);
    if (!relative(toDir, source).startsWith('..') && !isAbsolute(relative(toDir, source))) { copies.set(ref, prefix + relative(toDir, source)); continue; }
    const bytes = await fs.readFile(source);
    await fs.mkdir(toDir, { recursive: true });
    const ext = extname(source), stem = basename(source, ext);
    for (let n = 1; ; n++) {
      const name = n === 1 ? stem + ext : `${stem}-${n}${ext}`, target = join(toDir, name);
      const existing = await fs.readFile(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (existing && !existing.equals(bytes)) continue;
      if (!existing) await fs.writeFile(target, bytes);
      copies.set(ref, prefix + name);
      break;
    }
  }
  return mapFiles(style, ref => copies.get(ref));
}

const PAGE_TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.glsl': 'text/plain', '.frag': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' };
export const contentType = path => PAGE_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';

/**
 * The Edit as the render page reads it: each drawing becomes a URL under `/files/` (with its built-in
 * parameters underneath the item's own). Refs resolve against `dir`; `files` collects the served
 * names and paths, and may be shared by several Edits.
 */
export function forRender(edit, dir, files = {}) {
  const serve = path => {
    let name = Object.keys(files).find(key => files[key] === path);
    if (!name) { name = `style-${Object.keys(files).length}${extname(path)}`; files[name] = path; }
    return `/files/${name}`;
  };
  const copy = structuredClone(edit);
  for (const item of items(copy)) {
    const kind = KINDS.find(key => item[key] !== undefined);
    if (!kind) continue;
    const ref = item[kind], builtin = !isFile(ref) && BUILTINS[ref];
    if (!isFile(ref) && !builtin) throw new Error(`No built-in named '${ref}'; built-ins are ${Object.keys(BUILTINS).join(', ')}, or name a file with its extension`);
    Object.assign(item, { ...(builtin ? builtin.params : {}), ...item, ref, kind, url: serve(builtin ? join(BUILTIN_DIR, builtin.file) : resolve(dir, ref)) });
    if (item.files) item.files = Object.fromEntries(Object.entries(item.files).map(([name, file]) => [name, serve(resolve(dir, file))]));
  }
  return { edit: copy, files };
}
