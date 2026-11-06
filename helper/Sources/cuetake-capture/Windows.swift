import ApplicationServices
import CoreGraphics
import CoreVideo
import Foundation

/** One of the App's windows as one frame saw it: its bounds in global points, and whether it showed anything. */
struct Seen: Equatable {
  let id: UInt32
  let layer: Int
  let bounds: CGRect
}

/** A window's identity for what is measured once: the same window at another size is measured again. */
struct WindowAtSize: Hashable {
  let id: UInt32
  let width: Int
  let height: Int
  init(_ seen: Seen) { id = seen.id; width = Int(seen.bounds.width); height = Int(seen.bounds.height) }
}

/**
 * Follows the App's windows on the Desktop, frame by frame: which show, back to front, and where.
 * A window counts once the frame shows something opaque inside it; its visible frame is its bounds, or
 * for a menu or any window above layer 0, what Accessibility finds inside them (AX.visibleFrame); its
 * corner radius is read once from the frame's alpha along its corner diagonals. Runs on the frames
 * queue, except Accessibility reads, which run on their own queue so a busy App cannot stall a frame.
 */
final class WindowTracker {
  private let pid: pid_t
  private let app: AXUIElement
  private let desktop: CGRect
  private let axQueue = DispatchQueue(label: "cuetake.ax")
  private let lock = NSLock()
  /** Each measured window's visible frame relative to its bounds' origin, so a window that moves keeps it. */
  private var visible: [WindowAtSize: CGRect] = [:]
  private var asked: Set<WindowAtSize> = []
  private var radius: [WindowAtSize: Double] = [:]
  private var attempts: [WindowAtSize: Int] = [:]
  private var states: [(t: Double, seen: [Seen])] = []
  private var everShown: Set<UInt32> = []

  init(pid: pid_t, desktop: CGRect) {
    self.pid = pid
    self.desktop = desktop
    app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.25)
  }

  /** The App's on-screen windows, back to front. */
  func windows() -> [Seen] {
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    return list.compactMap { info -> Seen? in
      guard (info[kCGWindowOwnerPID as String] as? Int32) == pid, (info[kCGWindowAlpha as String] as? Double ?? 1) > 0,
            let b = info[kCGWindowBounds as String] as? [String: CGFloat], let id = info[kCGWindowNumber as String] as? UInt32 else { return nil }
      let bounds = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
      return bounds.width > 0 && bounds.height > 0 ? Seen(id: id, layer: info[kCGWindowLayer as String] as? Int ?? 0, bounds: bounds) : nil
    }.reversed()
  }

  /** Notes the windows a frame shows at `t` seconds; `pixels` is that frame, BGRA, `scale` pixels per point. */
  func sample(t: Double, pixels: CVPixelBuffer, scale: Double) {
    CVPixelBufferLockBaseAddress(pixels, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
    let image = Alpha(pixels, desktop: desktop, scale: scale)
    // A window seen before stays listed once it lies wholly off the Desktop, where its pixels cannot be
    // read, so a first window that leaves is still noted, and warned about.
    let shown = windows().filter { image.showsAnything(in: $0.bounds) || (everShown.contains($0.id) && !$0.bounds.intersects(desktop)) }
    everShown.formUnion(shown.map(\.id))
    if states.last?.seen != shown { states.append((t, shown)) }
    for window in shown {
      let sized = WindowAtSize(window)
      if window.layer != 0 { measureVisibleFrame(sized, window.bounds) }
      lock.lock(); let known = radius[sized] != nil, frame = visibleFrame(window); lock.unlock()
      guard !known, let frame else { continue }
      let tries = (attempts[sized] ?? 0) + 1
      attempts[sized] = tries
      // A window fading in has no opaque corner yet; one that never has any is drawn square.
      if let found = image.cornerRadius(of: frame) ?? (tries > 120 ? 0 : nil) { lock.lock(); radius[sized] = found; lock.unlock() }
    }
  }

  private func measureVisibleFrame(_ sized: WindowAtSize, _ bounds: CGRect) {
    lock.lock(); let ask = !asked.contains(sized); asked.insert(sized); lock.unlock()
    guard ask else { return }
    axQueue.async { [self] in
      let frame = (AX.visibleFrame(app, within: bounds) ?? bounds).offsetBy(dx: -bounds.minX, dy: -bounds.minY)
      lock.lock(); visible[sized] = frame; lock.unlock()
    }
  }

  /**
   * The windows over time in Desktop points, back to front: each state from its `t` until the next,
   * every window with its frame, layer and corner radius. Consecutive states that come out the same are one.
   */
  func track() -> [[String: Any]] {
    axQueue.sync {}
    lock.lock(); defer { lock.unlock() }
    var out: [[String: Any]] = [], last: [[String: Any]]? = nil
    for state in states {
      let shown = state.seen.map { window -> [String: Any] in
        let sized = WindowAtSize(window), frame = visibleFrame(window) ?? window.bounds
        return ["id": Int(window.id), "layer": window.layer, "x": half(frame.minX - desktop.minX), "y": half(frame.minY - desktop.minY),
                "width": half(frame.width), "height": half(frame.height), "radius": half(radius[sized] ?? 0)]
      }
      if let last, NSArray(array: last).isEqual(to: shown) { continue }
      out.append(["t": (state.t * 1000).rounded() / 1000, "shown": shown])
      last = shown
    }
    return out
  }

  /** Where `window` shows in global points: its bounds, or above layer 0 its measured visible frame, nil until measured. Call under the lock. */
  private func visibleFrame(_ window: Seen) -> CGRect? {
    window.layer == 0 ? window.bounds : visible[WindowAtSize(window)]?.offsetBy(dx: window.bounds.minX, dy: window.bounds.minY)
  }

  /** Whether one of the App's menus is open, which holds its event loop until Escape closes it. */
  func menuOpen() -> Bool { windows().contains { $0.layer >= Int(CGWindowLevelForKey(.popUpMenuWindow)) } }
}

private func half(_ value: CGFloat) -> Double { (Double(value) * 2).rounded() / 2 }

/** The alpha of a BGRA frame of the Desktop, read in global points. */
struct Alpha {
  let base: UnsafePointer<UInt8>
  let row: Int, width: Int, height: Int
  let desktop: CGRect
  let scale: Double

  init(_ pixels: CVPixelBuffer, desktop: CGRect, scale: Double) {
    base = UnsafePointer(CVPixelBufferGetBaseAddress(pixels)!.assumingMemoryBound(to: UInt8.self))
    row = CVPixelBufferGetBytesPerRow(pixels)
    width = CVPixelBufferGetWidth(pixels)
    height = CVPixelBufferGetHeight(pixels)
    self.desktop = desktop
    self.scale = scale
  }

  /** The pixel holding global point (x, y), or nil outside the frame. */
  private func pixel(_ x: CGFloat, _ y: CGFloat) -> (Int, Int)? {
    let px = Int(((Double(x) - Double(desktop.minX)) * scale).rounded(.down)), py = Int(((Double(y) - Double(desktop.minY)) * scale).rounded(.down))
    return px >= 0 && py >= 0 && px < width && py < height ? (px, py) : nil
  }

  private func alpha(_ px: Int, _ py: Int) -> UInt8 { base[py * row + px * 4 + 3] }

  /** Whether anything opaque shows across the middle of `bounds`, inside the Desktop. */
  func showsAnything(in bounds: CGRect) -> Bool {
    let steps = max(2, Int(max(bounds.width, bounds.height) * CGFloat(scale)))
    for i in 0...steps {
      let k = CGFloat(i) / CGFloat(steps)
      for point in [CGPoint(x: bounds.minX + k * bounds.width, y: bounds.midY), CGPoint(x: bounds.midX, y: bounds.minY + k * bounds.height)] {
        if let (px, py) = pixel(point.x, point.y), alpha(px, py) > 127 { return true }
      }
    }
    return false
  }

  /**
   * The corner radius of `frame` in points: along each corner's diagonal inside the Desktop, the first
   * opaque pixel lies r × (1 − 1/√2) in from a corner of radius r. The largest corner wins: where
   * another of the App's windows lies under a corner, the frame is opaque there and reads 0, and Render
   * draws that window under it anyway. Nil while no corner has an opaque pixel yet.
   */
  func cornerRadius(of frame: CGRect) -> Double? {
    let limit = Int(48 * scale)
    var found: Double? = nil
    for (cx, cy, dx, dy) in [(frame.minX, frame.minY, 1.0, 1.0), (frame.maxX, frame.minY, -1.0, 1.0), (frame.minX, frame.maxY, 1.0, -1.0), (frame.maxX, frame.maxY, -1.0, -1.0)] {
      guard let (x0, y0) = pixel(cx + (dx < 0 ? -0.01 : 0), cy + (dy < 0 ? -0.01 : 0)) else { continue }
      for d in 0..<min(limit, Int(min(frame.width, frame.height) * CGFloat(scale)) / 2) {
        let x = x0 + Int(dx) * d, y = y0 + Int(dy) * d
        guard x >= 0, y >= 0, x < width, y < height else { break }
        if alpha(x, y) > 127 { found = max(found ?? 0, Double(d) / (1 - 1 / 2.0.squareRoot()) / scale); break }
      }
    }
    return found
  }
}
