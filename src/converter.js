import { execFile } from 'node:child_process';
import { access, stat, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { buildFFmpegZoomFilter } from './zoom.js';
const exec = promisify(execFile);
const run = (cmd, args) => exec(cmd, args, { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
const checkFfmpeg = () => run('ffmpeg', ['-version']);
const loadTimeline = async path => JSON.parse(await readFile(path, 'utf8'));

export async function convertWithZoomMp4(webmPath, timelinePath, options = {}) {
  await checkFfmpeg();
  await access(webmPath);

  const timeline = await loadTimeline(timelinePath);
  const zoomFilter = buildFFmpegZoomFilter(timeline, {
    zoomLevel: options.zoomLevel || 2.5,
    transitionDuration: options.transitionDuration || 0.35,
    holdPerTarget: options.holdPerTarget || 0.8,
    preLead: options.preLead ?? 0.25,
    panDuration: options.panDuration || 0.25,
    chainGap: options.chainGap ?? 2.5,
    fps: options.fps || 60,
    width: options.width || timeline.viewport.width,
  });

  const mp4Path = options.outputPath || webmPath.replace(/\.webm$/, '-zoom.mp4');
  const crf = options.crf ?? 16;

  const outputWidth = options.width || timeline.viewport.width;
  const outputHeight = Math.round(outputWidth * timeline.viewport.height / timeline.viewport.width / 2) * 2;
  const duration = timeline.duration;
  // MediaRecorder may omit the end of a static hold. Extend source frames
  // before camera evaluation, then cut to the measured take duration.
  const holdTail = Number.isFinite(duration) && duration > 0
    ? `tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration},`
    : '';
  const filterArgs = ['-vf', holdTail + (zoomFilter || `fps=${options.fps || 60},scale=${outputWidth}:${outputHeight}:flags=lanczos`)];

  await run('ffmpeg', [
    '-i', webmPath,
    '-threads', '4',
    ...filterArgs,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', String(crf),
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-y', mp4Path
  ]);

  const mp4Stat = await stat(mp4Path);
  return {
    mp4Path,
    sizeBytes: mp4Stat.size,
    sizeMB: (mp4Stat.size / 1024 / 1024).toFixed(2),
    zoomEvents: timeline.events.filter(e => e.boundingBox).length,
  };
}
