# CueTake development

CueTake records product demos of web pages and desktop Apps for AI agents. Use the vocabulary in `GLOSSARY.md`, respect the decisions in `docs/adr/`, and read `skills/cuetake/scenarios.md` before changing the Scenario API.

- Use Bun for development and keep `bun.lock` in sync. Users run the CLI on Node, so runtime code uses Node APIs only (`node:*` modules, no `Bun.*`).
- The CLI is the only interface; the skill drives it. Capture produces the Source and Timeline; Render reads only Source, Timeline, Edit and the Narration (ADRs 0002, 0006).
- Install scripts download nothing. The browser is installed only by `cuetake install-browser`, after the user agrees.
- Keep timing and coordinate spaces explicit: Scenario boxes and the Timeline use CSS pixels; the Source uses device pixels; output dimensions are independent.
- Check git status first. Keep product-specific Scenarios, Takes and Auth profiles outside this repository. `origin` is the public repository, `levyxdev/cuetake`.
- `main` is what users install, since the skill is installed from it, so it changes only in a release, run with `/release` when the user asks. Work lands on `dev`, committed directly or through a branch and a PR against `dev`. A commit that finishes an issue says `Closes #N`, otherwise `Part of #N`; the issue then swaps its triage label for `on-dev` (`docs/agents/triage-labels.md`).
- Run `bun test tests/pipeline.test.js` for pipeline and Render changes. For Capture or Render changes, also record a short real Scenario and inspect the Final's frame metadata and cursor position.
- Push each commit on `dev` (or its branch) to `origin` as soon as it is made. Publish packages, create releases, or start a website server only when requested.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `levyxdev/cuetake`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
