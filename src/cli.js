#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { doctor, recordScenario, renderTake, verifyTake } from './pipeline.js';
import { login } from './auth.js';

const help = `CueTake ${pkg.version} — browser demos directed by code

  cuetake doctor
  cuetake record <scenario.mjs> [--out <new-directory>] [--auth-profile <name>]
  cuetake render <take-directory>
  cuetake verify <take-directory>
  cuetake login <profile> <login-url>

record captures, renders and verifies a new take; an existing directory is never overwritten.
render reuses source.webm, timeline.json and edit.json, replacing final.mp4 only on success.
login opens a separate browser; close its window after logging in to save the profile.
Scenario files are trusted JavaScript. Recording runs locally, without audio.
`;
try {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { out: { type: 'string' }, help: { type: 'boolean', short: 'h' }, 'auth-profile': { type: 'string' } } });
  const [command, target] = positionals;
  if (values.help || !command) console.log(help);
  else if (command === 'doctor') { const result = await doctor(); console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1; }
  else if (command === 'record' && target) console.log(JSON.stringify(await recordScenario(target, values.out, { authProfile: values['auth-profile'] }), null, 2));
  else if (command === 'render' && target) { await renderTake(target); console.log(JSON.stringify(await verifyTake(target), null, 2)); }
  else if (command === 'verify' && target) console.log(JSON.stringify(await verifyTake(target), null, 2));
  else if (command === 'login' && target && positionals[2]) console.log(JSON.stringify(await login(positionals[2], target), null, 2));
  else throw new Error(`Unknown or incomplete command.\n${help}`);
} catch (error) { console.error(`CueTake: ${error.message}`); process.exitCode = 1; }
