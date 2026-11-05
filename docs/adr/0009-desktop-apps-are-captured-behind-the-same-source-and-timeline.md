# Desktop apps are captured behind the same Source and Timeline

CueTake records desktop Apps on macOS through one native Capture method that produces a Source and a Timeline as ADR 0002 defines them, so the Edit and Looks work unchanged. A Swift helper uses ScreenCaptureKit to record a Desktop: one region of the screen, filtered to the Take's Apps, showing only their windows, where they are and in their order, without the pointer, at backing-pixel size. Several windows, menus, sheets and switches between Apps then show as they happen, and the Take has one Tab, its Desktop (ADR 0008). Every App goes this way, Electron apps included. The Director moves the real pointer and posts real keys at a human pace, and names targets by Accessibility role and title. The Timeline is what the Director did, plus the frames of the Desktop's windows, focus targets and the system cursor's shape. The evidence for this, measured on a Mac, is in [docs/research/desktop-apps.md](../research/desktop-apps.md) (issue #23).

## Considered options

- **Record Electron apps through Playwright's `_electron.launch` and tab capture.** This reuses the browser pipeline and needs no Screen Recording grant. Rejected: tab capture misses the app's native menus and its `WebContentsView`s, it cannot attach to apps that turn off the `EnableNodeCliInspectArguments` fuse (Claude among them), and it would be a second desktop path to maintain. None of the Apps the first demos target (TextEdit, LocalSend, Claude) would use it.
- **Record one window with `desktopIndependentWindow`.** Rejected: menus, pop-up lists and popovers are windows of their own, so they would be missing, and a second window or another App could not be shown.
- **An agent's computer use as the Director.** Rejected: measured on a native app, its background mode presses through Accessibility, so the pointer never moves and typed text appears at once. Its full-screen mode teleports the pointer, types about 19 ms per key, and pauses 6 to 8 seconds between actions. Neither looks like a person. The agent uses computer use, or the helper's Accessibility listing, to find targets while writing a Scenario.
- **ScreenCaptureKit with `showsCursor` on.** Rejected: the pointer would be baked into the Source, so the Cursor could no longer be restyled without recording again (ADR 0002).
- **A node-gyp addon or an existing npm binding for ScreenCaptureKit.** Rejected: an addon builds at install and fetches Node headers, which breaks "install scripts download nothing". The prebuilt bindings on npm offer no filtered region capture with per-frame geometry.
- **The helper as a signed `.app` with its own grants, or signed with a Developer ID.** Rejected: run as a child process, the helper uses the grants of the app that started CueTake, and those grants survived an update of the Claude Code CLI, so it needs no identity of its own. An ad-hoc signature is enough to run on Apple silicon.

## Consequences

- A Scenario starts one or more Apps (each a `.app` path or bundle id, with arguments) instead of opening a URL. CueTake refuses to start an App that is already running, so every Take starts the same way, and never quits one for the user. To record the app that hosts the agent, run the agent from a terminal.
- An App runs with the user's own login and data. A Take can change that data, and Auth profiles do not apply to Apps.
- Desktop points play the role of CSS pixels, and backing pixels play the role of device pixels. The Desktop sits on the display with the highest scale, and its first window fills it. A window that leaves the Desktop, moves or resizes during a Take, or a Desktop at scale 1, is a warning, not something Render corrects.
- The helper records each window's frame per frame. Render draws only the windows, each with its own corners and shadow, and the Background shows between them. This is the one change Render needs.
- Menus opened from the menu bar sit outside the Desktop and are not recorded.
- The helper is a prebuilt universal binary shipped inside the npm package and run as a child process over stdio, so runtime code stays Node-only. It is built on a Mac before publishing, as a release step.
- macOS grants Screen Recording and Accessibility to the process responsible for CueTake: the terminal or the agent's host. `doctor` checks them with non-prompting preflight calls and names that app. Nothing is requested without the user agreeing.
- The Director moves the real pointer, so the Mac cannot be used during a Take. The Timeline holds only the Director's input, and `verify` warns when other input arrived. A click whose target is covered by another app's window fails the Take.
- The cursor shape comes from `NSCursor.currentSystemCursor`, which Apple has deprecated, with a fallback inferred from the Accessibility role under the pointer.
- Windows and Linux are out of scope until the macOS method ships.
