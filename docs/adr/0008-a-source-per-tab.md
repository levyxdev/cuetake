# A Source per Tab; Render cuts between them

A demo that opens a new tab or a popup window (a `target="_blank"` link, an OAuth or payment popup) shows more than one page, so Capture records one Source per Tab instead of one Source per Take. The recorder page captures each Tab the demo opens as its own stream, for as long as the Tab is open, whether it is in front or not. The Timeline notes which Tab is in front over time and positions each input in the CSS pixels of the Tab it happened in. Render shows the Tab in front at each moment: a Tab the size of the viewport replaces the page inside the same window, and any other Tab is drawn as a popup window over the Tab that opened it. How Tabs switch and where popup windows sit are Edit choices, so they can change without recording again. This amends ADR 0002, which spoke of one Source; the boundary it draws is unchanged.

## Considered options

- **One stream that Capture switches to the Tab in front** (surface switching). Rejected: the cut would be fixed at Capture, with a gap in the picture at each switch; the Tab behind a popup window could not be shown while the popup is open; and auto-selecting the captured tab by its title was not shown to work with switching.
- **Record only the first Tab** (as before). Rejected: OAuth, payment and "open in new tab" flows are common in product demos, and the page they open was simply missing from the Final.

## Consequences

- Each open Tab costs one more stream to encode, at its full frame rate even behind. On machines without a GPU, Capture's warning about too few Source frames is reported per Tab.
- The Director acts only on the Tab in front. A new Tab comes in front when it opens, the Tab that opened it comes back when it closes, and `d.switchTo(page)` brings back any other.
- The Cursor stays one pointer across Tabs. Where the page cannot see the pointer (between the Tab behind and a popup window), the Director writes its own path into the Timeline, so the Cursor glides into the popup. The Director converts positions using the popup's default placement; moving the popup in the Edit makes the Cursor jump slightly as it enters.
