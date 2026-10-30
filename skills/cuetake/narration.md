# Narration and Subtitles

A Narration is spoken commentary: Lines in one language, which you write and a separate speech tool voices. CueTake places each Line's audio, mixes it into the Final and draws Subtitles from its text. It never synthesizes speech itself (ADR 0006). Voice the Lines **before** recording, so `d.say` can hold each Line for as long as it is spoken and the picture follows the voice.

## 1. Write and voice the Lines

Write one Line per beat of the demo, in the language the user asked for: a short phrase the viewer hears while the action happens. Have the speech tool the user chose write one audio file per Line (WAV, MP3, M4A, Ogg or FLAC). If none is set up yet, ask the user which one to use. Speech models and their licences are the user's choice, and narration text leaves the machine only when the tool they choose is a cloud service. For a quick pacing draft on macOS, `say -o intro.wav --data-format=LEI16@24000 "Invite a teammate."` works.

Then write `narration.json` beside the audio:

```json
{
  "language": "en",
  "lines": [
    { "id": "intro", "text": "Invite a teammate by email.", "audio": "intro.wav" },
    { "id": "send", "text": "Then send the invite.", "audio": "send.wav",
      "words": [{ "text": "Then", "start": 0.08, "end": 0.3 }] }
  ]
}
```

- `id`: letters, digits, `.`, `-` and `_`; unique in the file.
- `text`: what the audio says. Subtitles show it.
- `audio`: a path relative to the file.
- `words` (optional): word timings from the speech tool or an aligner, in seconds from the start of the Line's audio. With them Subtitles change exactly as each word is spoken; without them, time is spread across the Line by character count.
- `start` (optional): seconds from the start of the Take, for a Line the Scenario does not say.

CueTake measures each Line's duration from its audio; any duration the file states is ignored.

## 2. Say each Line in the Scenario

```js
export async function run(d) {
  await d.at(0.5);
  await d.say('intro');                 // holds until the intro audio ends
  await d.type(d.page.getByLabel('Email'), 'ada@example.com');
  await d.say('send');
  await d.click(d.page.getByRole('button', { name: 'Send invite' }));
  await d.wait(2000);
}
```

Record with `record <scenario> --out <take> --narration narration.json`. The Narration and its audio are copied into the Take's `narration/` folder first. Each `d.say(id)` starts its Line and waits for its audio to end, and the Line's start seeds `edit.json`. To speak over an action, start it without awaiting the Line: `const intro = d.say('intro'); await d.click(...); await intro;`.

Without `--narration`, `d.say(id, text)` only marks where a Line starts and does not wait. Use it for a first draft, then import audio for the same ids.

`record` reports the Lines that were never said and have no `start`; Render leaves them out.

## 3. Change Lines after recording

- **New audio or text**: voice again, then `narrate import <take> narration.json`. It replaces the Take's Narration. Lines keep their start in `edit.json`, and a new Line takes the `start` the file gives it. The command reports each Line's start and duration, and any Line that overlaps the next one or runs past the end.
- **Timing and volume**: `edit.json` holds `narration: { volume, lines: [{ id, start, volume }] }`. Change `start` (seconds) or `volume` (1 is as recorded), then `render`. You only need to record again when the picture must change to make room.

A Line that overlaps the next one, runs past the end of the Final or is spoken while the Final fast-forwards ([scenarios.md](scenarios.md)) stops `render` and `verify`, with an error naming the Line and the seconds involved. Move or shorten the Line; CueTake never moves Lines or stretches the picture.

## Subtitles

`render` always writes `subtitles.srt` and `subtitles.vtt` into the Take. By default it also burns them into the Final, drawn outside the camera so they keep their size while it zooms. Rows hold about 16 characters in Chinese, Japanese and Korean and about 42 otherwise, and break at a sentence or clause end where one is near. Each cue has up to two rows and stays on screen at least a second.

Subtitles are an item in the Edit, and a Look can save them like the cursor: see [styling.md](styling.md). Set `"subtitles": { "burn": false }` to keep them to the files.

Burned-in Chinese, Japanese or Korean needs a font. On macOS the built-in uses PingFang SC. Anywhere else, `render` stops until the Edit or Look names a font file as `subtitles.files.font`.

## Audio in the Final

The Final gets one mono 48 kHz track: AAC where the platform encodes it (macOS, Windows), Opus otherwise. `render.json` records which. `verify` checks that:

- the track decodes and lasts as long as the video;
- every Line's audio decodes;
- no Lines overlap and none runs past the end;
- the subtitle files match the Lines;
- burned-in Subtitles were drawn while each Line is spoken.
