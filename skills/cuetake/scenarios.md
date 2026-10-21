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
  output: { width: 1920, crf: 16 },
  camera: {
    zoomLevel: 1.5,
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
| `click(locator, durationMs=450)` | Move to a visible locator, click, and save a focusable event. A CSS selector also works. |
| `type(locator, text, msPerChar=70)` | Click a field, then type with a visible per-character delay. |
| `drag({x,y}, {x,y}, durationMs=1200)` | Move to the start, press, move, then release. |
| `focus({x,y,width,height}, seconds?)` | Add a camera target; defaults to the current time. |
| `time()` | Seconds elapsed since capture started. |

`move` starts from (0,0). If preparation positioned the cursor elsewhere, initialize it with `await d.move(x, y, 0)` at the start of `run`.

With explicit `focus` targets, the camera uses those targets. Otherwise it follows recorded clicks. Focus boxes always use CSS pixels, even when the source is captured at 2× scale. Nearby targets stay in one camera chain according to `holdPerTarget` and `chainGap`.

Use actual locators for clicks. Canvas drags often require coordinates; derive or validate them for the configured viewport. Keep setup outside capture, hold important states, and assert meaningful application changes. An exception marks the take failed and closes the isolated browser.

## Take folder

```text
<output>/<scenario>/<take>/
  project.json       Configuration, status, application evidence, duration
  scenario.mjs       Snapshot of the original scenario module
  source.webm        Original high-resolution VP9 capture
  capture.json       Track settings and video frame callback observations
  timeline.json      All recorded focus/click events
  camera.json        Selected events used by the camera renderer
  poster.png         Final page state at native capture resolution
  final.mp4          H.264 camera composition
  verification.json Output metadata, decode result, capture observations
```

A copied scenario snapshot may import helper modules from its original project. It is a record of the scenario, not a bundled runnable archive. Keep business scenarios in their application repository.

To edit a completed take, change `project.json` camera/output fields or the event boxes and timestamps in `camera.json`, then run `cuetake render <take>`. Input changes require recording again; changing a baked-in arrow also requires a new capture. `render` automatically runs verification; `verify` checks without rendering.

Output width and aspect ratio are independent of device scale. For example: a 1440×900 viewport at 2× produces a 2880×1800 source. At a 1.5× camera zoom, a 1920×1200 output can use the cropped source without enlarging its pixels.

Click effects default to a white, dark-outlined spark matching the arrow. Set style to `none` to disable. Geometry is in CSS pixels and duration is milliseconds. Login is passed separately as a named runtime auth profile, never embedded in scenario config; see [authentication.md](authentication.md).
