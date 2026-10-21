# Architecture

CueTake is an agent-facing local recording runtime. Settled decisions live in [docs/adr](adr/).

## Pipeline

Agent + skill → business scenario → CLI → Playwright context → Chromium tab capture → VP9 Source + Timeline → Render in headless Chromium (WebCodecs decode, WebGL compose, H.264 encode) → Final + verification.

The scenario controls story and timing. All pointer/camera coordinates are CSS pixels; the source uses device pixels. Device scale does not change the page layout. Render samples the latest Source frame at or before each output time, turning the variable-rate Source into a constant-rate Final and holding the last frame to the measured Take duration.

`overlay.js` draws the arrow and click sparks inside the tab. The full-viewport canvas uses the device pixel ratio, draws only while sparks are active, and never intercepts input. Arrow color and spark core color match; dark outlines preserve contrast. Effects are baked into source video. No React dependency is needed.

## Modules

- `pipeline.js`: scenario validation, artifact lifecycle, render and verification.
- `director.js`: timed interactions and focus targets.
- `recorder.js` / `tab-capture.js`: supported HD capture only.
- `overlay.js`: pointer and ClickSpark rendering.
- `camera.js`: camera chains and the crop at any time; shared by Node and the render page.
- `render.js` / `render-page.js`: the Render driver and the in-browser compositor, encoder and inspector.
- `probe.js`: in-page Timeline recording.
- `edit.js`: the Edit schema and its first version from a Scenario.
- `auth.js`: the `login` command and Auth profile storage.
- `cli.js`: the command interface, the only entry point.

Source capture is variable frame rate and does not guarantee 60 distinct frames per second. Login and full navigations may happen during preparation; after recording begins, the document must remain alive (SPA changes are supported). Current acceptance platform is macOS headed Chromium, without audio.

No persistent background service, global browser profile modifications, desktop capture, or software GUI is required. Publishing and clean-machine installation remain release work; see [distribution.md](distribution.md).
