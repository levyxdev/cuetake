import ApplicationServices
import CoreGraphics
import Foundation

/** Accessibility reads, in global points with a top-left origin. */
enum AX {
  static func value(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
  }

  static func role(_ element: AXUIElement) -> String? { value(element, kAXRoleAttribute) as? String }

  static func frame(_ element: AXUIElement) -> CGRect? {
    guard let p = value(element, kAXPositionAttribute), let s = value(element, kAXSizeAttribute) else { return nil }
    var origin = CGPoint.zero, size = CGSize.zero
    AXValueGetValue(p as! AXValue, .cgPoint, &origin)
    AXValueGetValue(s as! AXValue, .cgSize, &size)
    return CGRect(origin: origin, size: size)
  }

  static func setFrame(_ element: AXUIElement, _ frame: CGRect) {
    var origin = frame.origin, size = frame.size
    // Position, size, then position again: an App may move a window it resizes.
    AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &origin)!)
    AXUIElementSetAttributeValue(element, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &size)!)
    AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &origin)!)
  }

  static func windows(_ app: AXUIElement) -> [AXUIElement] { value(app, kAXWindowsAttribute) as? [AXUIElement] ?? [] }

  /**
   * Asks an App to expose all its content: one built on Chromium, an Electron app such as Claude, through
   * AXManualAccessibility, which other Apps ignore; and one built on Flutter, such as LocalSend, by reading
   * its windows' children, after which it builds its semantics within about a second.
   */
  static func exposeContent(_ app: AXUIElement) {
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    for window in windows(app) { _ = value(window, kAXChildrenAttribute) }
  }

  /**
   * Visits the descendants of `root`, depth first, each with its role and subrole, read with its children
   * in one call. Stops after `limit` elements, so a runaway tree cannot hold the Take.
   */
  static func walk(_ root: AXUIElement, limit: Int = 20_000, depth maxDepth: Int = 64, _ visit: (AXUIElement, String, String?) -> Void) {
    var count = 0
    func children(_ element: AXUIElement) -> [AXUIElement] { value(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] }
    func descend(_ element: AXUIElement, _ depth: Int) {
      guard depth < maxDepth else { return }
      for child in children(element) {
        guard count < limit else { return }
        count += 1
        var values: CFArray?
        let names = [kAXRoleAttribute, kAXSubroleAttribute] as CFArray
        AXUIElementCopyMultipleAttributeValues(child, names, [], &values)
        let read = values as? [Any] ?? []
        visit(child, read.first as? String ?? "", read.count > 1 ? read[1] as? String : nil)
        descend(child, depth + 1)
      }
    }
    descend(root, 0)
  }

  /**
   * The frame of what a window shows: the outermost element at its centre that lies inside its bounds.
   * A menu's window is 75 points larger than the menu on every side, for its shadow; a window's own
   * element fills its bounds. Nil when the App exposes nothing there.
   */
  static func visibleFrame(_ app: AXUIElement, within bounds: CGRect) -> CGRect? {
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(app, Float(bounds.midX), Float(bounds.midY), &hit) == .success, var element = hit else { return nil }
    var outermost: CGRect?
    for _ in 0..<64 {
      guard let frame = frame(element), bounds.insetBy(dx: -0.5, dy: -0.5).contains(frame), frame.width > 0, frame.height > 0 else { break }
      outermost = frame
      guard let parent = value(element, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
      element = parent as! AXUIElement
    }
    return outermost
  }
}

/** A string for JSON, or null. */
func orNull(_ value: String?) -> Any { value ?? NSNull() }
