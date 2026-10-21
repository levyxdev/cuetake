# Ship the engine as an npm package; the skill only teaches and launches it

The recording engine is published as the `cuetake` npm package and exposed only as a CLI. The agent skill carries the operating knowledge plus a one-line launcher that runs `npx -y cuetake@<pinned version>`, and both are released from the same tag. We removed the MCP server: every agent that can install CueTake already has a shell, so MCP only added a second interface, its own job model and its own dependencies. If a client without a shell ever needs MCP, it can be a thin adapter over the same engine functions.

## Considered options

- **Engine inside the skill folder.** Rejected. Skill installers copy files but never run `npm install`, so Playwright and Mediabunny would have to be vendored, and every agent would hold its own copy of the engine.
- **`npx playwright install chromium` for the browser.** Rejected. Run on its own, it resolves the latest Playwright, which can download a Chromium build that CueTake's pinned Playwright never uses. `cuetake install-browser` installs the build matching CueTake's own dependency, after the user agrees.

## Consequences

Users run CueTake on Node. Development uses Bun, and the runtime code must stay Node-compatible (`node:*` APIs only). The Claude Code plugin installs the same skill and nothing else.
