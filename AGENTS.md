# CueTake development

CueTake records browser product demos for AI agents. Use the vocabulary in `GLOSSARY.md`, respect the decisions in `docs/adr/`, and read `skills/cuetake/scenarios.md` before changing the Scenario API.

- Use Bun for development and keep `bun.lock` in sync. Users run the CLI on Node, so runtime code uses Node APIs only (`node:*` modules, no `Bun.*`).
- The CLI is the only interface; the skill drives it. Capture produces the Source and Timeline; Render reads only Source, Timeline and Edit (ADR 0002).
- Install scripts download nothing. The browser is installed only by `cuetake install-browser`, after the user agrees.
- Keep timing and coordinate spaces explicit: Scenario boxes and the Timeline use CSS pixels; the Source uses device pixels; output dimensions are independent.
- Check git status first. Keep product-specific Scenarios, Takes and Auth profiles outside this repository. `origin` is the public repository, `levyxdev/cuetake`.
- Run `bun test tests/pipeline.test.js` for pipeline and Render changes. For Capture or Render changes, also record a short real Scenario and inspect the Final's frame metadata and cursor position.
- Do not publish packages, push code, create releases, or start a website server unless requested.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `levyxdev/cuetake`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
