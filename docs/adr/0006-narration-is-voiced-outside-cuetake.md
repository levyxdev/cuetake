# Narration is voiced outside CueTake, before Capture

The agent writes the Narration and has a separate speech tool voice each Line; CueTake places the Lines' audio, mixes it into the Final and draws the Subtitles, and never synthesizes speech or calls a language model. The speech models that reach publishable English and Chinese and allow commercial use (Qwen3-TTS, VoxCPM2 and Fun-CosyVoice3 in October 2026) run on Python with GPU- or MLX-specific runtimes, so bundling one would break CueTake's Node-only runtime and tie its releases to a field that changes every few months. Speech is voiced before Capture so the Director can hold each Line for its real duration: the picture follows the voice, instead of the voice being squeezed into gaps the Scenario guessed.

## Considered options

- **CueTake synthesizes speech with a bundled local engine** (sherpa-onnx running Kokoro). Rejected: no Kokoro checkpoint is good in both English and Chinese, and the stronger models do not run under Node.
- **CueTake calls an OpenAI-compatible speech endpoint.** Rejected: CueTake would still own model and voice choice, keys, and how to start a server on each platform.
- **CueTake writes the narration text with its own model call.** Rejected: the agent already knows what the demo shows, and a second model adds a second API key to manage (ADR 0003).
- **Speech is voiced after Capture and fitted to the video.** Rejected: the Scenario cannot know how long a Line takes, so Lines overlap or leave dead air.

## Consequences

- A Take receives its Narration as audio files with optional word timings, copied into the Take. CueTake measures each Line's duration from its audio.
- Lines are timed in Source time; cuts and retiming come from the time map of #11.
- A Line that overlaps the next one or runs past the end of the Final is an error naming that Line. CueTake does not move Lines or stretch the picture.
- Choosing models and voices, cloning, and keeping narration text on the user's machine are the speech tool's concerns.
