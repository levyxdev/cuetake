---
name: release
description: "Release dev: bump the version, publish to npm, move main to dev and tag it."
disable-model-invocation: true
---

A release moves `main`, which users install the skill from, to `dev`. The skill pins `npx -y cuetake@<version>`, so the package must be on npm before `main` moves: a `main` that pins an unpublished version breaks every new install.

1. **Start from a clean `dev`.** `git status` is clean and `dev` matches `origin/dev`. `origin/main` is an ancestor of `origin/dev`; if not, stop and show the user the commits only on `main`. CI (`Check`) is green on `dev`'s head.

2. **Account for every issue going out.** List the commits in `origin/main..origin/dev` and the open issues labelled `on-dev`. GitHub closes an issue when a commit saying `Closes`, `Fixes` or `Resolves #N` reaches `main`. Done when each `on-dev` issue either has such a commit, or the user has said it is done (close it by hand in step 8) or unfinished (swap `on-dev` back to its triage label). Also list closing commits whose issue lacks `on-dev`.

3. **Choose the version with the user.** Before 1.0: a minor for features or breaking changes, a patch for fixes only. Name the breaking changes you found in step 2.

4. **Prepare the release commit on `dev`.** Set the version in `package.json`, `.claude-plugin/plugin.json` and `skills/cuetake/scripts/cuetake`, and run `bun install` so `bun.lock` follows. Done when `grep -rn '<old version>'` outside `node_modules` and `.git` finds nothing, `bun test tests/pipeline.test.js` passes, and `npm pack --dry-run` lists `src`, `examples`, `README.md` and `LICENSE` and no install script. Commit as `Prepare <version> with <the headline changes>` and push `dev`.

5. **Build the helper.** The package ships `helper/bin/cuetake-capture`, the Swift helper that records Apps (ADR 0009), which git ignores. On a Mac, from the release commit, the user runs `bun run build:helper`. Done when `lipo -archs helper/bin/cuetake-capture` prints both `x86_64` and `arm64`, and `npm pack --dry-run` lists `helper/bin/cuetake-capture`. If it is missing or has one architecture, stop: publishing would ship a CueTake that cannot record Apps.

6. **Publish to npm.** This is the user's step, under their verified npm identity: hand them `npm publish` to run from that commit, in the folder where the helper was built. Wait until they confirm `cuetake@<version>` is on npm.

7. **Move `main` and tag it.** `git checkout main && git merge --ff-only origin/dev`, then `git tag -a v<version> -m "CueTake <version>"`, and push `main` and the tag.

8. **Write the GitHub release and tidy the issues.** Create the release `CueTake <version>` from the tag. Model its notes on the previous release's: one summary sentence, the install block with the new version, a bullet per user-visible change, then Breaking, Known issues, and the closing line naming the npm package built from this tag. Close the issues from step 2 that had no closing commit, with a comment naming the release. Remove `on-dev` from every issue this release closed. Done when no open issue carries `on-dev`.
