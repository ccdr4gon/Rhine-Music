import { escapeHtml } from "./html.ts";
import type { MusicAlbum } from "./music-types.ts";
import type { QueueTrack } from "./external-queue.ts";

/**
 * The DOM half of the song scene: a tilted glass sheet with the playlist as text, a title
 * plate floating in front of it, and the flat chrome around the large 3D card. Models and
 * geometry are pure functions; SongListView only applies them.
 */
export interface SongRow {
  /** Unique id of the row. Album rows: the track id; queue rows: the shelf record id of that song. */
  key: string;
  number: string;
  title: string;
  artist: string;
  /** Right-aligned, e.g. "FLAC · 4:05" or "4:05". */
  meta: string;
  /** Album rows: rendered as data-track (the document click handler plays it). */
  track?: string;
  /** Queue rows: rendered as data-select, the record index of that song's box. */
  select?: number;
  disabled?: boolean;
  /** Heading shown before this row when it differs from the previous row's group. */
  group?: string;
}
export interface SongListModel {
  kind: "album" | "queue";
  /** Identity of the rows: their DOM is rebuilt only when this changes. */
  id: string;
  caption: string;
  title: string;
  subtitle: string;
  overline: string;
  count: string;
  label: string;
  note?: string;
  empty?: string;
  rows: SongRow[];
}

const pad = (value: number, width: number) => String(value).padStart(width, "0");

/** FNV-1a over everything the rows show, so an id changes exactly when they must be rebuilt. */
function digest(parts: Iterable<string | number>) {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    const text = String(part);
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
    hash = Math.imul(hash ^ 0x1f, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function albumSongModel(
  album: MusicAlbum,
  options: { number: number; demo: boolean; time(seconds: number): string },
): SongListModel {
  const { tracks } = album;
  const discs = album.discCount || Math.max(1, ...tracks.map((track) => track.discNumber || 1));
  const rows: SongRow[] = tracks.map((track, index) => ({
    key: track.id,
    number: pad(track.trackNumber || index + 1, 2),
    title: track.title,
    artist: track.artist,
    meta: [`${track.format}${track.browserPlayable ? "" : " ↗"}`.trim(), options.time(track.duration)].filter(Boolean).join(" · "),
    track: track.id,
    disabled: album.offline,
    group: discs > 1 ? `DISC ${pad(track.discNumber || 1, 2)}` : undefined,
  }));
  const notes = [
    album.offline ? "目录离线，曲目暂时无法播放。" : "",
    tracks.some((track) => !track.browserPlayable) ? "↗ 需要兼容的播放内核。" : "",
  ].filter(Boolean);
  return {
    kind: "album",
    id: `album:${album.id}:${digest(rows.flatMap((row) => [row.key, row.number, row.title, row.artist, row.meta, row.group ?? "", row.disabled ? 1 : 0]))}`,
    caption: `ALBUM ${pad(options.number, 3)}${album.year ? ` / ${album.year}` : ""}`,
    title: album.title,
    subtitle: album.artist,
    overline: "TRACKS / 歌单",
    count: tracks.length
      ? `${tracks.length} ${tracks.length === 1 ? "TRACK" : "TRACKS"} · ${options.time(tracks.reduce((sum, track) => sum + track.duration, 0))}`
      : "0 TRACKS",
    label: album.artist,
    note: notes.join(" ") || undefined,
    empty: tracks.length ? undefined
      : options.demo ? "这是一张封面演示卡片，扫描本地音乐库后这里会显示真实曲目。" : "这个专辑还没有可播放曲目。",
    rows,
  };
}

export function queueSongModel(
  tracks: readonly QueueTrack[],
  options: {
    stamp: string;
    truncated: boolean;
    selected?: QueueTrack;
    keyOf(track: QueueTrack): string;
    indexOf(key: string): number;
    time(seconds: number): string;
    note?: string;
    /** The playlist column this list is, when the shelf's columns are playlists. */
    lane?: { name: string; live: boolean };
  },
): SongListModel {
  const total = tracks.length;
  const selectedKey = options.selected ? options.keyOf(options.selected) : undefined;
  let position = -1;
  // The stamp covers what the queue says; the boxes the rows point at come from the shelf.
  const boxes: number[] = [];
  const rows: SongRow[] = tracks.map((track, index) => {
    const key = options.keyOf(track);
    const select = options.indexOf(key);
    if (position < 0 && key === selectedKey) position = index;
    boxes.push(select);
    return {
      key,
      number: pad(index + 1, 3),
      title: track.title,
      artist: track.artist || "歌手未提供",
      meta: track.duration ? options.time(track.duration) : "",
      select: select < 0 ? undefined : select,
      disabled: select < 0,
    };
  });
  const selected = options.selected;
  // A playlist column names itself; NetEase's own queue keeps its captions.
  const lane = options.lane, name = lane?.name ?? "播放队列", word = lane && !lane.live ? "NETEASE PLAYLIST" : "NETEASE QUEUE";
  return {
    kind: "queue",
    id: `queue:${options.stamp}:${total}:${digest(boxes)}`,
    caption: position < 0 ? `${word} / ${pad(total, 3)}` : `${word} / ${pad(position + 1, 3)} · ${pad(total, 3)}`,
    title: selected?.title ?? name,
    subtitle: selected ? [selected.artist || "歌手未提供", selected.album].filter(Boolean).join(" — ") : "",
    overline: `PLAYLIST / ${name}`,
    // The queue is cut at 3000 songs; a playlist column can also be cut by the total across playlists.
    count: `${total} ${total === 1 ? "SONG" : "SONGS"}${options.truncated ? (lane && !lane.live ? "（未显示全部）" : "（前 3000 首）") : ""}`,
    label: `网易云音乐 / ${name}`,
    note: options.note,
    empty: total ? undefined : lane ? "这个歌单是空的。" : "播放队列是空的。",
    rows,
  };
}

/** Inner HTML for <section id="music-song" class="music-song" aria-label="歌曲选择" hidden>. */
export function songSceneMarkup(): string {
  return `<div class="song-chrome">
    <i class="song-rail song-rail-top" aria-hidden="true"></i><i class="song-rail song-rail-bottom" aria-hidden="true"></i><i class="song-marker" aria-hidden="true"></i>
    <button class="music-back" data-action="back"><span>← <span id="song-back-label">返回专辑架</span></span> <kbd>ESC</kbd></button>
    <button class="music-back song-details" data-action="details"><span>↗ <span id="song-details-label">专辑详情</span></span> <kbd>S</kbd></button>
    <p class="song-caption"><i aria-hidden="true"></i><span id="song-label"></span></p>
  </div>
  <div id="song-glass" class="song-glass">
    <div class="song-head"><span class="song-overline"><i class="song-ring" aria-hidden="true"></i><span id="song-overline"></span></span><span id="song-count" class="song-count"></span></div>
    <div id="song-list" class="song-list" role="group" aria-labelledby="song-overline" tabindex="-1"></div>
    <p id="song-note" class="song-note" hidden></p>
  </div>
  <div class="song-float">
    <i class="song-cross song-cross-h" aria-hidden="true"></i><i class="song-cross song-cross-v" aria-hidden="true"></i>
    <div class="song-plate"><small id="song-plate-caption" class="song-plate-caption"></small><h2 id="song-title" class="song-plate-title"></h2><p id="song-subtitle" class="song-plate-subtitle"></p></div>
    <div class="song-stepper" role="group" aria-label="切换专辑"><button id="song-prev" data-action="prev" aria-label="上一张专辑">↑ <span>上一张</span></button><button id="song-next" data-action="next" aria-label="下一张专辑"><span>下一张</span> ↓</button></div>
  </div>`;
}

/** Rows per block of the list; a block away from the visible part is not rendered at all. */
export const SONG_BLOCK_ROWS = 40;

/**
 * The list's rows (or its empty text); every field is plain text. Rows and headings have
 * fixed heights, so each block states its exact size (--rows, --groups) and the list's
 * length never changes while blocks come and go.
 */
export function songRowsMarkup(model: Pick<SongListModel, "rows" | "empty">): string {
  const { rows } = model;
  if (!rows.length) return model.empty ? `<p class="song-empty">${escapeHtml(model.empty)}</p>` : "";
  let group: string | undefined;
  let html = "";
  for (let start = 0; start < rows.length; start += SONG_BLOCK_ROWS) {
    const end = Math.min(rows.length, start + SONG_BLOCK_ROWS);
    let block = "", groups = 0;
    for (let index = start; index < end; index++) {
      const row = rows[index];
      if (row.group && row.group !== group) {
        block += `<div class="song-group">${escapeHtml(row.group)}</div>`;
        groups++;
      }
      group = row.group;
      const target = row.track !== undefined ? ` data-track="${escapeHtml(row.track)}"`
        : row.select !== undefined ? ` data-select="${escapeHtml(String(row.select))}"` : "";
      block += `<button type="button" class="song-row" data-row="${index}"${target} tabindex="-1"${row.disabled ? " disabled" : ""}><span class="song-row-number">${escapeHtml(row.number)}</span><span class="song-row-copy"><strong>${escapeHtml(row.title)}</strong><small>${escapeHtml(row.artist)}</small></span><span class="song-row-meta">${escapeHtml(row.meta)}</span></button>`;
    }
    html += `<div class="song-block" style="--rows:${end - start};--groups:${groups}">${block}</div>`;
  }
  return html;
}

/**
 * Where a roving-focus key moves from row `from` (-1: the list itself has the focus).
 * Disabled rows are skipped. Returns undefined for other keys, and `from` when there is
 * nowhere to go.
 */
export function rovingIndex(
  key: string,
  from: number,
  count: number,
  page: number,
  enabled: (index: number) => boolean = () => true,
): number | undefined {
  const forward = key === "ArrowDown" || key === "PageDown" || key === "Home";
  if (!forward && key !== "ArrowUp" && key !== "PageUp" && key !== "End") return undefined;
  const step = key === "PageDown" || key === "PageUp" ? Math.max(1, page) : 1;
  const start = key === "Home" ? 0
    : key === "End" ? count - 1
      : from < 0 ? (forward ? 0 : count - 1)
        : Math.max(0, Math.min(count - 1, from + (forward ? step : -step)));
  const direction = forward ? 1 : -1;
  // Keep going the way the key points, then settle for the farthest row short of the target.
  for (let i = start; i >= 0 && i < count; i += direction) if (enabled(i)) return i;
  for (let i = start - direction; i !== from && i >= 0 && i < count; i -= direction) if (enabled(i)) return i;
  return from;
}

/**
 * The scroll offset that makes a row comfortably visible, or undefined when it already is.
 * A row just outside moves the list as little as possible; a distant one lands in its
 * upper half.
 */
export function revealScrollTop(
  row: { top: number; height: number },
  scrollTop: number,
  viewport: number,
  content: number,
): number | undefined {
  if (viewport <= 0) return undefined;
  const max = Math.max(0, content - viewport);
  const clamp = (value: number) => Math.max(0, Math.min(max, value));
  const margin = Math.max(0, Math.min(row.height * 1.5, (viewport - row.height) / 2));
  const low = clamp(row.top + row.height + margin - viewport);
  const high = clamp(row.top - margin);
  if (scrollTop >= low - 0.5 && scrollTop <= high + 0.5) return undefined;
  const nearest = scrollTop < low ? low : high;
  if (Math.abs(nearest - scrollTop) <= viewport) return Math.round(nearest);
  return Math.round(clamp(row.top - (viewport - row.height) * 0.4));
}

/** Title sizes of the plate, in layout units, largest first. */
export const PLATE_TITLE_SIZES = { l: 4.3, m: 3.1, s: 2.3 } as const;
export type PlateTitleSize = keyof typeof PLATE_TITLE_SIZES;

/**
 * A title's width in ems of the plate's bold face, rounded up a little: full-width
 * characters and long dashes count 1, capitals about three quarters, small letters 0.6.
 */
export function titleWidth(title: string) {
  let width = 0;
  for (const character of title) {
    const code = character.codePointAt(0)!;
    width += code >= 0x1100 || character === "—" || character === "…" ? 1
      : character === " " ? 0.3
        : /[MWmw@%]/.test(character) ? 1
          : /[Iijl.,:;!'|()[\]]/.test(character) ? 0.36
            : /[A-Z&#]/.test(character) ? 0.76
              : /[0-9]/.test(character) ? 0.64 : 0.6;
  }
  return width;
}

/** The largest size at which the title fits one line of `capacity` units; "s" may wrap to two. */
export function plateTitleSize(title: string, capacity: number): PlateTitleSize {
  const width = titleWidth(title);
  return width * PLATE_TITLE_SIZES.l <= capacity ? "l" : width * PLATE_TITLE_SIZES.m <= capacity ? "m" : "s";
}

export interface SongCard { x: number; y: number; width: number; height: number }
export interface SongSceneLayout {
  /** "wide": plate beside the list; "stacked": plate on the sheet's top-left corner. */
  mode: "wide" | "stacked";
  /** Pixels per layout unit: 1 % of the picture's shorter side, bounded. */
  unit: number;
  /** The vertical line behind the card and its marker; `shown` is false when they would crowd. */
  rail: { x: number; top: number; bottom: number; marker: number; shown: boolean; markerShown: boolean };
  /** The glass sheet before its transform (centre and size) and the transform itself. */
  glass: { x: number; y: number; width: number; height: number; tilt: number; perspective: number; side: number };
  plate: { x: number; y: number; width: number; height: number };
  /** Crosshair: the vertical line (x, from top to bottom) and the horizontal line's y. */
  cross: { x: number; y: number; top: number; bottom: number };
  /** Stacked: how much of the sheet's top-left corner the plate covers (sheet coordinates). */
  head: { inset: number; height: number };
  /**
   * Where the note goes: "side" is the column left of the list, under the plate and the
   * stepper (wide only, when that column is tall enough); "under" is below the list.
   */
  note: "side" | "under";
}

/**
 * The sheet turns away on its left side. The reference picture turns 25 degrees at a
 * perspective distance of 1.42 sheet widths; rows of text read more comfortably at 18
 * and 1.8, where the slant of the top and bottom rows is about half as steep.
 */
const PERSPECTIVE = 1.8;
const TILT = { wide: 18, stacked: 12, portrait: 6 } as const;
/** Share of the sheet's width left of the list in the wide arrangement. */
const SIDE = 0.36;
const PLATE_HEIGHT = 13;
/** Viewport widths the browser adds around a row before deciding whether to paint it (1.5), with a margin. */
const PAINT_REACH = 1.6;
/** Room kept for the note, in ems of its font: the longest one the app writes is 53 full-width characters. */
const NOTE_EMS = 56;
/**
 * setCard receives the case's nominal face. The drawn case is turned towards the camera,
 * has thickness and a soft glow, and reaches this much further (shares of the face's width
 * and height, measured in the running scene). Zero these if the drawn outline is ever
 * handed over instead.
 */
export const CARD_REACH = { right: 0.075, top: 0.07, bottom: 0.055 } as const;

/** How a sheet turned by `tilt` degrees projects: edge magnifications and reach from its centre. */
function sheetProjection(tilt: number) {
  const radians = (tilt * Math.PI) / 180;
  const depth = Math.sin(radians) / (2 * PERSPECTIVE);
  const near = 1 / (1 - depth), far = 1 / (1 + depth);
  return { radians, near, far, reachNear: (Math.cos(radians) / 2) * near, reachFar: (Math.cos(radians) / 2) * far };
}

/** Screen position of a point of the sheet, given from the sheet's centre (x right, y down). */
export function projectSheet(glass: SongSceneLayout["glass"], x: number, y: number) {
  const radians = (glass.tilt * Math.PI) / 180;
  const scale = 1 / (1 - (x * Math.sin(radians)) / glass.perspective);
  return { x: glass.x + x * Math.cos(radians) * scale, y: glass.y + y * scale };
}

/**
 * Places the sheet, the plate and the rail around the large card. `width` and `height` are
 * the section's size, `card` the large case's rectangle (centre and size) in the same
 * pixels, `portrait` the stage's data-layout: the sheet takes the right in landscape and
 * the space under the card in portrait. Its near edge stays below the header and above
 * the bottom line.
 */
export function songSceneLayout(width: number, height: number, card: SongCard, portrait: boolean): SongSceneLayout {
  width = Math.max(1, width);
  height = Math.max(1, height);
  const vh = height / 100;
  const unit = Math.max(7.2, Math.min(13.5, Math.min(width, height) / 100));
  const cardLeft = card.x - card.width / 2, cardTop = card.y - card.height / 2;
  // The drawn card's edges: nothing may touch them, and the line stops at them.
  const cardRight = card.x + card.width / 2 + CARD_REACH.right * card.width;
  const edgeTop = cardTop - CARD_REACH.top * card.height;
  const cardBottom = card.y + card.height / 2 + CARD_REACH.bottom * card.height;
  const header = Math.max(10 * vh, 96);
  const bottom = height - Math.max(4.6 * vh, 40);
  const plateHeight = PLATE_HEIGHT * unit;

  const railX = cardLeft + 0.2125 * card.width;
  const marker = Math.min(edgeTop - 2.4 * unit, Math.max(header + 2.2 * unit, cardTop - 0.28 * card.height));
  const rail = { x: railX, top: edgeTop, bottom: cardBottom, marker, shown: !portrait, markerShown: !portrait && marker >= header + 1.2 * unit };

  let mode: SongSceneLayout["mode"] = "stacked";
  let left: number, right: number;
  if (portrait) {
    const margin = Math.max(0.045 * width, 18);
    left = margin + 1.2 * unit;
    right = width - margin;
  } else {
    right = width - Math.max(4.5 * vh, 28);
    // The reference anchors the sheet to the right edge; a nearer card pushes its left edge.
    left = Math.max(width - 102.7 * vh, cardRight + 3.2 * unit);
    if (right - left >= 70 * vh) mode = "wide";
    else left = cardRight + 2.6 * unit;
  }
  const span = Math.max(24 * unit, right - left);
  let tilt: number = portrait ? TILT.portrait : TILT[mode];
  let projection = sheetProjection(tilt);
  let glassWidth = span / (projection.reachNear + projection.reachFar);
  // Chromium decides whether a `content-visibility: auto` box is on screen after growing it
  // by one and a half viewport widths in the sheet's own plane. If that reaches the plane
  // through the eye (perspective / sin(tilt) from the sheet's centre), the rows are never
  // painted. Very wide, short windows therefore turn the sheet a little less.
  for (let pass = 0; pass < 3; pass++) {
    const limit = (Math.asin(Math.min(1, (PERSPECTIVE * glassWidth) / (glassWidth / 2 + PAINT_REACH * width))) * 180) / Math.PI;
    if (tilt <= limit) break;
    tilt = limit;
    projection = sheetProjection(tilt);
    glassWidth = span / (projection.reachNear + projection.reachFar);
  }
  const glassX = right - projection.reachNear * glassWidth;

  let glassHeight: number, glassY: number;
  if (portrait) {
    // The far (left) top corner carries the plate; the near corner must still clear the card.
    const ratio = (projection.near - projection.far) / (projection.near + projection.far);
    const farTop = Math.max(cardBottom + 3.6 * unit, (cardBottom + unit + bottom * ratio) / (1 + ratio));
    glassHeight = Math.max(20 * unit, (bottom - farTop) / ((projection.near + projection.far) / 2));
    glassY = bottom - (glassHeight / 2) * projection.near;
  } else {
    glassHeight = (bottom - header) / projection.near;
    glassY = (header + bottom) / 2;
  }
  const glass = {
    x: glassX, y: glassY, width: glassWidth, height: glassHeight, tilt,
    perspective: PERSPECTIVE * glassWidth, side: SIDE * glassWidth,
  };

  const farTop = glassY - (glassHeight / 2) * projection.far;
  let plate: SongSceneLayout["plate"], cross = { x: 0, y: 0, top: 0, bottom: 0 }, head = { inset: 0, height: 0 };
  let note: SongSceneLayout["note"] = "under";
  if (mode === "wide") {
    const listLeft = projectSheet(glass, glass.side - glassWidth / 2, 0).x;
    const x = Math.max(left - 3.5 * unit, cardRight + 1.2 * unit);
    plate = { x, y: glassY + 1.5 * vh - plateHeight / 2, width: listLeft - 1.6 * unit - x, height: plateHeight };
    // The note is bottom-aligned in the side column; the stepper ends about 5.4 units under
    // the plate. A short window leaves less than the note needs there: it goes under the list.
    const far = projectSheet(glass, -glassWidth / 2, 1).y - glassY; // least magnification in that column
    const room = glassHeight / 2 - 3 * unit - 1 - (plate.y + plateHeight + 6.4 * unit - glassY) / far;
    const font = Math.max(11, 1.3 * unit);
    const lines = Math.ceil(NOTE_EMS / Math.max(1, Math.floor((glass.side - 5.6 * unit) / font)));
    note = room >= 1.6 * unit + lines * 1.75 * font ? "side" : "under";
    // The lines keep to the gap between the plate and the list, and out of the header.
    const edge = (glassHeight / 2) * (projectSheet(glass, glass.side - glassWidth / 2, 1).y - glassY);
    cross = {
      x: listLeft - 0.8 * unit, y: plate.y - 1.1 * unit,
      top: Math.max(header - 1.5 * unit, glassY - edge - 5 * unit),
      bottom: Math.min(height - 2 * unit, glassY + edge + 5 * unit),
    };
  } else {
    const x = portrait ? left - 1.2 * unit : Math.max(left - 2.2 * unit, cardRight + 1.2 * unit);
    plate = { x, y: Math.max(portrait ? cardBottom + unit : header, farTop - 2.6 * unit), width: Math.min(36 * unit, 0.62 * span), height: plateHeight };
    const scale = Math.cos(projection.radians) * projection.far;
    head = {
      inset: Math.max(0, (plate.x + plate.width - left + 1.6 * unit) / scale),
      height: Math.max(0, (plate.y + plateHeight - farTop + 1.4 * unit) / projection.far),
    };
  }
  return { mode, unit, rail, glass, plate, cross, head, note };
}

/** The layout as the CSS variables song-scene.css reads from the section. */
export function songLayoutStyle(layout: SongSceneLayout): Record<string, string> {
  const px = (value: number) => `${Math.round(value * 100) / 100}px`;
  const { glass, plate, rail, cross, head } = layout;
  return {
    "--songs-u": px(layout.unit),
    "--songs-rail-x": px(rail.x),
    "--songs-card-top": px(rail.top),
    "--songs-card-bottom": px(rail.bottom),
    "--songs-marker-y": px(rail.marker),
    "--songs-glass-x": px(glass.x - glass.width / 2),
    "--songs-glass-y": px(glass.y - glass.height / 2),
    "--songs-glass-w": px(glass.width),
    "--songs-glass-h": px(glass.height),
    "--songs-tilt": `${-glass.tilt}deg`,
    "--songs-perspective": px(glass.perspective),
    "--songs-side": px(glass.side),
    "--songs-plate-x": px(plate.x),
    "--songs-plate-y": px(plate.y),
    "--songs-plate-w": px(plate.width),
    "--songs-plate-h": px(plate.height),
    "--songs-cross-x": px(cross.x),
    "--songs-cross-y": px(cross.y),
    "--songs-cross-top": px(cross.top),
    "--songs-cross-bottom": px(cross.bottom),
    "--songs-head-inset": px(head.inset),
    "--songs-head-height": px(head.height),
  };
}

type RowMark = "playing" | "selected" | "pending";
export interface SongRowState {
  playing?: string;
  selected?: string;
  pending?: string;
  /** The playing song is not sounding (paused, stopped or unknown): its meter holds still. */
  paused?: boolean;
}

export class SongListView {
  /** Elements whose opacity the caller animates to show or hide the view (never the root). */
  readonly fadeTargets: readonly HTMLElement[];
  /** The glass sheet; wheel events inside it scroll the list instead of switching albums. */
  readonly glass: HTMLElement;
  private readonly list: HTMLElement;
  private readonly title: HTMLElement;
  private readonly stepper: HTMLElement;
  private readonly text: Record<"caption" | "subtitle" | "overline" | "count" | "label" | "note" | "prev" | "next", HTMLElement>;
  private rows: HTMLButtonElement[] = [];
  private rowKeys: string[] = [];
  private keys = new Map<string, HTMLButtonElement>();
  private id: string | undefined;
  private state: SongRowState = {};
  private marks: Partial<Record<RowMark, HTMLButtonElement>> = {};
  private current: HTMLButtonElement | undefined;
  private tabStop: HTMLButtonElement | undefined;
  private firstEnabled: HTMLButtonElement | undefined;
  private titleText: string | undefined;
  private titleMotion: Animation[] = [];
  /** Plate width available to the title, in layout units. */
  private capacity = 26;
  /** The next reveal is the first one the list can show: it must not animate. */
  private unrevealed = true;
  /** Rows were rebuilt while the list had no box: the old offset comes back with the box. */
  private stale = false;
  private layoutKey = "";

  constructor(private readonly root: HTMLElement) {
    const find = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
    this.glass = find(".song-glass");
    this.fadeTargets = [find(".song-chrome"), this.glass, find(".song-float")];
    this.list = find(".song-list");
    this.title = find(".song-plate-title");
    this.stepper = find(".song-stepper");
    this.text = {
      caption: find(".song-plate-caption"), subtitle: find(".song-plate-subtitle"),
      overline: find("#song-overline"), count: find(".song-count"),
      label: find("#song-label"), note: find(".song-note"),
      prev: find("#song-prev span"), next: find("#song-next span"),
    };
    // The tab stop follows the focus, so Tab returns to the row the user left.
    this.list.addEventListener("focusin", (event) => {
      const row = (event.target as HTMLElement).closest<HTMLButtonElement>(".song-row");
      if (row) this.setTabStop(row);
    });
  }

  /**
   * Updates the plate, header and footer; rebuilds the rows only when `model.id` changed
   * (otherwise the list keeps its scroll position and focus). A changed plate title is
   * swapped behind its mask unless `reduced`.
   */
  render(model: SongListModel, reduced: boolean) {
    const { root, text } = this;
    if (root.dataset.kind !== model.kind) {
      const queue = model.kind === "queue";
      root.dataset.kind = model.kind;
      text.prev.textContent = queue ? "上一首" : "上一张";
      text.next.textContent = queue ? "下一首" : "下一张";
      this.stepper.setAttribute("aria-label", queue ? "切换歌曲" : "切换专辑");
    }
    const set = (element: HTMLElement, value: string) => {
      if (element.textContent !== value) element.textContent = value;
    };
    set(text.caption, model.caption);
    set(text.subtitle, model.subtitle);
    set(text.overline, model.overline);
    set(text.count, model.count);
    set(text.label, model.label);
    set(text.note, model.note ?? "");
    text.note.hidden = !model.note;
    this.setTitle(model.title, !reduced && !root.hidden);
    if (model.id !== this.id) this.rebuild(model);
  }

  /**
   * Row keys, and whether the playing song is paused (mirrored as data-paused on the section).
   * Touches at most the rows whose state changed, so it can run on every poll.
   */
  sync(state: SongRowState) {
    this.state = state;
    const row = (key?: string) => (key === undefined ? undefined : this.keys.get(key));
    for (const mark of ["playing", "selected", "pending"] as const) {
      const next = row(state[mark]), previous = this.marks[mark];
      if (next === previous) continue;
      previous?.classList.remove(mark);
      next?.classList.add(mark);
      this.marks[mark] = next;
    }
    const paused = String(!!state.paused);
    if (this.root.dataset.paused !== paused) this.root.dataset.paused = paused;
    const current = row(state.selected) ?? row(state.playing);
    if (current !== this.current) {
      this.current?.removeAttribute("aria-current");
      current?.setAttribute("aria-current", "true");
      this.current = current;
    }
    // Until the user focuses a row, Tab enters the list at the current one.
    if (!this.list.contains(document.activeElement)) this.setTabStop(this.focusable(current));
  }

  /** Scrolls the row into a comfortable position unless it already is in one. */
  reveal(key: string | undefined, smooth: boolean) {
    // A hidden section has no boxes: the reveal that follows its showing jumps instead.
    if (!this.list.clientHeight) {
      this.unrevealed = true;
      return;
    }
    const first = this.unrevealed;
    this.unrevealed = false;
    if (this.stale) {
      this.stale = false;
      this.list.scrollTop = 0;
    }
    if (first) this.fitTitle();
    const row = key === undefined ? undefined : this.keys.get(key);
    if (row) this.scrollToRow(row, first || !smooth);
  }

  /** Focuses the selected, else the playing, else the first row, without scrolling anything. */
  focusCurrent() {
    (this.focusable(this.current) ?? this.list).focus({ preventScroll: true });
  }

  /**
   * Roving focus inside the list: ArrowUp/ArrowDown/Home/End/PageUp/PageDown. Returns true
   * (after preventDefault) only when the focus is inside the list and the key was handled.
   */
  handleKey(event: KeyboardEvent): boolean {
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !this.list.contains(active)) return false;
    const row = active.closest<HTMLElement>(".song-row");
    const from = Number(row?.dataset.row ?? -1);
    const to = rovingIndex(event.key, from, this.rows.length, Math.floor(this.list.clientHeight / (row?.offsetHeight || 48)) - 1,
      (index) => !this.rows[index].disabled);
    if (to === undefined || to < 0) return false;
    event.preventDefault();
    if (to !== from) {
      this.rows[to].focus({ preventScroll: true });
      this.scrollToRow(this.rows[to], true);
    }
    return true;
  }

  /**
   * The large card's rectangle in CSS pixels relative to the section (centre and size).
   * Everything that hugs the card follows through CSS variables on the section.
   */
  setCard(rect: SongCard) {
    const stage = this.root.parentElement;
    const width = stage?.clientWidth || innerWidth, height = stage?.clientHeight || innerHeight;
    const portrait = this.root.closest<HTMLElement>("[data-layout]")?.dataset.layout === "portrait";
    const layout = songSceneLayout(width, height, rect, portrait);
    const style = songLayoutStyle(layout);
    const key = JSON.stringify([layout.mode, layout.note, layout.rail.shown, layout.rail.markerShown, style]);
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    for (const [name, value] of Object.entries(style)) this.root.style.setProperty(name, value);
    this.root.dataset.panel = layout.mode;
    this.root.dataset.note = layout.note;
    this.root.dataset.rail = layout.rail.shown ? (layout.rail.markerShown ? "marker" : "line") : "none";
    this.capacity = layout.plate.width / layout.unit - 4.2;
    this.fitTitle();
  }

  private focusable(preferred?: HTMLButtonElement) {
    return preferred && !preferred.disabled ? preferred : this.firstEnabled;
  }

  private setTabStop(row?: HTMLButtonElement) {
    if (row === this.tabStop) return;
    if (this.tabStop) this.tabStop.tabIndex = -1;
    if (row) row.tabIndex = 0;
    this.tabStop = row;
  }

  private scrollToRow(row: HTMLElement, instant: boolean) {
    // Blocks may or may not be offset parents; the list always is.
    let offset = 0;
    for (let node: HTMLElement | null = row; node && node !== this.list; node = node.offsetParent as HTMLElement | null) offset += node.offsetTop;
    const from = this.list.scrollTop, viewport = this.list.clientHeight;
    const top = revealScrollTop({ top: offset, height: row.offsetHeight }, from, viewport, this.list.scrollHeight);
    if (top === undefined) return;
    // A far row is approached from one page away: no flight past thousands of rows.
    if (!instant && Math.abs(top - from) > 2 * viewport) this.list.scrollTop = top - Math.sign(top - from) * viewport;
    this.list.scrollTo({ top, behavior: instant ? "auto" : "smooth" });
  }

  private rebuild(model: SongListModel) {
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && this.list.contains(active) ? active : undefined;
    const focusedKey = this.rowKeys[Number(focused?.closest<HTMLElement>(".song-row")?.dataset.row ?? -1)];
    this.id = model.id;
    this.list.innerHTML = songRowsMarkup(model);
    this.rows = Array.from(this.list.querySelectorAll<HTMLButtonElement>(".song-row"));
    this.rowKeys = model.rows.map((row) => row.key);
    this.keys.clear();
    // The same song can be queued twice: the first row answers for its key.
    this.rowKeys.forEach((key, index) => {
      if (!this.keys.has(key)) this.keys.set(key, this.rows[index]);
    });
    this.firstEnabled = this.rows.find((row) => !row.disabled);
    this.marks = {};
    this.current = undefined;
    this.tabStop = undefined;
    // Without a box (the section is hidden) this write does nothing: reveal() repeats it.
    this.list.scrollTop = 0;
    this.stale = !this.list.clientHeight;
    this.unrevealed = true;
    this.sync(this.state);
    // New rows replace the focused one: keep the keyboard inside the list.
    if (focused) {
      const same = focusedKey === undefined ? undefined : this.keys.get(focusedKey);
      (same && !same.disabled ? same : this.focusable(this.current) ?? this.list).focus({ preventScroll: true });
    }
  }

  /**
   * The title's size comes from its estimated width; where the line has a box (the section
   * is shown), a line that still overflows steps down.
   */
  private fitTitle() {
    const line = this.title.lastElementChild as HTMLElement | null;
    if (!line || this.titleText === undefined) return;
    let size = plateTitleSize(this.titleText, this.capacity);
    line.dataset.size = size;
    while (size !== "s" && line.clientWidth && line.scrollWidth > line.clientWidth + 1)
      line.dataset.size = size = size === "l" ? "m" : "s";
  }

  /** The plate stays put; the old title leaves its mask upwards and the new one rises into it. */
  private setTitle(title: string, animate: boolean) {
    if (title === this.titleText) return;
    const previous = this.titleText === undefined ? null : this.title.lastElementChild as HTMLElement | null;
    this.titleText = title;
    for (const motion of this.titleMotion) motion.cancel();
    this.titleMotion = [];
    const line = document.createElement("span");
    line.className = "song-plate-line";
    line.textContent = title;
    this.title.replaceChildren(...(animate && previous ? [previous, line] : [line]));
    this.fitTitle();
    if (!animate || !previous) return;
    previous.setAttribute("aria-hidden", "true");
    const leave = previous.animate([{ transform: "translateY(0)" }, { transform: "translateY(-125%)" }],
      { duration: 170, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" });
    const enter = line.animate([{ transform: "translateY(125%)" }, { transform: "translateY(0)" }],
      { duration: 250, delay: 70, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "backwards" });
    this.titleMotion = [leave, enter];
    void enter.finished.then(() => {
      if (this.titleMotion[1] !== enter) return;
      previous.remove();
      this.titleMotion = [];
    }).catch(() => {});
  }
}
