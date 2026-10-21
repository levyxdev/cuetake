# CueTake

**Script the flow. Keep the take.**

Built entirely for AI agents, CueTake turns browser interactions into sharp product demo videos with a precise cursor and continuous camera moves. Give an agent a scenario, then capture, render, and verify the result locally.

- Retina tab capture at 30 or 60 fps and a 2× pixel scale, headless by default.
- An automatic camera that frames each click, field and drag, then zooms out once.
- Cursor and click sparks drawn at Render time, so a Take can be restyled without recording again.
- Rendering in Chromium with WebGL and WebCodecs: no FFmpeg, 4K60 by hardware encoder.
- A separate folder for every Take: Source, Timeline, Edit, Final MP4, and verification.

## For AI agents

If a user hands you this repository to set up CueTake:

1. Install the skill with `npx skills add levyxdev/cuetake`. In Claude Code you can instead run `/plugin marketplace add levyxdev/cuetake`, then `/plugin install cuetake`.
2. Follow the skill's [setup guide](skills/cuetake/setup.md): run `scripts/cuetake doctor`, and install Node or the browser only after the user agrees to the option they pick.
3. Write a Scenario for the user's product with the [scenario API](skills/cuetake/scenarios.md), record it, and review the frames.

The skill runs the CLI through `npx -y cuetake@<version>`. CueTake is not yet published to npm; until it is, point the skill at a source checkout with `CUETAKE_BIN="node /path/to/cuetake/src/cli.js"`.

## Run from source

Requirements: Bun for development (users run the CLI on Node 20.10+) and the Chromium build CueTake's Playwright drives. Verified on macOS, headless and headed.

```sh
bun install --frozen-lockfile
bun run doctor
# Only if doctor reports Chromium missing (about 150 MB):
bun src/cli.js install-browser

bun src/cli.js record examples/basic.mjs --out ./recordings/first-take
```

The example uses `https://example.com`. It adds a small animated demo element in that isolated browser context, so it works without a local application server. For your own product, write a scenario using the [scenario API](skills/cuetake/scenarios.md).

Playwright is a local package dependency. Browser binaries use Playwright's normal OS cache. CueTake does not install global packages or start your application server.

## Commands

```sh
bun src/cli.js doctor
bun src/cli.js install-browser
bun src/cli.js record ./my-scenario.mjs --out ./recordings/my-take [--headed]
bun src/cli.js render ./recordings/my-take
bun src/cli.js verify ./recordings/my-take
bun src/cli.js frame ./recordings/my-take 2.5
bun src/cli.js login product-demo https://your-app.example/login
```

`record` completes capture → render → verification and refuses an existing output folder. `render` uses the saved Source, Timeline and Edit; it replaces the final video only after encoding succeeds. Clone a take folder to keep multiple edits.

A successful command is a technical check, not an editorial approval. Watch the result before publishing.

## How it works

Playwright drives an isolated Chromium tab. Chromium captures the tab at device-pixel resolution using `getDisplayMedia`; a VP9 `MediaRecorder` saves the source. An in-page probe records the pointer path, clicks, drags and typing into the Timeline. Render then composes the camera path in a headless Chromium page with WebGL and encodes H.264 with WebCodecs; see [ADR 0001](docs/adr/0001-render-in-browser-with-webgl-and-webcodecs.md).

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

`pipeline.test.js` covers configuration and camera math; `browser.test.js` covers the probe, Auth profiles, and Render geometry, cursor and sparks at a 2× capture scale. No build step is required. Do not commit recordings, browser profiles, credentials, or product-specific scenarios into this generic tool repository.
