# CueTake

**Script the flow. Keep the take.**

Built entirely for AI agents, CueTake turns browser interactions into sharp product demo videos with a precise cursor and continuous camera moves. Give an agent a scenario, then capture, render, and verify the result locally.

- Retina tab capture with configurable 30 / 60 fps and a 2× pixel scale.
- A viewport-aligned arrow and matching outlined ClickSpark with configurable size and timing.
- Camera chains that zoom in, move between points of interest, and zoom out once.
- A reusable CLI and JavaScript scenario API.
- A separate folder for every take: source, camera edit, finished MP4, and verification.

CueTake is not yet published to a package registry.

## Run from source

Requirements: Bun, FFmpeg with H.264 encoding, and Playwright Chromium. The verified capture environment is macOS with headed Chromium.

```sh
bun install --frozen-lockfile
bun run doctor
# Only if doctor reports Chromium missing:
PLAYWRIGHT_SKIP_BROWSER_GC=1 bunx playwright install chromium

bun src/cli.js record examples/basic.mjs --out ./recordings/first-take
```

The example uses `https://example.com`. It adds a small animated demo element in that isolated browser context, so it works without a local application server. For your own product, write a scenario using the [scenario API](skills/cuetake/scenarios.md).

Playwright is a local package dependency. Browser binaries use Playwright's normal OS cache. CueTake does not install global packages or start your application server.

## Commands

```sh
bun src/cli.js doctor
bun src/cli.js record ./my-scenario.mjs --out ./recordings/my-take
bun src/cli.js render ./recordings/my-take
bun src/cli.js verify ./recordings/my-take
bun src/cli.js login product-demo https://your-app.example/login
```

`record` completes capture → render → verification and refuses an existing output folder. `render` uses the saved source and camera edit; it replaces the final video only after encoding succeeds. Clone a take folder to keep multiple edits.

A successful command is a technical check, not an editorial approval. Watch the result before publishing.

## How it works

Playwright drives an isolated Chromium tab. Chromium captures the tab at device-pixel resolution using `getDisplayMedia`; a VP9 `MediaRecorder` saves the source. The cursor is drawn inside the page at the actual input coordinates. FFmpeg then renders the camera path into an H.264 MP4.

Source capture is variable frame rate. Static scenes may drop to approximately one captured frame per second, and busy scenes can drop frames. A 60 fps output does not imply 60 unique source frames every second. Capture callback statistics and output metadata are retained in each take. No motion interpolation is used.

## Current scope

The supported workflow is a short, same-document browser demo, including SPA interactions. A full page navigation or reload destroys the in-page recorder; record those as separate takes. Audio and desktop/window capture are outside this workflow. Browser automation and captured data stay local; the visited website still receives normal browser requests.

The bundled [agent skill](skills/cuetake/SKILL.md) teaches planning and operation; site-specific scenarios stay in your application project. See [distribution](docs/distribution.md) and [login](skills/cuetake/authentication.md).

## Development

```sh
bun test tests/pipeline.test.js
# With Playwright Chromium installed:
bun test tests/browser.test.js
```

Tests verify configuration validation and actual FFmpeg camera geometry at a 2× capture scale. No build step is required. Do not commit recordings, browser profiles, credentials, or product-specific scenarios into this generic tool repository.
