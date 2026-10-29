# Architecture

CueTake is an agent-facing local recording runtime. Settled decisions live in [docs/adr](adr/).

## Pipeline

Agent + skill → business scenario → CLI → Playwright context → Chromium tab capture → VP9 Source + Timeline → Render in headless Chromium (WebCodecs decode, WebGL compose, H.264 encode) → Final + verification.

The scenario controls story and timing. All pointer/camera coordinates are CSS pixels; the source uses device pixels. Device scale does not change the page layout. Render samples the latest Source frame at or before each output time, turning the variable-rate Source into a constant-rate Final and holding the last frame to the measured Take duration.

The Source holds only page pixels, since tab capture never shows the pointer; `probe.js` records the cursor shape the page asks for. Render draws the Cursor from the Timeline's pointer path, in that shape, pressed while a button is held and faded when still, and any click effect at each press, as WebGL sprites under the same camera, so a Take can be restyled without recording again (ADR 0002). The Background, window effects, chrome, cursor, click effect and Subtitles are agent-written shaders, drawing code or images, with built-in defaults in `src/styles/` (ADR 0005); the render page has no network.

A Narration is voiced before Capture by a separate speech tool (ADR 0006). The Director holds each said Line for its audio; Render decodes the Lines with Web Audio, mixes them into one mono track (AAC, or Opus where Chromium has no AAC encoder) and draws Subtitles outside the camera.

## Modules

- `pipeline.js`: scenario validation, artifact lifecycle, render and verification.
- `director.js`: timed interactions, focus targets and said Lines.
- `motion.js`: how the Director moves like a person (durations, path, pauses, typing rhythm); pure and seeded.
- `recorder.js` / `tab-capture.js`: supported HD capture only.
- `cursor.js`: the Cursor's position, press, fade and shape over time, and click-effect timing; shared by Node and the render page.
- `camera.js`: camera chains and the crop at any time; shared by Node and the render page.
- `stage.js`: output size, window and page layout, camera view and brand color; shared by Node and the render page.
- `narration.js`: Line problems, subtitle rows and cues, and subtitle files; shared by Node and the render page.
- `styles.js` / `styles/`: built-in styling files, and the file refs an Edit or Look names (copying, serving).
- `look.js`: saving, listing and adopting Looks.
- `environment.js`: `doctor`, `install-browser`, and removing the browser.
- `uninstall.js`: the `uninstall` command; it removes only what CueTake owns.
- `render.js` / `render-page.js`: the Render driver and the in-browser compositor, encoder and inspector.
- `probe.js`: in-page Timeline recording.
- `edit.js`: the Edit's defaults, merging, and its first version from a Scenario.
- `auth.js`: the `login` command and Auth profile storage.
- `cli.js`: the command interface, the only entry point.

Source capture is variable frame rate and does not guarantee 60 distinct frames per second. Login and full navigations may happen during preparation; after recording begins, the document must remain alive (SPA changes are supported). Capture runs in Chromium's new headless mode by default (`--headed` shows the window); both are verified on macOS, without page audio. Login always uses a headed window.

No persistent background service, global browser profile modifications, desktop capture, or software GUI is required. Publishing and clean-machine installation remain release work; see [distribution.md](distribution.md).
