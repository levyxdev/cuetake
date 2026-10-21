# Architecture

CueTake is an agent-facing local recording runtime. It descends from Pagecast commit `6bbf3c94539c947a65ecaacb1965ffe32345c5a4`; attribution is retained in NOTICE and LICENSE. Active runtime names and interfaces are CueTake's. The original legacy recorder, tooltip/GIF branches, optional Remotion renderer, and old MCP interface have been removed.

## Pipeline

Agent + skill → business scenario → local MCP job / CLI → Playwright context → Chromium tab capture → VP9 source → FFmpeg camera composition → H.264 final + verification.

The scenario controls story and timing. All pointer/camera coordinates are CSS pixels; the source uses device pixels. Device scale does not change the page layout. Camera frames use zoompan because the inherited time-dependent crop widths were only evaluated at initialization. The final static frame is held to the measured take duration before camera evaluation.

`overlay.js` draws the arrow and click sparks inside the tab. The full-viewport canvas uses the device pixel ratio, draws only while sparks are active, and never intercepts input. Arrow color and spark core color match; dark outlines preserve contrast. Effects are baked into source video. No React dependency is needed.

## Modules

- `pipeline.js`: scenario validation, artifact lifecycle, render and verification.
- `director.js`: timed interactions and focus targets.
- `recorder.js` / `tab-capture.js`: supported HD capture only.
- `overlay.js`: pointer and ClickSpark rendering.
- `zoom.js` / `converter.js`: camera chain and FFmpeg encoding.
- `auth.js`: isolated login preparation and local state storage.
- `index.js`: task-oriented stdio MCP and child-process jobs.
- `cli.js`: shared engine command interface.

Source capture is variable frame rate and does not guarantee 60 distinct frames per second. Login and full navigations may happen during preparation; after recording begins, the document must remain alive (SPA changes are supported). Current acceptance platform is macOS headed Chromium, without audio.

No persistent background service, global browser profile modifications, desktop capture, or software GUI is required. The MCP client manages its local child process. Runtime publishing and clean-machine installation remain release work; see distribution.md.
