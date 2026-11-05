import AppKit
import ApplicationServices
import CoreGraphics

/**
 * The grants the responsible process holds, read without prompting. macOS grants Screen Recording and
 * Accessibility to the process responsible for CueTake (the terminal or the agent's host), and this
 * helper, its child, uses them, so the fix names that app.
 */
func preflight() -> [String: Any] {
  let responsible = responsibleProcess()
  return [
    "screenRecording": CGPreflightScreenCaptureAccess(),
    "accessibility": AXIsProcessTrusted(),
    "inputMonitoring": CGPreflightListenEventAccess(),
    "responsible": responsible,
  ]
}

/** The responsible process's path, and the app to name: the outermost `.app` bundle holding it, or the binary. */
func responsibleProcess() -> [String: Any] {
  typealias Responsible = @convention(c) (pid_t) -> pid_t
  var pid = getpid()
  if let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid") {
    pid = unsafeBitCast(symbol, to: Responsible.self)(getpid())
  }
  var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
  let path = proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 ? String(cString: buffer) : ""
  var app = (path as NSString).lastPathComponent
  let parts = (path as NSString).pathComponents
  if let index = parts.firstIndex(where: { $0.hasSuffix(".app") }) {
    let bundle = Bundle(path: NSString.path(withComponents: Array(parts[...index])))
    app = (bundle?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
      ?? (bundle?.object(forInfoDictionaryKey: "CFBundleName") as? String)
      ?? (parts[index] as NSString).deletingPathExtension
  }
  return ["pid": Int(pid), "path": path, "app": app]
}
