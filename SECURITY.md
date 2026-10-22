# Security policy

## Supported versions

CueTake is pre-1.0. Only the latest published version of the [`cuetake`](https://www.npmjs.com/package/cuetake) package receives fixes.

## Reporting a vulnerability

Report it privately through [GitHub's private vulnerability reporting](https://github.com/levyxdev/cuetake/security/advisories/new). Please do not open a public issue. Expect a first reply within seven days.

## What CueTake trusts

- **Scenarios are code.** `cuetake record` runs the Scenario file with the user's permissions. Run only Scenarios you wrote or reviewed.
- **Auth profiles hold live sessions.** `cuetake login` saves cookies, localStorage and IndexedDB to `~/.local/share/cuetake/auth/<profile>.json` (or `CUETAKE_AUTH_DIR`) with mode 0600, unencrypted. Treat them like passwords and never commit or share them.
- **Takes may contain private data.** A Take's Source, Timeline and Final show whatever the recorded page showed, including typed text.
- **Downloads.** Install scripts download nothing. `cuetake install-browser` downloads Playwright's Chromium only when the user runs it.

Reports about these areas, about the Render page (which serves files from a private `cuetake.invalid` origin inside headless Chromium), or about the agent skill's instructions are all in scope.
