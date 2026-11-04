# Desktop apps are captured behind the same Source and Timeline

CueTake records desktop apps by adding Capture methods, not by changing Render: each method produces Sources and a Timeline as ADR 0002 defines them, so Render, the Edit and Looks work unchanged. Electron apps come first, because their windows are Chromium pages. Playwright's `_electron.launch` starts the installed app on a user-data directory CueTake owns. A recorder window in a private session partition then records each app window through the main process's `setDisplayMediaRequestHandler`, and the probe and the Director stay as they are. Native macOS apps come second, through a Swift helper. ScreenCaptureKit records one window without the pointer, at its backing-pixel size. The Timeline comes from the Director's own actions, a listen-only event tap and Accessibility notifications. Scenarios name targets by Accessibility role and title. The evidence for both methods, measured on a Mac, is in [docs/research/desktop-apps.md](../research/desktop-apps.md) (issue #23).

## Considered options

- **An agent's computer use as the Director.** Rejected: measured on a native app, its background mode presses through Accessibility, so the pointer never moves and typed text appears at once. Its full-screen mode teleports the pointer, types about 19 ms per key, and pauses 6 to 8 seconds between actions. Neither looks like a person. The agent uses computer use to find targets while writing a Scenario, as it uses a browser for web demos.
- **ScreenCaptureKit with `showsCursor` on.** Rejected: the pointer would be baked into the Source, so the Cursor could no longer be restyled without recording again (ADR 0002).
- **A node-gyp addon or an existing npm binding for ScreenCaptureKit.** Rejected: an addon builds at install and fetches Node headers, which breaks "install scripts download nothing". The prebuilt bindings on npm offer no single-window capture with per-frame geometry.
- **Native capture for every Electron app.** Rejected as the first step: it needs Screen Recording and a new helper, while `_electron.launch` reuses the browser pipeline with no grant. Native capture still serves the Electron apps that turn off the `EnableNodeCliInspectArguments` fuse (Claude, Goose and Grok Bot on the test Mac), and stays the fallback for them.
- **CDP screencast as a Source for those apps.** Rejected: lossy JPEG frames with no device-pixel guarantee, and a third Source format.

## Consequences

- A Scenario starts an app (an executable and its arguments) instead of opening a URL. An Auth profile for an app is a saved copy of a user-data directory CueTake owns. It works only on the same Mac and user.
- Each recorded app window is a Tab with its own Source (ADR 0008). An Electron `WebContentsView` is a Tab that Render places inside its window. A `<webview>` is part of its window's Source.
- For native apps, window points play the role of CSS pixels, and backing pixels play the role of device pixels. The helper records each frame's content rect and scale. A window that is resized during a Take is a warning, not something Render corrects.
- The native helper is a signed, prebuilt universal binary shipped inside the npm package and run as a child process over stdio. Runtime code stays Node-only, and signing becomes a release step.
- macOS grants Screen Recording, Accessibility and Input Monitoring to the process responsible for CueTake: the terminal or the agent's host. `doctor` checks them with non-prompting preflight calls and names that app. Nothing is requested without the user agreeing.
- The native Director moves the real pointer, so the Mac cannot be used during a native Take. The event tap flags input from any other process, and `verify` warns about it.
- The cursor shape comes from `NSCursor.currentSystemCursor`, which Apple has deprecated, with a fallback inferred from the Accessibility role under the pointer.
- Windows and Linux are out of scope until the macOS methods ship.
