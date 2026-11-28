# Subtitle rows break at Phrases the agent marks, not by a dictionary

Chinese and Japanese write no spaces between words, so a Subtitle row needs to know where a word ends before it can break there. The agent that writes a Line knows its words and phrases; CueTake does not. So a Line may carry `phrases`, its text cut into the runs a row never splits, and CueTake breaks rows by width only: at a sentence end, then a clause end, then a Phrase boundary, then a space, then between two CJK characters. The Phrases join to the Line's text exactly, so the characters that word timings count are the same and the Subtitles still change as each word is spoken. The agent writes them with the Line, before voicing: a speech tool fills in only a Line's audio and word timings, so which tool voices the Narration does not matter (ADR 0006).

## Considered options

- **CueTake finds words with the `Intl.Segmenter` dictionary**, as it did before this ADR. Rejected: the dictionary leaves a word it does not know as lone characters, and no scoring of lone characters keeps every word whole: a lone character before a word can be its first character or a word of its own.
- **Phrase marks inside the text**, such as a separator character. Rejected: the text is what Subtitles show and what word timings and `word()` count, so every reader of it would have to strip the marks.
- **The speech tool's word timings as the word boundaries.** Rejected: voxx times Chinese one character at a time, and other tools may give no timings at all.

## Consequences

- A Line whose `phrases` do not join to its text stops `record` and `narrate import`, naming the Line and the character where they part, so a Line edited without its Phrases is found before Render.
- A Line without `phrases` still renders: rows break at spaces, and in CJK text between any two characters, nearest an even width. The skill asks for Phrases in Chinese and Japanese Lines; Korean breaks at its spaces.
- Rows are still broken once in Node and handed to the render page and verify, so the burned-in Subtitles and the subtitle files agree.
