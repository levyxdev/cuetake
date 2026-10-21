# Scenario API and take folders

A scenario is trusted JavaScript exporting `config`, optional `prepare(page)`, and `run(director)`. Do not execute scenario modules from an untrusted source.

```js
export const config = {
  name: 'product-editor',
  url: 'http://localhost:3000/editor',
  viewport: { width: 1440, height: 900 },
  capture: { fps: 60, resolutionScale: 2 },
  cursor: { style: 'arrow', size: 24, color: '#ffffff' },
  clickEffect: { style: 'spark', radius: 32, length: 16, count: 8, duration: 420 },
  output: { size: '2160p', aspect: '16:9', quality: 22 },
  frame: { window: 'browser', background: 'aurora', padding: 0.08, radius: 12, shadow: true },
  camera: {
    maxZoom: 2,
    minZoom: 1.2,
    padding: 48,
    transitionDuration: 0.48,
    panDuration: 0.42,
    preLead: 0.48,
    holdPerTarget: 3,
    chainGap: 5,
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

Only `name` and `url` are required in config. Other fields use the shown defaults. Capture FPS accepts 30 or 60. Resolution scale accepts 1 or 2. Widths and heights must be even. There is no audio capture.

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
| `time()` | Seconds elapsed since capture started. |

`move` starts from (0,0). If preparation positioned the cursor elsewhere, initialize it with `await d.move(x, y, 0)` at the start of `run`.

With explicit `focus` targets, the camera uses only those targets. Otherwise it follows the clicks, typing and drags the page observed, whether they came from the director or from Playwright input directly; pass `focus: false` to an action to keep the camera wide for it. A bare number still works as the action's timing. Each target is framed with `padding` CSS px around its box, zooming at most `maxZoom`; boxes too large to reach `minZoom` stay wide. Set `zoom` on a target in `edit.json` to fix it. Focus boxes always use CSS pixels, even when the source is captured at 2× scale. Nearby targets stay in one camera chain according to `holdPerTarget` and `chainGap`, and the camera changes zoom as it moves between them.

Use actual locators for clicks. Canvas drags often require coordinates; derive or validate them for the configured viewport. Keep setup outside capture, hold important states, and assert meaningful application changes. An exception marks the take failed and closes the isolated browser.

## Take folder

```text
<output>/<scenario>/<take>/
  project.json       Scenario config, status, application evidence, duration
  scenario.mjs       Snapshot of the original scenario module
  source.webm        Source: original high-resolution VP9 capture
  capture.json       Track settings and video frame callback observations
  timeline.json      Timeline: pointer path, clicks, drags, typing and focus, in seconds and CSS pixels
  edit.json          Edit: camera targets and settings, cursor, click effect, frame, output
  poster.png         Final page state at native capture resolution
  final.mp4          Final: H.264 camera composition
  render.json        Encoder, rate control and GPU used by the last Render
  verification.json Output metadata, decode result, capture observations
```

A copied scenario snapshot may import helper modules from its original project. It is a record of the scenario, not a bundled runnable archive. Keep business scenarios in their application repository.

To edit a completed take, change `edit.json` (camera settings, target boxes and times, cursor, click effect, frame, output), then run `cuetake render <take>`. The Scenario config only seeds the first Edit. Changing what happens on the page requires recording again. `render` automatically runs verification; `verify` checks without rendering.

`output.size` names the Final's short side (`1080p`, `1440p`, `2160p`, or an even pixel count) and `output.aspect` is `16:9`, `1:1` or `9:16`; both are independent of device scale. `frame` places the page in a window on a background: `window` is `browser` (with an address bar showing `url`, which defaults to the Scenario's host), `macos` or `none`; `background` is `aurora`, `sunset`, `ocean`, `graphite`, `paper`, `auto` (a mesh around the page's brand color) or `blur` (the page itself, blurred); `padding` is a fraction of the short side; `radius` is in 1080p pixels. Set `frame: false` to let the page fill the Final at the viewport's aspect. The camera zooms the whole stage, so background may show beside the page when a target sits near its edge. `edit.json` also carries `output.fps`, the Final's frame rate, which a new Take takes from `capture.fps`. `output.quality` is the H.264 quantizer (10–40, default 22): lower is sharper and larger. Encoders without a quantizer mode fall back to a bitrate, recorded in `render.json`.

Click effects default to a white, dark-outlined spark matching the arrow. Set style to `none` to disable. Geometry is in CSS pixels and duration is milliseconds. Login is passed separately as a named runtime auth profile, never embedded in scenario config; see [authentication.md](authentication.md).
