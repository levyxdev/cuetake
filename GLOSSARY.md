# CueTake

CueTake records browser product demos for AI agents: an agent writes a Scenario, CueTake captures a Take and renders its Final video.

## Language

### Recording

**Scenario**:
A trusted script describing one demo: the start page, the timed interactions, and the evidence that the demonstrated change happened.
_Avoid_: script, flow file, recipe

**Take**:
One recording attempt and everything it produces, kept together in its own folder.
_Avoid_: recording, run, project

**Capture**:
The phase that drives the page through a Scenario and produces the Source and the Timeline.
_Avoid_: recording phase

**Source**:
The unedited picture of the page produced by Capture, in device pixels.
_Avoid_: raw video, recording

**Timeline**:
Every interaction observed during Capture (pointer path, clicks, typing, focus targets), timed from the start of Capture and positioned in CSS pixels.
_Avoid_: event log, camera events

**Auth profile**:
A saved, named login state that a Take can start from, so login never happens on camera.
_Avoid_: session, cookies, login state

### Rendering

**Edit**:
The editable choices that turn a Source and Timeline into a Final: camera, cursor, click effects, frame styling, and output.
_Avoid_: camera edit, render config, project settings

**Look**:
A named, reusable set of the Edit choices that do not depend on one Take (frame styling, cursor, click effects, output size and quality, camera behavior) that a new or existing Take can adopt. A Look is saved locally, for the directory CueTake runs in, or globally, for every directory; a local Look hides a global one with the same name.
_Avoid_: style, theme, preset

**Preview**:
A still picture of a Take composed exactly as Render would compose it, one tile per Look being compared, made without producing a Final.
_Avoid_: thumbnail, mockup, frame

**Render**:
The phase that composes the Final from the Source, the Timeline and the Edit.
_Avoid_: convert, export, encode

**Final**:
The finished video a Take delivers.
_Avoid_: output, export, result
