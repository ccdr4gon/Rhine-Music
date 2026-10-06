import "@kitlangton/rolling-number/styles.css";
import { flushDesktopPreferences, isDesktop, saveDesktopPreferences } from "./desktop";
import { chooseMusicFolders } from "./local_music/connector/folders";
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
import { laneTrackKey, queueTrackKey } from "./netease_music/data/queue";
import { NETEASE_NAME, isNeteaseSource } from "./netease_music/connector/player";
import { NeteaseSession } from "./netease_music/connector/session";
import { queueSettingMarkup } from "./netease_music/connector/settings";
import {
  playerLinks, playerMediaPort, pageSource, sourceAddress, markSourceSwitch, takeSourceSwitch, type SourceKind,
} from "./music-sources";
import { type LaneName } from "./lane-labels";
import { installWindowFrame } from "./window-frame";
import { WheelNavigation, WHEEL_PIXELS_PER_ROW } from "./wheel-navigation";
import {
  ExternalMediaConnection, nativeMediaPort, mediaLibrary, mediaVisualKey,
  mediaConnectionLabel, mediaPlaybackLabel, mediaTime, mediaSourcesMarkup,
  mediaPermissionMarkup, spacedName, type MediaAction, type SourceLink,
} from "./external_player/external-media";
import { DocumentDecryption } from "./document-decryption";
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
import { SONG_VIEW } from "./song-pose";
import { MUSIC_MODEL } from "./music-model";

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
 * the details, S the song scene, Space plays or pauses (a small triangle instead of words). A
 * lone live track (no queue) has only the details and play / pause.
 */
function keyHintMarkup(queue: boolean) {
  const hint = (key: string, words: string) => `<span class="hint"><kbd>${key}</kbd><span>${words}</span></span>`;
  const space = '<span class="hint"><kbd>SPACE</kbd><i class="hint-play" aria-hidden="true"></i><span class="sr-only">播放 / 暂停</span></span>';
  if (playerCurrent && !queue) return hint("ENTER", "查看") + space;
  return hint("↑ ↓", "选歌") + hint("ENTER", "查看") + hint("S", playerCurrent ? "播放列表" : "选歌") + space;
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
    neteaseQueue: false,
    // The play button (and Space) asks NetEase to play the selected queue song through its
    // debugging port (which also gives the progress and seeking); only while the port answers.
    neteaseControl: true,
    // One shelf column per NetEase playlist, read from its local database once the queue is
    // shown. On unless switched off (the owner's choice, 2026-10-04).
    playlistColumns: true,
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
      neteaseControl: boolean;
      playlistColumns: boolean;
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
// and playlist columns when they were off by default (now under playlistColumns, so that the
// old default does not outlive the new one).
for (const key of ["laneLabels", "laneNameStyle", "neteasePlaylists"]) delete (preferences as Record<string, unknown>)[key];
if (!["genre", "artist", "album"].includes(preferences.sortMode))
  preferences.sortMode = "genre";
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
});
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
    <div class="music-identity"><span class="music-brand"><strong>RHINE LAB</strong></span></div>
    <nav class="music-topnav" aria-label="音乐终端导航">
      <div class="topnav-modes" id="topnav-modes">
        ${sourceButtons()}
        <div class="topnav-theme"><span class="topnav-menu-only" aria-hidden="true">主题</span><div class="theme-switch" role="group" aria-label="主题">${(["day", "night"] as Theme[]).map((t) => `<button data-theme="${t}" aria-label="${themeNames[t]}主题" aria-pressed="${preferences.theme === t}">${themeNames[t]}</button>`).join("")}</div></div>
        <button data-action="settings" aria-label="播放与画质设置"><span class="topnav-menu-only">播放与画质</span>设置<i class="topnav-menu-value topnav-menu-square" aria-hidden="true"></i></button>
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
        <div class="shelf-play"><button data-action="play-pause" id="shelf-play" class="play-ring play-ring-big" aria-label="播放" aria-pressed="false" data-ring="plain" ${playerCurrent ? "disabled" : ""}><span class="transport-glyph transport-play" aria-hidden="true"></span><span class="transport-glyph transport-pause" aria-hidden="true"><i></i><i></i></span></button><span id="shelf-play-note" class="shelf-play-note" data-dot="false"><i aria-hidden="true"></i><span></span></span></div>
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
    <div class="music-keyhint" id="music-keyhint">${keyHintMarkup(false)}</div>
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
  <div id="music-empty" class="music-empty" hidden>${playerCurrent ? '<small>YOUR PLAYER / THIS WINDOW</small><h1>让正在听的歌进入档案馆。</h1><p id="external-empty-note">选择一个外部播放器，显示它的当前曲目与封面。这里只提供连接和控制，不导入曲库，也不播放本地音频。</p><button data-action="sources" id="external-empty-sources">选择播放器 ↗</button><button data-action="local-source" class="subtle">改用本地音乐</button>' : '<small>YOUR PRIVATE COLLECTION</small><h1>让音乐进入这座档案馆。</h1><p>选择一个音乐主文件夹：其中每个子文件夹是一个歌单，每首歌一张卡片，封面来自它的专辑。</p><button data-action="library">选择音乐主文件夹 ↗</button><button data-action="demo" class="subtle">先查看演示歌单</button>'}</div>
  <div id="music-panel-root"></div><div id="music-toast" role="status" aria-live="polite"></div>
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

function notify(message: string) {
  $("#music-toast").textContent = message;
  $("#music-toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => $("#music-toast").classList.remove("visible"),
    5500,
  );
}
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
  ".detail-facts dd, .track-name strong, .album-about p",
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
  },
  // A press during the fade-in shows the whole page at once: the shelf's own fade too.
  onRevealCut: () => browseTransition.finish(),
});
function showBrowseSurface() {
  if (!albums.length || boot?.active) return;
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
    const box = header.getBoundingClientRect(), brand = $(".music-brand").getBoundingClientRect();
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
  const previousDetail = detailKey();
  const visualKey = (items: MusicAlbum[], groups: MusicGenre[]) =>
    JSON.stringify([
      items.map((a) => [a.id, a.title, a.artist, a.genreId, a.coverUrl]),
      groups.map((g) => [g.id, g.name]),
    ]);
  const oldVisual = visualKey(albums, genres);
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
  if (playerCurrent && records.length && records[selected]?.id !== previousId) {
    // The box the user rested on is gone: it left NetEase's queue, or its column became or
    // stopped being the queue (the queue's cases have keys of their own). Nothing to play:
    // follow NetEase again from the song it plays now, whichever column that is. Asked of
    // the new queue (queuePlaying is still the last poll's), and never left in a column that
    // is only for browsing, where following stops.
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
  if (scene && ready && oldVisual !== visualKey(albums, genres)) {
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
  if (mode === "detail" && previousDetail !== detailKey())
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
    // after a disconnect, nothing is connected by itself.
    const preferredName = externalMedia.preferred?.name ?? "";
    const awaited = externalMedia.remembers && externalMedia.awaitsPreferred && !externalMedia.ambiguous;
    setText($("#external-empty-note"), `${externalMedia.ambiguous
      ? `${preferredName}有多个媒体会话，请选择要连接的一个`
      : awaited
        ? `等待${spacedName(preferredName)}…上次连接的是它，它出现后会自动连接`
        : externalMedia.followsPreferred
          ? `${preferredName}在运行时会自动连接，也可以选择其他播放器`
          : "选择一个外部播放器"}，显示它的当前曲目与封面。这里只提供连接和控制，不导入曲库，也不播放本地音频。`);
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
  tickMotion.update(
    files.map((index) => ({ index, id: records[index].id, title: records[index].title })),
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
  // The play button acts on where the selection is going: say so while a detail switch waits.
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
 * selected case) opens the details, S switches to the song scene and back to the details,
 * Esc returns to the shelf. (Enter on a focused button does what the button does: on a row
 * of the song list it selects or plays that row.) S is never a way out to the shelf; while
 * a swap is refused (still opening, text leaving, shelf settling after a rebuild) it is ignored.
 */
function toggleSongs() {
  if (menu !== "song") openSongs();
  else swapToDetail();
}
/** Song details: opened from the shelf, swapped in from the song scene. */
function showDetails() {
  if (menu === "song") swapToDetail();
  else setMode("detail");
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
      note: netease.songQueueNote(),
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
  const playing = (queue ? netease.queuePlaying : playerState?.currentTrack?.id) || undefined;
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
  songView.sync({ playing, selected: selectedKey, pending: netease.queueJump?.key, paused, live });
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
 * The play button and Space. The owner's play mode (2026-10-05): browsing never switches the
 * song; the play button plays the selection when it is not what plays, and pauses or resumes
 * it when it is. With NetEase as the current source a selected song of its queue is played through the
 * debugging port (NetEase's own "play this song of the queue"); what Rhine cannot ask NetEase
 * to play (a playlist column, no port, private FM) leaves NetEase's plain play / pause.
 */
function togglePlayback() {
  if (playerCurrent) {
    const wanted = netease.queueSongToPlay(playsCurrent());
    if (wanted) void netease.playQueueSong(wanted);
    else {
      if (!externalMedia?.can("toggle")) return;
      void controlExternal("toggle");
    }
  } else if (localSongWaits()) playSong();
  else playerState?.currentTrack ? void player?.toggle() : playSong();
  scene?.playGesture();
  if (records.length) tickMotion.ripple();
}
/**
 * Whether the play button may ask for the playing song itself: when NetEase offers no play /
 * pause of its own (whether or not a control is on its way) and is not playing it. It can
 * start a song that way, never pause one.
 */
function playsCurrent() {
  return !externalMedia?.offers("toggle") && mediaPlayback() !== "playing";
}
/** NetEase's own play / pause, whatever is selected: the details page's player controls. */
function toggleExternal() {
  if (!externalMedia?.can("toggle")) return;
  void controlExternal("toggle");
  scene?.playGesture();
  if (records.length) tickMotion.ripple();
}
/** 本地音乐: the selected song is not the one loaded, so the play button plays it. */
function localSongWaits() {
  const song = currentAlbum(), loaded = playerState?.currentTrack;
  return !!song?.tracks.length && !song.offline && (!loaded || loaded.id !== song.id);
}
/** NetEase's playback as its own player reports it when the port answers, else as Windows does. */
function mediaPlayback(source = externalMedia?.selected) {
  return netease.playback(source);
}
/** The play button says what it will do: play the selection, or pause / resume what plays. */
function syncPlayButton() {
  syncRing();
  syncPlayNote();
  // The header's ring and the shelf's larger one are the same control (the same press, label and state).
  for (const button of document.querySelectorAll<HTMLButtonElement>("#play-pause, #shelf-play")) {
    if (playerCurrent) {
      if (!externalMedia) return;
      const source = externalMedia.selected, wanted = netease.queueSongToPlay(), playback = mediaPlayback(source);
      // Pausing or resuming NetEase's song while another case is selected (a playlist column's).
      const other = !!netease.shownQueue() && records[navigationSelection()]?.id !== netease.queuePlaying ? "当前" : "";
      const label = wanted ? "播放这首" : playback === "playing" ? `暂停${other}` : playback === "unknown" ? "播放 / 暂停（状态未知）" : playback === "paused" ? `继续${other}` : `播放${other}`;
      // Not dimmed while a control is on its way (a press in that moment is ignored, as before).
      button.disabled = !wanted && !externalMedia.offers("toggle") && !netease.queueSongToPlay(playsCurrent());
      button.setAttribute("aria-pressed", String(!wanted && playback === "playing"));
      button.setAttribute("aria-label", label);
      button.title = wanted ? `${source?.name ?? NETEASE_NAME}：播放 ${wanted.song.title}` : source ? `${source.name}：${label}` : "请先连接播放器";
      continue;
    }
    const song = currentAlbum(), loaded = playerState?.currentTrack, waits = localSongWaits();
    const playing = !waits && !!playerState?.playing;
    const resume = !waits && playerState?.transport === "paused" ? "继续" : "播放";
    // Nothing loaded and nothing the selection could play (offline, a demonstration cover).
    button.disabled = !waits && !loaded && !(song?.tracks.length && !song.offline);
    button.setAttribute("aria-pressed", String(playing));
    button.setAttribute("aria-label", playing ? "暂停" : resume);
    button.title = waits ? `播放：${song!.title}` : loaded ? `${playing ? "暂停" : resume}：${loaded.title}` : "播放选中的歌";
  }
}
/**
 * The note beside the shelf's play ring: the number of the song (or album) that plays when the
 * selection is another one of its column (a dot in the playback colour), "正在切换…" while
 * NetEase has not yet reported the song asked for, "只供浏览" in a playlist column; nothing when
 * the selection is what plays or nothing plays.
 */
function syncPlayNote() {
  const note = $("#shelf-play-note");
  const cursor = navigationSelection(), key = records[cursor]?.id;
  let text = "", dot = false;
  if (playerCurrent) {
    const lane = netease.shownQueue() ? netease.laneAt(cursor) : undefined;
    if (!netease.shownQueue() || !key) text = "";
    else if (lane && !lane.live) text = "只供浏览";
    else if (netease.queueJump?.key === key) text = "正在切换…";
    else if (netease.queuePlaying && key !== netease.queuePlaying) {
      const playing = records.findIndex((record) => record.id === netease.queuePlaying);
      if (playing >= 0) {
        text = String(columnFiles(fileLocation(playing).lane).indexOf(playing) + 1).padStart(3, "0");
        dot = true;
      }
    }
  } else {
    // The loaded song's number in its playlist, while another song is selected.
    const loaded = playerState?.currentTrack && ["playing", "paused", "loading"].includes(playerState.transport)
      ? playerState.currentTrack.id : undefined;
    const playing = loaded && key !== loaded ? records.findIndex((record) => record.id === loaded) : -1;
    if (playing >= 0) {
      text = String(columnFiles(fileLocation(playing).lane).indexOf(playing) + 1).padStart(3, "0");
      dot = true;
    }
  }
  setText(note.lastElementChild as HTMLElement, text);
  if (note.dataset.dot !== String(dot)) note.dataset.dot = String(dot);
}
/** The case of the song that is loaded in the player (NetEase's, or the local player's), -1 if none. */
function playingRecord() {
  if (playerCurrent) return netease.queuePlaying ? records.findIndex((record) => record.id === netease.queuePlaying) : -1;
  const loaded = playerState?.currentTrack && ["playing", "paused", "loading"].includes(playerState.transport)
    ? playerState.currentTrack.id : undefined;
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
 * The play ring and the playback colour (--state, on the stage). A plain ring when a press
 * plays the selection, or when nothing is loaded; otherwise the playing song's progress from
 * 12 o'clock, all in the line colour while its position is unknown. --state is the playing or
 * the paused colour only when the player says so, else muted (never an invented state).
 */
function syncRing() {
  let ring: "plain" | "progress" | "unknown" = "plain", progress = 0;
  let playback: "playing" | "paused" | "unknown" = "unknown";
  // The details' ring: NetEase's own play / pause (always what plays, never the selection); a local
  // song's details play that song, so locally it is the header's ring.
  let own: "plain" | "progress" | "unknown" = "unknown";
  if (playerCurrent) {
    const source = externalMedia?.selected, state = mediaPlayback(source);
    playback = state === "playing" ? "playing" : state === "paused" || state === "stopped" ? "paused" : "unknown";
    if (source) {
      const { position, duration } = externalTimeline();
      const known = typeof position === "number" && typeof duration === "number" && duration > 0;
      own = known ? "progress" : "unknown";
      if (known) progress = position / duration;
      if (!netease.queueSongToPlay()) ring = own;
    }
  } else {
    const state = playerState, track = state?.currentTrack;
    // Loading the next song keeps the colour it had.
    playback = !track ? "unknown" : state!.transport === "playing" ? "playing" : state!.transport === "paused" ? "paused"
      : state!.transport === "loading" && stage.dataset.playback !== "unknown" ? stage.dataset.playback as "playing" | "paused" : "unknown";
    if (track && state!.duration > 0) progress = state!.currentTime / state!.duration;
    if (track && !localSongWaits()) ring = state!.duration > 0 ? "progress" : "unknown";
    own = ring;
  }
  if (stage.dataset.playback !== playback) stage.dataset.playback = playback;
  const value = `${Math.round(Math.max(0, Math.min(1, progress)) * 1000) / 10}%`;
  // The header's ring and the shelf's larger one.
  for (const button of document.querySelectorAll<HTMLElement>("#play-pause, #shelf-play")) {
    if (button.dataset.ring !== ring) button.dataset.ring = ring;
    if (button.style.getPropertyValue("--progress") !== value) button.style.setProperty("--progress", value);
  }
  const detail = document.querySelector<HTMLElement>("#detail-toggle");
  if (detail) {
    if (detail.dataset.ring !== own) detail.dataset.ring = own;
    if (detail.style.getPropertyValue("--progress") !== value) detail.style.setProperty("--progress", value);
  }
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
 * 本地音乐's song details: the ring plays this song, or pauses / resumes it once it is the one
 * loaded (the play button's own rule); what is loaded when it is another song (正在播放); and
 * this song's position while it is loaded (the slider seeks it; dashed while another song plays).
 */
let localSeekHeld = false;
function syncLocalTransport() {
  if (playerCurrent) return;
  const state = playerState, track = state?.currentTrack;
  const toggle = document.querySelector<HTMLButtonElement>("#detail-toggle");
  if (toggle) {
    const waits = localSongWaits();
    const playing = !waits && !!state?.playing;
    const label = waits || !track ? "播放这首" : playing ? "暂停" : state!.transport === "paused" ? "继续" : "播放";
    toggle.disabled = !waits && !track;
    toggle.setAttribute("aria-pressed", String(playing));
    toggle.setAttribute("aria-label", label);
    toggle.title = !waits && track ? `${label}：${track.title}` : label;
  }
  // 正在播放: placed when the document is rendered, while the loaded song is another one than
  // the one shown. It then keeps its place until the next document and names what is loaded, so
  // a song started here does not pull the controls up under the pointer.
  const shown = currentAlbum();
  const other = !!track && track.id !== shown?.id;
  for (const row of document.querySelectorAll<HTMLElement>("[data-local-now-row]")) {
    if (row.dataset.localNowRow) continue;
    row.dataset.localNowRow = "placed";
    row.hidden = !other;
  }
  for (const node of document.querySelectorAll<HTMLElement>("[data-local-now]")) setText(node, track?.title ?? "—");
  // The timeline is this song's: its position while it is the one loaded, else its length only.
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
 * 本地音乐's details ring: it plays this song when another one (or none) is loaded, and pauses
 * or resumes it once it is the one loaded, as the play button does.
 */
function toggleLocal() {
  if (!player) return;
  if (localSongWaits()) playSong();
  else if (playerState?.currentTrack) void player.toggle();
  else return;
  scene?.playGesture();
  if (records.length) tickMotion.ripple();
}
/**
 * A local song's details (2026-10-06: each case is a song of a folder playlist): the design's
 * document with its tag (the playlist's number and the song's place in it, previous / next), four
 * facts with Chinese keys (the song's album, year, format and length; the artist is the line
 * above them), what the player has loaded when it is another song, the transport row and the
 * timeline, which play this song, and its album's introduction when there is one.
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
  $("#detail-body").innerHTML = `<p class="detail-artist">${esc(a.artist)}${a.offline ? '<span class="detail-badge">目录离线</span>' : ""}</p>
    <dl class="detail-facts">${detailFact("专辑", esc(track?.album || "未提供"))}${detailFact("年份", esc(String(track?.year || "未提供")))}${detailFact("格式", demo ? "封面演示" : esc(songFormat(track)))}${detailFact("时长", demo || !track?.duration ? "—" : esc(time(track.duration)))}${detailFact("正在播放", "", ' data-local-now-row data-wide="true" hidden', " data-local-now")}</dl>
    <div class="detail-transport" role="group" aria-label="播放控制"><button data-action="previous-track" class="detail-control" aria-label="上一曲" title="上一曲" disabled>${skipGlyph("prev")}</button>${detailDivider}<button data-action="local-toggle" id="detail-toggle" class="detail-control detail-toggle" aria-label="播放这首" aria-pressed="false" data-ring="plain">${detailRing}</button>${detailDivider}<button data-action="next-track" class="detail-control" aria-label="下一曲" title="下一曲" disabled>${skipGlyph("next")}</button></div>${detailTimeline("local-seek", "播放位置", "local")}${songAbout(song)}`;
  article.scrollTop = scroll;
  documentDecryption.reset(
    article,
    preferences.reduced || scene?.decryptionFrame.phase === "clear",
  );
  syncRing();
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
  if (externalSeekPointer === undefined && !externalSeekKeys.size) void netease.sendSeeks();
}
function updateExternalControls() {
  if (!externalMedia) return;
  const source = externalMedia.selected;
  // ... and the header's now-playing slot with it.
  updateStatus();
  syncPlayButton();
  // The details page's controls work NetEase as it is: their play / pause (a ring with a
  // triangle or two bars, the words in its name) says what plays.
  const playback = mediaPlayback(source);
  const toggleLabel = playback === "playing" ? "暂停" : playback === "unknown" ? "播放 / 暂停（状态未知）" : "播放";
  document.querySelectorAll<HTMLButtonElement>("[data-media-action]").forEach(button => {
    button.disabled = !externalMedia.offers(button.dataset.mediaAction as MediaAction);
    if (button.dataset.mediaAction !== "toggle") return;
    if (button.getAttribute("aria-label") !== toggleLabel) button.setAttribute("aria-label", toggleLabel);
    const title = source ? `${source.name}：${toggleLabel}` : toggleLabel;
    if (button.title !== title) button.title = title;
    button.setAttribute("aria-pressed", String(playback === "playing"));
  });
  const shown = source && { ...source, playback: playback ?? source.playback };
  document.querySelectorAll<HTMLElement>("[data-media-playback]").forEach(node => { node.textContent = mediaPlaybackLabel(shown); });
  document.querySelectorAll<HTMLElement>("[data-media-album]").forEach(node => { node.textContent = source?.album || "未提供"; });
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
    const queueKey = JSON.stringify([source?.id, isNeteaseSource(source), preferences.neteaseQueue, preferences.playlistColumns, restarting]);
    if (queueSetting && queueKey !== queueSettingVisual) {
      queueSettingVisual = queueKey;
      debugSettingVisual = "";
      // NetEase's source disappears while it restarts; keep saying what is happening.
      // The switch that was just operated is rebuilt with the rest: give it its focus back.
      const focused = queueSetting.contains(document.activeElement) ? (document.activeElement as HTMLElement).id : "";
      queueSetting.innerHTML = restarting
        ? '<p class="external-note" role="status">正在以调试端口重新启动网易云…</p>'
        : queueSettingMarkup(source, preferences.neteaseQueue, netease.queueStatus, control,
            { enabled: preferences.playlistColumns, status: netease.playlistStatus });
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
  const key = records[selected]?.id;
  const playing = !!netease.queuePlaying && key === netease.queuePlaying;
  // The details' 网易云当前曲目: placed when the document is rendered, while the selection is not
  // NetEase's song ('正在切换…' while NetEase has not yet reported the song asked for). It then
  // keeps its place until the next document and names NetEase's song, so the controls below it
  // do not jump up under the pointer when NetEase arrives at the selection.
  for (const row of document.querySelectorAll<HTMLElement>("[data-now-row]")) {
    if (row.dataset.nowRow) continue;
    row.dataset.nowRow = "placed";
    row.hidden = playing;
  }
  document.querySelectorAll<HTMLElement>("[data-media-now]").forEach((node) => {
    setText(node, netease.queueJump?.key === key && !!key ? "正在切换…" : externalMedia?.selected?.title || "未提供");
  });
  // ... and under the timeline, what the controls cannot do here (nothing when the port plays the selection).
  const limit = netease.shownQueue() ? netease.queueControlLimit() : externalMedia?.selected ? LONE_TRACK_NOTE : "";
  document.querySelectorAll<HTMLElement>("[data-detail-limit]").forEach((node) => setText(node, limit));
  if (menu === "song") {
    // The switch and the port change under an open song scene; its rows are not re-rendered for that.
    if (netease.shownQueue()) setText($("#song-note"), netease.songQueueNote());
    syncSongRows();
  }
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
  $("#music-keyhint").innerHTML = keyHintMarkup(queue);
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
// until NetEase's state changes (at most 1.5 s) instead of a second later.
const CONFIRM_STEP_MS = 150, CONFIRM_MS = 1500;
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
    const delay = externalRefreshAgain ? 0 : confirmUntil ? CONFIRM_STEP_MS : document.hidden ? 2000 : 1000;
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
 * The details' document (Claude Design, 2026-10-05, direction A): a tag row (the case's tag and
 * count, previous / next), the title (its own reel, #detail-title), the artist, the facts, a
 * transport row (previous | play ring | next | stop, 48 high, divided by 1 px lines) and the
 * 播放位置 timeline; under it, only when there is something to say, a muted line of what the
 * controls cannot do and the player's warnings.
 */
const pad3 = (n: number) => String(n).padStart(3, "0");
function detailHead(tag: string, count: string, steps?: { group: string; previous: string; next: string }, after = "") {
  const step = (action: "prev" | "next", label: string) =>
    `<button data-action="${action}" class="detail-step" aria-label="${label}" title="${label}"><i class="chevron chevron-${action === "prev" ? "up" : "down"}" aria-hidden="true"></i></button>`;
  return `<div class="detail-tag-row"><span class="detail-tag-group"><span class="selection-tag detail-tag">${esc(tag)}</span>${count ? `<span class="detail-tag-of">${count}</span>` : ""}${after}</span>${steps ? `<span class="detail-steps" role="group" aria-label="${steps.group}">${step("prev", steps.previous)}${step("next", steps.next)}</span>` : ""}</div>`;
}
const detailFact = (key: string, value: string, row = "", data = "") =>
  `<div class="detail-fact"${row}><dt>${key}</dt><dd${data}>${value}</dd></div>`;
const detailDivider = '<i class="detail-divider" aria-hidden="true"></i>';
const detailRing = '<span class="detail-ring" aria-hidden="true"><span class="transport-glyph transport-play"></span><span class="transport-glyph transport-pause"><i></i><i></i></span></span>';
function detailTimeline(id: string, name: string, data: "media" | "local") {
  return `<label class="detail-timeline" for="${id}"><span class="detail-timeline-head"><span${data === "media" ? " data-media-timeline-label" : ""}>播放位置</span><output for="${id}"><span data-${data}-position>—</span> / <span data-${data}-duration>—</span></output></span><input type="range" id="${id}" class="detail-seek" min="0" max="1" step="1" value="0" disabled aria-label="${name}" data-known="false"></label>`;
}
// NetEase's (or another player's) own controls: they act on what plays, whatever is selected.
const externalControls = `<div class="detail-transport" role="group" aria-label="外部播放器控制"><button data-media-action="previous" class="detail-control" aria-label="上一曲" title="上一曲">${skipGlyph("prev")}</button>${detailDivider}<button data-media-action="toggle" id="detail-toggle" class="detail-control detail-toggle" aria-label="播放" title="播放" aria-pressed="false" data-ring="unknown">${detailRing}</button>${detailDivider}<button data-media-action="next" class="detail-control" aria-label="下一曲" title="下一曲">${skipGlyph("next")}</button>${detailDivider}<button data-media-action="stop" class="detail-control detail-stop" aria-label="停止" title="停止"><i aria-hidden="true"></i></button></div>${detailTimeline("external-seek", "外部播放器播放位置", "media")}`;
const detailNote = '<p class="detail-limit" data-detail-limit></p><p class="detail-warning" data-media-warning role="status"></p>';
// A lone live track (no queue): what the page is and is not.
const LONE_TRACK_NOTE = "只显示当前曲目，不代表完整专辑或播放队列。音量与音效由原播放器控制；灰色按钮表示该来源当前未提供相应能力。";
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
  // The design's facts: the song's album and its column's song count; NetEase's own song, full
  // width, while the selection is another one (updateQueueRows keeps it current).
  $("#detail-body").innerHTML = `<p class="detail-artist">${esc(a.artist)}</p><dl class="detail-facts">${detailFact("专辑", esc(song?.album || "未提供"))}${detailFact("曲目数", `${files.length} 首`)}${detailFact("网易云当前曲目", "", ' data-now-row data-wide="true" hidden', " data-media-now")}</dl>${externalControls}${detailNote}`;
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
  $("#detail-body").innerHTML = `<p class="detail-artist">${esc(source.artist || "歌手未提供")}</p><dl class="detail-facts">${detailFact("专辑", esc(source.album || "未提供"), "", " data-media-album")}${detailFact("播放状态", "", "", " data-media-playback")}</dl>${externalControls}${detailNote}`;
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
    settings: ["SYSTEM SETTINGS", "播放与画质"],
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
function renderSettingsPanel() {
  $("#panel-body").innerHTML =
    `<section class="panel-section"><h3>外观主题</h3><div class="theme-cards">${(["day", "night"] as Theme[]).map((t) => `<button data-theme="${t}" aria-pressed="${preferences.theme === t}" class="${t}"><i></i><strong>${themeNames[t]}</strong><span>${t === "day" ? "暖白玻璃与日光" : "极简星空与透光白卡"}</span></button>`).join("")}</div></section>
    <section class="panel-section" id="introduction-settings"><h3>专辑介绍</h3><p>从公开百科查询并更新专辑介绍，附上资料来源。介绍保存在本机，不需要配置 MusicBrainz 联系信息；音乐文件不会上传。</p><p id="introduction-coverage"></p><button class="primary-button" id="introduction-refresh" data-action="introductions-library">查询 / 更新专辑介绍 ↗</button><progress id="introduction-progress" aria-label="专辑介绍查询进度" max="1" value="0" hidden></progress><p id="introduction-status" class="scan-status" role="status" aria-live="polite"></p><details id="introduction-missing" hidden><summary></summary><ul></ul></details></section>
    ${qualityMarkup(renderQuality)}
    <section class="panel-section"><h3>动效与显示</h3><label class="settings-row"><span>减少动态效果<small>简化镜头、文字加载和页签过渡</small></span><input type="checkbox" id="reduced-motion" ${preferences.reduced ? "checked" : ""}></label><label class="settings-row"><span>开场动画<small>启动时约 4 秒的专辑架进场，下次启动时生效</small></span><input type="checkbox" id="intro-setting" ${preferences.intro ? "checked" : ""}></label><button class="text-button" data-action="fullscreen">切换全屏 ↗</button></section>
    <section class="panel-section"><h3>声音</h3><label class="settings-row"><span>歌曲音量</span><input type="range" id="volume" aria-label="歌曲音量" min="0" max="100" value="${Math.round(preferences.volume * 100)}"></label><label class="settings-row"><span>切歌淡入淡出<small>当前歌曲先淡出，再淡入下一首</small></span><input type="checkbox" id="song-fade-setting" ${preferences.songFade ? "checked" : ""}></label><label class="settings-row"><span>界面音效<small>玻璃卡片与终端操作</small></span><input type="checkbox" id="sound-setting" ${preferences.sound ? "checked" : ""}></label><label class="settings-row"><span>音效音量</span><input type="range" id="sound-volume" aria-label="音效音量" min="0" max="100" value="${Math.round(preferences.soundVolume * 100)}"></label><label class="settings-row"><span>氛围 BGM<small>专辑开始前淡出，播完后淡入</small></span><input type="checkbox" id="bgm-setting" ${preferences.bgm ? "checked" : ""}></label><label class="settings-row"><span>BGM 音量</span><input type="range" id="bgm-volume" aria-label="BGM 音量" min="0" max="100" value="${Math.round(preferences.bgmVolume * 100)}"></label><button class="text-button" data-action="sound-preview">试听界面音效 ↗</button><p>当前版本支持 Windows 和 macOS，使用浏览器播放本地音乐。DSF / DFF 暂不支持播放，其他格式取决于浏览器解码能力。</p></section>
    <section class="panel-section"><h3>开发与资源</h3><p>音乐适配与维护：<a href="https://github.com/RonaldDeng/Rhine-Music-Demo" target="_blank" rel="noopener">RonaldDeng ↗</a><br>原版界面：<a href="https://github.com/LBEILC/RhineLabUI" target="_blank" rel="noopener">LBEILC / RhineLabUI ↗</a></p><p><a href="/licenses/project-mit.txt" target="_blank" rel="noopener">代码 MIT 许可 ↗</a> · <a href="https://github.com/RonaldDeng/Rhine-Music-Demo/blob/v0.2.0/NOTICE.md" target="_blank" rel="noopener">版权与资源说明 ↗</a></p><a href="/?original=1&scene=archive" target="_blank" rel="noopener">打开原版档案界面 ↗</a><p><a href="/fonts/MiSans-license.pdf" target="_blank" rel="noopener">MiSans 字体许可 ↗</a></p></section>`;
  if (playerCurrent) {
    $("#introduction-settings").remove();
    $("#volume").closest(".panel-section")?.remove();
    $("#panel-body").insertAdjacentHTML("afterbegin", '<p class="panel-intro">当前来源是外部播放器，这里只调整此窗口的外观。歌曲音量、淡入淡出与曲库管理请在原播放器中设置；连接播放器时，此窗口不播放本地音乐或 BGM。</p>');
  }
  updateQuality();
  updateIntroductionStatus();
}
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
/** 本地音乐: play the selected song; the player then continues through its playlist. */
function playSong() {
  const a = currentAlbum(), song = localSong();
  if (playerCurrent || !song || !a?.tracks.length || a.offline) return;
  void player?.play(song.id, playlistQueue(localShelf, song));
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
  if (target.dataset.select) {
    const index = Number(target.dataset.select);
    const rulerStep = Number(target.dataset.rulerStep);
    netease.queueFollowPaused = true;
    select(index,
      target.dataset.rulerStep !== undefined && Number.isInteger(rulerStep)
        ? { axis: "row", direction: rulerStep }
        // A playlist row: the chain of covers runs to it the shorter way round.
        : target.closest("#music-song") ? rowNavigation(navigationSelection(), index) : undefined);
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
    case "open":
      setMode("detail");
      break;
    case "songs":
      toggleSongs();
      break;
    case "details":
      showDetails();
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
    case "play-pause":
      togglePlayback();
      break;
    // 本地音乐's details: the local player's own play / pause.
    case "local-toggle":
      toggleLocal();
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
  if (externalMedia && el.id === "netease-control") {
    preferences.neteaseControl = el.checked;
    savePrefs();
    netease.controlSwitched(el.checked);
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
  // In the open menu the arrows move along its items, not the shelf; the scene's keys close it.
  if (stage.dataset.chromeMenu === "open") {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = [...$("#topnav-modes").querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const at = items.indexOf(document.activeElement as HTMLButtonElement), step = e.key === "ArrowDown" ? 1 : -1;
      items[at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length]?.focus();
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.code === "KeyS") setChromeMenu(false);
  }
  if (e.key === "Escape") {
    panel ? closePanel() : leaveMenu();
    return;
  }
  if (panel) {
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
  if (
    (e.target as HTMLElement).matches(
      "input, textarea, select, [contenteditable=true]",
    )
  )
    return;
  if (e.key === "/") {
    e.preventDefault();
    searchGenre = "";
    openPanel("search");
  }
  if (e.code === "KeyS" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
    e.preventDefault();
    toggleSongs();
    return;
  }
  // Inside the playlist the arrows move along its rows; elsewhere they move the shelf.
  if (menu === "song" && songView.handleKey(e)) return;
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    stepGenre(-1);
  }
  if (e.key === "ArrowRight") {
    e.preventDefault();
    stepGenre(1);
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    stepAlbum(-1);
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    stepAlbum(1);
  }
  if (e.key === "Enter" && !(e.target as HTMLElement).closest("button, a")) {
    e.preventDefault();
    showDetails();
  }
  // Space stays play / pause on a playlist row too; Enter is what activates the row.
  if (e.code === "Space" && (!(e.target as HTMLElement).closest("button, a") || (e.target as HTMLElement).closest("#song-list"))) {
    e.preventDefault();
    togglePlayback();
  }
});
// A button is clicked when Space is released: keep that from playing the focused row.
document.addEventListener("keyup", (e) => {
  if (e.code === "Space" && (e.target as HTMLElement).closest?.("#song-list")) e.preventDefault();
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
  frameTimer = 0;
function requestFrame() {
  window.clearTimeout(frameTimer);
  frameTimer = 0;
  if (!frameRequest) frameRequest = requestAnimationFrame(frame);
}
function frame(ms: number) {
  frameRequest = 0;
  if (!document.hidden && scene) {
    drainWheel();
    const opening = boot?.update(ms / 1000);
    if (!viewer?.isOpen) scene.update(ms / 1000, opening?.cinema);
    syncBracket();
    syncSongHop();
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
  // ~60 Hz slot instead of running every display frame (FramePacing).
  const quiet = scene && !document.hidden && !boot?.active && !viewer?.isOpen &&
    !pendingDetailFocus && !pendingSongFocus && !pendingSearchTrack && !wheelNavigation.active && (presentation.phase === "archive" ||
      (presentation.phase === "detail" && !documentDecryption.active));
  const wait = quiet ? scene!.nextFrameAt() * 1000 - performance.now() : 0;
  if (wait > 1) frameTimer = window.setTimeout(requestFrame, wait);
  else frameRequest = requestAnimationFrame(frame);
}
async function start() {
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
      playerCurrent ? "三维卡片，显示所选外部播放器的当前曲目" : "三维歌曲阵列，左右切歌单，上下切歌",
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
      // The selected case opens its details: on the shelf and as the song scene's large card.
      if (lifted && (presentation.phase === "archive" || songScene)) return showDetails();
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
    }
    syncSelectionMotion();
    requestAnimationFrame((ms) => {
      stage.classList.add("theme-motion-ready");
      scene!.onWake = requestFrame;
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
