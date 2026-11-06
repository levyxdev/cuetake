import AppKit
import ApplicationServices

/**
 * `cuetake-capture tree <app>`: prints the Accessibility tree of a running App, found by bundle id, name
 * or .app path, as one JSON object: `{ app, bundle, windows, truncated }`, each element `{ role, subrole, title, description,
 * label, identifier, value, frame, children }`, frames in global points. It only reads, so it may look at
 * an App the user started; the agent uses it to find locators while writing a Scenario.
 */
@MainActor func printTree(_ name: String) -> Never {
  guard AXIsProcessTrusted() else { fail("accessibility", "The app CueTake runs in has no Accessibility grant; run cuetake doctor, which names it") }
  let path = URL(fileURLWithPath: name).standardizedFileURL.path
  guard let app = NSWorkspace.shared.runningApplications.first(where: {
    !$0.isTerminated && ($0.bundleIdentifier == name || $0.localizedName == name || $0.bundleURL?.standardizedFileURL.path == path)
  }) else { fail("app", "No running App is \(name); start it, then list its tree. Give its bundle id, its name or its .app path.") }
  let ax = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(ax, 2)
  AX.exposeContent(ax)
  // Chromium and Flutter build their trees only once an assistive client has asked.
  Thread.sleep(forTimeInterval: 1.5)
  var count = 0, truncated = false
  func node(_ element: AXUIElement, _ depth: Int) -> [String: Any] {
    count += 1
    let f = AX.frame(element) ?? .zero
    var out: [String: Any] = [
      "role": AX.role(element) ?? "", "subrole": orNull(AX.value(element, kAXSubroleAttribute) as? String),
      "title": AX.value(element, kAXTitleAttribute) as? String ?? "", "description": AX.value(element, kAXDescriptionAttribute) as? String ?? "",
      "identifier": AX.value(element, kAXIdentifierAttribute) as? String ?? "",
      "frame": ["x": Double(f.minX), "y": Double(f.minY), "width": Double(f.width), "height": Double(f.height)],
    ]
    if let title = AX.value(element, kAXTitleUIElementAttribute), CFGetTypeID(title) == AXUIElementGetTypeID() {
      let labelling = title as! AXUIElement
      out["label"] = AX.value(labelling, kAXValueAttribute) as? String ?? AX.value(labelling, kAXTitleAttribute) as? String ?? ""
    }
    if let value = AX.value(element, kAXValueAttribute) as? String { out["value"] = String(value.prefix(80)) }
    else if let value = AX.value(element, kAXValueAttribute) as? NSNumber { out["value"] = value }
    let children = depth < 64 ? AX.value(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] : []
    out["children"] = children.compactMap { child -> [String: Any]? in
      guard count < 5_000 else { truncated = true; return nil }
      return node(child, depth + 1)
    }
    return out
  }
  let windows = AX.windows(ax).map { node($0, 0) }
  emit(["app": app.localizedName ?? name, "bundle": app.bundleIdentifier ?? "", "windows": windows, "truncated": truncated])
  exit(0)
}
