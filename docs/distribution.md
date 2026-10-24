# Agent-only product and distribution

CueTake is a local video production capability for agents, not a desktop recording UI. The human describes the outcome and reviews a Take. The agent plans the flow, inspects the page, prepares login if required, writes a Scenario, runs it, and judges the result.

## Installation shape

The engine ships as the `cuetake` npm package and is used only through its CLI. The skill teaches workflow and judgment and launches the engine with a pinned `npx -y cuetake@<version>`. Both are released from the same tag. See [ADR 0003](adr/0003-npm-engine-with-thin-skill.md) for why there is no MCP server and why the engine does not live inside the skill.

A Scenario belongs to the consuming business project, never to the reusable skill. Do not execute untrusted Scenario JavaScript. The agent's authorization covers the selected site and flow, not arbitrary actions a downloaded Scenario might perform.

The Claude Code plugin in `.claude-plugin/` installs the same skill and nothing else.

## Before claiming one-click installation

1. Publish the versioned package under a verified npm identity. Done since 0.1.0; keep the skill's pinned version in step with each release.
2. Give the skill the knowledge to set up Node and the browser: detect existing version managers first, offer the user a choice, and install only after the user agrees.
3. Validate on a clean macOS machine. Linux and Windows are separate later qualifications; keep current platform limits visible.
4. Make uninstall remove only CueTake-owned caches. Let users keep Take folders and choose explicitly whether to remove Auth profiles. Done: `cuetake uninstall` removes CueTake's npx folders, and the browser unless another Playwright installation uses it; it removes Auth profiles only with `--auth` and global Looks only with `--looks`.
