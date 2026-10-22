# Styling is agent-written code and images, with built-in defaults and no validation

Everything Render draws besides the page is supplied the same way: Background layers and window effects (shadow, glow, outline) are GLSL fragment shaders or images; the window chrome, cursor and click effect are drawing code for a 2D canvas or images. CueTake ships one default of each as ordinary files the agent can read and copy (a fluted-glass Background lit by the page's brand color, a soft shadow, light and dark browser and macOS chrome, an arrow and a dot cursor, a spark). Every number, such as output size, padding and camera timing, is a free field with a default. Styling is not validated: CueTake fills in defaults and renders; a wrong value shows up in the Preview or as the error where it breaks, and the agent fixes it.

The user only talks to an agent (ADR 0004), and agents write shaders and canvas code well, so a fixed list of effects and ranges would only limit what they can make. The Background stays still while the camera moves the window, so it is drawn once per Take; window effects follow the window and are drawn every frame.

## Considered options

- **Named presets with tunable parameters** (the 0.2 `background: 'ocean'`). Rejected: every new effect needs a CueTake release, and agents can already write the effect itself.
- **SVG for the chrome and cursor.** Rejected: drawing code can fit the address field to the URL and load fonts; SVG was only safer, and the render page's network block covers that.
- **Animated Backgrounds.** Rejected for now: a still Background is drawn once, keeps Render's cost flat and keeps each Preview identical to the Final.

## Consequences

- A Look or Take carries code. The skill tells agents to read the code of a Look they did not write before using it, and to download any remote font or image into the Look; the render page has no network, so code that reaches out fails with an error naming what to download.
- Files a Look or Take names travel with it: a Look with files is saved as a folder, and adopting it copies the files into the Take's `styles/` folder, so Render still reads only the Take (ADR 0002).
- A shader that fails to compile reports its file and line; code that throws or stalls the GPU stops the Preview or Render with that error.
