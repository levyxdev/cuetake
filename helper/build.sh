#!/bin/sh
# Builds the universal (arm64 and x86_64) cuetake-capture helper into helper/bin, which the npm
# package ships. Run on a Mac with Xcode or its Command Line Tools, before publishing.
set -eu
cd "$(dirname "$0")"
swift build -c release --arch arm64 --arch x86_64
built=$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path)
mkdir -p bin
cp "$built/cuetake-capture" bin/cuetake-capture
lipo -archs bin/cuetake-capture
