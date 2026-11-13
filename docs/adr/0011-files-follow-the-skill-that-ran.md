# Files follow the skill copy that ran

CueTake keeps Scenarios, Takes and Looks in one Home, chosen by where the skill copy that ran is installed: a skill installed in a project uses `<project>/.cuetake`; a global skill, a plugin, or the CLI run without the skill uses the user's Home, `~/.local/share/cuetake`. Before this, files scattered: Takes went to `recordings/` under whatever directory the agent ran in, local Looks to that directory's `.cuetake/looks`, global Looks to the user's data folder, and Scenarios wherever the agent wrote them, often a folder it invented outside every project. Users could not tell what was per project, what was per user, and what ended up in git.

The skill's `scripts/cuetake` knows its own path, so it derives the project from it and passes the Home to the CLI as `CUETAKE_HOME`; the files themselves never live in the skill folder, which installers replace on upgrade.

## Considered options

- **The directory the agent runs in.** Rejected: the agent may run in a subdirectory or outside any project, which is how files scattered.
- **Always the user's Home.** Rejected: a team cannot commit its Scenarios and Looks with the product they demo.

## Consequences

- A plugin's files sit in a shared cache whatever its scope, so a plugin always uses the user's Home.
- When a project skill and a global one share a name, Claude Code runs the global one, so its files go to the user's Home; the setup guide tells users to install one way only, not to mix them.
- Auth profiles hold live sessions and stay per user in `~/.local/share/cuetake/auth`, outside every Home.
- A project's Home gets a `.gitignore` for `takes/` when CueTake first creates it; the user may change it.
