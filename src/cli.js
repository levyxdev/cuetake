#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { recordScenario, renderTake, verifyTake } from './pipeline.js';
import { doctor, installBrowser } from './environment.js';
import { login } from './auth.js';
import { extractFrame } from './render.js';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const help = `CueTake ${pkg.version} — browser demos directed by code

  cuetake doctor
  cuetake install-browser
  cuetake record <scenario.mjs> [--out <new-directory>] [--auth-profile <name>] [--headed]
  cuetake render <take-directory>
  cuetake verify <take-directory>
  cuetake frame <take-directory> <seconds> [--out <file.png>]
  cuetake login <profile> <login-url>

install-browser downloads the Chromium build this CueTake version drives (about 150 MB).
record captures, renders and verifies a new take; an existing directory is never overwritten.
  Capture runs headless; --headed shows the browser window while recording.
render reuses source.webm, timeline.json and edit.json, replacing final.mp4 only on success.
frame saves one Final frame as a PNG for inspection.
login opens a separate browser; close its window after logging in to save the profile.
Scenario files are trusted JavaScript. Recording runs locally, without audio.
`;
try {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { out: { type: 'string' }, help: { type: 'boolean', short: 'h' }, 'auth-profile': { type: 'string' }, headed: { type: 'boolean' } } });
  const [command, target] = positionals;
  if (values.help || !command) console.log(help);
  else if (command === 'doctor') { const result = await doctor(); console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1; }
  else if (command === 'install-browser') console.log(JSON.stringify(await installBrowser(), null, 2));
  else if (command === 'record' && target) console.log(JSON.stringify(await recordScenario(target, values.out, { authProfile: values['auth-profile'], headed: values.headed }), null, 2));
  else if (command === 'render' && target) { await renderTake(target); console.log(JSON.stringify(await verifyTake(target), null, 2)); }
  else if (command === 'verify' && target) console.log(JSON.stringify(await verifyTake(target), null, 2));
  else if (command === 'frame' && target && positionals[2]) {
    const out = resolve(values.out || join(target, `frame-${positionals[2]}s.png`));
    await writeFile(out, await extractFrame(join(target, 'final.mp4'), Number(positionals[2])));
    console.log(out);
  }
  else if (command === 'login' && target && positionals[2]) console.log(JSON.stringify(await login(positionals[2], target), null, 2));
  else throw new Error(`Unknown or incomplete command.\n${help}`);
} catch (error) { console.error(`CueTake: ${error.message}`); process.exitCode = 1; }
