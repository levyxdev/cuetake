# Scenario API and take folders

A scenario is trusted JavaScript exporting `config`, optional `prepare(page)`, and `run(director)`. Do not execute scenario modules from an untrusted source.

```js
export const config = {
  name: 'product-editor',
  url: 'http://localhost:3000/editor',
  viewport: { width: 1440, height: 900 },
  capture: { fps: 60, resolutionScale: 2 },
  // Styling seeds the first Edit; see styling.md. File paths are relative to this file.
  output: { width: 3840, height: 2160, quality: 22 },
  frame: { padding: 0.08, chrome: { draw: 'browser' }, background: [{ shader: 'fluted' }] },
  camera: {
    maxZoom: 2,
    minZoom: 1.2,
    padding: 48,
    lead: 0.6,
    hold: 1.5,
    chainGap: 2,
    response: 0.6,
    follow: true,
    endWide: 1.5,
  },
};

export async function prepare(page) {
  // Runs before capture. Load a free example, wait for assets, open the editor.
  await page.getByRole('button', { name: 'Use example' }).click();
}

export async function run(d) {
  await d.at(1);
  await d.click(d.page.getByRole('button', { name: 'Preview' }));
  await d.at(5);
  return { previewOpened: true }; // Prefer evidence checked against the real UI.
}
```

Only `name` and `url` are required in config. Other fields use the shown defaults. Capture FPS accepts 30 or 60. Resolution scale accepts 1 or 2. Widths and heights must be even. Page audio is not captured; a voiced Narration is added with `record --narration` ([narration.md](narration.md)).

## Director

| API | Behavior |
| --- | --- |
| `page` | The isolated Playwright page; use its locators and assertions. |
| `at(seconds)` | Wait until a time relative to the capture start. Past times return immediately. |
| `wait(ms)` | Hold the current state. |
| `move(x, y, durationMs=500)` | Move along a smooth path using viewport CSS coordinates. |
| `click(locator, { duration=450, focus })` | Move to a visible locator and click. A CSS selector also works. |
| `type(locator, text, { msPerChar=70, focus })` | Click a field, then type with a visible per-character delay. |
| `drag({x,y}, {x,y}, { duration=1200, focus })` | Move to the start, press, move, then release. |
| `focus({x,y,width,height}, seconds?)` | Add a camera target; defaults to the current time. |
| `say(id, text?)` | Start a Narration Line. With `--narration` it waits until the Line's audio ends; without, `text` is required and it does not wait. See [narration.md](narration.md). |
| `time()` | Seconds elapsed since capture started. |

`move` starts from (0,0). If preparation positioned the cursor elsewhere, initialize it with `await d.move(x, y, 0)` at the start of `run`.

The camera works like Screen Studio's auto zoom. It follows the clicks, typing and drags the page observed, whether they came from the director or from Playwright input directly:

- It arrives `lead` seconds before each action, so the zoom is in place when the action happens.
- Actions whose zoom windows sit within `chainGap` seconds share one zoom segment: the camera stays zoomed and moves between them instead of zooming out and back in.
- It holds `hold` seconds after the segment's last action (after typing ends, for typing), then returns to the wide shot.
- While zoomed it follows the cursor, keeping it in the central 70% of the view (`follow: false` turns this off).
- Movement is a critically damped spring that settles in about `response` seconds and never overshoots.
- Every Final ends wide: the camera heads back `endWide` seconds before the end, so leave at least 2 seconds after the last action for the result to be seen in context.

Each target is framed with `padding` CSS px around its box, zooming at most `maxZoom`; boxes too large to reach `minZoom` stay wide. Set `zoom` on a target in `edit.json` to fix it. Pass `focus: false` to an action to keep the camera wide for it; a bare number still works as the action's timing. `d.focus(box)` adds a deliberate target and, like a manual zoom in Screen Studio, replaces only the automatic targets within its own span; the rest of the Take keeps following actions. Focus boxes always use CSS pixels, even when the source is captured at 2× scale.

Use actual locators for clicks. Canvas drags often require coordinates; derive or validate them for the configured viewport. Keep setup outside capture, hold important states, and assert meaningful application changes. An exception marks the take failed and closes the isolated browser.

## Take folder

```text
<output>/<scenario>/<take>/
  project.json       Scenario config, status, application evidence, duration
  scenario.mjs       Snapshot of the original scenario module
  source.webm        Source: original high-resolution VP9 capture
  capture.json       Track settings and video frame callback observations
  timeline.json      Timeline: pointer path, clicks, drags, typing, focus and said Lines, in seconds and CSS pixels
  edit.json          Edit: camera targets and settings, cursor, click effect, frame, Line starts and volumes, Subtitles, output
  narration/         The Narration: narration.json (text, word timings) and each Line's audio, named by its id
  subtitles.srt/.vtt Subtitles of the placed Lines, from the last Render
  styles/            Shaders, drawing code and images the Edit names
  poster.png         Final page state at native capture resolution
  preview.png        Preview: the current Edit beside candidate Looks, from the last `preview`
  final.mp4          Final: H.264 camera composition
  render.json        Encoder, rate control and GPU used by the last Render
  verification.json Output metadata, decode result, capture observations
```

A copied scenario snapshot may import helper modules from its original project. It is a record of the scenario, not a bundled runnable archive. Keep business scenarios in their application repository.

To edit a completed take, change `edit.json` (camera settings, target boxes and times, and the styling in [styling.md](styling.md)), then run `cuetake render <take>`. To compare styling first, run `cuetake preview <take> --look <name|file.json>...`, which composes stills without touching `edit.json` or the Final. A Look is a partial Edit holding any styling and camera settings, but not camera targets, `frame.url` or `output.fps`. `cuetake look apply` merges one into `edit.json`, and `cuetake record --look` seeds a new take's Edit with it under the Scenario config. The Scenario config only seeds the first Edit. Changing what happens on the page requires recording again. `render` automatically runs verification; `verify` checks without rendering.

`edit.json` also carries `output.fps`, the Final's frame rate, which a new Take takes from `capture.fps`, and `frame.url`, the address bar's text, which defaults to the Scenario's host. Encoders without a quantizer mode fall back to a bitrate, recorded in `render.json`.

Login is passed separately as a named runtime auth profile, never embedded in scenario config; see [authentication.md](authentication.md).
