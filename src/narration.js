/**
 * Narration timing and Subtitles, shared by Node and the render page. Pure functions, no imports.
 *
 * A placed Line is `{ id, text, start, duration, words? }`: `start` is seconds of Source time,
 * `duration` is measured from its audio, and each word is `{ text, start, end }` in seconds from the
 * start of the Line's audio. Subtitle cues are `{ id, start, end, rows }`, `id` naming their Line.
 */

const CJK = /[⺀-鿿豈-﫿＀-￯]/u;
const SENTENCE_END = /[.!?。！？…]["'”’）)]*$/u;
const CLAUSE_END = /[,;:，、；：—–]["'”’）)]*$/u;
// Closing punctuation never starts a row; it joins what it follows.
const CLOSING = /^[.,;:!?)\]}'"”’。，、；：！？）》」』…]/u;
/** The characters that are spoken, which word timings count: no spaces or punctuation. */
const spoken = text => Array.from(text.replace(/[\s\p{P}\p{S}]/gu, '')).length;
const length = text => Array.from(text).length;

/** Whether `text` (or a language tag such as zh-CN) is written without spaces between words. */
export const isCjk = (text, language) => /^(zh|ja|ko)\b/i.test(language ?? '') || CJK.test(text);

/**
 * The text broken into atoms that rows never split: a CJK character or a run of other non-space
 * characters, with any closing punctuation after it. `space` marks a space before the atom.
 */
function atoms(text) {
  const list = [];
  for (const [piece] of text.trim().matchAll(/\s+|[⺀-鿿豈-﫿＀-￯]|[^\s⺀-鿿豈-﫿＀-￯]+/gu)) {
    if (/^\s+$/u.test(piece)) { if (list.length) list.at(-1).spaceAfter = true; continue; }
    const last = list.at(-1);
    if (last && !last.spaceAfter && CLOSING.test(piece)) last.text += piece;
    else list.push({ text: piece, space: Boolean(last?.spaceAfter) });
  }
  return list;
}
/** How good a break after `atom` is: sentence end, clause end, between words, inside CJK text. */
const breakScore = (atom, next) => SENTENCE_END.test(atom.text) ? 3 : CLAUSE_END.test(atom.text) ? 2 : next?.space ? 1 : 0.5;
const join = list => list.map((atom, i) => (i && atom.space ? ' ' : '') + atom.text).join('');

/**
 * The text as subtitle rows of at most `maxChars` characters, broken at the best place: a sentence
 * end after the first third of an even row, then a clause end after its first half, then the word
 * boundary nearest an even width, so a Line one word too long does not leave that word alone on a
 * row. A single word longer than a row gets a row of its own.
 */
export function subtitleRows(text, maxChars) {
  const total = length(text.trim()), even = Math.min(maxChars, Math.ceil(total / Math.ceil(total / maxChars)));
  const least = { 3: even * 0.3, 2: even * 0.5 };
  const rows = [];
  let row = [];
  for (const atom of atoms(text)) {
    row.push(atom);
    if (row.length < 2 || length(join(row)) <= maxChars) continue;
    let cut = row.length - 1, best = -1, distance = Infinity;
    for (let i = 0; i < row.length - 1; i++) {
      const score = breakScore(row[i], row[i + 1]), prefix = length(join(row.slice(0, i + 1)));
      if (prefix < (least[score] ?? 0)) continue;
      if (score > best || (score === best && Math.abs(prefix - even) < distance)) { best = score; distance = Math.abs(prefix - even); cut = i + 1; }
    }
    rows.push(join(row.slice(0, cut)));
    row = row.slice(cut);
  }
  if (row.length) rows.push(join(row));
  return rows;
}

/**
 * When a Line's spoken characters are said, in seconds from the start of its audio: `start(k)` when
 * the `k`th begins and `end(k)` when the one before it ends. With word timings each character takes
 * an equal share of its word, so a pause between words shows as a gap; without, of the whole Line.
 */
function clock(line) {
  const total = spoken(line.text);
  if (!line.words?.length) { const at = k => line.duration * (total ? k / total : 0); return { start: at, end: at }; }
  const spans = [];
  let count = 0;
  for (const word of line.words) { const n = Math.max(1, spoken(word.text)); spans.push({ from: count, n, ...word }); count += n; }
  const at = (k, closing) => {
    const position = total ? k * count / total : 0;
    const span = spans.find(s => closing ? position <= s.from + s.n : position < s.from + s.n) ?? spans.at(-1);
    return span.start + (span.end - span.start) * Math.min(1, Math.max(0, (position - span.from) / span.n));
  };
  return { start: k => at(k, false), end: k => at(k, true) };
}

/**
 * Subtitle cues for placed Lines: each Line's rows, `maxRows` to a cue (a cue also ends after a
 * sentence), shown while they are spoken. A cue shorter than `minDuration` takes time from the next
 * cue of its Line, or from the silence after its Line, up to `end`, the end of the Final.
 */
export function subtitleCues(lines, { language, maxChars, maxRows = 2, minDuration = 1, end = Infinity } = {}) {
  const cues = [];
  for (const line of [...lines].sort((a, b) => a.start - b.start)) {
    const width = maxChars ?? (isCjk(line.text, language) ? 16 : 42), said = clock(line);
    const groups = [];
    for (const row of subtitleRows(line.text, width)) {
      const last = groups.at(-1);
      if (last && last.length < maxRows && !SENTENCE_END.test(last.at(-1))) last.push(row); else groups.push([row]);
    }
    let k = 0;
    const own = groups.map(rows => {
      const n = rows.reduce((sum, row) => sum + spoken(row), 0);
      const cue = { id: line.id, start: line.start + said.start(k), end: line.start + (k + n >= spoken(line.text) ? line.duration : said.end(k + n)), rows };
      k += n;
      return cue;
    });
    cues.push(...own);
  }
  for (const [i, cue] of cues.entries()) {
    if (cue.end - cue.start >= minDuration) continue;
    const next = cues[i + 1], want = cue.start + minDuration;
    if (next?.id === cue.id) cue.end = next.start = Math.min(want, Math.max(cue.end, (cue.start + next.end) / 2));
    else cue.end = Math.min(want, next ? Math.max(cue.end, next.start) : Math.max(cue.end, end));
  }
  return cues;
}

/** Whether the Edit's `subtitles` item draws them into the Final; otherwise they go only to the subtitle files. */
export const burnsIn = subtitles => Boolean(subtitles) && subtitles.burn !== false;

/** The cues of placed Lines as the Edit's `subtitles` item lays them out, ending by `end`. */
export const cuesFor = (lines, language, subtitles, end) => subtitleCues(lines, { language, maxChars: subtitles?.maxChars, maxRows: subtitles?.maxRows, minDuration: subtitles?.minDuration, end });

/**
 * What stops Lines from playing as placed: a Line overlapping the next one, starting before the
 * Take, or running past the end of the Final (`end` seconds). Each problem names its Line.
 */
export function lineProblems(lines, end) {
  const sorted = [...lines].sort((a, b) => a.start - b.start), problems = [];
  const seconds = s => `${s.toFixed(2)} s`;
  for (const [i, line] of sorted.entries()) {
    const next = sorted[i + 1], stops = line.start + line.duration;
    if (line.start < 0) problems.push(`Line '${line.id}' starts ${seconds(-line.start)} before the Take`);
    if (next && stops > next.start + 0.005) problems.push(`Line '${line.id}' overlaps '${next.id}' by ${seconds(stops - next.start)}`);
    if (stops > end + 0.005) problems.push(`Line '${line.id}' runs ${seconds(stops - end)} past the end of the Final`);
  }
  return problems;
}

const stamp = (seconds, separator) => {
  const ms = Math.max(0, Math.round(seconds * 1000)), pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`;
};
/** Cues as a SubRip (.srt) file. */
export const toSrt = cues => cues.map((cue, i) => `${i + 1}\n${stamp(cue.start, ',')} --> ${stamp(cue.end, ',')}\n${cue.rows.join('\n')}\n`).join('\n');
/** Cues as a WebVTT (.vtt) file. */
export const toVtt = cues => `WEBVTT\n\n${cues.map(cue => `${stamp(cue.start, '.')} --> ${stamp(cue.end, '.')}\n${cue.rows.join('\n')}\n`).join('\n')}`;
