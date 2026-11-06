// cuetake-capture: records a Desktop of macOS Apps for CueTake (ADR 0009). The Node CLI runs it as a
// child process and talks to it in JSON lines over stdio; it never prompts for a permission.
//
//   cuetake-capture preflight   Prints which grants the responsible process holds, without prompting.
//   cuetake-capture record      Reads a request line, starts the App, then follows `start` and `stop`.
//   cuetake-capture tree <app>  Prints the Accessibility tree of a running App, for writing a Scenario.
//
// Coordinates: global points have a top-left origin on the primary display; the Desktop's own points
// count from its top-left corner and play the role of CSS pixels; backing pixels are the Source's.
import AppKit
import Foundation

/** Writes one JSON line to stdout. */
func emit(_ object: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

/** Reports an error the Node CLI shows as it is, then exits. */
func fail(_ code: String, _ message: String, _ exitCode: Int32 = 2) -> Never {
  emit(["error": ["code": code, "message": message]])
  exit(exitCode)
}

// ScreenCaptureKit asserts in CGS_REQUIRE_INIT unless the process has connected to the window server.
_ = NSApplication.shared
NSApplication.shared.setActivationPolicy(.prohibited)

switch CommandLine.arguments.dropFirst().first {
case "preflight":
  emit(preflight())
  exit(0)
case "record":
  Recorder.main()
case "tree" where CommandLine.arguments.count == 3:
  MainActor.assumeIsolated { printTree(CommandLine.arguments[2]) }
default:
  FileHandle.standardError.write("usage: cuetake-capture preflight | record | tree <app>\n".data(using: .utf8)!)
  exit(64)
}
