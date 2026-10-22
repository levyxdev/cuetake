import { z } from 'zod';
import { SHORT_SIDE, CHROME_HEIGHT, BACKGROUNDS } from './stage.js';

/** An Edit holds every choice Render makes; a Scenario's config only seeds the first one. */
export const evenSize = z.number().int().min(240).max(7680).refine(n => n % 2 === 0, 'Must be an even pixel count');
const box = z.object({ x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative() });

// size names the Final's short side; quality is the H.264 quantizer (lower is sharper and larger).
export const outputFields = z.object({
  size: z.union([z.enum(Object.keys(SHORT_SIDE)), evenSize]).default('2160p'),
  aspect: z.enum(['16:9', '1:1', '9:16']).default('16:9'),
  quality: z.number().int().min(10).max(40).default(22),
});

// The page in a window on a background. Radius is in 1080p pixels.
export const frameFields = z.object({
  window: z.enum(Object.keys(CHROME_HEIGHT)).default('browser'),
  background: z.enum([...Object.keys(BACKGROUNDS), 'auto', 'blur']).default('aurora'),
  padding: z.number().min(0).max(0.3).default(0.08),
  radius: z.number().min(0).max(48).default(12),
  shadow: z.boolean().default(true),
  url: z.string().max(200).optional(),
});

/** Times are seconds except clickEffect.duration, which is milliseconds; geometry is CSS pixels. */
export const editFields = {
  cursor: z.object({ style: z.enum(['arrow', 'dot']).default('arrow'), size: z.number().min(12).max(64).default(24), color: z.string().regex(/^#[a-fA-F0-9]{6}$/).default('#ffffff') }).default({}),
  clickEffect: z.object({ style: z.enum(['spark', 'none']).default('spark'), radius: z.number().min(8).max(80).default(32), length: z.number().min(4).max(40).default(16), count: z.number().int().min(4).max(16).default(8), duration: z.number().min(150).max(1000).default(420) }).default({}),
  output: outputFields.default({}),
  // `false` lets the page fill the Final.
  frame: z.union([z.literal(false), frameFields]).default({}),
  // See camera.js. Each target is framed with `padding` CSS px around it, zooming at most `maxZoom`;
  // fits below `minZoom` stay wide. The camera arrives `lead` before an action, holds `hold` after the
  // last one in a segment, settles in about `response`, and returns wide `endWide` before the end.
  camera: z.object({
    maxZoom: z.number().min(1).max(4).default(2), minZoom: z.number().min(1).max(4).default(1.2), padding: z.number().min(0).max(400).default(48),
    lead: z.number().min(0).max(3).default(0.6), hold: z.number().min(0).max(30).default(1.5), chainGap: z.number().min(0).max(30).default(2),
    response: z.number().min(0.1).max(3).default(0.6), follow: z.boolean().default(true), endWide: z.number().min(0).max(10).default(1.5),
  }).default({}),
};

/** A camera target is a CSS-pixel box the camera reaches at `t` seconds and holds at least until `until`, optionally at a fixed `zoom`. */
const target = z.object({ t: z.number().nonnegative(), box, until: z.number().nonnegative().optional(), zoom: z.number().min(1).max(4).optional() });

export const editSchema = z.object({
  schemaVersion: z.literal(2),
  ...editFields,
  camera: editFields.camera.removeDefault().extend({ targets: z.array(target).default([]) }).default({}),
  // The Final's frame rate; a new Take takes it from the Scenario's capture rate.
  output: outputFields.extend({ fps: z.union([z.literal(30), z.literal(60)]).default(60) }).default({}),
});

/**
 * Camera targets: observed clicks, typing and drags, except those inside a `wide` window ({ start, end }
 * seconds) from an action with `focus: false`. Like a manual zoom in Screen Studio, an explicit focus
 * target replaces only the automatic targets inside its own span (from `lead` before it to `hold` after).
 */
export function cameraTargets(timeline, focus, wide = [], { lead, hold } = editFields.camera.parse({})) {
  const spans = focus.map(f => ({ start: f.t - lead, end: (f.until ?? f.t) + hold }));
  const inside = (t, windows) => windows.some(w => t >= w.start && t <= w.end);
  const automatic = timeline.events.filter(event => !inside(event.t, wide) && !inside(event.t, spans)).flatMap(event => {
    if (event.type === 'click' && event.box) return [{ t: event.t, box: event.box }];
    if (event.type === 'type' && event.box) return [{ t: event.t, box: event.box, until: event.end }];
    if (event.type === 'drag') {
      const x = Math.min(event.from.x, event.to.x), y = Math.min(event.from.y, event.to.y);
      return [{ t: event.t, box: { x, y, width: Math.abs(event.to.x - event.from.x), height: Math.abs(event.to.y - event.from.y) }, until: event.end }];
    }
    return [];
  });
  return [...automatic, ...focus].sort((a, b) => a.t - b.t);
}

export function createEdit(config, timeline, focus, wide = []) {
  return editSchema.parse({
    schemaVersion: 2,
    cursor: config.cursor, clickEffect: config.clickEffect, output: { ...config.output, fps: config.capture.fps },
    // The browser chrome shows the Scenario's host unless the config names something else.
    frame: config.frame && { url: new URL(config.url).host, ...config.frame },
    camera: { ...config.camera, targets: cameraTargets(timeline, focus, wide, config.camera) },
  });
}
