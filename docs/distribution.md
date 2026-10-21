# Agent-only product and distribution

CueTake is a local video production capability for agents, not a desktop recording UI. The human describes the outcome and reviews a take. The agent plans the flow, inspects the page, prepares login if required, writes a scenario, executes it, and judges the result.

## Recommended installation experience

Ship a client plugin containing **one generic skill + one local stdio MCP server**. The package manager pins a release of the runtime. The client starts the MCP child process on demand and closes it with the session; no separately managed HTTP service is needed.

The skill teaches workflow and judgment. The MCP owns execution and returns jobs/artifacts. A scenario belongs to the consuming business project, not the reusable skill. Thin launcher scripts may adapt paths; the recording engine must not be copied into multiple skills.

For clients without plugin packaging, offer a skill plus an MCP configuration entry. For agents with only shell access, the CLI invokes exactly the same engine. Installing a skill alone is insufficient to provide the executable or dependencies.

## Current implementation

- Generic skill: `skills/cuetake/SKILL.md`.
- MCP: `bun /absolute/path/to/cuetake/src/cli.js mcp`.
- CLI: `record`, `render`, `verify`, `doctor`.
- MCP tools: `cuetake_doctor`, `cuetake_record`, `cuetake_render`, `cuetake_verify`, `cuetake_job`, `cuetake_auth_open`, `cuetake_auth_save`.
- Record/render/verify return a job immediately. Jobs run sequentially per MCP process to avoid GPU contention and same-output races. Job IDs are process-local; completed take files remain reusable after restart.

A client with JSON MCP configuration can use this **local source installation** shape (replace the path):

```json
{
  "mcpServers": {
    "cuetake": {
      "command": "bun",
      "args": ["/absolute/path/to/cuetake/src/cli.js", "mcp"]
    }
  }
}
```

Do not execute untrusted scenario JavaScript. The agent's authorization applies to the selected site and flow, not arbitrary actions a downloaded scenario might perform.

## Before claiming one-click public installation

1. Publish the versioned runtime under a verified package/repository identity; there is no public CueTake release yet.
2. Provide client-specific plugin manifests that bundle the skill and launch the same pinned runtime. Do not assume one client's plugin format installs on every agent.
3. Add an installer that detects Bun, Chromium, and FFmpeg, obtains informed permission for missing downloads, and reports where files go. Chromium and FFmpeg are real prerequisites; an MCP entry cannot make them disappear.
4. Validate installation on a clean macOS machine, then separately qualify Linux/Windows. Keep current platform limits visible.
5. Make uninstall remove only CueTake-owned executables/caches; allow users to preserve take folders and explicitly choose whether to remove login profiles.

This turn prepares the runtime and portable skill. It does not publish a package, install a global plugin/MCP configuration, or claim the clean-machine installer already exists.
