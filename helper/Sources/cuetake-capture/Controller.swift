import AppKit
import ApplicationServices
import CoreGraphics

/**
 * What the Director asks of the App during a Take (app-locators.js, app-director.js): Accessibility reads
 * by role and identifier, and real input, the pointer moved and pressed and keys posted as a person's
 * would be. Positions are Desktop points; elements are numbered refs the Node side passes back.
 */
@MainActor final class Controller {
  private let app: NSRunningApplication
  private let ax: AXUIElement
  private let desktop: CGRect
  private let source = CGEventSource(stateID: .hidSystemState)
  /** Elements by ref, from the latest `windows` on; `byHash` finds an element's ref again, so it has one ref. */
  private var elements: [Int: AXUIElement] = [:]
  private var byHash: [CFHashCode: [Int]] = [:]
  private var held: CGMouseButton?

  init(app: NSRunningApplication, desktop: CGRect) {
    self.app = app
    self.desktop = desktop
    ax = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(ax, 2)
  }

  /** Answers one request: its reply, or throws a Refusal whose message the Scenario sees. */
  func handle(_ message: [String: Any]) throws -> Any {
    if message["windows"] != nil {
      // Each locator resolves from the windows down, so refs from earlier resolutions are no longer needed.
      elements.removeAll()
      byHash.removeAll()
      let focused = focusedWindow()
      return AX.windows(ax).map { summary($0, focused: focused) }
    }
    if let find = message["find"] as? [String: Any] { return try self.find(find) }
    if let read = message["read"] as? [String: Any] { return try self.read(element(read["ref"])) }
    if message["focused"] != nil {
      guard let focused = AX.value(ax, kAXFocusedUIElementAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID() else { return ["role": NSNull(), "subrole": NSNull()] }
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

  private func focusedWindow() -> AXUIElement? {
    guard let window = AX.value(ax, kAXFocusedWindowAttribute), CFGetTypeID(window) == AXUIElementGetTypeID() else { return nil }
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

  private func summary(_ element: AXUIElement, focused: AXUIElement? = nil) -> [String: Any] {
    var out: [String: Any] = [
      "ref": ref(element), "role": AX.role(element) ?? "", "subrole": orNull(AX.value(element, kAXSubroleAttribute) as? String),
      "title": title(element), "description": AX.value(element, kAXDescriptionAttribute) as? String ?? "",
      "label": label(element), "identifier": AX.value(element, kAXIdentifierAttribute) as? String ?? "", "frame": frame(element),
    ]
    if let focused { out["focused"] = CFEqual(focused, element) }
    return out
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

  /** Whose window lies over `point`: the App's, another app's, or nobody's. */
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
    if pid == app.processIdentifier { return .app }
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
    if press != nil { event.setIntegerValueField(.mouseEventClickState, value: 1) }
    event.post(tap: .cghidEventTap)
  }

  /** Keys go to the App in front; refused when another app is in front, so they never reach it. */
  private func inFront() throws {
    let front = NSWorkspace.shared.frontmostApplication
    guard front?.processIdentifier == app.processIdentifier else {
      throw Refusal("input", "\(front?.localizedName ?? "Another app") is in front, not \(app.localizedName ?? "the App"), so keys would reach it; click into the App first, and leave the Mac alone during the Take")
    }
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
