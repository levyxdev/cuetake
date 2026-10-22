# Adjust styling in conversation with Previews, not in a configurator page

The user never operates styling controls. They tell the agent what they want; the agent proposes a few Looks, `cuetake preview` composes them side by side from the Take's own Source with Render's compositor, and the user picks or comments while the agent edits `edit.json`. Agents already edit the Edit directly and users talk only to agents, so a page of controls would duplicate what the agent does while adding a second interface (ADR 0003); comparing pictures of the agent's proposals is the part only the user can do.

## Considered options

- **A configurator page in a headed Chromium window**, served on a private origin like Render and closed like `cuetake login`. Rejected: it needs its own controls and a protocol for returning choices to the agent, and still only does what "use B, rounder corners" in chat does.
- **A static HTML file.** Rejected: a `file://` page cannot read the Take's Source or write `edit.json` back, so the user would copy JSON by hand.
- **Short candidate videos.** Rejected: each candidate needs a full encode (about realtime at 2160p, ADR 0001), while styling is judged from a still.

## Consequences

- A Preview composes stills without encoding, so styling iterations take seconds; the Final is rendered once, after the user approves.
- Chosen styling is reused as Looks, saved locally (the directory CueTake runs in) or globally. Looks are not stored in the skill's folder: skill installers replace that folder on upgrade, its location differs per agent, and the CLI launched through `npx` cannot know it.
