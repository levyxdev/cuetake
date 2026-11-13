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

Run `cuetake doctor` again. Every check must report `ok`; a `platform` note means that platform is not yet verified. Checks marked `for: "Apps"` (`helper`, `screen-recording`, `accessibility`, `input-monitoring`) matter only for recording a desktop App, which needs `apps.ok`: each names the app that needs the grant in System Settings > Privacy & Security, which the user must allow there and then restart. CueTake never asks macOS for a grant itself. A `gpu` check with `accelerated: false` still passes: Chromium draws on the CPU there, so `record` captures at resolution scale 1 unless the Scenario sets one.

## Where files live

CueTake keeps Scenarios, Takes and Looks in a Home, which `cuetake home` prints. The skill installed in a project uses that project's `.cuetake` folder, which starts with a `.gitignore` for `takes/` so Scenarios and Looks can be committed; a skill installed globally or as a plugin uses the user Home, `~/.local/share/cuetake`, for every project. Auth profiles always stay per user.

When the user asks how to install the skill, tell them to pick one way: in each project, to keep each project's files with it, or once globally or as a plugin, to share one Home. Mixed installs are confusing: when a project and the user both install it under the same name, Claude Code runs the user's copy, so files go to the user Home; a plugin adds a second skill, `/cuetake:cuetake`, and which one an agent picks on its own is not defined.

## Uninstall

Run `cuetake uninstall --dry-run` first and show the user what it lists. Plain `cuetake uninstall` removes CueTake's npx cache and, through Playwright, the browser. Playwright keeps the browser while another Playwright installation still uses it. Auth profiles and the user Home's Looks, Takes and Scenarios are the user's work: the dry run lists them under `kept`. Ask about each kind separately, and pass `--auth`, `--looks`, `--takes` or `--scenarios` only for the ones the user agrees to remove. A project's `.cuetake` folder is never removed. Node stays, because other tools need it. Remove the skill itself with the tool that installed it, for example `/plugin uninstall cuetake` in Claude Code.
