import AppKit
import ApplicationServices
import CoreMedia

/**
 * What the helper observes during a Take besides the frames (ADR 0009), from `begin` to `end`:
 * - the system cursor's shape, polled at the capture rate (CursorShapes);
 * - each element the App focuses, through an AXObserver, as a focus target for the camera;
 * - the frames of the elements masks follow, read at the capture rate;
 * - input the Director did not make, through a listen-only event tap that tells events apart by the
 *   process that posted them. That input never enters the Timeline; `verify` warns about it.
 * Times are seconds from the first frame, on the host clock the frames use; positions are Desktop points.
 */
final class Observer {
  /** The elements a Mask follows, each with its last frame, and which `watch` call gave them. */
  private struct Watch { let generation: Int; let elements: [(element: AXUIElement, last: CGRect?)] }

  private let pid: pid_t
  private let app: AXUIElement
  private let desktop: CGRect
  private let fps: Int
  private let lock = NSLock()
  private let queue = DispatchQueue(label: "cuetake.observe")
  private let shapes = CursorShapes()
  // Read and written under the lock.
  private var zero = Double.nan
  private var pointer: CGPoint
  private var previous: CGPoint
  private var shapeLog: [[Any]] = []
  private var focusLog: [[String: Any]] = []
  private var watching: [Int: Watch] = [:]
  private var generation = 0
  private var boxLog: [Int: [[Any]]] = [:]
  private var lastBoxes: [Int: [[Double]]] = [:]
  private var otherLog: [[Any]] = []
  private var lastOther: [String: Double] = [:]
  private var timer: DispatchSourceTimer?
  private var observer: AXObserver?
  private var tap: CFMachPort?
  private var tapLoop: CFRunLoop?

  init(pid: pid_t, desktop: CGRect, fps: Int) {
    self.pid = pid
    self.desktop = desktop
    self.fps = fps
    app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.25)
    pointer = desktop.origin
    previous = desktop.origin
  }

  private static func now() -> Double { CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock())) }
  /** Seconds since the first frame, to the millisecond, or nil before `begin` or after `end`. Call under the lock. */
  private func elapsed() -> Double? { zero.isNaN ? nil : ((Observer.now() - zero) * 1000).rounded() / 1000 }

  /** Starts observing; `zero` is the first frame's host time in seconds. Throws when the event tap cannot be made. */
  @MainActor func begin(zero: Double) throws {
    try startTap()
    lock.lock(); self.zero = zero; lock.unlock()
    var created: AXObserver?
    if AXObserverCreate(pid, { _, element, _, refcon in
      Unmanaged<Observer>.fromOpaque(refcon!).takeUnretainedValue().focused(element)
    }, &created) == .success, let created {
      AXObserverAddNotification(created, app, kAXFocusedUIElementChangedNotification as CFString, Unmanaged.passUnretained(self).toOpaque())
      CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .defaultMode)
      observer = created
    }
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: 1.0 / Double(fps), leeway: .milliseconds(2))
    timer.setEventHandler { [weak self] in self?.sample() }
    timer.resume()
    self.timer = timer
  }

  /** Stops observing and returns what was seen. */
  @MainActor func end() -> [String: Any] {
    timer?.cancel()
    queue.sync {}
    if let observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode) }
    if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
    lock.lock(); defer { lock.unlock() }
    if let tapLoop { CFRunLoopStop(tapLoop) }
    zero = .nan
    return ["shapes": shapeLog, "focused": focusLog, "otherInput": otherLog,
            "watched": boxLog.keys.sorted().map { ["id": $0, "boxes": boxLog[$0]!] }]
  }

  /** Where the Director put the pointer, in global points: the AX fallback for the shape looks there, not where a person may have moved it. */
  func pointerMoved(to point: CGPoint) { lock.lock(); previous = pointer; pointer = point; lock.unlock() }

  /** Follows `elements` as the boxes of the masked element `id`, in place of what it followed before. */
  func watch(_ id: Int, _ elements: [AXUIElement]) {
    elements.forEach { AXUIElementSetMessagingTimeout($0, 0.25) }
    lock.lock(); generation += 1; watching[id] = Watch(generation: generation, elements: elements.map { ($0, nil) }); if boxLog[id] == nil { boxLog[id] = [] }; lock.unlock()
  }

  // MARK: Sampling, on the observe queue

  private func sample() {
    // The moment of this sample, before the reads, any of which may wait on a busy App.
    lock.lock(); let at = pointer, before = previous, watched = watching, moment = elapsed(); lock.unlock()
    guard let t = moment else { return }
    // The system cursor shows what lies under the real pointer, so it stands for the Cursor only while the real pointer
    // is where the Director put it (or still on its way there); once a person moved it away, infer what lies under the Director's.
    let real = CGEvent(source: nil)?.location
    let directed = real.map { real in [at, before].contains { hypot($0.x - real.x, $0.y - real.y) <= 1 } } ?? false
    let shape = (directed ? shapes.current() : nil) ?? CursorShapes.inferred(at: at)
    var read: [Int: Watch] = [:], boxes: [Int: [[Double]]] = [:]
    for (id, watch) in watched {
      // An element the App removed keeps its last frame until the Director resolves the locator again, so a Mask never lets go early.
      let elements = watch.elements.map { ($0.element, AX.frame($0.element) ?? $0.last) }
      read[id] = Watch(generation: watch.generation, elements: elements)
      boxes[id] = elements.compactMap { $0.1 }.filter { $0.width > 0 && $0.height > 0 }.map { inDesktop($0) }
    }
    lock.lock(); defer { lock.unlock() }
    guard !zero.isNaN else { return }
    if shapeLog.last?[1] as? String != shape { shapeLog.append([shapeLog.isEmpty ? 0 : t, shape]) }
    for (id, found) in boxes {
      // Elements the Director replaced while they were read are not logged: the next sample reads what replaced them.
      guard watching[id]?.generation == read[id]?.generation else { continue }
      watching[id] = read[id]
      if lastBoxes[id] == found, boxLog[id]?.isEmpty == false { continue }
      lastBoxes[id] = found
      boxLog[id, default: []].append([t] + found.map { $0 as Any })
    }
  }

  private func inDesktop(_ frame: CGRect) -> [Double] {
    [half(frame.minX - desktop.minX), half(frame.minY - desktop.minY), half(frame.width), half(frame.height)]
  }

  // MARK: Focus, on the main thread

  private func focused(_ element: AXUIElement) {
    guard let frame = AX.frame(element), frame.width > 0, frame.height > 0, frame.intersects(desktop) else { return }
    let r = inDesktop(frame), box: [String: Double] = ["x": r[0], "y": r[1], "width": r[2], "height": r[3]]
    let role = AX.role(element) ?? ""
    lock.lock(); defer { lock.unlock() }
    guard let t = elapsed() else { return }
    if let last = focusLog.last, last["box"] as? [String: Double] == box, last["role"] as? String == role { return }
    focusLog.append(["t": t, "box": box, "role": role])
  }

  // MARK: Other input, on the tap's own thread

  private static let watchedTypes: [CGEventType] = [.mouseMoved, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp,
                                                   .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel, .keyDown, .keyUp, .flagsChanged]

  private func startTap() throws {
    let mask = Observer.watchedTypes.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
    guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: { _, type, event, refcon in
      Unmanaged<Observer>.fromOpaque(refcon!).takeUnretainedValue().saw(type, event)
      return Unmanaged.passUnretained(event)
    }, userInfo: Unmanaged.passUnretained(self).toOpaque()) else {
      throw Refusal("input-monitoring", "macOS refused to let CueTake watch for input it did not make; the app CueTake runs in needs the Input Monitoring grant, which cuetake doctor names")
    }
    self.tap = tap
    let started = DispatchSemaphore(value: 0)
    let thread = Thread { [self] in
      CFRunLoopAddSource(CFRunLoopGetCurrent(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
      CGEvent.tapEnable(tap: tap, enable: true)
      lock.lock(); tapLoop = CFRunLoopGetCurrent(); lock.unlock()
      started.signal()
      CFRunLoopRun()
    }
    thread.name = "cuetake.tap"
    thread.start()
    started.wait()
  }

  /** Notes input another process posted, or a person made (process 0), once per kind every half second. */
  private func saw(_ type: CGEventType, _ event: CGEvent) {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { if let tap { CGEvent.tapEnable(tap: tap, enable: true) }; return }
    guard event.getIntegerValueField(.eventSourceUnixProcessID) != Int64(getpid()) else { return }
    let kind = [.keyDown, .keyUp, .flagsChanged].contains(type) ? "key" : type == .scrollWheel ? "scroll" : "pointer"
    lock.lock(); defer { lock.unlock() }
    guard let t = elapsed() else { return }
    if let last = lastOther[kind], t - last < 0.5 { return }
    lastOther[kind] = t
    otherLog.append([t, kind])
  }
}

/**
 * The system cursor's shape as the CSS keyword the page probe records. `NSCursor.currentSystem` is
 * deprecated and may return nil in a future macOS, so an unknown or missing cursor falls back to the
 * Accessibility role under the pointer.
 */
final class CursorShapes {
  private struct Known { let signature: String; let pixels: Data?; let name: String }
  private let known: [Known]

  init() {
    let standard: [(NSCursor, String)] = [
      (.arrow, "default"), (.iBeam, "text"), (.iBeamCursorForVerticalLayout, "vertical-text"), (.pointingHand, "pointer"),
      (.openHand, "grab"), (.closedHand, "grabbing"), (.crosshair, "crosshair"), (.operationNotAllowed, "not-allowed"),
      (.resizeLeftRight, "ew-resize"), (.resizeLeft, "w-resize"), (.resizeRight, "e-resize"),
      (.resizeUpDown, "ns-resize"), (.resizeUp, "n-resize"), (.resizeDown, "s-resize"),
      (.dragCopy, "copy"), (.dragLink, "alias"), (.contextualMenu, "context-menu"), (.disappearingItem, "no-drop"),
    ]
    known = standard.map { Known(signature: CursorShapes.signature($0.0), pixels: CursorShapes.pixels($0.0), name: $0.1) }
  }

  /** A cheap key: the hotspot and the size of each of the image's representations. */
  private static func signature(_ cursor: NSCursor) -> String {
    "\(cursor.hotSpot.x),\(cursor.hotSpot.y) " + cursor.image.representations.map { "\($0.pixelsWide)x\($0.pixelsHigh)" }.joined(separator: " ")
  }

  /** The smallest representation's pixels, to tell apart cursors with the same signature, such as the arrow and the copy arrow. */
  private static func pixels(_ cursor: NSCursor) -> Data? {
    cursor.image.representations.min { $0.pixelsWide < $1.pixelsWide }.flatMap { ($0 as? NSBitmapImageRep)?.tiffRepresentation }
  }

  /** The shape of the system cursor now, or nil when macOS gives none or one that is not standard. */
  func current() -> String? {
    guard let cursor = NSCursor.currentSystem else { return nil }
    let candidates = known.filter { $0.signature == CursorShapes.signature(cursor) }
    guard let first = candidates.first else { return nil }
    if candidates.allSatisfy({ $0.name == first.name }) { return first.name }
    guard let seen = CursorShapes.pixels(cursor) else { return nil }
    return candidates.first { $0.pixels == seen }?.name
  }

  private static let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]
  // A hung App answers no sooner than this, so it cannot stall the sampler, and with it the Masks.
  private static let systemWide: AXUIElement = { let element = AXUIElementCreateSystemWide(); AXUIElementSetMessagingTimeout(element, 0.1); return element }()

  /** The shape the element under `point` (global points) suggests: text for a text field or area, pointer for a link, else default. */
  static func inferred(at point: CGPoint) -> String {
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(systemWide, Float(point.x), Float(point.y), &hit) == .success, let hit else { return "default" }
    AXUIElementSetMessagingTimeout(hit, 0.1)
    let role = AX.role(hit) ?? "", subrole = AX.value(hit, kAXSubroleAttribute) as? String ?? ""
    if textRoles.contains(role) || textRoles.contains(subrole) { return "text" }
    return role == "AXLink" ? "pointer" : "default"
  }
}

private func half(_ value: CGFloat) -> Double { (Double(value) * 2).rounded() / 2 }
