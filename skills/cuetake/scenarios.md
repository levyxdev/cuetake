# Scenario API

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
  await d.at(1.5);
  await d.click(d.page.getByRole('button', { name: 'Preview' }));
  await d.wait(3000); // hold the result; see directing.md
  return { previewOpened: true }; // Prefer evidence checked against the real UI.
}
```

Only `name` and `url` are required in config; a Scenario of a desktop App names `app` instead of `url` (see Apps below). Other fields use the shown defaults. `director.speed` scales how fast the Director moves, pauses and types (`1.25` is a quarter faster); `director.seed` picks another, equally human way to move. Capture FPS accepts 30 or 60. Resolution scale accepts 1 or 2; left unset, it is 2, or 1 when `doctor` finds Chromium drawing without a GPU, which `record` reports under `capture`. Widths and heights must be even. Page audio is not captured; a voiced Narration is added with `record --narration` ([narration.md](narration.md)).

`run` may navigate, submit forms and reload: one Take records through each, and the Timeline notes every page load as a `navigate` event. Login still happens in `prepare`, before capture. Capture runs headless; pass `--headed` to `record` to watch it. Headless Chromium renders the generic `monospace` family as Courier rather than Menlo, so record with `--headed` when a page relies on it. Capture is variable frame rate: static scenes reduce cadence and moving scenes can drop frames, so report the observed stats in `capture.json`, not a promise of 60 independent page frames each second.

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
| `scroll(locator, { block='start', inline='nearest', duration })` | Scroll until the target shows where `block` (vertically) and `inline` (sideways) put it in what scrolls it, named as `scrollIntoView` names them: `'start'`, `'center'`, `'end'` or `'nearest'`; `start` and `end` leave a tenth of the view at the edge. It turns the wheel a little each frame, the page first, then each container inside it, diagonally where one scrolls both ways, and moves the cursor onto a container first when a wheel where it rests would scroll something else. Returns the target's box on the page. See Scrolling below. |
| `focus({x,y,width,height}, seconds?)` | Add a camera target in CSS pixels (Desktop points for an App); defaults to the current time. See [directing.md](directing.md), Camera. |
| `say(id, text?)` | Start a Narration Line. With `--narration` it waits until the Line's audio ends; without, `text` is required and it does not wait. See [narration.md](narration.md). |
| `fastForward(wait, { rate=4 })` | Run `wait`, a function that waits on the page, such as `() => reply.waitFor()`, and return its result; the Final plays that span `rate` times faster. |
| `mask(locator, { effect='blur', ... })` | Mask every element the locator matches, in any Tab, from now until the returned `end()` is called or the Take ends. `effect` is `'blur'`, `'cover'` or `'spotlight'`. See Masks below. |
| `switchTo(page)` | Bring a Tab back in front, such as the first page after a new tab opened over it. See Tabs below. In a Take of several Apps, bring a window in front; see Apps below. |
| `time()` | Seconds elapsed since capture started. |

The Director moves like a person. A move takes longer the farther and smaller its target is (Fitts's law), starts quickly and settles slowly, and at the default speed stays under about 2000 CSS px/s; it pauses briefly before pressing and after releasing, and holds a click's button for a moment, so the Cursor's press shows. A `duration` fixes one move's length in ms and `msPerChar` one field's typing pace; the arc, pauses and uneven typing stay. The same Scenario and `seed` move the same way on every recording. Changing any of this needs a new recording.

A scroll takes longer the farther it goes, quickly at first and settling long, about 0.8 s for 600 CSS px and 2 s for 6000, never faster than 3000 CSS px/s on average; `duration` fixes the first container's in ms.

`move` starts from (0,0). If preparation positioned the cursor elsewhere, initialize it with `await d.move(x, y, 0)` at the start of `run`.

Capture records each Shortcut, a key pressed outside a text field or with Control, Alt or Meta held inside one, whether it came from `press` or from Playwright input directly, and the Final shows its keycaps for a moment, outside the camera, with platform symbols (`⌃ ⌥ ⇧ ⌘`). A key pressed alone, such as `Escape`, is recorded but shows only when the Edit's `keycaps.singleKeys` is on ([styling.md](styling.md)). Typing into a field shows nothing extra, since the page shows it, and the typed text never reaches the Timeline. A Shortcut is shown as pressed, so press `Meta` for a macOS demo; `ControlOrMeta` presses the one the recording platform uses. The Shortcuts are copied into `edit.json`, where one can be relabeled or removed without recording again.

Capture records the cursor shape the page asks for (a hand over links, an I-beam over text, whatever a canvas app sets), and Render draws the Cursor in that shape; the page's own cursor never appears in the Source.

The camera follows the clicks, typing and drags the page observed, in any frame; how it moves, and when to steer it with `focus`, is in [directing.md](directing.md), Camera.

`fastForward` eases into and out of the faster speed inside the span; the page, the Cursor and click effects speed up with it, while the camera, keycaps and Subtitles keep their pace. To show viewers the speed-up, turn on the Edit's `fastForwardBadge` ([styling.md](styling.md)). A Line cannot play faster, so `say` inside `fastForward` fails the Take: say it before the wait. Each span is copied into `edit.json` as `fastForward: [{ "start": 3.2, "end": 9.8, "rate": 4 }]` (Source seconds), where it can be retimed or removed without recording again. What to fast-forward is in [directing.md](directing.md).

## Scrolling

Scroll to the element the viewer should see, never by a distance: the page's layout decides how far that is.

```js
const install = d.page.getByRole('heading', { name: 'Installation' });
d.focus(await d.scroll(install));               // the section, framed once the page has stopped
await d.scroll(d.page.getByRole('cell', { name: 'Total' }), { block: 'center', inline: 'nearest' });
```

- A target already where it was asked to be scrolls nothing. A container that cannot go farther stops at its end, and the call returns normally.
- A page that moves its layout while it scrolls, such as images loading above the target, gets one short second scroll to correct it, only when it is off by more than 4 CSS px.
- A scroll fails the Take when the wheel moves nothing (the page takes the wheel itself, or something lies over the container), when no part of a container the wheel would reach shows, and when the target still is not in view at the end.
- A target inside an iframe scrolls only within the iframe's own document; scroll to the iframe first with `d.scroll(d.page.locator('iframe'))`.
- Each scroll is recorded in the Timeline as a `scroll` event and copied into `edit.json` as `camera.scrolls: [{ "start": 8.1, "end": 9.9 }]` (Source seconds): the camera is back wide `response` before a scroll starts and stays wide until it ends ([directing.md](directing.md), Camera). Remove a span there to keep a zoom through that scroll. Wheel input sent through Playwright directly is not recorded, and the camera ignores it.

## Masks

Takes often start from an Auth profile signed in to a real account, so real emails, names, amounts or keys can end up on camera. Mask them in the Scenario, before the Director first waits or acts:

```js
export async function run(d) {
  await d.mask(d.page.getByTestId('account-email'));                        // blur, the whole Take
  await d.mask(d.page.locator('.api-key'), { effect: 'cover', color: '#18181b' });
  await d.at(1);
  // ...
  const result = await d.mask(d.page.getByRole('row', { name: 'Paid' }), { effect: 'spotlight' });
  await d.wait(3000);
  result.end();                                                            // the spotlight ends here
}
```

- `blur` blurs the region past reading (`blur`, 16 CSS px by default, at least 8); `cover` fills it with `color` (black by default); `spotlight` dims the rest of the frame by `dim` (0.6), the light falling off over `feather` (16 CSS px) across the region's edge, easing in and out over `ease` Final seconds (0.3). Each takes `padding` around the element (4 CSS px, 8 for a spotlight) and a corner `radius`.
- Capture records each element's box as it moves, so the Mask stays on it as the page scrolls, the layout changes or the element is replaced, and inside iframes. A locator matching several elements masks all of them; one that matches nothing masks nothing until it does.
- A blur or cover made before the Director first waits or acts covers the Take from its first frame. A Mask made later starts when it is made, so mask before the private data shows.
- While its element moves, a blur or cover also covers where it was for 0.2 s before and 0.25 s after, since the Source shows a change a little after the page makes it and Capture finds a replaced element within a tenth of a second, so it never trails the page.
- Masks sit on the page under the camera, so they stay on their element as the camera zooms and pans. A spotlight dims every window, popups included, their chrome and the Background, but not click effects, keycaps or Subtitles. The Cursor fades out as a spotlight fades in and back as it ends. Spotlights showing together light each of their regions and dim the rest once.

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

Use actual locators for clicks. Canvas drags often require coordinates; derive or validate them for the configured viewport. Keep setup outside capture and assert meaningful application changes. An exception marks the take failed and closes the isolated browser.

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

// Optional: the App's first window, before Capture starts. Only locators work here.
export async function prepare(page) {
  await page.getByRole('textbox').waitFor();
}

export async function run(d) {
  const body = d.page.getByRole('textbox'), bold = d.page.getByRole('checkbox', { name: 'bold' });
  await d.say('intro', 'A fresh note in TextEdit.');
  await d.type(body, 'Hello from CueTake.');
  await d.press('Meta+A');
  await d.click(bold);
  await d.wait(1500);
  const evidence = { text: await body.value(), bold: await bold.value() };
  // An edited untitled document asks to be kept when TextEdit quits, so close it without keeping it.
  await d.press('Meta+W');
  await d.click(d.page.getByRole('button', { name: 'Delete' }));
  return evidence;
}
```

- **Before recording, tell the user** that the Mac cannot be used until the Take ends, and that the Scenario acts on their real App, with their own login and data. The Director moves the real pointer and posts real keys, so the user's own input would mix with it. CueTake also prints this when Capture starts.
- **An App that is already running** stops `record` before Capture, naming it. Ask the user whether to record it as it is: its windows and data then show in the Take, which does not start afresh. On yes, record again with `--use-running`: CueTake records that instance, moves its first window to fill the Desktop, puts its windows back when the Take ends and leaves it running. Otherwise ask the user to quit it; never quit it for them. This is also how you record your own host app, such as Claude: type into it, but never send. CueTake quits an App it started when the Take ends; if the App asks to save first, `record` reports it.
- **Permissions.** Recording needs the Screen Recording, Accessibility and Input Monitoring grants of the app CueTake runs in (the terminal, or the agent's host); Input Monitoring lets CueTake notice input the Scenario did not make. `doctor` reports them under `apps` without asking for them; follow its fix, with the user's agreement.
- **Locators.** `d.page` is the window in front, whichever App owns it; `d.app(name)` is one App, offering the locators of its own front window, and `d.app(name).window(title)` another of its windows, by a part of its title; `prepare(page)` gets the first window. An App is named by its name, in any case, or by the bundle id or path the Scenario gave; with one App, `d.app()` names it. They offer only Accessibility locators, chainable to narrow inside one: `getByRole(role, { name, exact })` and `getByTestId(id)`, which matches the element's `AXIdentifier`. `role` is an ARIA role (`button`, `textbox`, `link`, `checkbox`, `radio`, `combobox`, `menuitem`, `tab`, `group`, `text`, ...), each mapped to the AX roles AppKit, SwiftUI and Chromium use (`textbox` is `AXTextField` or `AXTextArea`), or a raw AX role such as `AXPopUpButton`. `name` matches the element's AX title, description or label (a static text's text is its title): a part of it in any case, the whole of it with `exact: true`, or a RegExp. A locator also offers `value()` (the AX value: a field's text, a checkbox's 0 or 1), `text()` (its text, or the text inside it), `isVisible()` and `waitFor({ state: 'visible' | 'hidden', timeout })`, for evidence and for `d.fastForward(() => reply.waitFor())`. Reads and actions wait up to 10 s for the element; several matches fail at once, naming them, as Playwright's strict mode does. Playwright's other methods and `expect` do not apply, and throw.
- **Finding locators.** Run `scripts/cuetake tree <app>` on the running App (bundle id, name or `.app` path) to list its Accessibility tree: each element's role, name, value and frame, with the locator that finds it. It only reads, so it may look at the user's own instance; or start a Take that holds the App open with `d.at(30)` and list it meanwhile. Use your computer use to explore the App while writing the Scenario, never to perform it. An App built on Chromium (an Electron app such as Claude) or Flutter (such as LocalSend) builds its tree only once asked; CueTake asks for it when the App starts, and `tree` waits for it. Where an App exposes no element, act on a point in Desktop points instead: `d.click({ x: 600, y: 400 })`.
- **Actions** work as for a page, in Desktop points: `click`, `hover`, `type` and `move` glide the real pointer at the capture rate and press where they land; `press` posts keys such as `'Meta+S'` (`ControlOrMeta` is Meta); `drag` takes points. Before each press the Director checks that an App of the Take owns what lies under the pointer: a click covered by another app's window fails the Take, naming that app, and keys are refused while an app outside the Take is in front. The Final draws the Cursor, click effects and keycaps from what the Director did, and the camera follows it. The Cursor takes the shape macOS showed (an I-beam over text, an arrow elsewhere, a hand over a link), and the camera also follows the element the App focuses, such as a field a sheet opens with. Input the Scenario did not make, such as a hand on the trackpad, never moves the Cursor, but `verify` warns about it and when it happened, since the App may have reacted; meanwhile the Cursor takes the shape the App's element under it suggests (an I-beam over text, an arrow elsewhere).
- **Masks** work as for a page: `d.mask(locator, { effect })` takes an App locator, masks every element it matches, and follows each as it moves, since the helper reads their frames at the capture rate and the locator is resolved again ten times a second. Fixed boxes in `edit.json` are in Desktop points.
- **Refused for an App:** `d.scroll`, `--auth-profile` (the App starts with the login it already has), `--headed`, and `capture.resolutionScale` (the Desktop records at its display's scale, 2 on a Retina display, which `record` reports under `capture`). Start the App in the state the demo needs through `args`. A sandboxed App, such as TextEdit, refuses a document passed there with a dialog; `record` then refuses too, since only a standard window fills the Desktop. A Cocoa App also reopens the windows and panels of its last session unless `args` holds `-ApplePersistenceIgnoreState YES`.
- **Several Apps** share one Desktop when `app` is a list, `[{ path, args }, ...]`: a demo that copies in one App and pastes into another, or drags a file across. `record` stops if any of them is running, as above, then starts them in order. The first App's first window fills the Desktop and the first App is in front; the others' windows open where those Apps put them, usually behind it. Arrange them in `prepare(page, { app })`, whose `app(name)` is `d.app(name)` with `setFrame({ x, y, width, height })` on each window, in Desktop points; only `prepare` moves windows, since a window jumping during a Take would look like no person's doing. The Desktop shows the windows of every App of the Take in their real order, and no other app's, even one lying over the Desktop. `d.switchTo(window)` switches like a person: the Director glides to an empty part of that window's title bar showing on the Desktop, clicks it, so the switch shows in the Final, and waits for the window to come in front; the camera frames the window. It fails when no empty part of the title bar shows, so leave one uncovered, and waits for nothing when the window is already in front. `d.press('Meta+Tab')` also switches, without waiting for the other App to come in front, so hold a moment after it; the system's app switcher is not an App of the Take, so it does not show. A click lands on whichever App's window lies at that point, so an element of one App under another App's window is clicked through that window: bring its window in front with `d.switchTo` first. Copying in a Take replaces the user's clipboard, so tell the user before recording.

  ```js
  const ARGS = ['-NSShowAppCentricOpenPanelInsteadOfUntitledFile', 'NO', '-ApplePersistenceIgnoreState', 'YES'];
  export const config = {
    name: 'copy-across',
    app: [{ path: 'com.apple.TextEdit', args: ARGS }, { path: 'com.apple.ScriptEditor2', args: ARGS }],
    viewport: { width: 1200, height: 760 },
  };
  export async function prepare(page, { app }) {
    await page.setFrame({ x: 0, y: 0, width: 760, height: 760 });
    await app('Script Editor').setFrame({ x: 480, y: 90, width: 700, height: 560 });   // its title bar shows right of TextEdit
  }
  export async function run(d) {
    await d.type(d.app('TextEdit').getByRole('textbox'), 'display dialog (current date) as text');
    await d.press('Meta+A');
    await d.press('Meta+C');
    await d.switchTo(d.app('Script Editor'));
    await d.click(d.app('Script Editor').getByRole('textbox', { name: 'script source' }));
    await d.press('Meta+V');
    // ...
  }
  ```
- A Take of an App has no browser chrome by default (`frame.chrome: false`); a `frame.chrome` the Scenario names still applies. A window that leaves the Desktop is cut off where it does, and the first window moving or resizing is not corrected; `verify` warns about both, naming the App when the Take has several, about a first window that does not fill the Desktop in a Take of one App, and about a Desktop recorded at scale 1. Menus opened from the menu bar sit outside the Desktop and are not recorded.

Login is passed separately as a named runtime auth profile, never embedded in scenario config; see [authentication.md](authentication.md).
