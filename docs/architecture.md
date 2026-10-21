# Architecture

CueTake is an agent-facing local recording runtime. Settled decisions live in [docs/adr](adr/).

## Pipeline

Agent + skill → business scenario → CLI → Playwright context → Chromium tab capture → VP9 Source + Timeline → Render in headless Chromium (WebCodecs decode, WebGL compose, H.264 encode) → Final + verification.

The scenario controls story and timing. All pointer/camera coordinates are CSS pixels; the source uses device pixels. Device scale does not change the page layout. Render samples the latest Source frame at or before each output time, turning the variable-rate Source into a constant-rate Final and holding the last frame to the measured Take duration.

The Source holds only page pixels; `probe.js` hides the page cursor during Capture. Render draws the cursor from the Timeline's pointer path and a spark at each press, as WebGL sprites under the same camera, so a Take can be restyled without recording again (ADR 0002).

## Modules

- `pipeline.js`: scenario validation, artifact lifecycle, render and verification.
- `director.js`: timed interactions and focus targets.
- `recorder.js` / `tab-capture.js`: supported HD capture only.
- `cursor.js`: cursor position, sparks and their drawing; shared by Node and the render page.
- `camera.js`: camera chains and the crop at any time; shared by Node and the render page.
- `render.js` / `render-page.js`: the Render driver and the in-browser compositor, encoder and inspector.
- `probe.js`: in-page Timeline recording.
- `edit.js`: the Edit schema and its first version from a Scenario.
- `auth.js`: the `login` command and Auth profile storage.
- `cli.js`: the command interface, the only entry point.

Source capture is variable frame rate and does not guarantee 60 distinct frames per second. Login and full navigations may happen during preparation; after recording begins, the document must remain alive (SPA changes are supported). Capture runs in Chromium's new headless mode by default (`--headed` shows the window); both are verified on macOS, without audio. Login always uses a headed window.

No persistent background service, global browser profile modifications, desktop capture, or software GUI is required. Publishing and clean-machine installation remain release work; see [distribution.md](distribution.md).
