# Render in the browser with WebGL and WebCodecs

Render runs inside Chromium: Mediabunny demuxes the VP9 Source, WebCodecs decodes it, a WebGL shader composes camera, cursor and frame styling, and WebCodecs encodes H.264 that Mediabunny muxes into the Final MP4. We replaced the FFmpeg filtergraph because Screen Studio-style effects (backgrounds, rounded corners, shadows, window chrome, later motion blur) are simple in a shader and painful in filtergraphs, and because it removes FFmpeg from the user's install. Chromium is already required for Capture.

## Consequences

A spike on an Apple M4 (15 s Source at 2880×1800) measured these speeds as multiples of realtime, the same headless and headed, with the hardware GPU (ANGLE Metal) and hardware encoder in both:

| Output | WebGL Render | FFmpeg zoompan only, no effects |
| --- | --- | --- |
| 1080p60 | 2.3× | 3.9× |
| 1440p60 | 2.1× | — |
| 2160p60 | 1.0× | 1.1× |

- **4K is capped at realtime.** The hardware H.264 encoder tops out around 480 MP/s, which is exactly 4K60. Composing with Canvas2D instead of WebGL was 1.5–2× slower, because copying the canvas into a `VideoFrame` was the bottleneck.
- **Use quantizer rate control.** Hardware variable bitrate wastes bits on static scenes. Quantizer 22 halves file size at near-identical sharpness (PSNR 49.5 dB, SSIM 0.9992 against a q8 reference). Quantizer mode is only available on the hardware encoder.
- **Set encoder metadata explicitly.** Patch the colour transfer to bt709 before muxing; the encoder tags sRGB. Request an H.264 level that fits each preset: `avc1.640033` up to 1440p60, `avc1.640034` for 2160p60.
- **Blurring motion inside the page needs extra Source sampling.** Each output frame samples the latest Source frame at or before its timestamp, so blurring the page's own motion, such as scrolling, needs more than one sample per output frame. Camera and Cursor blur do not: the camera track and the pointer path are known at any moment, so a frame composes one Source frame at several moments and averages them. On the same M4, a 7.4 s Take of `examples/basic.mjs` with the default half-frame shutter, which blurred the camera on 82 of its 442 frames and the Cursor on 36, rendered at 0.82× realtime at 2160p60 against 0.85× without blur, and at 2.56× at 1080p60 either way. A frame whose camera moves fast composes up to 16 moments, so a Take that pans more often costs more.
- **Memory for long Takes is unmeasured.** Peak browser memory was 1.3–1.5 GB for the 15 s Take.
