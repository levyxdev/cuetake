# Setting up CueTake on the user's machine

CueTake needs Node 20.10 or newer and the Chromium build its Playwright drives. Nothing installs without the user's agreement. Offer the choices below, say what each one changes and roughly how large it is, and act only after the user picks one. With the user's agreement you may run the installers yourself, including a graphical installer through computer use. The user may also prefer to install it themselves.

## Node

Check what already exists before offering anything: `node --version`, then the version managers `fnm`, `nvm`, `volta`, then `brew`. If one exists, use it:

| Found | Install Node with |
| --- | --- |
| fnm | `fnm install --lts && fnm use lts-latest` |
| nvm | `nvm install --lts` |
| volta | `volta install node` |
| Homebrew only | `brew install node` |

With none of them, offer:

- **fnm**, for developers who want to switch Node versions: `brew install fnm`, or the installer at https://github.com/Schniz/fnm.
- **Homebrew**: `brew install node`, if the user wants Homebrew anyway.
- **The official installer** from https://nodejs.org (LTS). It asks for the administrator password, which only the user can type.

## Browser

Run `cuetake install-browser` (about 150 MB into Playwright's cache in the user's Library). It downloads the exact build this CueTake version drives, so do not substitute `npx playwright install`, which may fetch a different build. The user's own Chrome is never used or modified.

## Check

Run `cuetake doctor` again. Every check must report `ok`; a `platform` note means that platform is not yet verified. A `gpu` check with `accelerated: false` still passes: Chromium draws on the CPU there, so `record` captures at resolution scale 1 unless the Scenario sets one.

## Uninstall

Run `cuetake uninstall --dry-run` first and show the user what it lists. Plain `cuetake uninstall` removes CueTake's npx cache and, through Playwright, the browser. Playwright keeps the browser while another Playwright installation still uses it. Auth profiles and global Looks are the user's work: the dry run lists them under `kept`. Ask about each one separately, and pass `--auth` or `--looks` only for the ones the user agrees to remove. Take folders and local Looks (`.cuetake/looks`) in the user's projects are never removed. Node stays, because other tools need it. Remove the skill itself with the tool that installed it, for example `/plugin uninstall cuetake` in Claude Code.
