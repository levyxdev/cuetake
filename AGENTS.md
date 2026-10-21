# CueTake development

CueTake is a standalone browser demo recorder derived from Pagecast. Read README.md and docs/scenarios.md before changing the recording API.

- Use Bun and keep bun.lock in sync. No automatic browser downloads in install scripts.
- Check git status first. Keep product-specific scenarios and private recordings outside this repository.
- The supported release path is the scenario CLI with HD tab capture and FFmpeg camera MP4. MCP and CLI share this engine; do not reintroduce separate legacy recording paths.
- Keep timing and coordinate spaces explicit: scenario boxes are CSS pixels; source video uses device pixels; output dimensions are independent.
- Retain original source attribution and the MIT license. History starts fresh in this repository; Pagecast attribution lives in LICENSE and NOTICE. `origin` is the public repository, `levyxdev/cuetake`.
- Run `bun test tests/pipeline.test.js` for pipeline/camera changes. For capture changes, also record a short real scenario and inspect output frame metadata and cursor position.
- Do not publish packages, push code, create releases, or start a website server unless requested.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `levyxdev/cuetake`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
