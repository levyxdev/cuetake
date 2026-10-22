#!/usr/bin/env node
import { parseArgs } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { recordScenario, renderTake, verifyTake, previewTake, applyLookToTake, saveLookFromTake } from './pipeline.js';
import { listLooks, removeLook } from './look.js';
import { doctor, installBrowser } from './environment.js';
import { login } from './auth.js';
import { extractFrame } from './render.js';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const help = `CueTake ${pkg.version} — browser demos directed by code

  cuetake doctor
  cuetake install-browser
  cuetake record <scenario.mjs> [--out <new-directory>] [--auth-profile <name>] [--look <name|file.json>] [--headed]
  cuetake preview <take-directory> [--look <name|file.json>]... [--at <seconds>]
  cuetake render <take-directory>
  cuetake verify <take-directory>
  cuetake frame <take-directory> <seconds> [--out <file.png>]
  cuetake login <profile> <login-url>
  cuetake look list
  cuetake look save <name> <take-directory> [--global] [--replace]
  cuetake look apply <name|file.json> <take-directory>
  cuetake look rm <name> [--global]

install-browser downloads the Chromium build this CueTake version drives (about 150 MB).
record captures, renders and verifies a new take; an existing directory is never overwritten.
  Capture runs headless; --headed shows the browser window while recording.
  --look seeds the first Edit from a Look; fields the Scenario config names win.
preview writes preview.png in the take: the current Edit beside up to five Looks, at --at seconds
  or at the end with the camera wide. It never changes edit.json or final.mp4.
render reuses source.webm, timeline.json and edit.json, replacing final.mp4 only on success.
frame saves one Final frame as a PNG for inspection.
login opens a separate browser; close its window after logging in to save the profile.
A Look is a take's reusable styling. Looks are saved locally (.cuetake/looks in this directory)
  unless --global; a local Look hides a global one with the same name. apply rewrites edit.json.
Scenario files are trusted JavaScript. Recording runs locally, without audio.
`;
try {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { out: { type: 'string' }, help: { type: 'boolean', short: 'h' }, 'auth-profile': { type: 'string' }, headed: { type: 'boolean' }, look: { type: 'string', multiple: true }, at: { type: 'string' }, global: { type: 'boolean' }, replace: { type: 'boolean' } } });
  const [command, target] = positionals, looks = values.look ?? [];
  const print = data => console.log(JSON.stringify(data, null, 2));
  if (values.help || !command) console.log(help);
  else if (command === 'doctor') { const result = await doctor(); console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1; }
  else if (command === 'install-browser') console.log(JSON.stringify(await installBrowser(), null, 2));
  else if (command === 'record' && target && looks.length <= 1) print(await recordScenario(target, values.out, { authProfile: values['auth-profile'], look: looks[0], headed: values.headed }));
  else if (command === 'preview' && target) print(await previewTake(target, looks, { at: values.at === undefined ? undefined : Number(values.at) }));
  else if (command === 'render' && target) { await renderTake(target); console.log(JSON.stringify(await verifyTake(target), null, 2)); }
  else if (command === 'verify' && target) console.log(JSON.stringify(await verifyTake(target), null, 2));
  else if (command === 'frame' && target && positionals[2]) {
    const out = resolve(values.out || join(target, `frame-${positionals[2]}s.png`));
    await writeFile(out, await extractFrame(join(target, 'final.mp4'), Number(positionals[2])));
    console.log(out);
  }
  else if (command === 'login' && target && positionals[2]) console.log(JSON.stringify(await login(positionals[2], target), null, 2));
  else if (command === 'look' && target === 'list') print(await listLooks());
  else if (command === 'look' && target === 'save' && positionals[3]) print(await saveLookFromTake(positionals[2], positionals[3], { global: values.global, replace: values.replace }));
  else if (command === 'look' && target === 'apply' && positionals[3]) print(await applyLookToTake(positionals[2], positionals[3]));
  else if (command === 'look' && target === 'rm' && positionals[2]) print(await removeLook(positionals[2], { global: values.global }));
  else throw new Error(`Unknown or incomplete command.\n${help}`);
} catch (error) { console.error(`CueTake: ${error.message}`); process.exitCode = 1; }
