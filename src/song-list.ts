import { escapeHtml } from "./html.ts";
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
  /**
   * Rendered as data-track. No list model sets it since the album lists went (albumSongModel,
   * removed 2026-10-08), and the page has no click action for it; nor does any set `group`.
   */
  track?: string;
  /** Queue rows: rendered as data-select, the record index of that song's box. */
  select?: number;
  disabled?: boolean;
  /**
   * The row's song can be played from the list (data-playable): ▶ takes its number's place when
   * it is hovered, focused or selected, while the section allows it (data-play). Never a song
   * without a box, one without a file or one the browser cannot play (↗: the row only selects,
   * and its tooltip says why). (A song of another NetEase playlist is played with its playlist
   * since 2026-10-10; until then such a column was only for browsing.)
   */
  playable?: boolean;
  /** The row's tooltip: what its marks mean (↗ a format that needs another player, 目录离线). */
  hint?: string;
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
  /** The tag: 共 N 首; under it, quietly, why the list is cut, an album's length or 目录离线. */
  count: string;
  countNote?: string;
  /** The column's name, bottom left. */
  label: string;
  /** The list's accessible name. */
  listLabel: string;
  empty?: string;
  rows: SongRow[];
}

/** What a row's marks mean, in its tooltip (no note under the list: the owner, 2026-10-07). */
const OFFLINE_HINT = "目录离线", KERNEL_HINT = "需要兼容的播放内核";

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

export function queueSongModel(
  tracks: readonly PlayerTrack[],
  options: {
    stamp: string;
    truncated: boolean;
    selected?: PlayerTrack;
    keyOf(track: PlayerTrack): string;
    indexOf(key: string): number;
    time(seconds: number): string;
    /** The playlist column this list is, when the shelf's columns are playlists. */
    lane?: { name: string; live: boolean };
    /** That column's place among the columns (from 1), and how many there are. */
    column?: { number: number; total: number };
  },
): SongListModel {
  const total = tracks.length;
  // Every song with a box can be asked for: one of NetEase's queue (the one column, or the
  // playlist it came from) as it is, one of another playlist column with its playlist, which then
  // becomes NetEase's queue (the owner, 2026-10-10).
  const lane = options.lane;
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
      playable: select >= 0,
    };
  });
  const selected = options.selected;
  // A playlist column names itself; NetEase's own queue, the one column, is the QUEUE.
  const name = lane?.name ?? "播放队列", column = lane ? options.column : undefined;
  return {
    kind: "queue",
    id: `queue:${options.stamp}:${lane && !lane.live ? "browse" : "live"}:${total}:${digest(boxes)}`,
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
 * as a row of NetEase's queue does: moving never plays; its ▶ does (a song with a file the browser
 * can play: not a demonstration cover, not in an offline folder, not marked ↗, such as DSF / DFF,
 * which are only indexed: the review of 2026-10-08). What a row's marks mean is in its tooltip, and
 * an offline folder says so under the count (目录离线), with no note under the list.
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
      playable: select >= 0 && !options.demo && !song.offline && song.browserPlayable,
      hint: options.demo ? undefined : song.offline ? OFFLINE_HINT : song.browserPlayable ? undefined : KERNEL_HINT,
    };
  });
  const selected = songs.find((song) => song.id === options.selected);
  const column = options.column;
  const offline = songs.some((song) => song.offline);
  return {
    kind: "playlist",
    id: `playlist:${digest(rows.flatMap((row) => [row.key, row.number, row.title, row.artist, row.meta, row.select ?? -1, row.playable ? 1 : 0, row.hint ?? ""]))}`,
    tab: { label: "PLAYLIST", number: column?.number, total: column?.total, digits: 2, name: `歌单${column ? ` ${column.number} / ${column.total}` : ""}` },
    title: selected?.title ?? options.name,
    subtitle: selected ? [selected.artist || "歌手未提供", selected.album].filter(Boolean).join(" · ") : "",
    count: `共 ${songs.length} 首`,
    countNote: offline ? OFFLINE_HINT
      : songs.length && !options.demo ? options.time(songs.reduce((sum, song) => sum + song.duration, 0)) : undefined,
    label: options.name,
    listLabel: options.name,
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
    </div>
    <button class="music-back song-details" data-action="details"><span>↗ <span id="song-details-label">专辑详情</span></span> <kbd>S</kbd></button>
    <p class="song-caption"><i aria-hidden="true"></i><span id="song-label"></span></p>
  </div>
  <div id="song-glass" class="song-glass">
    <div class="song-head">
      <div class="song-tab"><span id="song-tab-text" class="song-tab-text"></span><span class="song-tab-label" aria-hidden="true"><span id="song-tab-label"></span><i class="song-tab-dot"></i></span><span class="song-tab-figure" aria-hidden="true"><b id="song-tab-number" class="song-tab-number"></b><span id="song-tab-total" class="song-tab-total"></span></span></div>
      <div class="song-tally"><span class="song-tally-row"><button id="song-go-playing" class="song-go-playing" data-action="go-playing" aria-label="回到正在播放的歌" hidden><i aria-hidden="true"></i><span></span></button><span id="song-count" class="song-count"></span></span><small id="song-count-note" class="song-count-note" hidden></small></div>
    </div>
    <div class="song-selected">
      <h2 id="song-title" class="song-title"></h2>
      <p id="song-subtitle" class="song-subtitle"></p>
      <div class="song-steps" role="group" aria-label="切换专辑"><button id="song-prev" data-action="prev" aria-label="上一张专辑"><i class="chevron chevron-up" aria-hidden="true"></i></button><button id="song-next" data-action="next" aria-label="下一张专辑"><i class="chevron chevron-down" aria-hidden="true"></i></button></div>
    </div>
    <div id="song-list" class="song-list" role="group" tabindex="-1"></div>
  </div>`;
}

/** Rows per block of the list; a block away from the visible part is not rendered at all. */
export const SONG_BLOCK_ROWS = 40;

/**
 * The list's rows (or its empty text); every field is plain text. Rows and headings have
 * fixed heights, so each block states its exact size (--rows, --groups) and the list's
 * length never changes while blocks come and go. Each row's number shares its cell with a ▶
 * (data-action="play-row", shown by song-scene.css in the number's place on a playable row that is
 * hovered, focused or selected; the owner, 2026-10-08, after NetEase's own list). It is not a
 * button of its own (a button cannot hold one): the row is the button, P plays its song, and so
 * does a double-click or a double tap on the row (rowClickKind; a single click only selects it).
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
      const marks = `${row.playable ? " data-playable" : ""}${row.hint ? ` title="${escapeHtml(row.hint)}"` : ""}`;
      block += `<button type="button" class="song-row" data-row="${index}"${target}${marks} tabindex="-1"${row.disabled ? " disabled" : ""}><span class="song-row-number">${escapeHtml(row.number)}</span>${row.playable ? '<span class="song-row-play" data-action="play-row" aria-hidden="true"></span>' : ""}<span class="song-row-copy"><strong>${escapeHtml(row.title)}</strong><small>${escapeHtml(row.artist)}</small></span><span class="song-row-meta">${escapeHtml(row.meta)}</span></button>`;
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
   * Where 这首歌 stands over the card (song-scene.css): the right edge of the case as it is seen
   * (its face, without the reach of its glow), and the drawn card's top edge.
   */
  card: { right: number; top: number };
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
  return { mode, unit, rail, glass, card: { right: card.x + card.width / 2, top: edgeTop } };
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
    "--songs-card-right": px(layout.card.right),
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

/** The press a click on a row's ▶ came from (SongListView keeps the last primary pointerdown). */
export interface RowPress {
  /** The pointerdown's pointerType: "mouse", "pen" or "touch" ("" when the browser does not say). */
  pointer: string;
  /** The list's row it landed on, if any. */
  row: object | null;
  /** Whether that row's ▶ was displayed at the press, before a tap could hover the row. */
  shown: boolean;
}

/**
 * Whether a click on a row's ▶ plays the row's song; otherwise it only selects the row. A mouse
 * plays: it hovers the row before it presses, so ▶ is what it clicked. Touch has no hover, yet
 * Chromium hovers the tapped row as the tap lands, so ▶ turns up under the finger before the click
 * is hit-tested (the review of 2026-10-08: a tap on a row's number played it). A tap or a pen's
 * press therefore plays only on the row it pressed, and only if that row showed ▶ before it (the
 * selected or the keyboard-focused row, or one a hovering pen was over); otherwise it selects.
 */
export function rowPressPlays(press: RowPress | undefined, row: object): boolean {
  if (!press || (press.pointer !== "touch" && press.pointer !== "pen")) return true;
  return press.row === row && press.shown;
}

/** A click on a song row (its ▶ or the rest of it), as SongListView keeps the last one. */
export interface RowClick {
  /** The clicks on the page so far, this one included (the one just before it: one less). */
  serial: number;
  /** Its timeStamp (ms) and where it was (client pixels). */
  at: number;
  x: number;
  y: number;
  /** Its pointerType: "mouse", "pen" or "touch" ("" when the browser does not say). */
  pointer: string;
  /** Its `detail`: how many clicks in a row the browser counted there (0 from the keyboard). */
  count: number;
}
export type RowClickKind = "single" | "double" | "more";
/**
 * A double tap, or a pen's double press: the second within this many ms and px of the first (the
 * shelf's DOUBLE_PRESS), for a browser that counts only a mouse's clicks (Chromium counts taps
 * too). `counted`: the longest a click the browser counted with the one before can follow it (the
 * longest double-click time Windows allows).
 */
export const ROW_DOUBLE = { ms: 500, px: 16, counted: 5000 } as const;

/**
 * What a click on a song row is (the owner, 2026-10-08: "double-click a song in the list to switch
 * to it"): "double" when it is the second click of a double-click or a double tap whose first, the
 * click just before it on the page (`previous`), was a "single" on a row; "more" for a further
 * click of that burst (a triple click), which does nothing; else "single". A mouse's double-click
 * is the system's: the browser counts it with the click before (detail one more, within the
 * system's double-click time and distance). A tap or a pen's press is also one when it comes
 * within ROW_DOUBLE of the click before, by the same kind of pointer. Where it landed is not
 * asked: the first click can scroll the list to reveal its row, so the second may find another
 * row under the pointer, and the burst is the first click's row's (SongListView.rowClick). A click
 * from the keyboard (detail 0: Enter on a focused row) is always "single", and no double begins
 * with it.
 */
export function rowClickKind(previous: (RowClick & { kind: RowClickKind }) | undefined, click: RowClick): RowClickKind {
  if (click.count <= 0 || !previous || previous.count <= 0 || click.serial !== previous.serial + 1) return "single";
  const after = click.at - previous.at;
  const counted = click.count === previous.count + 1 && after >= 0 && after < ROW_DOUBLE.counted;
  const near = click.pointer !== "mouse" && click.pointer === previous.pointer && after >= 0 && after < ROW_DOUBLE.ms
    && Math.hypot(click.x - previous.x, click.y - previous.y) <= ROW_DOUBLE.px;
  if (!counted && !near) return "single";
  return previous.kind === "single" ? "double" : "more";
}

/**
 * The level meter's bars (song-scene.css): each between 45% of its height and all of it, on its own
 * period (ms), starting `delay` ms after the meter does; the design's animation, ease-in-out either way.
 */
export const SONG_METER = [
  { period: 700, delay: 0 },
  { period: 820, delay: 120 },
  { period: 940, delay: 240 },
] as const;
/** CSS's ease-in-out, cubic-bezier(0.42, 0, 0.58, 1), at `x` (0..1): its x(t) solved for t, then y(t). */
export function easeInOut(x: number) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const ax = 0.52, bx = -0.78, cx = 1.26;
  const curve = (t: number) => ((ax * t + bx) * t + cx) * t;
  let t = x;
  for (let i = 0; i < 8; i++) {
    const error = curve(t) - x;
    if (Math.abs(error) < 1e-7) break;
    const slope = (3 * ax * t + 2 * bx) * t + cx;
    if (Math.abs(slope) < 1e-6) break;
    t -= error / slope;
  }
  if (!(t >= 0 && t <= 1) || Math.abs(curve(t) - x) > 1e-5) {
    // Bisection where Newton's steps do not settle (x(t) rises monotonically on 0..1).
    let low = 0, high = 1;
    for (let i = 0; i < 40; i++) {
      t = (low + high) / 2;
      if (curve(t) < x) low = t;
      else high = t;
    }
  }
  return t * t * (3 - 2 * t);
}
/** A bar's height (its scaleY) `elapsed` ms after its animation began: whole before it starts. */
export function meterScale(elapsed: number, period: number) {
  if (elapsed < 0) return 1;
  const phase = (elapsed % period) / period;
  return phase < 0.5
    ? 0.45 + 0.55 * easeInOut(phase * 2)
    : 1 - 0.55 * easeInOut(phase * 2 - 1);
}

/** The playing row's level meter (song-scene.css): three bars in the number's place, decorative. */
function songMeter() {
  const meter = document.createElement("i");
  meter.className = "song-meter";
  meter.setAttribute("aria-hidden", "true");
  for (let bar = 0; bar < 3; bar++) meter.append(document.createElement("i"));
  return meter;
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
  /**
   * The playable rows show ▶ (data-play): it plays their song, or, for NetEase's queue while its
   * port may not be used for a reason the user can change, says why (the page's requestPlay).
   */
  play?: boolean;
  /** The playing row's song is paused and ▶ can resume it (data-resume). */
  resume?: boolean;
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
  private readonly glass: HTMLElement;
  private readonly details: HTMLElement;
  /** The pane's layout and the card as setCard last placed them, for alignDetails. */
  private placed: { layout: SongSceneLayout; card: SongCard; portrait: boolean } | undefined;
  private detailsY = "";
  private readonly text: Record<"subtitle" | "tab" | "tabLabel" | "tabTotal" | "count" | "countNote" | "label", HTMLElement>;
  private rows: HTMLButtonElement[] = [];
  private rowKeys: string[] = [];
  private keys = new Map<string, HTMLButtonElement>();
  private id: string | undefined;
  private state: SongRowState = {};
  private marks: Partial<Record<RowMark, HTMLButtonElement>> = {};
  /**
   * The playing row's level meter (songMeter): one element, moved into whichever row plays, its bars
   * scaled by tickMeter. Drawn as the number cell's background, its animated heights restyled and
   * repainted the list on every display frame (measured 2026-10-10).
   */
  private meter: HTMLElement | undefined;
  /** When the meter's bars began to move (tickMeter); NaN while they stand still. */
  private meterStart = NaN;
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
  /** The last primary press anywhere on the page (playAllowed). */
  private press: RowPress | undefined;
  /** Clicks on the page so far (RowClick.serial). */
  private clicks = 0;
  /**
   * The last click on a row (rowClick): what it was, the row its burst began on, and whether the
   * burst has played that row's song.
   */
  private lastClick: (RowClick & { kind: RowClickKind; row: HTMLButtonElement; played: boolean }) | undefined;

  constructor(private readonly root: HTMLElement) {
    const find = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
    this.fadeTargets = [find(".song-chrome"), find(".song-glass")];
    this.list = find(".song-list");
    this.tabNumber = find("#song-tab-number");
    this.title = find(".song-title");
    this.steps = find(".song-steps");
    this.glass = find(".song-glass");
    this.details = find(".song-details");
    // The pane's type settles once its fonts arrive: 这首歌 follows the title's line.
    document.fonts?.addEventListener?.("loadingdone", () => this.alignDetails());
    this.text = {
      subtitle: find(".song-subtitle"),
      tab: find("#song-tab-text"), tabLabel: find("#song-tab-label"), tabTotal: find("#song-tab-total"),
      count: find(".song-count"), countNote: find(".song-count-note"),
      label: find("#song-label"),
    };
    // The tab stop follows the focus, so Tab returns to the row the user left.
    this.list.addEventListener("focusin", (event) => {
      const row = (event.target as HTMLElement).closest<HTMLButtonElement>(".song-row");
      if (row) this.setTabStop(row);
    });
    // Every primary press, before the page answers it (capture): by which pointer, on which of
    // the list's rows, and whether that row's ▶ was displayed then.
    document.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary) return;
      const hit = event.target instanceof Element ? event.target.closest<HTMLElement>(".song-row") : null;
      const row = hit && this.list.contains(hit) ? hit : null;
      const play = row?.querySelector<HTMLElement>(".song-row-play");
      this.press = { pointer: event.pointerType, row, shown: !!play && getComputedStyle(play).display !== "none" };
    }, true);
    // Every click on the page, before the page answers it: a double-click is two clicks in a row.
    document.addEventListener("click", () => {
      this.clicks++;
    }, true);
  }

  /**
   * Whether a click on `row`'s ▶ may play its song, or only select the row: a tap or a pen's
   * press plays only where ▶ showed before it (rowPressPlays); a mouse always plays.
   */
  playAllowed(row: HTMLElement) {
    return rowPressPlays(this.press, row);
  }

  /**
   * A click on `row`, its ▶ or the rest of it (rowClickKind): a "single" one, the second of a
   * double-click or a double tap ("double"), or a further click of that burst ("more"). `row` in
   * the answer is the row the burst began on, which the first click may have scrolled away from
   * under the pointer; `played`: a click before it in the burst has played that row's song already
   * (rowPlayed), so the double plays nothing more. A burst whose row the list no longer holds (the
   * rows were rebuilt in between) ends: the click is a single one. The click's pointer is its own,
   * else that of the press before it.
   */
  rowClick(row: HTMLButtonElement, event: MouseEvent): { kind: RowClickKind; row: HTMLButtonElement; played: boolean } {
    const pointer = (event as Partial<PointerEvent>).pointerType || this.press?.pointer || "";
    const click: RowClick = { serial: this.clicks, at: event.timeStamp, x: event.clientX, y: event.clientY, pointer, count: event.detail };
    // A burst whose row the list no longer holds (its rows were rebuilt in between) ends there.
    const kind = this.lastClick && this.list.contains(this.lastClick.row) ? rowClickKind(this.lastClick, click) : "single";
    const burst = kind === "single" || !this.lastClick ? { row, played: false } : this.lastClick;
    this.lastClick = { ...click, kind, row: burst.row, played: burst.played };
    return { kind, row: burst.row, played: burst.played };
  }

  /** The click rowClick has just answered played the row's song: the rest of its burst plays nothing. */
  rowPlayed() {
    if (this.lastClick) this.lastClick.played = true;
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
    this.setTitle(model.title, !reduced && !root.hidden);
    if (model.id !== this.id) this.rebuild(model);
  }

  /**
   * Row keys, whether the playing song is paused (mirrored as data-paused on the section),
   * whether the listed column holds what plays (data-live, the tab's dot) and whether ▶ can play
   * the playable rows or resume the paused one (data-play, data-resume). Touches at most the
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
    // The meter goes with the playing row, also into the new rows of a rebuilt list, and starts
    // over there (as the design's animation did on a new row).
    const cell = this.marks.playing?.querySelector<HTMLElement>(".song-row-number") ?? null;
    if (cell && this.meter?.parentElement !== cell) {
      cell.append(this.meter ??= songMeter());
      this.meterStart = NaN;
    } else if (!cell) this.meter?.remove();
    const flags = { paused: state.paused, live: state.live, play: state.play, resume: state.resume };
    for (const [name, on] of Object.entries(flags)) {
      const value = String(!!on);
      if (this.root.dataset[name] !== value) this.root.dataset[name] = value;
    }
    const current = row(state.selected) ?? row(state.playing);
    if (current !== this.current) {
      this.current?.removeAttribute("aria-current");
      current?.setAttribute("aria-current", "true");
      this.current = current;
    }
    // Until the user focuses a row, Tab enters the list at the current one.
    if (!this.list.contains(document.activeElement)) this.setTabStop(this.focusable(current));
  }

  /**
   * Moves the playing row's meter to `now` (ms), from the page's frame loop: about 60 times a second
   * where the scene rests (FramePacing), so the pane under it is composited that often instead of at
   * the display's rate, as a running animation had it (240 Hz here; measured 2026-10-10). The bars
   * stand whole while the song is paused, with reduced motion and while the view is hidden; they start
   * over when they move again. Returns whether they move.
   */
  tickMeter(now: number, reduced: boolean) {
    const meter = this.meter;
    const running = !!meter?.isConnected && !this.state.paused && !reduced && !this.root.hidden;
    if (!running) {
      if (!Number.isNaN(this.meterStart)) {
        this.meterStart = NaN;
        if (meter) for (const bar of meter.children) (bar as HTMLElement).style.removeProperty("transform");
      }
      return false;
    }
    if (Number.isNaN(this.meterStart)) this.meterStart = now;
    SONG_METER.forEach(({ period, delay }, index) => {
      const bar = meter!.children[index] as HTMLElement | undefined;
      const scale = meterScale(now - this.meterStart - delay, period);
      const transform = scale === 1 ? "" : `scaleY(${scale.toFixed(4)})`;
      if (bar && bar.style.transform !== transform) bar.style.transform = transform;
    });
    return true;
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
   * (after preventDefault) only when the focus is inside the list and the key was handled. `key`
   * is the key it counts as (a user's key for 上一首 / 下一首 counts as an arrow: 设置 → 快捷键).
   */
  handleKey(event: KeyboardEvent, key = event.key): boolean {
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !this.list.contains(active)) return false;
    const row = active.closest<HTMLElement>(".song-row");
    const from = Number(row?.dataset.row ?? -1);
    const to = rovingIndex(key, from, this.rows.length, Math.floor(this.list.clientHeight / (row?.offsetHeight || 48)) - 1,
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
    const key = JSON.stringify([layout.mode, layout.rail.shown, layout.rail.markerShown, style]);
    this.placed = { layout, card: rect, portrait };
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      for (const [name, value] of Object.entries(style)) this.root.style.setProperty(name, value);
      this.root.dataset.panel = layout.mode;
      this.root.dataset.rail = layout.rail.shown ? (layout.rail.markerShown ? "marker" : "line") : "none";
    }
    this.alignDetails();
  }

  /**
   * 这首歌 level with the second line of the selected song's title on the pane (the owner,
   * 2026-10-10: "parallel with this", beside a two-line title's second line): where that line is,
   * or would be, in the pane's own layout (its offsets, which the pane's turn and its entrance do
   * not change), projected as the pane is turned (projectSheet). It keeps clear above the case, and
   * its place does not move with the title's length. Not in portrait (the title is in the pane under
   * the card) and not before the pane has a box: there the card's top edge places it (song-scene.css).
   */
  alignDetails() {
    const placed = this.placed;
    if (!placed || placed.portrait) return this.setDetailsY("");
    if (this.root.hidden || !this.glass.offsetWidth) return;
    let x = 0, y = 0;
    for (let at: HTMLElement | null = this.title; at && at !== this.glass; at = at.offsetParent as HTMLElement | null) {
      x += at.offsetLeft;
      y += at.offsetTop;
    }
    const line = Number.parseFloat(getComputedStyle(this.title).lineHeight);
    if (!Number.isFinite(line) || line <= 0) return;
    const { layout: { glass }, card } = placed;
    const second = projectSheet(glass, x - glass.width / 2, y + 1.5 * line - glass.height / 2).y;
    const centre = Math.min(second, card.y - card.height / 2 - 4 - this.details.offsetHeight / 2);
    if (Number.isFinite(centre)) this.setDetailsY(`${Math.round(centre * 4) / 4}px`);
  }
  private setDetailsY(value: string) {
    if (value === this.detailsY) return;
    this.detailsY = value;
    if (value) this.root.style.setProperty("--songs-details-y", value);
    else this.root.style.removeProperty("--songs-details-y");
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
