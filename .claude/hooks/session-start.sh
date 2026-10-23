#!/bin/bash
# Prepares a Claude Code cloud session: installs dependencies and checks the browser.
# Downloads no browser; if Chromium is missing, doctor names the fix for the user to approve.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
bun install

# Users run the CLI on Node, so check with Node rather than Bun.
if ! node src/cli.js doctor; then
  echo "cuetake doctor reported a problem; see the checks above." >&2
fi
