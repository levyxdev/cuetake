# Edit times are Source time; the Final's time comes from the time map

Every time in the Timeline and the Edit (camera targets, Shortcuts, Line starts, Fast-forwards) stays in Source time, seconds since Capture started. The Final's time is derived from the Edit's Fast-forwards by one time map (`src/time-map.js`), so a span can be retimed or removed and everything else follows without being rewritten. Cuts and trims, if they come, are the same map with segments removed.

What the page itself does plays at the Final moment's Source time: the Source frame, the Cursor's path, presses and shape, and click effects, so they speed up with the page. What is shown for the viewer keeps its pace in Final time: the camera arrives `lead` before each action and settles in `response` seconds of the Final, keycaps and Subtitles show for their duration, and Lines play at their own speed.

## Considered options

- **Rewrite the Edit's times into Final time when a Fast-forward is added.** Rejected: every retime would have to rewrite targets, Shortcuts and Lines, and removing a span could not restore them exactly.
- **Run the camera in Source time.** Rejected: around a Fast-forward its moves would be squeezed into a fraction of `response`, and an action right after a span would get almost no `lead`.
- **Speed up a Line spoken during a Fast-forward, or let it run on over the faster picture.** Rejected: speech cannot be sped up without sounding wrong, and a voice over a picture racing ahead no longer describes it (ADR 0006: the picture follows the voice). The Director refuses `say` inside `fastForward`, and Render refuses a Line placed over one, naming it.

## Consequences

- `render.json` reports times in the Final; `subtitles.srt` and `.vtt` are timed to the Final; `preview --at` takes seconds of the Final.
- A Fast-forward can show the Source time it skips: each frame of the Final averages the Source frames in its interval, and the Cursor trails across it. This blurs only the page's own motion, which ADR 0001 noted needs more than one Source frame per output frame; a Fast-forward already decodes them.
- While the camera follows the Cursor during a Fast-forward, the Cursor can briefly move faster than the camera follows it and leave the view.
