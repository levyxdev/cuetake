# Scenario API and take folders

A scenario is trusted JavaScript exporting `config`, optional `prepare(page)`, and `run(director)`. Do not execute scenario modules from an untrusted source.

```js
export const config = {
  name: 'product-editor',
  url: 'http://localhost:3000/editor',
  viewport: { width: 1440, height: 900 },
  capture: { fps: 60, resolutionScale: 2 },
  director: { speed: 1, seed: 1 },
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

Only `name` and `url` are required in config. Other fields use the shown defaults. `director.speed` scales how fast the Director moves, pauses and types (`1.25` is a quarter faster); `director.seed` picks another, equally human way to move. Capture FPS accepts 30 or 60. Resolution scale accepts 1 or 2; left unset, it is 2, or 1 when `doctor` finds Chromium drawing without a GPU, which `record` reports under `capture`. Widths and heights must be even. Page audio is not captured; a voiced Narration is added with `record --narration` ([narration.md](narration.md)).

## Director

| API | Behavior |
| --- | --- |
| `page` | The isolated Playwright page; use its locators and assertions. A locator inside an iframe, such as `d.page.frameLocator('iframe[name=checkout]').getByLabel('Card number')`, works with every action, cross-origin and nested frames included. |
| `at(seconds)` | Wait until a time relative to the capture start. Past times return immediately. |
| `wait(ms)` | Hold the current state. |
| `move(x, y, durationMs?)` | Move along a slight arc using viewport CSS coordinates. `0` jumps there. |
| `hover(locator, { duration })` | Move onto a visible locator and rest there without pressing, so the page shows its hover state. It adds no camera target; use `focus` to frame what it reveals. |
| `click(locator, { duration, button, focus })` | Move to a visible locator, pause, press near its center for about a tenth of a second, release, pause. A CSS selector also works. `button: 'right'` opens the page's context menu. |
| `press(keys, { focus })` | Pause, press a key or combination on whatever has focus, such as `'Meta+K'`, `'ControlOrMeta+Z'` or `'Escape'`, hold it for a moment, pause. The Final shows it as keycaps (see below). |
| `type(locator, text, { msPerChar=70, focus })` | Click a field, then type with uneven per-character delays averaging `msPerChar`, longer after a word. |
| `drag({x,y}, {x,y}, { duration, focus })` | Move to the start, press, move more slowly than an empty-handed move, then release. |
| `focus({x,y,width,height}, seconds?)` | Add a camera target; defaults to the current time. |
| `say(id, text?)` | Start a Narration Line. With `--narration` it waits until the Line's audio ends; without, `text` is required and it does not wait. See [narration.md](narration.md). |
| `fastForward(wait, { rate=4 })` | Run `wait`, a function that waits on the page, such as `() => reply.waitFor()`, and return its result; the Final plays that span `rate` times faster. |
| `time()` | Seconds elapsed since capture started. |

The Director moves like a person. A move takes longer the farther and smaller its target is (Fitts's law), starts quickly and settles slowly, and at the default speed stays under about 2000 CSS px/s; it pauses briefly before pressing and after releasing, and holds a click's button for a moment, so the Cursor's press shows. A `duration` fixes one move's length in ms and `msPerChar` one field's typing pace; the arc, pauses and uneven typing stay. The same Scenario and `seed` move the same way on every recording. Changing any of this needs a new recording.

`move` starts from (0,0). If preparation positioned the cursor elsewhere, initialize it with `await d.move(x, y, 0)` at the start of `run`.

Capture records each Shortcut, a key pressed outside a text field or with Control, Alt or Meta held inside one, whether it came from `press` or from Playwright input directly, and the Final shows its keycaps for a moment, outside the camera, with platform symbols (`⌃ ⌥ ⇧ ⌘`). A key pressed alone, such as `Escape`, is recorded but shows only when the Edit's `keycaps.singleKeys` is on ([styling.md](styling.md)). Typing into a field shows nothing extra, since the page shows it, and the typed text never reaches the Timeline. A Shortcut is shown as pressed, so press `Meta` for a macOS demo; `ControlOrMeta` presses the one the recording platform uses. The Shortcuts are copied into `edit.json`, where one can be relabeled or removed without recording again.

Capture records the cursor shape the page asks for (a hand over links, an I-beam over text, whatever a canvas app sets), and Render draws the Cursor in that shape; the page's own cursor never appears in the Source.

The camera works like Screen Studio's auto zoom. It follows the clicks, typing and drags the page observed, whether they came from the director or from Playwright input directly, and in any frame: input inside an iframe, such as an embedded checkout or sign-in, is placed where the iframe shows on the page, through scrolling, fixed positioning and scaling. An iframe that is rotated, skewed or 3D-transformed is placed as if it were only scaled, and verification warns; record once it is upright, after any opening animation.

- It arrives `lead` seconds before each action, so the zoom is in place when the action happens.
- Actions whose zoom windows sit within `chainGap` seconds share one zoom segment: the camera stays zoomed and moves between them instead of zooming out and back in. A segment holds one zoom, the closest that fits every target in it.
- Within a segment the camera centers on the first target, then stays still while later targets are already in view (with `padding`) and otherwise moves only far enough to bring them in.
- It holds `hold` seconds after the segment's last action (after typing ends, for typing), then returns to the wide shot.
- While zoomed it follows the cursor only when it nears the edge, keeping it in the central 80% of the view, and stays where the cursor left it (`follow: false` turns this off).
- Movement eases in and out, settles in about `response` seconds and never overshoots.
- Every Final ends wide: the camera heads back `endWide` seconds before the end, so leave at least 2 seconds after the last action for the result to be seen in context.

Each target is framed with `padding` CSS px around its box, zooming at most `maxZoom`; boxes too large to reach `minZoom` stay wide. Set `zoom` on a target in `edit.json` to fix it; its segment then zooms no further. Pass `focus: false` to an action to keep the camera wide for it; a bare number still works as the action's timing. `d.focus(box)` adds a deliberate target and, like a manual zoom in Screen Studio, replaces only the automatic targets within its own span; the rest of the Take keeps following actions. Focus boxes always use CSS pixels, even when the source is captured at 2× scale.

Wrap only dead time in `fastForward`: a page load, a server, an AI response streaming in. A deliberate hold such as `d.at(5)` on a result stays outside, so the viewer can read it. The Final eases into and out of the faster speed inside the span; the page, the Cursor and click effects speed up with it, while the camera, keycaps and Subtitles keep their pace. To show viewers the speed-up, turn on the Edit's `fastForwardBadge` ([styling.md](styling.md)). A Line cannot play faster, so `say` inside `fastForward` fails the Take: say it before the wait. Keep the cursor still inside `fastForward`: a move there plays `rate` times faster, and a zoomed camera can lose it. If it would cover what the viewer waits for, move it aside before the wait. Each span is copied into `edit.json` as `fastForward: [{ "start": 3.2, "end": 9.8, "rate": 4 }]` (Source seconds), where it can be retimed or removed without recording again.

Use actual locators for clicks. Canvas drags often require coordinates; derive or validate them for the configured viewport. Keep setup outside capture, hold important states, and assert meaningful application changes. An exception marks the take failed and closes the isolated browser.

## Take folder

```text
<output>/<scenario>/<take>/
  project.json       Scenario config, status, application evidence, duration
  scenario.mjs       Snapshot of the original scenario module
  source.webm        Source: original high-resolution VP9 capture
  capture.json       Track settings, video frame callback observations and the page's animation frames per second
  timeline.json      Timeline: pointer path, cursor shapes, clicks and drags with their release, typing, Shortcuts, focus, said Lines and fast-forwards, in seconds and top-level CSS pixels, plus any input inside an iframe it could not place exactly (`frameInput`)
  edit.json          Edit: camera targets and settings, cursor, click effect, Shortcuts and keycaps, frame, fast-forwards, Line starts and volumes, Subtitles, output
  narration/         The Narration: narration.json (text, word timings) and each Line's audio, named by its id
  subtitles.srt/.vtt Subtitles of the placed Lines, from the last Render
  styles/            Shaders, drawing code and images the Edit names
  poster.png         Final page state at native capture resolution
  preview.png        Preview: the current Edit beside candidate Looks, from the last `preview`
  final.mp4          Final: H.264 camera composition
  render.json        Encoder, rate control and GPU used by the last Render; its times are seconds of the Final
  verification.json Output metadata, decode result, capture observations, and warnings when the browser fell behind or iframe input could not be placed exactly
```

A copied scenario snapshot may import helper modules from its original project. It is a record of the scenario, not a bundled runnable archive. Keep business scenarios in their application repository.

Times in `edit.json` and `timeline.json` are Source seconds, from the start of Capture; a fast-forward only changes when they happen in the Final. To edit a completed take, change `edit.json` (camera settings, target boxes and times, fast-forwards, the Shortcuts shown as `shortcuts: [{ "t": 2.4, "keys": ["Meta", "K"] }]`, and the styling in [styling.md](styling.md)), then run `cuetake render <take>`. To compare styling first, run `cuetake preview <take> --look <name|file.json>...`, which composes stills without touching `edit.json` or the Final. A Look is a partial Edit holding any styling and camera settings, but not camera targets, Shortcuts, fast-forwards, `frame.url`, `frame.urls` or `output.fps`. `cuetake look apply` merges one into `edit.json`, and `cuetake record --look` seeds a new take's Edit with it under the Scenario config. The Scenario config only seeds the first Edit. Changing what happens on the page requires recording again. `render` automatically runs verification; `verify` checks without rendering.

`edit.json` also carries `output.fps`, the Final's frame rate, which a new Take takes from `capture.fps`, and `frame.url`, the address bar's text, which defaults to the host the page was on when Capture started; a Scenario's `frame.url` replaces that host's name. When the page navigates to another host, `frame.urls` lists each change as `{ "t": 3.2, "url": "checkout.stripe.com" }`, in Source time from when the page took the new address; edit or remove one and render again. Encoders without a quantizer mode fall back to a bitrate, recorded in `render.json`.

Login is passed separately as a named runtime auth profile, never embedded in scenario config; see [authentication.md](authentication.md).
