import "@kitlangton/rolling-number/styles.css";
import { flushDesktopPreferences, isDesktop, saveDesktopPreferences } from "./desktop";
import { chooseMusicFolders } from "./local_music/connector/folders";
import { LocalLyrics } from "./local_music/connector/lyrics-api";
import {
  readLibrary, scanLibrary, enrichLibrary, startIntroductions, readOnlineConfig, saveOnlineConfig,
} from "./local_music/connector/library-api";
import "./style.css";
import "./quality-settings.css";
import "./document-decryption.css";
import "./decryption.css";
import "./music.css";
import "./music-navigation-motion.css";
import "./music-navigation-ruler.css";
import "./music-transport-title.css";
import "./music-theme.css";
import "./music-theme-switch.css";
import "./external-media.css";
import "./music-chrome.css";
import "./music-shelf.css";
import "./music-detail.css";
import "./song-scene.css";
import { caseSong, laneTrackKey, queueTrackKey } from "./netease_music/data/queue";
import { NETEASE_NAME, isNeteaseSource } from "./netease_music/connector/player";
import { NeteaseSession, PORT_BLOCK_NOTICE, type PortBlock } from "./netease_music/connector/session";
import { queueSettingMarkup } from "./netease_music/connector/settings";
import {
  playerLinks, playerMediaPort, pageSource, sourceAddress, markSourceSwitch, takeSourceSwitch, type SourceKind,
} from "./music-sources";
import { type LaneName } from "./lane-labels";
import { installWindowFrame } from "./window-frame";
import { WheelNavigation, WHEEL_PIXELS_PER_ROW } from "./wheel-navigation";
import { FrameCap } from "./frame-cap";
import {
  ExternalMediaConnection, nativeMediaPort, mediaLibrary, mediaVisualKey,
  mediaConnectionLabel, mediaTime, mediaSourcesMarkup,
  mediaPermissionMarkup, spacedName, type MediaAction, type SourceLink,
} from "./external_player/external-media";
import { DocumentDecryption } from "./document-decryption";
import type { Lyrics } from "./lyrics";
import { LyricsView, type LyricsClock } from "./lyrics-view";
import { ContentTransition, SurfaceTransition, DETAIL_SCENE, DETAIL_SWAP, SONG_SCENE } from "./ui-transitions";
import { qualityMarkup, syncQualityUI } from "./quality-settings";
import { ArchiveScene } from "./scene";
import {
  records,
  archiveColumns,
  columnFiles,
  fileLocation,
  setMusicAlbums,
  orderMusicAlbums,
  type MusicSortMode,
} from "./data";
import { wrap, type ArchiveNavigation } from "./archive-loop";
import {
  normalizeQuality,
  qualityPresets,
  type QualityPreset,
  type RenderQuality,
} from "./render-quality";
import { MusicPlayer, type MusicPlayerState } from "./local_music/connector/music-player";
import { ModelViewer } from "./model-viewer";
import { TerminalAudio } from "./audio";
import type {
  MusicAlbum,
  MusicGenre,
  MusicLibrary,
  MusicTrack,
} from "./music-types";
import { demoLibrary } from "./local_music/data/demo-library";
import {
  playlistShelf, playlistSongs, playlistQueue, introductionFits, type LocalShelf, type LocalSong,
} from "./local_music/data/playlists";
import { escapeHtml as esc } from "./html";
import { setupMusicTitleLayout, setupDetailTitle } from "./music-title";
import { setupMusicTextMotion, setupRollingNumber } from "./music-text-motion";
import { setupTransportTitle } from "./music-transport-title";
import { setupMusicTicks } from "./music-ticks";
import { setupMusicRuler } from "./music-ruler";
import { MusicPresentation, type AlbumSelection } from "./music-presentation";
import { MusicTrackFocus } from "./music-track-focus";
import { MusicBoot } from "./music-boot";
import { songCardRect, viewportLayout } from "./viewport-layout";
import { SongListView, playlistSongModel, queueSongModel, songSceneMarkup } from "./song-list";
import {
  SHORTCUTS, actionKeys, allowed, assign, changed, clear, eventCode, holder, isExtra, keyLabel,
  keyboardLayout, reset, sanitize, shortcutEvent, shortcutInfo, shortcutTable, slotAction, slotKey,
  spokenKey, type KeyLayout, type ShortcutAction, type ShortcutInfo, type ShortcutOverrides, type ShortcutSlot,
} from "./shortcuts";
import { SONG_VIEW } from "./song-pose";
import { MUSIC_COVER, MUSIC_MODEL } from "./music-model";

type Theme = "day" | "night";
type Panel = "library" | "search" | "settings" | "sources" | null;
/**
 * The current source: 本地音乐, or a player (the owner, 2026-10-06: no modes any more, only
 * sources). The page shows one of them, as its address says (`?source=player`, set by main.rs from
 * what was chosen last; music-sources.ts pageSource). Switching between 本地音乐 and a player loads
 * the page again with the other one (switchSource); switching to another player is done in place.
 */
const currentSource: SourceKind = pageSource(location.search);
const playerCurrent = currentSource === "player";
/** The switch that loaded this page (once; music-sources.ts takeSourceSwitch): no opening animation. */
const sessionStore = (() => { try { return sessionStorage; } catch { return undefined; } })();
const sourceSwitch = takeSourceSwitch(sessionStore, currentSource);
const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const setText = (node: HTMLElement, text: string) => { if (node.textContent !== text) node.textContent = text; };
// The header's previous / next marks: a bar and a triangle, drawn in CSS (music-chrome.css).
const skipGlyph = (direction: "prev" | "next") => direction === "prev"
  ? '<i class="skip-bar" aria-hidden="true"></i><i class="skip-tri skip-left" aria-hidden="true"></i>'
  : '<i class="skip-tri skip-right" aria-hidden="true"></i><i class="skip-bar" aria-hidden="true"></i>';
/**
 * The shelf's key hints, centred at the bottom: moving never plays (选歌, not 换歌), Enter opens
 * the details, S the song scene (its link's word: 歌单歌曲 in a NetEase playlist column), P plays
 * the selected song (a small triangle), L goes back to the song that plays, Space pauses or
 * resumes it (two bars). Written once; each shows only while its key can act (syncKeyHint), and
 * no sentence takes the place of one that cannot. P, L and SPACE wait hidden for the first sync.
 */
function keyHintMarkup() {
  const hint = (name: string, key: string, words: string, hidden = false) => `<span class="hint" data-hint="${name}"${hidden ? " hidden" : ""}><kbd>${key}</kbd><span>${words}</span></span>`;
  const glyph = (name: string, key: string, mark: string, words: string) => `<span class="hint" data-hint="${name}" hidden><kbd>${key}</kbd><i class="${mark}" aria-hidden="true"></i><span class="sr-only">${words}</span></span>`;
  return hint("move", "↑ ↓", "选歌") + hint("enter", "ENTER", "查看") + hint("songs", "S", playerCurrent ? "播放列表" : "选歌")
    + glyph("play", "P", "hint-play", "播放选中的歌") + hint("back", "L", "正在播放", true) + glyph("space", "SPACE", "hint-pause", "暂停 / 继续");
}
/**
 * The header row's sources (Claude Design's 播放器 · 本地音乐; the owner, 2026-10-06: one app, one
 * current source). The current one is in ink and demibold, like the chosen theme word, the other
 * muted. 播放器 opens the list of players, where choosing one makes it the current source; 本地音乐
 * makes the local music the current source. What only 本地音乐 has (音乐库, its main folder, and
 * 搜索) follows it while it is the current source. In a browser, where no player can be connected,
 * 播放器 is not offered.
 */
function sourceButtons() {
  const players = isDesktop || playerCurrent
    ? `<button data-action="sources" class="topnav-source" aria-pressed="${playerCurrent}" aria-label="${playerCurrent ? "播放器（当前来源）：选择外部播放器" : "播放器：选择外部播放器作为来源"}">播放器<span class="topnav-menu-only">来源</span><em class="topnav-menu-value" id="topnav-source"></em></button>`
    : "";
  const local = `<button data-action="local-source" class="topnav-source" aria-pressed="${!playerCurrent}" aria-label="${playerCurrent ? "本地音乐：切换到本地音乐" : "本地音乐（当前来源）"}">本地音乐${playerCurrent ? '<em class="topnav-menu-value">切换</em>' : ""}</button>`;
  const tools = playerCurrent ? ""
    : '<button data-action="library" aria-label="音乐库">音乐库</button><button data-action="search" aria-label="搜索">搜索<em class="topnav-menu-value">/</em></button>';
  return players + local + tools;
}
/** The 帧率上限 choices (frames a second; 0: as many as the display shows). */
const FRAME_CAPS = [0, 144, 120, 90, 60, 30];
const read =<T>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
  if (key === "rhine-music-preferences") saveDesktopPreferences(value);
};
const preferences = {
  ...{
    theme: "day" as Theme,
    sortMode: "genre" as MusicSortMode,
    quality: "original" as QualityPreset,
    reduced: false,
    // The opening animation (the 「开场动画」 setting; the owner, 2026-10-06). Off, every start
    // goes straight to the shelf, as the skip button does; a change applies at the next start.
    intro: true,
    volume: 0.65,
    songFade: true,
    bgm: true,
    bgmVolume: 0.18,
    sound: true,
    soundVolume: 0.22,
    renderQuality: undefined as RenderQuality | undefined,
    // While NetEase is the current source: show its saved play queue. Off until the user switches it on.
    // (▶, P, opening a song's details, a double-clicked row and the shelf's and the details' ring on
    // another song ask NetEase to play a song of its queue through its debugging port whenever the
    // port answers: no switch, the owner, 2026-10-09, "do not make this a setting option".)
    neteaseQueue: false,
    // One shelf column per NetEase playlist, read from its local database once the queue is
    // shown. On unless switched off (the owner's choice, 2026-10-04).
    playlistColumns: true,
    // The keys the user gave the scenes' actions (设置 → 快捷键; shortcuts.ts): only what differs
    // from the defaults.
    shortcuts: {} as ShortcutOverrides,
    // 帧率上限 (设置 → 通用; the owner, 2026-10-11: "add a max frame option in settings"): at most
    // this many runs of the frame loop, and so drawn frames, a second; 0 follows the display.
    frameCap: 0,
  },
  ...read<
    Partial<{
      theme: Theme;
      sortMode: MusicSortMode;
      quality: QualityPreset;
      reduced: boolean;
      intro: boolean;
      volume: number;
      songFade: boolean;
      bgm: boolean;
      bgmVolume: number;
      sound: boolean;
      soundVolume: number;
      renderQuality: RenderQuality;
      neteaseQueue: boolean;
      playlistColumns: boolean;
      shortcuts: ShortcutOverrides;
      frameCap: number;
      // The source chosen last, 本地音乐 or a player, and the player last connected (null after a
      // disconnect; read through readSourceLink): a plain start of the client opens that source
      // again and connects that player again (main.rs opens_player; the owner, 2026-10-06).
      // `source` replaces an earlier build's playerMode ("local" | "external"), dropped below.
      source: SourceKind;
      playerLink: SourceLink | null;
    }>
  >("rhine-music-preferences", {}),
};
let renderQuality = normalizeQuality(
  preferences.renderQuality || qualityPresets[preferences.quality],
);
if (!["day", "night"].includes(preferences.theme)) {
  preferences.theme = "day";
  save("rhine-music-preferences", preferences);
}
if (!Object.hasOwn(qualityPresets, preferences.quality))
  preferences.quality = "original";
if (typeof preferences.intro !== "boolean") preferences.intro = true;
// Keys of earlier builds, saved with every other preference: the playlist-name styles (gone),
// playlist columns when they were off by default (now under playlistColumns, so that the
// old default does not outlive the new one), and the switch for asking NetEase through its
// debugging port (gone: the port is used whenever it answers; the owner, 2026-10-09).
for (const key of ["laneLabels", "laneNameStyle", "neteasePlaylists", "neteaseControl"]) delete (preferences as Record<string, unknown>)[key];
if (!["genre", "artist", "album"].includes(preferences.sortMode))
  preferences.sortMode = "genre";
// The keys the user gave (shortcuts.ts sanitize): what this build cannot use, or two actions would
// share, goes back to its default; that is said once the page shows (start).
if (!FRAME_CAPS.includes(preferences.frameCap)) preferences.frameCap = 0;
const savedShortcuts = sanitize(preferences.shortcuts);
preferences.shortcuts = savedShortcuts.overrides;
/** Which action each key of the lookup runs (P, S, L, / and the 附加键s), for the keydown handler. */
let shortcutKeys = shortcutTable(preferences.shortcuts);
// Where a plain start of the client opens (main.rs opens_player): the source this page shows,
// saved on every load where it changed. An earlier build's mode (playerMode) was read by main.rs
// to open this page, its last use: it is dropped (migrated to `source`).
const earlierMode = Object.hasOwn(preferences, "playerMode");
delete (preferences as Record<string, unknown>).playerMode;
if (preferences.source !== currentSource || earlierMode) {
  preferences.source = currentSource;
  save("rhine-music-preferences", preferences);
}
// The players' connection while a player is the current source. The player it was last connected
// to is remembered and connected again by itself: when it comes back, and at the next start while
// a player was the current source; NetEase while no player was ever connected (the default link);
// nothing after a disconnect, until the user selects a player (music-sources.ts playerLinks). Only
// the player's identity is saved, never what it plays. Each known player's sources are shown as
// its module shows them (QQ Music's as 「QQ音乐」).
function rememberPlayer(link: SourceLink | null) {
  preferences.playerLink = link;
  save("rhine-music-preferences", preferences);
}
const externalMedia = playerCurrent
  ? new ExternalMediaConnection(playerMediaPort(nativeMediaPort), playerLinks(preferences.playerLink, rememberPlayer))
  : undefined;
// While 本地音乐 is the current source, the 播放器 panel lists the players to choose from, read only
// while it is open (refreshChooser). Its links are the same: choosing a player, or the default link
// connecting one while the panel is open, makes that player the current source (switchSource).
const playerChooser = !playerCurrent && isDesktop
  ? new ExternalMediaConnection(playerMediaPort(nativeMediaPort), playerLinks(preferences.playerLink, rememberPlayer))
  : undefined;
// NetEase while it is the current source: its queue and playlists, its debugging port, the song
// asked for and whether the shelf follows the song it plays (netease_music/connector/session.ts).
// It exists while 本地音乐 is the current source too, holding nothing, as its state always did.
const netease = new NeteaseSession({
  media: externalMedia,
  preferences,
  recordId: (index) => records[index]?.id,
  genreId: (index) => albums[index]?.genreId,
  indexOf: (id) => records.findIndex((record) => record.id === id),
  selected: () => selected,
  navigationSelection,
  canFollow: () => ready && !boot?.active && !panel && !libraryRebuilding,
  follow: (index, from) => select(index, rowNavigation(from, index)),
  songChanged: () => {
    updateQueueRows();
    updateSelection();
  },
  jumpChanged: () => {
    updateQueueRows();
    syncPlayButton();
  },
  confirmSoon,
  refresh: refreshExternal,
  notify,
  lyricsChanged: () => syncLyrics(),
});
// The details' lyrics (syncLyrics): their view, the local songs' reader and the two clocks.
const lyricsView = new LyricsView();
lyricsView.setReduced(preferences.reduced);
const localLyrics = new LocalLyrics(() => syncLyrics());
const neteaseLyricsClock: LyricsClock = {
  position: () => netease.playbackClock.position(performance.now()),
  playing: () => netease.debugState.playback === "playing",
};
const localLyricsClock: LyricsClock = {
  position: () => (loadedTrack() ? player?.position : undefined),
  playing: () => playerState?.transport === "playing",
};
// The columns are playlists, whatever the source: the main folder's subfolders for 本地音乐 (the
// owner, 2026-10-06), NetEase's playlists while it is the current source. The earlier arrangement
// setting (by genre, artist or album name) stays in the saved preferences (sortMode) but arranges
// nothing any more.
let libraryReceived = false,
  scanSubmitting = false;
let scanRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let library: MusicLibrary = {
  version: 1,
  albums: [],
  genres: [],
  roots: [],
  scan: { running: false },
  onlineEnabled: false,
};
let albums: MusicAlbum[] = [],
  genres: MusicGenre[] = [],
  demo = false,
  selected = 0;
// The local library as the shelf shows it: one column per playlist of the main folder, one case
// per song (local_music/data/playlists.ts).
let localShelf: LocalShelf = { albums: [], genres: [], songs: new Map(), lists: new Map() };
let mode: "archive" | "detail" = "archive",
  panel: Panel = null;
// An opened album shows its detail page or the song scene (a large card, the row as a
// chain of covers, the playlist as text); the scene remembers where it was opened from.
let menu: "detail" | "song" = "detail",
  songOrigin: "archive" | "detail" = "archive",
  menuSwapping = false,
  songStay = false,
  // The details stay while their document swaps for the previous / next song or album.
  detailStay = false,
  pendingSongFocus = false;
let scene: ArchiveScene | undefined,
  ready = false,
  apiAvailable = true,
  refreshing = false;
let introductionsStarting = false,
  libraryStateVersion = 0,
  introductionRequestError = "";
let viewer: ModelViewer | undefined;
let boot: MusicBoot | undefined;
const effects = new TerminalAudio();
effects.configure({
  sound: !playerCurrent && preferences.sound,
  music: false,
  soundVolume: preferences.soundVolume,
  musicVolume: 0,
});
if (!playerCurrent) document.addEventListener("pointerdown", () => void effects.unlock(), {
  once: true,
});
if (!playerCurrent) document.addEventListener("keydown", () => void effects.unlock(), {
  once: true,
});
let toastTimer: ReturnType<typeof setTimeout>,
  pollTimer: ReturnType<typeof setTimeout> | undefined;
// The case each column was left on, by column: names can repeat (two playlists of one name).
let columnMemory = new Map<number, string>();
let playerState: MusicPlayerState | undefined;
// Local playback and the atmosphere BGM exist only while 本地音乐 is the current source: with a
// player current, no Audio element or local playback queue is ever created.
const player = playerCurrent ? undefined : new MusicPlayer({
  volume: preferences.volume,
  songFadeEnabled: preferences.songFade,
  bgmEnabled: preferences.bgm,
  bgmVolume: preferences.bgmVolume,
});
const themeNames: Record<Theme, string> = {
  day: "暖昼",
  night: "深夜",
};
const stage = $("#stage");
stage.className = "music-app";
stage.dataset.mode = "archive";
stage.dataset.theme = preferences.theme;
stage.dataset.external = String(playerCurrent);
stage.dataset.menu = menu;
// The header's top right: the design's text row, or its "menu" form where the row does not fit
// (fitChrome); what the now-playing slot shows; the playback state its dot and ring are tinted by.
stage.dataset.chrome = "row";
stage.dataset.chromeMenu = "closed";
stage.dataset.now = "none";
stage.dataset.playback = "unknown";
stage.innerHTML = `
  <div id="three-scene" class="three-scene"></div>
  <div class="music-vignette" aria-hidden="true"></div>
  <header class="music-header">
    <div class="music-identity"><span class="music-brand"><strong>RHINE LAB</strong></span><button id="go-current" class="go-current" data-action="go-playing" data-shown="false" aria-label="回到当前"><i aria-hidden="true"></i><span>回到当前</span><kbd>L</kbd></button></div>
    <nav class="music-topnav" aria-label="音乐终端导航">
      <div class="topnav-modes" id="topnav-modes">
        ${sourceButtons()}
        <div class="topnav-theme"><span class="topnav-menu-only" aria-hidden="true">主题</span><div class="theme-switch" role="group" aria-label="主题">${(["day", "night"] as Theme[]).map((t) => `<button data-theme="${t}" aria-label="${themeNames[t]}主题" aria-pressed="${preferences.theme === t}">${themeNames[t]}</button>`).join("")}</div></div>
        <button data-action="settings" aria-label="设置">设置<i class="topnav-menu-value topnav-menu-square" aria-hidden="true"></i></button>
      </div>
      <i class="topnav-divider" aria-hidden="true"></i>
      <div class="minimal-transport" role="group" aria-label="音乐播放"><span class="now-playing"><i class="now-dot" aria-hidden="true"></i><span id="transport-track" class="transport-track" aria-hidden="true"><span id="transport-track-label"></span></span><span id="now-status" class="sr-only" role="status"></span></span>${playerCurrent ? `<button data-media-action="previous" class="transport-skip external-header-prev" aria-label="外部播放器上一曲" title="上一曲" disabled>${skipGlyph("prev")}</button>` : `<button data-action="previous-track" class="transport-skip transport-prev" aria-label="上一曲" title="上一曲" disabled>${skipGlyph("prev")}</button>`}<button data-action="play-pause" id="play-pause" class="play-ring" aria-label="播放" aria-pressed="false" data-ring="plain"><span class="transport-glyph transport-play" aria-hidden="true"></span><span class="transport-glyph transport-pause" aria-hidden="true"><i></i><i></i></span></button>${playerCurrent ? `<button data-media-action="next" class="transport-skip external-header-next" aria-label="外部播放器下一曲" title="下一曲" disabled>${skipGlyph("next")}</button>` : `<button data-action="next-track" class="transport-skip transport-next" aria-label="下一曲" title="下一曲" disabled>${skipGlyph("next")}</button>`}</div>
      <button class="topnav-menu-button" data-action="topnav-menu" aria-expanded="false" aria-controls="topnav-modes">菜单<i aria-hidden="true"></i></button>
    </nav>
  </header>
  <div id="library-status" class="library-status" hidden><i></i><span>${playerCurrent ? "正在发现外部播放器" : "正在读取本地音乐索引"}</span></div>
  <section id="music-browse" class="music-browse" aria-label="专辑浏览">
    <div class="music-browse-veil" aria-hidden="true"></div>
    <div class="selection-bracket" aria-hidden="true" data-shown="false"><i></i><i></i><i></i><i></i></div>
    <div class="album-callout">
      <div class="selection-tag-row"><span id="selection-code" class="selection-tag"><span id="selection-code-label">${playerCurrent ? "LIVE TRACK" : "PL 01 ·"}</span> <span id="selection-code-number" ${playerCurrent ? "hidden" : ""}>001</span></span><span id="selection-code-of" class="selection-code-of" ${playerCurrent ? "hidden" : ""}>/ <span id="selection-code-total">000</span></span></div>
      <h1 id="selection-title"></h1><p id="selection-artist" class="selection-artist"></p>
      <div class="selection-meta" id="selection-meta"><span class="selection-fact"><small id="selection-fact-a-key">专辑</small><span id="selection-fact-a" class="selection-fact-value"></span></span><span class="selection-fact selection-fact-count" ${playerCurrent ? "hidden" : ""}><small>曲目数</small><span id="selection-fact-b" class="selection-fact-value"></span></span></div>
      <div class="shelf-actions">
        <div class="shelf-play"><button data-action="shelf-play" id="shelf-play" class="play-ring play-ring-big" aria-label="播放" aria-pressed="false" data-ring="plain" ${playerCurrent ? "disabled" : ""}><span class="transport-glyph transport-play" aria-hidden="true"></span><span class="transport-glyph transport-pause" aria-hidden="true"><i></i><i></i></span></button><button id="shelf-play-note" class="shelf-play-note" data-action="go-playing" hidden><i aria-hidden="true"></i><span></span></button><span id="shelf-play-status" class="shelf-play-status" role="status"></span></div>
        <div class="shelf-links"><button class="open-album" data-action="open"><span id="open-album-label">${playerCurrent ? "当前曲目与控制" : "查看这首歌"}</span><i class="link-chevron" aria-hidden="true"></i></button><button class="open-songs" data-action="songs"><span id="open-songs-label">${playerCurrent ? "播放列表" : "选歌"}</span><i class="link-chevron" aria-hidden="true"></i></button></div>
      </div>
      <section id="playlist-drum" class="playlist-drum" aria-label="歌单" hidden>
        <div class="drum-head"><span id="genre-position" class="drum-position"><span id="genre-code">PLAYLIST</span> <span id="genre-index">01</span> / <span id="genre-total">00</span></span><span class="drum-steps"><button data-action="genre-prev" class="drum-step" aria-label="上一个歌单" title="上一个歌单"><i class="chevron chevron-left" aria-hidden="true"></i></button><button data-action="genre-next" class="drum-step" aria-label="下一个歌单" title="下一个歌单"><i class="chevron chevron-right" aria-hidden="true"></i></button></span></div>
        <div class="drum-window"><div class="drum-track" id="drum-track"></div></div>
      </section>
    </div>
    <div class="music-navigation">
      <div class="music-counter"><span class="music-counter-label" id="selection-counter-label">歌曲</span><div><b id="selection-number">01</b><span>/ <i id="selection-total">00</i></span></div></div>
      <div class="album-stepper"><button data-action="prev" aria-label="上一首" title="上一首"><i class="chevron chevron-up" aria-hidden="true"></i></button><div class="ruler-box"><div id="album-ticks"></div></div><button data-action="next" aria-label="下一首" title="下一首"><i class="chevron chevron-down" aria-hidden="true"></i></button></div>
    </div>
    <div class="music-keyhint" id="music-keyhint">${keyHintMarkup()}</div>
  </section>
  <section id="music-detail" class="music-detail" aria-label="${playerCurrent ? "当前曲目" : "歌曲详情"}" hidden>
    <div class="detail-exits">
      <button class="music-back" data-action="back"><span>← 返回专辑架</span> <kbd>ESC</kbd></button>
      <button class="music-back detail-songs" data-action="songs"><span>↗ <span id="detail-songs-label">${playerCurrent ? "播放列表" : "选歌"}</span></span> <kbd>S</kbd></button>
    </div>
    <p class="detail-caption" aria-hidden="true"><i></i><span id="detail-label"></span></p>
    <article id="album-detail-content" tabindex="-1"><div id="detail-head" class="detail-head"></div><h1 id="detail-title" class="detail-title"></h1><div id="detail-body" class="detail-body"></div></article>
  </section>
  <section id="music-song" class="music-song" aria-label="歌曲选择" hidden>${songSceneMarkup()}</section>
  <div id="music-empty" class="music-empty" hidden>${playerCurrent ? '<small>YOUR PLAYER / THIS WINDOW</small><h1>让正在听的歌进入档案馆。</h1><p id="external-empty-note" role="status" hidden></p><button data-action="sources" id="external-empty-sources">选择播放器 ↗</button><button data-action="local-source" class="subtle">改用本地音乐</button>' : '<small>YOUR PRIVATE COLLECTION</small><h1>让音乐进入这座档案馆。</h1><button data-action="library">选择音乐主文件夹 ↗</button><button data-action="demo" class="subtle">先查看演示歌单</button>'}</div>
  <div id="music-panel-root"></div><div id="music-toast" role="status" aria-live="polite"><span id="music-toast-text"></span><button id="music-toast-action" class="toast-action" type="button" hidden></button></div>
  <div id="music-loading"><span class="loading-orbit"></span>${sourceSwitch
    ? `<strong>SWITCHING SOURCE</strong><small>${playerCurrent ? "正在切换到播放器" : "正在切换到本地音乐"}</small>`
    : "<strong>OPENING THE ARCHIVE</strong><small>正在载入三维专辑架</small>"}</div>
`;
// A switch of the source keeps the header (and an open 播放器 panel) in view while the page loads:
// the loading cover stays under them (music.css), and the shelf comes without the opening.
if (sourceSwitch) stage.dataset.switching = "true";
installWindowFrame(stage);
const transportTitleMotion = setupTransportTitle(
  $("#transport-track"),
  $("#transport-track-label"),
);
transportTitleMotion.setReduced(preferences.reduced);
// The header's menu closes when the keyboard leaves it: its list and the 菜单 button.
$(".music-topnav").addEventListener("focusout", (event) => {
  const next = event.relatedTarget as Node | null;
  if (stage.dataset.chromeMenu === "open" && !$("#topnav-modes").contains(next) && !$(".topnav-menu-button").contains(next))
    setChromeMenu(false);
});
void document.fonts.ready.then(() => {
  fitChrome();
  // The song scene's pane keeps below the header's row, which the fonts can move.
  syncSongCard();
});
const titleMotion = setupMusicTitleLayout(stage);
// The details' title: set with the page, rolled in after previous / next (the document swap).
const detailTitle = setupDetailTitle($("#detail-title"));
const textMotion = setupMusicTextMotion(stage);
if (playerCurrent) {
  $<HTMLButtonElement>("#play-pause").disabled = true;
}
// Keep the previous navigation available while the ruler version is on trial.
const tickMotion = new URLSearchParams(location.search).get("nav") === "previous"
  ? setupMusicTicks($("#album-ticks"))
  : setupMusicRuler($("#album-ticks"), "歌曲");
let selectionInitialized = false;
const selectionMotionEnabled = () =>
  ready &&
  !boot?.active &&
  mode === "archive" &&
  !$("#music-browse").hidden &&
  !preferences.reduced;
function syncSelectionMotion() {
  // Build static reels during the hidden camera movement, before the text fades in.
  const enabled = selectionMotionEnabled() ||
    (mode === "archive" && !!albums.length && !preferences.reduced);
  textMotion.setEnabled(enabled);
  if (!enabled) titleMotion.finish();
  else {
    const album = currentAlbum();
    if (album) titleMotion.update(album.title, true);
  }
}

/**
 * The playlist list under the shelf's actions (the design's drum): the selected column in the
 * middle row, the columns around it in the shelf's looping order, as many odd rows (at most 7)
 * as fit above the bottom of the right column (one in portrait). Fewer columns than that: each
 * column once, in the fewest odd rows that hold them around the middle (so at most one row is
 * blank). A single column has no list. Its rows step through stepGenre, like ← → and the wheel
 * over it.
 */
const DRUM_MAX_ROWS = 7;
const drum = $("#playlist-drum"), drumTrack = $("#drum-track");
const drumRowNodes = Array.from({ length: DRUM_MAX_ROWS }, () => {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "drum-row";
  // The list is for the pointer; the keyboard has ← → and the two buttons above it.
  row.tabIndex = -1;
  row.innerHTML = '<span class="drum-n"></span><span class="drum-name"></span><i class="drum-dot" aria-hidden="true"></i><span class="drum-count"></span>';
  drumTrack.append(row);
  return row;
});
// A click on a row leaves the focus where it was, so Enter still opens the details.
drumTrack.addEventListener("mousedown", (event) => {
  if ((event.target as Element).closest(".drum-row")) event.preventDefault();
});
// The rows that fit (fitDrum) and the rows shown (renderDrum: no more than the columns need).
let drumFit = 0,
  drumRows = 0,
  drumRowHeight = 28,
  drumLane = -1,
  drumPlaying = -2;
// The wheel over the list: one column per notch (or 40 px), at most one every 110 ms.
const DRUM_WHEEL_STEP = 40, DRUM_WHEEL_GAP_MS = 110;
const drumWheel = { pending: 0, stepped: -Infinity, last: -Infinity };
function renderDrum(navigation?: ArchiveNavigation) {
  const columns = archiveColumns.length;
  const shown = columns > 1 && records.length > 0 && (!playerCurrent || netease.queueLanesShown.length > 1);
  if (drum.hidden === shown) drum.hidden = !shown;
  if (!shown) {
    drumLane = -1;
    return;
  }
  const rows = Math.max(1, Math.min(drumFit, columns % 2 ? columns : columns + 1));
  if (rows !== drumRows) {
    drumRows = rows;
    drum.style.setProperty("--drum-rows", String(rows));
  }
  const lane = fileLocation(selected).lane, middle = (rows - 1) / 2;
  // The column that holds NetEase's queue, or the loaded song's playlist (local).
  const playing = playingRecord();
  const live = playerCurrent
    ? archiveColumns.findIndex((_, column) => netease.laneAt(columnFiles(column)[0])?.live)
    : playing >= 0 ? fileLocation(playing).lane : -1;
  const digits = Math.max(2, String(columns).length);
  const unit = "首";
  drumRowNodes.forEach((row, k) => {
    const offset = k - middle;
    // With fewer columns than rows each column appears once: the nearer ones, then the next.
    const used = k < rows && (columns >= rows || (offset >= -Math.floor((columns - 1) / 2) && offset <= Math.ceil((columns - 1) / 2)));
    row.hidden = k >= rows;
    row.dataset.blank = String(!used);
    row.disabled = !used;
    row.setAttribute("aria-hidden", String(!used));
    if (!used) {
      delete row.dataset.laneStep;
      row.removeAttribute("aria-current");
      return;
    }
    const column = wrap(lane + offset, columns), name = archiveColumns[column] ?? "", count = columnFiles(column).length;
    row.dataset.laneStep = String(offset);
    row.dataset.live = String(column === live);
    row.setAttribute("aria-current", String(offset === 0));
    setText(row.children[0] as HTMLElement, String(column + 1).padStart(digits, "0"));
    setText(row.children[1] as HTMLElement, name);
    setText(row.children[3] as HTMLElement, String(count));
    row.title = name;
    row.setAttribute("aria-label", `${name}，${count} ${unit}`);
  });
  const previous = drumLane;
  drumLane = lane;
  if (previous < 0 || previous === lane) return;
  // A new column slides in from the side it came from (the shorter way round the loop).
  const forward = wrap(lane - previous, columns);
  const steps = navigation && "axis" in navigation && navigation.axis === "lane" && navigation.direction
    ? navigation.direction : forward <= columns / 2 ? forward : forward - columns;
  if (drumTrack.contains(document.activeElement)) drumRowNodes[Math.floor(middle)].focus({ preventScroll: true });
  if (preferences.reduced || !steps) return;
  drumTrack.animate(
    [{ transform: `translateY(${Math.sign(steps) * Math.min(3, Math.abs(steps)) * drumRowHeight}px)` }, { transform: "translateY(0)" }],
    { duration: 360, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  );
}
/** As many odd rows as fit in the room the right column leaves the list (one in portrait). */
function fitDrum() {
  if (drum.hidden) return;
  const style = getComputedStyle(drum);
  drumRowHeight = Number.parseFloat(style.getPropertyValue("--drum-row")) || 28;
  const head = (drum.firstElementChild as HTMLElement).offsetHeight + (Number.parseFloat(style.rowGap) || 0);
  let rows = stage.dataset.layout === "portrait" ? 1
    : Math.max(1, Math.min(DRUM_MAX_ROWS, Math.floor((drum.clientHeight - head) / drumRowHeight + 0.01)));
  if (rows % 2 === 0) rows -= 1;
  if (rows === drumFit) return;
  drumFit = rows;
  renderDrum();
}
new ResizeObserver(() => fitDrum()).observe(drum);
/** The wheel over the list turns it: one column per notch, at most one every 110 ms. */
function turnDrum(event: WheelEvent) {
  // When the notch happened, not when it is handled: a column change keeps the main thread
  // busy, and a second notch handled late must not count as a slow one.
  const now = event.timeStamp || performance.now();
  const notches = (event as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
  const notched = event.deltaMode === 0 && typeof notches === "number" && notches !== 0 && notches % 120 === 0;
  const delta = notched ? (-notches / 120) * DRUM_WHEEL_STEP
    : event.deltaY * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? innerHeight : 1);
  if (now - drumWheel.last > 400 || Math.sign(delta) !== Math.sign(drumWheel.pending)) drumWheel.pending = 0;
  drumWheel.last = now;
  drumWheel.pending += delta;
  if (Math.abs(drumWheel.pending) < DRUM_WHEEL_STEP || now - drumWheel.stepped < DRUM_WHEEL_GAP_MS) return;
  drumWheel.stepped = now;
  const direction = Math.sign(drumWheel.pending);
  drumWheel.pending = 0;
  stepGenre(direction);
}

/**
 * The selection bracket: four squares on the corners of the lifted case's box as the scene last
 * drew it on the shelf (scene.liftedCaseRect, null in the intro and while a case is opened),
 * following it with no easing of its own; hidden off the shelf and when the case is off screen.
 * It fades in and out with the shelf's other overlays (browseTransition).
 */
const selectionBracket = $(".selection-bracket");
let bracketKey = "";
function syncBracket() {
  const box = presentation.phase === "archive" ? scene?.liftedCaseRect ?? null : null;
  const width = stage.clientWidth, height = stage.clientHeight;
  const shown = !!box && box.right > 0 && box.left < width && box.bottom > 0 && box.top < height;
  // Quarter pixels: a resting case writes nothing.
  const q = (value: number) => Math.round(value * 4) / 4;
  const edges = shown ? [q(box!.left), q(box!.top), q(box!.right), q(box!.bottom)] : [];
  const key = edges.join(",");
  if (key === bracketKey) return;
  bracketKey = key;
  selectionBracket.dataset.shown = String(shown);
  if (!shown) return;
  ["--bl", "--bt", "--br", "--bb"].forEach((name, i) => selectionBracket.style.setProperty(name, `${edges[i]}px`));
}
// (The lifted case had a round ▶ of its own from 2026-10-07; the owner removed it on 2026-10-10:
// "delete the marked button, we already have a play button on the right", the shelf's ring.)
// These buttons hide once they have done their work (the selection is back on the song that plays):
// a click leaves the focus where it was, so Enter still opens the details.
for (const button of [$("#shelf-play-note"), $("#song-go-playing"), $("#go-current")])
  button.addEventListener("mousedown", (event) => event.preventDefault());
// The rings that play their song (the shelf's and the details', ringPlay) keep the focus where it was
// too: left on the ring, a later Enter would play the song browsed to instead of opening its details
// (2026-10-09 review). The details' ring is written anew with each song, hence the delegation.
document.addEventListener("mousedown", (event) => {
  if ((event.target as Element | null)?.closest?.('#shelf-play, [data-action="detail-play"]')) event.preventDefault();
}, true);
/**
 * A double press on a ring that plays its song (ringPlay) plays it once: the press after it within
 * the double-click time does not pause it. Touch's double tap on a song row alike (song-list.ts).
 */
const DOUBLE_PRESS = { ms: 500, px: 16 } as const;
/**
 * The press found the header's menu (its compact or portrait form) open: a press elsewhere closes
 * it (its focusout as the press takes the focus, else the page's click), so it is read here, before
 * either. On the lifted case that press opens the details, as it always did, and plays nothing (the
 * review of 2026-10-08: a click that dismisses a menu does not start music; openCase).
 */
let pressClosesMenu = false;
stage.addEventListener("pointerdown", () => {
  pressClosesMenu = stage.dataset.chromeMenu === "open";
}, true);

/**
 * A notice under the header's row, for 5.5 s. `action`: one button in it that opens a panel (the
 * 播放器 panel for a song that cannot be played until the user changes something there:
 * explainNoPlay), and the notice stays 8 s; the button closes it.
 */
function notify(message: string, action?: { label: string; panel: Exclude<Panel, null> }) {
  const toast = $("#music-toast"), button = $<HTMLButtonElement>("#music-toast-action");
  $("#music-toast-text").textContent = message;
  button.hidden = !action;
  if (action) {
    button.textContent = action.label;
    button.dataset.action = action.panel;
  } else delete button.dataset.action;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 8000 : 5500);
}
function hideToast() {
  clearTimeout(toastTimer);
  $("#music-toast").classList.remove("visible");
}
// The notice's button acts through the page's click (its data-action) and the notice goes with it.
$("#music-toast-action").addEventListener("click", hideToast);
function time(value: number) {
  const n = Math.max(0, Math.floor(value || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}
function genreName(id: string) {
  return genres.find((g) => g.id === id)?.name || "未分类";
}
function currentAlbum() {
  return albums.find((a) => a.id === records[selected]?.id);
}
/** The song of a local case: its track, its album record and its playlist (none while a player is the current source). */
function localSong(index = selected): LocalSong | undefined {
  return localShelf.songs.get(records[index]?.id ?? "");
}
/** A song's format in one line: container / codec · bits / rate · bitrate (what is known of it). */
function songFormat(t?: MusicTrack) {
  if (!t) return "未提供";
  const bits = t.lossless === false ? "有损编码" : t.bitsPerSample ? `${t.bitsPerSample} bit` : "";
  const rate = t.sampleRate ? `${Number((t.sampleRate / 1000).toFixed(1))} kHz` : "";
  return [
    t.codec ? `${t.format} / ${t.codec}` : t.format,
    [bits, rate].filter(Boolean).join(" / "),
    t.bitrate ? `${Math.round(t.bitrate / 1000)} kbps` : "",
  ].filter(Boolean).join(" · ") || "未提供";
}
function cover(a: MusicAlbum, className = "") {
  return a.coverUrl
    ? `<img class="${className}" src="${esc(a.coverUrl)}" alt="${esc(a.title)}专辑封面" loading="lazy">`
    : `<span class="cover-placeholder">♪</span>`;
}
// The redaction stays on the facts, the track names and the introduction; the title has its reel.
const documentDecryption = new DocumentDecryption(
  ".detail-album, .detail-meta span, .track-name strong, .album-about p",
  0.35,
);
const tabTransition = new ContentTransition();
// The details as a page (the exits, the document and the section label) rise into place and
// sink away; previous / next inside them swap only the document (DETAIL_SWAP).
const detailTransition = new SurfaceTransition(
  $("#music-detail"),
  $("#music-detail"),
  420,
  200,
  DETAIL_SCENE,
);
const documentSwap = new SurfaceTransition(
  $("#album-detail-content"),
  $("#album-detail-content"),
  250,
  170,
  DETAIL_SWAP,
);
const songView = new SongListView($("#music-song"));
// The chrome and the pane rise into place and sink away; the section itself is never faded or
// moved (see song-scene.css).
const songTransition = new SurfaceTransition($("#music-song"), undefined, 420, 200, SONG_SCENE, undefined, songView.fadeTargets);
// The pane's tab number (the playlist column's, two digits for every source), on the same 460 ms reel as the shelf's.
const songTabNumber = setupRollingNumber(songView.tabNumber, 2);
const browseTransition = new SurfaceTransition(
  $("#music-browse"),
  undefined,
  // Keep the existing reveal timing, but fade each overlay in its own layer.
  // Fading the parent traps its text below the night vignette until opacity=1.
  720,
  140,
  "up",
  "cubic-bezier(0.45, 0, 0.25, 1)",
  [$(".music-browse-veil"), $(".selection-bracket"), $(".album-callout"), $(".music-navigation"), $(".music-keyhint")],
);
let detailIdentity = "",
  pendingDetailFocus = false;
const trackFocus = new MusicTrackFocus();
let pendingSearchTrack: { albumId: string; trackId: string } | undefined;
function cancelSearchTrack() {
  pendingSearchTrack = undefined;
  trackFocus.cancel();
}
// The pane is interactive while its entrance is finishing. Cancel a queued
// reveal too, so a click/scroll in that interval is never pulled back later.
for (const event of ["wheel", "pointerdown", "touchstart", "keydown"] as const) {
  $("#album-detail-content").addEventListener(event, () => {
    if (pendingSearchTrack) cancelSearchTrack();
  }, { passive: true });
}
let libraryRebuilding = false;
type LibraryIntent = AlbumSelection & { openAfter: boolean } |
  { mode: "archive" | "detail" };
let libraryIntent: LibraryIntent | undefined;
const presentation = new MusicPresentation({
  presentationReady: () => scene?.musicPresentationReady ?? false,
  archiveReady: () => scene?.musicArchiveReady ?? false,
  archiveInteractive: () => scene?.musicArchiveInteractive ?? false,
  enterCamera: () => {
    scene?.setMode("detail");
    scene?.setSongStage(menu === "song");
    effects.setScene("detail");
    effects.play("open");
  },
  returnCamera: () => {
    scene?.setMode("archive");
    effects.setScene("archive");
    effects.play("back");
  },
  select: ({ index, navigation }) => commitSelection(index, navigation),
  switchDetail: ({ index, navigation }) => commitSelection(index, navigation, true),
  mode: (next) => {
    mode = next;
    stage.dataset.mode = next;
    // The shelf always reopens an album's detail page unless the song scene is asked for.
    if (next === "archive") {
      setMenu("detail");
      songStay = pendingSongFocus = false;
      // Esc or a search while the document was away for previous / next: the page itself
      // (its exits and section label stayed) leaves with the camera.
      detailStay = false;
      const detail = $("#music-detail");
      if (!detail.hidden && detail.dataset.transition !== "closing") {
        detail.inert = true;
        detail.setAttribute("aria-hidden", "true");
        detailTransition.hide(preferences.reduced);
      }
    }
    syncSelectionMotion();
    syncLyrics();
  },
  prepareMenu: () => {
    if (menu === "song") {
      if (!songStay) {
        songTransition.hide(true);
        $("#music-song").inert = true;
        $("#music-song").setAttribute("aria-hidden", "true");
      }
      renderSongs();
      return;
    }
    // Previous / next: the page stays and its document, away, takes the new song;
    // the title is held blank and rolls in when the document returns (showMenu).
    if (detailStay) {
      renderDetail();
      detailTitle.hold();
      return;
    }
    detailTransition.hide(true);
    documentSwap.show(true);
    renderDetail();
    $("#music-detail").inert = true;
    $("#music-detail").setAttribute("aria-hidden", "true");
  },
  showMenu: () => {
    if (menu === "song") {
      const section = $("#music-song");
      songStay = false;
      if (section.hidden || section.dataset.transition === "closing" || section.dataset.transition === "closed") {
        songTransition.show(preferences.reduced);
        // With a box now: 这首歌 level with the title's second line.
        songView.alignDetails();
        pendingSongFocus = true;
      }
      section.inert = !!panel;
      section.setAttribute("aria-hidden", "false");
      syncSongRows(true);
      return;
    }
    const detail = $("#music-detail"), content = $("#album-detail-content");
    const swapped = detailStay;
    detailStay = false;
    if (swapped) documentSwap.show(preferences.reduced);
    else detailTransition.show(preferences.reduced);
    detail.inert = !!panel;
    detail.setAttribute("aria-hidden", "false");
    content.inert = false;
    content.scrollTop = 0;
    // The design rolls the title only when the document returns; the page's entry fades it in.
    detailTitle.reveal(swapped && !preferences.reduced);
    documentDecryption.reset(content, preferences.reduced);
    pendingDetailFocus = true;
  },
  hideMenu: (done) => {
    if (menu === "song") {
      pendingSongFocus = false;
      // Moving along the playlist keeps the panel: only its text and the scene change.
      songStay = presentation.openingOrDetail && !menuSwapping && presentation.pendingSelection?.route !== "archive";
      if (songStay) {
        done();
        return;
      }
      $("#music-song").inert = true;
      $("#music-song").setAttribute("aria-hidden", "true");
      songTransition.hide(preferences.reduced, done);
      return;
    }
    trackFocus.cancel();
    pendingDetailFocus = false;
    tabTransition.cancel();
    // Moving to the previous / next song or album keeps the page: only its document leaves
    // (and returns with the new one once the scene has drawn the new case out).
    detailStay = presentation.openingOrDetail && !menuSwapping && presentation.pendingSelection?.route !== "archive" &&
      !$("#music-detail").hidden && $("#music-detail").dataset.transition !== "closing";
    if (detailStay) {
      $("#album-detail-content").inert = true;
      documentSwap.hide(preferences.reduced, done);
      return;
    }
    $("#music-detail").inert = true;
    $("#music-detail").setAttribute("aria-hidden", "true");
    detailTransition.hide(preferences.reduced, done);
  },
  hideBrowse: (done) => {
    $("#music-browse").inert = true;
    $("#music-browse").setAttribute("aria-hidden", "true");
    browseTransition.hide(preferences.reduced, done);
  },
  showBrowse: showBrowseSurface,
});
boot = new MusicBoot(stage, {
  reduced: () => preferences.reduced,
  intro: () => preferences.intro,
  onStart: () => {
    cancelSearchTrack();
    presentation.reset();
    detailTransition.hide(true);
    songTransition.hide(true);
    browseTransition.hide(true);
    scene?.setMode("hidden");
    syncSelectionMotion();
  },
  onComplete: (reason) => {
    const now = performance.now() / 1000;
    if (reason === "skip") scene?.showMusicArchiveImmediately(now);
    else scene?.finishMusicIntro(now);
    effects.setScene("archive");
    showBrowseSurface();
    showStartupNotice();
  },
  // A press during the fade-in shows the whole page at once: the shelf's own fade too.
  onRevealCut: () => browseTransition.finish(),
});
/**
 * For the first seconds the shelf shows, its rolling text keeps the layers it otherwise has only
 * while it rolls (music.css .layers-warm): the compositor builds their shaders behind the reveal,
 * as it did while they were layers all the time, instead of on the first roll. On a cold shader
 * cache (a new WebView2) that build stopped the picture for 4.7 s (measured 2026-10-10).
 */
stage.classList.add("layers-warm");
let layersWarm: ReturnType<typeof setTimeout> | undefined;
function showBrowseSurface() {
  if (!albums.length || boot?.active) return;
  layersWarm ??= setTimeout(() => stage.classList.remove("layers-warm"), 3000);
  browseTransition.show(preferences.reduced);
  $("#music-browse").inert = !!panel;
  $("#music-browse").setAttribute("aria-hidden", "false");
  syncSelectionMotion();
  if (!panel) $("[data-action=open]").focus({ preventScroll: true });
}
function savePrefs() {
  save("rhine-music-preferences", preferences);
}
function reloadPlayer() {
  void flushDesktopPreferences().then(() => location.reload()).catch((error) => notify(String(error)));
}
let sourceSwitching = false;
/**
 * Make 本地音乐 or a player the current source (the owner, 2026-10-06: one app, one current source).
 * The page is loaded again with the other one (music-sources.ts sourceAddress). Local playback and
 * the BGM stop first, and the choice is saved before the page goes, so that the next plain start
 * opens the same source (main.rs opens_player). The new page skips the opening animation and keeps
 * the header in view (takeSourceSwitch); `after.panel` opens the 播放器 panel again there, with
 * `after.session`, the session the user picked in it, connected.
 */
function switchSource(next: SourceKind, after: { panel?: boolean; session?: string } = {}) {
  if (next === currentSource || sourceSwitching) return;
  sourceSwitching = true;
  clearTimeout(chooserPoll);
  player?.stop();
  player?.dispose();
  preferences.source = next;
  savePrefs();
  markSourceSwitch(sessionStore, { to: next, panel: !!after.panel, ...(after.session ? { session: after.session } : {}) });
  void flushDesktopPreferences()
    .then(() => location.assign(sourceAddress(location.href, next)))
    .catch((error) => {
      sourceSwitching = false;
      notify(String(error));
    });
}
/**
 * The 播放器 panel while 本地音乐 is the current source: the players, read once a second while the
 * panel is open and at no other time. The user choosing one, or the default link connecting one
 * while the panel is open (the player last connected; NetEase while no player was ever connected,
 * AGENTS.md 2026-10-04; none after a disconnect), makes that player the current source.
 */
let chooserPoll: ReturnType<typeof setTimeout> | undefined;
let chooserVisual = "";
async function refreshChooser() {
  clearTimeout(chooserPoll);
  if (!playerChooser || panel !== "sources" || panelClosing || sourceSwitching) return;
  await playerChooser.refresh();
  if (panel !== "sources" || panelClosing || sourceSwitching) return;
  const connected = playerChooser.selected;
  if (connected) {
    choosePlayer(connected.id);
    return;
  }
  updateChooser();
  chooserPoll = setTimeout(() => void refreshChooser(), document.hidden ? 2000 : 1000);
}
/** A player chosen in the panel (or connected by the default link) becomes the current source. */
function choosePlayer(id: string) {
  updateChooser();
  switchSource("player", { panel: true, session: id });
}
/** What the panel says while 本地音乐 is current: who would be connected by itself, if anyone. */
function chooserLabel(chooser: ExternalMediaConnection) {
  const name = chooser.awaitsPreferred ? chooser.preferred!.name : "";
  if (chooser.selected) return `正在切换到${spacedName(chooser.selected.name)}…`;
  if (chooser.ambiguous) return `${name}有多个媒体会话，请选择要连接的一个`;
  if (name && chooser.remembers) return `上次连接的是${spacedName(name)}：它出现后会自动连接，也可以选择其他播放器`;
  if (name) return `未发现${name}；它出现后会自动连接，也可以选择其他播放器`;
  return "选择一个播放器，它就成为当前来源";
}
function updateChooser() {
  if (!playerChooser || panel !== "sources") return;
  const status = document.querySelector<HTMLElement>("#external-connection-status");
  if (status) setText(status, chooserLabel(playerChooser));
  const list = document.querySelector<HTMLElement>("#external-sources");
  const key = JSON.stringify([playerChooser.sources.map((item) => [item.id, item.name, item.title, item.artist]),
    playerChooser.selected?.id, playerChooser.preferred?.name ?? ""]);
  if (list && key !== chooserVisual) {
    chooserVisual = key;
    list.innerHTML = mediaSourcesMarkup(playerChooser);
  }
  const warning = [playerChooser.warning, playerChooser.error].filter(Boolean).join("\n");
  document.querySelectorAll<HTMLElement>("[data-media-warning]").forEach((node) => setText(node, warning));
  // 断开连接 forgets the player last connected (none is connected by itself afterwards).
  const disconnect = document.querySelector<HTMLButtonElement>('[data-action="disconnect-source"]');
  if (disconnect) disconnect.disabled = !playerChooser.remembers;
}
function setTheme(theme: Theme) {
  if (theme !== "day" && theme !== "night") theme = "day";
  if (theme === preferences.theme) return;
  preferences.theme = theme;
  stage.dataset.theme = theme;
  scene?.setTheme(theme, !preferences.reduced);
  viewer?.setTheme(theme);
  document
    .querySelectorAll<HTMLButtonElement>("button[data-theme]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.theme === theme)),
    );
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "night" ? "#08121f" : "#e8e5e1");
  savePrefs();
}
/** The least room the row form leaves the now-playing title before the menu form takes over. */
const ROW_TITLE_MIN = 96;
/** ... and the menu form, before it moves below the wordmark. */
const MENU_TITLE_MIN = 48;
/**
 * The header's top right (the design's chrome variants): the text row where it fits beside the
 * wordmark, else the menu form (now playing, previous, play, next | 菜单), always in portrait.
 * The choice follows the layout (data-layout) and the room the items really take, not a width
 * threshold. It also gives the now-playing title the room left (--song-cap) and tells the page
 * where the header ends (--chrome-bottom: the toast and the status line sit below it).
 */
function fitChrome() {
  const header = $(".music-header"), nav = $(".music-topnav"), now = $(".now-playing");
  const layout = stage.dataset.layout;
  // The title's room in a form: the header's width less the wordmark (unless the form is on
  // its own line) and every item but the title. One gap and the dot (5 + 8) stay with the slot.
  const room = (chrome: "row" | "menu", stacked: boolean) => {
    stage.dataset.chrome = chrome;
    stage.dataset.chromeStack = String(stacked);
    // The wordmark and 回到当前 beside it, whose room is kept while it is hidden.
    const box = header.getBoundingClientRect(), brand = $("#go-current").getBoundingClientRect();
    const transport = $(".minimal-transport"), gap = parseFloat(getComputedStyle(transport).columnGap) || 0;
    const shown = getComputedStyle(now).display !== "none";
    const fixed = nav.getBoundingClientRect().width - (shown ? now.getBoundingClientRect().width + gap : 0);
    const left = stacked ? box.left : brand.right + parseFloat(getComputedStyle(header).columnGap || "0");
    return box.right - left - fixed - gap - 13;
  };
  let chrome: "row" | "menu" = layout === "portrait" ? "menu" : "row", stacked = false;
  let space = room(chrome, stacked);
  if (chrome === "row" && layout === "compact" && space < ROW_TITLE_MIN) space = room(chrome = "menu", stacked);
  if (chrome === "menu" && space < MENU_TITLE_MIN) space = room(chrome, stacked = true);
  if (chrome === "row") setChromeMenu(false);
  // The design caps the slot at 230 px (260 in the menu form) with its dot; the label keeps
  // 6 px of that for the reel's unkerned characters (music-transport-title.css).
  const size = parseFloat(getComputedStyle(nav).fontSize) || 12;
  const most = ((chrome === "row" ? 230 : 260) - 13 + 6) * size / 12;
  // The slot is 14 px wider than its text (the reel's room); it does not push the transport.
  nav.style.setProperty("--song-cap", `${Math.round(Math.max(0, Math.min(space, most))) + 14}px`);
  const bottom = header.getBoundingClientRect().bottom - stage.getBoundingClientRect().top;
  stage.style.setProperty("--chrome-bottom", `${Math.round(bottom)}px`);
  // Where the wordmark's side ends (回到当前's room included): the song scene's line keeps clear of it.
  const identity = $("#go-current").getBoundingClientRect().right - stage.getBoundingClientRect().left;
  stage.style.setProperty("--identity-right", `${Math.round(identity)}px`);
}
/** The menu form's list (播放器来源, 本地音乐 and, while it is current, 音乐库 and 搜索; 主题, 设置). */
function setChromeMenu(open: boolean, focusButton = false) {
  const button = $(".topnav-menu-button"), list = $("#topnav-modes");
  const menu = stage.dataset.chrome === "menu";
  open &&= menu;
  const was = stage.dataset.chromeMenu === "open";
  stage.dataset.chromeMenu = open ? "open" : "closed";
  button.setAttribute("aria-expanded", String(open));
  if (open && !was) list.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  // Focus left in the closing list returns to the button (a panel opened from it returns there too).
  if (!open && menu && (focusButton || list.contains(document.activeElement))) button.focus({ preventScroll: true });
}
function fit() {
  // Use the same stage dimensions and aspect boundary as the scene framing.
  stage.dataset.layout = viewportLayout(stage.clientWidth, stage.clientHeight, false).kind;
  fitChrome();
  fitDrum();
  scene?.resize();
  viewer?.resize();
  syncSongCard();
  if (mode === "detail") documentDecryption.refresh();
}
window.addEventListener("resize", fit);
// The header is fitted again whenever it or the wordmark's side changes size once laid out: a new
// layout's margins and type (which can come frames after the resize is reported, as in Chromium's own
// emulation, where the form chosen at the resize would otherwise stay), the fonts, 回到当前's key.
const chromeWatch = new ResizeObserver(() => fitChrome());
chromeWatch.observe($(".music-header"));
chromeWatch.observe($(".music-identity"));

async function loadLibrary(force = false) {
  if (playerCurrent) return;
  // Keep the selected cards and cover atlas stable for the opening shot.
  if (boot?.active) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void loadLibrary(force), 1000);
    return;
  }
  if (refreshing) return;
  refreshing = true;
  const stateVersion = libraryStateVersion;
  try {
    const next = await readLibrary();
    apiAvailable = true;
    if (stateVersion === libraryStateVersion && !boot?.active) await receiveLibrary(next, force);
  } catch (error) {
    apiAvailable = false;
    updateStatus();
    updateIntroductionStatus();
    if (force)
      notify(
        `${(error as Error).message}。${isDesktop ? "请关闭后重新打开播放器，本机曲库数据会保留。" : "请使用 npm run music 启动本地音乐服务。"}`,
      );
  } finally {
    refreshing = false;
  }
  clearTimeout(pollTimer);
  pollTimer = setTimeout(
    () => void loadLibrary(),
    library.scan.running ||
      library.enrich?.running ||
      library.introductions?.running
      ? 1400
      : 12000,
  );
}
async function receiveLibrary(next: MusicLibrary, force = false) {
  const previousScan = library.scan;
  const scanCompleted = libraryReceived && !next.scan.running && !next.scan.error &&
    !!next.scan.finishedAt && next.scan.finishedAt !== previousScan.finishedAt;
  const scanFailed = libraryReceived && previousScan.running && !next.scan.running && !!next.scan.error;
  libraryReceived = true;
  const previousIntroductionRun = library.introductions;
  const changed =
    JSON.stringify(next.albums) !== JSON.stringify(library.albums) ||
    JSON.stringify(next.genres) !== JSON.stringify(library.genres) ||
    JSON.stringify(next.playlists) !== JSON.stringify(library.playlists);
  library = next;
  if (library.introductions?.running) introductionRequestError = "";
  if (changed || force) await applyLibrary();
  updateStatus();
  if (panel === "library") updateScanStatus();
  updateIntroductionStatus();
  if (
    previousIntroductionRun?.running &&
    library.introductions &&
    !library.introductions.running
  ) {
    const result = library.introductions;
    notify(
      result.error ||
        `专辑介绍查询完成：更新 ${result.updated} 张，未找到可靠资料 ${result.notFound} 张，查询失败 ${result.failed} 张。`,
    );
  }
  if (scanFailed) notify(`音乐库扫描失败：${next.scan.error}`);
  if (scanCompleted && !scanRefreshTimer) {
    notify("音乐库扫描完成，2 秒后自动刷新页面。");
    scanRefreshTimer = setTimeout(reloadPlayer, 2000);
  }
}
/**
 * What the open details or song scene show of the selection: its case and, for a local song, its
 * album record's introduction (songAbout), which the case does not carry.
 */
function detailKey() {
  const album = localSong()?.album;
  return JSON.stringify([currentAlbum(), album && [album.id, album.title, album.description, album.descriptionSource]]);
}
async function applyLibrary() {
  const hadAlbums = albums.length > 0;
  const previousId = currentAlbum()?.id;
  const previousIndex = selected;
  const previousDetail = detailKey();
  // The shelf as it was, for what still points into it (a selection on its way, a pending hop).
  const previousRecords = records;
  const visualKey = (items: MusicAlbum[], groups: MusicGenre[]) =>
    JSON.stringify([
      items.map((a) => [a.id, a.title, a.artist, a.genreId, a.coverUrl]),
      groups.map((g) => [g.id, g.name]),
    ]);
  // What the shelf shows, without its cases' keys (a NetEase picture on any of its image servers).
  const shapeKey = (items: MusicAlbum[], groups: MusicGenre[]) =>
    JSON.stringify([
      items.map((a) => [a.title, a.artist, a.genreId, a.coverKey ?? a.coverUrl]),
      groups.map((g) => [g.id, g.name]),
    ]);
  const oldVisual = visualKey(albums, genres);
  const oldShape = shapeKey(albums, genres);
  if (library.albums.length) demo = false;
  // The columns are playlists, in their own order: the main folder's (one case per song, as
  // NetEase's queue has it), or NetEase's.
  const displaySort: MusicSortMode = "genre";
  if (playerCurrent) {
    albums = orderMusicAlbums(library.albums, displaySort);
    genres = library.genres;
  } else {
    localShelf = playlistShelf(demo ? demoLibrary : library, demo);
    albums = localShelf.albums;
    genres = localShelf.genres;
  }
  setMusicAlbums(albums, genres, displaySort);
  syncLaneLabels();
  // New columns: the playlist list does not slide from a column of the previous library.
  drumLane = -1;
  selected = Math.max(
    0,
    records.findIndex((r) => r.id === previousId),
  );
  // A playlist asked to play from one of its songs (the owner, 2026-10-10) has become NetEase's
  // queue: the case it was asked from is gone, and the song asked for has a case of the queue's
  // own in the same column. The selection moves to it, and the request stands until NetEase
  // reports the song.
  const gone = playerCurrent && records.length > 0 && records[selected]?.id !== previousId;
  const jump = gone ? netease.queueJump : undefined;
  const asked = jump?.from && jump.from === previousId ? records.findIndex((record) => record.id === jump.key) : -1;
  if (asked >= 0) selected = asked;
  else if (gone) {
    // The box the user rested on is gone: it left NetEase's queue, or its column became or
    // stopped being the queue (the queue's cases have keys of their own). Nothing to play:
    // follow NetEase again from the song it plays now, whichever column that is. Asked of
    // the new queue (queuePlaying is still the last poll's), and never left in a column that
    // is not the queue, where following stops.
    netease.forgetQueueJumps();
    netease.queueFollowPaused = false;
    const key = netease.playingKey();
    const playing = key ? records.findIndex((record) => record.id === key) : -1;
    const liveColumn = archiveColumns.findIndex((_, column) => netease.laneAt(columnFiles(column)[0])?.live);
    if (playing >= 0) selected = playing;
    else if (liveColumn >= 0) selected = columnFiles(liveColumn)[0];
  }
  // A column opens where it was left: remembered cases that still exist are kept. A column
  // that was never visited has no entry and opens on its first case, whatever that now is.
  const remembered = new Set(columnMemory.values());
  columnMemory = new Map(
    archiveColumns.flatMap((_, lane) => {
      const kept = columnFiles(lane).find((index) => remembered.has(records[index].id));
      return kept === undefined ? [] : [[lane, records[kept].id] as [number, string]];
    }),
  );
  if (records[selected]) columnMemory.set(fileLocation(selected).lane, records[selected].id);
  // Where a case of the shelf as it was stands now: the same key, else the same song in the same
  // column (a playlist's cases and NetEase's queue's have keys of their own); -1 when it is gone.
  const moved = (index: number) => {
    const before = previousRecords[index];
    if (!before) return -1;
    const same = records.findIndex((record) => record.id === before.id);
    if (same >= 0) return same;
    const song = caseSong(before.id), column = before.album?.genreId;
    return records.findIndex((record) => record.album?.genreId === column && caseSong(record.id) === song);
  };
  // Only on NetEase's queue shelf: a source with one card is built again for each song, as before.
  const anchor = playerCurrent && hadAlbums && !!netease.shownQueue() ? moved(previousIndex) : -1;
  const shapeChanged = oldShape !== shapeKey(albums, genres);
  if (scene && ready && oldVisual !== visualKey(albums, genres) && anchor >= 0) {
    // NetEase's queue moved to another playlist, or back, or NetEase's playlists were read again,
    // and the song the selection rests on is still in its column. The cases took other keys, and
    // where NetEase's own copy of a playlist differs from the one saved on this PC (a song more or
    // less, another order, a picture on another of its image servers) other songs too. Nothing is
    // torn down (2026-10-16, the owner: "when I switch to a new playlist and click the play button,
    // it reloads the whole scene1"; 2026-10-10: the rebuild also closed and reopened the details or
    // the song scene, about 4.5 s): the selection stays on its song where it now stands, the lifted
    // case, the camera and an open details or song scene stay, the cases around take their songs in
    // place (scene.relayout), and no cover is painted again (cover-atlas.ts keys a print by its
    // picture). Where the selection has to go instead (following NetEase's song), it goes as any
    // selection does. A selection still on its way, or a hop waiting for one, keeps its song.
    const pending = presentation.pendingSelection;
    if (pending) {
      const index = moved(pending.index);
      if (index >= 0) presentation.pendingSelection = { ...pending, index, navigation: undefined };
      else presentation.pendingSelection = undefined;
    }
    if (gestureFor !== undefined) {
      const index = moved(gestureFor);
      gestureFor = index >= 0 ? index : undefined;
    }
    const target = selected;
    selected = anchor;
    scene.relayout(anchor);
    if (target !== anchor) select(target);
  } else if (scene && ready && oldVisual !== visualKey(albums, genres)) {
    const reopen = presentation.openingOrDetail;
    const reopenMenu = menu;
    cancelSearchTrack();
    libraryRebuilding = true;
    libraryIntent = undefined;
    presentation.reset();
    detailTransition.hide(true);
    songTransition.hide(true);
    browseTransition.hide(true);
    try { await scene.refreshLibrary(selected); }
    finally { libraryRebuilding = false; }
    const intent = libraryIntent as LibraryIntent | undefined;
    libraryIntent = undefined;
    scene.setMode("archive");
    // A rebuilt shelf (NetEase's queue changed) reopens the song scene it interrupted.
    const keepSongs = reopen && reopenMenu === "song" && songsAvailable();
    if (intent && "index" in intent) {
      // A selection made during the rebuild still returns to the song scene; a search
      // result keeps its shelf -> detail route.
      const songs = keepSongs && intent.route !== "archive";
      if (songs) setMenu("song");
      select(intent.index, intent.navigation, intent.openAfter || songs, intent.route);
      // A plain selection leaves the shelf at rest: reveal its overlay like the branch below.
      if (presentation.phase === "archive") showBrowseSurface();
    } else if ((intent ? intent.mode === "detail" : reopen) && albums.length) {
      if (keepSongs && !intent) setMenu("song");
      presentation.open();
    } else showBrowseSurface();
  }
  if (!albums.length) {
    cancelSearchTrack();
    presentation.reset();
  }
  stage.dataset.mode = mode;
  $("#music-empty").hidden = albums.length > 0;
  // Ordinary index refreshes must not reveal a page while its peer is exiting.
  if (!ready || !hadAlbums || !albums.length) {
    if (albums.length && mode === "archive") browseTransition.show(true);
    else browseTransition.hide(true);
    // Detail is revealed exclusively by the camera completion gate.
    if (presentation.phase !== "detail") {
      detailTransition.hide(true);
      songTransition.hide(true);
    }
    $("#music-browse").inert = !albums.length || mode !== "archive" || !!panel;
    $("#music-detail").inert = !albums.length || mode !== "detail" || menu !== "detail" || !!panel;
    $("#music-song").inert = !albums.length || mode !== "detail" || menu !== "song" || !!panel;
    $("#music-song").setAttribute("aria-hidden", String(!albums.length || mode !== "detail" || menu !== "song"));
    $("#music-browse").setAttribute(
      "aria-hidden",
      String(!albums.length || mode !== "archive"),
    );
    $("#music-detail").setAttribute(
      "aria-hidden",
      String(!albums.length || mode !== "detail" || menu !== "detail"),
    );
  }
  updateSelection();
  // The song scene lists the selected column: again when its songs changed under the selection.
  if (mode === "detail" && (previousDetail !== detailKey() || (menu === "song" && shapeChanged)))
    menu === "song" ? renderSongs() : renderDetail();
  updateStatus();
}
/**
 * The connection or library state in words. There is no status line any more: the
 * now-playing slot shows it while no song is there; #library-status, under the wordmark, only
 * what is out of the ordinary while a song is (scanning, the service down, the demonstration).
 * Errors are toasts. `tone` tints the slot's dot: the player's state, muted, muted and
 * pulsing while something is under way, or the paused colour when a link is lost.
 */
let libraryStatus = { text: "", tone: "muted" as NowTone, unusual: false };
type NowTone = "state" | "muted" | "working" | "warn";
function updateStatus() {
  if (externalMedia) {
    const text = mediaConnectionLabel(externalMedia, mediaPlayback());
    const lost = externalMedia.disconnected || (!!externalMedia.selectedId && !externalMedia.selected);
    libraryStatus = {
      text,
      tone: externalMedia.selected ? "state" : lost ? "warn" : externalMedia.awaitsPreferred ? "working" : "muted",
      unusual: !externalMedia.selected,
    };
    // A remembered source is awaited by name, and nothing asks to choose (the 播放器 panel can
    // still change it); NetEase, while nothing was ever connected, beside the other players;
    // after a disconnect, nothing is connected by itself. The empty page says only what is under
    // way or what the user must do (the owner, 2026-10-07: no descriptive text): 等待 X…, or which
    // of several sessions to connect; otherwise its buttons speak for themselves.
    const preferredName = externalMedia.preferred?.name ?? "";
    const awaited = externalMedia.remembers && externalMedia.awaitsPreferred && !externalMedia.ambiguous;
    const emptyNote = $("#external-empty-note");
    const emptyText = externalMedia.ambiguous ? `${preferredName}有多个媒体会话，请选择要连接的一个`
      : awaited ? `等待${spacedName(preferredName)}…` : "";
    setText(emptyNote, emptyText);
    if (emptyNote.hidden === !!emptyText) emptyNote.hidden = !emptyText;
    setText($("#external-empty-sources"), awaited ? "更换播放器 ↗" : "选择播放器 ↗");
    const queue = netease.shownQueue();
    // Diagnostics only (no longer shown): what the shelf holds.
    $("#three-scene").dataset.library = queue
      ? netease.queueLanesShown.length ? `NETEASE / ${netease.queueLanesShown.length} PLAYLISTS / ${albums.length} SONGS` : `NETEASE QUEUE / ${albums.length} TRACKS`
      : externalMedia.selected ? "CURRENT TRACK ONLY" : "NOT CONNECTED";
    syncNowPlaying();
    return;
  }
  // The main folder's playlists and their songs (each song is one case).
  const n = library.playlists?.length ?? 0,
    tracks = library.playlists?.reduce((sum, playlist) => sum + playlist.trackIds.length, 0) ?? 0;
  const working = !!library.scan.running ||
    !!library.enrich?.running ||
    !!library.introductions?.running;
  const label = !apiAvailable
    ? "本地音乐服务尚未连接"
    : library.scan.running
      ? "正在扫描音乐库…"
      : library.enrich?.running
        ? `补充在线资料 ${library.enrich.completed}/${library.enrich.total}`
        : library.introductions?.running
          ? `查询专辑介绍 ${library.introductions.completed}/${library.introductions.total}`
          : demo
            ? "演示歌单 · 选择音乐主文件夹后显示你的歌曲"
            : `${n} 个歌单 · ${tracks} 首歌曲 · 本地索引`;
  // An indexed library is the ordinary state: its counts are in the library panel.
  libraryStatus = { text: label, tone: !apiAvailable ? "warn" : working ? "working" : "muted", unusual: !apiAvailable || working || demo };
  $("#three-scene").dataset.library = demo
    ? "DEMONSTRATION"
    : `${n} PLAYLISTS / ${tracks} SONGS`;
  syncNowPlaying();
}
/**
 * The header's now-playing slot: the song that plays (not the selection), with a dot in the
 * playback state's colour; while there is none, the status in its place.
 */
function syncNowPlaying() {
  const source = externalMedia?.selected;
  const local = playerState?.currentTrack && ["playing", "paused", "loading"].includes(playerState.transport)
    ? playerState.currentTrack.title : "";
  const title = externalMedia ? source?.title || "" : local;
  // A player as the current source always has something to say (connected, waiting, lost); 本地音乐 only when unusual.
  const status = title ? "" : externalMedia || libraryStatus.unusual ? libraryStatus.text : "";
  const text = title || status;
  transportTitleMotion.update(text, !!text);
  const now = title ? "track" : status ? "status" : "none";
  if (stage.dataset.now !== now) stage.dataset.now = now;
  const tone = title ? "state" : libraryStatus.tone;
  if (stage.dataset.nowTone !== tone) stage.dataset.nowTone = tone;
  setText($("#now-status"), text);
  // The full words, under the wordmark, only when unusual and not already in the slot.
  const line = $("#library-status");
  setText($("#library-status span"), libraryStatus.text);
  line.classList.toggle("working", libraryStatus.tone === "working");
  line.hidden = !(libraryStatus.unusual && title);
  // The menu form names the connected player beside 播放器来源 (选择 while 本地音乐 is the current
  // source): 网易云音乐 for either way NetEase is connected (the owner, 2026-10-06), QQ音乐 or as listed.
  const name = document.querySelector<HTMLElement>("#topnav-source");
  if (name) setText(name, !playerCurrent ? "选择" : source ? (isNeteaseSource(source) ? NETEASE_NAME : source.name) : "未连接");
}
/**
 * The name of the column the selection stands in: a playlist (or 播放队列 while the queue is the
 * one column), the connected player for a lone live track, or the main folder's playlist locally.
 */
function columnName() {
  if (externalMedia) {
    const source = externalMedia.selected;
    if (!netease.shownQueue()) return source ? isNeteaseSource(source) ? NETEASE_NAME : source.name : "";
    return netease.laneAt()?.name ?? "播放队列";
  }
  return archiveColumns[fileLocation(selected).lane] ?? "";
}
function updateSelection(navigation?: ArchiveNavigation) {
  const a = currentAlbum();
  if (!a) {
    selectionInitialized = false;
    textMotion.finish();
    titleMotion.finish();
    return;
  }
  const location = fileLocation(selected),
    files = columnFiles(location.lane),
    idx = files.indexOf(selected);
  const lane = netease.laneAt(), queue = !!netease.shownQueue();
  const column = `PL ${String(location.lane + 1).padStart(2, "0")} ·`;
  // The tag: QUEUE (NetEase's own queue), PL nn · (a playlist column: NetEase's, for browsing,
  // or a local one), or a lone live track.
  setText($("#selection-code-label"), queue ? (lane && !lane.live ? column : "QUEUE")
    : playerCurrent ? "LIVE TRACK" : column);
  if (queue) {
    // The song scene lists the selected column: the queue, or a playlist that is not it. The
    // details' way there is the design's 播放列表 for both.
    setText($("#open-songs-label"), lane && !lane.live ? "歌单歌曲" : "播放列表");
  }
  // The details' section label (bottom left): the column the selection stands in.
  setText($("#detail-label"), columnName());
  const animated = selectionInitialized && selectionMotionEnabled();
  selectionInitialized = true;
  textMotion.update(
    {
      number: idx + 1,
      total: files.length,
      genresTotal: archiveColumns.length,
      // A playlist column counts its own songs (local playlists too).
      code: idx + 1,
      codeTotal: files.length,
      genreIndex: location.lane + 1,
      artist: a.artist,
      // The design's two facts: the song's album and the column's song count (a local song: its
      // own album tag); a lone live track has its album only.
      factA: queue ? netease.laneSong()?.album || "未提供" : externalMedia ? externalMedia.selected?.album || "未提供"
        : localSong()?.track.album || "未提供",
      factB: playerCurrent && !queue ? "" : `${files.length} 首`,
    },
    animated,
    navigation,
  );
  titleMotion.update(a.title, animated);
  $("#selection-title").title = a.title;
  // The ticks know a case by its song: the same songs under new keys (NetEase's queue moved to
  // another playlist) are the same ticks, not a new group that ripples in.
  tickMotion.update(
    files.map((index) => ({ index, id: caseSong(records[index].id), title: records[index].title })),
    selected,
    preferences.reduced,
    navigation,
  );
  renderDrum(navigation);
  syncPlayingMarks();
  // The play rings act on the selection (a library that arrived, a column that changed).
  syncPlayButton();
  // Hidden archive content can prepare its static reels before the reveal.
  if (!animated) syncSelectionMotion();
}
function commitSelection(index: number, navigation?: ArchiveNavigation, keepDetail = false) {
  selected = wrap(index, records.length);
  columnMemory.set(fileLocation(selected).lane, records[selected].id);
  if (keepDetail) scene?.switchMusicAlbum(selected, navigation);
  else scene?.select(selected, navigation);
  updateSelection(navigation);
  syncPlayButton();
  effects.play(
    navigation && "axis" in navigation && navigation.axis === "lane"
      ? "column"
      : "tick",
  );
  // ▶ on a song the selection was still moving to: its case hops now that it is the lifted one.
  if (gestureFor !== undefined) {
    const due = gestureFor === selected;
    gestureFor = undefined;
    if (due) {
      scene?.playGesture();
      if (records.length) tickMotion.ripple();
    }
  }
}
function select(index: number, navigation?: ArchiveNavigation, openAfter = presentation.openingOrDetail, route?: AlbumSelection["route"]) {
  if (!records.length || !ready || boot?.active || index < 0) return;
  if (route !== "archive") cancelSearchTrack();
  const pending = libraryRebuilding && libraryIntent && "index" in libraryIntent
    ? libraryIntent : presentation.pendingSelection;
  const previous = pending?.navigation;
  if (pending) {
    // Coalesced key presses still reach the matching physical loop cell.
    navigation = previous && navigation && "axis" in previous && "axis" in navigation && previous.axis === navigation.axis
      ? { axis: navigation.axis, direction: previous.direction + navigation.direction }
      : undefined;
  }
  if (libraryRebuilding) {
    libraryIntent = { index: wrap(index, records.length), navigation, openAfter, route };
    return;
  }
  // A search result always opens the detail page, also over a song scene that is still
  // waiting for the shelf to settle.
  if (route === "archive" && mode === "archive") setMenu("detail");
  presentation.select({ index: wrap(index, records.length), navigation, route }, openAfter);
  // P, L, ● and the key hints act on where the selection is going: follow it while a detail switch waits.
  syncPlayButton();
}
function navigationSelection() {
  if (libraryRebuilding && libraryIntent && "index" in libraryIntent) return libraryIntent.index;
  return presentation.pendingSelection?.index ?? selected;
}
function stepAlbum(direction: number) {
  if (playerCurrent && !netease.shownQueue()) return;
  netease.queueFollowPaused = true;
  if (!records.length) return;
  const cursor = navigationSelection();
  const files = columnFiles(fileLocation(cursor).lane);
  if (files.length > 1)
    select(files[wrap(files.indexOf(cursor) + direction, files.length)], {
      axis: "row",
      direction,
    });
}
function stepGenre(direction: number) {
  if (playerCurrent && !netease.shownQueue()) return;
  netease.queueFollowPaused = true;
  if (!records.length || archiveColumns.length < 2) return;
  const lane = wrap(
    fileLocation(navigationSelection()).lane + direction,
    archiveColumns.length,
  );
  // Stepping into NetEase's own queue lands on the song it plays and follows it again. Any
  // other column opens where it was left.
  const live = !!netease.laneAt(columnFiles(lane)[0])?.live;
  const playing = live ? records.findIndex((r) => r.id === netease.queuePlaying) : -1;
  // Also when the playing song has no case there: the remembered case is shown, not played.
  if (live) netease.queueFollowPaused = false;
  // The wheel's rows still owed belong to the column that is being left.
  wheelNavigation.reset();
  const remembered = columnMemory.get(lane);
  const index = playing >= 0 ? playing : records.findIndex((r) => r.id === remembered);
  select(index >= 0 ? index : columnFiles(lane)[0], {
    axis: "lane",
    direction,
  });
}
function setMode(next: "archive" | "detail") {
  if (boot?.active) return;
  if (next === "archive") cancelSearchTrack();
  if (libraryRebuilding) { libraryIntent = { mode: next }; return; }
  // A song scene still waiting for the shelf to settle is dropped with its request; an
  // opened menu (mode "detail") keeps its own exit and is reset when the shelf returns.
  if (mode === "archive") setMenu("detail");
  if (next === "detail") {
    if (currentAlbum()) presentation.open();
  } else presentation.back();
}
function setMenu(next: "detail" | "song") {
  menu = next;
  stage.dataset.menu = next;
  syncLyrics();
}
/** The song scene lists an album's songs or NetEase's queue; a lone live track has neither. */
function songsAvailable() {
  return !!currentAlbum() && (!playerCurrent || !!netease.shownQueue());
}
function openSongs() {
  if (boot?.active || !ready || libraryRebuilding || panel || viewer?.isOpen || !songsAvailable() || menu === "song") return;
  if (presentation.phase === "archive") {
    songOrigin = "archive";
    setMenu("song");
    presentation.open();
  } else {
    // From an opened album; refused while it is still opening or its text is leaving.
    menuSwapping = true;
    const swapped = presentation.swapMenu(() => {
      // Before the panel is rendered: the menu and the scene switch to the song stage.
      songOrigin = "detail";
      setMenu("song");
      scene?.setSongStage(true);
    });
    menuSwapping = false;
    // Changing view cancels a search result's locate animation, as elsewhere.
    if (swapped) cancelSearchTrack();
  }
}
/**
 * Swap the song scene for the opened case's details, wherever the song scene was opened
 * from; false when refused (still arriving, text leaving, shelf settling after a rebuild).
 */
function swapToDetail() {
  if (menu !== "song" || libraryRebuilding || boot?.active) return false;
  menuSwapping = true;
  const swapped = presentation.swapMenu(() => {
    setMenu("detail");
    scene?.setSongStage(false);
  });
  menuSwapping = false;
  return swapped;
}
/**
 * The three scenes (the shelf, the opened case's details, the song scene) each lead to the
 * other two, and the keys mean the same in every one of them: Enter (or clicking the
 * selected case, which on the shelf also plays its song: openCase) opens the details, S switches
 * to the song scene and back to the details, Esc returns to the shelf. (Enter on a focused
 * button does what the button does: on a row of the song list it selects that row.) S is never
 * a way out to the shelf; while a swap is refused (still opening, text leaving, shelf settling
 * after a rebuild) it is ignored.
 */
function toggleSongs() {
  if (menu !== "song") openSongs();
  // S from the song scene opens the song's details, and plays it (openCase; the owner, 2026-10-09).
  else openCase(true, swapToDetail);
}
/** Song details: opened from the shelf, swapped in from the song scene (false when that swap is refused). */
function showDetails() {
  if (menu === "song") return swapToDetail();
  setMode("detail");
  return true;
}
/**
 * Opening the selected song's details plays it: a click or a tap on the shelf's lifted case (the
 * owner, 2026-10-08: "when I click a box to enter scene2, it should just switch to that song and play
 * it"), and since 2026-10-09 ("also play this song") Enter, the 查看这首歌 link, the song scene's large
 * card, its 这首歌 link and S from there. Its song plays as ▶ plays it (selectionPlay, playSelection)
 * and its details open (`open`: as each of them opened them before). 本地音乐: the player plays it and
 * continues through its playlist. NetEase: 播放队列中这首歌 for a song of its queue, or for a song of
 * another playlist column that playlist from the song (2026-10-10), while the port answers, or the
 * paused song it plays resumes. The song that plays goes on (opening never pauses), and where the song
 * cannot be played (the port down, private FM, a source with one card, a local song the browser cannot
 * play: ↗) only the details open, as do a press
 * that closes the header's open menu (`play` false: pressClosesMenu) and Enter on details already open.
 * Where only a reason the user can change stands in the way (the port down, private FM: playBlock),
 * the page says so as the details open (requestPlay; the owner, 2026-10-09: the click "doesn't switch
 * to that song or play it", silently). The case being drawn out is the motion: it does not hop first
 * (the review of 2026-10-08: it rose twice), while the waves and the ruler's ring answer the play
 * (playWaves). A double click opens and plays once: its second press finds the case on its way out
 * (scene.onSelect answers it only on the shelf), and the song asked for is no longer one to play. Rows
 * the wheel still owes are dropped: they would carry the opened details away from the song that was
 * clicked (and plays). From the song scene the song plays once the swap to the details is accepted.
 */
function openCase(play = true, open: () => boolean | void = showDetails) {
  // Open or opening already (Enter on the details): they do what they did, nothing plays again.
  if (presentation.openingOrDetail && menu === "detail") return void open();
  const index = selected;
  const plays = play && navigationSelection() === index;
  wheelNavigation.reset();
  if (menu === "song") {
    // From the song scene the swap may be refused (still arriving, its text leaving): play once it is not.
    if (open() !== false && plays) requestPlay(index, false);
    return;
  }
  if (plays) requestPlay(index, false);
  open();
}
/** Esc and the back buttons: the shelf, from the details and from the song scene alike. */
function leaveMenu() {
  setMode("archive");
}
/**
 * The song panel's first paint builds its glass layers and their blur. Doing that once under
 * the loading screen keeps the panel's first entrance from stuttering.
 */
async function prewarmSongPanel() {
  const section = $("#music-song");
  if (!section.hidden) return;
  syncSongCard();
  section.inert = true;
  section.hidden = false;
  songView.alignDetails();
  // Two painted frames, or a short wait when the window is not being painted at all.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 300);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
  });
  section.hidden = true;
}
function syncSongCard() {
  // The pane's near top corner keeps below where the header's row ends (fitChrome).
  const chromeBottom = Number.parseFloat(stage.style.getPropertyValue("--chrome-bottom")) || 0;
  songView.setCard(songCardRect(stage.clientWidth, stage.clientHeight, SONG_VIEW.span, MUSIC_MODEL.width, MUSIC_MODEL.height), chromeBottom);
}
function renderSongs() {
  const a = currentAlbum();
  if (!a) return;
  const queue = netease.shownQueue();
  const model = queue ? (() => {
    const index = new Map(records.map((record, i) => [record.id, i] as const));
    // With playlist columns the panel lists the selected column.
    const lane = netease.laneAt();
    return queueSongModel(lane ? lane.tracks : queue.tracks, {
      stamp: lane ? `${netease.queueStamp ?? ""}:${netease.playlistStamp ?? ""}:${lane.id}` : netease.queueStamp ?? "",
      truncated: lane ? lane.truncated : queue.truncated,
      selected: netease.laneSong(),
      keyOf: lane ? (track) => laneTrackKey(lane, track) : queueTrackKey,
      indexOf: (key) => index.get(key) ?? -1,
      time,
      lane: lane && { name: lane.name, live: lane.live },
      column: { number: fileLocation(selected).lane + 1, total: archiveColumns.length },
    });
  })() : localSongModel();
  songView.render(model, preferences.reduced);
  // The tab's number rolls while the scene is on screen (← → to another playlist, ↑ ↓ to another album).
  const section = $("#music-song");
  if (model.tab.number !== undefined)
    songTabNumber.update(model.tab.number, !preferences.reduced && !section.hidden && section.dataset.transition !== "closed");
  // Every case is a song (NetEase's or a local playlist's): the details are the song's.
  $("#song-details-label").textContent = "这首歌";
  for (const [id, words] of [["#song-prev", "上一首"], ["#song-next", "下一首"]] as const) {
    $(id).setAttribute("aria-label", words);
    $(id).title = words;
  }
  syncSongCard();
  syncSongRows(true);
}
/**
 * The local song scene: the selected song's playlist, one row per song. A row selects that song's
 * case (moving never plays); its number is the playlist's column.
 */
function localSongModel() {
  const song = localSong(), index = new Map(records.map((record, i) => [record.id, i] as const));
  const songs = song ? playlistSongs(localShelf, song.playlist.id) : [];
  return playlistSongModel(songs.map(({ id, track, album }) => ({
    id, title: track.title, artist: track.artist, album: track.album, format: track.format,
    browserPlayable: track.browserPlayable, duration: track.duration, offline: album.offline,
  })), {
    name: song?.playlist.name ?? columnName(), selected: song?.id, indexOf: (id) => index.get(id) ?? -1, time, demo,
    column: { number: fileLocation(selected).lane + 1, total: archiveColumns.length },
  });
}
/** Which rows are playing, selected and being switched to; cheap enough for every poll. */
function syncSongRows(reveal = false) {
  const queue = !!netease.shownQueue();
  // Each row is a case's song (NetEase's queue or playlist, or a local playlist).
  const selectedKey = records[selected]?.id;
  // 本地音乐: the song the player has loaded (playing, paused or loading), as the shelf marks it
  // (playingRecord); not the last one of a playlist that has played to its end (idle).
  const playing = (queue ? netease.queuePlaying : loadedTrack()?.id) || undefined;
  // Paused, stopped or unknown: the current row stays marked but its level meter holds still. The
  // page reads the same state as the meter's colour (--state, syncRing), so they never disagree.
  const paused = queue
    ? mediaPlayback() !== "playing"
    : !(playerState?.playing || playerState?.transport === "loading");
  // The tab's dot: the listed column holds NetEase's queue (always, while the queue is the one
  // column), or the listed local playlist holds the loaded song.
  const lane = queue ? netease.laneAt() : undefined;
  const loaded = playingRecord();
  const live = queue ? !lane || lane.live : loaded >= 0 && fileLocation(loaded).lane === fileLocation(selected).lane;
  // ▶ on a row (hovered, focused or selected): its song can be played (a song of NetEase's queue, or
  // with its playlist one of another playlist column, since 2026-10-10; a local song with a file the
  // browser plays: the row's own mark), or, on the row that is paused, resumed (selectionPlay's
  // rules). NetEase's rows keep their ▶ while the port may not be used for a reason the user can
  // change: pressed, it says why (playOffer, requestPlay; the owner, 2026-10-09).
  const play = queue || !playerCurrent;
  const resume = loaded >= 0 && playOffer(loaded)?.action === "resume";
  songView.sync({ playing, selected: selectedKey, pending: netease.pendingKey(), paused, live, play, resume });
  if (reveal) songView.reveal(selectedKey ?? playing, !preferences.reduced && !$("#music-song").hidden);
}
/** The shorter way round a looping column from one of its files to another. */
function rowNavigation(from: number, to: number): ArchiveNavigation | undefined {
  const files = columnFiles(fileLocation(to).lane);
  const start = files.indexOf(from), end = files.indexOf(to);
  if (start < 0 || end < 0 || start === end) return undefined;
  let rows = end - start;
  if (Math.abs(rows) > files.length / 2) rows -= Math.sign(rows) * files.length;
  return { axis: "row", direction: rows };
}
/**
 * The header's ring and Space: pause or resume what plays, never another song (the owner,
 * 2026-10-08: "ring = pause/resume only"; browsing still never switches the song, and ▶ / P play the
 * selection, playSelection); the shelf's and the details' ring too while their song is the one that
 * plays (ringPlay). 本地音乐: the song the player has loaded. NetEase: its own play / pause; where it
 * offers none, the port's 播放队列中这首歌 for the song it plays, which can start that song, never
 * pause it (playsCurrent). Any other player: its play / pause. Nothing loaded: nothing to do (the
 * header's ring is disabled).
 */
function togglePlayback() {
  if (playerCurrent) {
    if (externalMedia?.offers("toggle")) {
      if (!externalMedia?.can("toggle")) return;
      void controlExternal("toggle");
    } else {
      const current = playsCurrent();
      if (!current) return;
      void netease.playQueueSong(current);
    }
  } else {
    if (!player || !loadedTrack()) return;
    void player.toggle();
  }
  scene?.playGesture();
  if (records.length) tickMotion.ripple();
}
/**
 * The song NetEase plays, for the rings when NetEase offers no play / pause of its own (whether
 * or not a control is on its way) and is not playing it: the port's action can start it that
 * way, never pause it. Undefined otherwise, or while the port may not be used.
 */
function playsCurrent() {
  if (externalMedia?.offers("toggle") || mediaPlayback() === "playing") return undefined;
  return netease.queueSongToPlay(true, playingRecord());
}
/** 本地音乐: the song the player has loaded (playing, paused or loading), as the header shows it. */
function loadedTrack() {
  const state = playerState;
  return state?.currentTrack && ["playing", "paused", "loading"].includes(state.transport) ? state.currentTrack : undefined;
}
/**
 * What ▶ does for the song of the case at `index` (the lifted case's ▶, a song row's, P; the
 * owner, 2026-10-07/08): "play" it, "resume" it when it is the song that is paused, or nothing
 * (undefined): the song that plays, a song whose request NetEase has not answered yet, a song
 * Rhine may not ask NetEase for now (the port down, private FM: playBlock, where requestPlay says
 * why; a song of another playlist column is asked for with its playlist since 2026-10-10), a local
 * song without a file to play (a demonstration cover, an offline folder)
 * or one the browser cannot play (↗: DSF / DFF, which are only indexed, and any other format it
 * does not decode; asked to, the player would stop the song that plays and say so), and any source
 * with one card.
 */
function selectionPlay(index: number): "play" | "resume" | undefined {
  const key = records[index]?.id;
  if (!key) return undefined;
  if (playerCurrent) {
    if (!netease.shownQueue()) return undefined;
    if (key === netease.queuePlaying) {
      const playback = mediaPlayback();
      if (externalMedia?.offers("toggle")) return playback === "paused" || playback === "stopped" ? "resume" : undefined;
      return playback !== "playing" && netease.queueSongToPlay(true, index) ? "resume" : undefined;
    }
    if (netease.isPending(key)) return undefined;
    return netease.queueSongToPlay(false, index) ? "play" : undefined;
  }
  const song = localSong(index), album = albums.find((item) => item.id === key);
  if (!song || !album?.tracks.length || album.offline || !song.track.browserPlayable) return undefined;
  if (loadedTrack()?.id === song.id) return playerState?.transport === "paused" ? "resume" : undefined;
  return "play";
}
/**
 * ▶ (and P, through requestPlay): play the song of the case at `index`, selecting it first when it
 * is not the selection (along its column, the shorter way round, as a row does), or resume it when
 * it is the song that is paused. 本地音乐: the player plays it and continues through its playlist.
 * NetEase: the consented 播放队列中这首歌, or for a song of another playlist column NetEase's own
 * 播放全部 of that playlist from the song, after which the playlist is its queue (playQueueSong; the
 * owner, 2026-10-10). The selected case hops (with the ruler's ripple) once the selection has arrived; not when
 * `hop` is false (a click that also opens the case: openCase).
 */
function playSelection(index = navigationSelection(), hop = true) {
  const action = selectionPlay(index);
  if (!action) return;
  const cursor = navigationSelection();
  if (index !== cursor) {
    netease.queueFollowPaused = true;
    select(index, rowNavigation(cursor, index));
  }
  if (playerCurrent) {
    if (action === "resume" && externalMedia?.offers("toggle")) {
      if (!externalMedia.can("toggle")) return;
      void controlExternal("toggle");
    } else {
      const wanted = netease.queueSongToPlay(action === "resume", index);
      if (!wanted) return;
      void netease.playQueueSong(wanted);
    }
  } else if (action === "resume") void player?.toggle();
  else {
    const song = localSong(index);
    if (!song) return;
    void player?.play(song.id, playlistQueue(localShelf, song));
  }
  answerPlay(index, hop);
}
// A song asked to play while the selection was still on its way to it: its case hops once it
// has arrived (commitSelection), not the case that leaves.
let gestureFor: number | undefined;
/**
 * The play gesture for the song of the case at `index`: now when it is the lifted case, else on
 * arrival. Without its hop (`hop` false: the case is being opened, which is its motion), the waves.
 */
function answerPlay(index: number, hop = true) {
  if (index === selected && navigationSelection() === selected) {
    gestureFor = undefined;
    if (hop) scene?.playGesture();
    else playWaves();
    if (records.length) tickMotion.ripple();
  } else gestureFor = index;
}
/**
 * The play gesture's waves without the lifted case's hop: over the shelf (seen under the opened case
 * too) and along the song scene's chain; the caller adds the ruler's ring. No hop begins, and a hop
 * still running from an earlier press lands as it would have. Reduced motion has neither, as before.
 */
function playWaves() {
  scene?.playGesture({ hop: false });
}
/**
 * Why ▶ cannot play the song of the case at `index` now, where the reason is one the user can change
 * in the 播放器 panel (the owner, 2026-10-09, whose NetEase ran without its debugging port: "clicking
 * the lifted box doesn't switch to that song or play it"): a song NetEase can be asked for (its
 * queue's, or since 2026-10-10 another playlist's, with that playlist: netease.songRequest), or the
 * song it plays that ▶ would start (NetEase offering no play / pause of its own), while the port does
 * not answer or NetEase is in private FM (netease.portBlock; there is no switch for it since
 * 2026-10-09). Undefined when ▶ can play it (selectionPlay) and wherever it never could: the song that
 * plays, one NetEase was asked for already, a source with one card, and every local song ▶ does not
 * play (a demonstration cover, an offline folder, ↗).
 */
function playBlock(index: number): PortBlock | undefined {
  if (!playerCurrent) return undefined;
  const key = records[index]?.id, request = netease.songRequest(index);
  if (!key || !request || netease.isPending(key)) return undefined;
  if (!request.playlist && key === netease.queuePlaying && (externalMedia?.offers("toggle") || mediaPlayback() === "playing")) return undefined;
  return netease.portBlock();
}
/**
 * What ▶ offers for the case at `index`: to play its song, or to resume it when it is the one that
 * is paused (selectionPlay), or to say why it cannot now (`block`: playBlock). Undefined: no ▶.
 */
function playOffer(index: number): { action: "play" | "resume"; block?: PortBlock } | undefined {
  const action = selectionPlay(index);
  if (action) return { action };
  const block = playBlock(index);
  return block ? { action: records[index]?.id === netease.queuePlaying ? "resume" : "play", block } : undefined;
}
/**
 * Every way of playing a chosen song: ▶ on the lifted case or a row, P, a click on the lifted case
 * (openCase, `hop` false), a double-click on a row, and the shelf's and the details' ring for a song
 * other than the one that plays (ringPlay). It plays as ▶ does (playSelection); where a reason the
 * user can change stands in the way it says which, with the way to the 播放器 panel, and sends nothing
 * (explainNoPlay). Whether it played.
 */
function requestPlay(index: number, hop = true) {
  if (selectionPlay(index)) {
    playSelection(index, hop);
    return true;
  }
  explainNoPlay(index);
  return false;
}
/**
 * The error notice for a song that was asked to play and cannot be (requestPlay): NetEase's port
 * reason (playBlock) with a button to the 播放器 panel, where the port's status and the restart are
 * (Rhine never restarts NetEase by itself). Nothing for the rest (the song that plays, one asked for
 * already, a local song ▶ does not play): their rings and rows say why in their titles. (A playlist
 * column that was only for browsing said so once a page until 2026-10-10, when its songs became
 * playable with their playlist.)
 */
function explainNoPlay(index: number) {
  const block = playBlock(index);
  if (block) notify(PORT_BLOCK_NOTICE[block], { label: "打开播放器", panel: "sources" });
}
/**
 * Why there is nothing to play for the case at `index` (no ▶: playOffer is undefined), for the
 * title of a ring that is then disabled (the reason only there, the owner, 2026-10-07).
 */
function noPlayReason(index: number) {
  if (playerCurrent) return "不能播放这首歌";
  const song = localSong(index), album = albums.find((item) => item.id === records[index]?.id);
  if (!song || !album?.tracks.length) return "演示封面没有音频";
  if (album.offline) return "目录离线";
  if (!song.track.browserPlayable) return `${song.track.format} 需要兼容的播放内核`;
  return "不能播放这首歌";
}
/**
 * Whether a ring for the song of the case at `index` pauses or resumes it: it is the song that plays
 * or is paused (the one the player has loaded, or NetEase plays), or the live track of a source with
 * one card. Otherwise the ring plays that song (ringPlay).
 */
function ringPauses(index: number) {
  if (playerCurrent && !netease.shownQueue()) return true;
  return index >= 0 && index === playingRecord();
}
/**
 * The shelf's 42 px ring (the selection's) and the details' ring (the song they show) are their song's
 * own play button (the owner, 2026-10-09: "when I click the play button, it should only play the
 * selected song, not the previously playing one"): on the song that plays or is paused they pause or
 * resume it (togglePlayback); on any other song, or while nothing is loaded, they play it as ▶ does
 * (requestPlay, with the hop). The header's ring stays pause / resume of what plays.
 */
function ringPlay(index: number) {
  // A double press on a ring that has just played its song (2026-10-09 review: the second press
  // found the ring turned into that song's pause button and paused it): the gesture's end, nothing.
  const now = performance.now();
  if (index === ringPlayed.index && now - ringPlayed.at < DOUBLE_PRESS.ms) return;
  if (ringPauses(index)) togglePlayback();
  else {
    requestPlay(index);
    ringPlayed = { at: now, index };
  }
}
let ringPlayed = { at: -Infinity, index: -1 };
/**
 * A click on a row of the song scene's list: on its ▶ (`onPlay`) or the rest of it. One click
 * selects the row's case (the chain runs to it the shorter way round); one on ▶ plays the row's song
 * instead (selectionPlay, playSelection), where a tap or a pen's press found ▶ shown before it
 * (songView.playAllowed). A double-click or a double tap (the owner, 2026-10-08: "double-click a
 * song in the list to switch to it") plays the song of the row it began on by the same rules: its
 * first click selected the row, so the second only plays (the case hops once it has arrived), and
 * nothing when the first click played it already or the song cannot be played (a song without a file
 * or one the browser cannot play, ↗): the double click only selected it. Where the port may not be used
 * for a reason the user can change (the port down, private FM), the double click or ▶ says so instead
 * (requestPlay; the owner, 2026-10-09),
 * once a burst, and ▶ selects the row as the rest of it does. A further click of the burst does
 * nothing.
 */
function clickSongRow(clicked: HTMLButtonElement, onPlay: boolean, event: MouseEvent) {
  const click = songView.rowClick(clicked, event);
  const row = click.row, index = Number(row.dataset.select);
  if (row.disabled || row.dataset.select === undefined || !Number.isInteger(index)) return;
  if (click.kind !== "single") {
    if (click.kind === "double" && !click.played) {
      songView.rowPlayed();
      requestPlay(index);
    }
    return;
  }
  if (onPlay && songView.playAllowed(row) && playOffer(index)) {
    songView.rowPlayed();
    if (requestPlay(index)) return;
  }
  netease.queueFollowPaused = true;
  select(index, rowNavigation(navigationSelection(), index));
}
/**
 * Back to the song that plays or is paused (L, and its number beside the ring and on the song
 * scene's pane; the owner, 2026-10-07): the selection moves there as following does, along its
 * column the shorter way round, or into its column by the shorter way round the shelf, as stepping
 * into NetEase's queue lands on it. Navigation only: nothing plays, no gesture; following resumes.
 */
function goToPlaying() {
  const target = backTarget(), cursor = navigationSelection();
  if (target < 0) return;
  netease.queueFollowPaused = false;
  wheelNavigation.reset();
  const from = fileLocation(cursor).lane, to = fileLocation(target).lane;
  if (from === to) {
    select(target, rowNavigation(cursor, target));
    return;
  }
  const columns = archiveColumns.length, forward = wrap(to - from, columns);
  select(target, { axis: "lane", direction: forward <= columns / 2 ? forward : forward - columns });
}
/**
 * Where L (goToPlaying) goes: the case of the song that plays or is paused, while the selection
 * (or where it is moving) is another case; -1 when there is none, or the source has one card.
 */
function backTarget() {
  if (playerCurrent && !netease.shownQueue()) return -1;
  const target = playingRecord(), cursor = navigationSelection();
  return target >= 0 && target !== cursor && records[cursor] ? target : -1;
}
/** Whether the header's ring and Space have something to pause or resume now (else that ring is disabled). */
function pauseResumeOffered() {
  if (playerCurrent) return !!externalMedia && (externalMedia.offers("toggle") || !!playsCurrent());
  return !!player && !!loadedTrack();
}
/** A player's own play / pause, for the details of a source with one card (its live track). */
function toggleExternal() {
  if (!externalMedia?.can("toggle")) return;
  void controlExternal("toggle");
  scene?.playGesture();
  if (records.length) tickMotion.ripple();
}
/** NetEase's playback as its own player reports it when the port answers, else as Windows does. */
function mediaPlayback(source = externalMedia?.selected) {
  return netease.playback(source);
}
/**
 * The play rings say what they do (their words in their name and title): the header's pauses or
 * resumes what plays, never the selection, disabled while there is nothing to pause or resume (the
 * reason in its title); the shelf's and the details' are their song's (ringPlay). Then ▶ and the key
 * hints.
 */
function syncPlayButton() {
  syncRing();
  syncPlayNote();
  syncSelectionPlay();
  applyRing(document.querySelector<HTMLButtonElement>("#play-pause"), pauseResumeRing());
  applyRing(document.querySelector<HTMLButtonElement>("#shelf-play"), songRing(navigationSelection()));
  // The details' ring of a song (NetEase's queue, a local song); a lone live track's is its player's own (updateExternalControls).
  applyRing(document.querySelector<HTMLButtonElement>('#detail-toggle[data-action="detail-play"]'), songRing(selected));
  syncDetailTimeline();
  syncLyrics();
}
/**
 * The details' timeline belongs to the song that plays (the owner, 2026-10-09: "in the detail of a song
 * isnt playing, dont show the timeline, when it starts to play, make an animation for the timeline to
 * emerge"): on the details of any other song it is not there (folded away, out of reach of the keys),
 * and when the song they show starts to play, or is the one paused, it emerges: it opens downwards as
 * its line draws in from the left. When another song plays it folds away again. The song that plays is
 * the one a ring pauses (ringPauses): the song the player has loaded or NetEase plays, or a lone live
 * track. A document just written takes its state at once (timelineState, detailTimeline); reduced motion
 * has no movement.
 */
function syncDetailTimeline() {
  const wrap = document.querySelector<HTMLElement>("#detail-body .detail-timeline-wrap");
  if (!wrap) return;
  const state = timelineState();
  if (wrap.dataset.timeline === state) return;
  wrap.dataset.motion = preferences.reduced ? "off" : "on";
  wrap.dataset.timeline = state;
  wrap.inert = state === "hidden";
}
function timelineState() {
  return ringPauses(selected) ? "shown" : "hidden";
}
/**
 * The details' lyrics (the owner, 2026-10-17: "Redesign scene 2. It shouldn't show 曲目数 anymore, and
 * see if you can add dynamic lyrics there instead"), in the box under the transport and the timeline
 * (lyrics-view.ts). Like the timeline they belong to the song that plays or is paused: on another
 * song's details the box is folded away, and it opens when that song starts. NetEase's are the lyrics
 * it has loaded for the song it plays, read through its debugging port (asked to load them first, as
 * its playing page does: netease.lyrics); a local song's are its .lrc beside it, else its tags
 * (localLyrics); a lone live track has none. They are asked for, and follow the song, only while the
 * details show.
 */
function syncLyrics() {
  lyricsView.attach(document.querySelector<HTMLElement>("#detail-body .detail-lyrics"));
  const source = timelineState() === "shown" ? lyricsSource() : undefined;
  if (!source) return lyricsView.hide();
  const open = mode === "detail" && menu === "detail";
  if (open) source.want();
  lyricsView.show(source.key, source.lyrics, source.clock, open);
}
// The song NetEase's port last named, with the case that played then: a reading that misses its time
// now and then (NetEase busy loading a playlist) keeps that song's lyrics while the same case plays, up
// to LYRICS_PORT_GRACE_MS, instead of taking them away and writing them again a second later.
let neteaseLyricsSong: { id: string; record: number; at: number } | undefined;
const LYRICS_PORT_GRACE_MS = 5000;
function lyricsSource(): { key: string; lyrics: Lyrics | null | undefined; clock: LyricsClock; want(): void } | undefined {
  if (playerCurrent) {
    if (!netease.shownQueue()) return undefined;
    // NetEase's lyrics are read through its debugging port, for the song it reports.
    const now = performance.now(), record = playingRecord();
    const id = netease.debugState.available ? netease.debugState.trackId : undefined;
    if (id) neteaseLyricsSong = { id, record, at: now };
    const kept = neteaseLyricsSong;
    if (!id && kept && kept.record === record && now - kept.at < LYRICS_PORT_GRACE_MS)
      return { key: `netease:${kept.id}`, lyrics: netease.lyrics.get(kept.id), clock: neteaseLyricsClock, want() {} };
    if (!id) return { key: "netease", lyrics: null, clock: neteaseLyricsClock, want() {} };
    return { key: `netease:${id}`, lyrics: netease.lyrics.get(id), clock: neteaseLyricsClock, want: () => netease.lyrics.want(id) };
  }
  const track = loadedTrack();
  if (!track) return undefined;
  return { key: `local:${track.id}`, lyrics: localLyrics.get(track.id), clock: localLyricsClock, want: () => localLyrics.want(track.id) };
}
interface RingWords { disabled: boolean; pressed: boolean; label: string; title: string }
/** The header's ring: pause or resume what plays (togglePlayback). */
function pauseResumeRing(): RingWords {
  if (playerCurrent) {
    const source = externalMedia?.selected, playback = mediaPlayback(source);
    const label = playback === "playing" ? "暂停" : playback === "unknown" ? "播放 / 暂停（状态未知）" : playback === "paused" ? "继续" : "播放";
    // Not dimmed while a control is on its way (a press in that moment is ignored, as before).
    const disabled = !externalMedia?.offers("toggle") && !playsCurrent();
    return {
      disabled, pressed: playback === "playing", label: disabled ? "暂停 / 继续" : label,
      title: !source ? "请先连接播放器"
        : disabled ? `${source.name}没有提供${playback === "playing" ? "暂停" : "播放 / 暂停"}`
        : `${source.name}：${label}`,
    };
  }
  const loaded = loadedTrack(), transport = playerState?.transport;
  const playing = !!loaded && (transport === "playing" || transport === "loading");
  const label = playing ? "暂停" : "继续";
  return { disabled: !loaded, pressed: playing, label: loaded ? label : "暂停 / 继续", title: loaded ? `${label}：${loaded.title}` : "没有正在播放的歌" };
}
/**
 * The shelf's or the details' ring for the song of the case at `index` (ringPlay): the header's
 * words on the song that plays or is paused; otherwise ▶ and 播放：<its title> (also where pressing it
 * only says why it cannot play now: playOffer's block), or, with nothing to play, disabled with the
 * reason in its title. Not dimmed while NetEase has not answered a request for it (a press then does
 * nothing, as the header's ring while a control is on its way).
 */
function songRing(index: number): RingWords {
  if (ringPauses(index)) return pauseResumeRing();
  const title = records[index]?.title ?? "";
  if (playOffer(index)) return { disabled: false, pressed: false, label: `播放：${title}`, title: `播放：${title}` };
  if (playerCurrent && title && netease.isPending(records[index]?.id))
    return { disabled: false, pressed: false, label: `正在切换：${title}`, title: "正在切换…" };
  return { disabled: true, pressed: false, label: "播放", title: noPlayReason(index) };
}
function applyRing(button: HTMLButtonElement | null, words: RingWords) {
  if (!button) return;
  if (button.disabled !== words.disabled) button.disabled = words.disabled;
  const pressed = String(words.pressed);
  if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
  if (button.getAttribute("aria-label") !== words.label) button.setAttribute("aria-label", words.label);
  if (button.title !== words.title) button.title = words.title;
}
/**
 * ▶'s keys as the selection and the player now allow (playOffer: what selectionPlay plays, and
 * NetEase's songs while the port may not be used for a reason the user can change, where P says
 * why): the key hints. (The song rows' ▶ follows the song scene's data-play and each row's
 * data-playable: song-scene.css. The lifted case's own ▶ is gone since 2026-10-10.)
 */
function syncSelectionPlay() {
  syncKeyHint();
}
/**
 * The keyboard layout's characters (navigator.keyboard), read at the start and whenever the window
 * comes back to the front (the layout may have changed); until then keys are named by their codes.
 */
let keyLayout: KeyLayout | undefined;
function readKeyLayout() {
  void keyboardLayout().then((layout) => {
    if (!layout || sameLayout(layout, keyLayout)) return;
    keyLayout = layout;
    applyKeyLabels();
  });
}
/** Whether two layouts print the same on every key (a new map comes back at every focus). */
function sameLayout(a: KeyLayout, b?: KeyLayout) {
  if (!b || a.size !== b.size) return false;
  for (const [code, text] of a) if (b.get(code) !== text) return false;
  return true;
}
/**
 * An action's name and note as this page says them: with 本地音乐 as the source, S is 选歌, as its
 * hint and its links are; with a player, 播放列表.
 */
function actionWords(id: ShortcutAction): { name: string; note?: string } {
  const info = shortcutInfo(id);
  if (id === "songs" && !playerCurrent) return { name: "选歌", note: "在专辑架和详情里打开选歌；在选歌里打开这首歌" };
  return { name: info.name, note: info.note };
}
/** What an action's key is shown as now: its main key, else its 附加键; "" while it has neither. */
function keyName(id: ShortcutAction) {
  const key = actionKeys(preferences.shortcuts, id)[0];
  return key ? keyLabel(key, keyLayout) : "";
}
/**
 * Writes the keys' names where the page shows them: the shelf's hints (move, enter, play, songs,
 * playing, space), the details' and the song scene's ways back (Esc) and to the playlist (S), the
 * menu form's 搜索 (/), the canvas's label (sceneLabel) and NetEase's play key (netease.playKey). A
 * key the user cleared is not shown. The markup keeps the default names (keyHintMarkup, songSceneMarkup).
 */
function applyKeyLabels() {
  const write = (selector: string, text: string) => document.querySelectorAll<HTMLElement>(selector).forEach((node) => {
    setText(node, text);
    if (node.hidden !== !text) node.hidden = !text;
  });
  write('#music-keyhint [data-hint="move"] > kbd', [keyName("songUp"), keyName("songDown")].filter(Boolean).join(" "));
  write('#music-keyhint [data-hint="enter"] > kbd', keyName("open"));
  write('#music-keyhint [data-hint="play"] > kbd', keyName("play"));
  write('#music-keyhint [data-hint="songs"] > kbd', keyName("songs"));
  write('#music-keyhint [data-hint="back"] > kbd, #go-current > kbd', keyName("playing"));
  write('#music-keyhint [data-hint="space"] > kbd', keyName("pause"));
  write('.music-back[data-action="back"] > kbd', keyName("back"));
  write(".detail-songs > kbd, .song-details > kbd", keyName("songs"));
  write('[data-action="search"] > .topnav-menu-value', keyName("search"));
  document.querySelector("#three-scene canvas")?.setAttribute("aria-label", sceneLabel());
  // NetEase's port status and consent name the key of 播放选中的歌.
  netease.playKey = keyName("play");
  queueSettingVisual = "";
  debugSettingVisual = "";
  keyHintKey = "";
  syncKeyHint();
  if (panel === "settings" && settingsTab === "keys" && !shortcutCapture) renderShortcutRows();
}
/** The scene's description for screen readers: its keys for the lists and the songs (the arrows by default). */
function sceneLabel() {
  if (playerCurrent) return "三维卡片，显示所选外部播放器的当前曲目";
  const ids: ShortcutAction[] = ["listLeft", "listRight", "songUp", "songDown"];
  if (!ids.some((id) => changed(preferences.shortcuts, id))) return "三维歌曲阵列，左右切歌单，上下切歌";
  const say = (id: ShortcutAction) => {
    const key = actionKeys(preferences.shortcuts, id)[0];
    return key ? spokenKey(key, keyLayout) : "";
  };
  const lists = [say("listLeft"), say("listRight")].filter(Boolean).join("、");
  const songs = [say("songUp"), say("songDown")].filter(Boolean).join("、");
  return ["三维歌曲阵列", lists && `${lists}切歌单`, songs && `${songs}切歌`].filter(Boolean).join("，");
}
/** The keydown's action, if any (shortcuts.ts). */
function shortcutAt(e: KeyboardEvent) {
  return shortcutEvent(e) ? shortcutKeys.get(eventCode(e)) : undefined;
}
/** Runs an action as its keys do (whichever key the user gave it, main or 附加键). */
function runShortcut(action: ShortcutAction, e: KeyboardEvent) {
  switch (action) {
    case "pause":
      togglePlayback();
      return;
    case "play": {
      // As ▶: on a focused song row, that row's song (where its ▶ is); otherwise the selection.
      const row = menu === "song" ? (e.target as HTMLElement).closest<HTMLButtonElement>("#song-list .song-row") : null;
      const index = row && !row.disabled && row.dataset.select !== undefined ? Number(row.dataset.select) : NaN;
      requestPlay(Number.isInteger(index) ? index : navigationSelection());
      return;
    }
    case "playing":
      goToPlaying();
      return;
    case "songs":
      toggleSongs();
      return;
    case "search":
      searchGenre = "";
      openPanel("search");
      return;
    case "open":
      openCase();
      return;
    case "back":
      leaveMenu();
      return;
    case "songUp":
    case "songDown":
      // Inside the playlist they move along its rows, as the arrows do.
      if (menu === "song" && songView.handleKey(e, action === "songUp" ? "ArrowUp" : "ArrowDown")) return;
      stepAlbum(action === "songUp" ? -1 : 1);
      return;
    case "listLeft":
      stepGenre(-1);
      return;
    case "listRight":
      stepGenre(1);
      return;
  }
}
/** A notice for when the page is in front of the user (not under the loading cover or the opening). */
let startupNotice: (() => void) | undefined;
function showStartupNotice() {
  const show = startupNotice;
  startupNotice = undefined;
  show?.();
}
/** Saves the keys the user gave and shows them everywhere. */
function setShortcuts(next: ShortcutOverrides) {
  preferences.shortcuts = next;
  shortcutKeys = shortcutTable(next);
  savePrefs();
  applyKeyLabels();
}
/**
 * The bottom key hints, as the selection (or where it is moving) and the player now allow: S says
 * what its link says (播放列表, or 歌单歌曲 in a NetEase playlist column that is not its queue); P while
 * the lifted case has ▶ (playOffer: not a demonstration cover, an offline folder, a song the browser
 * cannot play (↗), the song that plays; while NetEase may not be asked
 * for a reason the user can change, P says why, as ▶ does);
 * L only while it is another song than the one that plays or is paused (backTarget); SPACE only
 * while something can be paused or resumed (pauseResumeOffered). A lone live track (no queue) has
 * only the details and pause / resume. The hints are shown and hidden, never written again.
 */
let keyHintKey = "";
function syncKeyHint() {
  const queue = !!netease.shownQueue(), lane = queue ? netease.laneAt() : undefined;
  const browsing = !!lane && !lane.live;
  const songs = playerCurrent ? (browsing ? "歌单歌曲" : "播放列表") : "选歌";
  const shelf = !playerCurrent || queue;
  const shown: Record<string, boolean> = {
    move: shelf, songs: shelf,
    play: shelf && !!playOffer(navigationSelection()),
    back: backTarget() >= 0,
    space: pauseResumeOffered(),
  };
  // A key cleared in 设置 → 快捷键 has no hint.
  shown.enter = !!keyName("open");
  if (!keyName("songUp") && !keyName("songDown")) shown.move = false;
  if (!keyName("songs")) shown.songs = false;
  if (!keyName("play")) shown.play = false;
  if (!keyName("playing")) shown.back = false;
  if (!keyName("pause")) shown.space = false;
  const key = JSON.stringify([songs, shown]);
  if (key === keyHintKey) return;
  keyHintKey = key;
  const hints = $("#music-keyhint");
  setText(hints.querySelector<HTMLElement>('[data-hint="songs"] > span')!, songs);
  for (const [name, on] of Object.entries(shown)) {
    const hint = hints.querySelector<HTMLElement>(`[data-hint="${name}"]`)!;
    if (hint.hidden === on) hint.hidden = !on;
  }
}
/**
 * Beside the shelf's play ring: the number of the song that plays or is paused, while the
 * selection is another song (any column), as a button back to it (goToPlaying; a dot in the
 * playback colour); "正在切换…" (a status, not a button) while NetEase has not yet reported the
 * song asked for; nothing when the selection is what plays, nothing plays, or the source has one
 * card. The song scene's pane has the same button beside its count, and every scene 回到当前
 * beside the wordmark.
 */
function syncPlayNote() {
  const cursor = navigationSelection(), key = records[cursor]?.id;
  let status = "", number = "", playing = -1;
  if (key && (!playerCurrent || netease.shownQueue())) {
    if (playerCurrent && netease.isPending(key)) status = "正在切换…";
    else {
      playing = playingRecord();
      if (playing >= 0 && playing !== cursor)
        number = String(columnFiles(fileLocation(playing).lane).indexOf(playing) + 1).padStart(3, "0");
    }
  }
  setText($("#shelf-play-status"), status);
  const label = number ? `回到正在播放的歌：${records[playing].title}` : "";
  for (const button of document.querySelectorAll<HTMLButtonElement>("#shelf-play-note, #song-go-playing")) {
    // Pressed from the keyboard, it leaves the focus on the selection as it hides.
    if (!number && !button.hidden && document.activeElement === button)
      button.id === "song-go-playing" ? songView.focusCurrent() : $("[data-action=open]").focus({ preventScroll: true });
    if (button.hidden === !!number) button.hidden = !number;
    setText(button.lastElementChild as HTMLElement, number);
    if (button.title !== label) {
      button.title = label;
      button.setAttribute("aria-label", number ? `${label}（${number}）` : "回到正在播放的歌");
    }
  }
  // 回到当前 beside the wordmark (the owner, 2026-10-17: "add 回到当前 button to top left", "add this
  // button to every scene, but show it only when a different song is selected"). It keeps its room
  // while hidden (invisible, out of reach). Pressed from the keyboard, it leaves the focus on the
  // scene's selection as it hides: 查看这首歌, the details' document, the song scene's row.
  const current = $("#go-current"), shown = String(!!number);
  if (!number && current.dataset.shown === "true" && document.activeElement === current)
    mode === "archive" ? $("[data-action=open]").focus({ preventScroll: true })
      : menu === "song" ? songView.focusCurrent()
      : $("#album-detail-content").focus({ preventScroll: true });
  if (current.dataset.shown !== shown) current.dataset.shown = shown;
  if (current.title !== label) {
    current.title = label;
    current.setAttribute("aria-label", number ? `回到当前：${records[playing].title}（${number}）` : "回到当前");
  }
}
/** The case of the song that is loaded in the player (NetEase's, or the local player's), -1 if none. */
function playingRecord() {
  if (playerCurrent) return netease.queuePlaying ? records.findIndex((record) => record.id === netease.queuePlaying) : -1;
  const loaded = loadedTrack()?.id;
  return loaded ? records.findIndex((record) => record.id === loaded) : -1;
}
/** The ruler's dot over the playing song's tick, and the playlist list's dot on its column. */
function syncPlayingMarks() {
  const index = playingRecord();
  tickMotion.setPlaying(index >= 0 ? index : undefined);
  if (index !== drumPlaying) {
    drumPlaying = index;
    renderDrum();
  }
}
/**
 * The play rings and the playback colour (--state, on the stage). The header's ring: plain when
 * nothing is loaded; otherwise the playing song's progress from 12 o'clock, all in the line colour
 * while its position is unknown (it pauses or resumes that song, whatever is selected). The shelf's
 * and the details' ring show the same while their song is that one (ringPauses), else a plain ring
 * with no progress (they play their song: ringPlay; the owner, 2026-10-09). --state is the playing or
 * the paused colour only when the player says so, else muted (never an invented state).
 */
function syncRing() {
  let ring: "plain" | "progress" | "unknown" = "plain", progress = 0;
  let playback: "playing" | "paused" | "unknown" = "unknown";
  // A lone live track's details ring: its player's own play / pause, as it always was.
  let own: "plain" | "progress" | "unknown" = "unknown";
  if (playerCurrent) {
    const source = externalMedia?.selected, state = mediaPlayback(source);
    playback = state === "playing" ? "playing" : state === "paused" || state === "stopped" ? "paused" : "unknown";
    if (source) {
      const { position, duration } = externalTimeline();
      const known = typeof position === "number" && typeof duration === "number" && duration > 0;
      own = known ? "progress" : "unknown";
      if (known) progress = position / duration;
      ring = own;
    }
  } else {
    const state = playerState, track = state?.currentTrack;
    // Loading the next song keeps the colour it had.
    playback = !track ? "unknown" : state!.transport === "playing" ? "playing" : state!.transport === "paused" ? "paused"
      : state!.transport === "loading" && stage.dataset.playback !== "unknown" ? stage.dataset.playback as "playing" | "paused" : "unknown";
    if (track && state!.duration > 0) progress = state!.currentTime / state!.duration;
    if (loadedTrack()) ring = (state?.duration ?? 0) > 0 ? "progress" : "unknown";
  }
  if (stage.dataset.playback !== playback) stage.dataset.playback = playback;
  const value = `${Math.round(Math.max(0, Math.min(1, progress)) * 1000) / 10}%`;
  const paint = (button: HTMLElement | null, shape: typeof ring, fill: string) => {
    if (!button) return;
    if (button.dataset.ring !== shape) button.dataset.ring = shape;
    if (button.style.getPropertyValue("--progress") !== fill) button.style.setProperty("--progress", fill);
  };
  // The header's ring: what plays.
  paint(document.querySelector("#play-pause"), ring, value);
  // The shelf's (the selection's) and the details' (their song's): what plays only while it is theirs.
  const song = (button: HTMLElement | null, index: number) => {
    const theirs = ringPauses(index);
    paint(button, theirs ? ring : "plain", theirs ? value : "0%");
  };
  song(document.querySelector("#shelf-play"), navigationSelection());
  const detail = document.querySelector<HTMLElement>("#detail-toggle");
  if (detail?.dataset.action === "detail-play") song(detail, selected);
  else paint(detail, own, value);
}
/** 本地音乐's previous / next in the header: the local player's own queue, once a song is loaded. */
function syncLocalSkip() {
  const state = playerState, loaded = !!state?.currentTrack;
  // The header's and the details' (the same player's queue).
  for (const previous of document.querySelectorAll<HTMLButtonElement>('[data-action="previous-track"]'))
    previous.disabled = !loaded;
  // The player stops after its last song: "next" is not offered for that.
  for (const next of document.querySelectorAll<HTMLButtonElement>('[data-action="next-track"]'))
    next.disabled = !loaded || state!.currentIndex >= state!.queue.length - 1;
}
/**
 * 本地音乐's song details: the ring (syncPlayButton: ringPlay's words) plays this song, or pauses /
 * resumes it once it is the one loaded, and this song's position while it is loaded (the slider seeks
 * it). While another song or none is loaded the timeline is folded away (syncDetailTimeline), and the
 * header names what is loaded.
 */
let localSeekHeld = false;
function syncLocalTransport() {
  if (playerCurrent) return;
  const state = playerState, track = state?.currentTrack;
  const shown = currentAlbum();
  const other = !!track && track.id !== shown?.id;
  // The timeline is this song's: its position while it is the one loaded, else its length only (and
  // folded away: syncDetailTimeline).
  const mine = !!track && !other;
  const known = mine && state!.duration > 0;
  const length = shown?.tracks[0]?.duration ?? 0;
  for (const node of document.querySelectorAll<HTMLElement>("[data-local-position]")) setText(node, mine ? time(state!.currentTime) : "—");
  for (const node of document.querySelectorAll<HTMLElement>("[data-local-duration]")) setText(node, known ? time(state!.duration) : length > 0 ? time(length) : "—");
  const slider = document.querySelector<HTMLInputElement>("#local-seek");
  if (slider) {
    const max = String(known ? Math.floor(state!.duration) : 1);
    if (slider.max !== max) slider.max = max;
    if (slider.disabled === known) slider.disabled = !known;
    if (!localSeekHeld) {
      const value = String(known ? Math.floor(state!.currentTime) : 0);
      if (slider.value !== value) slider.value = value;
    }
    syncSeekFill(slider, known, !track ? "尚未播放" : other ? "正在播放另一首" : known ? "" : "时长不可用");
  }
  syncLocalSkip();
}
/**
 * The design's timeline: a 1 px line, a 2 px ink fill to the position and a 9 px square head;
 * dashed, with no fill or head, while the position is unknown (`title` says why).
 */
function syncSeekFill(slider: HTMLInputElement, known: boolean, title = "") {
  const max = Number(slider.max) || 0;
  const fill = String(known && max > 0 ? Math.max(0, Math.min(1, Number(slider.value) / max)) : 0);
  if (slider.style.getPropertyValue("--fill") !== fill) slider.style.setProperty("--fill", fill);
  const state = known ? "true" : "false";
  if (slider.dataset.known !== state) slider.dataset.known = state;
  const row = slider.closest<HTMLElement>(".detail-timeline");
  for (const node of [slider, row]) if (node && node.title !== title) node.title = title;
}
// Only an external player has a stop (on its details page); 本地音乐 has play / pause.
function stopPlayback() {
  if (!externalMedia?.can("stop")) return;
  void controlExternal("stop");
  scene?.playGesture();
  if (records.length) tickMotion.ripple();
}
/**
 * A local song's details (2026-10-06: each case is a song of a folder playlist): the design's
 * document with its tag (the playlist's number and the song's place in it, previous / next), the
 * artist and the album on one line, the year, format and length on a quiet line under it, the
 * transport row and the timeline, which play this song, its lyrics while it is the one loaded (the
 * owner, 2026-10-17), and its album's introduction when there is one.
 */
function renderDetail() {
  if (externalMedia) return renderExternalDetail();
  const a = currentAlbum();
  if (!a) return;
  trackFocus.cancel();
  const song = localSong(), track = song?.track;
  const location = fileLocation(selected), files = columnFiles(location.lane);
  const article = $("#album-detail-content"),
    sameSong = detailIdentity === a.id,
    scroll = sameSong ? article.scrollTop : 0;
  detailIdentity = a.id;
  $("#detail-head").innerHTML = detailHead(`PL ${String(location.lane + 1).padStart(2, "0")} · ${pad3(files.indexOf(selected) + 1)}`, `/ ${pad3(files.length)}`,
    { group: "切换歌曲", previous: "上一首", next: "下一首" });
  detailTitle.set(a.title);
  const format = demo ? "封面演示" : songFormat(track);
  const meta = [track?.year ? String(track.year) : "", format === "未提供" ? "" : format, !demo && track?.duration ? time(track.duration) : ""].filter(Boolean);
  $("#detail-body").innerHTML = `${detailArtist(a.artist, track?.album, a.offline ? '<span class="detail-badge">目录离线</span>' : "")}${meta.length ? `<p class="detail-meta">${meta.map((fact) => `<span>${esc(fact)}</span>`).join("")}</p>` : ""}
    <div class="detail-transport" role="group" aria-label="播放控制"><button data-action="previous-track" class="detail-control" aria-label="上一曲" title="上一曲" disabled>${skipGlyph("prev")}</button>${detailDivider}<button data-action="detail-play" id="detail-toggle" class="detail-control detail-toggle" aria-label="播放" aria-pressed="false" data-ring="plain">${detailRing}</button>${detailDivider}<button data-action="next-track" class="detail-control" aria-label="下一曲" title="下一曲" disabled>${skipGlyph("next")}</button></div>${detailTimeline("local-seek", "播放位置", "local")}${lyricsBox}${songAbout(song)}`;
  article.scrollTop = scroll;
  documentDecryption.reset(
    article,
    preferences.reduced || scene?.decryptionFrame.phase === "clear",
  );
  // The ring's shape and words (its song's own play button) and the rest of the transport.
  syncPlayButton();
  syncLocalTransport();
}
/**
 * The song's album introduction, when its album record has one that is about this song's album
 * (introductionFits): the text, its source and licence, and a way to look it up again.
 */
function songAbout(song?: LocalSong) {
  const album = song?.album;
  if (!song || !album?.description || !introductionFits(song)) return "";
  const source = album.descriptionSource;
  return `<section class="album-about"><small>ABOUT THIS ALBUM · ${esc(album.title)}</small><p>${esc(album.description)}</p>${source ? `<a class="text-button" href="${esc(source.url)}" target="_blank" rel="noopener">来源：${esc(source.name)} ↗</a>${source.license ? `<small class="introduction-license">${esc(source.license)}</small>` : ""}` : ""}
    <button data-action="introduction-album" class="text-button" ${introductionsStarting || library.introductions?.running ? "disabled" : ""}>更新专辑介绍 ↗</button><p class="introduction-feedback" data-introduction-feedback="${esc(album.id)}" role="status">${esc(introductionAlbumStatus(album))}</p></section>`;
}
function introductionAlbumStatus(a: MusicAlbum) {
  const lookup = a.introduction;
  if (lookup?.status === "error")
    return `介绍查询失败：${lookup.error || "资料来源暂时无法访问，请稍后重试。"}${a.description ? " 已有介绍仍然保留。" : ""}`;
  if (lookup?.status === "uncertain")
    return `找到可能的同名专辑，尚无法可靠确认，暂未采用介绍。${a.description ? " 已保留原有介绍。" : ""}`;
  if (lookup?.status === "not-found")
    return a.description
      ? "本次未找到可靠更新，已保留原有介绍。"
      : "未找到可核实的专辑介绍，可以稍后重试。";
  if (a.description) return "介绍已保存在本机，可离线阅读。";
  return "尚未查询专辑介绍。";
}
function updateIntroductionStatus() {
  const job = library.introductions;
  const running = introductionsStarting || !!job?.running;
  const button = document.querySelector<HTMLButtonElement>(
    "#introduction-refresh",
  );
  if (button) {
    button.disabled = running || !apiAvailable || !library.albums.length;
    button.textContent = running
      ? "正在查询专辑介绍…"
      : "查询 / 更新专辑介绍 ↗";
  }
  for (const control of document.querySelectorAll<HTMLButtonElement>(
    '[data-action="introduction-album"]',
  ))
    control.disabled = running || !apiAvailable;
  for (const feedback of document.querySelectorAll<HTMLElement>(
    "[data-introduction-feedback]",
  )) {
    // An album record of the library (a song's details name its album's).
    const album = library.albums.find(
      (a) => a.id === feedback.dataset.introductionFeedback,
    );
    if (album)
      feedback.textContent = running
        ? "正在查询专辑介绍，已有资料仍可阅读。"
        : introductionAlbumStatus(album);
  }
  const progress = document.querySelector<HTMLProgressElement>(
    "#introduction-progress",
  );
  if (progress) {
    progress.hidden = !running;
    progress.max = Math.max(1, job?.total || 0);
    progress.value = job?.completed || 0;
    if (introductionsStarting && !job?.running)
      progress.removeAttribute("value");
  }
  const missing = library.albums.filter((album) => !album.description?.trim());
  const coverage = document.querySelector<HTMLElement>(
    "#introduction-coverage",
  );
  if (coverage)
    coverage.textContent = `已有介绍 ${library.albums.length - missing.length} / ${library.albums.length} 张 · 尚缺 ${missing.length} 张`;
  const status = document.querySelector<HTMLElement>("#introduction-status");
  if (status)
    status.textContent = !apiAvailable
      ? "本地音乐服务尚未连接，连接后可查询介绍。"
      : introductionRequestError
        ? `无法开始查询：${introductionRequestError}`
        : !library.albums.length
          ? "扫描本地音乐文件夹后，即可查询专辑介绍。"
          : introductionsStarting
            ? "正在提交专辑介绍查询…"
            : job?.running
              ? `已处理 ${job.completed} / ${job.total} 张 · 更新 ${job.updated} 张${job.currentAlbum ? `\n正在查询：${job.currentAlbum}` : ""}`
              : job?.error
                ? `查询未完成：${job.error}`
                : job && job.total > 0
                  ? `上次查询：处理 ${job.completed} / ${job.total} 张 · 更新 ${job.updated} 张 · 未找到可靠资料 ${job.notFound} 张 · 查询失败 ${job.failed} 张`
                  : "查询会核对专辑、歌手与年份；无法确认的结果不会覆盖已有介绍。";
  const details = document.querySelector<HTMLDetailsElement>(
    "#introduction-missing",
  );
  if (details) {
    details.hidden = !missing.length;
    details.querySelector("summary")!.textContent =
      `查看尚缺介绍的 ${missing.length} 张专辑`;
    details.querySelector("ul")!.innerHTML = missing
      .map(
        (album) =>
          `<li><strong>${esc(album.title)}</strong><span>${esc(album.artist)} · ${esc(introductionAlbumStatus(album))}</span></li>`,
      )
      .join("");
  }
}
/** The song scene's rows (the playing one, paused or not) follow the player. */
function updatePlayingRows() {
  if (menu === "song") syncSongRows();
}
/**
 * The shelf follows the local player from song to song (the next one of the playlist, or the
 * header's previous / next) only while the selection rests on the song that was playing, as it
 * follows NetEase: a user browsing elsewhere is not pulled back. It never plays anything.
 */
function followLocalSong(from?: string, to?: string) {
  if (!from || !to || from === to || !ready || boot?.active || panel || libraryRebuilding) return;
  const cursor = navigationSelection();
  if (records[cursor]?.id !== from) return;
  const index = records.findIndex((record) => record.id === to);
  if (index >= 0) select(index, rowNavigation(cursor, index));
}
let lastPlayerError = "";
player?.subscribe((state) => {
  const previous = playerState?.currentTrack?.id;
  playerState = state;
  // The header's now-playing slot: the song while it plays, is paused or loads.
  syncNowPlaying();
  syncPlayButton();
  // The header's previous / next and the details' transport and timeline.
  syncLocalTransport();
  // The ruler's and the playlist list's marks of the loaded album.
  syncPlayingMarks();
  if (state.error && state.error !== lastPlayerError) notify(state.error);
  lastPlayerError = state.error || "";
  updatePlayingRows();
  followLocalSong(previous, state.currentTrack?.id);
});

let externalVisual: string | undefined;
// The sources panel's NetEase settings as last drawn (rebuilt only when they change).
let queueSettingVisual = "";
let debugSettingVisual = "";
let externalPoll: ReturnType<typeof setTimeout> | undefined;
let externalStopped = false;
let externalRefreshing = false;
let externalUpdating: Promise<void> = Promise.resolve();
let sourcesVisual = "";
let externalSeekPointer: number | undefined;
const externalSeekKeys = new Set<string>();
const seekAdjustmentKeys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
let externalSeekSettling = false;
let externalSeekRelease: ReturnType<typeof setTimeout> | undefined;
function beginExternalSeek() {
  clearTimeout(externalSeekRelease);
  externalSeekSettling = false;
}
function finishExternalSeek() {
  if (externalSeekPointer !== undefined || externalSeekKeys.size) return;
  clearTimeout(externalSeekRelease);
  externalSeekSettling = true;
  // Let the range's change event capture its committed value before polling
  // can restore a position from the preceding native snapshot.
  externalSeekRelease = setTimeout(() => {
    externalSeekSettling = false;
    void netease.sendSeeks();
    updateExternalControls();
  }, 0);
}
if (playerCurrent) {
  document.addEventListener("pointerdown", event => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.id !== "external-seek" || target.disabled) return;
    beginExternalSeek();
    externalSeekPointer = event.pointerId;
  });
  for (const type of ["pointerup", "pointercancel"] as const) window.addEventListener(type, event => {
    if (externalSeekPointer !== event.pointerId) return;
    externalSeekPointer = undefined;
    finishExternalSeek();
  });
  document.addEventListener("keydown", event => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.id !== "external-seek" || target.disabled || !seekAdjustmentKeys.has(event.key)) return;
    beginExternalSeek();
    externalSeekKeys.add(event.key);
  });
  window.addEventListener("keyup", event => {
    if (externalSeekKeys.delete(event.key)) finishExternalSeek();
  });
  const releaseSeek = () => {
    externalSeekPointer = undefined;
    externalSeekKeys.clear();
    finishExternalSeek();
  };
  document.addEventListener("focusout", event => {
    if ((event.target as HTMLElement)?.id === "external-seek") releaseSeek();
  });
  window.addEventListener("blur", releaseSeek);
  // The poll is once a second; the timeline's seconds tick in between. Text only, no frames.
  setInterval(() => { if (!document.hidden && !externalStopped) updateExternalTimeline(); }, 250);
} else {
  // 本地音乐's details timeline: the player's position does not pull it back while it is dragged.
  document.addEventListener("pointerdown", (event) => {
    if ((event.target as HTMLElement)?.id === "local-seek") localSeekHeld = true;
  });
  for (const type of ["pointerup", "pointercancel"] as const) window.addEventListener(type, () => {
    if (!localSeekHeld) return;
    localSeekHeld = false;
    syncLocalTransport();
  });
}

/**
 * Position and length for the timeline. NetEase's media session has neither; while its
 * debugging port answers they come from there, and the timeline can be dragged.
 */
function externalTimeline() {
  const source = externalMedia?.selected;
  return netease.timeline(source)
    ?? { position: source?.position, duration: source?.duration, seekable: !!externalMedia?.can("seek"), debug: false };
}
/** Also runs between polls (see the timer below), so it only writes what changed. */
function updateExternalTimeline() {
  if (!externalMedia) return;
  const timeline = externalTimeline();
  const known = typeof timeline.duration === "number" && timeline.duration > 0;
  document.querySelectorAll<HTMLElement>("[data-media-position]").forEach(node => setText(node, mediaTime(timeline.position)));
  document.querySelectorAll<HTMLElement>("[data-media-duration]").forEach(node => setText(node, mediaTime(timeline.duration)));
  const slider = document.querySelector<HTMLInputElement>("#external-seek");
  if (slider) {
    const disabled = !(timeline.seekable && known), max = String(known ? Math.floor(timeline.duration!) : 1);
    if (slider.disabled !== disabled) slider.disabled = disabled;
    if (slider.max !== max) slider.max = max;
    const value = String(Math.floor(timeline.position || 0));
    if (externalSeekPointer === undefined && !externalSeekKeys.size && !externalSeekSettling && slider.value !== value)
      slider.value = value;
    // The line, its fill and head; dashed, with 时长不可用 in its title, while the length is unknown.
    const placed = known && typeof timeline.position === "number";
    syncSeekFill(slider, placed, !known ? "时长不可用" : placed ? "" : "播放位置不可用");
  }
  // The design keeps the words 播放位置; the times say "—" for what is unknown.
  const label = document.querySelector<HTMLElement>("[data-media-timeline-label]");
  if (label) setText(label, "播放位置");
  // The header's ring and the details' are the same timeline.
  syncRing();
}
/** The timeline shows the target at once; NetEase is asked when the key or pointer is let go. */
function requestSeek(position: number) {
  if (!Number.isFinite(position)) return;
  netease.seekTarget(position);
  updateExternalTimeline();
  lyricsView.sync();
  if (externalSeekPointer === undefined && !externalSeekKeys.size) void netease.sendSeeks();
}
function updateExternalControls() {
  if (!externalMedia) return;
  const source = externalMedia.selected;
  // ... and the header's now-playing slot with it.
  updateStatus();
  syncPlayButton();
  // The details page's controls work the player as it is: a lone live track's play / pause (a ring
  // with a triangle or two bars, the words in its name) says what plays. (A song's ring is its own:
  // syncPlayButton.)
  const playback = mediaPlayback(source);
  const toggleLabel = playback === "playing" ? "暂停" : playback === "unknown" ? "播放 / 暂停（状态未知）" : "播放";
  // NetEase's own previous / next do nothing while it plays a song outside its queue (outsideQueue):
  // not offered then, the reason only in their titles and names (the owner, 2026-10-07).
  const stuck = netease.outsideQueue();
  document.querySelectorAll<HTMLButtonElement>("[data-media-action]").forEach(button => {
    const action = button.dataset.mediaAction as MediaAction, skip = action === "previous" || action === "next";
    button.disabled = !externalMedia.offers(action) || (skip && stuck);
    if (skip) {
      const name = (button.dataset.baseName ??= button.getAttribute("aria-label") ?? ""), title = (button.dataset.baseTitle ??= button.title);
      const reason = stuck ? "：网易云正在播放的歌不在它的播放队列里，网易云不能从这里切换上一首或下一首" : "";
      if (button.getAttribute("aria-label") !== name + reason) button.setAttribute("aria-label", name + reason);
      if (button.title !== title + reason) button.title = title + reason;
    }
    if (action !== "toggle") return;
    if (button.getAttribute("aria-label") !== toggleLabel) button.setAttribute("aria-label", toggleLabel);
    const title = source ? `${source.name}：${toggleLabel}` : toggleLabel;
    if (button.title !== title) button.title = title;
    button.setAttribute("aria-pressed", String(playback === "playing"));
  });
  document.querySelectorAll<HTMLElement>("[data-media-album]").forEach((node) => {
    setText(node, source?.album ?? "");
    if (node.hidden !== !source?.album) node.hidden = !source?.album;
  });
  updateExternalTimeline();
  const warning = [externalMedia.warning, source?.warning, externalMedia.error].filter(Boolean).join("\n");
  document.querySelectorAll<HTMLElement>("[data-media-warning]").forEach(node => { node.textContent = warning; });
  const connection = document.querySelector<HTMLElement>("#external-connection-status");
  if (connection) connection.textContent = mediaConnectionLabel(externalMedia, mediaPlayback());
  // Also while a remembered source is awaited: 断开连接 forgets it (nothing is connected by
  // itself afterwards, also after a restart), without picking another player first.
  const disconnected = document.querySelector<HTMLButtonElement>('[data-action="disconnect-source"]');
  if (disconnected) disconnected.disabled = !externalMedia.selectedId && !externalMedia.remembers;
  if (panel === "sources") {
    const key = JSON.stringify([externalMedia.sources.map(item => [item.id, item.name, item.title, item.artist]), source?.id]);
    if (key !== sourcesVisual) {
      sourcesVisual = key;
      $("#external-sources").innerHTML = mediaSourcesMarkup(externalMedia);
    }
    const permission = $("#external-permission");
    if (permission.dataset.source !== (source?.id || "")) {
      permission.dataset.source = source?.id || "";
      permission.innerHTML = mediaPermissionMarkup(externalMedia);
    }
    const consent = document.querySelector<HTMLInputElement>("#external-global-keys");
    if (consent) consent.checked = externalMedia.allowGlobalMediaKeys;
    const queueSetting = document.querySelector<HTMLElement>("#external-queue");
    const control = netease.queueControl();
    // The control switch is not part of the key: rebuilding under it would drop its focus.
    const restarting = netease.debugRestarting && !isNeteaseSource(source);
    const queueKey = JSON.stringify([source?.id, isNeteaseSource(source), preferences.neteaseQueue, preferences.playlistColumns, restarting, netease.playKey]);
    if (queueSetting && queueKey !== queueSettingVisual) {
      queueSettingVisual = queueKey;
      debugSettingVisual = "";
      // NetEase's source disappears while it restarts; keep saying what is happening.
      // The switch that was just operated is rebuilt with the rest: give it its focus back.
      const focused = queueSetting.contains(document.activeElement) ? (document.activeElement as HTMLElement).id : "";
      queueSetting.innerHTML = restarting
        ? '<p class="external-note" role="status">正在以调试端口重新启动网易云…</p>'
        : queueSettingMarkup(source, preferences.neteaseQueue, netease.queueStatus, control,
            { enabled: preferences.playlistColumns, status: netease.playlistStatus }, netease.playKey);
      if (focused) queueSetting.querySelector<HTMLElement>(`#${CSS.escape(focused)}`)?.focus({ preventScroll: true });
    }
    const queueStatusNode = document.querySelector<HTMLElement>("[data-queue-status]");
    if (queueStatusNode) queueStatusNode.textContent = netease.queueStatus;
    const playlistStatusNode = document.querySelector<HTMLElement>("[data-playlist-status]");
    if (playlistStatusNode) playlistStatusNode.textContent = preferences.playlistColumns ? netease.playlistStatus : "";
    // The port's state changes with NetEase, not with the panel: update it in place so a
    // half-confirmed restart button is not rebuilt under the pointer.
    const debugKey = JSON.stringify([control.status, control.restart]);
    if (debugKey !== debugSettingVisual) {
      debugSettingVisual = debugKey;
      const debugStatusNode = document.querySelector<HTMLElement>("[data-debug-status]");
      if (debugStatusNode) debugStatusNode.textContent = control.status;
      const restart = document.querySelector<HTMLElement>("[data-debug-restart]");
      if (restart) restart.hidden = !control.restart;
    }
  }
  updateQueueRows();
}
function updateQueueRows() {
  // The switch and the port change under an open song scene (its rows' ▶): its rows are not re-rendered for that.
  if (menu === "song") syncSongRows();
}
/** The playlists' names beside their columns, written over the picture (scene.ts placeLaneLabels). */
let laneNames: LaneName[] | null = null;
function syncLaneLabels() {
  // A column is the playlist its first case belongs to.
  laneNames = netease.queueLanesShown.length
    ? archiveColumns.map((_, column) => {
        const lane = netease.laneAt(columnFiles(column)[0]);
        return { name: lane?.name ?? "", live: !!lane?.live };
      })
    : null;
  scene?.setLaneLabels(laneNames);
}
/** The song scene's line meets the large card's edges while the play gesture lifts it. */
let songHopShown = 0;
function syncSongHop() {
  const hop = menu === "song" && scene ? Math.round(scene.songCardHop * 10) / 10 : 0;
  if (hop === songHopShown) return;
  songHopShown = hop;
  $("#music-song").style.setProperty("--songs-hop", `${hop}px`);
}
/** Header text and navigation that differ between the single live card and the queue. */
function syncQueueChrome() {
  const queue = !!netease.shownQueue(), lanes = netease.queueLanesShown.length > 1;
  if (stage.dataset.queue === String(queue) && stage.dataset.lanes === String(lanes)) return;
  stage.dataset.queue = String(queue);
  // Several playlist columns bring back the playlist list (the drum) and the left / right keys.
  stage.dataset.lanes = String(lanes);
  $("#selection-code-label").textContent = queue ? "QUEUE" : "LIVE TRACK";
  $("#selection-counter-label").textContent = queue ? "歌曲" : "专辑";
  $("#selection-code-number").hidden = !queue;
  $("#selection-code-of").hidden = !queue;
  $("#open-album-label").textContent = queue ? "查看这首歌" : "当前曲目与控制";
  $("#music-detail").setAttribute("aria-label", queue ? "歌曲详情" : "当前曲目");
  // A lone live track has its album only; the queue's song count comes with the queue.
  $("#selection-fact-a-key").textContent = "专辑";
  ($("#selection-fact-b").parentElement as HTMLElement).hidden = !queue;
  // A lone live track has no playlist: the song scene is offered only for the queue.
  if (!queue && menu === "song" && presentation.phase === "archive") setMenu("detail");
  for (const [action, words] of [["prev", queue ? "上一首" : "上一个专辑"], ["next", queue ? "下一首" : "下一个专辑"]] as const) {
    const button = $(`.album-stepper [data-action="${action}"]`);
    button.setAttribute("aria-label", words);
    button.title = words;
  }
  // Whether NetEase follows depends on the switch and its port, so the hint only says "select".
  syncKeyHint();
}
function syncExternal(): Promise<void> {
  // Serialize scene changes; a later snapshot wins after an in-flight cover upload.
  externalUpdating = externalUpdating.catch(error => notify(String(error))).then(async () => {
    if (!externalMedia || externalStopped) return;
    updateExternalControls();
    const source = externalMedia.selected;
    // The queue's shelf changes only with the queue; a new song just moves the selection.
    // With the playlists read, the columns are playlists; otherwise the queue is the one column.
    const shelf = netease.shelf(source);
    const nextVisual = shelf ? shelf.key : mediaVisualKey(source);
    if (nextVisual !== externalVisual) {
      netease.queueLanesShown = shelf?.lanes ?? [];
      library = shelf ? shelf.library() : mediaLibrary(source);
      syncQueueChrome();
      await applyLibrary();
      externalVisual = nextVisual;
    }
    netease.followQueue();
    updateExternalControls();
  });
  return externalUpdating;
}
// After a play / pause, a play request or a step to another song: read again every 150 ms
// until NetEase's state changes (at most 1.5 s) instead of a second later. A play request NetEase
// has not answered where it was asked for (netease.awaiting: the song not yet seen there, or a
// playlist's 播放全部 not yet read as its queue, which NetEase saves a moment after the song starts)
// is read every 250 ms after that, until it is or the request lapses (2026-10-17).
const CONFIRM_STEP_MS = 150, CONFIRM_MS = 1500, AWAITING_STEP_MS = 250;
let confirmUntil = 0, confirmFrom = "";
let externalRefreshAgain = false;
let handedSession = sourceSwitch?.session;
function playbackKey() {
  const source = externalMedia?.selected;
  return JSON.stringify([mediaPlayback(source) ?? "", source?.title ?? "", netease.debugState.trackId ?? ""]);
}
function confirmSoon() {
  confirmFrom = playbackKey();
  confirmUntil = performance.now() + CONFIRM_MS;
}
async function refreshExternal() {
  if (!externalMedia || externalStopped) return;
  // One read at a time; one asked for meanwhile runs right after it rather than a second later.
  if (externalRefreshing) {
    externalRefreshAgain = true;
    return;
  }
  externalRefreshing = true;
  externalRefreshAgain = false;
  clearTimeout(externalPoll);
  try {
    await externalMedia.refresh();
    // The session the user picked while 本地音乐 was current, handed over by the switch (once):
    // connected even where what is remembered cannot tell it apart (two sessions of one app, or
    // a player without an app id). A new connection, as every one.
    const picked = handedSession;
    handedSession = undefined;
    if (picked && externalMedia.selected?.id !== picked) externalMedia.select(picked);
    await netease.refresh();
    await syncExternal();
  } catch (error) { notify(String(error)); }
  finally {
    externalRefreshing = false;
    if (confirmUntil && (performance.now() >= confirmUntil || playbackKey() !== confirmFrom)) confirmUntil = 0;
    const delay = externalRefreshAgain ? 0 : confirmUntil ? CONFIRM_STEP_MS : document.hidden ? 2000
      : netease.awaiting() ? AWAITING_STEP_MS : 1000;
    if (!externalStopped) externalPoll = setTimeout(() => void refreshExternal(), delay);
  }
}
async function controlExternal(action: MediaAction, position?: number) {
  if (!externalMedia) return;
  if (action !== "seek") confirmSoon();
  const pending = externalMedia.control(action, position);
  updateExternalControls();
  if (await pending && (action === "previous" || action === "next")) netease.followNextAt = performance.now();
  if (externalMedia.error) notify(externalMedia.error);
  await refreshExternal();
}
function renderSourcesPanel() {
  sourcesVisual = "";
  queueSettingVisual = "";
  chooserVisual = "";
  // A player as the current source: its connection, NetEase's switches and the global media keys.
  // 本地音乐 as the current source: the players to choose from (choosing one switches to it).
  const intro = playerCurrent
    ? "选择要连接的播放器，它就是当前来源。连接过的播放器会被记住：它断开后重新出现会自动接回；以它为当前来源退出后，下次直接启动 Rhine Music 会自动连接它，不用再选。还没有连接过播放器时，网易云音乐是默认连接，发现它即自动连接。选择另一个播放器会替换记住的那个；点“断开连接”则忘掉它，之后不再自动连接任何播放器（网易云也不），直到你再次选择。只记住是哪个播放器，不保存它播放的内容。默认只读取当前曲目、封面与可用控制；网易云的播放队列与切歌在下方另行开关。不会导入曲库，来源消失后也不会自动换到别的播放器。改用本地音乐请点上方的“本地音乐”。"
    : "当前来源是本地音乐。选择一个播放器，它就成为当前来源：Rhine 改为显示它正在播放的歌并提供它允许的控制，本地音乐与 BGM 停止播放；点上方的“本地音乐”可以换回。上次连接的播放器（还没有连接过播放器时是网易云音乐）是默认连接，打开这里时发现它即自动连接。点“断开连接”则忘掉它，之后不再自动连接任何播放器（网易云也不），直到你再次选择。只记住是哪个播放器，不保存它播放的内容；只在这个面板打开时读取各播放器的当前曲目。";
  $("#panel-body").innerHTML = `<p class="panel-intro">${intro}</p><p id="external-connection-status" role="status"></p><div id="external-sources" class="external-source-list"></div>${playerCurrent ? '<div id="external-permission"></div><div id="external-queue"></div>' : ""}<p data-media-warning class="external-warning" role="status"></p><div class="panel-actions"><button data-action="refresh-sources">刷新来源 ↻</button><button data-action="disconnect-source">断开连接</button></div><p class="external-note">无法取得播放状态或时长时显示未知，没有读数时不推算进度。缺少封面时使用中性卡片。播放器是否提供信息取决于它当前的版本与运行状态。</p>`;
  if (externalMedia) return updateExternalControls();
  if (playerChooser) {
    updateChooser();
    void refreshChooser();
    return;
  }
  // A browser: no player can be connected here.
  setText($("#external-connection-status"), "连接外部播放器需要 Windows 客户端。");
  $<HTMLButtonElement>('[data-action="disconnect-source"]').disabled = true;
  $<HTMLButtonElement>('[data-action="refresh-sources"]').disabled = true;
}
/**
 * The details' document (Claude Design, 2026-10-05, direction A; redesigned 2026-10-17 for the
 * lyrics): a tag row (the case's tag and count, previous / next), the title (its own reel,
 * #detail-title), the artist and the album on one line (the facts and their 曲目数 are gone), a
 * transport row (previous | play ring | next | stop, 48 high, divided by 1 px lines) and the
 * 播放位置 timeline; under it, only when there is one, the player's warning; then the lyrics, which
 * take the rest of the column.
 */
const pad3 = (n: number) => String(n).padStart(3, "0");
function detailHead(tag: string, count: string, steps?: { group: string; previous: string; next: string }, after = "") {
  const step = (action: "prev" | "next", label: string) =>
    `<button data-action="${action}" class="detail-step" aria-label="${label}" title="${label}"><i class="chevron chevron-${action === "prev" ? "up" : "down"}" aria-hidden="true"></i></button>`;
  return `<div class="detail-tag-row"><span class="detail-tag-group"><span class="selection-tag detail-tag">${esc(tag)}</span>${count ? `<span class="detail-tag-of">${count}</span>` : ""}${after}</span>${steps ? `<span class="detail-steps" role="group" aria-label="${steps.group}">${step("prev", steps.previous)}${step("next", steps.next)}</span>` : ""}</div>`;
}
/** The artist, then the album in the muted colour after a dot (none when there is no album). */
const detailArtist = (artist: string, album: string | undefined, after = "", albumData = "") =>
  `<p class="detail-artist"><span class="detail-artist-name">${esc(artist)}</span><span class="detail-album"${albumData}${album ? "" : " hidden"}>${esc(album ?? "")}</span>${after}</p>`;
// The lyrics' box (syncLyrics, lyrics-view.ts): written folded away; syncLyrics sets it at once.
const lyricsBox = '<section class="detail-lyrics" data-lyrics="off" data-motion="off" aria-label="歌词" tabindex="-1"><div class="lyrics-list"></div></section>';
const detailDivider = '<i class="detail-divider" aria-hidden="true"></i>';
const detailRing = '<span class="detail-ring" aria-hidden="true"><span class="transport-glyph transport-play"></span><span class="transport-glyph transport-pause"><i></i><i></i></span></span>';
// The timeline, in a fold that opens and closes with the song that plays (syncDetailTimeline): written
// open or shut as it is, without movement.
function detailTimeline(id: string, name: string, data: "media" | "local") {
  const state = timelineState();
  return `<div class="detail-timeline-wrap" data-timeline="${state}" data-motion="off"${state === "hidden" ? " inert" : ""}><div class="detail-timeline-clip"><label class="detail-timeline" for="${id}"><span class="detail-timeline-head"><span${data === "media" ? " data-media-timeline-label" : ""}>播放位置</span><output for="${id}"><span data-${data}-position>—</span> / <span data-${data}-duration>—</span></output></span><input type="range" id="${id}" class="detail-seek" min="0" max="1" step="1" value="0" disabled aria-label="${name}" data-known="false"></label></div></div>`;
}
// NetEase's (or another player's) own controls: previous, next and stop act on what plays, whatever
// is selected. The ring between them: a lone live track's is its player's own play / pause; a song of
// NetEase's queue or playlists has its own play button (ringPlay: it plays that song, or pauses or
// resumes it once it is the one that plays; the owner, 2026-10-09).
function externalControls(song: boolean) {
  const ring = song
    ? `<button data-action="detail-play" id="detail-toggle" class="detail-control detail-toggle" aria-label="播放" title="播放" aria-pressed="false" data-ring="plain">${detailRing}</button>`
    : `<button data-media-action="toggle" id="detail-toggle" class="detail-control detail-toggle" aria-label="播放" title="播放" aria-pressed="false" data-ring="unknown">${detailRing}</button>`;
  return `<div class="detail-transport" role="group" aria-label="外部播放器控制"><button data-media-action="previous" class="detail-control" aria-label="上一曲" title="上一曲">${skipGlyph("prev")}</button>${detailDivider}${ring}${detailDivider}<button data-media-action="next" class="detail-control" aria-label="下一曲" title="下一曲">${skipGlyph("next")}</button>${detailDivider}<button data-media-action="stop" class="detail-control detail-stop" aria-label="停止" title="停止"><i aria-hidden="true"></i></button></div>${detailTimeline("external-seek", "外部播放器播放位置", "media")}`;
}
// Under the timeline, only when there is one: the player's warning (no descriptive text, the owner,
// 2026-10-07; what a control cannot do is in its own title).
const detailNote = '<p class="detail-warning" data-media-warning role="status"></p>';
function renderQueueDetail() {
  const a = currentAlbum();
  if (!a) return;
  const song = netease.laneSong();
  const location = fileLocation(selected), files = columnFiles(location.lane);
  const lane = netease.laneAt(), browsing = !!lane && !lane.live;
  detailIdentity = a.id;
  $("#detail-head").innerHTML = detailHead(
    browsing ? `PL ${String(location.lane + 1).padStart(2, "0")} · ${pad3(files.indexOf(selected) + 1)}` : `QUEUE ${pad3(files.indexOf(selected) + 1)}`,
    `/ ${pad3(files.length)}`,
    { group: "切换歌曲", previous: "上一首", next: "下一首" },
  );
  detailTitle.set(a.title);
  // The artist and the song's album on one line; no facts (the owner, 2026-10-17: no 曲目数), the
  // lyrics instead. NetEase's own song is in the header.
  $("#detail-body").innerHTML = `${detailArtist(a.artist, song?.album)}${externalControls(true)}${detailNote}${lyricsBox}`;
  documentDecryption.reset($("#album-detail-content"), preferences.reduced || scene?.decryptionFrame.phase === "clear");
  updateExternalControls();
}
function renderExternalDetail() {
  const source = externalMedia?.selected;
  if (!source) return;
  if (netease.shownQueue()) return renderQueueDetail();
  detailIdentity = "";
  $("#detail-head").innerHTML = detailHead("LIVE TRACK", "", undefined,
    `<button data-action="sources" class="detail-source">${esc(source.name)}<i class="link-chevron" aria-hidden="true"></i></button>`);
  detailTitle.set(source.title || "曲名未提供");
  $("#detail-body").innerHTML = `${detailArtist(source.artist || "歌手未提供", source.album, "", " data-media-album")}${externalControls(false)}${detailNote}`;
  documentDecryption.reset($("#album-detail-content"), preferences.reduced || scene?.decryptionFrame.phase === "clear");
  updateExternalControls();
}
window.addEventListener("beforeunload", () => {
  externalStopped = true;
  clearTimeout(externalPoll);
  clearTimeout(externalSeekRelease);
  player?.dispose();
}, { once: true });

let panelFocus: HTMLElement | null = null;
let panelTransition: SurfaceTransition | undefined,
  panelClosing = false,
  pendingPanelAfter: (() => void) | undefined;
function closePanel(after?: () => void) {
  if (!panel) {
    after?.();
    return;
  }
  shortcutCapture = undefined;
  pendingPanelAfter = after;
  if (panelClosing) return;
  panelClosing = true;
  // The players are read for the 播放器 panel only while it is open (本地音乐 as the current source).
  clearTimeout(chooserPoll);
  panelTransition?.hide(preferences.reduced, () => {
    panel = null;
    panelClosing = false;
    panelTransition?.dispose();
    panelTransition = undefined;
    $("#music-panel-root").innerHTML = "";
    for (const node of [
      $("#music-browse"),
      $("#music-detail"),
      $("#music-song"),
      $(".music-header"),
      $("#three-scene"),
    ])
      node.inert = false;
    $("#music-browse").inert = presentation.phase !== "archive";
    $("#music-detail").inert = presentation.phase !== "detail" || menu !== "detail";
    // The song panel stays in use while its playlist moves to another song.
    $("#music-song").inert = menu !== "song" || $("#music-song").hidden || $("#music-song").dataset.transition === "closing";
    panelFocus?.focus({ preventScroll: true });
    const next = pendingPanelAfter;
    pendingPanelAfter = undefined;
    next?.();
  });
}
/** `instant`: shown at once, without its entrance (the panel a source switch keeps open). */
function openPanel(next: Panel, instant = false) {
  if (!next) return closePanel();
  if (playerCurrent && (next === "library" || next === "search")) next = "sources";
  // The header's menu does not stay open under a panel (its focus returns to 菜单 first).
  setChromeMenu(false);
  cancelSearchTrack();
  panelTransition?.dispose();
  pendingPanelAfter = undefined;
  panelClosing = false;
  if (!panel) panelFocus = document.activeElement as HTMLElement;
  panel = next;
  const titles = {
    library: ["MUSIC LIBRARY", "本地音乐库"],
    search: ["FIND MUSIC", "搜索歌曲"],
    settings: ["SYSTEM SETTINGS", "设置"],
    sources: ["CONNECT YOUR PLAYER", "连接外部播放器"],
  };
  $("#music-panel-root").innerHTML =
    `<div class="music-panel-scrim" data-action="dismiss-panel"><section class="music-panel" role="dialog" aria-modal="true" aria-labelledby="music-panel-title"><div class="panel-heading"><div><small>${titles[next][0]}</small><h2 id="music-panel-title">${titles[next][1]}</h2></div><button data-action="close-panel" aria-label="关闭">×</button></div><div id="panel-body"></div></section></div>`;
  for (const node of [
    $("#music-browse"),
    $("#music-detail"),
    $("#music-song"),
    $(".music-header"),
    $("#three-scene"),
  ])
    node.inert = true;
  const scrim = $(".music-panel-scrim");
  scrim.hidden = true;
  panelTransition = new SurfaceTransition(scrim, $(".music-panel"));
  panelTransition.show(preferences.reduced || instant);
  if (!instant) effects.play("page-open");
  if (next === "library") renderLibraryPanel();
  if (next === "search") renderSearchPanel();
  if (next === "settings") renderSettingsPanel();
  if (next === "sources") renderSourcesPanel();
  (
    document.querySelector<HTMLElement>("#album-search") ||
    document.querySelector<HTMLElement>('#music-panel-root [role="tab"][aria-selected="true"]') ||
    $("#music-panel-root button")
  )?.focus({ preventScroll: true });
}
/**
 * The library panel (the owner, 2026-10-06): one main folder, chosen with the system picker or
 * typed, and its playlists (each subfolder, and the main folder's own songs first) with their
 * song counts. Folders an earlier version saved after the main one are only mentioned.
 */
function renderLibraryPanel() {
  const main = library.roots[0]?.path ?? "", earlier = library.roots.length - 1;
  const lists = library.playlists ?? [];
  const songs = lists.reduce((n, list) => n + list.trackIds.length, 0);
  const playlists = lists.length
    ? `<ol class="library-playlists">${lists.map((list) => `<li><span>${esc(list.name)}${list.main ? "<small>主文件夹</small>" : ""}</span><b>${list.trackIds.length} 首</b></li>`).join("")}</ol>`
    : `<p>${main ? "扫描后在这里列出主文件夹中的歌单。" : "选择主文件夹并扫描后，这里会列出它的歌单。"}</p>`;
  $("#panel-body").innerHTML =
    `<p class="panel-intro">选择一个音乐主文件夹：它的每个子文件夹是一个歌单，子文件夹里更深处的歌也属于这个歌单；直接放在主文件夹里的歌是第一个歌单。每首歌一张卡片，封面优先使用所在文件夹的封面图片，其次使用音乐内嵌的封面。没有音乐的文件夹和隐藏文件夹不显示。音乐文件只读取，不会被修改。</p><label class="field-label" for="music-root">音乐主文件夹<span>一个文件夹</span></label><input id="music-root" type="text" spellcheck="false" value="${esc(main)}" placeholder="Windows: D:\\Music · macOS: /Users/你的用户名/Music"><div class="panel-actions"><button class="primary-button" data-action="scan">保存并扫描 ↗</button><button data-action="rescan">重新扫描</button></div><div id="scan-status" class="scan-status"></div><div class="library-metrics"><div><b>${lists.length}</b><span>歌单</span></div><div><b>${songs}</b><span>歌曲</span></div><div><b>${library.albums.length}</b><span>专辑</span></div></div><section class="panel-section"><h3>歌单</h3>${playlists}${earlier > 0 ? `<p>旧版本保存的另外 ${earlier} 个音乐文件夹仍保留在设置中，但不再扫描或显示。</p>` : ""}</section><section class="panel-section"><h3>在线资料</h3><p>向 MusicBrainz 核对专辑与歌手，补充专辑介绍与制作资料并缓存在本机；音乐文件留在本机。</p><button data-action="enrich-library" class="text-button">补充缺失的在线资料 ↗</button></section><section class="panel-section"><h3>封面显示</h3><p>方形、竖版、横版封面均保持原始比例，完整放入卡片正面。没有封面时显示占位，不使用其他专辑的图片。</p>${!library.albums.length ? '<button data-action="demo" class="text-button">查看演示歌单 ↗</button>' : ""}</section>`;
  if (isDesktop) {
    const picker = document.createElement("button");
    picker.textContent = "选择主文件夹…";
    picker.addEventListener("click", async () => {
      try {
        const initialDirectory = document.querySelector<HTMLInputElement>("#music-root")?.value.trim();
        const [path] = await chooseMusicFolders(initialDirectory || undefined);
        const input = document.querySelector<HTMLInputElement>("#music-root");
        if (!input || !path) return;
        input.value = path;
      } catch (error) { notify((error as Error).message); }
    });
    $("#panel-body .panel-actions").prepend(picker);
  }
  updateScanStatus();
  const configSection = document.createElement("section");
  configSection.className = "panel-section";
  configSection.id = "online-config";
  $("#panel-body").append(configSection);
  void (async () => {
    try {
      const config = await readOnlineConfig();
      if (!configSection.isConnected) return;
      configSection.innerHTML = `<h3>资料库连接</h3><label class="field-label" for="metadata-contact">MusicBrainz 联系邮箱或项目网址</label><input id="metadata-contact" type="text" value="${esc(config.musicBrainzContact || "")}" placeholder="你的联系邮箱或公开项目网址"><p>按 MusicBrainz 要求用于标识本应用的资料请求，不用于注册或订阅。</p><label class="settings-row"><span>扫描后自动补充新专辑资料<small>已有缓存不重复查询；断网仍可浏览与播放</small></span><input type="checkbox" id="online-enabled" ${config.onlineEnabled ? "checked" : ""}></label><button class="text-button" data-action="save-online">保存资料库设置 ↗</button><p>${config.musicBrainzConfigured ? "资料库请求标识已配置。" : "尚未配置；本地曲库和播放已可使用。"}</p>`;
    } catch (error) {
      if (configSection.isConnected)
        configSection.innerHTML = `<p>${esc((error as Error).message)}</p>`;
    }
  })();
}
function updateScanStatus() {
  const el = document.querySelector("#scan-status");
  const main = library.roots[0];
  // QQ Music's encrypted downloads in the main folder: counted by the scan, never read.
  const encrypted = main?.encrypted ? `\n另有 ${main.encrypted} 个 QQ 音乐加密下载文件（.mflac / .mgg / .qmc*）无法读取，已跳过。` : "";
  if (el)
    el.textContent = library.scan.running
      ? "正在扫描，已有曲库可以继续浏览…"
      : library.scan.error ||
        (main?.status === "offline" ? `${main.path} 暂时离线，原索引已保留。` : "") ||
        (library.scan.finishedAt
          ? `上次扫描 ${new Date(library.scan.finishedAt).toLocaleString("zh-CN")}${encrypted}`
          : "尚未扫描音乐主文件夹。");
}
function renderSearchPanel() {
  $("#panel-body").innerHTML =
    `<input class="album-search" id="album-search" type="search" placeholder="歌曲、歌手、专辑、歌单…" aria-label="搜索歌曲"><div class="genre-filters"><button data-filter="" class="active">全部</button>${genres
      .filter((g) => albums.some((a) => a.genreId === g.id))
      .map((g) => `<button data-filter="${esc(g.id)}">${esc(g.name)}</button>`)
      .join("")}</div><div id="album-results"></div>`;
  renderSearchResults();
}
let searchGenre = "";
/** At most this many results are drawn (a large library lists every song while nothing is typed). */
const SEARCH_RESULTS = 300;
function renderSearchResults() {
  const query = ($<HTMLInputElement>("#album-search")?.value || "")
    .trim()
    .toLocaleLowerCase();
  const results: string[] = [];
  let found = 0;
  for (const a of albums) {
    if (searchGenre && a.genreId !== searchGenre) continue;
    // Each case is a song: its title, artist, album tag and playlist. A result is the song's own
    // case, so selecting it opens that song's details (it never plays).
    const album = localShelf.songs.get(a.id)?.track.album ?? "";
    if (query && !`${a.title} ${a.artist} ${album} ${genreName(a.genreId)}`.toLocaleLowerCase().includes(query)) continue;
    if (++found > SEARCH_RESULTS) continue;
    results.push(`<button class="album-result song-result" data-album="${esc(a.id)}" aria-label="定位歌曲 ${esc(a.title)}，${esc(genreName(a.genreId))}"><span class="result-cover">${cover(a)}</span><span class="result-copy"><strong>${esc(a.title)}</strong><small>${esc([a.artist, album, genreName(a.genreId)].filter(Boolean).join(" · "))}</small></span><em>歌曲</em><i>↗</i></button>`);
  }
  if (found > SEARCH_RESULTS) results.push(`<div class="no-results">还有 ${found - SEARCH_RESULTS} 首，请输入更多文字缩小范围。</div>`);
  $("#album-results").innerHTML = results.length
    ? results.join("")
    : '<div class="no-results">没有找到歌曲。</div>';
}
/** The settings panel's tab (通用, 快捷键), kept while the page lives (a source switch reloads it). */
let settingsTab: "general" | "keys" = "general";
/**
 * The settings panel: two tabs (the owner, 2026-10-10: "a settings tab where users can customize
 * the hotkeys"), 通用 (everything the panel had) and 快捷键; only the shown tab is in the page.
 */
function renderSettingsPanel() {
  const tab = (id: typeof settingsTab, number: string, name: string) =>
    `<button role="tab" id="settings-tab-${id}" data-action="settings-tab" data-settings-tab="${id}" aria-selected="${settingsTab === id}" aria-controls="settings-tabpanel" tabindex="${settingsTab === id ? 0 : -1}"><span aria-hidden="true">${number}</span>${name}</button>`;
  $("#panel-body").innerHTML =
    `<div class="music-tabs panel-tabs" role="tablist" aria-label="设置分类">${tab("general", "01", "通用")}${tab("keys", "02", "快捷键")}<i class="music-tab-indicator" aria-hidden="true"></i></div><div id="settings-tabpanel" role="tabpanel" aria-labelledby="settings-tab-${settingsTab}"></div>`;
  renderSettingsTab(true);
}
function renderSettingsTab(first = false) {
  const body = $("#settings-tabpanel");
  body.setAttribute("aria-labelledby", `settings-tab-${settingsTab}`);
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-settings-tab]")) {
    const on = button.dataset.settingsTab === settingsTab;
    button.setAttribute("aria-selected", String(on));
    button.tabIndex = on ? 0 : -1;
  }
  if (settingsTab === "keys") renderShortcutsTab(body);
  else renderGeneralSettings(body);
  // The 2 px ink line under the chosen tab, as the old album tabs had it (180 ms; at once when reduced).
  const selected = document.querySelector<HTMLElement>(`[data-settings-tab="${settingsTab}"]`);
  const line = document.querySelector<HTMLElement>(".panel-tabs .music-tab-indicator");
  if (selected && line) {
    line.style.transition = first || preferences.reduced ? "none" : "";
    line.style.transform = `translateX(${selected.offsetLeft}px) scaleX(${selected.offsetWidth})`;
  }
  if (!first) tabTransition.reveal(body, preferences.reduced);
}
function setSettingsTab(next: typeof settingsTab) {
  if (next === settingsTab) return;
  endShortcutCapture();
  settingsTab = next;
  renderSettingsTab();
  document.querySelector(".music-panel")?.scrollTo({ top: 0 });
  effects.play("ui-tick");
}
/** ← → Home End on the tabs move between them (and show them), as tabs do. */
function settingsTabKey(e: KeyboardEvent) {
  const tab = (e.target as HTMLElement).closest?.<HTMLButtonElement>("[data-settings-tab]");
  if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return false;
  e.preventDefault();
  const tabs = [...document.querySelectorAll<HTMLButtonElement>("[data-settings-tab]")];
  const at = tabs.indexOf(tab);
  const next = tabs[e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (at + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
  setSettingsTab(next.dataset.settingsTab as typeof settingsTab);
  next.focus();
  return true;
}
/** 通用: what the settings panel always had. */
function renderGeneralSettings(body: HTMLElement) {
  body.innerHTML =
    `<section class="panel-section"><h3>外观主题</h3><div class="theme-cards">${(["day", "night"] as Theme[]).map((t) => `<button data-theme="${t}" aria-pressed="${preferences.theme === t}" class="${t}"><i></i><strong>${themeNames[t]}</strong><span>${t === "day" ? "暖白玻璃与日光" : "极简星空与透光白卡"}</span></button>`).join("")}</div></section>
    <section class="panel-section" id="introduction-settings"><h3>专辑介绍</h3><p>从公开百科查询并更新专辑介绍，附上资料来源。介绍保存在本机，不需要配置 MusicBrainz 联系信息；音乐文件不会上传。</p><p id="introduction-coverage"></p><button class="primary-button" id="introduction-refresh" data-action="introductions-library">查询 / 更新专辑介绍 ↗</button><progress id="introduction-progress" aria-label="专辑介绍查询进度" max="1" value="0" hidden></progress><p id="introduction-status" class="scan-status" role="status" aria-live="polite"></p><details id="introduction-missing" hidden><summary></summary><ul></ul></details></section>
    ${qualityMarkup(renderQuality)}
    <section class="panel-section"><h3>动效与显示</h3><label class="settings-row"><span>减少动态效果<small>简化镜头、文字加载和页签过渡</small></span><input type="checkbox" id="reduced-motion" ${preferences.reduced ? "checked" : ""}></label><label class="settings-row"><span>开场动画<small>启动时约 4 秒的专辑架进场，下次启动时生效</small></span><input type="checkbox" id="intro-setting" ${preferences.intro ? "checked" : ""}></label><label class="settings-row"><span>帧率上限<small>三维画面每秒最多画多少帧；上限越低越省电，动作越不顺滑</small></span><select id="frame-cap" aria-label="帧率上限">${FRAME_CAPS.map((cap) => `<option value="${cap}"${preferences.frameCap === cap ? " selected" : ""}>${cap ? `${cap} 帧／秒` : "不限（跟随显示器）"}</option>`).join("")}</select></label><button class="text-button" data-action="fullscreen">切换全屏 ↗</button></section>
    <section class="panel-section"><h3>声音</h3><label class="settings-row"><span>歌曲音量</span><input type="range" id="volume" aria-label="歌曲音量" min="0" max="100" value="${Math.round(preferences.volume * 100)}"></label><label class="settings-row"><span>切歌淡入淡出<small>当前歌曲先淡出，再淡入下一首</small></span><input type="checkbox" id="song-fade-setting" ${preferences.songFade ? "checked" : ""}></label><label class="settings-row"><span>界面音效<small>玻璃卡片与终端操作</small></span><input type="checkbox" id="sound-setting" ${preferences.sound ? "checked" : ""}></label><label class="settings-row"><span>音效音量</span><input type="range" id="sound-volume" aria-label="音效音量" min="0" max="100" value="${Math.round(preferences.soundVolume * 100)}"></label><label class="settings-row"><span>氛围 BGM<small>专辑开始前淡出，播完后淡入</small></span><input type="checkbox" id="bgm-setting" ${preferences.bgm ? "checked" : ""}></label><label class="settings-row"><span>BGM 音量</span><input type="range" id="bgm-volume" aria-label="BGM 音量" min="0" max="100" value="${Math.round(preferences.bgmVolume * 100)}"></label><button class="text-button" data-action="sound-preview">试听界面音效 ↗</button><p>当前版本支持 Windows 和 macOS，使用浏览器播放本地音乐。DSF / DFF 暂不支持播放，其他格式取决于浏览器解码能力。</p></section>
    <section class="panel-section"><h3>开发与资源</h3><p>音乐适配与维护：<a href="https://github.com/RonaldDeng/Rhine-Music-Demo" target="_blank" rel="noopener">RonaldDeng ↗</a><br>原版界面：<a href="https://github.com/LBEILC/RhineLabUI" target="_blank" rel="noopener">LBEILC / RhineLabUI ↗</a></p><p><a href="/licenses/project-mit.txt" target="_blank" rel="noopener">代码 MIT 许可 ↗</a> · <a href="https://github.com/RonaldDeng/Rhine-Music-Demo/blob/v0.2.0/NOTICE.md" target="_blank" rel="noopener">版权与资源说明 ↗</a></p><a href="/?original=1&scene=archive" target="_blank" rel="noopener">打开原版档案界面 ↗</a><p><a href="/fonts/MiSans-license.pdf" target="_blank" rel="noopener">MiSans 字体许可 ↗</a></p></section>`;
  if (playerCurrent) {
    body.querySelector("#introduction-settings")?.remove();
    body.querySelector("#volume")?.closest(".panel-section")?.remove();
    body.insertAdjacentHTML("afterbegin", '<p class="panel-intro">当前来源是外部播放器，这里只调整此窗口的外观。歌曲音量、淡入淡出与曲库管理请在原播放器中设置；连接播放器时，此窗口不播放本地音乐或 BGM。</p>');
  }
  updateQuality();
  updateIntroductionStatus();
}
/**
 * 快捷键 (shortcuts.ts): each action with its main key and its 附加键, every one a button that takes the next key pressed.
 * A key button takes the next key pressed (shortcutCapture); a key another action holds asks for a
 * second press, then the two swap; Backspace clears, Esc cancels. The rows are written again after
 * every change; the status line stays, for screen readers.
 */
function renderShortcutsTab(body: HTMLElement) {
  body.innerHTML = `<p class="panel-intro">点一个按键，再按下新的键即可更改；新键已被其他操作使用时，再按一次可互换。Backspace 清除，Esc 取消。每个操作可以再加一个附加键；Esc 总是关闭面板与菜单。</p><p id="shortcut-status" class="shortcut-status" role="status" aria-live="polite"></p><div id="shortcut-rows"></div><button class="text-button" data-action="shortcuts-reset-all">全部恢复默认</button>`;
  renderShortcutRows();
}
function renderShortcutRows(focusSlot?: string) {
  const rows = document.querySelector<HTMLElement>("#shortcut-rows");
  if (!rows) return;
  // Written again, the rows keep the focused key button or 恢复默认 (the window coming back, a reset).
  const active = document.activeElement instanceof HTMLElement && rows.contains(document.activeElement) ? document.activeElement : undefined;
  focusSlot ??= active?.dataset.shortcutSlot;
  const focusReset = focusSlot ? undefined : active?.dataset.shortcut;
  const groups = ["播放", "浏览", "打开与返回"] as const;
  rows.innerHTML = `<div class="shortcut-head" aria-hidden="true"><span></span><span>按键</span><span>附加键</span><span></span></div>` +
    groups.map((group) => `<section class="panel-section shortcut-group"><h3>${group}</h3>${SHORTCUTS.filter((info) => info.group === group).map(shortcutRow).join("")}</section>`).join("");
  if (focusSlot) rows.querySelector<HTMLElement>(`[data-shortcut-slot="${focusSlot}"]`)?.focus({ preventScroll: true });
  else if (focusReset) (rows.querySelector<HTMLElement>(`[data-shortcut="${focusReset}"]`) ??
    rows.querySelector<HTMLElement>(`[data-shortcut-slot="${focusReset}"], [data-shortcut-slot="${focusReset}.extra"]`))?.focus({ preventScroll: true });
}
function shortcutRow(info: ShortcutInfo) {
  const words = actionWords(info.id);
  const slotCap = (slot: ShortcutSlot) => {
    const key = slotKey(preferences.shortcuts, slot);
    const capturing = shortcutCapture?.slot === slot;
    const shown = capturing ? "按下新的键…" : key ? keyLabel(key, keyLayout) : isExtra(slot) ? "+" : "未设置";
    const spoken = key ? spokenKey(key, keyLayout) : "未设置";
    const what = `${words.name}${isExtra(slot) ? "的附加键" : ""}`;
    return `<button class="shortcut-key${capturing ? " capturing" : ""}${key ? "" : " empty"}" data-action="shortcut-capture" data-shortcut-slot="${slot}" aria-label="${esc(`${what}：${capturing ? "按下新的键" : spoken}`)}"><kbd>${esc(shown)}</kbd></button>`;
  };
  const restore = changed(preferences.shortcuts, info.id)
    ? `<button class="text-button shortcut-reset" data-action="shortcut-reset" data-shortcut="${info.id}" aria-label="${esc(`恢复默认：“${words.name}”改回 ${spokenKey(info.key, keyLayout)}`)}">恢复默认</button>`
    : "<span></span>";
  return `<div class="shortcut-row" data-shortcut-row="${info.id}"><span class="shortcut-name">${words.name}${words.note ? `<small>${words.note}</small>` : ""}</span>${slotCap(info.id)}${slotCap(`${info.id}.extra`)}${restore}</div>`;
}
/** The key button that takes the next key pressed, if any; and the key that set one, until it is released. */
let shortcutCapture: { slot: ShortcutSlot; pending?: string } | undefined;
let shortcutHeld = "";
function shortcutStatus(text: string) {
  const node = document.querySelector<HTMLElement>("#shortcut-status");
  if (node) node.textContent = text;
}
/** “查看这首歌”, or “查看这首歌”的附加键: an action's slot, named in a message. */
function slotWords(slot: ShortcutSlot) {
  return `“${actionWords(slotAction(slot)).name}”${isExtra(slot) ? "的附加键" : ""}`;
}
function startShortcutCapture(slot: ShortcutSlot) {
  shortcutCapture = { slot };
  renderShortcutRows(slot);
  shortcutStatus(`请按新的键来设置${slotWords(slot)}，Backspace 清除，Esc 取消`);
}
/** Ends the capture (a cancel says so, if `cancelled`); the focus stays on its key button. */
function endShortcutCapture(message?: string) {
  if (!shortcutCapture) return;
  const slot = shortcutCapture.slot;
  shortcutCapture = undefined;
  renderShortcutRows(document.activeElement?.closest?.("#shortcut-rows") ? slot : undefined);
  if (message !== undefined) shortcutStatus(message);
}
// The capture takes the keys before the page does (capture phase): Esc cancels it rather than
// closing the panel; Tab still moves the focus (and cancels); Ctrl, Alt and Win combinations stay
// the system's (Alt+F4) and are refused; a key's repeats and its release are not the page's.
function captureShortcutKey(e: KeyboardEvent) {
  if (shortcutHeld && e.code === shortcutHeld) {
    if (e.repeat) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // A fresh press: its release went to another window.
    shortcutHeld = "";
  }
  if (!shortcutCapture) return;
  if (e.key === "Tab") {
    endShortcutCapture("已取消");
    return;
  }
  e.stopPropagation();
  const modifier = ["Shift", "Control", "Alt", "AltGraph", "Meta", "OS", "CapsLock", "NumLock", "ScrollLock", "Fn"].includes(e.key);
  if (e.ctrlKey || e.altKey || e.metaKey) {
    if (!modifier) shortcutStatus("不支持组合键，请只按一个键");
    return;
  }
  e.preventDefault();
  if (e.repeat || modifier) return;
  shortcutHeld = e.code;
  const slot = shortcutCapture.slot;
  const current = slotKey(preferences.shortcuts, slot);
  if (e.key === "Escape") {
    endShortcutCapture(current ? `已取消，${slotWords(slot)}仍为 ${keyLabel(current, keyLayout)}` : "已取消");
    return;
  }
  if (e.key === "Backspace" || e.key === "Delete") {
    setShortcuts(clear(preferences.shortcuts, slot));
    endShortcutCapture(`${slotWords(slot)}已清除`);
    return;
  }
  if (e.isComposing || e.keyCode === 229 || ["Unidentified", "Process"].includes(e.key) ||
    /^(Lang[1-5]|Convert|NonConvert|KanaMode|HangulMode|HanjaMode|Zenkaku|Hankaku|ZenkakuHankaku|Eisu|Romaji)$/.test(e.key)) {
    shortcutStatus("请先关闭输入法，再按一个键");
    return;
  }
  const code = eventCode(e), name = keyLabel(code, keyLayout);
  if (!allowed(code)) {
    shortcutStatus(`${code ? `${name} ` : "这个键"}不能用作快捷键（Tab、功能键与媒体键不行），请按其他键`);
    return;
  }
  const other = holder(preferences.shortcuts, code);
  if (other && other !== slot && shortcutCapture.pending !== code) {
    shortcutCapture.pending = code;
    shortcutStatus(`${name} 已用于${slotWords(other)}，再按一次 ${name} 互换，或按其他键`);
    return;
  }
  const result = assign(preferences.shortcuts, slot, code);
  if (!result.ok) return;
  setShortcuts(result.overrides);
  const moved = result.moved
    ? `；${slotWords(result.moved.slot)}${result.moved.key ? `改用 ${keyLabel(result.moved.key, keyLayout)}` : "已清除"}`
    : "";
  endShortcutCapture(`${slotWords(slot)}已改为 ${name}${moved}`);
}
function releaseShortcutKey(e: KeyboardEvent) {
  if (!shortcutHeld || e.code !== shortcutHeld) return;
  shortcutHeld = "";
  e.preventDefault();
  e.stopPropagation();
}
document.addEventListener("keydown", captureShortcutKey, true);
document.addEventListener("keyup", releaseShortcutKey, true);
// Alt+← and Alt+→ would take the page back or forward in its history (the other source's page):
// never, in a panel, a text field, the opening or while a key is being set too.
window.addEventListener("keydown", (e) => {
  if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) e.preventDefault();
}, true);
window.addEventListener("blur", () => {
  shortcutHeld = "";
  endShortcutCapture("已取消");
});
function updateQuality() {
  renderQuality = normalizeQuality(renderQuality);
  preferences.renderQuality = renderQuality;
  scene?.setQuality(renderQuality);
  viewer?.setQuality(renderQuality);
  syncQualityUI(renderQuality);
  const summary = document.querySelector("#quality-summary");
  if (summary)
    summary.textContent = `渲染 ${renderQuality.scale}% · 像素上限 ${renderQuality.pixelRatio}× · ${renderQuality.antialias === "off" ? "基础抗锯齿" : "基础 + SMAA"}`;
  savePrefs();
}
async function scan(saveRoots = false) {
  if (playerCurrent) return;
  if (scanSubmitting || library.scan.running) return;
  scanSubmitting = true;
  clearTimeout(scanRefreshTimer);
  scanRefreshTimer = undefined;
  ++libraryStateVersion;
  try {
    // The main folder first; folders an earlier version saved after it stay saved, unused.
    const main = saveRoots ? $<HTMLInputElement>("#music-root").value.trim() : "";
    if (saveRoots && !main) {
      notify("请先选择或填写音乐主文件夹。");
      return;
    }
    const roots = saveRoots
      ? [main, ...library.roots.slice(1).map((root) => root.path).filter((path) => path !== main)]
      : undefined;
    const next = await scanLibrary(roots);
    ++libraryStateVersion; // Discard polls started before this accepted scan.
    notify("开始扫描音乐主文件夹，已有歌单可以继续浏览。");
    await receiveLibrary(next);
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void loadLibrary(), 600);
  } catch (error) {
    notify((error as Error).message);
  } finally {
    scanSubmitting = false;
  }
}
async function enrich() {
  if (playerCurrent) return;
  if (demo) return;
  try {
    await enrichLibrary();
    notify("已开始补充流派和制作资料，结果将缓存在本机。");
    await loadLibrary();
  } catch (error) {
    notify((error as Error).message);
  }
}
async function queryIntroductions(one = false) {
  if (playerCurrent) return;
  // One album: the selected song's album record.
  const album = localSong()?.album;
  if (demo || !library.albums.length || (one && !album)) return;
  if (introductionsStarting || library.introductions?.running) {
    notify("专辑介绍正在查询，进度可在设置中查看。");
    return;
  }
  introductionsStarting = true;
  introductionRequestError = "";
  updateIntroductionStatus();
  try {
    const next = await startIntroductions(one ? [album!.id] : undefined);
    // A GET started before this accepted job must not restore an older snapshot.
    libraryStateVersion++;
    apiAvailable = true;
    await receiveLibrary(next);
    const job = next.introductions;
    notify(
      job?.running
        ? `${one ? "这张专辑" : "音乐库"}的介绍查询已开始，可在设置中查看进度。`
        : job?.error ||
            (job && job.total > 0
              ? `专辑介绍查询完成：更新 ${job.updated} 张，未找到可靠资料 ${job.notFound} 张，查询失败 ${job.failed} 张。`
              : "当前没有需要查询的专辑。"),
    );
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void loadLibrary(), 800);
  } catch (error) {
    introductionRequestError = (error as Error).message;
    notify(introductionRequestError);
  } finally {
    introductionsStarting = false;
    updateIntroductionStatus();
  }
}

document.addEventListener("click", (e) => {
  if (boot?.active) return;
  const target = (e.target as HTMLElement).closest<HTMLElement>(
    "button, [data-action]",
  );
  // The header's menu closes on a click elsewhere, and once one of its items acted (a theme
  // word leaves it open, to see the change).
  if (stage.dataset.chromeMenu === "open" && !(e.target as Element).closest(".topnav-menu-button") &&
    (!(e.target as Element).closest(".topnav-modes") || (target && !target.dataset.theme)))
    setChromeMenu(false, false);
  // A key being set is cancelled by a click anywhere but its own button (which cancels it too).
  if (shortcutCapture && target?.dataset.action !== "shortcut-capture") endShortcutCapture("已取消");
  if (!target) return;
  if (target instanceof HTMLButtonElement && target.disabled) return;
  if (target.dataset.mediaSource && externalMedia) {
    if (externalMedia.select(target.dataset.mediaSource)) void syncExternal();
    return;
  }
  // A player chosen while 本地音乐 is the current source: it becomes the current source.
  if (target.dataset.mediaSource && playerChooser) {
    if (playerChooser.select(target.dataset.mediaSource)) choosePlayer(target.dataset.mediaSource);
    return;
  }
  if (target.dataset.mediaAction && externalMedia) {
    // NetEase's own controls (the details page's, and the header's previous / next): play /
    // pause and stop answer with the selected case's hop; after previous or next the shelf
    // goes with the song NetEase plays.
    if (target.dataset.mediaAction === "toggle") toggleExternal();
    else if (target.dataset.mediaAction === "stop") stopPlayback();
    else void controlExternal(target.dataset.mediaAction as MediaAction);
    return;
  }
  if (target.dataset.action === "dismiss-panel" && e.target !== target) return;
  if (target.dataset.theme) {
    setTheme(target.dataset.theme as Theme);
    return;
  }
  // A row of the shelf's playlist list: that column, by the same step as ← → (the middle row is the selection).
  if (target.dataset.laneStep !== undefined) {
    const step = Number(target.dataset.laneStep);
    if (step && Number.isInteger(step)) stepGenre(step);
    return;
  }
  // A row of the song scene's list, its ▶ or the rest of it: one click, two or more (clickSongRow).
  const songRow = target.closest<HTMLButtonElement>("#song-list .song-row");
  if (songRow) {
    clickSongRow(songRow, target.dataset.action === "play-row", e);
    return;
  }
  if (target.dataset.select) {
    const index = Number(target.dataset.select);
    const rulerStep = Number(target.dataset.rulerStep);
    netease.queueFollowPaused = true;
    select(index, target.dataset.rulerStep !== undefined && Number.isInteger(rulerStep) ? { axis: "row", direction: rulerStep } : undefined);
    return;
  }
  if (target.dataset.album) {
    const id = target.dataset.album;
    const trackId = target.dataset.searchTrack;
    closePanel(() => {
      cancelSearchTrack();
      const index = records.findIndex((r) => r.id === id);
      if (index < 0) return;
      if (trackId) pendingSearchTrack = { albumId: id, trackId };
      select(index, undefined, true, "archive");
    });
    return;
  }
  if (target.dataset.filter !== undefined) {
    searchGenre = target.dataset.filter;
    document
      .querySelectorAll("[data-filter]")
      .forEach((b) =>
        b.classList.toggle(
          "active",
          (b as HTMLElement).dataset.filter === searchGenre,
        ),
      );
    renderSearchResults();
    return;
  }
  const action = target.dataset.action;
  if (["library", "search", "settings", "sources"].includes(action || "")) {
    searchGenre = "";
    openPanel(action as Panel);
    return;
  }
  switch (action) {
    // 设置's tabs and its 快捷键 (renderShortcutsTab).
    case "settings-tab":
      setSettingsTab(target.dataset.settingsTab === "keys" ? "keys" : "general");
      break;
    case "shortcut-capture": {
      const slot = target.dataset.shortcutSlot as ShortcutSlot;
      if (shortcutCapture?.slot === slot) endShortcutCapture("已取消");
      else startShortcutCapture(slot);
      break;
    }
    case "shortcut-reset": {
      const id = target.dataset.shortcut as ShortcutAction;
      const info = shortcutInfo(id);
      const result = reset(preferences.shortcuts, id);
      setShortcuts(result.overrides);
      renderShortcutRows(id);
      const moved = result.moved
        ? `；${slotWords(result.moved.slot)}${result.moved.key ? `改用 ${keyLabel(result.moved.key, keyLayout)}` : "已清除"}`
        : "";
      shortcutStatus(`“${actionWords(id).name}”已恢复默认 ${keyLabel(info.key, keyLayout)}${moved}`);
      break;
    }
    case "shortcuts-reset-all": {
      // What this build does not know (a later version's keys) stays for it.
      const known = new Set<string>(SHORTCUTS.flatMap((info) => [info.id, `${info.id}.extra`]));
      setShortcuts(Object.fromEntries(Object.entries(preferences.shortcuts).filter(([slot]) => !known.has(slot))));
      renderShortcutRows();
      shortcutStatus("所有快捷键已恢复默认");
      break;
    }
    // 本地音乐 in the header (and the empty page's button): the local music becomes the current
    // source; nothing to do while it is (as with the chosen theme word).
    case "local-source":
      switchSource("local");
      break;
    case "refresh-sources":
      if (playerChooser) void refreshChooser();
      else void refreshExternal();
      break;
    case "disconnect-source":
      if (playerChooser) {
        playerChooser.disconnect();
        updateChooser();
        break;
      }
      externalMedia?.disconnect();
      void syncExternal();
      break;
    case "netease-restart-debug":
      if (netease.debugRestarting) break;
      if (target.dataset.confirm !== "true") {
        // Closing someone's player needs a second, deliberate click.
        target.dataset.confirm = "true";
        target.textContent = "再点一次确认：将关闭并重新启动网易云";
        break;
      }
      void netease.restart()
        .then(() => notify(externalMedia?.followsPreferred
          ? "网易云已以调试端口重新启动，出现后会自动重新连接。"
          : "网易云已以调试端口重新启动。请在“播放器”面板重新选择网易云。"))
        .catch((error) => notify(String(error instanceof Error ? error.message : error)))
        .finally(() => {
          delete target.dataset.confirm;
          target.textContent = "以调试端口重新启动网易云";
          void refreshExternal();
        });
      updateExternalControls();
      break;
    case "close-panel":
    case "dismiss-panel":
      closePanel();
      break;
    // 查看这首歌 (the shelf) and 这首歌 (the song scene) open the song's details and play it (openCase;
    // the owner, 2026-10-09). A pointer press that closed the header's open menu only opens; a press
    // of the key (e.detail 0) is not one.
    case "open":
      openCase(!(e.detail > 0 && pressClosesMenu), () => setMode("detail"));
      break;
    case "songs":
      toggleSongs();
      break;
    case "details":
      openCase(!(e.detail > 0 && pressClosesMenu));
      break;
    case "back":
      leaveMenu();
      break;
    case "model-viewer":
      // Temporarily unavailable for the simplified CD shell (no inner assembly).
      break;
    case "sound-preview":
      effects.play("page-open");
      break;
    case "fullscreen":
      void (
        document.fullscreenElement
          ? document.exitFullscreen()
          : document.documentElement.requestFullscreen()
      ).catch(() => notify("当前浏览器无法进入全屏。"));
      break;
    case "prev":
      stepAlbum(-1);
      break;
    case "next":
      stepAlbum(1);
      break;
    case "genre-prev":
      stepGenre(-1);
      break;
    case "genre-next":
      stepGenre(1);
      break;
    // The header's ring: pause or resume what plays.
    case "play-pause":
      togglePlayback();
      break;
    // The shelf's 42 px ring: the selected song's own play button (ringPlay).
    case "shelf-play":
      ringPlay(navigationSelection());
      break;
    // (▶ in a song row, data-action="play-row", is the row's: clickSongRow, above.)
    // ● 012 beside the shelf's ring and on the song scene's pane: back to the song that plays.
    case "go-playing":
      goToPlaying();
      break;
    // The details' ring of a song (NetEase's queue, a local song): that song's own play button.
    case "detail-play":
      ringPlay(selected);
      break;
    // 本地音乐's header: the local player's own previous / next song. The shelf stays where it is.
    case "previous-track":
      void player?.previous();
      break;
    case "next-track":
      void player?.next();
      break;
    case "topnav-menu":
      setChromeMenu(stage.dataset.chromeMenu !== "open");
      break;
    case "scan":
      void scan(true);
      break;
    case "rescan":
      void scan();
      break;
    case "enrich-library":
      void enrich();
      break;
    case "introduction-album":
      void queryIntroductions(true);
      break;
    case "introductions-library":
      void queryIntroductions();
      break;
    case "save-online":
      void (async () => {
        try {
          await saveOnlineConfig({
            musicBrainzContact:
              $<HTMLInputElement>("#metadata-contact").value.trim(),
            onlineEnabled: $<HTMLInputElement>("#online-enabled").checked,
          });
          notify("资料库设置已保存。可以开始补充专辑资料。");
        } catch (error) {
          notify((error as Error).message);
        }
      })();
      break;
    case "demo":
      if (playerCurrent) break;
      demo = true;
      closePanel(() => void applyLibrary());
      break;
  }
});
document.addEventListener("input", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.dataset.quality && el.type === "range") {
    renderQuality = normalizeQuality({
      ...renderQuality,
      [el.dataset.quality]: Number(el.value),
    });
    updateQuality();
  }
  if (el.id === "bgm-volume") {
    if (playerCurrent) return;
    preferences.bgmVolume = Number(el.value) / 100;
    player?.setBgmVolume(preferences.bgmVolume);
    savePrefs();
  }
  if (el.id === "sound-volume") {
    if (playerCurrent) return;
    preferences.soundVolume = Number(el.value) / 100;
    effects.configure({
      sound: preferences.sound,
      music: false,
      soundVolume: preferences.soundVolume,
      musicVolume: 0,
    });
    savePrefs();
  }
  if (el.id === "album-search") renderSearchResults();
  // The details' timelines: the fill follows a drag at once (the seek is sent on change).
  if ((el.id === "external-seek" || el.id === "local-seek") && el.dataset.known === "true") syncSeekFill(el, true);
  if (el.id === "volume") {
    if (playerCurrent) return;
    preferences.volume = Number(el.value) / 100;
    player?.setVolume(preferences.volume);
    savePrefs();
  }
});
document.addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement;
  if (externalMedia && el.id === "external-global-keys") {
    externalMedia.setGlobalMediaKeys(el.checked);
    updateExternalControls();
    return;
  }
  if (externalMedia && el.id === "external-seek") {
    if (externalTimeline().debug) requestSeek(Number(el.value));
    else void controlExternal("seek", Number(el.value));
    return;
  }
  if (el.id === "local-seek") {
    player?.seek(Number(el.value));
    return;
  }
  if (externalMedia && el.id === "netease-queue") {
    preferences.neteaseQueue = el.checked;
    savePrefs();
    netease.queueSwitched(el.checked);
    updateExternalControls();
    void refreshExternal();
    return;
  }
  if (externalMedia && el.id === "netease-playlists") {
    preferences.playlistColumns = el.checked;
    savePrefs();
    netease.playlistsSwitched(el.checked);
    updateExternalControls();
    void refreshExternal();
    return;
  }
  if (el.id === "quality-preset") {
    preferences.quality = el.value as QualityPreset;
    renderQuality = normalizeQuality(qualityPresets[preferences.quality]);
    updateQuality();
  }
  if (el.dataset.quality) {
    renderQuality = normalizeQuality({
      ...renderQuality,
      [el.dataset.quality]:
        el.dataset.quality === "antialias" ? el.value : Number(el.value),
    });
    updateQuality();
  }
  if (el.id === "sound-setting") {
    if (playerCurrent) return;
    preferences.sound = el.checked;
    effects.configure({
      sound: el.checked,
      music: false,
      soundVolume: preferences.soundVolume,
      musicVolume: 0,
    });
    savePrefs();
  }
  if (el.id === "song-fade-setting") {
    if (playerCurrent) return;
    preferences.songFade = el.checked;
    player?.setSongFadeEnabled(el.checked);
    savePrefs();
  }
  if (el.id === "frame-cap") {
    const cap = Number((el as unknown as HTMLSelectElement).value);
    preferences.frameCap = FRAME_CAPS.includes(cap) ? cap : 0;
    frameCap.set(preferences.frameCap);
    requestFrame();
    savePrefs();
  }
  if (el.id === "reduced-motion") {
    preferences.reduced = el.checked;
    transportTitleMotion.setReduced(el.checked);
    if (el.checked) {
      browseTransition.finish();
      detailTransition.finish();
      songTransition.finish();
    }
    syncSelectionMotion();
    scene?.setReduced(el.checked);
    lyricsView.setReduced(el.checked);
    stage.classList.toggle("reduce-motion", el.checked);
    updateSelection();
    savePrefs();
  }
  // Read when the page starts (MusicBoot): nothing changes until the next start.
  if (el.id === "intro-setting") {
    preferences.intro = el.checked;
    savePrefs();
  }
  if (el.id === "bgm-setting") {
    if (playerCurrent) return;
    preferences.bgm = el.checked;
    player?.setBgmEnabled(el.checked);
    savePrefs();
  }
});
document.addEventListener("keydown", (e) => {
  if (boot?.active) return;
  if (viewer?.isOpen) return;
  // An open header menu closes first.
  if (e.key === "Escape" && stage.dataset.chromeMenu === "open") {
    setChromeMenu(false, true);
    return;
  }
  // In the open menu the arrows move along its items, not the shelf; the scenes' keys close it before
  // they act (but Space and Enter, which press its items).
  if (stage.dataset.chromeMenu === "open") {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = [...$("#topnav-modes").querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const at = items.indexOf(document.activeElement as HTMLButtonElement), step = e.key === "ArrowDown" ? 1 : -1;
      items[at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length]?.focus();
      return;
    }
    if (!!shortcutAt(e) && e.code !== "Space" && e.key !== "Enter") setChromeMenu(false);
  }
  // Esc closes an open panel, whatever key 返回专辑架 has.
  if (e.key === "Escape" && panel) {
    closePanel();
    return;
  }
  if (panel) {
    if (settingsTabKey(e)) return;
    if (e.key === "Tab") {
      const items = [
        ...document.querySelectorAll<HTMLElement>(
          "#music-panel-root button:not([disabled]), #music-panel-root input, #music-panel-root textarea, #music-panel-root select, #music-panel-root a",
        ),
      ];
      if (!items.length) return;
      const first = items[0],
        last = items.at(-1)!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    return;
  }
  const target = e.target as HTMLElement;
  // Typing: no shortcut (a slider is not typing).
  if (target.matches("input:not([type=range]), textarea, select, [contenteditable=true]")) return;
  // Inside the playlist its own keys (↑ ↓ Home End PageUp PageDown) move along its rows, whatever
  // they are bound to; a focused slider keeps its keys too.
  if (menu === "song" && songView.handleKey(e)) return;
  if (target.matches("input[type=range]") && SLIDER_KEYS.has(e.key)) return;
  // Ctrl or Win with Space or Enter is no shortcut, and does not press the focused control either
  // where the key alone would act instead (Chromium's press ignores them). Alt+Space is the window's.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.isComposing && e.keyCode !== 229 &&
    (e.code === "Space" || e.key === "Enter")) {
    const plain = shortcutKeys.get(eventCode(e));
    if (plain && takesPress(e, plain, target)) {
      e.preventDefault();
      if (e.code === "Space") spaceTaken = true;
    }
    return;
  }
  // Every action by its keys (shortcuts.ts; the user's, 设置 → 快捷键): by the key's code, without
  // Ctrl, Alt or Win, held down only where the action repeats (the songs' and the playlists' steps).
  const action = shortcutAt(e);
  if (!action) return;
  if ((e.code === "Space" || e.key === "Enter") && !takesPress(e, action, target)) return;
  e.preventDefault();
  if (e.code === "Space") spaceTaken = true;
  if (!e.repeat || shortcutInfo(action).repeat) runShortcut(action, e);
});
/** A focused slider's own keys. */
const SLIDER_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
/**
 * Whether Space or Enter, bound to `action`, acts instead of pressing the focused control (Space
 * presses it as it is released). In the three scenes the action comes first (the owner, 2026-10-08:
 * Space pauses or resumes whatever button has the focus), but not where they stay the control's own
 * (pressKeepsOwn); 查看这首歌 leaves a focused button its own press, as Enter always did; and Enter
 * presses the header's and a notice's buttons whatever it is bound to, so 设置 stays in reach of
 * the keyboard.
 */
function takesPress(e: KeyboardEvent, action: ShortcutAction, target: HTMLElement) {
  if (pressKeepsOwn(target)) return false;
  const control = target.closest("button, a");
  if (!control) return true;
  if (action === "open") return false;
  return !(e.key === "Enter" && !!control.closest(".music-topnav, #music-toast"));
}
/**
 * Where Space and Enter stay the focused control's own keys: the header's open menu, the window's
 * own buttons, and a page without songs (its buttons: choose a folder, a player, the demonstration).
 */
function pressKeepsOwn(target: HTMLElement) {
  return stage.dataset.chromeMenu === "open" || !!target.closest(".window-bar")
    || (!records.length && !!target.closest("button, a"));
}
// A focused button is clicked when Space is released: not when Space ran a shortcut.
let spaceTaken = false;
document.addEventListener("keyup", (e) => {
  if (e.code !== "Space" || !spaceTaken) return;
  spaceTaken = false;
  e.preventDefault();
});

// The wheel scrolls the shelf. Events only add to the accumulator; frame() applies the rows
// it releases as one multi-row step, so a fast spin costs a few selections, not one per event.
const wheelNavigation = new WheelNavigation();
function wheelCanNavigate() {
  return ready && !!scene && !boot?.active && !panel && !viewer?.isOpen && !libraryRebuilding &&
    records.length > 1 && (!playerCurrent || !!netease.shownQueue());
}
/** Track lists, panels and a tall selection callout keep their own wheel scrolling. */
function scrollsNatively(target: EventTarget | null) {
  for (let node = target instanceof Element ? target : null; node && node !== stage; node = node.parentElement) {
    if (node.matches("input, textarea, select")) return true;
    if (node.scrollHeight > node.clientHeight + 1 && /^(auto|scroll)$/.test(getComputedStyle(node).overflowY)) return true;
  }
  return false;
}
stage.addEventListener("wheel", (event) => {
  // Ctrl + wheel is zoom, and a mostly sideways gesture is not a row scroll.
  if (event.ctrlKey || event.metaKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
  // Over the shelf's playlist list the wheel turns the list (the columns), not the column's rows.
  if ((event.target as Element | null)?.closest?.(".playlist-drum")) {
    event.preventDefault();
    if (wheelCanNavigate()) turnDrum(event);
    return;
  }
  // The song scene's list keeps the wheel to itself even when it is too short to scroll; the
  // rest of its pane (the tab, the selected song) moves along the column like the scene around it.
  if (!wheelCanNavigate() || scrollsNatively(event.target) || songView.list.contains(event.target as Node)) return;
  event.preventDefault();
  // A mouse wheel reports whole notches in wheelDeltaY (120 each), whatever the Windows
  // "lines per notch" setting or the page zoom make of deltaY: one notch is one row.
  const notches = (event as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
  const notched = event.deltaMode === 0 && typeof notches === "number" && notches !== 0 && notches % 120 === 0;
  wheelNavigation.push(notched ? (-notches / 120) * WHEEL_PIXELS_PER_ROW : event.deltaY, event.deltaMode, performance.now(), innerHeight);
  requestFrame();
}, { passive: false });
function drainWheel() {
  if (!wheelNavigation.active) return;
  if (!wheelCanNavigate()) return wheelNavigation.reset();
  const rows = wheelNavigation.take(performance.now(), preferences.reduced);
  if (rows) stepAlbum(rows);
}

let lastFrame = 0,
  frameCount = 0,
  frameRequest = 0,
  frameTimer = 0,
  // The number of the loop's pending request: only that one runs the loop, so it is one loop.
  frameToken = 0;
// 帧率上限 (frame-cap.ts): which display frames the loop may run on.
const frameCap = new FrameCap();
frameCap.set(preferences.frameCap);
/**
 * Asks for the loop's next run. A second loop drew the whole scene again in every display frame
 * (2026-10-10: up to 637 draws a second against the display's 240; the frame pacing takes a run that
 * took no time for a fresh start that must draw); a request that is not the latest ends unrun.
 */
function scheduleFrame() {
  const token = ++frameToken;
  frameRequest = requestAnimationFrame((ms) => {
    if (token === frameToken) frame(ms);
  });
}
function requestFrame() {
  window.clearTimeout(frameTimer);
  frameTimer = 0;
  if (!frameRequest) scheduleFrame();
}
function frame(ms: number) {
  frameRequest = 0;
  // 帧率上限: a display frame before the next run's time (an early wake by input, or one stamped
  // before that time) only measures the display for the frame pacing; the loop then waits for it.
  const capped = !document.hidden;
  if (capped && !frameCap.admit(ms)) {
    if (scene && !viewer?.isOpen) scene.skipFrame(ms / 1000);
    waitForFrame(frameCap.next);
    return;
  }
  if (!document.hidden && scene) {
    drainWheel();
    const opening = boot?.update(ms / 1000);
    if (!viewer?.isOpen) scene.update(ms / 1000, opening?.cinema);
    syncBracket();
    syncSongHop();
    // The song scene's level meter moves with this loop (about 60 times a second at rest, fewer
    // under a lower 帧率上限).
    songView.tickMeter(ms, preferences.reduced);
    viewer?.update(ms / 1000);
    if (!viewer?.isOpen && !boot?.active) presentation.update();
    const phase = presentation.phase;
    if (stage.dataset.presentation !== phase) stage.dataset.presentation = phase;
    const cameraPhase = scene.musicPresentationPhase;
    if (stage.dataset.cameraPhase !== cameraPhase) stage.dataset.cameraPhase = cameraPhase;
    if (presentation.phase === "detail") {
      documentDecryption.update(
        ms / 1000,
        scene.decryptionFrame,
        preferences.reduced,
        !viewer?.isOpen,
      );
      if (pendingDetailFocus && !panel && !viewer?.isOpen) {
        $("#album-detail-content").focus({ preventScroll: true });
        pendingDetailFocus = false;
      }
      if (pendingSongFocus && !panel && menu === "song") {
        songView.focusCurrent();
        pendingSongFocus = false;
      }
      if (pendingSearchTrack && !panel && !viewer?.isOpen &&
        $("#music-detail").dataset.transition === "open" &&
        currentAlbum()?.id === pendingSearchTrack.albumId) {
        const content = $("#album-detail-content");
        const trackId = pendingSearchTrack.trackId;
        pendingSearchTrack = undefined;
        const row = Array.from(content.querySelectorAll<HTMLButtonElement>(".track-row"))
          .find((item) => item.dataset.track === trackId);
        if (row) trackFocus.reveal(content, row, preferences.reduced);
      }
    }
    frameCount++;
    if (ms - lastFrame > 1500) {
      // The frame rate is diagnostics only (no readout on screen any more).
      $("#three-scene").dataset.fps = String(Math.round((frameCount * 1000) / (ms - lastFrame)));
      // Keep read-only render diagnostics alongside the existing resolution
      // attributes, without adding controls or per-frame DOM work.
      if (!viewer?.isOpen) {
        const { drawCalls, triangles, selectionLight } = scene.getStats();
        $("#three-scene").dataset.renderStats = JSON.stringify({
          drawCalls,
          triangles,
        });
        $("#three-scene").dataset.selectionLight =
          JSON.stringify(selectionLight);
      }
      frameCount = 0;
      lastFrame = ms;
    }
  } else {
    wheelNavigation.reset();
    frameCount = 0;
    lastFrame = ms;
  }
  // Input or a state change during this frame already asked for the next one.
  if (frameRequest) return;
  // While the scene rests and nothing here animates, wait for the scene's next
  // ~60 Hz slot instead of running every display frame (FramePacing); with a 帧率上限,
  // also for the cap's next run, whichever is later.
  const quiet = scene && !document.hidden && !boot?.active && !viewer?.isOpen &&
    !pendingDetailFocus && !pendingSongFocus && !pendingSearchTrack && !wheelNavigation.active && (presentation.phase === "archive" ||
      (presentation.phase === "detail" && !documentDecryption.active));
  waitForFrame(Math.max(quiet ? scene!.nextFrameAt() * 1000 : 0, capped ? frameCap.next : 0));
}
/**
 * Runs the loop again at `at` (ms, the animation-frame clock): a timer, or the next display frame
 * when that is less than a display frame away (it is then the first that may run).
 */
function waitForFrame(at: number) {
  const wait = at - performance.now();
  if (wait > Math.max(1, (scene?.displayFrame ?? 0) * 1000)) {
    // The interval across this wait is not a display frame (FramePacing).
    scene?.frameWaited();
    frameTimer = window.setTimeout(requestFrame, wait);
  } else scheduleFrame();
}
async function start() {
  // The keys' names (设置 → 快捷键), with the keyboard layout's characters once it is read.
  applyKeyLabels();
  readKeyLayout();
  window.addEventListener("focus", readKeyLayout);
  if (savedShortcuts.reverted) {
    savePrefs();
    settingsTab = "keys";
    startupNotice = () => notify("有快捷键与其他按键重复或不能使用，已恢复默认。", { label: "打开设置", panel: "settings" });
  }
  // This local application owns its live index. An old archive PWA must not serve stale UI.
  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((r) => r.unregister()));
  }
  if (playerCurrent) await refreshExternal();
  else await loadLibrary(true);
  try {
    fit();
    scene = new ArchiveScene($("#three-scene"));
    // Keep a direct visual comparison URL without adding another user setting.
    if (new URLSearchParams(location.search).get("lighting") !== "baseline")
      scene.enableSelectionLighting();
    await Promise.all([
      scene.load(),
      document.fonts.load("400 20px MiSans"),
      document.fonts.load("600 20px MiSans"),
      // The wordmark and the tags: no swap while the overlay is revealed.
      document.fonts.load("700 20px MiSans"),
    ]);
    ready = true;
    fitChrome();
    $("#three-scene canvas").setAttribute(
      "aria-label",
      sceneLabel(),
    );
    stage.classList.toggle("reduce-motion", preferences.reduced);
    // A player as the current source starts on the song that is playing: with the default link
    // the queue is there before the scene, and the opening must not present another song and
    // travel afterwards.
    if (playerCurrent && netease.queuePlaying) {
      const playing = records.findIndex((record) => record.id === netease.queuePlaying);
      if (playing >= 0) selected = playing;
    }
    syncLaneLabels();
    await scene.refreshLibrary(selected);
    scene.setTheme(preferences.theme);
    scene.setQuality(renderQuality);
    scene.setReduced(preferences.reduced);
    await scene.precompile();
    await prewarmSongPanel();
    scene.onSelect = (index, cell, lifted) => {
      if (boot?.active || panel) return;
      const songScene = presentation.phase === "detail" && menu === "song";
      // The selected case opens its details: on the shelf, where its song also plays (openCase;
      // not for the press that closed the header's open menu), and as the song scene's large
      // card, where it plays too since 2026-10-09 (openCase).
      if (lifted && presentation.phase === "archive") return openCase(!pressClosesMenu);
      if (lifted && songScene) return openCase(!pressClosesMenu);
      if (playerCurrent && !netease.shownQueue()) return;
      // A card of the chain becomes the large card, also when a short looping column shows
      // the same album or song again there.
      if (!songScene && presentation.phase !== "archive") return;
      netease.queueFollowPaused = true;
      select(index, cell ? { cell } : undefined);
    };
    scene.onNavigate = (axis, direction) => {
      if ((!playerCurrent || netease.shownQueue()) && !boot?.active && presentation.phase === "archive" && !panel)
        axis === "lane" ? stepGenre(direction) : stepAlbum(direction);
    };
    $("#music-loading").remove();
    delete stage.dataset.switching;
    updateSelection();
    // The opening plays when the program starts, never when the source is switched (the page
    // loaded again for the other source: the shelf is simply there, the header never left).
    if (albums.length && new URLSearchParams(location.search).get("scene") !== "archive" && !sourceSwitch) {
      boot?.start(performance.now() / 1000);
    } else {
      scene.showMusicArchiveImmediately(performance.now() / 1000);
      effects.setScene("archive");
      if (albums.length) showBrowseSurface();
      else browseTransition.hide(true);
      $("#music-browse").inert = !albums.length || !!panel;
      $("#music-browse").setAttribute("aria-hidden", String(!albums.length));
      showStartupNotice();
    }
    syncSelectionMotion();
    requestAnimationFrame((ms) => {
      stage.classList.add("theme-motion-ready");
      scene!.onWake = requestFrame;
      // The loop starts here. The wheel may have started one while the above was loading: its
      // pending run is dropped, and this is the one loop.
      if (frameRequest) cancelAnimationFrame(frameRequest);
      window.clearTimeout(frameTimer);
      frameRequest = frameTimer = 0;
      frameToken++;
      frame(ms);
    });
  } catch (error) {
    console.error(error);
    $("#music-loading").innerHTML =
      `<strong>三维资源未能加载</strong><small>${esc((error as Error).message)}</small><button data-action="library">检查音乐库</button>`;
  }
}
// The 播放器 panel a player was chosen in is open again on the page that shows that player, at
// once, over the loading cover (the switch keeps it in view).
if (sourceSwitch?.panel && playerCurrent) openPanel("sources", true);
void start();
Object.assign(window, {
  rhineMusic: {
    get library() {
      return library;
    },
    get selectedAlbum() {
      return currentAlbum();
    },
    get player() {
      return player?.state;
    },
    get external() {
      return externalMedia ? { sources: externalMedia.sources, selected: externalMedia.selected,
        selectedId: externalMedia.selectedId, disconnected: externalMedia.disconnected,
        remembered: externalMedia.remembered,
        allowGlobalMediaKeys: externalMedia.allowGlobalMediaKeys, warning: externalMedia.warning,
        error: externalMedia.error, busy: externalMedia.busy } : undefined;
    },
    stats: () => scene?.getStats(),
    // The lifted case's box on screen (CSS px), null off the shelf: the overlay's marks follow it.
    get liftedCase() {
      return scene?.liftedCaseRect ?? null;
    },
    get presentation() {
      return { phase: presentation.phase, cameraPhase: scene?.musicPresentationPhase,
        pendingIndex: presentation.pendingSelection?.index,
        menuVisible: !$("#music-detail").hidden,
        menu, songOrigin, songVisible: !$("#music-song").hidden,
        cameraReady: scene?.musicPresentationReady,
        archiveReady: scene?.musicArchiveReady };
    },
  },
});
