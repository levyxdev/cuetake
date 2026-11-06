import AppKit
import ApplicationServices
import CoreGraphics

/**
 * What the Director asks of the Take's Apps (app-locators.js, app-director.js): Accessibility reads by
 * role and identifier, and real input, the pointer moved and pressed and keys posted as a person's
 * would be, and the elements a Mask follows, handed to the Observer; and for `prepare`, windows moved and
 * sized. Positions are Desktop points; elements are numbered refs the Node side passes back, whichever
 * App they belong to; Apps are numbered in the Take's order.
 */
@MainActor final class Controller {
  private let apps: [NSRunningApplication]
  private let ax: [AXUIElement]
  private let pids: Set<pid_t>
  private let desktop: CGRect
  private let source = CGEventSource(stateID: .hidSystemState)
  /** Elements by ref, for the whole Take; `byHash` finds an element's ref again, so it has one ref. */
  private var elements: [Int: AXUIElement] = [:]
  private var byHash: [CFHashCode: [Int]] = [:]
  private var held: CGMouseButton?
  private let observer: Observer

  init(apps: [NSRunningApplication], desktop: CGRect, observer: Observer) {
    self.apps = apps
    self.desktop = desktop
    self.observer = observer
    pids = Set(apps.map(\.processIdentifier))
    ax = apps.map { app in
      let element = AXUIElementCreateApplication(app.processIdentifier)
      AXUIElementSetMessagingTimeout(element, 2)
      return element
    }
  }

  /** The App of the Take in front, by its index, or nil when another app is. */
  private func front() -> Int? {
    let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier
    return apps.firstIndex { $0.processIdentifier == pid }
  }

  /** Answers one request: its reply, or throws a Refusal whose message the Scenario sees. */
  func handle(_ message: [String: Any]) throws -> Any {
    if message["windows"] != nil {
      // Refs stay valid across resolutions: a Mask resolves its locator again while the Director resolves another.
      let inFront = front()
      return ax.enumerated().flatMap { i, app -> [[String: Any]] in
        let main = window(app, kAXMainWindowAttribute), focused = window(app, kAXFocusedWindowAttribute)
        return AX.windows(app).map { window in
          let isFocused = focused.map { CFEqual($0, window) } ?? false
          return summary(window).merging(["app": i, "main": main.map { CFEqual($0, window) } ?? isFocused, "focused": isFocused && inFront == i]) { a, _ in a }
        }
      }
    }
    if let set = message["setFrame"] as? [String: Any] {
      let box = CGRect(x: set["x"] as? Double ?? 0, y: set["y"] as? Double ?? 0, width: set["width"] as? Double ?? 0, height: set["height"] as? Double ?? 0)
      AX.setFrame(try element(set["ref"]), box.offsetBy(dx: desktop.minX, dy: desktop.minY))
      return [:]
    }
    if let bar = message["titleBar"] as? [String: Any] { return titleBar(try element(bar["ref"])) }
    if let find = message["find"] as? [String: Any] { return try self.find(find) }
    if let read = message["read"] as? [String: Any] { return try self.read(element(read["ref"])) }
    if message["focused"] != nil {
      guard let i = front(), let focused = AX.value(ax[i], kAXFocusedUIElementAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID() else { return ["role": NSNull(), "subrole": NSNull()] }
      let element = focused as! AXUIElement
      return ["role": orNull(AX.role(element)), "subrole": orNull(AX.value(element, kAXSubroleAttribute) as? String)]
    }
    if let move = message["move"] as? [String: Any] { try pointer(move, type: nil); return [:] }
    if let down = message["down"] as? [String: Any] {
      switch owner(at: global(down)) {
      case .app: try pointer(down, type: .down); return [:]
      case .other(let name): return ["covered": name]
      case .nothing: return ["nothing": true]
      }
    }
    if let up = message["up"] as? [String: Any] { try pointer(up, type: .up); return [:] }
    if let watch = message["watch"] as? [String: Any], let id = watch["id"] as? Int {
      observer.watch(id, try (watch["refs"] as? [Any] ?? []).map { try element($0) })
      return [:]
    }
    if let key = message["key"] as? [String: Any] { try self.key(key); return [:] }
    if let text = message["text"] as? String { try type(text); return [:] }
    throw Refusal("request", "cuetake-capture does not know the request \(message.keys.sorted())")
  }

  // MARK: Accessibility

  private func ref(_ element: AXUIElement) -> Int {
    let hash = CFHash(element)
    if let known = byHash[hash]?.first(where: { CFEqual(elements[$0], element) }) { return known }
    let ref = elements.count + 1
    elements[ref] = element
    byHash[hash, default: []].append(ref)
    return ref
  }

  private func element(_ ref: Any?) throws -> AXUIElement {
    guard let ref = ref as? Int, let element = elements[ref] else { throw Refusal("request", "No element \(String(describing: ref)); resolve the locator again") }
    return element
  }

  /** The App's main or focused window, as `attribute` names it. */
  private func window(_ app: AXUIElement, _ attribute: String) -> AXUIElement? {
    guard let window = AX.value(app, attribute), CFGetTypeID(window) == AXUIElementGetTypeID() else { return nil }
    return (window as! AXUIElement)
  }

  /** The text of the element that labels `element`, as for a text field beside its label. */
  private func label(_ element: AXUIElement) -> String {
    guard let title = AX.value(element, kAXTitleUIElementAttribute), CFGetTypeID(title) == AXUIElementGetTypeID() else { return "" }
    let labelling = title as! AXUIElement
    return AX.value(labelling, kAXValueAttribute) as? String ?? AX.value(labelling, kAXTitleAttribute) as? String ?? ""
  }

  private func frame(_ element: AXUIElement) -> [String: Double] {
    let f = AX.frame(element) ?? .zero
    return ["x": Double(f.minX - desktop.minX), "y": Double(f.minY - desktop.minY), "width": Double(f.width), "height": Double(f.height)]
  }

  /** The element's title, or a static text's value, which is its text. */
  private func title(_ element: AXUIElement) -> String {
    if let title = AX.value(element, kAXTitleAttribute) as? String, !title.isEmpty { return title }
    return AX.role(element) == "AXStaticText" ? AX.value(element, kAXValueAttribute) as? String ?? "" : ""
  }

  private func summary(_ element: AXUIElement) -> [String: Any] {
    [
      "ref": ref(element), "role": AX.role(element) ?? "", "subrole": orNull(AX.value(element, kAXSubroleAttribute) as? String),
      "title": title(element), "description": AX.value(element, kAXDescriptionAttribute) as? String ?? "",
      "label": label(element), "identifier": AX.value(element, kAXIdentifierAttribute) as? String ?? "", "frame": frame(element),
    ]
  }

  // What an empty part of a title bar answers to a hit test: the window itself, or a unified toolbar between its items.
  private static let emptyRoles: Set<String> = ["AXWindow", "AXToolbar"]

  /** Where a static text's characters lie, in global points, as the text a title takes may be far wider than its title. */
  private func glyphs(_ text: AXUIElement) -> CGRect? {
    let count = (AX.value(text, kAXNumberOfCharactersAttribute) as? Int) ?? (AX.value(text, kAXValueAttribute) as? String)?.utf16.count ?? 0
    var range = CFRange(location: 0, length: count), bounds: CFTypeRef?, rect = CGRect.zero
    guard count > 0, AXUIElementCopyParameterizedAttributeValue(text, kAXBoundsForRangeParameterizedAttribute as CFString, AXValueCreate(.cfRange, &range)!, &bounds) == .success,
          let bounds, CFGetTypeID(bounds) == AXValueGetTypeID(), AXValueGetValue(bounds as! AXValue, .cgRect, &rect) else { return nil }
    return rect
  }

  /**
   * The window's title bar sampled along its middle (the close button's, or 14 points down), every 4
   * points of it on the Desktop: `empty` where the topmost element there, whoever owns it, is the window
   * itself or its toolbar, or a static text of the window away from its characters (8 points before them,
   * 20 after, past a title's menu arrow), so no control, no title and no other window lies there. Null
   * without a frame.
   */
  private func titleBar(_ window: AXUIElement) -> Any {
    guard let frame = AX.frame(window) else { return NSNull() }
    var pid: pid_t = 0
    AXUIElementGetPid(window, &pid)
    let close = AX.value(window, kAXCloseButtonAttribute).flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? AX.frame($0 as! AXUIElement) : nil }
    let y = close?.midY ?? frame.minY + 14
    let systemWide = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(systemWide, 0.25)
    var samples: [[Any]] = [], texts: [(element: AXUIElement, glyphs: CGRect?)] = []
    for x in stride(from: max(frame.minX, desktop.minX) + 2, to: min(frame.maxX, desktop.maxX) - 2, by: 4) where y >= desktop.minY && y < desktop.maxY {
      var hit: AXUIElement?, owner: pid_t = 0
      var empty = false
      if AXUIElementCopyElementAtPosition(systemWide, Float(x), Float(y), &hit) == .success, let hit {
        AXUIElementGetPid(hit, &owner)
        let role = AX.role(hit) ?? "", hitWindow = role == "AXWindow" ? hit : AX.value(hit, kAXWindowAttribute).flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
        if owner == pid, hitWindow.map({ CFEqual($0, window) }) == true {
          if Controller.emptyRoles.contains(role) { empty = true }
          else if role == "AXStaticText" {
            if !texts.contains(where: { CFEqual($0.element, hit) }) { texts.append((hit, glyphs(hit))) }
            if let drawn = texts.first(where: { CFEqual($0.element, hit) })?.glyphs { empty = x < drawn.minX - 8 || x > drawn.maxX + 20 }
          }
        }
      }
      samples.append([Double(x - desktop.minX), empty])
    }
    return ["y": Double(y - desktop.minY), "samples": samples]
  }

  /** The descendants of `within` with one of `roles` and that `identifier`, depth first. */
  private func find(_ query: [String: Any]) throws -> [[String: Any]] {
    let root = try element(query["within"])
    let roles = (query["roles"] as? [[String: Any]])?.map { ($0["role"] as? String ?? "", $0["subrole"] as? String) }
    let identifier = query["identifier"] as? String
    var found: [[String: Any]] = []
    AX.walk(root) { element, role, subrole in
      if let roles, !roles.contains(where: { $0.0 == role && ($0.1 == nil || $0.1 == subrole) }) { return }
      if let identifier, AX.value(element, kAXIdentifierAttribute) as? String != identifier { return }
      found.append(summary(element))
    }
    return found
  }

  /** The element's value as JSON takes it, its text and its frame. */
  private func read(_ element: AXUIElement) throws -> [String: Any] {
    let value = AX.value(element, kAXValueAttribute)
    let json: Any = (value as? String) ?? (value as? NSNumber) ?? NSNull()
    var text = value as? String ?? ""
    if text.isEmpty {
      var parts: [String] = []
      AX.walk(element) { child, role, _ in
        if ["AXStaticText", "AXTextField", "AXTextArea"].contains(role), let part = AX.value(child, kAXValueAttribute) as? String, !part.isEmpty { parts.append(part) }
      }
      text = parts.joined(separator: "\n")
    }
    return ["value": json, "text": text, "frame": frame(element)]
  }

  // MARK: Input

  private func global(_ point: [String: Any]) -> CGPoint {
    CGPoint(x: desktop.minX + CGFloat(point["x"] as? Double ?? 0), y: desktop.minY + CGFloat(point["y"] as? Double ?? 0))
  }

  private enum Owner { case app, other(String), nothing }

  /** Whose window lies over `point`: an App of the Take's, another app's, or nobody's. */
  private func owner(at point: CGPoint) -> Owner {
    var hit: AXUIElement?, pid: pid_t = 0
    if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit) == .success, let hit {
      AXUIElementGetPid(hit, &pid)
    } else {
      // Where Accessibility finds nothing, the frontmost window there tells whose it is.
      let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
      let window = list.first { info in
        guard let b = info[kCGWindowBounds as String] as? [String: CGFloat], (info[kCGWindowLayer as String] as? Int ?? 0) < Int(CGWindowLevelForKey(.mainMenuWindow)) else { return false }
        return CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0).contains(point)
      }
      guard let owner = window?[kCGWindowOwnerPID as String] as? Int32 else { return .nothing }
      pid = owner
    }
    if pids.contains(pid) { return .app }
    return .other(NSRunningApplication(processIdentifier: pid)?.localizedName ?? "process \(pid)")
  }

  private enum Press { case down, up }

  /** Moves the pointer, dragging while a button is held, or presses or releases a button there. */
  private func pointer(_ message: [String: Any], type press: Press?) throws {
    let at = global(message), button: CGMouseButton = (message["button"] as? String) == "right" ? .right : .left
    let type: CGEventType
    switch press {
    case .down: type = button == .right ? .rightMouseDown : .leftMouseDown; held = button
    case .up: type = button == .right ? .rightMouseUp : .leftMouseUp; held = nil
    case nil: type = held == .right ? .rightMouseDragged : held == .left ? .leftMouseDragged : .mouseMoved
    }
    guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: at, mouseButton: press == nil ? (held ?? .left) : button) else { throw Refusal("input", "macOS refused to make a pointer event") }
    observer.pointerMoved(to: at)
    if press != nil { event.setIntegerValueField(.mouseEventClickState, value: 1) }
    event.post(tap: .cghidEventTap)
  }

  /** Keys go to the App in front; refused when an app outside the Take is in front, so they never reach it. */
  private func inFront() throws {
    guard front() == nil else { return }
    let other = NSWorkspace.shared.frontmostApplication?.localizedName ?? "Another app"
    let names = apps.compactMap(\.localizedName).joined(separator: " or ")
    throw Refusal("input", "\(other) is in front, not \(names.isEmpty ? "an App of the Take" : names), so keys would reach it; click into the App first, and leave the Mac alone during the Take")
  }

  private static let modifiers: [String: (code: CGKeyCode, flag: CGEventFlags)] = [
    "control": (59, .maskControl), "option": (58, .maskAlternate), "shift": (56, .maskShift), "command": (55, .maskCommand),
  ]

  /** Presses (`down`) or releases a key, pressing its modifiers before it and releasing them after. */
  private func key(_ message: [String: Any]) throws {
    try inFront()
    let code = CGKeyCode(message["keyCode"] as? Int ?? 0), down = message["down"] as? Bool ?? true
    let names = (message["modifiers"] as? [String] ?? []).compactMap { Controller.modifiers[$0] }
    var flags = CGEventFlags()
    func post(_ key: CGKeyCode, _ isDown: Bool) {
      let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: isDown)
      event?.flags = flags
      event?.post(tap: .cghidEventTap)
    }
    if down {
      for modifier in names { flags.insert(modifier.flag); post(modifier.code, true) }
      post(code, true)
    } else {
      names.forEach { flags.insert($0.flag) }
      post(code, false)
      for modifier in names.reversed() { flags.remove(modifier.flag); post(modifier.code, false) }
    }
  }

  /** Types `text` as the keyboard would, whatever the layout. */
  private func type(_ text: String) throws {
    try inFront()
    let units = Array(text.utf16)
    for isDown in [true, false] {
      guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: isDown) else { throw Refusal("input", "macOS refused to make a key event") }
      event.flags = []
      event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
      event.post(tap: .cghidEventTap)
    }
  }
}
