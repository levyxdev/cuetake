---
name: cuetake
description: Direct an AI agent to plan, record, refine, and verify browser product demo videos with CueTake's local MCP runtime or CLI, including login preparation and camera/cursor styling.
---

# CueTake agent operating manual

CueTake is a local execution engine for AI agents. You direct the story; CueTake captures the browser and renders the finished take. Read `docs/scenarios.md` in the CueTake installation when writing a scenario. Read `docs/authentication.md` when a page needs login.

## Workflow

1. Infer the audience, demonstrated outcome, duration and framing from the request. Inspect the actual application with the available browser tool; use real locators and measured canvas coordinates.
2. Run `cuetake_doctor` through MCP, or `bun <cuetake-root>/src/cli.js doctor`. Resolve missing dependencies explicitly; this does not start the application's dev server.
3. Write a trusted `.mjs` scenario in the business project. `prepare(page)` loads examples/assets before capture. `run(d)` performs timed interactions and returns evidence of the demonstrated changes. Never embed credentials or copied browser state in a scenario.
4. Invoke `cuetake_record` with the scenario's absolute path and a new output directory. It returns immediately with a job ID. Check `cuetake_job` after roughly 10 seconds and wait for completed/failed; do not infer success from the initial response.
5. Read verification and application evidence. Inspect frames around clicks and camera transitions and play the final MP4. Deliver the absolute final path and relevant limitations. Technical verification is not editorial approval or authorization to publish.

Use `cuetake_render` after changing a take's `project.json` camera/output settings or `camera.json` targets. This reuses source.webm. Cursor and spark pixels are baked into capture, so changing them requires recording again. Preserve versions by copying a take before editing it.

## Division of responsibility

- Skill: story, pacing, discovery, authorization boundaries, quality judgment, and tool usage.
- Scenario: site-specific selectors, actions and assertions. Store it in the business project.
- MCP/runtime: recording, cursor/click effects, camera math, auth-state loading, output files and verification.
- CLI: the same engine for agents without MCP and for diagnostics. Do not duplicate the engine under skill scripts.

## Login

Reuse a named auth profile when the user has authorized that account for the demo. If missing or expired, call `cuetake_auth_open` with the login URL and profile name; no capture runs in that window. Let the user complete password/SSO/2FA, then call `cuetake_auth_save` after confirmation. Pass the profile name to `cuetake_record`.

`prepare` must verify an authenticated page anchor before capture. If redirected to sign-in, stop and refresh the profile instead of recording login. Do not read the user's normal Chrome profile, print tokens, or put auth files into output/source control. A stored file proves only that state exists; the application decides whether the session is still valid.

## Styling and timing

Defaults: CSS viewport 1440×900, 2× capture resolution, 60 fps target, 1920×1200 output, 24 px white arrow. Clicks use an outlined white spark: 32 px radius, 16 px rays, 8 rays, 420 ms duration. Set `clickEffect.style: 'none'` to disable it; color follows the cursor.

Use `d.focus(box, seconds)` for deliberate camera targets. Boxes are CSS pixels. Nearby targets form one continuous camera chain. Default zoom 1.5×, enter/exit 0.48 seconds, pan 0.42 seconds. Keep the camera steady during a meaningful action and give the viewer time to read the result.

Capture is variable frame rate: static scenes reduce cadence and moving scenes can drop frames. Report observed stats, not a promise of 60 independent page frames each second. Current acceptance coverage is headed Chromium on macOS, same-document/SPA operations, no audio. Full document navigation during capture requires separate takes; login and other navigation may happen before capture.

## CLI fallback

```sh
bun <cuetake-root>/src/cli.js record <scenario.mjs> --out <new-take-directory>
bun <cuetake-root>/src/cli.js record <scenario.mjs> --out <new-take-directory> --auth-profile product-demo
bun <cuetake-root>/src/cli.js render <take-directory>
bun <cuetake-root>/src/cli.js verify <take-directory>
```

Runtime authentication UI is currently exposed through MCP. The skill is portable guidance; installing only this file does not install the runtime, browser, or FFmpeg. Read `docs/distribution.md` for integration and release status.
