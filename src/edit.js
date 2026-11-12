import { z } from 'zod';
import { isPopup } from './tabs.js';

/**
 * An Edit holds every choice Render makes; a Scenario's config only seeds the first one. Styling is
 * agent-written and not validated (ADR 0005): defaults fill in what an Edit leaves out, and anything
 * else an item names is passed to its shader or drawing code as a parameter.
 *
 * Drawn things are items: `{ shader }`, `{ draw }` or `{ image }` naming a file (relative to the Take)
 * or a built-in (a name without an extension, see styles.js), plus optional `files` and parameters.
 */
export const EDIT_VERSION = 3;
export const evenSize = z.number().int().min(240).max(7680).refine(n => n % 2 === 0, 'Must be an even pixel count');

/** Times are seconds except clickEffect.duration, which is milliseconds; geometry is CSS pixels. */
export const DEFAULT_STYLE = {
  // The Cursor shrinks to `press` while a button is held; `false` turns that off. A click shows on the
  // Cursor, so no click effect is drawn unless named.
  cursor: { draw: 'arrow', size: 24, color: '#ffffff', press: 0.8 },
  clickEffect: false,
  // quality is the H.264 quantizer (lower is sharper and larger). shutter is the fraction of each
  // frame over which the camera and the Cursor blur as they move (shutter.js); 0 turns blur off.
  output: { width: 3840, height: 2160, quality: 22, shutter: 0.5 },
  // padding is a fraction of the short side, one number or [top, right, bottom, left]; radius is in 1080p pixels.
  frame: { padding: 0.08, radius: 12, chrome: { draw: 'browser' }, background: [{ shader: 'fluted' }], effects: [{ shader: 'shadow' }] },
  // See camera.js. Each target is framed with `padding` CSS px around it, zooming at most `maxZoom`;
  // fits below `minZoom` stay wide. The camera arrives `lead` before an action, holds `hold` after the
  // last one in a segment, settles in about `response`, and returns wide `endWide` before the end.
  camera: { maxZoom: 2, minZoom: 1.2, padding: 48, lead: 0.6, hold: 1.5, chainGap: 2, response: 0.6, follow: true, endWide: 1.5 },
  // Shortcuts show as keycaps over the Final, outside the camera, for `duration` seconds after each
  // press; presses of the same keys meanwhile count up. A key pressed without Control, Alt, Shift or
  // Meta shows only with `singleKeys`. `false` shows none.
  keycaps: { draw: 'keycaps', duration: 1.5, singleKeys: false },
  // Drawn over the Final, outside the camera, while a Line is spoken; `burn: false` keeps them to the
  // subtitle files. Rows hold up to `maxChars` (about 16 in Chinese, 42 otherwise), `maxRows` to a cue,
  // each shown at least `minDuration`.
  subtitles: { draw: 'subtitles', burn: true },
  // Drawn over the Final, outside the camera, while it fast-forwards, such as { draw: 'fast-forward' };
  // `false` shows none.
  fastForwardBadge: false,
  // How the Final shows the Tabs (tabs.js): the window cuts to a tab of its own size, or fades over
  // `{ fade }` seconds; a popup window scales and fades in and out over `duration`, from `scale`, unless
  // `popupAnimation` is false. Times are Final seconds.
  tabs: { transition: 'cut', popupAnimation: { duration: 0.2, scale: 0.9 } },
};

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Naming what draws an item starts a new item, so the old drawing's parameters do not leak into it. */
const namesDrawing = value => ['shader', 'draw', 'image'].some(key => key in value);
/** `over` wins field by field: nested objects merge; anything else, including arrays and `false`, replaces. */
export function merge(base, over) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(over ?? {})) {
    if (value === undefined) continue;
    merged[key] = isObject(value) && isObject(base?.[key]) && !namesDrawing(value) ? merge(base[key], value) : value;
  }
  return merged;
}

/** A complete Edit: the defaults under whatever `edit` names. */
export function withDefaults(edit) {
  return merge({ schemaVersion: EDIT_VERSION, ...DEFAULT_STYLE, output: { ...DEFAULT_STYLE.output, fps: 60 }, camera: { ...DEFAULT_STYLE.camera, targets: [], scrolls: [] }, tabs: { ...DEFAULT_STYLE.tabs, placement: [] }, shortcuts: [], fastForward: [], masks: [], narration: { volume: 1, lines: [] } }, edit);
}

// Seconds after a click within which the App's focus moving to what holds its target counts as the click's.
const FOCUS_AFTER_CLICK = 1;

/**
 * Camera targets: observed clicks, typing and drags, and each element an App focused, each in the CSS
 * pixels of its Tab, and each popup window's whole page as it first comes in front, except those
 * inside a `wide` window ({ start, end } seconds) from an action with `focus: false`, and focus a click
 * gave to what holds its target. Like a manual zoom in Screen Studio, an explicit focus
 * target replaces only the automatic targets inside its own span (from `lead` before it to `hold` after).
 */
export function cameraTargets(timeline, focus, wide = [], camera = {}) {
  const { lead, hold } = { ...DEFAULT_STYLE.camera, ...camera };
  const spans = focus.map(f => ({ start: f.t - lead, end: (f.until ?? f.t) + hold }));
  const inside = (t, windows) => windows.some(w => t >= w.start && t <= w.end);
  const tabs = new Map((timeline.tabs ?? []).map(tab => [tab.id, tab])), framed = new Set();
  // Focus a click gave to what holds its target, such as the text area around a link, adds only a larger box.
  const holds = (outer, inner) => outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;
  const byClick = focused => timeline.events.some(event => event.type === 'click' && event.box && event.tab === focused.tab && event.t <= focused.t && focused.t - event.t <= FOCUS_AFTER_CLICK && holds(focused.box, event.box));
  const automatic = timeline.events.filter(event => !inside(event.t, wide) && !inside(event.t, spans)).flatMap(event => {
    const tab = event.tab === undefined ? {} : { tab: event.tab };
    if (event.type === 'focused' && byClick(event)) return [];
    if ((event.type === 'click' || event.type === 'focused') && event.box) return [{ t: event.t, box: event.box, ...tab }];
    if (event.type === 'type' && event.box) return [{ t: event.t, box: event.box, until: event.end, ...tab }];
    if (event.type === 'drag') {
      const x = Math.min(event.from.x, event.to.x), y = Math.min(event.from.y, event.to.y);
      return [{ t: event.t, box: { x, y, width: Math.abs(event.to.x - event.from.x), height: Math.abs(event.to.y - event.from.y) }, until: event.end, ...tab }];
    }
    const opened = tabs.get(event.tab);
    if (event.type === 'front' && opened && isPopup(opened, timeline.viewport) && !framed.has(event.tab)) {
      framed.add(event.tab);
      return [{ t: event.t, box: { x: 0, y: 0, ...opened.viewport }, tab: event.tab }];
    }
    return [];
  });
  return [...automatic, ...focus].sort((a, b) => a.t - b.t);
}

/** What the address bar shows for a page address: its host, or the whole address when it has none. */
export function addressOf(url) {
  try { const parsed = new URL(url); return /^https?:$/.test(parsed.protocol) ? parsed.host : url; } catch { return url; }
}

/**
 * The address bar's text when Capture started (`url`), and each change after it (`urls`, as
 * { t, url, tab } in Source time): a full navigation to another host shows the new one from the moment
 * the page took its address. A Tab the demo opens shows the host it opened on, or nothing until its
 * first document commits when it opened on about:blank. The Scenario's `frame.url`, when set, names
 * the host Capture started on, also when a navigation comes back to it.
 */
export function addressBar(config, timeline) {
  const first = addressOf(timeline.url ?? config.url), shown = host => host === first ? config.frame?.url ?? first : host;
  const urls = [], current = new Map([[0, first]]);
  const change = (t, url, tab) => {
    const host = !url || url === 'about:blank' ? '' : addressOf(url);
    if (host !== (current.get(tab) ?? '')) urls.push({ t, url: shown(host), tab });
    current.set(tab, host);
  };
  const opened = (timeline.tabs ?? []).slice(1).map(tab => ({ t: tab.opened, url: tab.url, tab: tab.id }));
  const committed = (timeline.events ?? []).filter(event => event.type === 'navigate' && event.commit !== undefined).map(event => ({ t: event.commit, url: event.url, tab: event.tab ?? 0 }));
  for (const { t, url, tab } of [...opened, ...committed].sort((a, b) => a.t - b.t)) change(t, url, tab);
  return { url: shown(first), urls };
}

/**
 * The first Edit of a Take. Each Line starts where the Scenario said it (`d.say`); its text, audio and
 * word timings stay in the Take's Narration, since they change only with new audio. The Shortcuts the
 * Timeline recorded are the ones shown, so one can be relabeled or removed without recording again, and
 * so are the waits the Scenario fast-forwarded (`d.fastForward`), so one can be retimed (time-map.js),
 * and the elements it masked (`d.mask`), so a mask can be retimed, restyled or removed (masks.js).
 */
export function createEdit(config, timeline, focus, wide = []) {
  return withDefaults({
    cursor: config.cursor, clickEffect: config.clickEffect, keycaps: config.keycaps, subtitles: config.subtitles, fastForwardBadge: config.fastForwardBadge, output: { ...config.output, fps: config.capture.fps },
    // The browser chrome shows the host the page is on, unless the config names something else. A Take
    // of Apps shows the App's own windows, without chrome, unless the config names one (ADR 0009).
    frame: config.app ? { chrome: false, ...config.frame } : { ...config.frame, ...addressBar(config, timeline) },
    camera: { ...config.camera, targets: cameraTargets(timeline, focus, wide, config.camera), scrolls: timeline.events.filter(event => event.type === 'scroll').map(({ t, end }) => ({ start: t, end })) }, tabs: config.tabs,
    shortcuts: timeline.events.filter(event => event.type === 'shortcut').map(({ t, keys }) => ({ t, keys })),
    fastForward: timeline.events.filter(event => event.type === 'fastForward').map(({ t, end, rate }) => ({ start: t, end, rate })),
    masks: timeline.events.filter(event => event.type === 'mask').map(({ type, t, end, effect, element, ...params }) => ({ effect, element, start: t, ...(end !== null && end !== undefined && { end }), ...params })),
    narration: { lines: timeline.events.filter(event => event.type === 'say').map(event => ({ id: event.id, start: event.t })) },
  });
}
