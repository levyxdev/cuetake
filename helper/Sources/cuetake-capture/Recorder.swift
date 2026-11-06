import AppKit
import ApplicationServices
import AVFoundation
import CoreImage
import ScreenCaptureKit

/**
 * What `record` reads first: the Apps, the Desktop's size in points, the frame rate, where the Source and
 * poster go, and whether the user agreed to record an App they already run as it is (`useRunning`).
 */
struct Request: Decodable {
  struct App: Decodable { let path: String; let args: [String]? }
  struct Size: Decodable { let width: Double; let height: Double }
  let apps: [App]
  let useRunning: Bool?
  let desktop: Size
  let fps: Int
  let source: String
  let poster: String
}

/**
 * `cuetake-capture record`: starts the Apps and lays out their Desktop, then records it between `start`
 * and `stop`, each a JSON line on stdin. Replies, one JSON line each:
 *   {"ready": {...}}    the first App's first window fills the Desktop; nothing records yet
 *   {"started": {...}}  the first frame is written; `epochMs` is its wall-clock time
 *   {"stopped": {...}}  the Source is complete; `frames`, `windows` and what the Observer saw are the sidecar
 *   {"error": {...}}    then the helper exits
 * Once ready, a line with an `id` is a request of the Director's (Controller), answered with
 * {"id", "reply"} or, when it cannot be done, {"id", "failed": message}.
 * Closing stdin ends the Source and quits the Apps, as `stop` does.
 */
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
  static func main() {
    let recorder = Recorder()
    Task { @MainActor in await recorder.run() }
    NSApplication.shared.run()
  }

  private var request: Request!
  /** The Take's Apps, in the request's order, once started, and their names. */
  private var running: [NSRunningApplication] = []
  private var names: [String] = []
  /** The Apps the user started, by index: never quit, and their windows' frames, to put back after the Take. */
  private var users: Set<Int> = []
  private var putBack: [(AXUIElement, CGRect)] = []
  private var desktop = CGRect.zero
  private var scale = 2.0
  private var stream: SCStream?
  private var writer: AVAssetWriter?
  private var input: AVAssetWriterInput?
  private var tracker: WindowTracker?
  private let frames = DispatchQueue(label: "cuetake.frames")
  // Read and written on the frames queue.
  private var firstTime: CMTime?
  private var latest: CVPixelBuffer?
  private var times: [[Double]] = []
  private var dropped = 0
  private var startedAt: CheckedContinuation<Double, Never>?
  private var failure: String?
  private var stopping = false
  private var controller: Controller?
  private var observer: Observer?

  private let commands = AsyncStream<String> { continuation in
    Thread.detachNewThread {
      while let line = readLine() { continuation.yield(line.trimmingCharacters(in: .whitespaces)) }
      continuation.finish()
    }
  }

  @MainActor private func run() async {
    var lines = commands.makeAsyncIterator()
    guard let first = await lines.next(), let request = try? JSONDecoder().decode(Request.self, from: Data(first.utf8)) else { fail("request", "cuetake-capture record expects a request line") }
    self.request = request
    guard CGPreflightScreenCaptureAccess() else { fail("screen-recording", "The app CueTake runs in has no Screen Recording grant; run cuetake doctor, which names it") }
    guard AXIsProcessTrusted() else { fail("accessibility", "The app CueTake runs in has no Accessibility grant; run cuetake doctor, which names it") }
    guard CGPreflightListenEventAccess() else { fail("input-monitoring", "The app CueTake runs in has no Input Monitoring grant, which tells the Director's input from a person's; run cuetake doctor, which names it") }
    var ready = false
    do {
      emit(["ready": try await launch()])
      ready = true
      while let line = await lines.next() {
        guard let message = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] else { continue }
        if let id = message["id"] as? Int {
          do { emit(["id": id, "reply": try controller!.handle(message)]) }
          catch { emit(["id": id, "failed": (error as? Refusal)?.message ?? "\(error)"]) }
        }
        else if message["start"] != nil { emit(["started": ["epochMs": try await start()]]) }
        else if message["stop"] != nil { break }
      }
      emit(["stopped": try await stop()])
      exit(0)
    } catch {
      let refusal = error as? Refusal
      // Before ready the Scenario has not touched the App, so one stuck on a dialog may be forced to quit.
      await quitApp(force: !ready)
      fail(refusal?.code ?? "capture", failure ?? refusal?.message ?? "\(error)")
    }
  }

  // MARK: Launch

  /**
   * Starts the Apps, waits for each one's first standard window, and fills the Desktop with the first
   * App's; the others stay where they put theirs. The first App ends in front. An App the user already
   * runs stops the Take unless they agreed to record it as it is (`useRunning`): then it is used as it
   * runs, never quit, and its windows are put back when the Take ends.
   */
  @MainActor private func launch() async throws -> [String: Any] {
    guard !request.apps.isEmpty else { throw Refusal("app", "The request names no App") }
    let urls = try request.apps.map { try appURL($0.path) }
    let bundles = urls.map { Bundle(url: $0) }
    names = zip(urls, bundles).map { url, bundle in (bundle?.object(forInfoDictionaryKey: "CFBundleName") as? String) ?? url.deletingPathExtension().lastPathComponent }
    let ids = zip(urls, bundles).map { url, bundle in bundle?.bundleIdentifier ?? url.standardizedFileURL.path }
    if let twice = ids.enumerated().first(where: { ids.firstIndex(of: $0.element) != $0.offset }) {
      throw Refusal("app", "\(names[twice.offset]) is named twice in config.app; name each App once")
    }
    let theirs = bundles.map { bundle in bundle?.bundleIdentifier.flatMap { NSRunningApplication.runningApplications(withBundleIdentifier: $0).first { !$0.isTerminated } } }
    let busy = zip(theirs, names).filter { $0.0 != nil }.map(\.1)
    if !busy.isEmpty && request.useRunning != true {
      let one = busy.count == 1, listed = one ? "\(busy[0]) is" : busy.dropLast().joined(separator: ", ") + " and \(busy.last!) are"
      let it = one ? "it" : "them", its = one ? "its" : "their"
      throw Refusal("running", "\(listed) running. Ask the user whether to record \(it) as \(one ? "it is" : "they are"): \(its) windows and data show in the Take, which does not start afresh; CueTake leaves \(it) running and puts \(its) windows back. On yes, record again with --use-running; otherwise ask the user to quit \(it). Never quit \(it) for them.")
    }
    let screen = NSScreen.screens.enumerated().max { $0.element.backingScaleFactor < $1.element.backingScaleFactor || ($0.element.backingScaleFactor == $1.element.backingScaleFactor && $0.offset > $1.offset) }!.element
    scale = Double(screen.backingScaleFactor)
    let primaryHeight = NSScreen.screens[0].frame.height, visible = screen.visibleFrame
    let size = CGSize(width: request.desktop.width, height: request.desktop.height)
    guard size.width <= visible.width, size.height <= visible.height else {
      throw Refusal("desktop", "The Desktop, \(Int(size.width))×\(Int(size.height)) points, does not fit on \(screen.localizedName) (\(Int(visible.width))×\(Int(visible.height)) points free); use a smaller viewport")
    }
    desktop = CGRect(x: (visible.minX + (visible.width - size.width) / 2).rounded(), y: (primaryHeight - visible.maxY + (visible.height - size.height) / 2).rounded(), width: size.width, height: size.height)

    var first: AXUIElement?
    for (i, url) in urls.enumerated() {
      let configuration = NSWorkspace.OpenConfiguration()
      configuration.arguments = request.apps[i].args ?? []
      configuration.activates = true
      configuration.addsToRecentItems = false
      configuration.promptsUserIfNeeded = false
      let app: NSRunningApplication
      if let mine = theirs[i] {
        app = mine
        users.insert(i)
        app.unhide()
      } else { app = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration) }
      running.append(app)
      let window = try await standardWindow(of: app, named: names[i])
      if i == 0 { first = window }
      if theirs[i] != nil { putBack += AX.windows(AXUIElementCreateApplication(app.processIdentifier)).compactMap { w in AX.frame(w).map { (w, $0) } } }
    }
    AX.setFrame(first!, desktop)
    for app in running { AX.exposeContent(AXUIElementCreateApplication(app.processIdentifier)) }
    running[0].activate()
    let observer = Observer(pids: running.map(\.processIdentifier), desktop: desktop, fps: request.fps)
    self.observer = observer
    controller = Controller(apps: running, desktop: desktop, observer: observer)
    try await Task.sleep(nanoseconds: 500_000_000)
    let frame = AX.frame(first!) ?? desktop
    let apps = running.enumerated().map { i, app -> [String: Any] in ["name": names[i], "bundle": bundles[i]?.bundleIdentifier ?? "", "pid": Int(app.processIdentifier), "running": users.contains(i)] }
    return ["apps": apps, "scale": scale, "display": screen.localizedName, "desktop": rect(desktop), "window": rect(frame.offsetBy(dx: -desktop.minX, dy: -desktop.minY))]
  }

  /** The App's first standard window, waited for: an App may show a dialog first, which the Take must not frame. */
  @MainActor private func standardWindow(of app: NSRunningApplication, named name: String) async throws -> AXUIElement {
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    var others = 0
    for _ in 0..<300 {
      let windows = AX.windows(ax)
      if let window = windows.first(where: { AX.value($0, kAXSubroleAttribute) as? String == kAXStandardWindowSubrole }) { return window }
      others = windows.count
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    throw Refusal("window", others > 0
      ? "\(name) showed a dialog and no window within 30 s. Open it yourself, answer the dialog, quit it, then record again; an App given a document in args may not be allowed to open it."
      : "\(name) opened no window within 30 s; open it yourself to see why, quit it, then record again.")
  }

  private func appURL(_ path: String) throws -> URL {
    if path.hasSuffix(".app") || path.contains("/") {
      let url = URL(fileURLWithPath: path)
      guard FileManager.default.fileExists(atPath: url.path) else { throw Refusal("app", "No App at \(path)") }
      return url
    }
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: path) else { throw Refusal("app", "No App with the bundle id \(path)") }
    return url
  }

  // MARK: Capture

  /** Starts recording; returns the wall-clock time of the first frame, in ms since the epoch. */
  @MainActor private func start() async throws -> Double {
    guard !running.isEmpty else { throw Refusal("capture", "No App of the Take is running; record again") }
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    // Every App of the Take, so their windows show in their real order on the one Source, and no other app's does.
    var shared: [SCRunningApplication] = []
    for (i, app) in running.enumerated() {
      guard let listed = content.applications.first(where: { $0.processID == app.processIdentifier }) else { throw Refusal("capture", "ScreenCaptureKit does not list \(names[i]), which may have quit or hidden its windows; record again") }
      shared.append(listed)
    }
    guard let display = content.displays.first(where: { $0.frame.intersects(desktop) && $0.frame.contains(CGPoint(x: desktop.midX, y: desktop.midY)) }) else { throw Refusal("capture", "No display holds the Desktop, as when a display was disconnected; record again") }
    let config = SCStreamConfiguration()
    config.sourceRect = desktop.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
    config.width = Int(desktop.width * scale)
    config.height = Int(desktop.height * scale)
    config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(request.fps))
    config.showsCursor = false
    config.captureResolution = .best
    config.pixelFormat = kCVPixelFormatType_32BGRA
    config.colorSpaceName = CGColorSpace.sRGB
    // Clear outside the App's windows, so each window's corners can be read before H.264 drops the alpha.
    // Shadows stay: where a menu or sheet lies over a window, its own shadow shows on it, as on the screen.
    config.backgroundColor = CGColor.clear
    config.queueDepth = 6

    let writer = try AVAssetWriter(outputURL: URL(fileURLWithPath: request.source), fileType: .mp4)
    let pixels = config.width * config.height
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: config.width, AVVideoHeightKey: config.height,
      AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: min(80_000_000, max(8_000_000, pixels * request.fps / 6)),
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        AVVideoExpectedSourceFrameRateKey: request.fps, AVVideoMaxKeyFrameIntervalKey: request.fps * 2,
        AVVideoAllowFrameReorderingKey: false,
      ],
      AVVideoColorPropertiesKey: [AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2, AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2, AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2],
    ])
    input.expectsMediaDataInRealTime = true
    guard writer.canAdd(input) else { throw Refusal("capture", "The H.264 encoder cannot take \(config.width)×\(config.height)") }
    writer.add(input)
    guard writer.startWriting() else { throw Refusal("capture", "The Source cannot be written: \(writer.error?.localizedDescription ?? "unknown")") }
    self.writer = writer
    self.input = input
    tracker = WindowTracker(pids: running.map(\.processIdentifier), desktop: desktop)

    let filter = SCContentFilter(display: display, including: shared, exceptingWindows: [])
    let stream = SCStream(filter: filter, configuration: config, delegate: self)
    try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: frames)
    self.stream = stream
    let first = await withCheckedContinuation { continuation in
      frames.sync { startedAt = continuation }
      Task { do { try await stream.startCapture() } catch { frames.sync { failure = "\(error)"; startedAt?.resume(returning: .nan); startedAt = nil } } }
    }
    if first.isNaN { throw Refusal("capture", failure ?? "Capture did not start") }
    try observer?.begin(zero: frames.sync { CMTimeGetSeconds(firstTime!) })
    return first
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, !stopping, let input, let writer,
          let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
          let info = attachments.first, let raw = info[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
          let pixels = CMSampleBufferGetImageBuffer(sample) else { return }
    let time = CMSampleBufferGetPresentationTimeStamp(sample)
    if firstTime == nil {
      firstTime = time
      writer.startSession(atSourceTime: time)
      // The wall clock at this frame: now, less how long ago the frame was presented.
      let ago = CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock())) - CMTimeGetSeconds(time)
      startedAt?.resume(returning: (Date().timeIntervalSince1970 - ago) * 1000)
      startedAt = nil
    }
    guard input.isReadyForMoreMediaData, input.append(sample) else { dropped += 1; return }
    let t = CMTimeGetSeconds(CMTimeSubtract(time, firstTime!)), frameScale = (info[.scaleFactor] as? Double) ?? scale
    times.append([(t * 1_000_000).rounded() / 1_000_000, frameScale])
    latest = pixels
    tracker?.sample(t: t, pixels: pixels, scale: frameScale)
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    frames.async { [self] in failure = "Capture stopped: \(error.localizedDescription)"; startedAt?.resume(returning: .nan); startedAt = nil }
  }

  // MARK: Stop

  /** Finishes the Source at this moment, writes the poster, quits the Apps and returns the sidecar. */
  @MainActor private func stop() async throws -> [String: Any] {
    let end = CMClockGetTime(CMClockGetHostTimeClock())
    let observed = observer?.end() ?? [:]
    try? await stream?.stopCapture()
    let (first, latest, times, dropped) = frames.sync { stopping = true; return (firstTime, self.latest, self.times, self.dropped) }
    if let failure { throw Refusal("capture", failure) }
    guard let first, let writer, let input else { throw Refusal("capture", "Capture recorded no frame: the App showed nothing on the Desktop; check that it opens a window, then record again") }
    input.markAsFinished()
    // The Source lasts until `stop`, holding its last frame, as long as the Take.
    writer.endSession(atSourceTime: end)
    await writer.finishWriting()
    if writer.status != .completed { throw Refusal("capture", "The Source was not written: \(writer.error?.localizedDescription ?? "unknown")") }
    if let latest {
      let context = CIContext()
      try? context.writePNGRepresentation(of: CIImage(cvPixelBuffer: latest), to: URL(fileURLWithPath: request.poster), format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
    }
    let windows = tracker?.track() ?? []
    let unquit = await quitApp()
    return ["duration": (CMTimeGetSeconds(CMTimeSubtract(end, first)) * 1000).rounded() / 1000, "frames": times, "dropped": dropped,
            "size": ["width": Int(desktop.width * scale), "height": Int(desktop.height * scale)], "windows": windows, "unquit": unquit].merging(observed) { a, _ in a }
  }

  /**
   * Quits the Apps this Take started, closing any open menu first, and puts back the windows of those
   * the user started; returns the names of those that did not quit. With `force`, an App that does not
   * quit within 5 s, as one holding a dialog open, is forced to.
   */
  @discardableResult @MainActor private func quitApp(force: Bool = false) async -> [String] {
    let started = running.enumerated().filter { !users.contains($0.offset) }
    let live = started.map(\.element).filter { !$0.isTerminated }
    defer { for (window, frame) in putBack { AX.setFrame(window, frame) }; putBack = [] }
    guard !running.filter({ !$0.isTerminated }).isEmpty else { return [] }
    if tracker?.menuOpen() ?? WindowTracker(pids: running.map(\.processIdentifier), desktop: desktop).menuOpen() {
      let source = CGEventSource(stateID: .combinedSessionState)
      for down in [true, false] { CGEvent(keyboardEventSource: source, virtualKey: 53, keyDown: down)?.post(tap: .cgSessionEventTap) }
      try? await Task.sleep(nanoseconds: 300_000_000)
    }
    guard !live.isEmpty else { return [] }
    live.forEach { $0.terminate() }
    for _ in 0..<50 where live.contains(where: { !$0.isTerminated }) { try? await Task.sleep(nanoseconds: 100_000_000) }
    if force && live.contains(where: { !$0.isTerminated }) {
      live.filter { !$0.isTerminated }.forEach { $0.forceTerminate() }
      for _ in 0..<20 where live.contains(where: { !$0.isTerminated }) { try? await Task.sleep(nanoseconds: 100_000_000) }
    }
    return started.filter { !$0.element.isTerminated }.map { names[$0.offset] }
  }
}

/** A failure the Node CLI shows as it is. */
struct Refusal: Error {
  let code: String, message: String
  init(_ code: String, _ message: String) { self.code = code; self.message = message }
}

private func rect(_ r: CGRect) -> [String: Double] { ["x": Double(r.minX), "y": Double(r.minY), "width": Double(r.width), "height": Double(r.height)] }
