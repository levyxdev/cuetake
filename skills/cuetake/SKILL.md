---
name: cuetake
description: Plan, record, refine, and verify browser product demo videos with the CueTake CLI, including login preparation and camera/cursor styling.
---

# CueTake agent operating manual

CueTake is a local execution engine for AI agents. You direct the story; CueTake captures the browser and renders the finished take. Run every command through `scripts/cuetake` in this skill's folder; it launches the pinned CueTake version with `npx`. Read [scenarios.md](scenarios.md) when writing a scenario, [authentication.md](authentication.md) when a page needs login, and [setup.md](setup.md) when Node or `npx` is missing or `doctor` reports a failed check.

## Workflow

1. Infer the audience, demonstrated outcome, duration and framing from the request. Inspect the actual application with the available browser tool; use real locators and measured canvas coordinates.
2. Run `doctor`. If it fails, follow [setup.md](setup.md): nothing installs without the user's agreement. This does not start the application's dev server.
3. Write a trusted `.mjs` scenario in the business project. `prepare(page)` loads examples/assets before capture. `run(d)` performs timed interactions and returns evidence of the demonstrated changes. Never embed credentials or copied browser state in a scenario.
4. Run `record` with the scenario path and a new Take directory. It captures, renders and verifies in the foreground, then prints the verification report; a failure exits non-zero. Capture lasts as long as the scenario and Render adds its own time, so run it in the background when your shell would time out.
5. Read verification and application evidence. Inspect frames around clicks and camera transitions with `frame <take> <seconds>`, which saves a PNG you can view, and play the final MP4. Deliver the absolute final path and relevant limitations. Technical verification is not editorial approval or authorization to publish.

Run `render` after changing a take's `edit.json`. This reuses source.webm. Cursor, click effect, camera and output all live in the Edit, so restyling never requires recording again. Preserve versions by copying a take before editing it.

## Division of responsibility

- Skill: story, pacing, discovery, authorization boundaries, quality judgment, and tool usage.
- Scenario: site-specific selectors, actions and assertions. Store it in the business project.
- CLI: recording, cursor/click effects, camera math, auth-state loading, output files and verification. Do not duplicate the engine under skill scripts.

## Login

Reuse a named auth profile when the user has authorized that account for the demo. If missing or expired, run `login <profile> <login-url>` in the background; no capture runs in that window. Ask the user to complete password/SSO/2FA and then close the window; the command saves the profile when the window closes. Pass `--auth-profile <profile>` to `record`.

`prepare` must verify an authenticated page anchor before capture. If redirected to sign-in, stop and refresh the profile instead of recording login. Do not read the user's normal Chrome profile, print tokens, or put auth files into output/source control. A stored file proves only that state exists; the application decides whether the session is still valid.

## Styling and timing

Defaults: CSS viewport 1440×900, 2× capture resolution, 60 fps target, a 3840×2160 Final with the page in a browser window on the `aurora` background, 24 px white arrow. Clicks use an outlined white spark: 32 px radius, 16 px rays, 8 rays, 420 ms duration. Set `clickEffect.style: 'none'` to disable it; color follows the cursor.

Use `d.focus(box, seconds)` for deliberate camera targets. Boxes are CSS pixels. Nearby targets form one continuous camera chain. The camera zooms to fit each target with 48 px padding, at most 2×; enter/exit 0.48 seconds, pan 0.42 seconds. Pass `focus: false` to an action that should not move the camera. Keep the camera steady during a meaningful action and give the viewer time to read the result.

Capture is variable frame rate: static scenes reduce cadence and moving scenes can drop frames. Report observed stats, not a promise of 60 independent page frames each second. Capture runs headless by default; pass `--headed` to watch it. Coverage is macOS, same-document/SPA operations, no audio. Known limitation: headless Chromium renders the generic `monospace` family as Courier rather than Menlo; record with `--headed` when a page relies on it. Full document navigation during capture requires separate takes; login and other navigation may happen before capture.

## Commands

`<skill>` is this skill's folder.

```sh
<skill>/scripts/cuetake doctor
<skill>/scripts/cuetake install-browser
<skill>/scripts/cuetake record <scenario.mjs> --out <new-take-directory> [--auth-profile product-demo] [--headed]
<skill>/scripts/cuetake render <take-directory>
<skill>/scripts/cuetake verify <take-directory>
<skill>/scripts/cuetake frame <take-directory> 2.5
<skill>/scripts/cuetake login product-demo https://your-app.example/login
```
