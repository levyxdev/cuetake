// swift-tools-version:5.9
// cuetake-capture: the native helper the Node CLI runs to record a Desktop of macOS Apps (ADR 0009).
// Build it with `bun run build:helper`, which makes the universal binary shipped in the npm package.
import PackageDescription

let package = Package(
  name: "cuetake-capture",
  platforms: [.macOS(.v14)],
  targets: [.executableTarget(name: "cuetake-capture", path: "Sources/cuetake-capture")]
)
