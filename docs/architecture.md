# Architecture

CueTake is an agent-facing local recording runtime. Settled decisions live in [docs/adr](adr/).

## Pipeline

Agent + skill → business scenario → CLI → Playwright context → Chromium tab capture → VP9 source → FFmpeg camera composition → H.264 final + verification.

The scenario controls story and timing. All pointer/camera coordinates are CSS pixels; the source uses device pixels. Device scale does not change the page layout. Camera frames use zoompan because the inherited time-dependent crop widths were only evaluated at initialization. The final static frame is held to the measured take duration before camera evaluation.

`overlay.js` draws the arrow and click sparks inside the tab. The full-viewport canvas uses the device pixel ratio, draws only while sparks are active, and never intercepts input. Arrow color and spark core color match; dark outlines preserve contrast. Effects are baked into source video. No React dependency is needed.

## Modules

- `pipeline.js`: scenario validation, artifact lifecycle, render and verification.
- `director.js`: timed interactions and focus targets.
- `recorder.js` / `tab-capture.js`: supported HD capture only.
- `overlay.js`: pointer and ClickSpark rendering.
- `zoom.js` / `converter.js`: camera chain and FFmpeg encoding.
- `auth.js`: the `login` command and Auth profile storage.
- `cli.js`: the command interface, the only entry point.

Source capture is variable frame rate and does not guarantee 60 distinct frames per second. Login and full navigations may happen during preparation; after recording begins, the document must remain alive (SPA changes are supported). Current acceptance platform is macOS headed Chromium, without audio.

No persistent background service, global browser profile modifications, desktop capture, or software GUI is required. Publishing and clean-machine installation remain release work; see [distribution.md](distribution.md).
