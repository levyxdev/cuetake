# Capture produces a Source and a Timeline; Render never touches the captured page

Capture's only outputs are the Source (the page's pixels, without cursor or click effects) and the Timeline (every pointer movement, click, keystroke and focus target, timed from capture start and positioned in CSS pixels). Render reads only the Source, the Timeline and the Edit; it never drives or reads the captured page. (It does run its own Chromium page to compose and encode; see ADR 0001.) The cursor and click effects are therefore drawn at Render time from the Timeline instead of being baked into the Source.

This boundary lets a Take be restyled (cursor, camera, frame) without recording again, enables cursor smoothing and blur, and lets a future capture method, such as a native app window driven by an agent's computer use, reuse Render unchanged by producing the same two artifacts.

A Take that shows several Tabs has a Source per Tab (ADR 0008).
