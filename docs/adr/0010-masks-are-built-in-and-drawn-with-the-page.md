# Masks are built-in effects, drawn with the page in its own CSS pixels

A Mask hides private data or points the viewer at the change being shown, so it has to stay on its element whatever the camera, the Tabs and the motion blur do. It sits in the page's own CSS pixels under the camera, and a Mask the Scenario names follows its element's box as Capture recorded it in the Timeline. Blur and cover are drawn as part of the page itself: where they sit, the page shader puts a blurred or solid picture in place of the page. Spotlight is drawn over the page and its chrome. The three effects are built in, and Render refuses a Mask it cannot draw. This amends ADR 0005, under which everything drawn besides the page is agent-written and unvalidated: a Mask is drawn by CueTake and validated.

## Considered options

- **Agent-written mask shaders, like the Background (ADR 0005).** Rejected: a weak blur or a shader that draws nothing would show what the Mask hides, and only a Final someone watches would reveal it. A Mask's job is to hide something, so CueTake keeps it to effects that are known to hide, and enforces a minimum blur.
- **Masks in output pixels, drawn over the Final.** Rejected: they would slide off their element whenever the camera zooms or pans, and could not follow an element as the page scrolls.
- **Drawing blur and cover as a layer over the page.** Rejected: while a Tab fades in or a popup window animates, the page under the layer is partly transparent, so the private page would show through a partly transparent mask.

## Consequences

- Blur and cover cover a little more while their element moves: every box it had from 0.2 s before each moment to 0.25 s after. Tab capture shows a change tens of milliseconds after the page makes it, so the Source can still show the element where it was after its box has moved; and Capture finds an element the page replaced elsewhere only when the Director next matches its locator, ten times a second. A spotlight follows only the current box.
- A blur or cover the Scenario makes before the Director first waits or acts covers the Take from its first frame.
