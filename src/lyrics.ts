/**
 * Lyrics for a song's details (scene 2; the owner, 2026-10-17: "see if you can add dynamic lyrics
 * there"): what a source gives, made one shape. Lines in time order, each with its start and
 * possibly its end (seconds), its text, its translation and, when the source times each word, its
 * words. Unsynchronised lyrics (no times) show as text that does not follow the song. A local
 * song's lyrics (its .lrc beside it, else its tags) come here as LRC text (parseLrc, after
 * decodeLyricBytes); NetEase's own are put together in netease_music/data/lyrics.ts.
 */
export interface LyricWord {
  start: number;
  end: number;
  text: string;
}
export interface LyricLine {
  /** Seconds into the song (below 0 for a line an offset moved before the song; already past at its
   * start); 0 for unsynchronised lyrics. */
  start: number;
  /** When the source says the line ends before the next one starts (a pause between them). */
  end?: number;
  /** "" for a pause between lines (an empty timed line of an LRC file). */
  text: string;
  translation?: string;
  words?: LyricWord[];
}
export interface Lyrics {
  lines: LyricLine[];
  /** Times are known: the current line follows the song. */
  synced: boolean;
}

/** Lyrics longer than this are cut: no song has them. */
export const MAX_LYRIC_LINES = 2000;
const MAX_LINE = 300;

const clip = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, MAX_LINE);

/** `mm:ss`, `mm:ss.xx` or `mm:ss:xx` (an LRC time tag's inside) in seconds. */
export function lrcTime(tag: string): number | undefined {
  const match = /^\s*(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\s*$/.exec(tag);
  if (!match) return undefined;
  const fraction = match[3] ? Number(match[3]) / 10 ** match[3].length : 0;
  return Number(match[1]) * 60 + Number(match[2]) + fraction;
}

const WORD_STAMP = /<(\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?)>/;
const WORD_STAMPS = new RegExp(WORD_STAMP.source, "g");
/** The LRC metadata tags (`[ar:…]`): only these are taken out; "[Verse 1: Someone]" is a line's words. */
const METADATA = /^(?:ar|al|ti|au|by|re|ve|length|offset|tool|la|lang|id|kana|#)\s*:/i;

/** An enhanced LRC line's words: `<mm:ss.xx>` before each one; a last stamp alone ends the line's last word. */
function timedWords(text: string): { words: LyricWord[]; close?: number } | undefined {
  if (!WORD_STAMP.test(text)) return undefined;
  const parts = text.split(new RegExp(WORD_STAMP.source, "g"));
  const words: LyricWord[] = [];
  let close: number | undefined;
  for (let index = 1; index < parts.length; index += 2) {
    const start = lrcTime(parts[index]);
    if (start === undefined) return undefined;
    const word = parts[index + 1] ?? "";
    if (words.length) words[words.length - 1].end = start;
    if (word) words.push({ start, end: start, text: word });
    else close = start;
  }
  if (parts[0].trim() && words.length) words.unshift({ start: words[0].start, end: words[0].start, text: parts[0] });
  if (!words.length) return undefined;
  if (close !== undefined && close > words[words.length - 1].start) words[words.length - 1].end = close;
  else close = undefined;
  return { words, close };
}

/** NetEase's credit lines in its own lyrics files: `{"t":ms,"c":[{"tx":"作词: "},{"tx":"…"}]}`. */
function creditLine(line: string): { time: number; text: string } | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(line) as { t?: unknown; c?: { tx?: unknown }[] };
    if (typeof value.t !== "number" || !Number.isFinite(value.t) || !Array.isArray(value.c) || !value.c.length) return undefined;
    const parts = value.c.map((part) => (typeof part?.tx === "string" ? part.tx : ""));
    return { time: Math.max(0, value.t / 1000), text: parts[0] + parts.slice(1).filter(Boolean).join(" ") };
  } catch {
    return undefined;
  }
}

interface Entry {
  time?: number;
  text: string;
  words?: LyricWord[];
  close?: number;
  order: number;
}

/**
 * LRC text: lines led by one or more `[mm:ss.xx]` tags (a line sung more than once has several),
 * metadata tags (`[ar:…]`; `[offset:±ms]` moves every line, positive sooner), enhanced LRC word
 * stamps (`<mm:ss.xx>`) and NetEase's JSON credit lines. Two lines at the same time are a line and
 * its translation (bilingual files). An empty timed line is a pause. Text without times is
 * unsynchronised lyrics, its lines in order. Null when there is no text at all.
 */
export function parseLrc(text: string): Lyrics | null {
  const entries: Entry[] = [];
  let offset = 0;
  let order = 0;
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/)) {
    let rest = raw.trim();
    if (!rest) continue;
    const credit = creditLine(rest);
    if (credit) {
      entries.push({ time: credit.time, text: clip(credit.text), order: order++ });
      continue;
    }
    const times: number[] = [];
    let tagged = false;
    for (let tag = /^\[([^\]]*)\]/.exec(rest); tag; tag = /^\[([^\]]*)\]/.exec(rest)) {
      const time = lrcTime(tag[1]);
      if (time !== undefined) times.push(time);
      else if (METADATA.test(tag[1])) {
        // A metadata tag: only the offset counts.
        const shift = /^offset:\s*([+-]?\d+)\s*$/i.exec(tag[1]);
        if (shift) offset = Number(shift[1]);
        tagged = true;
      } else break; // "[Chorus]" and the like are words of the line.
      rest = rest.slice(tag[0].length).trimStart();
    }
    if (tagged && !times.length && !rest) continue;
    const timed = timedWords(rest);
    // Word stamps without words (a line of empty timed parts) are no text either.
    const plain = clip(timed ? timed.words.map((word) => word.text).join("") : rest.replace(WORD_STAMPS, ""));
    if (!times.length) {
      if (plain) entries.push({ text: plain, order: order++ });
      continue;
    }
    // A line sung more than once: its word stamps belong to the time nearest its first word; the same
    // words move with each of the others.
    const own = timed ? times.reduce((best, time) => (Math.abs(time - timed.words[0].start) < Math.abs(best - timed.words[0].start) ? time : best)) : 0;
    for (const time of times) {
      const moved = timed ? time - own : 0;
      const words = moved ? timed!.words.map((word) => ({ ...word, start: word.start + moved, end: word.end + moved })) : timed?.words;
      entries.push({ time, text: plain, words: plain ? words : undefined, close: timed?.close !== undefined ? timed.close + moved : undefined, order: order++ });
    }
  }
  const timed = entries.filter((entry) => entry.time !== undefined && entry.text);
  const untimed = entries.filter((entry) => entry.time === undefined);
  if (!timed.length) {
    const lines = untimed.slice(0, MAX_LYRIC_LINES).map((entry) => ({ start: 0, text: entry.text }));
    return lines.length ? { lines, synced: false } : null;
  }
  if (untimed.length > timed.length) {
    // Mostly untimed: the few times are noise; show it all as text.
    const lines = entries.filter((entry) => entry.text).slice(0, MAX_LYRIC_LINES).map((entry) => ({ start: 0, text: entry.text }));
    return { lines, synced: false };
  }
  const shift = offset / 1000;
  const sorted = entries
    .filter((entry) => entry.time !== undefined)
    .map((entry) => ({ ...entry, time: entry.time! - shift, words: entry.words?.map((word) => ({ ...word, start: word.start - shift, end: word.end - shift })) }))
    .sort((a, b) => a.time - b.time || a.order - b.order);
  const lines: LyricLine[] = [];
  for (const entry of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.start - entry.time) < 0.005) {
      // The same time again: the translation (or the text, after a pause marker).
      if (!entry.text) continue;
      if (!last.text) {
        last.text = entry.text;
        last.words = entry.words;
      } else last.translation = last.translation ? `${last.translation} ${entry.text}` : entry.text;
      continue;
    }
    // Pauses: none before the first words, never two in a row.
    if (!entry.text && (!last || !last.text)) continue;
    lines.push({ start: entry.time, text: entry.text, ...(entry.words ? { words: entry.words } : {}), ...(entry.close !== undefined ? { end: Math.max(entry.time, entry.close - shift) } : {}) });
    if (lines.length >= MAX_LYRIC_LINES) break;
  }
  closeWords(lines);
  return lines.some((line) => line.text) ? { lines, synced: true } : null;
}

/**
 * A line's last word ends where the line ends, else where the next one starts, but not much later
 * than its words go (a long pause after a line without an end would draw its last word out).
 */
export function closeWords(lines: LyricLine[]) {
  for (const [index, line] of lines.entries()) {
    const words = line.words;
    if (!words?.length) continue;
    const next = lines[index + 1]?.start ?? Infinity;
    const last = words[words.length - 1];
    if (last.end > last.start) continue;
    const span = words.length > 1 ? (last.start - words[0].start) / (words.length - 1) : 1;
    last.end = Math.max(last.start + 0.05, Math.min(line.end ?? next, last.start + Math.min(3, Math.max(0.5, span * 1.5))));
  }
}

/** The line sung at `seconds`: the last one that has started, -1 before the first or in a pause after a line's end. */
export function lineAt(lines: readonly LyricLine[], seconds: number) {
  let low = 0, high = lines.length - 1, found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (lines[middle].start <= seconds) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  const line = lines[found];
  return line && line.end !== undefined && seconds >= line.end ? -1 : found;
}

/** When the line shown changes next after `seconds` (the next start, or the current line's end). */
export function nextChange(lines: readonly LyricLine[], seconds: number): number | undefined {
  let low = 0, high = lines.length - 1, next = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (lines[middle].start > seconds) {
      next = middle;
      high = middle - 1;
    } else low = middle + 1;
  }
  const current = lines[next < 0 ? lines.length - 1 : next - 1];
  const end = current?.end !== undefined && current.end > seconds ? current.end : undefined;
  const start = next < 0 ? undefined : lines[next].start;
  return end === undefined ? start : start === undefined ? end : Math.min(end, start);
}

/**
 * A lyrics file's bytes as text: by its byte-order mark, else UTF-16 when every other byte of its
 * start is zero (text has no zero bytes otherwise), else UTF-8 when the bytes are UTF-8, else
 * GB 18030 (GBK: how most Chinese .lrc files not in UTF-8 are saved).
 */
export function decodeLyricBytes(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  if (bytes.length >= 4 && bytes[1] === 0 && bytes[3] === 0 && bytes[0] !== 0) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[2] === 0 && bytes[1] !== 0) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Not UTF-8.
  }
  try {
    return new TextDecoder("gb18030").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
