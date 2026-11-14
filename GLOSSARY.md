# CueTake

CueTake records product demos of web pages and desktop Apps for AI agents: an agent writes a Scenario, CueTake captures a Take and renders its Final video.

## Language

### Recording

**Scenario**:
A trusted script describing one demo: the start page or App, the timed interactions, and the evidence that the demonstrated change happened.
_Avoid_: script, flow file, recipe

**Director**:
What a Scenario's `run` is handed to act on the page or App like a person: it moves the cursor, clicks, types, drags and scrolls at a human pace, and marks camera targets and Lines.
_Avoid_: driver, bot, automation

**App**:
An installed desktop application that a Scenario starts instead of opening a start page.
_Avoid_: client, program, binary

**Desktop**:
The part of the screen a Take of Apps shows: the windows of the Apps it records, where they are and in their order, with nothing else on the screen.
_Avoid_: screen, display, stage

**Take**:
One recording attempt and everything it produces, kept together in its own folder.
_Avoid_: recording, run, project

**Tab**:
One page or Desktop a Take shows: the start page, or one the demo opened, as a new tab or a popup window; a Take of Apps shows a single Tab, its Desktop. One Tab is in front at each moment.
_Avoid_: page, window, popup

**Capture**:
The phase that drives the page or App through a Scenario and produces the Source and the Timeline.
_Avoid_: recording phase

**Source**:
The unedited picture of one Tab produced by Capture, in device pixels; a Take has one Source per Tab.
_Avoid_: raw video, recording

**Timeline**:
Every interaction observed during Capture (pointer path, presses and releases, the cursor shape the page asked for or macOS showed, typing, Shortcuts, focus targets, each element an App focused, where each Line was said and any of its words the Scenario waited for after the voice said it, the Fast-forwards the Scenario marked, each page load from a navigation or reload, which Tab is in front, the boxes of each element a Mask follows), timed from the start of Capture and positioned in the CSS pixels of the Tab it happened in.
_Avoid_: event log, camera events

**Shortcut**:
A key or combination pressed outside a text field, or with Control, Alt or Meta held inside one, which the Final shows as keycaps, a key pressed alone only when the Edit asks; typing into a field is not one, since the page already shows it.
_Avoid_: hotkey, keystroke, key event

**Home**:
Where CueTake keeps Scenarios, Takes and Looks: a project's own, when the skill that ran is installed in that project, otherwise the user's, shared by every project.
_Avoid_: workspace, data dir, storage

**Auth profile**:
A saved, named login state that a Take of a web page can start from, so login never happens on camera. A Take of an App starts with the login the App already has.
_Avoid_: session, cookies, login state

### Rendering

**Edit**:
The editable choices that turn a Source and Timeline into a Final: camera, cursor, click effects, the Shortcuts shown and their keycaps, frame styling, how Tabs switch and where popup windows sit, Fast-forwards, Masks, Line timing, Subtitles, and output, together with the shader, drawing-code and image files those choices name, kept in the Take.
_Avoid_: camera edit, render config, project settings

**Fast-forward**:
A span of a Take, marked by the Scenario as a wait the viewer need not sit through, that the Final plays faster at its rate.
_Avoid_: speed-up, timelapse, idle skip

**Mask**:
A region of one Tab's page, hidden or pointed at for a span of a Take: blurred past reading, covered with a solid color, or spotlit, with the rest of the frame dimmed. It follows an element the Scenario named, or sits at a fixed box.
_Avoid_: redaction, blur box, highlight

**Background**:
What fills the Final around the window: a list of image and shader layers, each drawn over the one before. It stays still while the camera moves the window over it.
_Avoid_: backdrop, wallpaper, gradient

**Cursor**:
The pointer Render draws over the page or Desktop, following the Timeline's pointer path, in the shape the page or macOS showed once it settled, so passing over links and text keeps the shape before, pressed while a button is held.
_Avoid_: mouse, pointer sprite

**Look**:
A named, reusable set of the Edit choices that do not depend on one Take (frame styling, how Tabs switch, cursor, click effects, keycap styling, Subtitle styling, output size and quality, camera behavior), with the files they name, that a new or existing Take can adopt. A Look is saved in a Home; one in a project's Home hides one with the same name in the user's.
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

### Narration

**Narration**:
The spoken commentary of a Take: Lines in one language, written by the agent and voiced outside CueTake.
_Avoid_: voiceover, script, audio

**Line**:
One spoken phrase of a Narration, with its text, its audio and the time it starts.
_Avoid_: cue, segment, utterance

**Subtitles**:
The text of a Narration shown in time with its Lines, written as subtitle files and optionally drawn into the Final.
_Avoid_: captions
