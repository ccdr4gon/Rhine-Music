import { closeWords, parseLrc, MAX_LYRIC_LINES, type LyricLine, type LyricWord, type Lyrics } from "../../lyrics";

/**
 * What Rhine reads of the lyrics NetEase has loaded for the song it plays (debug_port.rs `lyrics`,
 * with the owner's consent, 2026-10-17). Kept in memory only, never logged.
 */
export interface DebugLyrics {
  /** "failed": NetEase could not load the song's lyrics (its server, say); asked again later. */
  status: "ready" | "loading" | "asked" | "none" | "changed" | "failed";
  /** Each line's start (seconds; null when unsynchronised) and text, as NetEase shows them. */
  lines?: [number | null, string][];
  /**
   * NetEase's own adjustment of the song's lyrics (seconds, positive sooner; set in NetEase), already in
   * `lines`' times but not in its word timing, which its own lyrics move as they are shown.
   */
  offset?: number;
  /** Each line's translation, aligned with `lines` ("" for none). */
  translations?: string[];
  /** NetEase's word-timed lyrics ("yrc") and their translation (LRC text). */
  words?: string;
  wordsTranslation?: string;
}

const STAMP = /\((\d+),(\d+),-?\d+\)/g;

/**
 * NetEase's word-timed lyrics: a line per `[start,length]` (milliseconds), each word led by
 * `(start,length,0)`. Lines without words are left out.
 */
export function parseYrc(text: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const head = /^\s*\[(\d+),(\d+)\]/.exec(raw);
    if (!head) continue;
    const body = raw.slice(head[0].length);
    const stamps = [...body.matchAll(STAMP)];
    const words: LyricWord[] = [];
    for (const [index, stamp] of stamps.entries()) {
      const from = stamp.index! + stamp[0].length;
      const word = body.slice(from, stamps[index + 1]?.index ?? body.length);
      if (!word) continue;
      const start = Number(stamp[1]) / 1000;
      words.push({ start, end: start + Number(stamp[2]) / 1000, text: word });
    }
    const plain = (words.length ? words.map((word) => word.text).join("") : body.replace(STAMP, "")).replace(/\s+/g, " ").trim();
    if (!plain) continue;
    const start = Number(head[1]) / 1000;
    lines.push({ start, end: start + Number(head[2]) / 1000, text: plain.slice(0, 300), ...(words.length ? { words } : {}) });
    if (lines.length >= MAX_LYRIC_LINES) break;
  }
  return lines.sort((a, b) => a.start - b.start);
}

/** Text compared without spaces, punctuation or case (a credit line that is also a sung line). */
const plainText = (text: string) => text.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");

/** Lines (and their words) `by` seconds sooner. */
function sooner(lines: LyricLine[], by: number): LyricLine[] {
  if (!by) return lines;
  return lines.map((line) => ({
    ...line,
    start: line.start - by,
    ...(line.end !== undefined ? { end: line.end - by } : {}),
    ...(line.words ? { words: line.words.map((word) => ({ ...word, start: word.start - by, end: word.end - by })) } : {}),
  }));
}

/** Each translation on the line that starts nearest it (within a second), one per line. */
function attachTranslations(lines: LyricLine[], translations: { start: number; text: string }[]) {
  for (const translation of translations) {
    const text = translation.text.trim();
    if (!text) continue;
    // The last line starting by a second after it; the nearest is among its neighbours.
    let low = 0, high = lines.length - 1, at = 0;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (lines[middle].start <= translation.start + 1) {
        at = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    let best = -1, distance = 1;
    for (let index = Math.max(0, at - 3); index <= Math.min(lines.length - 1, at + 3); index += 1) {
      const gap = Math.abs(lines[index].start - translation.start);
      if (gap < distance && !lines[index].translation) {
        best = index;
        distance = gap;
      }
    }
    if (best >= 0) lines[best].translation = text;
  }
}

/**
 * The lyrics NetEase has loaded, in Rhine's shape. With word-timed lyrics: their lines and words,
 * with NetEase's credit lines (作词, 作曲…: its lines before the first and after the last timed one)
 * around them, and the translation timed for them (else the lines' own, by the nearest time).
 * Otherwise NetEase's lines with their translations: synchronised when every line has a time. Null
 * when there is nothing to show.
 */
export function neteaseLyrics(reply: DebugLyrics): Lyrics | null {
  if (reply.status !== "ready") return null;
  const given = (reply.lines ?? []).map(([time, text], index) => ({
    time: typeof time === "number" && Number.isFinite(time) ? Math.max(0, time) : null,
    text: text.replace(/\s+/g, " ").trim(),
    translation: reply.translations?.[index]?.replace(/\s+/g, " ").trim() || undefined,
  }));
  // NetEase's offset is in its lines' times already; its word timing and that one's translation take it here.
  const offset = typeof reply.offset === "number" && Number.isFinite(reply.offset) ? reply.offset : 0;
  const timed = reply.words ? sooner(parseYrc(reply.words), offset) : [];
  if (timed.length) {
    closeWords(timed);
    const own = reply.wordsTranslation ? parseLrc(reply.wordsTranslation) : null;
    attachTranslations(timed, own?.synced
      ? own.lines.map((line) => ({ start: line.start - offset, text: line.text }))
      : given.flatMap((line) => (line.time !== null && line.translation ? [{ start: line.time, text: line.translation }] : [])));
    const first = timed[0], last = timed[timed.length - 1];
    const end = last.end ?? last.start;
    const credit = (line: (typeof given)[number], before: boolean) =>
      line.time !== null && !!line.text && (before ? line.time < first.start - 0.05 && plainText(line.text) !== plainText(first.text)
        : line.time > end + 0.05 && plainText(line.text) !== plainText(last.text));
    const plain = (line: (typeof given)[number]): LyricLine => ({ start: line.time!, text: line.text });
    const head = given.filter((line) => credit(line, true)).map(plain);
    const tail = given.filter((line) => credit(line, false)).map(plain);
    return { lines: [...head, ...timed, ...tail].sort((a, b) => a.start - b.start).slice(0, MAX_LYRIC_LINES), synced: true };
  }
  const shown = given.filter((line) => line.text);
  if (!shown.length) return null;
  const synced = shown.every((line) => line.time !== null);
  const lines: LyricLine[] = shown.slice(0, MAX_LYRIC_LINES).map((line) => ({
    start: synced ? line.time! : 0,
    text: line.text,
    ...(line.translation ? { translation: line.translation } : {}),
  }));
  // NetEase puts its credit lines first and last; a credit timed after the first words goes in its place.
  return { synced, lines: synced ? lines.sort((a, b) => a.start - b.start) : lines };
}
