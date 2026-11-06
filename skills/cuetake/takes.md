# Take folders and editing a Take

Read this after `record` finishes, to find a file in a Take or to change a Take without recording again. What happens on the page is fixed at Capture; changing it means writing the Scenario again ([scenarios.md](scenarios.md)).

```text
<output>/<scenario>/<take>/
  project.json       Scenario config, status, application evidence, duration
  scenario.mjs       Snapshot of the original scenario module
  source-<tab>.webm  Source of each Tab (0 is the first page): original high-resolution VP9 capture; a Take of an App has source-0.mp4, its Desktop in H.264
  capture.json       Per Tab: track settings, video frame callback observations and the page's animation frames per second, in seconds from its own start
  timeline.json      Timeline: for a Take of Apps, the Apps (`apps`) and their windows on the Desktop over time (`windows`, each naming its App), the Director's pointer path and input, the system cursor's shapes and each element the App focused (`focused` events), in Desktop points; the Tabs (`tabs`: opener, when each opened, closed and started recording, viewport) and which is in front (`front` events), pointer path, cursor shapes, clicks and drags with their release, typing, Shortcuts, focus, said Lines, fast-forwards, masks and page loads, in seconds and each Tab's top-level CSS pixels, the boxes of each masked element over time (`elements`), plus any input inside an iframe it could not place exactly (`frameInput`)
  edit.json          Edit: camera targets and settings, cursor, click effect, Shortcuts and keycaps, frame, how Tabs switch and where popups sit, fast-forwards, Masks, Line starts and volumes, Subtitles, output
  narration/         The Narration: narration.json (text, word timings) and each Line's audio, named by its id
  subtitles.srt/.vtt Subtitles of the placed Lines, from the last Render
  styles/            Shaders, drawing code and images the Edit names
  poster.png         The Tab in front at the end, at native capture resolution
  preview.png        Preview: the current Edit beside candidate Looks, from the last `preview`
  final.mp4          Final: H.264 camera composition
  render.json        Encoder, rate control and GPU used by the last Render, and the frames each Mask was drawn on; its times are seconds of the Final
  verification.json Output metadata, decode result, capture observations per Tab, and warnings when the browser fell behind, iframe input could not be placed exactly, a Mask found no element, or, for an App, someone used the Mac during the Take
```

A copied scenario snapshot may import helper modules from its original project. It is a record of the scenario, not a bundled runnable archive. Keep business scenarios in their application repository.

Times in `edit.json` and `timeline.json` are Source seconds, from the start of Capture; a fast-forward only changes when they happen in the Final. To edit a completed take, change `edit.json` (camera settings, target boxes and times, fast-forwards, Masks, the Shortcuts shown as `shortcuts: [{ "t": 2.4, "keys": ["Meta", "K"] }]`, and the styling in [styling.md](styling.md)), then run `cuetake render <take>`. To compare styling first, run `cuetake preview <take> --look <name|file.json>...`, which composes stills without touching `edit.json` or the Final. A Look is a partial Edit holding any styling and camera settings, but not camera targets, Shortcuts, fast-forwards, Masks, `frame.url`, `frame.urls`, `tabs.placement` or `output.fps`. `cuetake look apply` merges one into `edit.json`, and `cuetake record --look` seeds a new take's Edit with it under the Scenario config. The Scenario config only seeds the first Edit. Changing what happens on the page requires recording again. `render` automatically runs verification; `verify` checks without rendering.

`edit.json` also carries `output.fps`, the Final's frame rate, which a new Take takes from `capture.fps`, and `frame.url`, the address bar's text, which defaults to the host the page was on when Capture started; a Scenario's `frame.url` replaces that host's name. When a page navigates to another host, `frame.urls` lists each change as `{ "t": 3.2, "url": "checkout.stripe.com", "tab": 0 }`, in Source time from when the Tab took the new address; a Tab the demo opens starts with the address it opened on, or empty until its first page commits. Edit or remove one and render again. `tabs.placement: [{ "tab": 2, "x": 100, "y": 60 }]` moves a popup window, its page's top left in its opener's CSS pixels; by default it is centered over its opener and scaled down to fit. Encoders without a quantizer mode fall back to a bitrate, recorded in `render.json`.

Copy a Take folder before editing it to keep several versions.
