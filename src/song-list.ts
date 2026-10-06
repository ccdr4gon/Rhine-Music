import { escapeHtml } from "./html.ts";
import type { MusicAlbum } from "./music-types.ts";
import type { PlayerTrack } from "./external_player/player-track.ts";

/**
 * The DOM half of the song scene (Claude Design "Overlay Frame", direction B, 2026-10-05): one
 * tilted pane of glass with the column's tab, the selected song and the playlist as text, and
 * the flat chrome around the large 3D card (the ways out, the line behind the card, the column's
 * name). Models and geometry are pure functions; SongListView only applies them.
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
/** The pane's tab: PLAYLIST 03 / 07, QUEUE (NetEase's queue as the one column) or ALBUM 012 / 040. */
export interface SongListTab {
  label: string;
  /** The playlist column's or the album's number, and the count it is out of; none for the lone queue. */
  number?: number;
  total?: number;
  /** Digits the number and the total are padded to (2 for playlists, 3 for albums, as on the shelf). */
  digits: number;
  /** The tab in words, for screen readers (its number is a reel). */
  name: string;
}
export interface SongListModel {
  kind: "album" | "queue" | "playlist";
  /** Identity of the rows: their DOM is rebuilt only when this changes. */
  id: string;
  tab: SongListTab;
  /** The selected song (an album: its title), and its artist · album (an album: artist · year). */
  title: string;
  subtitle: string;
  /** The tag: 共 N 首; under it, quietly, why the list is cut or an album's length. */
  count: string;
  countNote?: string;
  /** The column's name, bottom left. */
  label: string;
  /** The list's accessible name. */
  listLabel: string;
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
  options: {
    number: number;
    demo: boolean;
    time(seconds: number): string;
    /** How many albums the library holds (the tab's "/ total"). */
    total?: number;
    /** The shelf column the album stands in (its genre, artist or group): the name bottom left. */
    column?: string;
  },
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
  const total = options.total;
  return {
    kind: "album",
    id: `album:${album.id}:${digest(rows.flatMap((row) => [row.key, row.number, row.title, row.artist, row.meta, row.group ?? "", row.disabled ? 1 : 0]))}`,
    tab: { label: "ALBUM", number: options.number, total, digits: 3, name: `专辑 ${options.number}${total ? ` / ${total}` : ""}` },
    title: album.title,
    subtitle: [album.artist, album.year ? String(album.year) : ""].filter(Boolean).join(" · "),
    count: `共 ${tracks.length} 首`,
    countNote: tracks.length ? options.time(tracks.reduce((sum, track) => sum + track.duration, 0)) : undefined,
    label: options.column ?? album.artist,
    listLabel: `${album.title} 曲目`,
    note: notes.join(" ") || undefined,
    empty: tracks.length ? undefined
      : options.demo ? "这是一张封面演示卡片，扫描本地音乐库后这里会显示真实曲目。" : "这个专辑还没有可播放曲目。",
    rows,
  };
}

export function queueSongModel(
  tracks: readonly PlayerTrack[],
  options: {
    stamp: string;
    truncated: boolean;
    selected?: PlayerTrack;
    keyOf(track: PlayerTrack): string;
    indexOf(key: string): number;
    time(seconds: number): string;
    note?: string;
    /** The playlist column this list is, when the shelf's columns are playlists. */
    lane?: { name: string; live: boolean };
    /** That column's place among the columns (from 1), and how many there are. */
    column?: { number: number; total: number };
  },
): SongListModel {
  const total = tracks.length;
  // The stamp covers what the queue says; the boxes the rows point at come from the shelf.
  const boxes: number[] = [];
  const rows: SongRow[] = tracks.map((track, index) => {
    const key = options.keyOf(track);
    const select = options.indexOf(key);
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
  // A playlist column names itself; NetEase's own queue, the one column, is the QUEUE.
  const lane = options.lane, name = lane?.name ?? "播放队列", column = lane ? options.column : undefined;
  return {
    kind: "queue",
    id: `queue:${options.stamp}:${total}:${digest(boxes)}`,
    tab: lane
      ? { label: "PLAYLIST", number: column?.number, total: column?.total, digits: 2, name: `歌单${column ? ` ${column.number} / ${column.total}` : ""}` }
      : { label: "QUEUE", digits: 2, name: "播放队列" },
    title: selected?.title ?? name,
    subtitle: selected ? [selected.artist || "歌手未提供", selected.album].filter(Boolean).join(" · ") : "",
    count: `共 ${total} 首`,
    // The queue is cut at 3000 songs; a playlist column can also be cut by the total across playlists.
    countNote: options.truncated ? (lane && !lane.live ? "未显示全部" : "前 3000 首") : undefined,
    label: name,
    listLabel: name,
    note: options.note,
    empty: total ? undefined : lane ? "这个歌单是空的。" : "播放队列是空的。",
    rows,
  };
}

/** A song of a local folder playlist as the list shows it (local_music/data/playlists.ts). */
export interface PlaylistSong {
  /** The song's case on the shelf (its track ID). */
  id: string;
  title: string;
  artist: string;
  album?: string;
  format: string;
  browserPlayable: boolean;
  duration: number;
  offline: boolean;
}

/**
 * A local folder playlist (the owner, 2026-10-06: each playlist is a subfolder of the main
 * folder): one row per song in the order its column holds them. A row selects that song's case,
 * as a row of NetEase's queue does: moving never plays; the play button does.
 */
export function playlistSongModel(
  songs: readonly PlaylistSong[],
  options: {
    /** The playlist's name: its folder's (bottom left, and the title while no song is selected). */
    name: string;
    /** The selected song's case. */
    selected?: string;
    indexOf(id: string): number;
    time(seconds: number): string;
    /** The playlist's column (from 1) among the columns. */
    column?: { number: number; total: number };
    /** Cover-only demonstration songs: nothing to play, no lengths. */
    demo?: boolean;
  },
): SongListModel {
  const rows: SongRow[] = songs.map((song, index) => {
    const select = options.indexOf(song.id);
    return {
      key: song.id,
      number: pad(index + 1, 3),
      title: song.title,
      artist: song.artist || "歌手未提供",
      meta: options.demo ? "演示" : [`${song.format}${song.browserPlayable ? "" : " ↗"}`, options.time(song.duration)].join(" · "),
      select: select < 0 ? undefined : select,
      disabled: select < 0,
    };
  });
  const selected = songs.find((song) => song.id === options.selected);
  const column = options.column;
  const notes = [
    songs.some((song) => song.offline) ? "目录离线，歌曲暂时无法播放。" : "",
    !options.demo && songs.some((song) => !song.browserPlayable) ? "↗ 需要兼容的播放内核。" : "",
  ].filter(Boolean);
  return {
    kind: "playlist",
    id: `playlist:${digest(rows.flatMap((row) => [row.key, row.number, row.title, row.artist, row.meta, row.select ?? -1]))}`,
    tab: { label: "PLAYLIST", number: column?.number, total: column?.total, digits: 2, name: `歌单${column ? ` ${column.number} / ${column.total}` : ""}` },
    title: selected?.title ?? options.name,
    subtitle: selected ? [selected.artist || "歌手未提供", selected.album].filter(Boolean).join(" · ") : "",
    count: `共 ${songs.length} 首`,
    countNote: songs.length && !options.demo ? options.time(songs.reduce((sum, song) => sum + song.duration, 0)) : undefined,
    label: options.name,
    listLabel: options.name,
    note: notes.join(" ") || undefined,
    empty: songs.length ? undefined : "这个歌单是空的。",
    rows,
  };
}

/** Inner HTML for <section id="music-song" class="music-song" aria-label="歌曲选择" hidden>. */
export function songSceneMarkup(): string {
  return `<div class="song-chrome">
    <i class="song-rail song-rail-top" aria-hidden="true"></i><i class="song-rail song-rail-bottom" aria-hidden="true"></i><i class="song-marker" aria-hidden="true"></i>
    <div class="song-exits">
      <button class="music-back" data-action="back"><span>← <span id="song-back-label">返回专辑架</span></span> <kbd>ESC</kbd></button>
      <button class="music-back song-details" data-action="details"><span>↗ <span id="song-details-label">专辑详情</span></span> <kbd>S</kbd></button>
    </div>
    <p class="song-caption"><i aria-hidden="true"></i><span id="song-label"></span></p>
  </div>
  <div id="song-glass" class="song-glass">
    <div class="song-head">
      <div class="song-tab"><span id="song-tab-text" class="song-tab-text"></span><span class="song-tab-label" aria-hidden="true"><span id="song-tab-label"></span><i class="song-tab-dot"></i></span><span class="song-tab-figure" aria-hidden="true"><b id="song-tab-number" class="song-tab-number"></b><span id="song-tab-total" class="song-tab-total"></span></span></div>
      <div class="song-tally"><span id="song-count" class="song-count"></span><small id="song-count-note" class="song-count-note" hidden></small></div>
    </div>
    <div class="song-selected">
      <h2 id="song-title" class="song-title"></h2>
      <p id="song-subtitle" class="song-subtitle"></p>
      <div class="song-steps" role="group" aria-label="切换专辑"><button id="song-prev" data-action="prev" aria-label="上一张专辑"><i class="chevron chevron-up" aria-hidden="true"></i></button><button id="song-next" data-action="next" aria-label="下一张专辑"><i class="chevron chevron-down" aria-hidden="true"></i></button></div>
    </div>
    <div id="song-list" class="song-list" role="group" tabindex="-1"></div>
    <p id="song-note" class="song-note" hidden></p>
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

export interface SongCard { x: number; y: number; width: number; height: number }
export interface SongSceneLayout {
  /** "wide": the selected song in a column left of the list; "stacked": above it. */
  mode: "wide" | "stacked";
  /** Pixels per layout unit: 1 % of the picture's shorter side, bounded. */
  unit: number;
  /** The vertical line behind the card and its marker; `shown` is false when they would crowd. */
  rail: { x: number; top: number; bottom: number; marker: number; shown: boolean; markerShown: boolean };
  /** The glass pane before its transform (centre and size) and the transform itself. */
  glass: { x: number; y: number; width: number; height: number; tilt: number; perspective: number; side: number };
  /**
   * Where the note goes: "side" is the bottom of the column left of the list, under the
   * selected song (wide only, when that column is tall enough); "under" is below the list.
   */
  note: "side" | "under";
}

/**
 * The pane turns away on its left side. The design (1440 × 900) turns 712 px of glass by 18
 * degrees at a perspective distance of 1660 px, 2.33 pane widths.
 */
const PERSPECTIVE = 2.3315;
const TILT = { wide: 18, stacked: 12, portrait: 6 } as const;
/** Share of the pane's width left of the list in the wide arrangement (290 of 712 px). */
const SIDE = 0.407;
/**
 * The pane's insides in layout units (9 px at 1440 × 900; song-scene.css uses the same):
 * padding at the top and left (30 px) and at the right and bottom (28 px), the head with the
 * tab and the count (108 px, so the list starts 138 px down) and the room between the selected
 * song and the list (24 px).
 */
export const PANE = { start: 3.3333, end: 3.1111, head: 12, gap: 2.6667 } as const;
/** Viewport widths the browser adds around a row before deciding whether to paint it (1.5), with a margin. */
const PAINT_REACH = 1.6;
/** Room kept for the note, in ems of its font: the longest one the app writes is 53 full-width characters. */
const NOTE_EMS = 56;
/** The least the wide arrangement leaves the list and the selected song, in units. */
const WIDE_LIST = 40;
const WIDE_SIDE = 20;
/**
 * setCard receives the case's nominal face. The drawn case is turned towards the camera,
 * has thickness and a soft glow, and reaches this much further (shares of the face's width
 * and height, measured in the running scene). Zero these if the drawn outline is ever
 * handed over instead.
 */
export const CARD_REACH = { right: 0.075, top: 0.07, bottom: 0.055 } as const;

/** Type sizes of the pane in pixels (song-scene.css): the selected title, its second line, the note. */
export function songPaneType(unit: number) {
  return { title: Math.max(16, 2.4444 * unit), subtitle: Math.max(11, 1.2222 * unit), note: Math.max(10, 1.2222 * unit) };
}
/**
 * The tallest the selected song's block gets (song-scene.css): 8 px from the list's top rule,
 * a title of at most three lines, its second line, the two step buttons 20 px below.
 */
export function selectedBlockHeight(unit: number) {
  const type = songPaneType(unit), gap = 1.1111 * unit;
  return 0.8889 * unit + 3 * 1.2 * type.title + gap + 1.4 * type.subtitle + 2 * gap + Math.max(24, 2.8889 * unit);
}

/** How a pane turned by `tilt` degrees projects: edge magnifications and reach from its centre. */
function sheetProjection(tilt: number) {
  const radians = (tilt * Math.PI) / 180;
  const depth = Math.sin(radians) / (2 * PERSPECTIVE);
  const near = 1 / (1 - depth), far = 1 / (1 + depth);
  return { radians, near, far, reachNear: (Math.cos(radians) / 2) * near, reachFar: (Math.cos(radians) / 2) * far };
}

/** Screen position of a point of the pane, given from the pane's centre (x right, y down). */
export function projectSheet(glass: SongSceneLayout["glass"], x: number, y: number) {
  const radians = (glass.tilt * Math.PI) / 180;
  const scale = 1 / (1 - (x * Math.sin(radians)) / glass.perspective);
  return { x: glass.x + x * Math.cos(radians) * scale, y: glass.y + y * scale };
}

/**
 * Places the pane and the rail around the large card. `width` and `height` are the section's
 * size, `card` the large case's rectangle (centre and size) in the same pixels, `portrait` the
 * stage's data-layout: the pane takes the right in landscape and the space under the card in
 * portrait. Its near edge stays below the header (and `chromeBottom`, where the header's row
 * ends, when given) and above the bottom line. At 1440 × 900 this is the design's pane: left
 * 688, top 108, 712 × 728, turned 18 degrees at 1660 px.
 */
export function songSceneLayout(width: number, height: number, card: SongCard, portrait: boolean, chromeBottom = 0): SongSceneLayout {
  width = Math.max(1, width);
  height = Math.max(1, height);
  const vh = height / 100;
  const unit = Math.max(7.2, Math.min(13.5, Math.min(width, height) / 100));
  const cardLeft = card.x - card.width / 2, cardTop = card.y - card.height / 2;
  // The drawn card's edges: nothing may touch them, and the line stops at them.
  const cardRight = card.x + card.width / 2 + CARD_REACH.right * card.width;
  const edgeTop = cardTop - CARD_REACH.top * card.height;
  const cardBottom = card.y + card.height / 2 + CARD_REACH.bottom * card.height;
  const header = Math.max(9.1 * vh, 82, chromeBottom + 12);
  const bottom = height - Math.max(4.2 * vh, 38);

  const railX = cardLeft + 0.2125 * card.width;
  const marker = Math.min(edgeTop - 2.4 * unit, Math.max(header + 2.2 * unit, cardTop - 0.309 * card.height));
  const rail = { x: railX, top: edgeTop, bottom: cardBottom, marker, shown: !portrait, markerShown: !portrait && marker >= header + 1.2 * unit };

  /** The pane between `left` and `right` at `tilt`, turned less where rows would not be painted. */
  const place = (left: number, right: number, startTilt: number) => {
    const span = Math.max(24 * unit, right - left);
    let tilt = startTilt;
    let projection = sheetProjection(tilt);
    let glassWidth = span / (projection.reachNear + projection.reachFar);
    // Chromium decides whether a `content-visibility: auto` box is on screen after growing it
    // by one and a half viewport widths in the pane's own plane. If that reaches the plane
    // through the eye (perspective / sin(tilt) from the pane's centre), the rows are never
    // painted. Very wide, short windows therefore turn the pane a little less.
    for (let pass = 0; pass < 3; pass++) {
      const limit = (Math.asin(Math.min(1, (PERSPECTIVE * glassWidth) / (glassWidth / 2 + PAINT_REACH * width))) * 180) / Math.PI;
      if (tilt <= limit) break;
      tilt = limit;
      projection = sheetProjection(tilt);
      glassWidth = span / (projection.reachNear + projection.reachFar);
    }
    return { tilt, projection, glassWidth, glassX: right - projection.reachNear * glassWidth };
  };

  let mode: SongSceneLayout["mode"] = "stacked";
  let placed: ReturnType<typeof place>;
  if (portrait) {
    const margin = Math.max(0.045 * width, 18);
    placed = place(margin + 1.2 * unit, width - margin, TILT.portrait);
  } else {
    const right = width - Math.max(3.7 * vh, 28);
    // Wide: the selected song has a column of its own left of a list wide enough to read.
    const fitsWide = (candidate: ReturnType<typeof place>) => {
      const side = SIDE * candidate.glassWidth;
      const probe = { x: candidate.glassX, y: 0, width: candidate.glassWidth, height: 1, tilt: candidate.tilt, perspective: PERSPECTIVE * candidate.glassWidth, side };
      const listLeft = projectSheet(probe, side - candidate.glassWidth / 2, 0).x;
      return right - listLeft >= WIDE_LIST * unit && side - (PANE.start + PANE.gap) * unit >= WIDE_SIDE * unit;
    };
    // The design anchors the pane to the right edge, at least 80 units wide (a very wide, short
    // window); a nearer card pushes its left edge.
    placed = place(Math.max(cardRight + 8.9 * unit, Math.min(width - 102.7 * vh, right - 80 * unit)), right, TILT.wide);
    if (fitsWide(placed)) mode = "wide";
    else placed = place(cardRight + 2.6 * unit, right, TILT.stacked);
  }
  const { tilt, projection, glassWidth, glassX } = placed;

  let glassHeight: number, glassY: number;
  if (portrait) {
    // Under the card: the near (right) top corner is the pane's highest point.
    const top = cardBottom + 2.4 * unit;
    glassHeight = Math.max(20 * unit, (bottom - top) / projection.near);
    glassY = bottom - (glassHeight / 2) * projection.near;
  } else {
    glassHeight = (bottom - header) / projection.near;
    glassY = (header + bottom) / 2;
  }
  const glass = {
    x: glassX, y: glassY, width: glassWidth, height: glassHeight, tilt,
    perspective: PERSPECTIVE * glassWidth, side: SIDE * glassWidth,
  };

  // The note is bottom-aligned in the side column, under the selected song's block (both lie in
  // the pane's plane). A short window leaves less than the note needs there: it goes under the list.
  let note: SongSceneLayout["note"] = "under";
  if (mode === "wide") {
    const type = songPaneType(unit);
    const column = glass.side - (PANE.start + PANE.gap) * unit;
    const lines = Math.ceil(NOTE_EMS / Math.max(1, Math.floor(column / type.note)));
    const room = glassHeight - (PANE.start + PANE.head + PANE.end) * unit - 2;
    note = room >= selectedBlockHeight(unit) + 2 * unit + lines * 1.7 * type.note ? "side" : "under";
  }
  return { mode, unit, rail, glass, note };
}

/** The layout as the CSS variables song-scene.css reads from the section. */
export function songLayoutStyle(layout: SongSceneLayout): Record<string, string> {
  const px = (value: number) => `${Math.round(value * 100) / 100}px`;
  const { glass, rail } = layout;
  return {
    "--songs-u": px(layout.unit),
    // A whole pixel: the 1 px line stays crisp.
    "--songs-rail-x": px(Math.round(rail.x)),
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
  };
}

type RowMark = "playing" | "selected" | "pending";
export interface SongRowState {
  playing?: string;
  selected?: string;
  pending?: string;
  /** The playing song is not sounding (paused, stopped or unknown): its meter holds still. */
  paused?: boolean;
  /** The listed column holds what plays (NetEase's queue, the loaded album): the tab's dot. */
  live?: boolean;
}

export class SongListView {
  /** Elements whose opacity the caller animates to show or hide the view (never the root). */
  readonly fadeTargets: readonly HTMLElement[];
  /** The list; the wheel over it scrolls it instead of moving along the column. */
  readonly list: HTMLElement;
  /** The tab's number, for the caller's reel (the module stays free of DOM libraries). */
  readonly tabNumber: HTMLElement;
  private readonly title: HTMLElement;
  private readonly steps: HTMLElement;
  private readonly text: Record<"subtitle" | "tab" | "tabLabel" | "tabTotal" | "count" | "countNote" | "label" | "note", HTMLElement>;
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
  /** The next reveal is the first one the list can show: it must not animate. */
  private unrevealed = true;
  /** Rows were rebuilt while the list had no box: the old offset comes back with the box. */
  private stale = false;
  private layoutKey = "";

  constructor(private readonly root: HTMLElement) {
    const find = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
    this.fadeTargets = [find(".song-chrome"), find(".song-glass")];
    this.list = find(".song-list");
    this.tabNumber = find("#song-tab-number");
    this.title = find(".song-title");
    this.steps = find(".song-steps");
    this.text = {
      subtitle: find(".song-subtitle"),
      tab: find("#song-tab-text"), tabLabel: find("#song-tab-label"), tabTotal: find("#song-tab-total"),
      count: find(".song-count"), countNote: find(".song-count-note"),
      label: find("#song-label"), note: find(".song-note"),
    };
    // The tab stop follows the focus, so Tab returns to the row the user left.
    this.list.addEventListener("focusin", (event) => {
      const row = (event.target as HTMLElement).closest<HTMLButtonElement>(".song-row");
      if (row) this.setTabStop(row);
    });
  }

  /**
   * Updates the tab, the count, the selected song and the column's name; rebuilds the rows
   * only when `model.id` changed (otherwise the list keeps its scroll position and focus). A
   * changed title is swapped behind its mask unless `reduced`. The tab's number is the
   * caller's (tabNumber): it is only shown or hidden here.
   */
  render(model: SongListModel, reduced: boolean) {
    const { root, text } = this;
    if (root.dataset.kind !== model.kind) {
      root.dataset.kind = model.kind;
      this.steps.setAttribute("aria-label", model.kind === "album" ? "切换专辑" : "切换歌曲");
    }
    const set = (element: HTMLElement, value: string) => {
      if (element.textContent !== value) element.textContent = value;
    };
    const { tab } = model;
    set(text.tab, tab.name);
    set(text.tabLabel, tab.label);
    set(text.tabTotal, tab.total ? `/ ${pad(tab.total, tab.digits)}` : "");
    const numbered = String(tab.number !== undefined);
    if (root.dataset.tabNumber !== numbered) root.dataset.tabNumber = numbered;
    set(text.subtitle, model.subtitle);
    text.subtitle.title = model.subtitle;
    set(text.count, model.count);
    set(text.countNote, model.countNote ?? "");
    text.countNote.hidden = !model.countNote;
    set(text.label, model.label);
    if (this.list.getAttribute("aria-label") !== model.listLabel) this.list.setAttribute("aria-label", model.listLabel);
    set(text.note, model.note ?? "");
    text.note.hidden = !model.note;
    this.setTitle(model.title, !reduced && !root.hidden);
    if (model.id !== this.id) this.rebuild(model);
  }

  /**
   * Row keys, whether the playing song is paused (mirrored as data-paused on the section) and
   * whether the listed column holds what plays (data-live, the tab's dot). Touches at most the
   * rows whose state changed, so it can run on every poll.
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
    const paused = String(!!state.paused), live = String(!!state.live);
    if (this.root.dataset.paused !== paused) this.root.dataset.paused = paused;
    if (this.root.dataset.live !== live) this.root.dataset.live = live;
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
   * The large card's rectangle in CSS pixels relative to the section (centre and size), and
   * where the header's row ends. Everything that hugs the card follows through CSS variables
   * on the section.
   */
  setCard(rect: SongCard, chromeBottom = 0) {
    const stage = this.root.parentElement;
    const width = stage?.clientWidth || innerWidth, height = stage?.clientHeight || innerHeight;
    const portrait = this.root.closest<HTMLElement>("[data-layout]")?.dataset.layout === "portrait";
    const layout = songSceneLayout(width, height, rect, portrait, chromeBottom);
    const style = songLayoutStyle(layout);
    const key = JSON.stringify([layout.mode, layout.note, layout.rail.shown, layout.rail.markerShown, style]);
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    for (const [name, value] of Object.entries(style)) this.root.style.setProperty(name, value);
    this.root.dataset.panel = layout.mode;
    this.root.dataset.note = layout.note;
    this.root.dataset.rail = layout.rail.shown ? (layout.rail.markerShown ? "marker" : "line") : "none";
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
   * The block stays put; the old title leaves its mask upwards and the new one rises into it
   * (the design's document swap: out 170 ms, in 250 ms after 70 ms). At most three lines are
   * shown; the whole title is the tooltip.
   */
  private setTitle(title: string, animate: boolean) {
    if (title === this.titleText) return;
    const previous = this.titleText === undefined ? null : this.title.lastElementChild as HTMLElement | null;
    this.titleText = title;
    this.title.title = title;
    for (const motion of this.titleMotion) motion.cancel();
    this.titleMotion = [];
    const line = document.createElement("span");
    line.className = "song-title-line";
    line.textContent = title;
    this.title.replaceChildren(...(animate && previous ? [previous, line] : [line]));
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
