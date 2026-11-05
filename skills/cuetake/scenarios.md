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

Only `name` and `url` are required in config; a Scenario of a desktop App names `app` instead of `url` (see Apps below). Other fields use the shown defaults. `director.speed` scales how fast the Director moves, pauses and types (`1.25` is a quarter faster); `director.seed` picks another, equally human way to move. Capture FPS accepts 30 or 60. Resolution scale accepts 1 or 2; left unset, it is 2, or 1 when `doctor` finds Chromium drawing without a GPU, which `record` reports under `capture`. Widths and heights must be even. Page audio is not captured; a voiced Narration is added with `record --narration` ([narration.md](narration.md)).

## Director

| API | Behavior |
| --- | --- |
| `page` | The Tab in front, an isolated Playwright page; use its locators and assertions. A locator inside an iframe, such as `d.page.frameLocator('iframe[name=checkout]').getByLabel('Card number')`, works with every action, cross-origin and nested frames included. |
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
| `mask(locator, { effect='blur', ... })` | Mask every element the locator matches, in any Tab, from now until the returned `end()` is called or the Take ends. `effect` is `'blur'`, `'cover'` or `'spotlight'`. See Masks below. |
| `switchTo(page)` | Bring a Tab back in front, such as the first page after a new tab opened over it. See Tabs below. |
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

## Masks

Takes often start from an Auth profile signed in to a real account, so real emails, names, amounts or keys can end up on camera. Mask them in the Scenario, before the Director first waits or acts:

```js
export async function run(d) {
  await d.mask(d.page.getByTestId('account-email'));                        // blur, the whole Take
  await d.mask(d.page.locator('.api-key'), { effect: 'cover', color: '#18181b' });
  await d.at(1);
  // ...
  const result = await d.mask(d.page.getByRole('row', { name: 'Paid' }), { effect: 'spotlight' });
  await d.at(6);
  result.end();                                                            // the spotlight ends here
}
```

- `blur` blurs the region past reading (`blur`, 16 CSS px by default, at least 8); `cover` fills it with `color` (black by default); `spotlight` dims the rest of the frame by `dim` (0.6), the light falling off over `feather` (16 CSS px) across the region's edge, easing in and out over `ease` Final seconds (0.3). Each takes `padding` around the element (4 CSS px, 8 for a spotlight) and a corner `radius`.
- Capture records each element's box as it moves, so the Mask stays on it as the page scrolls, the layout changes or the element is replaced, and inside iframes. A locator matching several elements masks all of them; one that matches nothing masks nothing until it does.
- A blur or cover made before the Director first waits or acts covers the Take from its first frame. A Mask made later starts when it is made, so mask before the private data shows.
- While its element moves, a blur or cover also covers where it was for 0.2 s before and 0.25 s after, since the Source shows a change a little after the page makes it and Capture finds a replaced element within a tenth of a second, so it never trails the page.
- Masks sit on the page under the camera, so they stay on their element as the camera zooms and pans. A spotlight dims every window, popups included, their chrome and the Background, but not the Cursor, click effects, keycaps or Subtitles. Spotlights showing together light each of their regions and dim the rest once.

Each Mask is copied into `edit.json` as `masks: [{ "effect": "blur", "element": 0, "start": 0 }]` (Source seconds; without `end` it lasts to the end of the Take), where its span or parameters can be changed or it can be removed without recording again. `element` is one of `timeline.json`'s `elements`, which names its locator. To mask what the Scenario did not, add a fixed box in the Tab's CSS pixels and render again:

```json
"masks": [{ "effect": "cover", "box": { "x": 1100, "y": 16, "width": 220, "height": 36 }, "start": 2.5, "end": 9, "tab": 0 }]
```

Check with `preview --at` that nothing private shows before rendering: Previews draw Masks as the Final does. Render refuses a Mask it cannot draw, naming it, and verification warns when a Mask's element never showed during its span. `render.json` lists each Mask with the first and last frame it was drawn on.

## Tabs

Capture follows every page the demo opens, from a link with `target="_blank"`, `window.open`, or an iframe, such as an OAuth or payment popup, and records each as a Tab with its own Source. Pages a Scenario opens with `context.newPage()` are not followed. Get the new page with Playwright's idiom, before the click that opens it:

```js
const opened = d.page.waitForEvent('popup');
await d.click(d.page.getByRole('link', { name: 'Open docs' }));
const docs = await opened;   // now in front: d.page is docs
await d.click(docs.getByRole('button', { name: 'Copy' }));
```

Which Tab is in front follows the browser: a new Tab comes in front when it opens, and when it closes, the Tab that opened it comes back. Bring back any other open Tab with `d.switchTo(page)`; keep a reference to the first page (`const app = d.page` at the start of `run`) to return to it. Every action works on the Tab in front, and an action on a locator of a Tab behind fails and names `d.switchTo`, since a person can't click a tab they can't see. A click that makes a popup close itself is fine.

In the Final, a Tab the size of the viewport replaces the page in the same window, with a cut by default, and the camera cuts to wide. Any other Tab is a popup window over the Tab that opened it, which keeps playing behind it; the camera frames it as it opens. The Cursor stays one pointer across Tabs, where it was on the window. Each Tab's input is in its own CSS pixels in `timeline.json`, and each event names its `tab`.

Use actual locators for clicks. Canvas drags often require coordinates; derive or validate them for the configured viewport. Keep setup outside capture, hold important states, and assert meaningful application changes. An exception marks the take failed and closes the isolated browser.

## Apps

On macOS a Scenario can record a desktop App instead of a page. CueTake starts the App, sizes its first window to fill the Desktop, a `viewport`-sized region at the centre of the sharpest display, and records only the App's own windows there: menus, pop-up lists, sheets and second windows included, with nothing else on the screen and without the pointer. The Final draws each window over the Background with its own corners and shadow.

```js
export const config = {
  name: 'notes-demo',
  // A bundle id or a .app path; args are the App's command line. These two, which any Cocoa App takes for
  // one launch only, open an untitled document rather than the Open panel and restore no earlier windows.
  app: { path: 'com.apple.TextEdit', args: ['-NSShowAppCentricOpenPanelInsteadOfUntitledFile', 'NO', '-ApplePersistenceIgnoreState', 'YES'] },
  viewport: { width: 1200, height: 760 },   // the Desktop, in points
};

export async function run(d) {
  await d.say('intro', 'A fresh note in TextEdit.');
  d.focus({ x: 0, y: 0, width: 600, height: 200 });   // Desktop points, from its top-left corner
  await d.at(8);
}
```

- **Before recording, tell the user** that the Mac cannot be used until the Take ends, and that the Scenario acts on their real App, with their own login and data. CueTake also prints this when Capture starts.
- **The App must not be running.** `record` refuses and names it; ask the user to quit it, and never quit it for them. CueTake quits the App it started when the Take ends; if the App asks to save first, `record` reports it. To record the agent's own host app, run the agent from a terminal.
- **Permissions.** Recording needs the Screen Recording and Accessibility grants of the app CueTake runs in (the terminal, or the agent's host). `doctor` reports both under `apps` without asking for them; follow its fix, with the user's agreement.
- **Refused for an App:** `--auth-profile` (the App starts with the login it already has), `--headed`, `capture.resolutionScale` (the Desktop records at its display's scale, 2 on a Retina display, which `record` reports under `capture`) and `prepare`. Start the App in the state the demo needs through `args`. A sandboxed App, such as TextEdit, refuses a document passed there with a dialog; `record` then refuses too, since only a standard window fills the Desktop. A Cocoa App also reopens the windows and panels of its last session unless `args` holds `-ApplePersistenceIgnoreState YES`.
- **What the Director does so far:** `at`, `wait`, `time`, `say`, `fastForward` and `focus`, in Desktop points. Clicking, typing and the other actions throw for now.
- A Take of an App has no browser chrome by default (`frame.chrome: false`); a `frame.chrome` the Scenario names still applies. A window that leaves the Desktop is cut off where it does, and the first window moving or resizing is not corrected; `verify` warns about both, and about a Desktop recorded at scale 1. Menus opened from the menu bar sit outside the Desktop and are not recorded.

## Take folder

```text
<output>/<scenario>/<take>/
  project.json       Scenario config, status, application evidence, duration
  scenario.mjs       Snapshot of the original scenario module
  source-<tab>.webm  Source of each Tab (0 is the first page): original high-resolution VP9 capture; a Take of an App has source-0.mp4, its Desktop in H.264
  capture.json       Per Tab: track settings, video frame callback observations and the page's animation frames per second, in seconds from its own start
  timeline.json      Timeline: for a Take of an App, the App's windows on the Desktop over time (`windows`); the Tabs (`tabs`: opener, when each opened, closed and started recording, viewport) and which is in front (`front` events), pointer path, cursor shapes, clicks and drags with their release, typing, Shortcuts, focus, said Lines, fast-forwards, masks and page loads, in seconds and each Tab's top-level CSS pixels, the boxes of each masked element over time (`elements`), plus any input inside an iframe it could not place exactly (`frameInput`)
  edit.json          Edit: camera targets and settings, cursor, click effect, Shortcuts and keycaps, frame, how Tabs switch and where popups sit, fast-forwards, Masks, Line starts and volumes, Subtitles, output
  narration/         The Narration: narration.json (text, word timings) and each Line's audio, named by its id
  subtitles.srt/.vtt Subtitles of the placed Lines, from the last Render
  styles/            Shaders, drawing code and images the Edit names
  poster.png         The Tab in front at the end, at native capture resolution
  preview.png        Preview: the current Edit beside candidate Looks, from the last `preview`
  final.mp4          Final: H.264 camera composition
  render.json        Encoder, rate control and GPU used by the last Render, and the frames each Mask was drawn on; its times are seconds of the Final
  verification.json Output metadata, decode result, capture observations per Tab, and warnings when the browser fell behind, iframe input could not be placed exactly or a Mask found no element
```

A copied scenario snapshot may import helper modules from its original project. It is a record of the scenario, not a bundled runnable archive. Keep business scenarios in their application repository.

Times in `edit.json` and `timeline.json` are Source seconds, from the start of Capture; a fast-forward only changes when they happen in the Final. To edit a completed take, change `edit.json` (camera settings, target boxes and times, fast-forwards, Masks, the Shortcuts shown as `shortcuts: [{ "t": 2.4, "keys": ["Meta", "K"] }]`, and the styling in [styling.md](styling.md)), then run `cuetake render <take>`. To compare styling first, run `cuetake preview <take> --look <name|file.json>...`, which composes stills without touching `edit.json` or the Final. A Look is a partial Edit holding any styling and camera settings, but not camera targets, Shortcuts, fast-forwards, Masks, `frame.url`, `frame.urls`, `tabs.placement` or `output.fps`. `cuetake look apply` merges one into `edit.json`, and `cuetake record --look` seeds a new take's Edit with it under the Scenario config. The Scenario config only seeds the first Edit. Changing what happens on the page requires recording again. `render` automatically runs verification; `verify` checks without rendering.

`edit.json` also carries `output.fps`, the Final's frame rate, which a new Take takes from `capture.fps`, and `frame.url`, the address bar's text, which defaults to the host the page was on when Capture started; a Scenario's `frame.url` replaces that host's name. When a page navigates to another host, `frame.urls` lists each change as `{ "t": 3.2, "url": "checkout.stripe.com", "tab": 0 }`, in Source time from when the Tab took the new address; a Tab the demo opens starts with the address it opened on, or empty until its first page commits. Edit or remove one and render again. `tabs.placement: [{ "tab": 2, "x": 100, "y": 60 }]` moves a popup window, its page's top left in its opener's CSS pixels; by default it is centered over its opener and scaled down to fit. Encoders without a quantizer mode fall back to a bitrate, recorded in `render.json`.

Login is passed separately as a named runtime auth profile, never embedded in scenario config; see [authentication.md](authentication.md).
