import AppKit
import ApplicationServices
import AVFoundation
import CoreImage
import ScreenCaptureKit

/** What `record` reads first: the App, the Desktop's size in points, the frame rate and where the Source and poster go. */
struct Request: Decodable {
  struct App: Decodable { let path: String; let args: [String]? }
  struct Size: Decodable { let width: Double; let height: Double }
  let app: App
  let desktop: Size
  let fps: Int
  let source: String
  let poster: String
}

/**
 * `cuetake-capture record`: starts the App and lays out its Desktop, then records it between `start`
 * and `stop`, each a JSON line on stdin. Replies, one JSON line each:
 *   {"ready": {...}}    the App's first window fills the Desktop; nothing records yet
 *   {"started": {...}}  the first frame is written; `epochMs` is its wall-clock time
 *   {"stopped": {...}}  the Source is complete; `frames` and `windows` are the sidecar
 *   {"error": {...}}    then the helper exits
 * Closing stdin ends the Source and quits the App, as `stop` does.
 */
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
  static func main() {
    let recorder = Recorder()
    Task { @MainActor in await recorder.run() }
    NSApplication.shared.run()
  }

  private var request: Request!
  private var running: NSRunningApplication?
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
    var ready = false
    do {
      emit(["ready": try await launch()])
      ready = true
      while let line = await lines.next() {
        if line.contains("\"start\"") { emit(["started": ["epochMs": try await start()]]) }
        if line.contains("\"stop\"") { break }
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

  /** Starts the App, unless it already runs, and fills the Desktop with its first window. */
  @MainActor private func launch() async throws -> [String: Any] {
    let url = try appURL(request.app.path)
    let bundle = Bundle(url: url), name = (bundle?.object(forInfoDictionaryKey: "CFBundleName") as? String) ?? url.deletingPathExtension().lastPathComponent
    if let id = bundle?.bundleIdentifier, NSRunningApplication.runningApplications(withBundleIdentifier: id).contains(where: { !$0.isTerminated }) {
      throw Refusal("running", "\(name) is running. Quit it, then record again: every Take starts the App afresh, and CueTake never quits it for you.")
    }
    let screen = NSScreen.screens.enumerated().max { $0.element.backingScaleFactor < $1.element.backingScaleFactor || ($0.element.backingScaleFactor == $1.element.backingScaleFactor && $0.offset > $1.offset) }!.element
    scale = Double(screen.backingScaleFactor)
    let primaryHeight = NSScreen.screens[0].frame.height, visible = screen.visibleFrame
    let size = CGSize(width: request.desktop.width, height: request.desktop.height)
    guard size.width <= visible.width, size.height <= visible.height else {
      throw Refusal("desktop", "The Desktop, \(Int(size.width))×\(Int(size.height)) points, does not fit on \(screen.localizedName) (\(Int(visible.width))×\(Int(visible.height)) points free); use a smaller viewport")
    }
    desktop = CGRect(x: (visible.minX + (visible.width - size.width) / 2).rounded(), y: (primaryHeight - visible.maxY + (visible.height - size.height) / 2).rounded(), width: size.width, height: size.height)

    let configuration = NSWorkspace.OpenConfiguration()
    configuration.arguments = request.app.args ?? []
    configuration.activates = true
    configuration.addsToRecentItems = false
    configuration.promptsUserIfNeeded = false
    let app = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
    running = app
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    // Only a standard window fills the Desktop: an App may show a dialog first, which the Take must not frame.
    var window: AXUIElement?, others = 0
    for _ in 0..<300 {
      let windows = AX.windows(ax)
      window = windows.first { AX.value($0, kAXSubroleAttribute) as? String == kAXStandardWindowSubrole }
      others = windows.count
      if window != nil { break }
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    guard let window else {
      throw Refusal("window", others > 0
        ? "\(name) showed a dialog and no window within 30 s. Open it yourself, answer the dialog, quit it, then record again; an App given a document in args may not be allowed to open it."
        : "\(name) opened no window within 30 s; open it yourself to see why, quit it, then record again.")
    }
    AX.setFrame(window, desktop)
    app.activate()
    try await Task.sleep(nanoseconds: 500_000_000)
    let frame = AX.frame(window) ?? desktop
    return ["app": name, "bundle": bundle?.bundleIdentifier ?? "", "pid": Int(app.processIdentifier), "scale": scale, "display": screen.localizedName,
            "desktop": rect(desktop), "window": rect(frame.offsetBy(dx: -desktop.minX, dy: -desktop.minY))]
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
    guard let app = running else { throw Refusal("capture", "The App is not running") }
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let shared = content.applications.first(where: { $0.processID == app.processIdentifier }) else { throw Refusal("capture", "ScreenCaptureKit does not list the App, which may have quit or hidden its windows; record again") }
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
    tracker = WindowTracker(pid: app.processIdentifier, desktop: desktop)

    let filter = SCContentFilter(display: display, including: [shared], exceptingWindows: [])
    let stream = SCStream(filter: filter, configuration: config, delegate: self)
    try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: frames)
    self.stream = stream
    let first = await withCheckedContinuation { continuation in
      frames.sync { startedAt = continuation }
      Task { do { try await stream.startCapture() } catch { frames.sync { failure = "\(error)"; startedAt?.resume(returning: .nan); startedAt = nil } } }
    }
    if first.isNaN { throw Refusal("capture", failure ?? "Capture did not start") }
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

  /** Finishes the Source at this moment, writes the poster, quits the App and returns the sidecar. */
  @MainActor private func stop() async throws -> [String: Any] {
    let end = CMClockGetTime(CMClockGetHostTimeClock())
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
    let quit = await quitApp()
    return ["duration": (CMTimeGetSeconds(CMTimeSubtract(end, first)) * 1000).rounded() / 1000, "frames": times, "dropped": dropped,
            "size": ["width": Int(desktop.width * scale), "height": Int(desktop.height * scale)], "windows": windows, "quit": quit]
  }

  /**
   * Quits the App this Take started, closing any open menu first; true once it has quit. With `force`,
   * an App that does not quit within 5 s, as one holding a dialog open, is forced to.
   */
  @discardableResult @MainActor private func quitApp(force: Bool = false) async -> Bool {
    guard let app = running, !app.isTerminated else { return true }
    if tracker?.menuOpen() ?? WindowTracker(pid: app.processIdentifier, desktop: desktop).menuOpen() {
      let source = CGEventSource(stateID: .combinedSessionState)
      for down in [true, false] { CGEvent(keyboardEventSource: source, virtualKey: 53, keyDown: down)?.post(tap: .cgSessionEventTap) }
      try? await Task.sleep(nanoseconds: 300_000_000)
    }
    app.terminate()
    for _ in 0..<50 where !app.isTerminated { try? await Task.sleep(nanoseconds: 100_000_000) }
    if force && !app.isTerminated {
      app.forceTerminate()
      for _ in 0..<20 where !app.isTerminated { try? await Task.sleep(nanoseconds: 100_000_000) }
    }
    return app.isTerminated
  }
}

/** A failure the Node CLI shows as it is. */
struct Refusal: Error {
  let code: String, message: String
  init(_ code: String, _ message: String) { self.code = code; self.message = message }
}

private func rect(_ r: CGRect) -> [String: Double] { ["x": Double(r.minX), "y": Double(r.minY), "width": Double(r.width), "height": Double(r.height)] }
