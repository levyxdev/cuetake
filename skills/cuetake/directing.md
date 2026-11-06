# Directing a Scenario

A Take is a short film of one outcome. What the viewer sees, and for how long, comes from the order of the Scenario's actions, the waits between them and the automatic camera. This file is how to direct them; the calls themselves are in [scenarios.md](scenarios.md).

## Story

- One Take proves one **outcome**: the change the viewer should remember, such as "the invite is sent" or "the chart shows this week". A second outcome is a second Take.
- Build the Take from **beats**. A beat is a few actions in one area of the page that end on a **reveal**, the state that shows they worked. A Take holds one to five beats, 15 to 45 seconds in all; a story that needs more is several Takes.
- Open on the page as the viewer would find it, with everything the story needs loaded in `prepare`: examples, assets, dismissed banners and tours. Every action in `run` serves the outcome.
- Close on the outcome, wide, so the viewer sees it in the context of the whole page.

## Pacing

The Director already pauses like a person around each press and key, so consecutive actions in a beat follow each other with no waits. Time everything else with `d.wait(ms)`, counted from what just happened, so a page that loads slowly pushes later actions back and every hold keeps its length. `d.at(seconds)` waits for a time since the start; it suits only the opening, since a time already past returns at once and the hold it was meant to give disappears without a warning.

| Moment | Rule of thumb |
| --- | --- |
| Opening | `await d.at(1.5)` before the first action: about a second of the wide page before the camera heads in. |
| Within a beat | Nothing; the Director's own pauses are enough. |
| Before a decisive action (submit, send, run) | `d.wait(400)`, so the viewer sees what is about to be sent. |
| A reveal | Wait for it (`await toast.waitFor()`), then hold 1.5 s plus 0.3 s for each word, or 0.15 s for each Chinese, Japanese or Korean character, the viewer must read; 2 to 3 s is typical. |
| Between beats | The reveal's hold is the gap. |
| Ending | After the last reveal's hold, `d.wait(2000)`: the camera heads back wide 1.5 s before the end, so the outcome shows in context. |

`director.speed` scales the Director's moves, pauses and typing, never these waits. When the user finds a Take rushed or slow, change the waits; when the cursor itself feels wrong, change `director.speed`.

## Camera

The camera works like Screen Studio's auto zoom. It follows the clicks, typing and drags the page observed, whether they came from the Director or from Playwright input directly, and in any frame: input inside an iframe, such as an embedded checkout or sign-in, is placed where the iframe shows on the page, through scrolling, fixed positioning and scaling. An iframe that is rotated, skewed or 3D-transformed is placed as if it were only scaled, and verification warns; record once it is upright, after any opening animation.

- It arrives `lead` (0.6) seconds before each action, so the zoom is in place when the action happens.
- Actions whose zoom windows sit within `chainGap` (2) seconds share one zoom segment: the camera stays zoomed and moves between them instead of zooming out and back in. A segment holds one zoom, the closest that fits every target in it.
- Within a segment the camera centers on the first target, then stays still while later targets are already in view (with `padding`, 48 CSS px) and otherwise moves only far enough to bring them in.
- It holds `hold` (1.5) seconds after the segment's last action (after typing ends, for typing), then returns to the wide shot.
- While zoomed it follows the cursor only when it nears the edge, keeping it in the central 80% of the view, and stays where the cursor left it (`follow: false` turns this off).
- Movement eases in and out, settles in about `response` (0.6) seconds and never overshoots.
- Every Final ends wide: the camera heads back `endWide` (1.5) seconds before the end.

Each target is framed with `padding` CSS px around its box, zooming at most `maxZoom` (2); boxes too large to reach `minZoom` (1.2) stay wide. Set `zoom` on a target in `edit.json` to fix it; its segment then zooms no further. `d.focus(box, seconds?)` adds a deliberate target and, like a manual zoom in Screen Studio, replaces only the automatic targets within its own span, from `lead` before it to `hold` after; the rest of the Take keeps following actions. Pass `focus: false` to an action to keep the camera wide for it; a bare number still works as the action's timing. Focus boxes always use CSS pixels, even when the Source is captured at 2× scale; in a Take of an App they are Desktop points, read from `cuetake tree`.

Trust the automatic camera, and step in only for these:

- **A reveal away from the action.** A toast in a corner, a chart beside the form, a row added to a list: the camera follows the click, not its result. When the reveal shows, `d.focus(await reveal.boundingBox())`. `hover` adds no target either, so focus on the tooltip or menu it reveals.
- **A long read.** The camera leaves a target after 1.5 s. To keep it on a reveal for longer, call `d.focus` on the same box again every 2 s of the hold; each call chains into the same still shot.
- **An incidental action.** Closing a dialog, clicking a tab to get somewhere, moving focus: pass `focus: false`, so the camera stays wide and does not chain the beats around it into one long zoom.
- **A busy camera.** Actions within about 4 s of each other chain into one segment, and the camera pans between them. Finish each area before moving to the next, and never go back and forth between two areas: each change of area is a pan.

Keep the cursor off the reveal. If the last action leaves it covering what the viewer must read, `d.move` it a short way aside, 100 to 150 CSS px, within the view: a long move while zoomed pulls the camera with it.

## Waiting and emphasis

- **Dead time** goes in `d.fastForward`: a page load, a server, an AI response streaming in. A hold on a result stays outside it, so the viewer can read it. Keep the cursor still inside it: a move there plays `rate` times faster, and a zoomed camera can lose it. If the cursor would cover what the viewer waits for, move it aside before the wait.
- **A small change** in a busy page, such as one figure in a table, is hard to see even zoomed in. Spotlight it for its hold with `d.mask(locator, { effect: 'spotlight' })` and `end()` the spotlight when the hold ends ([scenarios.md](scenarios.md), Masks).

## Narration

With a voiced Narration ([narration.md](narration.md)), the Lines set the pace: `d.say(id)` holds until its Line ends, so a Line about a reveal is its hold, and a wait after it is needed only for text the viewer must read beyond what the Line says. Write one Line per beat. Start a Line as its beat starts, without awaiting it, so the voice and the action run together, and await it before the reveal:

```js
const line = d.say('send');
await d.type(email, 'ada@example.com');
await d.click(send);
await line;
```

The opening still waits about a second before the first Line, and the ending keeps its 2 s after the last.

## Example

```js
export const config = { name: 'invite', url: 'http://localhost:3000/team' };

export async function prepare(page) {
  await page.getByRole('button', { name: 'Invite' }).waitFor();   // loaded before Capture starts
}

export async function run(d) {
  const email = d.page.getByLabel('Email'), toast = d.page.getByRole('status');
  await d.move(720, 640, 0);
  await d.at(1.5);                                                   // opening: the page, wide

  // Beat 1: fill the invite.
  await d.click(d.page.getByRole('button', { name: 'Invite' }));
  await d.type(email, 'ada@example.com');
  await d.wait(400);                                                 // see the address before sending

  // Beat 2: send it. The toast shows in the top right, away from the button.
  await d.click(d.page.getByRole('button', { name: 'Send invite' }));
  await toast.waitFor();
  const box = await toast.boundingBox();
  d.focus(box);                                                      // the reveal, not the button
  await d.wait(2000);
  d.focus(box);                                                      // "Invite sent to ada@example.com": a longer read
  await d.wait(1200);

  await d.wait(2000);                                                // ending: the outcome, wide
  return { status: await toast.textContent() };
}
```
