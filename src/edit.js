import { z } from 'zod';

/** An Edit holds every choice Render makes; a Scenario's config only seeds the first one. */
const evenSize = z.number().int().min(240).max(7680).refine(n => n % 2 === 0, 'Must be an even pixel count');
const box = z.object({ x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative() });

export const editFields = {
  cursor: z.object({ style: z.enum(['arrow', 'dot']).default('arrow'), size: z.number().min(12).max(64).default(24), color: z.string().regex(/^#[a-fA-F0-9]{6}$/).default('#ffffff') }).default({}),
  clickEffect: z.object({ style: z.enum(['spark', 'none']).default('spark'), radius: z.number().min(8).max(80).default(32), length: z.number().min(4).max(40).default(16), count: z.number().int().min(4).max(16).default(8), duration: z.number().min(150).max(1000).default(420) }).default({}),
  // quality is the H.264 quantizer: lower is sharper and larger. Encoders without quantizer mode use a bitrate.
  output: z.object({ width: evenSize.default(1920), quality: z.number().int().min(10).max(40).default(22) }).default({}),
  camera: z.object({ zoomLevel: z.number().min(1).max(4).default(1.5), transitionDuration: z.number().min(0.1).max(3).default(0.48), panDuration: z.number().min(0.1).max(3).default(0.42), preLead: z.number().min(0).max(3).default(0.48), holdPerTarget: z.number().min(0.1).max(30).default(3), chainGap: z.number().min(0).max(30).default(5) }).default({}),
};

/** A camera target is a CSS-pixel box the camera reaches at `t` seconds and holds at least until `until`. */
const target = z.object({ t: z.number().nonnegative(), box, until: z.number().nonnegative().optional() });

export const editSchema = z.object({
  schemaVersion: z.literal(2),
  ...editFields,
  camera: editFields.camera.removeDefault().extend({ targets: z.array(target).default([]) }).default({}),
});

/** Explicit focus targets win; otherwise the camera follows observed clicks, typing and drags. */
export function cameraTargets(timeline, focus) {
  if (focus.length) return focus;
  return timeline.events.flatMap(event => {
    if (event.type === 'click' && event.box) return [{ t: event.t, box: event.box }];
    if (event.type === 'type' && event.box) return [{ t: event.t, box: event.box, until: event.end }];
    if (event.type === 'drag') {
      const x = Math.min(event.from.x, event.to.x), y = Math.min(event.from.y, event.to.y);
      return [{ t: event.t, box: { x, y, width: Math.abs(event.to.x - event.from.x), height: Math.abs(event.to.y - event.from.y) }, until: event.end }];
    }
    return [];
  });
}

export function createEdit(config, timeline, focus) {
  return editSchema.parse({
    schemaVersion: 2,
    cursor: config.cursor, clickEffect: config.clickEffect, output: config.output,
    camera: { ...config.camera, targets: cameraTargets(timeline, focus) },
  });
}
