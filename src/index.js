#!/usr/bin/env bun
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import { doctor } from './pipeline.js';
import { openAuth, finishAuth, closeAuthSessions } from './auth.js';

const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
const server = new McpServer({ name: 'cuetake', version: pkg.version });
const jobs = new Map();
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const safe = fn => async args => { try { return reply(await fn(args)); } catch (error) { return { ...reply({ error: error.message }), isError: true }; } };

function startJob(command, target, directory, authProfile) {
  // One local capture/render at a time avoids competing for the GPU or final.mp4.
  if ([...jobs.values()].some(j => j.state === 'running')) throw new Error('A CueTake job is running; wait for it before starting another');
  const jobId = randomUUID();
  const args = [cli, command, resolve(target)];
  if (command === 'record') args.push('--out', directory);
  if (authProfile) args.push('--auth-profile', authProfile);
  const child = spawn('bun', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const job = { jobId, command, directory, state: 'running', startedAt: new Date().toISOString(), child, stdout: '', stderr: '' };
  jobs.set(jobId, job);
  child.stdout.on('data', chunk => { job.stdout = (job.stdout + chunk).slice(-2_000_000); });
  child.stderr.on('data', chunk => { job.stderr = (job.stderr + chunk).slice(-16_000); });
  child.on('error', error => { job.state = 'failed'; job.error = error.message; });
  child.on('close', code => { job.state = code === 0 ? 'completed' : 'failed'; job.finishedAt = new Date().toISOString(); if (code !== 0) job.error ||= job.stderr || `Process exited with ${code}`; });
  return { jobId, directory, state: 'running', next: 'Call cuetake_job after roughly 10 seconds; do not assume completion until it reports completed.' };
}
server.tool('cuetake_doctor', 'Check local runtime dependencies; makes no installations.', {}, safe(doctor));
server.tool('cuetake_record', 'Run a trusted local scenario. Returns a job ID immediately. Captures, renders and verifies a new take.', {
  scenarioPath: z.string(), outputDir: z.string().optional(), authProfile: z.string().optional(),
}, safe(({ scenarioPath, outputDir, authProfile }) => startJob('record', scenarioPath, resolve(outputDir || join(homedir(), 'Movies/CueTake', new Date().toISOString().replace(/[:.]/g, '-'))), authProfile)));
server.tool('cuetake_render', 'Re-render and verify a saved take after editing its camera.json or project.json. No new browser capture.', { directory: z.string() }, safe(({ directory }) => startJob('render', directory, resolve(directory))));
server.tool('cuetake_verify', 'Verify a saved final MP4 and its metadata without re-rendering.', { directory: z.string() }, safe(({ directory }) => startJob('verify', directory, resolve(directory))));
server.tool('cuetake_job', 'Read job completion, progress, artifact paths and verification. Job IDs belong to this MCP session.', { jobId: z.string() }, safe(async ({ jobId }) => {
  const job = jobs.get(jobId);
  if (!job) throw new Error('Unknown job ID');
  let stage;
  try { stage = JSON.parse(await fs.readFile(join(job.directory, 'project.json'), 'utf8')).status; } catch {}
  let verification;
  if (job.state === 'completed') {
    const report = JSON.parse(await fs.readFile(join(job.directory, 'verification.json'), 'utf8'));
    verification = { passed: report.passed, media: report.media, sourceNote: report.source.note };
  }
  return { jobId, state: job.state, stage, directory: job.directory, ...(verification ? { final: join(job.directory, 'final.mp4'), verification } : {}), ...(job.error ? { error: job.error } : {}) };
}));
server.tool('cuetake_auth_open', 'Open a separate login browser without recording. The user can complete SSO/2FA; then call auth_save after they confirm.', { url: z.string().url(), profile: z.string() }, safe(({ url, profile }) => openAuth(url, profile)));
server.tool('cuetake_auth_save', 'Save completed login locally for reuse. Call only after the user has completed login. Never returns cookies or tokens.', { sessionId: z.string() }, safe(({ sessionId }) => finishAuth(sessionId)));
async function shutdown() { for (const job of jobs.values()) if (job.state === 'running') job.child.kill('SIGTERM'); await closeAuthSessions(); }
process.on('SIGINT', async () => { await shutdown(); process.exit(0); });
process.on('SIGTERM', async () => { await shutdown(); process.exit(0); });
server.server.onclose = shutdown;
await server.connect(new StdioServerTransport());
