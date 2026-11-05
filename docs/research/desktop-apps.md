# Research: recording desktop applications, Electron and native

Answers the questions in [issue #23](https://github.com/levyxdev/cuetake/issues/23). Researched on 2026-10-31, with the native capture and computer-use spikes run on 2026-11-04, on an Apple-silicon MacBook Air running macOS 27.2 (Darwin 27.2.0), Swift 6.4, Node 24.13 and Playwright 1.63.0 (the version `bun.lock` pins). Every documentation claim cites its source. Every spike gives the command and the output it actually printed. Spike scripts and outputs live outside the repository, in the session scratchpad (`desktop-spikes/`), and are not committed.

## Verdict

**Electron: feasible now, with most of the browser pipeline reused, for apps that leave the `EnableNodeCliInspectArguments` fuse on.** Playwright's `_electron.launch({ executablePath })` attached to the installed VS Code in 233 ms. It then gave CueTake two things it can use: the app's windows as Playwright pages, and code evaluation in the app's main process. Through the main process, CueTake can install its own `setDisplayMediaRequestHandler` on a private session partition. A hidden recorder window in that partition then records the app window's tab at its device-pixel size (2400×1600 for a 1200×800 window at scale 2) at 60 fps into VP9 WebM. That is the same Source today's recorder page makes, and it needs no Screen Recording grant. The Timeline probe (`addInitScript` plus `exposeBinding`) installs in the app window, in `<webview>` guests and in `WebContentsView`s. Six of the nine Electron apps installed here leave the fuse on. The other three turn it off: Claude, Goose and Grok Bot. `_electron.launch` cannot attach to those, and Playwright documents that limitation. For them, `--remote-debugging-port` plus `chromium.connectOverCDP` still drives the windows and installs the probe, but it gives no access to the main process, so it gives no tab capture. Their Source would have to come from the native path.

**Native macOS: feasible as a second Capture method, built on a small Swift helper; measured on 2026-11-04.** ScreenCaptureKit captures one window (`SCContentFilter(desktopIndependentWindow:)`) at the backing-pixel size, without the pointer (`showsCursor = false`). On the native Gemini app it delivered 3420×2018 (a 1710×1009-point window at scale 2) at 56 fps for 30 s with no incomplete frames, while an agent's computer use drove the app and took its own screenshots; the real pointer, resting on the text field, is absent from every frame. Every frame carries its content rect and scale, which covers window moves and resizes. No maintained Node binding covers single-window capture with per-frame geometry, so CueTake would ship its own prebuilt, universal Swift helper inside the npm package. The Timeline would combine three sources: the Director logging its own actions; a listen-only `CGEventTap` that tags each event with the process that posted it; and Accessibility frames for focus targets and camera targets. A spike read the cursor shape through `NSCursor.currentSystemCursor`, but the SDK deprecates that call and says it "will always be `nil` in a future version of macOS". macOS grants permissions to the *responsible* process. Here that is the Claude Code CLI, not Claude.app, the terminal or a helper. It had Accessibility and Input Monitoring from the start; the user granted Screen Recording on 2026-11-04, after which the capture spike ran (section 5).

**Recommended order:** (1) Electron apps that leave the fuse on, through `_electron.launch` and a WebFrameMain-based recorder. This is a small change, and the Source, Timeline, Director, probe and Render all stay as they are. (2) The native macOS helper (ScreenCaptureKit, event tap, Accessibility). It then also covers Electron apps with the fuse off, as "native window capture plus CDP probe". (3) Windows and Linux later.

---

## Electron applications

### 1. Can Playwright launch and drive an installed Electron app? Which refuse?

**Answer: yes, for apps that leave `EnableNodeCliInspectArguments` on. No, through `_electron.launch`, for apps that turn it off. Of the nine Electron apps installed here, Claude, Goose and Grok Bot turn it off.**

**Evidence**

- Playwright's Electron launcher always passes `--inspect=0` and `--remote-debugging-port=0`. It then waits for *both* the Node inspector line and the DevTools line on stderr, and connects to both (`node_modules/playwright-core/lib/coreBundle.js`, Playwright 1.63.0):
  ```js
  let electronArguments = ["--inspect=0", "--remote-debugging-port=0", ...options.args || []];
  const nodeMatchPromise = waitForLine(progress2, launchedProcess, /^Debugger listening on (ws:\/\/.*)$/);
  const chromeMatchPromise = waitForLine(progress2, launchedProcess, /^DevTools listening on (ws:\/\/.*)$/);
  ```
  The connection to the Node inspector is what makes `electronApp.evaluate()` run in the main process.
- Playwright documents Electron support as experimental, for Electron v21 and later. Under known issues it says that if launch times out, the `nodeCliInspect` fuse (`EnableNodeCliInspectArguments`) must not be set to `false` ([playwright.dev/docs/api/class-electron](https://playwright.dev/docs/api/class-electron)).
- Electron's fuse documentation: `nodeCliInspect` controls whether `--inspect`, `--inspect-brk` and similar flags are respected. It does not mention `--remote-debugging-port`, and no fuse governs that switch ([electronjs.org/docs/latest/tutorial/fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)). Electron documents `--remote-debugging-port=port` as "Enables remote debugging over HTTP on the specified port" ([command-line-switches](https://www.electronjs.org/docs/latest/api/command-line-switches)).
- The fuse wire format is documented on the same fuses page: the sentinel `dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX`, a version byte, a length byte, then one byte per fuse (`0` disabled, `1` enabled, `r` removed). The fuse order comes from `FuseV1Options` in [electron/fuses `src/config.ts`](https://github.com/electron/fuses/blob/main/src/config.ts): RunAsNode, EnableCookieEncryption, EnableNodeOptionsEnvironmentVariable, EnableNodeCliInspectArguments, EnableEmbeddedAsarIntegrityValidation, OnlyLoadAppFromAsar, LoadBrowserProcessSpecificV8Snapshot, GrantFileProtocolExtraPrivileges, WasmTrapHandlers.
- **Spike: read every installed app's fuses.** This parses the wire directly from each `Electron Framework` binary rather than running `npx @electron/fuses`, so nothing was downloaded (`read-fuses.mjs`). Output:
  ```
  Antigravity.app         electron 44.5.1    wire 101100011  RunAsNode=1 NodeCliInspect=1
  Claude.app              electron 44.9.3    wire 010011011  RunAsNode=0 NodeCliInspect=0
  Cursor.app              electron 42.11.16  wire 101100011  RunAsNode=1 NodeCliInspect=1
  DeepSeek Harness.app    electron 44.7.0    wire 101100011  RunAsNode=1 NodeCliInspect=1
  Devin.app               electron 42.11.16  wire 101100011  RunAsNode=1 NodeCliInspect=1
  Goose.app               electron 43.4.0    wire 010011011  RunAsNode=0 NodeCliInspect=0
  Grok Bot.app            electron 42.11.16  wire 010011011  RunAsNode=0 NodeCliInspect=0
  Openscreen.app          electron 41.2.1    wire 101100011  RunAsNode=1 NodeCliInspect=1
  Visual Studio Code.app  electron 43.8.3    wire 101100011  RunAsNode=1 NodeCliInspect=1
  ```
  The hardened apps also turn on cookie encryption, embedded ASAR integrity validation and only-load-from-ASAR, so the app's code cannot be swapped either. (Cursor updated itself during the session: an earlier read showed Electron 40.10.3 with an 8-fuse wire, which was the same as far as it went.)
- **Spike: `_electron.launch` against VS Code** (`electron-spike.mjs`). It used a throwaway `--user-data-dir` and `--extensions-dir` in the scratchpad, and VS Code was closed with `app.close()` afterwards:
  ```
  launched in ms 233
  firstWindow url vscode-file://vscode-app/Applications/Visual%20Studio%20Code.app/Contents/Resour title
  main process versions { electron: '43.8.3', chrome: '150.0.7871.250', name: 'Code' }
  dpr / viewport { dpr: 2, w: 1200, h: 800 }
  ```
  The first attempt failed inside VS Code, not in Playwright: `IPC handle ".../1.14-main.sock" is longer than 103 chars, try a shorter --user-data-dir`. VS Code puts its single-instance socket inside the user-data directory, and Unix socket paths are capped at 104 bytes. A short symlink fixed it.
- **Spike: CDP only, no Node inspector** (`cdp-spike.mjs`). The VS Code binary was started with only `--remote-debugging-port=0`, and `chromium.connectOverCDP` connected to it. This is the route left open when the fuse is off:
  ```
  contexts 1 pages [ 'vscode-file://vscode-app/Applications/Visual%20Stu' ]
  probe records via CDP-only [{"boot":"vscode-file:"},{"down":[300,200]}]
  gDM via CDP-only (no main-process handler) "AbortError: Invalid capture constraints"
  ```
- **Claude.app's own switch check** (read-only `grep` of its `app.asar`). Its main bundle contains a list of command-line switches and a function that tests `argv` against them:
  `var HZ=["remote-debugging-port","remote-debugging-pipe","ignore-certificate-errors","host-resolver-rules",...];function WZ(e){return e.some(...)}`. What the app does on a match was not determined. Nearby code concerns a `localPairingDisabledReason`. I did not launch Claude.app: this session runs inside it, and a second launch would reach the running instance through its single-instance lock.
- Slack, Notion, Linear and Figma desktop are not installed on this Mac, so their fuses were not read. `read-fuses.mjs` answers the question for any app in a second.

**Implication for CueTake**

- The supported path is `_electron.launch({ executablePath, args })`. `doctor`, or the start of Capture, can read the fuse wire. When `EnableNodeCliInspectArguments` is off, CueTake can name the app and the reason before it tries, instead of failing on Playwright's 30-second timeout.
- For apps with the fuse off, CDP still gives the Director its pages and the probe its frames, so only the Source must come from elsewhere: native window capture (section 5). CDP `Page.startScreencast` also delivered 60 JPEG frames per second from VS Code (`CDP screencast fps 60.0`). It is a possible stopgap, but it is lossy JPEG, has no device-pixel guarantee (frame size was not measured), and would be a third Source format. I would not build on it.
- Some apps add their own launch requirements, like VS Code's socket path limit. Keep the app's user-data directory short, for example under `~/.local/share/cuetake/apps/<profile>`, rather than inside a deep Take folder.

### 2. Does `getDisplayMedia` tab capture work inside an Electron window, or does capture need `desktopCapturer` / `capturePage`?

**Answer: tab capture works, but only after CueTake installs a display-media handler from the main process. Without one, `getDisplayMedia` rejects. With `_electron.launch`, CueTake can install the handler itself, so app cooperation is not needed. `desktopCapturer` is not needed, and on macOS it would need Screen Recording.**

**Evidence**

- Electron's `ses.setDisplayMediaRequestHandler(handler)` answers `getDisplayMedia` calls from that session. The callback's `video` may be a `WebFrameMain`, which "captures the whole tab that contains that frame" ([electronjs.org/docs/latest/api/session](https://www.electronjs.org/docs/latest/api/session)). `desktopCapturer` runs in the main process only. macOS attributes its permission "to the responsible process, so when running unpackaged from a terminal or IDE it is the terminal or IDE that must be granted access" ([desktop-capturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)). `webContents.capturePage([rect, opts])` captures a still image of the page ([web-contents](https://www.electronjs.org/docs/latest/api/web-contents)).
- **Spike, VS Code** (`electron-spike.mjs`, `electron-spike2.mjs`):
  ```
  gDM default {"ok":false,"name":"AbortError","message":"Invalid capture constraints"}
  gDM with WebFrameMain handler {"ok":true,"settings":{..."displaySurface":"browser","frameRate":60,...,"cursor":"motion"}, "vp9":true}
  capturePage size { width: 2400, height: 1600 }
  desktopCapturer window sources Failed to get sources.
  ```
  `desktopCapturer` failed because the responsible process has no Screen Recording grant; see section 6.
- **Spike: CueTake's recorder-page design, rebuilt inside Electron** (`electron-spike2.mjs`). The main process creates a session partition, `cuetake-recorder`. It answers `https://recorder.cuetake.invalid/` itself through `ses.protocol.handle('https', …)`, which makes the recorder page a secure context; a `data:` or `about:blank` page is not one, and has no `navigator.mediaDevices`. The handler returns the app window's `webContents.mainFrame`. A hidden `BrowserWindow` in that partition runs CueTake's existing constraints and `MediaRecorder`. Output, with a busy animation in the app window:
  ```
  {"contentBounds":{"x":255,"y":154,"width":1200,"height":800},"scale":2,
   "result":{"ok":true,"settings":{"width":2400,"height":1600,"frameRate":60,"displaySurface":"browser","cursor":"motion"},
             "video":[2400,1600],"fps":60,"webmBytes":262097,"secure":true}}
  ```
  The app's own default session and its handlers are left untouched.

**Implication for CueTake**

- `tab-capture.js` carries over almost unchanged. The differences are how the recorder page is created (a hidden `BrowserWindow` made through `electronApp.evaluate`, instead of `context.newPage()` plus `route`) and how the captured tab is chosen (a `WebFrameMain` from the handler, instead of `--auto-select-tab-capture-source-by-title`, which is a Chrome switch). The Source stays VP9 WebM in device pixels, one per Tab (ADR 0008), so Render does not change (ADR 0002). No Screen Recording permission is needed, and no new browser is installed: the app brings its own Chromium, so `install-browser` is not involved.
- The capture has no system pointer, as in the browser today (`cursor: "motion"` is the surface's setting, and the page pixels carry no pointer). The Cursor is still drawn by Render.
- An Electron window is a real, headed window on the user's screen. There is no headless mode, so Capture shows a window, as `--headed` does today. See section 3 for the input that this lets in.

### 3. Does the Timeline probe install in Electron windows, `<webview>`s and BrowserViews?

**Answer: yes, in all three. Playwright treats a `<webview>` guest and a `WebContentsView` (the successor of `BrowserView`) as separate pages, not as frames of the window. A `WebContentsView` is also missing from the window's tab capture, so it needs a Source of its own.**

**Evidence**

- **App window** (`electron-spike.mjs`). `context.exposeBinding` plus `context.addInitScript`, then a reload:
  ```
  probe records [{"kind":"boot","top":true,"href":"vscode-file://vscode-app/..."},{"kind":"move","x":450.46484375,"y":559.50390625,...}, ...] total 70
  ```
- **`WebContentsView`** (`electron-spike2.mjs`). A view was added to the VS Code window from the main process:
  ```
  pages now [ 'vscode-file://vscode-app/Applications/Visual%20Stu', 'data:text/html,<title>embedded view</title>...' ]
  boot records [..., {"kind":"boot","href":"data:text/html,<title>embedded view</tit", ...}]
  ```
  In the window's tab capture, the pixel at the centre of the yellow view was VS Code's background, `[19,18,21,255]`. `capturePage` gave the same result (`electron-spike3.mjs`). So a `WebContentsView` is not part of its window's tab.
- **`<webview>`** (`electron-spike4.mjs`). A host window with `webviewTag: true` was created from the main process:
  ```
  all webContents: [{"type":"webview",...},{"type":"window",...},...]
  boots: {"href":"data:text/html,<body style=\"margin:0;bac","isMainFrame":true}      <- host
         {"href":"data:text/html,<body style='margin:0;bac","isMainFrame":true}       <- the <webview> guest, as its own page
  tab capture pixel inside the <webview>: [254,254,4,255]                            <- yellow: the guest is in the host's tab
  ```
- VS Code itself uses neither. It has one `webContents` (`webContents in main [{ id: 1, type: 'window', ... }]`), and its editor webviews are iframes, which the probe already follows.
- **Real input leaks in.** In the first spike, the probe recorded `move` events around (450, 559) before any Playwright input. They came from the physical pointer over the new window. `isTrusted` cannot tell them apart from Playwright input, because both are trusted at the DOM level.

**Implication for CueTake**

- The probe and `collectTimeline` work as they are for the window and its iframes.
- A `<webview>` guest is drawn in its host's Source, but the probe sees it as a separate page. Node must place its records in the host's CSS pixels by measuring the `<webview>` element in the host, the way `frames.js` measures iframes. That is a small extension.
- A `WebContentsView` needs its own Source, and Render must composite it at its bounds inside the window. That is ADR 0008's Source per Tab, with "placed inside the window at these bounds" as a new placement next to "replaces the page" and "popup window". Electron apps that use this pattern (an app shell around web views) need it. VS Code does not.
- The user must keep their hands off the window during a Take. Otherwise the Director can mark its own input (for example, a probe flag set around each Director action), so stray physical input is dropped or flagged. `doctor` cannot prevent this; the skill should tell the user.

### 4. What is the Scenario's "start page" for an app? How do Auth profiles map onto the app's user-data directory?

**Answer: an app target (executable path plus arguments) replaces `config.url`. An Auth profile becomes a saved copy of the app's user-data directory, made by a login run, rather than a Playwright `storageState`. This was verified for VS Code. Whether every Electron app honours `--user-data-dir` was not verified.**

**Evidence**

- `_electron.launch` takes `executablePath`, `args`, `cwd` and `env` ([class-electron](https://playwright.dev/docs/api/class-electron)). There is no `goto`: the app opens its own first window, and `firstWindow()` returns it (spike above).
- VS Code honoured `--user-data-dir` and `--extensions-dir`. The throwaway profile in the scratchpad received its `logs/` folders, and the user's own profile was not used. That is VS Code's own flag. Electron's command-line switch list does not document `--user-data-dir` ([command-line-switches](https://www.electronjs.org/docs/latest/api/command-line-switches)), so for other apps it must be checked app by app.
- Electron logins live in the app's user-data directory (cookies, local storage, IndexedDB). With the `cookieEncryption` fuse on, the cookie store is encrypted "with OS-level keys" ([fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)), which on macOS means the login Keychain. A copied directory therefore works only for the same user on the same Mac. Playwright's `storageState` covers cookies and origin storage, but not the app's own files (settings, extension state, files written by Node in the main process).
- Window size is the app's choice: 1200×800 for a fresh VS Code profile. The Scenario's `viewport` can be applied with `BrowserWindow.setContentSize` through `electronApp.evaluate`. Device scale follows the display (dpr 2 here). Forcing scale 2 on a 1× display was not tested.

**Implication for CueTake**

- Scenario: `config.app = { executable: '/Applications/Visual Studio Code.app', args: [...] }` as an alternative to `config.url` (exactly one of the two). `prepare(page)` gets the first window. `run(d)` stays the same. `d.page` is the Tab in front, and a new window is a new Tab (ADR 0008).
- Auth profile: `cuetake login <profile> --app <path>` launches the app on a fresh user-data directory owned by CueTake and waits for the user to quit it. Each Take then starts from a fresh copy of that directory, so a Take never changes the saved login. The user's real profile is never opened, which keeps the AGENTS.md rule that product-specific Auth profiles stay outside the repository and away from global state.
- Validation: refuse an app whose fuse is off (section 1) and explain why, rather than timing out.

---

## Native applications (macOS first)

### 5. Source: a window at backing-pixel resolution and 60 fps? Node binding or helper binary?

**Answer: yes, measured: a window at backing-pixel resolution, about 56 fps, without the pointer. No suitable Node binding exists, so CueTake needs its own Swift helper. The best fit is a prebuilt universal binary shipped inside the npm package.**

**Evidence** (macOS SDK headers in `/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk`, and Apple's documentation)

- `SCContentFilter initWithDesktopIndependentWindow:` "captures just the independent window passed in". The filter exposes `pointPixelScale` and `contentRect` ("Size and location of content in points"), available from macOS 14 (`ScreenCaptureKit.framework/Headers/SCStream.h`; [SCContentFilter](https://developer.apple.com/documentation/screencapturekit/sccontentfilter)).
- `SCStreamConfiguration.width` and `height` are the output size in pixels, 1920 by default on macOS. `minimumFrameInterval` defaults to 1/60, "meaning that updates are coming in at or up to 60fps", and `kCMTimeZero` gives the display's native refresh rate. `showsCursor` is on by default ([showsCursor](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/showscursor)). `captureResolution` `.best` means "Capture streaming content at the best available resolution", and `.nominal` means one point to one pixel ([SCCaptureResolutionType](https://developer.apple.com/documentation/screencapturekit/sccaptureresolutiontype)). `ignoreShadowsSingleWindow` leaves out the window shadow. `ignoreGlobalClipSingleWindow` keeps capturing a window that is partly off screen (SCStream.h).
- Every frame carries `SCStreamFrameInfoScaleFactor` (pixels per point), `ContentScale` ("scaling factor from original content size to its size in surface"), `ContentRect` (content in points within the surface), `ScreenRect` (on-screen location) and `DirtyRects` (SCStream.h).
- `SCRecordingOutput` (macOS 15) writes H.264 or HEVC MP4 directly (`SCRecordingOutput.h`). Render already opens its Source through mediabunny with `ALL_FORMATS` (`src/render-page.js`), so an MP4 Source decodes without changes to Render.
- **Node bindings on npm** (`npm view`; nothing was installed):

  | Package | What it is | Fit |
  | --- | --- | --- |
  | `aperture` 7.0.0 (wulkano) | Prebuilt universal Swift binary, run by Node; the README targets macOS 10.13 and offers screen, crop area, `showCursor` and `highlightClicks` | No single-window capture or per-frame geometry |
  | `screencapturekit` 1.0.22 | Same pattern: a Swift CLI built at publish time (`swift build --arch arm64 --arch x86_64`) | Third-party binary of uncertain upkeep; no per-frame geometry |
  | `node-mac-recorder` 2.24.26 | node-gyp addon with an `install` script | Builds at install: needs a compiler, and node-gyp fetches Node headers, which breaks "install scripts download nothing" |
  | `node-mac-permissions` 2.5.0 | node-gyp addon (`install: node-gyp rebuild`) | Same install problem; permissions only |
  | `node-screencapturekit` 0.0.1 | Placeholder | None |

  The working pattern on npm is the one `aperture` and `screencapturekit` use: a Swift binary prebuilt at publish time, shipped in the package, and run with `child_process`.
- **Spike** (`swift/window-stream.swift`). It compiles with `/usr/bin/swiftc`. It picks an app's window, configures `desktopIndependentWindow`, sets size = `contentRect × pointPixelScale`, `minimumFrameInterval` 1/60, `showsCursor = false`, `.best`, and `ignoreShadowsSingleWindow`, then reports pixel size, frame rate and per-frame geometry. Run here:
  ```
  $ ./window-stream com.microsoft.VSCode 3        # 2026-10-31, before the grant
  no Screen Recording grant; not prompting
  exit 2
  ```
  After the user granted Screen Recording (2026-11-04), the first run aborted with `Assertion failed: (did_initialize), function CGS_REQUIRE_INIT`: a command-line tool must connect to the window server before ScreenCaptureKit, so the helper calls `NSApplication.shared` first. Then, on the native Gemini app (`com.google.GeminiMacOS`, a SwiftUI app with no Electron framework), saving every 120th frame as PNG:
  ```
  $ ./window-stream com.google.GeminiMacOS 30
  window on screen: true active: true
  window '' frame(points) (0.0, 37.0, 1710.0, 1009.0) pointPixelScale 2.0 -> output 3420x2018
  callbacks 1680, complete frames 1680, complete fps 55.96464836318456
    px 3420x2018 scale 2 contentScale 1 contentRect { ... }
  ```
  During those 30 s the agent's computer use moved the real pointer over the window, clicked the text field, typed "Thanks!" and took full-screen screenshots. Frame 360 shows the typed text and the text caret but no pointer, although the pointer was resting on that field; the rate held at 56 fps throughout, so computer use's own screenshots did not starve the stream. The window was frontmost; capturing an occluded window was not tested.

**Implication for CueTake**

- A helper `cuetake-capture` (universal arm64/x86_64, built at release by `swift build` and placed in the package; `aperture`'s whole package is 3.5 MB unpacked, binary included) runs as a child process of the Node CLI. Runtime code stays Node-only: `node:child_process` with JSON over stdio. Install scripts download nothing, because the binary is in the tarball and needs no postinstall. Not verified here: whether Gatekeeper ever checks a binary npm unpacked. Sign it at release anyway, so it keeps a stable identity if it ever becomes the responsible process (section 6). Building on first use with the user's consent, like `install-browser`, would need the Xcode Command Line Tools. They are present on this Mac but not on a stock one, and installing them is a download of its own. Prefer shipping it prebuilt.
- The helper writes the Source as H.264 or HEVC MP4 (`SCRecordingOutput`, or `AVAssetWriter` for exact per-frame timestamps), plus a sidecar with each frame's time, `contentRect`, `scaleFactor` and `contentScale`. That sidecar plays the role `capture.json` plays today. Render is unchanged (ADR 0002).
- The measured rate is 56 fps, not 60, on a 60 Hz panel. Render already turns a variable-rate Source into a constant-rate Final, so this needs no change, but the helper should time frames from their presentation timestamps, not count them.

### 6. Permissions: which process asks, and can `doctor` detect a missing grant?

**Answer: the responsible process holds the grant: the terminal app, or the agent's host. In this session that is the Claude Code CLI binary, because Claude.app starts it through a `disclaimer` helper. A child helper inherits it. Yes, `doctor` can detect a missing grant without a prompt, by asking the helper to run the preflight calls.**

**Evidence**

- `CGPreflightScreenCaptureAccess` "Returns whether the current process already has permission to capture the contents of the screen, without prompting the user". `CGRequestScreenCaptureAccess` prompts, and "A previously denied process is not re-prompted; the user must enable access in System Settings > Privacy & Security > Screen Recording" (`CoreGraphics.framework/Headers/CGWindow.h`). `CGPreflightListenEventAccess` and `CGPreflightPostEventAccess` check event listening and posting access (`CGEvent.h`). `AXIsProcessTrusted` returns whether the process is a trusted accessibility client. `AXIsProcessTrustedWithOptions` with `kAXTrustedCheckOptionPrompt` is the one that prompts (`HIServices.framework/Headers/AXUIElement.h`).
- Electron states the rule: macOS attributes the permission "to the responsible process, so when running unpackaged from a terminal or IDE it is the terminal or IDE that must be granted access" ([desktop-capturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)).
- **Spike** (`swift/probe.swift`, run from this agent's Bash). It reads the responsible process through the `responsibility_get_pid_responsible_for_pid` SPI (looked up with `dlsym`) and makes only non-prompting calls:
  ```
  self pid 49668 .../desktop-spikes/swift/probe
  responsible pid 45661 /Users/lyot/Library/Application Support/Claude/claude-code/2.1.309/5af865b9901c/claude.app/Contents/MacOS/claude
  CGPreflightScreenCaptureAccess() = false
  AXIsProcessTrusted() = true
  CGWindowList on-screen windows: 20, with a readable kCGWindowName: 1
  SCShareableContent skipped: no Screen Recording grant, and calling it could prompt
  ```
  On 2026-11-04, after the user's grant, the same probe printed `responsible pid 24011 …/claude-code/2.1.317/91184d3d9ba3/claude.app/Contents/MacOS/claude`, `CGPreflightScreenCaptureAccess() = true`, and `SCShareableContent windows: 21, displays: 1`. The responsible binary's path had changed with a CLI update (2.1.309 to 2.1.317); whether a grant survives the next update was not observed.
  `swift/probe2.swift`: `CGPreflightListenEventAccess() = true`, `CGPreflightPostEventAccess() = true`. The process tree shows Claude.app starting the CLI as `/Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- …/claude`. That helper makes the CLI its own responsible process, so grants go to the CLI binary, not to Claude.app. Without Screen Recording, `CGWindowListCopyWindowInfo` still lists windows and their bounds but withholds their titles, so only the menu bar's name was readable.

**Implication for CueTake**

- The process that needs Screen Recording (and Input Monitoring for the event tap, Accessibility for AX queries) is whatever started CueTake: Terminal, iTerm, VS Code's terminal, or the agent host's CLI. CueTake's helper does not need its own grant while it runs as a child. The prompt shows the host's name, which the skill must explain.
- `doctor` adds a `screen-recording` check, plus `accessibility` and `input-monitoring` checks where the Timeline needs them. Each runs `cuetake-capture preflight`, which makes only the preflight calls (never the request calls) and reports the responsible process's path, so the fix can name it: "Allow `<that app>` in System Settings > Privacy & Security > Screen Recording, then restart it". As with `install-browser`, nothing is requested without the user agreeing first.
- To keep one grant across hosts, the helper could later be shipped as a signed `.app` started with `open`, so it becomes its own responsible process. That is a later refinement, not needed to start.

### 7. Timeline without a page: Director log, event tap, accessibility notifications

**Answer: use all three, each for its own job. The Director's own log is the pointer path and presses, as today. A listen-only `CGEventTap` catches input the Director did not make (keys, the user's pointer), and tells them apart by the posting process. Accessibility gives frames for focus targets and camera targets, and window moves and resizes.**

**Evidence**

- **Event tap spike** (`swift/probe2.swift`). Input Monitoring was already granted, so a listen-only tap was created. The spike posted one mouse move to the pointer's current position, so nothing visibly moved:
  ```
  event tap created with option listenOnly; my pid 49878
    tap saw 5 from pid 49878 sourceState 1 at (635.3046875, 834.1328125)
  ```
  `kCGEventSourceUnixProcessID` (field 41, `CGEventTypes.h`) identifies the posting process, so the Director's synthetic input (its own pid) can be told apart from hardware input. Hardware input was not observed in the spike, because the pointer was idle. The location is in global points with a top-left origin. `CGPreflightListenEventAccess` checks "event listening access" and `CGPreflightPostEventAccess` checks "event synthesizing access" (`CGEvent.h`). The comment on `CGEventTapCreate` ties taps on key events to accessibility access. In System Settings, listening access is the Input Monitoring list.
- **Accessibility spike** (`swift/probe2.swift`, read-only queries of running apps):
  ```
  Dock AX items: 38 in 74 ms; first: ["Finder (38.27, 1045.73, 44.27, 56.27)", "Apps (...)", "Safari (...)"]
  Finder AX windows: 2 ["Downloads (360.0, 34.0, 1213.0, 991.0)", ...]
    AXButtons in first Finder window: 15
  element under pointer: AXScrollArea ''
  ```
  Frames come from `kAXPositionAttribute` and `kAXSizeAttribute` in global points with a top-left origin. `AXUIElementCopyElementAtPosition` returns the element at a point. `AXObserver` can subscribe to `kAXFocusedUIElementChangedNotification`, `kAXWindowMovedNotification` and `kAXWindowResizedNotification` (`AXNotificationConstants.h`).
- **Live spike on Gemini** (`swift/watch.swift`, 2026-11-04): a listen-only session tap, an `AXObserver` on the app, and a 50 ms poll of the pointer, the focused element and `NSCursor.currentSystem`, while the agent's computer use drove the app (section 11). Observer delivery works: focus and value changes arrived within milliseconds, with frames in global points:
  ```
  2045  focus AXTextArea 'Ask Gemini' (610.0, 509.5, 720.0, 31.0)
  10319 ax AXValueChanged: AXTextArea 'Ask Gemini' (610.0, 509.5, 720.0, 52.0)
  27989 tap type=1 at=(972.0, 970.0) srcPid=15105 targetPid=14315
  27989 tap type=2 at=(972.0, 970.0) srcPid=15105 targetPid=14315
  28026 tap type=10 at=(972.0, 970.0) srcPid=15105 targetPid=14315 key='N'
  ```
  Synthetic input carries the posting process (15105 is Claude.app, the computer-use host; 14315 is Gemini). The user's own trackpad scrolls in the same log carry `srcPid=0`, so hardware input and agent input are told apart as the earlier spike predicted.

**Implication for CueTake**

- The Director moves the pointer itself (section 8), so it knows the path exactly, as it does now with `glide`. It writes move, press and release records into the Timeline in window points.
- The helper's event tap (listen-only, keyboard and mouse) records keys for Shortcuts and flags any input whose source pid is not the Director's. That flag is a warning in `verify` ("the user's pointer moved during the Take"), not a silent mix.
- AX focus notifications give the focused element's frame as a focus target. The Director's `focus()` keeps working with AX frames. A window move or resize notification updates the window origin used for conversion (section 10).
- Shape records come from section 9.

### 8. Director: how does a Scenario name a target in a native app? What happens to `d.click(locator)`?

**Answer: by Accessibility role and title, in the style of `getByRole`, with coordinates in window points as a fallback. `d.click(target)` keeps its contract: glide to the target's AX frame, press there with a real `CGEvent`, and record the action.**

**Evidence**

- The AX tree exposes role, title, description and frame for standard AppKit and SwiftUI controls (spike above: Dock items by `AXDockItem` and title, Finder's `AXButton`s). `AXUIElementPerformAction(kAXPressAction)` presses without moving the pointer (`AXUIElement.h`, `AXActionConstants.h`).
- Posting a synthetic `CGEvent` mouse move works with post-event access, and the tap sees it with the helper's pid (section 7).

**Implication for CueTake**

- The Scenario passes `d.app`, an object with locators: `d.app.getByRole('button', { name: 'Export' })`, `d.app.window('Untitled')`. The helper resolves a locator to an AX element and returns its frame. `d.click(locator)` glides with `motion.js` (moving the real pointer through `CGEventPost`, sampled at the capture rate), pauses, presses and releases with `CGEvent` at the landing point, then checks the result through AX (the element is pressed or focused, or the value changed). `AXPress` is kept only for controls that ignore synthetic clicks, because it shows no pointer movement.
- `d.type` uses `CGEventKeyboardSetUnicodeString` key events. `d.press` uses keycodes. `d.drag` uses down, move and up. Evidence checks (`return { exported: true }`) read AX values.
- Moving the real pointer is unavoidable for a native demo, because the app must see hover and press. So the user cannot use the Mac during a native Take. CueTake should say so before Capture starts. The browser path has no such constraint.

### 9. Cursor shape: can the system cursor's shape be read so Render keeps drawing it?

**Answer: partly. `NSCursor.currentSystemCursor` works today and identifies standard shapes, but it is deprecated and Apple says it will return `nil` in a future macOS. A durable source for the shape does not exist, so CueTake would fall back to inferring the shape from the AX role under the pointer.**

**Evidence**

- AppKit header (`NSCursor.h`): `currentSystemCursor` "will always be `nil` in a future version of macOS", deprecated with "No longer recommended. Use ScreenCaptureKit to capture the screen. Use the `showsCursor` property on `SCStreamConfiguration` ... Or, use `NSCursor.currentCursor` if needing to just get the current cursor for this application."
- **Spike** (`swift/cursor.swift`, with `NSApplication.shared` initialised so the class cursors load). The pointer was over this terminal's text:
  ```
  NSCursor.arrow: hotSpot=(5.0, 5.0) size=(28.0, 40.0) reps=["28x40", "56x80", "140x200", "280x400"]
  NSCursor.iBeam: hotSpot=(12.0, 11.0) size=(23.0, 22.0) ...
  currentSystem: hotSpot=(12.0, 11.0) size=(23.0, 22.0) ...
  pixel-equal to: ["iBeam"]
  ```
  An earlier run with the pointer elsewhere returned the arrow's 28×40 image with hotspot (5, 5). Reading it 100 times took 17 ms, cheap enough to poll at 60 Hz.
- In the live Gemini spike (`swift/watch.swift`, section 7) the poll followed the pointer across another app's window: the shape switched from the arrow (hotspot (5, 5), 28×40) to the I-beam (hotspot (12, 11), 23×22) 44 ms after computer use clicked into Gemini's text field, and back to the arrow when the pointer left it.
- The alternative Apple points to, `showsCursor = true`, would bake the pointer into the Source. That contradicts ADR 0002 (the Cursor is drawn by Render from the Timeline).

**Implication for CueTake**

- The helper polls `currentSystemCursor` at the capture rate, matches it against the standard `NSCursor` images, and records `shape` records with the same keywords the probe uses (`default`, `text`, `pointer`, `grab`, ...). Where it returns `nil` or an unknown image, it falls back to the AX role under the pointer: text field or text area → `text`, link → `pointer`, otherwise `default`.
- Do not record with `showsCursor = true`: that would break restyling without recording again.

### 10. Coordinate spaces: window points vs. backing pixels, and window moves or resizes during a Take

**Answer: window points map to today's CSS pixels, and backing pixels map to the Source's device pixels. A move does not disturb the Source, but Timeline positions must be converted with the window origin at each moment. A resize changes the content scale inside a fixed-size Source, so it must be recorded per frame and should normally be prevented.**

**Evidence**

- AX frames, `CGEvent` locations and `SCWindow.frame` are all global points with a top-left origin (spikes above: the Dock at y = 1045 on a 1107-point-high display, the event at (635, 834)).
- `SCStreamFrameInfoScaleFactor` is "the pixel to point scaling factor ... in the range of [1, 4]". `ContentRect` is "the size and location of content in points in surface". `ContentScale` is "the scaling factor from original content size to its size in surface". A desktop-independent-window filter follows the window, and `ScreenRect` gives its on-screen location (SCStream.h).
- In the Electron spike, the window's CSS size equals its content size in points (1200×800), and the device scale (2) equals the display's backing scale.

**Implication for CueTake**

- Timeline coordinates for a native Take are points relative to the window's content origin, sampled with each record. That keeps AGENTS.md's rule as is: the Timeline in logical units (points stand in for CSS pixels), the Source in device pixels, output dimensions independent.
- On a move, the Source is unaffected: the helper converts each event with the window origin it had at that moment, using AX `kAXWindowMovedNotification` or the frame's `ScreenRect`.
- On a resize, the output size is fixed when the stream starts, so the content is rescaled (`contentScale` < 1) or letterboxed. The sidecar records `contentRect` and `contentScale` per frame, so Render could undo it. Simpler for v1: set the window size before Capture (AX `kAXSizeAttribute`), and warn if it changes during the Take.
- A window that moves to a display with another scale factor changes `scaleFactor` mid-Take. Warn about it, as for a resize.

### 11. Computer use: can an agent's computer use act as the Director while CueTake captures? Does it interfere?

**Answer: partly, now measured. Computer use drove the native Gemini app in both of its modes, and it does not disturb a ScreenCaptureKit window capture. But neither mode performs like a person: background mode leaves no input at all (no pointer, text appears in one jump), and full-screen mode teleports the pointer and types at machine speed, with several seconds of model time between actions. Use it to *author* a native Scenario (find targets and check them), not to perform one.**

**Evidence**

- Anthropic's computer use tool: Claude returns actions (`screenshot`, `mouse_move`, `left_click`, `left_click_drag`, `type`, `key`, `cursor_position`, ...). The developer's harness executes them ("Claude doesn't directly connect to this environment"). Coordinates are in screenshot pixels, and on macOS Retina they must be halved or the image downscaled. Each screenshot costs about 1,000–1,800 input tokens. The docs warn that Claude "sometimes acts as if its actions succeeded without explicitly checking their results" ([platform.claude.com/docs/en/docs/agents-and-tools/tool-use/computer-use-tool](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/computer-use-tool)).
- **Live spike, 2026-11-04**, with the Claude desktop app's computer-use server driving Gemini while `swift/watch.swift` (section 7) and `swift/window-stream.swift` (section 5) ran:
  - **Background mode (`app_*` tools).** "New chat" was pressed with `AXPress`, the prompt was written with `AXSelectedText`, and "Submit" was pressed with `AXPress`, as the tools' own results reported. The event tap saw no input events from them, and the real pointer did not move. The whole prompt arrived as one `AXValueChanged`, so a Source would show the text appear at once. A `return` key sent this way inserted a newline instead of submitting; the Submit button had to be pressed.
  - **Full-screen mode (`computer_batch`).** The real pointer jumped from (1422, 602) to (972, 970) between two 50 ms polls, with no positions in between. Press and release had the same timestamp. "Now say it in five words." (25 characters) was typed in about 480 ms, about 19 ms per key, each `keyDown` tagged `srcPid` = Claude.app. It also brought Gemini to the front and hid every app not granted to it.
  - **Pace.** Between one batch of actions and the next, the model took 6 to 8 seconds of wall time.
  - **Capture.** A 30 s ScreenCaptureKit capture running through a full-screen batch (two pointer moves, a click, typing, a screenshot) kept 56 fps with no incomplete frames, and showed no pointer (section 5).

**Implication for CueTake**

- Keep the Director deterministic: the Scenario is code, and the helper performs it at a human pace. The agent uses computer use, or the helper's AX listing (`cuetake-capture tree <app>`), while *writing* the Scenario: to find role and title locators and check that they resolve. That is the same split as the browser path, where the agent explores with a browser and then writes a Scenario.
- Background-mode computer use shows the right idea for locators: it found and pressed controls by AX role and title ("New chat", "Submit", the "Ask Gemini" text area), which is what a native Scenario's targets would be (section 8).
- If computer use ever acts during Capture, the event tap's source-pid flag (section 7) marks its input, so the Timeline still gets presses and keys. Render could glide the Cursor between press points, but the Source would still show machine-speed typing and multi-second pauses, so this is a fallback, not the design.

---

## Open questions for the user

Settled with the user on 2026-11-05, while grilling the follow-up issues; [ADR 0009](../adr/0009-desktop-apps-are-captured-behind-the-same-source-and-timeline.md) records the result.

1. **Grant identity across updates.** Settled: the grants survive. Accessibility and Input Monitoring, granted while the CLI was 2.1.309, still worked at 2.1.317 (the AX observer and the event tap in section 7), so the grant follows the CLI's signature, not its path. The helper runs as a child process; no `.app`.
2. **Which apps matter most?** TextEdit, LocalSend (Flutter) and Claude. None of them would use the Electron path, so every App, Electron included, is recorded natively, and the Electron path is dropped.
3. **Unattended Mac during Takes.** Accepted: the Mac is not used during a Take. CueTake says so before Capture, and `verify` warns about input the Director did not make.
4. **Signing the helper.** No Developer ID: run as a child process, an ad-hoc signature is enough. It is built on a Mac before publishing.
5. **Shape fallback.** Accepted: infer the shape from the AX role when `currentSystemCursor` gives nothing.

The grilling also replaced single-window capture (section 5) with a Desktop: a region of the screen filtered to the Take's Apps, so menus, sheets, several windows and switching between Apps are recorded. Whether that filter shows context menus and pop-up lists, and whether hardware idle time can detect the user's input without Input Monitoring, are checked on a Mac in issue #30.

## Proposed ADR direction

Superseded by ADR 0009 as settled above. As first proposed:

"**Desktop apps are a second and third Capture method behind the same Source and Timeline**" (extends ADRs 0002 and 0008):

- **Electron (first):** `_electron.launch` of the installed app on a user-data directory owned by CueTake. A recorder window in a private session partition records each window's tab through `setDisplayMediaRequestHandler` with a `WebFrameMain`. The page probe and Director are unchanged. A `WebContentsView` is a Tab placed inside its window. Apps with `EnableNodeCliInspectArguments` off are refused with the reason until native capture exists.
- **Native macOS (second):** a signed, prebuilt universal Swift helper shipped in the npm package, run as a child process. ScreenCaptureKit single-window capture without the pointer, written as MP4 with per-frame geometry. Timeline from the Director's own log, a listen-only event tap tagged by source pid, and AX focus and window notifications. Cursor shape from `currentSystemCursor`, with an AX-role fallback. Scenario targets by AX role and title. `doctor` checks Screen Recording, Accessibility and Input Monitoring through non-prompting preflights and names the responsible app.
- **Rejected:** computer use as the Director (too coarse for a timed, human-paced Timeline); `showsCursor = true` (bakes the pointer into the Source, against ADR 0002); a node-gyp addon (builds and downloads at install); CDP screencast as a Source (lossy JPEG, no device-pixel guarantee).

Follow-up issues: (a) Electron Capture via `_electron.launch` and a WebFrameMain recorder; (b) `config.app` and app Auth profiles; (c) `WebContentsView` as an inner Tab in Render; (d) the `cuetake-capture` helper and its `doctor` checks; (e) the native Director with AX locators; (f) the native Timeline (event tap, AX, cursor shape).
