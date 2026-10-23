# Narration is written by the agent and spoken locally by default

The agent driving CueTake writes the narration text, possibly with help from other skills; CueTake only turns that text into speech and subtitles and never calls a language model itself. The agent already knows what the demo shows, so a model inside CueTake would duplicate it and add a second API key to manage (ADR 0003). Speech is synthesized on the user's machine by default, because narration describes products that are often unreleased and every other part of a Take stays local. A cloud text-to-speech provider is an opt-in for users who supply their own key, and it is the only path on which narration text leaves the machine.

## Considered options

- **CueTake generates narration from the Timeline with its own model call.** Rejected for the reasons above; the skill teaches the agent how to write narration instead.
- **Cloud speech only.** Rejected: it sends every Take's script to a third party and makes narration fail offline or without a key.
- **The browser's built-in speech synthesis.** Not available: headless Chromium reports no voices.

## Consequences

- A local speech model is installed only by an explicit CueTake command after the user agrees, like `install-browser`; install scripts still download nothing.
- Provider keys are passed at runtime, never stored in a Scenario or an Edit, like Auth profiles.
