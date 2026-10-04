import "@kitlangton/rolling-number/styles.css";
import { chooseMusicFolders, flushDesktopPreferences, isDesktop, saveDesktopPreferences } from "./desktop";
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
import "./song-scene.css";
import {
  nativeQueuePort, nativeDebugPort, nativePlaylistPort, queueLibrary, queueLanes, laneLibrary, laneGenre, laneTrackKey,
  playingQueueTrack, queueTrackKey, queueSettingMarkup, playlistSummary,
  queueControlStatus, isNeteaseSource, PlaybackClock, type QueueTrack, type QueueSource, type QueueLane, type NeteasePlaylist, type DebugState,
} from "./external-queue";
import { type LaneName } from "./lane-labels";
import { installWindowFrame } from "./window-frame";
import { WheelNavigation, WHEEL_PIXELS_PER_ROW } from "./wheel-navigation";
import {
  ExternalMediaConnection, nativeMediaPort, mediaLibrary, mediaVisualKey,
  mediaConnectionLabel, mediaPlaybackLabel, mediaTime, mediaSourcesMarkup,
  mediaPermissionMarkup, type MediaAction,
} from "./external-media";
import { DocumentDecryption } from "./document-decryption";
import { ContentTransition, SurfaceTransition } from "./ui-transitions";
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
import { MusicPlayer, type MusicPlayerState } from "./music-player";
import { ModelViewer } from "./model-viewer";
import { TerminalAudio } from "./audio";
import type {
  MusicAlbum,
  MusicGenre,
  MusicLibrary,
  GenreRules,
} from "./music-types";
import { demoAlbums, demoGenres } from "./demo-library";
import { escapeHtml as esc } from "./html";
import { albumTitleMarkup, setupMusicTitleLayout } from "./music-title";
import { setupMusicTextMotion } from "./music-text-motion";
import { setupTransportTitle } from "./music-transport-title";
import { setupMusicTicks } from "./music-ticks";
import { setupMusicRuler } from "./music-ruler";
import { MusicPresentation, type AlbumSelection } from "./music-presentation";
import { MusicTrackFocus } from "./music-track-focus";
import { MusicBoot } from "./music-boot";
import { songCardRect, viewportLayout } from "./viewport-layout";
import { SongListView, albumSongModel, queueSongModel, songSceneMarkup } from "./song-list";
import { SONG_VIEW } from "./song-pose";
import { MUSIC_MODEL } from "./music-model";

type Theme = "day" | "night";
type Panel = "library" | "search" | "settings" | "sources" | null;
const externalMode = new URLSearchParams(location.search).get("mode") === "external";
// Windows may only know NetEase as "cloudmusic.exe".
const NETEASE_NAME = "网易云音乐";
// NetEase is the default link: connected when it is found, until the user chooses otherwise.
const externalMedia = externalMode
  ? new ExternalMediaConnection(nativeMediaPort, { name: NETEASE_NAME, match: isNeteaseSource })
  : undefined;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const svg = (path: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const icons = {
  play: svg('<path d="m9 5 11 7-11 7Z" fill="currentColor" stroke="none"/>'),
  pause: svg('<path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor" stroke="none"/>'),
  search: svg(
    '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  ),
  settings: svg(
    '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.5" fill="var(--surface)"/><circle cx="15" cy="17" r="2.5" fill="var(--surface)"/>',
  ),
  folder: svg('<path d="M3 7V5h6l2 2h10v13H3Z"/>'),
};
const read = <T>(key: string, fallback: T): T => {
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
    volume: 0.65,
    songFade: true,
    bgm: true,
    bgmVolume: 0.18,
    sound: true,
    soundVolume: 0.22,
    renderQuality: undefined as RenderQuality | undefined,
    // Player-skin mode: show NetEase's saved play queue. Off until the user switches it on.
    neteaseQueue: false,
    // Selecting a queue song makes NetEase play it; only acts while its debugging port answers.
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
// Keys of earlier builds, saved with every other preference: the playlist-name styles (gone),
// and playlist columns when they were off by default (now under playlistColumns, so that the
// old default does not outlive the new one).
for (const key of ["laneLabels", "laneNameStyle", "neteasePlaylists"]) delete (preferences as Record<string, unknown>)[key];
if (!["genre", "artist", "album"].includes(preferences.sortMode))
  preferences.sortMode = "genre";
const sortLabels: Record<MusicSortMode, { name: string; column: string; code: string }> = {
  genre: { name: "按流派", column: "流派", code: "GENRE" },
  artist: { name: "按歌手名字", column: "歌手", code: "ARTIST" },
  album: { name: "按专辑名字", column: "分组", code: "ALBUMS" },
};
const sortLabel = sortLabels[preferences.sortMode];
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
let mode: "archive" | "detail" = "archive",
  activeTab: "tracks" | "about" = "tracks",
  panel: Panel = null;
// An opened album shows its detail page or the song scene (a large card, the row as a
// chain of covers, the playlist as text); the scene remembers where it was opened from.
let menu: "detail" | "song" = "detail",
  songOrigin: "archive" | "detail" = "archive",
  menuSwapping = false,
  songStay = false,
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
  sound: !externalMode && preferences.sound,
  music: false,
  soundVolume: preferences.soundVolume,
  musicVolume: 0,
});
if (!externalMode) document.addEventListener("pointerdown", () => void effects.unlock(), {
  once: true,
});
if (!externalMode) document.addEventListener("keydown", () => void effects.unlock(), {
  once: true,
});
let toastTimer: ReturnType<typeof setTimeout>,
  pollTimer: ReturnType<typeof setTimeout> | undefined;
// The case each column was left on, by column: names can repeat (two playlists of one name).
let columnMemory = new Map<number, string>();
let playerState: MusicPlayerState | undefined;
// Connection mode never creates an Audio element or a local playback queue.
const player = externalMode ? undefined : new MusicPlayer({
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
stage.dataset.external = String(externalMode);
stage.dataset.menu = menu;
stage.innerHTML = `
  <div id="three-scene" class="three-scene"></div>
  <div class="music-vignette" aria-hidden="true"></div>
  <header class="music-header">
    <div class="music-identity"><a class="music-brand" href="/" aria-label="Rhine Music 音乐库"><strong>RHINE LAB</strong><span>${externalMode ? "MUSIC CONNECTION <i>／</i> 外部播放器" : "MUSIC ARCHIVE <i>／</i> 私人音乐终端"}</span></a></div>
    <nav class="music-topnav" aria-label="音乐终端导航">
      ${externalMode ? '<button data-action="sources" class="external-connect" aria-label="选择外部播放器">↗<span>播放器</span></button><button data-action="local-mode" class="external-connect" aria-label="返回本地音乐库">←<span>本地音乐</span></button>' : `<button data-action="library" aria-label="音乐库">${icons.folder}<span>音乐库</span></button><button data-action="search" aria-label="搜索">${icons.search}<span>搜索</span></button>${isDesktop ? '<button data-action="external-mode" class="external-connect" aria-label="连接外部播放器">↗<span>连接播放器</span></button>' : ""}`}
      <div class="theme-switch" aria-label="主题">${(["day", "night"] as Theme[]).map((t) => `<button data-theme="${t}" aria-label="${themeNames[t]}主题" aria-pressed="${preferences.theme === t}"><i class="theme-dot ${t}"></i><span>${themeNames[t]}</span></button>`).join("")}</div>
      <button data-action="settings" class="icon-button" aria-label="播放与画质设置">${icons.settings}</button>
      <div class="minimal-transport" role="group" aria-label="音乐播放"><span id="transport-track" class="transport-track" aria-hidden="true"><span id="transport-track-label"></span></span>${externalMode ? '<button data-media-action="previous" class="external-header-prev" aria-label="外部播放器上一曲" disabled>‹</button>' : ""}<button data-action="play-pause" id="play-pause" aria-label="播放" aria-pressed="false"><span class="transport-glyph transport-play" aria-hidden="true">${icons.play}</span><span class="transport-glyph transport-pause" aria-hidden="true">${icons.pause}</span></button>${externalMode ? '<button data-media-action="next" class="external-header-next" aria-label="外部播放器下一曲" disabled>›</button>' : ""}</div>
    </nav>
  </header>
  <div id="library-status" class="library-status"><i></i><span>${externalMode ? "正在发现外部播放器" : "正在读取本地音乐索引"}</span></div>
  <section id="music-browse" class="music-browse" aria-label="专辑浏览">
    <div class="music-browse-veil" aria-hidden="true"></div>
    <div class="album-callout"><p class="music-eyebrow">MUSIC ARCHIVE <span>／</span> <span id="selection-genre"></span></p>
      <div class="selection-rule"><span id="selection-code"><span id="selection-code-label">${externalMode ? "LIVE TRACK" : "ALBUM"}</span> <span id="selection-code-number" ${externalMode ? "hidden" : ""}>001</span></span><span id="selection-format"></span></div>
      <h1 id="selection-title"></h1><p id="selection-artist" class="selection-artist"></p>
      <div class="selection-meta" id="selection-meta"></div>
      <button class="open-album" data-action="open"><span id="open-album-label">${externalMode ? "当前曲目与控制" : "打开专辑"}</span> <span>↗</span></button>
      <button class="open-songs" data-action="songs"><span id="open-songs-label">${externalMode ? "播放队列" : "选歌"}</span> <kbd>S</kbd></button>
    </div>
    <div class="music-navigation">
      <div class="music-counter"><span class="music-eyebrow" id="selection-counter-label">ALBUM / SELECT</span><div><b id="selection-number">01</b><span>/ <i id="selection-total">00</i></span></div></div>
      <div class="album-stepper"><button data-action="prev" aria-label="上一个专辑">↑</button><div id="album-ticks"></div><button data-action="next" aria-label="下一个专辑">↓</button></div>
      <div class="genre-stepper"><button data-action="genre-prev" aria-label="上一个${sortLabel.column}">←</button><div><small id="genre-position"><span id="genre-code">${sortLabel.code}</span> <span id="genre-index">01</span> / <span id="genre-total">00</span></small><button data-action="genres" id="genre-name"></button></div><button data-action="genre-next" aria-label="下一个${sortLabel.column}">→</button></div>
    </div>
    <div class="music-keyhint" id="music-keyhint">${externalMode ? "SPACE 播放 / 暂停 <span>／</span> ENTER 当前曲目" : `← → ${sortLabel.column} <span>／</span> ↑ ↓ 专辑 <span>／</span> ENTER 打开专辑 <span>／</span> S 选歌`}</div>
  </section>
  <section id="music-detail" class="music-detail" aria-label="专辑详情" hidden>
    <button class="music-back" data-action="back">← 返回专辑架 <kbd>ESC</kbd></button>
    <div class="card-caption"><span id="detail-card-id"></span><small>拖动卡片，查看完整封面</small><button data-action="songs"><span id="detail-songs-label">${externalMode ? "播放队列" : "选歌"}</span> <kbd>S</kbd></button></div>
    <article id="album-detail-content" tabindex="-1"></article>
  </section>
  <section id="music-song" class="music-song" aria-label="歌曲选择" hidden>${songSceneMarkup()}</section>
  <div id="music-empty" class="music-empty" hidden>${externalMode ? '<small>YOUR PLAYER / THIS WINDOW</small><h1>让正在听的歌进入档案馆。</h1><p id="external-empty-note">选择一个外部播放器，显示它的当前曲目与封面。这里只提供连接和控制，不导入曲库，也不播放本地音频。</p><button data-action="sources">选择播放器 ↗</button><button data-action="local-mode" class="subtle">返回本地音乐</button>' : '<small>YOUR PRIVATE COLLECTION</small><h1>让音乐进入这座档案馆。</h1><p>选择本地音乐文件夹，专辑封面会出现在每一张卡片上。</p><button data-action="library">设置音乐文件夹 ↗</button><button data-action="demo" class="subtle">先查看演示封面</button>'}</div>
  <div class="music-bottomline"><span>${externalMode ? "EXTERNAL PLAYER" : "LOCAL COLLECTION"} <i>·</i> <span id="library-count">${externalMode ? "NOT CONNECTED" : "0 ALBUMS"}</span></span><span id="runtime-info">THREE.JS / ${externalMode ? "EXTERNAL" : "LOCAL"}</span></div>
  <div id="music-panel-root"></div><div id="music-toast" role="status" aria-live="polite"></div>
  <div id="music-loading"><span class="loading-orbit"></span><strong>OPENING THE ARCHIVE</strong><small>正在载入三维专辑架</small></div>
`;
installWindowFrame(stage);
const titleMotion = setupMusicTitleLayout(stage);
const textMotion = setupMusicTextMotion(stage);
if (externalMode) {
  $<HTMLButtonElement>("#play-pause").disabled = true;
}
// Keep the previous navigation available while the ruler version is on trial.
const tickMotion = new URLSearchParams(location.search).get("nav") === "previous"
  ? setupMusicTicks($("#album-ticks"))
  : setupMusicRuler($("#album-ticks"));
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
function formatList(a: MusicAlbum) {
  return (
    [
      ...new Set(
        a.tracks.map((t) => (t.codec ? `${t.format} / ${t.codec}` : t.format)),
      ),
    ].join(" · ") || (demo ? "封面演示" : "未提供")
  );
}
function albumDuration(a: MusicAlbum) {
  return a.tracks.reduce((sum, t) => sum + t.duration, 0);
}
function valueRange(
  values: (number | undefined)[],
  format: (n: number) => string,
) {
  const n = [
    ...new Set(values.filter((v): v is number => !!v && Number.isFinite(v))),
  ].sort((a, b) => a - b);
  return n.length
    ? n.length === 1
      ? format(n[0])
      : `${format(n[0])}–${format(n[n.length - 1])}`
    : "未提供";
}
function cover(a: MusicAlbum, className = "") {
  return a.coverUrl
    ? `<img class="${className}" src="${esc(a.coverUrl)}" alt="${esc(a.title)}专辑封面" loading="lazy">`
    : `<span class="cover-placeholder">♪</span>`;
}
const documentDecryption = new DocumentDecryption(
  "h1, .detail-artist, .album-facts span, .track-name strong, .album-about p",
  0.35,
);
const tabTransition = new ContentTransition();
const detailTransition = new SurfaceTransition(
  $("#music-detail"),
  $("#album-detail-content"),
  360,
  240,
  "right",
);
const songView = new SongListView($("#music-song"));
// The panel fades in place; the section itself is never faded (see song-scene.css).
const songTransition = new SurfaceTransition($("#music-song"), undefined, 450, 240, "right", undefined, songView.fadeTargets);
const browseTransition = new SurfaceTransition(
  $("#music-browse"),
  undefined,
  // Keep the existing reveal timing, but fade each overlay in its own layer.
  // Fading the parent traps its text below the night vignette until opacity=1.
  720,
  140,
  "up",
  "cubic-bezier(0.45, 0, 0.25, 1)",
  [$(".music-browse-veil"), $(".album-callout"), $(".music-navigation"), $(".music-keyhint")],
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
    activeTab = "tracks";
    detailTransition.hide(true);
    renderDetail();
    const content = $("#album-detail-content");
    content.style.removeProperty("opacity");
    content.style.removeProperty("transform");
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
    detailTransition.show(preferences.reduced);
    detail.inert = !!panel;
    detail.setAttribute("aria-hidden", "false");
    content.inert = false;
    content.scrollTop = 0;
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
function changePlayerMode(external: boolean) {
  player?.stop();
  player?.dispose();
  const url = new URL(location.href);
  if (external) url.searchParams.set("mode", "external");
  else url.searchParams.delete("mode");
  void flushDesktopPreferences().then(() => location.assign(url.href)).catch(error => notify(String(error)));
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
    ?.setAttribute("content", theme === "night" ? "#0a1220" : "#e8e5e1");
  savePrefs();
}
function fit() {
  // Use the same stage dimensions and aspect boundary as the scene framing.
  stage.dataset.layout = viewportLayout(stage.clientWidth, stage.clientHeight, false).kind;
  scene?.resize();
  viewer?.resize();
  syncSongCard();
  if (mode === "detail") {
    syncTabIndicator(false);
    documentDecryption.refresh();
  }
}
window.addEventListener("resize", fit);

async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(
    url,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json().catch(() => null);
  if (!response.ok || !data)
    throw new Error(data?.error || `本地服务请求失败 (${response.status})`);
  return data as T;
}
async function loadLibrary(force = false) {
  if (externalMode) return;
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
    const next = await request<MusicLibrary>("/api/library");
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
    JSON.stringify(next.genres) !== JSON.stringify(library.genres);
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
async function applyLibrary() {
  const hadAlbums = albums.length > 0;
  const previousId = currentAlbum()?.id;
  const previousDetail = JSON.stringify(currentAlbum());
  const visualKey = (items: MusicAlbum[], groups: MusicGenre[]) =>
    JSON.stringify([
      items.map((a) => [a.id, a.title, a.artist, a.genreId, a.coverUrl]),
      groups.map((g) => [g.id, g.name]),
    ]);
  const oldVisual = visualKey(albums, genres);
  if (library.albums.length) demo = false;
  const displaySort = externalMode ? "genre" : preferences.sortMode;
  albums = orderMusicAlbums(demo ? demoAlbums : library.albums, displaySort);
  genres = demo ? demoGenres : library.genres;
  setMusicAlbums(albums, genres, displaySort);
  syncLaneLabels();
  selected = Math.max(
    0,
    records.findIndex((r) => r.id === previousId),
  );
  if (externalMode && records.length && records[selected]?.id !== previousId) {
    // The box the user rested on is gone: it left NetEase's queue, or its column became or
    // stopped being the queue (the queue's cases have keys of their own). Nothing to play:
    // follow NetEase again from the song it plays now, whichever column that is. Asked of
    // the new queue (queuePlaying is still the last poll's), and never left in a column that
    // is only for browsing, where following stops.
    forgetQueueJumps();
    queueFollowPaused = false;
    const queue = shownQueue();
    const key = queue ? queueTrackKey(playingQueueTrack(queue.tracks, externalMedia?.selected, debugState)) : "";
    const playing = key ? records.findIndex((record) => record.id === key) : -1;
    const liveColumn = archiveColumns.findIndex((_, column) => laneAt(columnFiles(column)[0])?.live);
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
  if (mode === "detail" && previousDetail !== JSON.stringify(currentAlbum()))
    menu === "song" ? renderSongs() : renderDetail();
  updateStatus();
}
function updateStatus() {
  if (externalMedia) {
    $("#library-status span").textContent = mediaConnectionLabel(externalMedia);
    $("#library-status").classList.remove("working");
    // Only while the default link is in force: after a disconnect, or once another player
    // was selected, NetEase is not connected by itself.
    setText($("#external-empty-note"), `${externalMedia.followsPreferred
      ? `${NETEASE_NAME}在运行时会自动连接，也可以选择其他播放器`
      : "选择一个外部播放器"}，显示它的当前曲目与封面。这里只提供连接和控制，不导入曲库，也不播放本地音频。`);
    const queue = shownQueue();
    $("#library-count").textContent = queue
      ? queueLanesShown.length ? `NETEASE / ${queueLanesShown.length} PLAYLISTS / ${albums.length} SONGS` : `NETEASE QUEUE / ${albums.length} TRACKS`
      : externalMedia.selected ? "CURRENT TRACK ONLY" : "NOT CONNECTED";
    return;
  }
  const n = library.albums.length,
    tracks = library.albums.reduce((sum, a) => sum + a.tracks.length, 0);
  const label = !apiAvailable
    ? "本地音乐服务尚未连接"
    : library.scan.running
      ? "正在扫描音乐库…"
      : library.enrich?.running
        ? `补充在线资料 ${library.enrich.completed}/${library.enrich.total}`
        : library.introductions?.running
          ? `查询专辑介绍 ${library.introductions.completed}/${library.introductions.total}`
          : demo
            ? "演示专辑 · 加入音乐后显示真实封面"
            : `${n} 张专辑 · ${tracks} 首音乐 · 本地索引`;
  $("#library-status span").textContent = label;
  $("#library-status").classList.toggle(
    "working",
    !!library.scan.running ||
      !!library.enrich?.running ||
      !!library.introductions?.running,
  );
  $("#library-count").textContent = demo
    ? "DEMONSTRATION"
    : `${n} ALBUMS / ${tracks} TRACKS`;
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
  const lane = laneAt();
  if (queueLanesShown.length) setText($("#selection-code-label"), lane?.live ? "QUEUE" : "PLAYLIST");
  if (shownQueue()) {
    // The song scene lists the selected column: the queue, or a playlist that is not it.
    const list = lane && !lane.live ? "歌单歌曲" : "播放队列";
    setText($("#open-songs-label"), list);
    setText($("#detail-songs-label"), list);
  }
  const animated = selectionInitialized && selectionMotionEnabled();
  selectionInitialized = true;
  textMotion.update(
    {
      number: idx + 1,
      total: files.length,
      genresTotal: archiveColumns.length,
      // A playlist column counts its own songs.
      code: queueLanesShown.length ? idx + 1 : selected + 1,
      genreIndex: location.lane + 1,
      genre: archiveColumns[location.lane],
      genreName: archiveColumns[location.lane],
      format: shownQueue() ? (lane && !lane.live ? "NETEASE / 歌单" : "NETEASE / 播放队列") : externalMode ? "EXTERNAL / 当前曲目" : demo
        ? "DEMO"
        : [...new Set(a.tracks.map((t) => t.format))].join(" / "),
      artist: a.artist,
      meta: shownQueue() ? [laneSong()?.album || "专辑未提供", a.tracks[0]?.duration ? time(a.tracks[0].duration) : "", a.id === queuePlaying ? "当前曲目" : lane && !lane.live ? "仅浏览" : ""].filter(Boolean).join("  /  ")
        : externalMedia ? [externalMedia.selected?.album || "专辑未提供", "仅当前曲目"].join("  /  ") : [
        a.year ? String(a.year) : "年份未提供",
        demo ? "演示封面" : `${a.tracks.length} 首曲目`,
        a.tracks.length ? time(albumDuration(a)) : "",
      ]
        .filter(Boolean)
        .join("  /  "),
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
  $("#detail-card-id").textContent =
    shownQueue() ? `${lane && !lane.live ? "PLAYLIST" : "QUEUE"} / ${String((queueLanesShown.length ? idx : selected) + 1).padStart(3, "0")}`
      : externalMode ? "NOW PLAYING / 当前曲目" : `ALBUM / ${String(selected + 1).padStart(3, "0")}`;
  // Hidden archive content can prepare its static reels before the reveal.
  if (!animated) syncSelectionMotion();
}
function commitSelection(index: number, navigation?: ArchiveNavigation, keepDetail = false) {
  selected = wrap(index, records.length);
  columnMemory.set(fileLocation(selected).lane, records[selected].id);
  if (keepDetail) scene?.switchMusicAlbum(selected, navigation);
  else scene?.select(selected, navigation);
  updateSelection(navigation);
  scheduleQueueJump();
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
}
function navigationSelection() {
  if (libraryRebuilding && libraryIntent && "index" in libraryIntent) return libraryIntent.index;
  return presentation.pendingSelection?.index ?? selected;
}
function stepAlbum(direction: number) {
  if (externalMode && !shownQueue()) return;
  queueFollowPaused = true;
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
  if (externalMode && !shownQueue()) return;
  queueFollowPaused = true;
  if (!records.length || archiveColumns.length < 2) return;
  const lane = wrap(
    fileLocation(navigationSelection()).lane + direction,
    archiveColumns.length,
  );
  // Stepping into NetEase's own queue lands on the song it plays and follows it again, so
  // arriving there does not switch the song. Any other column opens where it was left.
  const live = !!laneAt(columnFiles(lane)[0])?.live;
  const playing = live ? records.findIndex((r) => r.id === queuePlaying) : -1;
  // Also when the playing song has no case there: the remembered case is shown, not played.
  if (live) queueFollowPaused = false;
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
  return !!currentAlbum() && (!externalMode || !!shownQueue());
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
  songView.setCard(songCardRect(stage.clientWidth, stage.clientHeight, SONG_VIEW.span, MUSIC_MODEL.width, MUSIC_MODEL.height));
}
function renderSongs() {
  const a = currentAlbum();
  if (!a) return;
  const queue = shownQueue();
  if (queue) {
    const index = new Map(records.map((record, i) => [record.id, i] as const));
    // With playlist columns the panel lists the selected column.
    const lane = laneAt();
    songView.render(queueSongModel(lane ? lane.tracks : queue.tracks, {
      stamp: lane ? `${queueStamp ?? ""}:${playlistStamp ?? ""}:${lane.id}` : queueStamp ?? "",
      truncated: lane ? lane.truncated : queue.truncated,
      selected: laneSong(),
      keyOf: lane ? (track) => laneTrackKey(lane, track) : queueTrackKey,
      indexOf: (key) => index.get(key) ?? -1,
      time,
      note: songQueueNote(),
      lane: lane && { name: lane.name, live: lane.live },
    }), preferences.reduced);
  } else songView.render(albumSongModel(a, { number: selected + 1, demo, time }), preferences.reduced);
  $("#song-details-label").textContent = queue ? "这首歌" : "专辑详情";
  $("#song-prev").setAttribute("aria-label", queue ? "上一首" : "上一张专辑");
  $("#song-next").setAttribute("aria-label", queue ? "下一首" : "下一张专辑");
  syncSongCard();
  syncSongRows(true);
}
/** Which rows are playing, selected and being switched to; cheap enough for every poll. */
function syncSongRows(reveal = false) {
  const queue = !!shownQueue();
  const selectedKey = queue ? records[selected]?.id : undefined;
  const playing = (queue ? queuePlaying : playerState?.currentTrack?.id) || undefined;
  // Paused, stopped or unknown: the current row stays marked but its level meter holds still.
  const paused = queue
    ? (debugState.available ? debugState.playback : externalMedia?.selected?.playback) !== "playing"
    : !(playerState?.playing || playerState?.transport === "loading");
  songView.sync({ playing, selected: selectedKey, pending: queueJump?.key, paused });
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
function togglePlayback() {
  if (externalMode) {
    if (!externalMedia?.can("toggle")) return;
    void controlExternal("toggle");
  } else playerState?.currentTrack ? void player?.toggle() : playAlbum();
  scene?.playGesture();
}
// Only an external player has a stop (on its details page); local mode has play / pause.
function stopPlayback() {
  if (!externalMedia?.can("stop")) return;
  void controlExternal("stop");
  scene?.playGesture();
}
function syncTabIndicator(animate = true) {
  const button = document.querySelector<HTMLElement>(`#tab-${activeTab}`);
  const indicator = document.querySelector<HTMLElement>(".music-tab-indicator");
  if (!button || !indicator) return;
  indicator.style.transition = animate && !preferences.reduced ? "" : "none";
  indicator.style.transform = `translateX(${button.offsetLeft}px) scaleX(${button.offsetWidth})`;
}
function setTab(tab: "tracks" | "about") {
  if (activeTab === tab) return;
  cancelSearchTrack();
  activeTab = tab;
  document.querySelectorAll<HTMLElement>("[data-tab]").forEach((button) => {
    const active = button.dataset.tab === tab;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  syncTabIndicator();
  const a = currentAlbum();
  if (!a) return;
  const content = $("#album-tab-content");
  content.innerHTML =
    tab === "tracks" ? trackList(a, a.discCount || 1) : albumAbout(a);
  content.setAttribute("aria-labelledby", `tab-${tab}`);
  documentDecryption.refresh();
  tabTransition.reveal(content, preferences.reduced);
  updatePlayingRows();
  effects.play("ui-tick");
}
function renderDetail() {
  if (externalMedia) return renderExternalDetail();
  const a = currentAlbum();
  if (!a) return;
  trackFocus.cancel();
  const discs =
    a.discCount || Math.max(1, ...a.tracks.map((t) => t.discNumber || 1));
  const bits =
    a.tracks.length && a.tracks.every((t) => t.lossless === false)
      ? "有损编码"
      : valueRange(
          a.tracks.map((t) => t.bitsPerSample),
          (n) => `${n} bit`,
        );
  const rate = valueRange(
    a.tracks.map((t) => t.sampleRate),
    (n) => `${Number((n / 1000).toFixed(1))} kHz`,
  );
  const bitrate = valueRange(
    a.tracks.map((t) => t.bitrate),
    (n) => `${Math.round(n / 1000)} kbps`,
  );
  const fields = [
    ["RELEASE / 发行年份", a.year || "未提供"],
    ["ARTIST / 歌手", a.artist],
    ["GENRE / 流派", genreName(a.genreId)],
    ["VOLUMES / 内含 CD", demo ? "—" : `${discs} CD · ${a.tracks.length} 首`],
    ["FORMAT / 文件格式", formatList(a)],
    ["RESOLUTION / 位深与采样率", `${bits} / ${rate}`],
    ["BITRATE / 码率", bitrate],
    ["DURATION / 总时长", time(albumDuration(a))],
  ];
  const article = $("#album-detail-content"),
    sameAlbum = detailIdentity === a.id,
    scroll = sameAlbum ? article.scrollTop : 0;
  detailIdentity = a.id;
  article.innerHTML = `<div class="detail-overline"><span>ALBUM ${String(selected + 1).padStart(3, "0")}</span><div class="detail-album-navigation" role="group" aria-label="切换专辑"><button data-action="prev" aria-label="上一张专辑">↑ 上一张</button><button data-action="next" aria-label="下一张专辑">下一张 ↓</button></div></div>
    <h1 title="${esc(a.title)}">${albumTitleMarkup(a.title)}</h1><p class="detail-artist">${esc(a.artist)}${a.offline ? '<span class="offline-badge">目录离线</span>' : ""}</p>
    <div class="album-facts">${fields.map(([name, value]) => `<div><small>${name}</small><span>${esc(String(value))}</span></div>`).join("")}</div>
    <div class="music-tabs" role="tablist" aria-label="专辑信息"><button role="tab" id="tab-tracks" data-tab="tracks" tabindex="${activeTab === "tracks" ? 0 : -1}" aria-selected="${activeTab === "tracks"}" aria-controls="album-tab-content"><span>01</span> 歌单</button><button role="tab" id="tab-about" data-tab="about" tabindex="${activeTab === "about" ? 0 : -1}" aria-selected="${activeTab === "about"}" aria-controls="album-tab-content"><span>02</span> 专辑介绍</button><i class="music-tab-indicator" aria-hidden="true"></i></div>
    <div id="album-tab-content" role="tabpanel" aria-labelledby="tab-${activeTab}">${activeTab === "tracks" ? trackList(a, discs) : albumAbout(a)}</div>`;
  article.scrollTop = scroll;
  syncTabIndicator(false);
  documentDecryption.reset(
    article,
    preferences.reduced || scene?.decryptionFrame.phase === "clear",
  );
  updatePlayingRows();
}
function trackList(a: MusicAlbum, discs: number) {
  if (!a.tracks.length)
    return `<div class="empty-tracks"><strong>${demo ? "这是一张封面演示卡片" : "这个专辑还没有可播放曲目"}</strong><p>${demo ? "用于检查封面原始比例与卡片材质。扫描本地音乐库后，这里会显示真实曲目。" : "请检查音乐文件是否完整，并重新扫描音乐库。"}</p><button data-action="library">打开音乐库设置 ↗</button></div>`;
  let disc = -1;
  return `<div class="track-list" aria-label="专辑歌曲列表">${a.tracks
    .map((t, index) => {
      const discNo = t.discNumber || 1;
      const head =
        discs > 1 && discNo !== disc
          ? `<div class="disc-heading">DISC ${String(discNo).padStart(2, "0")}</div>`
          : "";
      disc = discNo;
      return `${head}<button class="track-row" data-track="${esc(t.id)}" ${a.offline ? "disabled" : ""} aria-label="播放 ${esc(t.title)}"><span class="track-number">${String(t.trackNumber || index + 1).padStart(2, "0")}</span><span class="track-name"><strong>${esc(t.title)}</strong><small>${esc(t.artist)}</small></span><span class="track-format">${esc(t.format)}${!t.browserPlayable ? '<i title="需要兼容的播放内核"> ↗</i>' : ""}</span><span class="track-duration">${time(t.duration)}</span></button>`;
    })
    .join("")}</div>${producerBlock(a)}`;
}
function albumAbout(a: MusicAlbum) {
  return `<section class="album-about"><small>ABOUT THIS ALBUM</small>
    ${a.description ? `<p>${esc(a.description)}</p>${a.descriptionSource ? `<a class="text-button" href="${esc(a.descriptionSource.url)}" target="_blank" rel="noopener">来源：${esc(a.descriptionSource.name)} ↗</a>${a.descriptionSource.license ? `<small class="introduction-license">${esc(a.descriptionSource.license)}</small>` : ""}` : ""}` : `<h3>专辑介绍待补充</h3><p>从公开百科核对专辑与歌手后读取介绍，附上来源并保存在本机。无法确认对应专辑时保留空白。</p>`}
    ${!demo ? `<button data-action="introduction-album" class="text-button" ${introductionsStarting || library.introductions?.running ? "disabled" : ""}>${a.description ? "更新" : "查询"}专辑介绍 ↗</button><p class="introduction-feedback" data-introduction-feedback="${esc(a.id)}" role="status">${esc(introductionAlbumStatus(a))}</p>` : ""}
    <div class="source-note"><span>本地目录</span><code>${esc(a.folder)}</code></div><div class="genre-tags">${a.rawGenres.map((g) => `<span>${esc(g)}</span>`).join("")}</div></section>${producerBlock(a)}`;
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
    const album = albums.find(
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
function producerBlock(a: MusicAlbum) {
  return `<section class="producer-section"><div><small>ALBUM CREDITS / 制作人员</small>${!demo ? '<button data-action="enrich-album">补充在线资料 ↗</button>' : ""}</div>${a.producers.length ? `<dl>${a.producers.map((p) => `<div><dt>${esc(p.role)}${p.trackTitle ? ` · ${esc(p.trackTitle)}` : ""}</dt><dd>${esc(p.name)}</dd></div>`).join("")}</dl>` : "<p>暂无制作资料。本地标签优先，MusicBrainz 资料可查询并缓存在本机。</p>"}${a.online?.status === "uncertain" ? "<p>找到多个可能的发行版本，暂未自动采用资料。</p>" : ""}${a.online?.error ? `<p>${esc(a.online.error)}</p>` : ""}</section>`;
}
function updatePlayingRows() {
  document
    // The detail page's track list; the song scene's list keeps its own states (syncSongRows).
    .querySelectorAll<HTMLButtonElement>("#album-detail-content [data-track]")
    .forEach((row) => {
      const active = row.dataset.track === playerState?.currentTrack?.id;
      row.classList.toggle("playing", active);
      row.setAttribute("aria-current", String(active));
    });
  if (menu === "song") syncSongRows();
}
let lastPlayerError = "";
const transportTitleMotion = setupTransportTitle(
  $("#transport-track"),
  $("#transport-track-label"),
);
transportTitleMotion.setReduced(preferences.reduced);
player?.subscribe((state) => {
  playerState = state;
  const titleVisible = !!state.currentTrack &&
    (state.transport === "playing" || state.transport === "paused" || state.transport === "loading");
  transportTitleMotion.update(state.currentTrack?.title ?? "", titleVisible);
  $("#play-pause").setAttribute("aria-pressed", String(state.playing));
  $("#play-pause").setAttribute(
    "aria-label",
    state.playing ? "暂停" : "播放",
  );
  $("#play-pause").title = state.currentTrack
    ? `${state.playing ? "暂停" : "播放"}：${state.currentTrack.title}`
    : "播放当前专辑";
  if (state.error && state.error !== lastPlayerError) notify(state.error);
  lastPlayerError = state.error || "";
  updatePlayingRows();
});

let externalVisual: string | undefined;
let externalQueue: { tracks: QueueTrack[]; truncated: boolean; source?: QueueSource } | undefined;
let queueStamp: string | undefined;
let queueStatus = "";
// The user's NetEase playlists, read from its local database after the second opt-in.
let externalPlaylists: NeteasePlaylist[] | undefined;
let playlistStamp: string | undefined;
let playlistStatus = "";
// Whether the last playlists read met the reader's limits.
let playlistsCut = false;
let playlistsReadAt = -Infinity;
let playlistsReadFor: string | undefined;
// The database is not watched (NetEase rewrites it every few minutes for other reasons): read
// it again when the queue changes, which is when NetEase saves a playlist it started, and
// otherwise at this interval.
const PLAYLIST_REFRESH_MS = 30_000;
/** The shelf's columns while they are playlists; empty for the single queue column. */
let queueLanesShown: QueueLane[] = [];
let queueSettingVisual = "";
// The queue song the player reports, and whether the user browsed away from it. Following
// resumes when NetEase changes song by itself or the user returns to the playing song.
let queuePlaying = "";
let queueFollowPaused = false;
// NetEase's debugging port: the exact playing song, and the way to make it play another.
let debugState: DebugState = { available: false };
// NetEase's position, kept running between the once-a-second readings.
const playbackClock = new PlaybackClock();
// Whether the port has been asked since it was last wanted, and what it answered if not a state.
let debugProbed = false;
let debugError = "";
let debugSettingVisual = "";
let debugRestarting = false;
// The song Rhine asked NetEase to play and NetEase has not reported yet, and earlier
// requests the user moved on from before NetEase reported them (song -> time asked).
let queueJump: { key: string; at: number } | undefined;
const queueJumpsSuperseded = new Map<string, number>();
let queueJumpTimer: ReturnType<typeof setTimeout> | undefined;
// Long enough for a wheel glide or a held arrow key to finish before NetEase is asked.
const QUEUE_SETTLE_MS = 520;
const QUEUE_JUMP_TIMEOUT_MS = 6000;
/** NetEase's queue is shown only for a selected NetEase source after the user opted in. */
function shownQueue() {
  return externalMedia && preferences.neteaseQueue && isNeteaseSource(externalMedia.selected) && externalQueue?.tracks.length
    ? externalQueue : undefined;
}
/** The playlist column a case stands in, when the columns are playlists. */
function laneAt(index = selected) {
  const genre = queueLanesShown.length ? albums[index]?.genreId : undefined;
  return genre ? queueLanesShown.find((lane) => laneGenre(lane) === genre) : undefined;
}
/** The song a case shows: in its playlist column, or in NetEase's queue. */
function laneSong(index = selected) {
  const lane = laneAt(index), id = records[index]?.id;
  return lane ? lane.tracks.find((track) => laneTrackKey(lane, track) === id) : queueSong(id);
}
/** Only NetEase's own queue has songs it can be asked to play; a playlist column is for browsing. */
function queueSong(boxId?: string) {
  return boxId ? shownQueue()?.tracks.find((track) => queueTrackKey(track) === boxId) : undefined;
}
function queueControl() {
  const control = { enabled: preferences.neteaseControl, available: debugState.available };
  const status = !control.enabled ? ""
    : debugRestarting ? "正在以调试端口重新启动网易云…"
    : !debugProbed ? "正在检测网易云调试端口…"
    : debugError || queueControlStatus(control, debugState);
  // Offer a restart only once a probe has really found the port closed.
  return { ...control, status, restart: control.enabled && debugProbed && !control.available && !debugError && !debugRestarting };
}
function forgetQueueJumps() {
  clearTimeout(queueJumpTimer);
  queueJumpTimer = undefined;
  queueJump = undefined;
  queueJumpsSuperseded.clear();
}
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
    void sendSeeks();
    updateExternalControls();
  }, 0);
}
if (externalMode) {
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
}

/**
 * Position and length for the timeline. NetEase's media session has neither; while its
 * debugging port answers they come from there, and the timeline can be dragged.
 */
function externalTimeline() {
  const source = externalMedia?.selected;
  const position = playbackClock.position(performance.now());
  if (isNeteaseSource(source) && debugState.available && position !== undefined && playbackClock.duration)
    // A stopped or finished song has nothing loaded to seek in.
    return { position, duration: playbackClock.duration, seekable: preferences.neteaseControl && debugState.playback !== "stopped", debug: true };
  return { position: source?.position, duration: source?.duration, seekable: !!externalMedia?.can("seek"), debug: false };
}
const setText = (node: HTMLElement, text: string) => { if (node.textContent !== text) node.textContent = text; };
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
  }
  const label = document.querySelector<HTMLElement>("[data-media-timeline-label]");
  if (label) setText(label, known ? "播放位置" : "时长不可用");
}
// The newest place the user moved NetEase's timeline to and that has not been sent yet.
let pendingSeek: number | undefined;
let seekSending = false;
/** The timeline shows the target at once; NetEase is asked when the key or pointer is let go. */
function requestSeek(position: number) {
  if (!Number.isFinite(position)) return;
  pendingSeek = position;
  playbackClock.seek(position, performance.now());
  updateExternalTimeline();
  if (externalSeekPointer === undefined && !externalSeekKeys.size) void sendSeeks();
}
/** One request at a time, always the newest target: a held arrow key is one seek, not thirty. */
async function sendSeeks() {
  if (seekSending) return;
  seekSending = true;
  try {
    while (pendingSeek !== undefined) {
      const position = pendingSeek;
      pendingSeek = undefined;
      await seekNetease(position);
    }
  } finally {
    seekSending = false;
  }
}
async function seekNetease(position: number) {
  const trackId = debugState.trackId;
  if (!trackId || !preferences.neteaseControl || !debugState.available) return playbackClock.release();
  try {
    const sent = await nativeDebugPort.seek(trackId, position);
    // A trial clip limits the range: show where NetEase really went.
    if (pendingSeek === undefined && Number.isFinite(sent) && Math.abs(sent - position) > 0.5) playbackClock.seek(sent, performance.now());
  } catch (error) {
    playbackClock.release();
    notify(String(error instanceof Error ? error.message : error));
  }
  void refreshExternal();
}
function updateExternalControls() {
  if (!externalMedia) return;
  const source = externalMedia.selected;
  updateStatus();
  transportTitleMotion.update(source?.title || "", !!source?.title);
  const toggle = $<HTMLButtonElement>("#play-pause");
  toggle.disabled = !externalMedia.can("toggle");
  toggle.setAttribute("aria-pressed", String(source?.playback === "playing"));
  const toggleLabel = source?.playback === "playing" ? "暂停" : source?.playback === "unknown" ? "播放 / 暂停（状态未知）" : "播放";
  toggle.setAttribute("aria-label", toggleLabel);
  toggle.title = source ? `${source.name}：${toggleLabel}` : "请先连接播放器";
  document.querySelectorAll<HTMLButtonElement>("[data-media-action]").forEach(button => {
    button.disabled = !externalMedia.can(button.dataset.mediaAction as MediaAction);
    if (button.dataset.mediaAction === "toggle") button.textContent = toggleLabel;
  });
  document.querySelectorAll<HTMLElement>("[data-media-playback]").forEach(node => { node.textContent = mediaPlaybackLabel(source); });
  document.querySelectorAll<HTMLElement>("[data-media-album]").forEach(node => { node.textContent = source?.album || "未提供"; });
  updateExternalTimeline();
  const warning = [externalMedia.warning, source?.warning, externalMedia.error].filter(Boolean).join("\n");
  document.querySelectorAll<HTMLElement>("[data-media-warning]").forEach(node => { node.textContent = warning; });
  const connection = document.querySelector<HTMLElement>("#external-connection-status");
  if (connection) connection.textContent = mediaConnectionLabel(externalMedia);
  const disconnected = document.querySelector<HTMLButtonElement>('[data-action="disconnect-source"]');
  if (disconnected) disconnected.disabled = !externalMedia.selectedId;
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
    const control = queueControl();
    // The control switch is not part of the key: rebuilding under it would drop its focus.
    const restarting = debugRestarting && !isNeteaseSource(source);
    const queueKey = JSON.stringify([source?.id, isNeteaseSource(source), preferences.neteaseQueue, preferences.playlistColumns, restarting]);
    if (queueSetting && queueKey !== queueSettingVisual) {
      queueSettingVisual = queueKey;
      debugSettingVisual = "";
      // NetEase's source disappears while it restarts; keep saying what is happening.
      // The switch that was just operated is rebuilt with the rest: give it its focus back.
      const focused = queueSetting.contains(document.activeElement) ? (document.activeElement as HTMLElement).id : "";
      queueSetting.innerHTML = restarting
        ? '<p class="external-note" role="status">正在以调试端口重新启动网易云…</p>'
        : queueSettingMarkup(source, preferences.neteaseQueue, queueStatus, control,
            { enabled: preferences.playlistColumns, status: playlistStatus });
      if (focused) queueSetting.querySelector<HTMLElement>(`#${CSS.escape(focused)}`)?.focus({ preventScroll: true });
    }
    const queueStatusNode = document.querySelector<HTMLElement>("[data-queue-status]");
    if (queueStatusNode) queueStatusNode.textContent = queueStatus;
    const playlistStatusNode = document.querySelector<HTMLElement>("[data-playlist-status]");
    if (playlistStatusNode) playlistStatusNode.textContent = preferences.playlistColumns ? playlistStatus : "";
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
  const playing = !!queuePlaying && records[selected]?.id === queuePlaying;
  const lane = laneAt(), browsing = !!lane && !lane.live;
  document.querySelectorAll<HTMLElement>("[data-queue-state]").forEach((node) => {
    node.textContent = playing ? mediaPlaybackLabel(externalMedia?.selected)
      : queueJump?.key === records[selected]?.id ? "正在切换…" : browsing ? "仅浏览" : "队列中";
  });
  document.querySelectorAll<HTMLElement>("[data-media-now]").forEach((node) => {
    node.textContent = externalMedia?.selected?.title || "未提供";
  });
  const note = queueControlNote();
  document.querySelectorAll<HTMLElement>("[data-queue-control-note]").forEach((node) => { node.textContent = note; });
  if (menu === "song") {
    // The switch and the port change under an open song scene; its rows are not re-rendered for that.
    if (shownQueue()) setText($("#song-note"), songQueueNote());
    syncSongRows();
  }
}
const songQueueNote = () => {
  const lane = laneAt();
  return `${lane && !lane.live ? "盒子与列表按这个歌单在网易云里的顺序排列。" : "盒子与列表按网易云播放队列的顺序排列。"}${queueControlNote()}`;
};
function queueControlNote() {
  const lane = laneAt();
  if (lane && !lane.live) return "这一列是歌单，不是网易云当前的播放队列：只供浏览，选中盒子不会切歌。在网易云里播放这个歌单后，它就是播放队列。";
  return !preferences.neteaseControl ? "切歌未开启：可在“播放器”面板中打开“选中盒子时让网易云切歌”。"
    : debugState.available ? "停在一首歌上约半秒后，网易云播放它。"
    : "网易云的调试端口未连接，选中盒子不会切歌；可在“播放器”面板中查看。";
}
/** The playlists' names beside their columns, written in the scene. */
let laneNames: LaneName[] | null = null;
function syncLaneLabels() {
  // A column is the playlist its first case belongs to.
  laneNames = queueLanesShown.length
    ? archiveColumns.map((_, column) => {
        const lane = laneAt(columnFiles(column)[0]);
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
  const queue = !!shownQueue(), lanes = queueLanesShown.length > 1;
  if (stage.dataset.queue === String(queue) && stage.dataset.lanes === String(lanes)) return;
  stage.dataset.queue = String(queue);
  // Several playlist columns bring back the column stepper and the left / right keys.
  stage.dataset.lanes = String(lanes);
  $("#genre-code").textContent = queue ? "PLAYLIST" : sortLabel.code;
  $('.genre-stepper [data-action="genre-prev"]').setAttribute("aria-label", queue ? "上一个歌单" : `上一个${sortLabel.column}`);
  $('.genre-stepper [data-action="genre-next"]').setAttribute("aria-label", queue ? "下一个歌单" : `下一个${sortLabel.column}`);
  $("#selection-code-label").textContent = queue ? "QUEUE" : "LIVE TRACK";
  $("#selection-counter-label").textContent = queue ? "SONG / SELECT" : "ALBUM / SELECT";
  $("#selection-code-number").hidden = !queue;
  $("#open-album-label").textContent = queue ? "查看这首歌" : "当前曲目与控制";
  // A lone live track has no playlist: the song scene is offered only for the queue.
  if (!queue && menu === "song" && presentation.phase === "archive") setMenu("detail");
  $('.album-stepper [data-action="prev"]').setAttribute("aria-label", queue ? "上一首" : "上一个专辑");
  $('.album-stepper [data-action="next"]').setAttribute("aria-label", queue ? "下一首" : "下一个专辑");
  // Whether NetEase follows depends on the switch and its port, so the hint only says "select".
  $("#music-keyhint").innerHTML = queue
    ? `${lanes ? "← → 歌单 <span>／</span> " : ""}滚轮 / ↑ ↓ 选歌 <span>／</span> ENTER 打开 <span>／</span> S ${lanes ? "列表" : "队列"} <span>／</span> SPACE 播放 / 暂停`
    : "SPACE 播放 / 暂停 <span>／</span> ENTER 当前曲目";
}
async function refreshQueue() {
  const source = externalMedia?.selected;
  if (!preferences.neteaseQueue || !isNeteaseSource(source)) {
    externalQueue = undefined;
    queueStamp = undefined;
    return;
  }
  try {
    // The playlist the queue came from is asked for only with playlist columns on.
    const reply = await nativeQueuePort.read(queueStamp, preferences.playlistColumns);
    if (reply.status === "missing") {
      externalQueue = undefined;
      queueStamp = undefined;
      queueStatus = "没有找到网易云保存的播放队列。请先在网易云中播放歌曲。";
    } else if (reply.status === "queue") {
      queueStamp = reply.stamp;
      externalQueue = reply.tracks.length ? { tracks: reply.tracks, truncated: reply.truncated, source: reply.source } : undefined;
      queueStatus = reply.tracks.length
        ? `已读取播放队列 ${reply.tracks.length} 首${reply.truncated ? "（只显示前 3000 首）" : ""}，随网易云更新。`
        : "网易云的播放队列为空。";
    }
  } catch (error) {
    // A file being rewritten keeps the queue already shown; the next poll reads it again.
    queueStatus = String(error instanceof Error ? error.message : error);
  }
}
/** The user's playlists from NetEase's local database, only with both switches on. */
async function refreshPlaylists() {
  if (!preferences.neteaseQueue || !preferences.playlistColumns || !isNeteaseSource(externalMedia?.selected)) {
    externalPlaylists = undefined;
    playlistStamp = undefined;
    playlistsCut = false;
    playlistsReadAt = -Infinity;
    return;
  }
  const now = performance.now();
  if (now - playlistsReadAt < PLAYLIST_REFRESH_MS && playlistsReadFor === queueStamp) return;
  playlistsReadAt = now;
  playlistsReadFor = queueStamp;
  try {
    const reply = await nativePlaylistPort.read(playlistStamp);
    if (reply.status === "missing") {
      externalPlaylists = undefined;
      playlistStamp = undefined;
      playlistsCut = false;
      playlistStatus = "没有找到网易云的本机歌单数据。";
    } else {
      if (reply.status === "playlists") {
        playlistStamp = reply.stamp;
        externalPlaylists = reply.playlists;
        playlistsCut = reply.truncated;
      }
      // Also for "unchanged": a read that failed before left its error in the status.
      // (An answer to a read from before the switch was toggled finds nothing held.)
      if (externalPlaylists) playlistStatus = playlistSummary(externalPlaylists, playlistsCut);
    }
  } catch (error) {
    // A database being written keeps the playlists already shown; the next read tries again.
    playlistStatus = String(error instanceof Error ? error.message : error);
    playlistsReadAt = now - PLAYLIST_REFRESH_MS + 3000;
  }
}
async function refreshDebug() {
  if (!preferences.neteaseQueue || !preferences.neteaseControl || !isNeteaseSource(externalMedia?.selected)) {
    debugState = { available: false };
    debugProbed = false;
    debugError = "";
    playbackClock.update(debugState, performance.now());
    return;
  }
  try {
    debugState = await nativeDebugPort.state();
    debugError = "";
  } catch (error) {
    // Polled every second: e.g. NetEase's page is still starting. Report a change once.
    debugState = { available: false };
    const message = String(error instanceof Error ? error.message : error);
    if (message !== debugError) console.warn(message);
    debugError = message;
  }
  debugProbed = true;
  playbackClock.update(debugState, performance.now());
}
/**
 * The user is still moving along the shelf: a wheel glide, a step moments ago, or a step
 * that waits for the detail text to leave before it is committed.
 */
function queueBrowsing() {
  return wheelNavigation.active || queueJumpTimer !== undefined ||
    (queueFollowPaused && (!!presentation.pendingSelection ||
      (libraryRebuilding && !!libraryIntent && "index" in libraryIntent)));
}
/** Every committed selection restarts the wait; only the box the user rests on is played. */
function scheduleQueueJump(key = records[selected]?.id) {
  clearTimeout(queueJumpTimer);
  queueJumpTimer = undefined;
  if (!key || !shownQueue() || !queueFollowPaused) return;
  queueJumpTimer = setTimeout(() => {
    queueJumpTimer = undefined;
    void jumpToSelectedSong(key);
  }, QUEUE_SETTLE_MS);
}
/** `key` is the box the wait was started for; a rebuilt queue may no longer rest on it. */
async function jumpToSelectedSong(key: string) {
  // Still gliding, or a detail switch is waiting for its text to leave: ask again later.
  if (wheelNavigation.active || presentation.pendingSelection || libraryRebuilding) return scheduleQueueJump(key);
  const song = records[selected]?.id === key ? queueSong(key) : undefined;
  if (!song || !queueFollowPaused || key === queuePlaying || queueJump?.key === key) return;
  if (!preferences.neteaseControl || !debugState.available) return;
  if (queueJump) queueJumpsSuperseded.set(queueJump.key, queueJump.at);
  queueJumpsSuperseded.delete(key);
  queueJump = { key, at: performance.now() };
  updateQueueRows();
  try {
    await nativeDebugPort.play(song.id);
  } catch (error) {
    if (queueJump?.key === key) queueJump = undefined;
    updateQueueRows();
    notify(String(error instanceof Error ? error.message : error));
    return;
  }
  // The poll confirms it; ask now rather than up to a second later.
  void refreshExternal();
}
/** Bring the playing song forward unless the user is browsing elsewhere. */
function followQueue() {
  const queue = shownQueue();
  const key = queue ? queueTrackKey(playingQueueTrack(queue.tracks, externalMedia?.selected, debugState)) : "";
  const now = performance.now();
  for (const [asked, at] of queueJumpsSuperseded) if (now - at > QUEUE_JUMP_TIMEOUT_MS) queueJumpsSuperseded.delete(asked);
  if (queueJump && now - queueJump.at > QUEUE_JUMP_TIMEOUT_MS) {
    queueJump = undefined;
    notify("网易云没有切换到选中的歌曲。");
  }
  if (key !== queuePlaying) {
    queuePlaying = key;
    if (queueJump?.key === key) {
      // NetEase reports the song Rhine asked for.
      queueJump = undefined;
      queueJumpsSuperseded.clear();
    } else if (!queueJumpsSuperseded.delete(key)) {
      // NetEase changed song by itself (or skipped a song it cannot play): follow it again,
      // but never pull the shelf away from under a user who is still scrolling.
      queueJump = undefined;
      queueJumpsSuperseded.clear();
      if (!queueBrowsing()) queueFollowPaused = false;
    }
    // Otherwise an earlier request landed after the user had moved on: the newer request,
    // or the box the user rests on, still stands.
    updateQueueRows();
    updateSelection();
  }
  if (!key || !ready || boot?.active || panel || libraryRebuilding) return;
  const index = records.findIndex((record) => record.id === key);
  const cursor = navigationSelection();
  // Browsing another playlist's column: NetEase changing song does not pull the shelf back.
  if (queueLanesShown.length && !laneAt(cursor)?.live) return;
  if (index < 0) return;
  if (index === cursor) {
    queueFollowPaused = false;
    return;
  }
  if (queueFollowPaused) return;
  select(index, rowNavigation(cursor, index));
}
function syncExternal(): Promise<void> {
  // Serialize scene changes; a later snapshot wins after an in-flight cover upload.
  externalUpdating = externalUpdating.catch(error => notify(String(error))).then(async () => {
    if (!externalMedia || externalStopped) return;
    updateExternalControls();
    const source = externalMedia.selected;
    const queue = shownQueue();
    // The queue's shelf changes only with the queue; a new song just moves the selection.
    // With the playlists read, the columns are playlists; otherwise the queue is the one column.
    const lanes = queue && source && preferences.playlistColumns && externalPlaylists ? queueLanes(queue, externalPlaylists) : [];
    const nextVisual = queue && source
      ? JSON.stringify(["queue", source.id, source.name, queueStamp, ...(lanes.length ? [playlistStamp] : [])])
      : mediaVisualKey(source);
    if (nextVisual !== externalVisual) {
      queueLanesShown = lanes;
      library = queue && source ? (lanes.length ? laneLibrary(lanes) : queueLibrary(queue.tracks, NETEASE_NAME)) : mediaLibrary(source);
      syncQueueChrome();
      await applyLibrary();
      externalVisual = nextVisual;
    }
    followQueue();
    updateExternalControls();
  });
  return externalUpdating;
}
async function refreshExternal() {
  if (!externalMedia || externalStopped || externalRefreshing) return;
  externalRefreshing = true;
  clearTimeout(externalPoll);
  try {
    await externalMedia.refresh();
    await refreshQueue();
    await refreshPlaylists();
    await refreshDebug();
    await syncExternal();
  } catch (error) { notify(String(error)); }
  finally {
    externalRefreshing = false;
    if (!externalStopped) externalPoll = setTimeout(() => void refreshExternal(), document.hidden ? 2000 : 1000);
  }
}
async function controlExternal(action: MediaAction, position?: number) {
  if (!externalMedia) return;
  const pending = externalMedia.control(action, position);
  updateExternalControls();
  await pending;
  if (externalMedia.error) notify(externalMedia.error);
  await refreshExternal();
}
function renderSourcesPanel() {
  if (!externalMedia) return;
  sourcesVisual = "";
  queueSettingVisual = "";
  $("#panel-body").innerHTML = `<p class="panel-intro">选择要连接的播放器。网易云音乐是默认连接：发现它时自动连接，断开后重新出现也会自动接回；你选择了别的播放器或点了“断开连接”之后不再自动连接。默认只读取当前曲目、封面与可用控制；网易云的播放队列与切歌在下方另行开关。不会导入曲库，来源消失后也不会自动换到别的播放器。</p><p id="external-connection-status" role="status"></p><div id="external-sources" class="external-source-list"></div><div id="external-permission"></div><div id="external-queue"></div><p data-media-warning class="external-warning" role="status"></p><div class="panel-actions"><button data-action="refresh-sources">刷新来源 ↻</button><button data-action="disconnect-source">断开连接</button></div><p class="external-note">无法取得播放状态或时长时显示未知，没有读数时不推算进度。缺少封面时使用中性卡片。播放器是否提供信息取决于它当前的版本与运行状态。</p>`;
  updateExternalControls();
}
const externalControls = '<div class="external-controls" role="group" aria-label="外部播放器控制"><button data-media-action="previous">上一曲</button><button data-media-action="toggle">播放 / 暂停</button><button data-media-action="next">下一曲</button><button data-media-action="stop">停止</button></div><label class="external-timeline" for="external-seek"><span><span data-media-timeline-label>播放位置</span> <output><span data-media-position></span> / <span data-media-duration></span></output></span><input type="range" id="external-seek" min="0" max="1" step="1" value="0" disabled aria-label="外部播放器播放位置"></label>';
function renderQueueDetail() {
  const a = currentAlbum();
  if (!a) return;
  const song = laneSong();
  const lane = laneAt(), browsing = !!lane && !lane.live;
  const article = $("#album-detail-content");
  detailIdentity = a.id;
  article.innerHTML = `<div class="detail-overline"><span>${browsing ? "NETEASE PLAYLIST" : "NETEASE QUEUE"} / ${String((lane ? columnFiles(fileLocation(selected).lane).indexOf(selected) : selected) + 1).padStart(3, "0")}</span><div class="detail-album-navigation" role="group" aria-label="切换歌曲"><button data-action="prev" aria-label="上一首">↑ 上一首</button><button data-action="next" aria-label="下一首">下一首 ↓</button></div></div><h1 title="${esc(a.title)}">${albumTitleMarkup(a.title)}</h1><p class="detail-artist">${esc(a.artist)}</p><div class="album-facts"><div><small>ALBUM / 专辑</small><span>${esc(song?.album || "未提供")}</span></div><div><small>DURATION / 时长</small><span>${song?.duration ? time(song.duration) : "未提供"}</span></div><div><small>SOURCE / 来源</small><span>${lane ? `${NETEASE_NAME} / ${esc(lane.name)}` : NETEASE_NAME}</span></div><div><small>STATUS / 状态</small><span data-queue-state></span></div><div><small>NOW PLAYING / 网易云当前曲目</small><span data-media-now></span></div></div>${externalControls}<p class="external-note">${browsing ? "盒子按这个歌单在网易云里的顺序排列。" : "盒子按网易云播放队列的顺序排列，随机播放时实际播放顺序不同。"}<span data-queue-control-note></span></p><p data-media-warning class="external-warning" role="status"></p>`;
  documentDecryption.reset(article, preferences.reduced || scene?.decryptionFrame.phase === "clear");
  updateExternalControls();
}
function renderExternalDetail() {
  const source = externalMedia?.selected;
  if (!source) return;
  if (shownQueue()) return renderQueueDetail();
  const article = $("#album-detail-content");
  article.innerHTML = `<div class="detail-overline"><span>EXTERNAL / 当前曲目</span><button data-action="sources">${esc(source.name)} ↗</button></div><h1 title="${esc(source.title || "曲名未提供")}">${albumTitleMarkup(source.title || "曲名未提供")}</h1><p class="detail-artist">${esc(source.artist || "歌手未提供")}</p><div class="album-facts"><div><small>ALBUM / 专辑</small><span data-media-album>${esc(source.album || "未提供")}</span></div><div><small>STATUS / 播放状态</small><span data-media-playback></span></div></div>${externalControls}<p class="external-note">只显示当前曲目，不代表完整专辑或播放队列。音量与音效由原播放器控制；灰色按钮表示该来源当前未提供相应能力。</p><p data-media-warning class="external-warning" role="status"></p>`;
  documentDecryption.reset(article, preferences.reduced || scene?.decryptionFrame.phase === "clear");
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
function openPanel(next: Panel) {
  if (!next) return closePanel();
  if (externalMode && (next === "library" || next === "search")) next = "sources";
  cancelSearchTrack();
  panelTransition?.dispose();
  pendingPanelAfter = undefined;
  panelClosing = false;
  if (!panel) panelFocus = document.activeElement as HTMLElement;
  panel = next;
  const titles = {
    library: ["MUSIC LIBRARY", "本地音乐库"],
    search: ["FIND MUSIC", "搜索专辑与歌曲"],
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
  panelTransition.show(preferences.reduced);
  effects.play("page-open");
  if (next === "library") renderLibraryPanel();
  if (next === "search") renderSearchPanel();
  if (next === "settings") renderSettingsPanel();
  if (next === "sources") renderSourcesPanel();
  (
    document.querySelector<HTMLElement>("#album-search") ||
    $("#music-panel-root button")
  )?.focus({ preventScroll: true });
}
function renderLibraryPanel() {
  $("#panel-body").innerHTML =
    `<p class="panel-intro">根目录中的每首单曲各是一张卡片，优先使用自身内嵌封面。子文件夹按专辑展示，优先使用文件夹封面。</p><label class="field-label" for="music-roots">音乐文件夹<span>多个目录各占一行</span></label><textarea id="music-roots" rows="3" placeholder="Windows: D:\\Music&#10;macOS: /Users/你的用户名/Music">${esc(library.roots.map((r) => r.path).join("\n"))}</textarea><div class="panel-actions"><button class="primary-button" data-action="scan">保存目录并扫描 ↗</button><button data-action="rescan">重新扫描</button></div><div id="scan-status" class="scan-status"></div><div class="library-metrics"><div><b>${library.albums.length}</b><span>专辑</span></div><div><b>${library.albums.reduce((n, a) => n + a.tracks.length, 0)}</b><span>曲目</span></div><div><b>${library.genres.filter((g) => library.albums.some((a) => a.genreId === g.id)).length}</b><span>流派</span></div></div><section class="panel-section"><h3>在线资料与本地分类</h3><p>向 MusicBrainz 查询专辑名称与艺术家，补充流派和制作人员；音乐文件留在本机。已有资料使用缓存，人工分类优先保留。</p><button data-action="enrich-library" class="text-button">补充缺失的在线资料 ↗</button><button data-action="edit-genres" class="text-button">编辑流派归并规则 ↗</button></section><section class="panel-section"><h3>封面显示</h3><p>方形、竖版、横版封面均保持原始比例，完整放入卡片正面。没有封面时显示专辑名称占位，不使用其他专辑的图片。</p>${!library.albums.length ? '<button data-action="demo" class="text-button">查看演示封面 ↗</button>' : ""}</section>`;
  if (isDesktop) {
    const picker = document.createElement("button");
    picker.textContent = "选择音乐文件夹…";
    picker.addEventListener("click", async () => {
      try {
        const initialDirectory = document.querySelector<HTMLTextAreaElement>("#music-roots")?.value.split("\n")[0]?.trim();
        const paths = await chooseMusicFolders(initialDirectory);
        const input = document.querySelector<HTMLTextAreaElement>("#music-roots");
        if (!input || !paths.length) return;
        input.value = [...new Set([...input.value.split("\n").map((s) => s.trim()).filter(Boolean), ...paths])].join("\n");
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
      const config = await request<{
        musicBrainzContact?: string;
        musicBrainzConfigured?: boolean;
        onlineEnabled?: boolean;
      }>("/api/config");
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
  if (el)
    el.textContent = library.scan.running
      ? "正在扫描，已有曲库可以继续浏览…"
      : library.scan.error ||
        library.roots
          .filter((r) => r.status === "offline")
          .map((r) => `${r.path} 暂时离线，原索引已保留。`)
          .join("\n") ||
        (library.scan.finishedAt
          ? `上次扫描 ${new Date(library.scan.finishedAt).toLocaleString("zh-CN")}`
          : "尚未扫描音乐目录。");
}
function renderSearchPanel() {
  $("#panel-body").innerHTML =
    `<input class="album-search" id="album-search" type="search" placeholder="专辑、歌曲、歌手、流派…" aria-label="搜索专辑与歌曲"><div class="genre-filters"><button data-filter="" class="active">全部</button>${genres
      .filter((g) => albums.some((a) => a.genreId === g.id))
      .map((g) => `<button data-filter="${esc(g.id)}">${esc(g.name)}</button>`)
      .join("")}</div><div id="album-results"></div>`;
  renderSearchResults();
}
let searchGenre = "";
function renderSearchResults() {
  const query = ($<HTMLInputElement>("#album-search")?.value || "")
    .trim()
    .toLocaleLowerCase();
  const results: string[] = [];
  for (const a of albums) {
    if (searchGenre && a.genreId !== searchGenre) continue;
    if (!query || `${a.title} ${a.artist} ${genreName(a.genreId)}`.toLocaleLowerCase().includes(query)) {
      results.push(`<button class="album-result" data-album="${esc(a.id)}"><span class="result-cover">${cover(a)}</span><span class="result-copy"><strong>${esc(a.title)}</strong><small>${esc(a.artist)} · ${esc(genreName(a.genreId))}</small></span><em>专辑</em><i>↗</i></button>`);
    }
    if (!query) continue;
    for (const track of a.tracks) {
      if (!`${track.title} ${track.artist}`.toLocaleLowerCase().includes(query)) continue;
      // Preserve the exact song identity; selecting a result navigates without playing.
      results.push(`<button class="album-result song-result" data-album="${esc(a.id)}" data-search-track="${esc(track.id)}" aria-label="定位歌曲 ${esc(track.title)}，${esc(a.title)}"><span class="result-cover">${cover(a)}</span><span class="result-copy"><strong>${esc(track.title)}</strong><small>${esc(track.artist)} · ${esc(a.title)}</small></span><em>歌曲</em><i>↗</i></button>`);
    }
  }
  $("#album-results").innerHTML = results.length
    ? results.join("")
    : '<div class="no-results">没有找到专辑或歌曲。</div>';
}
function renderSettingsPanel() {
  $("#panel-body").innerHTML =
    `<section class="panel-section"><h3>外观主题</h3><div class="theme-cards">${(["day", "night"] as Theme[]).map((t) => `<button data-theme="${t}" aria-pressed="${preferences.theme === t}" class="${t}"><i></i><strong>${themeNames[t]}</strong><span>${t === "day" ? "暖白玻璃与日光" : "极简星空与透光白卡"}</span></button>`).join("")}</div></section>
    <section class="panel-section"><h3>音乐库排列</h3><label class="settings-row"><span>排列方式<small>切换后自动刷新页面</small></span><select id="music-sort" aria-label="音乐库排列方式">${(["genre", "artist", "album"] as MusicSortMode[]).map((value) => `<option value="${value}" ${preferences.sortMode === value ? "selected" : ""}>${sortLabels[value].name}</option>`).join("")}</select></label><p>按歌手时，同一歌手的专辑放在同一列；按专辑名时，按拼音或字母顺序排列，每 12 张一列。</p></section>
    <section class="panel-section" id="introduction-settings"><h3>专辑介绍</h3><p>从公开百科查询并更新专辑介绍，附上资料来源。介绍保存在本机，不需要配置 MusicBrainz 联系信息；音乐文件不会上传。</p><p id="introduction-coverage"></p><button class="primary-button" id="introduction-refresh" data-action="introductions-library">查询 / 更新专辑介绍 ↗</button><progress id="introduction-progress" aria-label="专辑介绍查询进度" max="1" value="0" hidden></progress><p id="introduction-status" class="scan-status" role="status" aria-live="polite"></p><details id="introduction-missing" hidden><summary></summary><ul></ul></details></section>
    ${qualityMarkup(renderQuality)}
    <section class="panel-section"><h3>动效与显示</h3><label class="settings-row"><span>减少动态效果<small>简化镜头、文字加载和页签过渡</small></span><input type="checkbox" id="reduced-motion" ${preferences.reduced ? "checked" : ""}></label><button class="text-button" data-action="fullscreen">切换全屏 ↗</button></section>
    <section class="panel-section"><h3>声音</h3><label class="settings-row"><span>歌曲音量</span><input type="range" id="volume" aria-label="歌曲音量" min="0" max="100" value="${Math.round(preferences.volume * 100)}"></label><label class="settings-row"><span>切歌淡入淡出<small>当前歌曲先淡出，再淡入下一首</small></span><input type="checkbox" id="song-fade-setting" ${preferences.songFade ? "checked" : ""}></label><label class="settings-row"><span>界面音效<small>玻璃卡片与终端操作</small></span><input type="checkbox" id="sound-setting" ${preferences.sound ? "checked" : ""}></label><label class="settings-row"><span>音效音量</span><input type="range" id="sound-volume" aria-label="音效音量" min="0" max="100" value="${Math.round(preferences.soundVolume * 100)}"></label><label class="settings-row"><span>氛围 BGM<small>专辑开始前淡出，播完后淡入</small></span><input type="checkbox" id="bgm-setting" ${preferences.bgm ? "checked" : ""}></label><label class="settings-row"><span>BGM 音量</span><input type="range" id="bgm-volume" aria-label="BGM 音量" min="0" max="100" value="${Math.round(preferences.bgmVolume * 100)}"></label><button class="text-button" data-action="sound-preview">试听界面音效 ↗</button><p>当前版本支持 Windows 和 macOS，使用浏览器播放本地音乐。DSF / DFF 暂不支持播放，其他格式取决于浏览器解码能力。</p></section>
    <section class="panel-section"><h3>开发与资源</h3><p>音乐适配与维护：<a href="https://github.com/RonaldDeng/Rhine-Music-Demo" target="_blank" rel="noopener">RonaldDeng ↗</a><br>原版界面：<a href="https://github.com/LBEILC/RhineLabUI" target="_blank" rel="noopener">LBEILC / RhineLabUI ↗</a></p><p><a href="/licenses/project-mit.txt" target="_blank" rel="noopener">代码 MIT 许可 ↗</a> · <a href="https://github.com/RonaldDeng/Rhine-Music-Demo/blob/v0.2.0/NOTICE.md" target="_blank" rel="noopener">版权与资源说明 ↗</a></p><a href="/?original=1&scene=archive" target="_blank" rel="noopener">打开原版档案界面 ↗</a><p><a href="/fonts/MiSans-license.pdf" target="_blank" rel="noopener">MiSans 字体许可 ↗</a></p></section>`;
  if (externalMode) {
    $("#music-sort").closest(".panel-section")?.remove();
    $("#introduction-settings").remove();
    $("#volume").closest(".panel-section")?.remove();
    $("#panel-body").insertAdjacentHTML("afterbegin", '<p class="panel-intro">外部播放器模式只调整此窗口的外观。歌曲音量、淡入淡出与曲库管理请在原播放器中设置，此窗口不会播放本地音乐或 BGM。</p>');
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
async function editGenres() {
  if (externalMode) return;
  const body = document.querySelector("#panel-body");
  try {
    const rules = await request<GenreRules>("/api/genre-rules");
    if (!body?.isConnected || panel !== "library") return;
    body.innerHTML = `<p class="panel-intro">这里编辑展示流派、别名和专辑人工分类。保存后重新归并本地索引，不修改音频标签。</p><label class="field-label" for="genre-json">本地流派规则</label><textarea id="genre-json" class="json-editor" spellcheck="false">${esc(JSON.stringify(rules, null, 2))}</textarea><div class="panel-actions"><button data-action="save-genres" class="primary-button">保存并应用</button><button data-action="library">返回音乐库</button></div><p id="genre-error" role="alert"></p>`;
  } catch (error) {
    notify((error as Error).message);
  }
}
async function scan(saveRoots = false) {
  if (externalMode) return;
  if (scanSubmitting || library.scan.running) return;
  scanSubmitting = true;
  clearTimeout(scanRefreshTimer);
  scanRefreshTimer = undefined;
  ++libraryStateVersion;
  try {
    const roots = saveRoots
      ? $<HTMLTextAreaElement>("#music-roots")
          .value.split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const next = await request<MusicLibrary>("/api/library/scan", roots ? { roots } : {});
    ++libraryStateVersion; // Discard polls started before this accepted scan.
    notify("开始扫描音乐库，已有专辑可以继续浏览。");
    await receiveLibrary(next);
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void loadLibrary(), 600);
  } catch (error) {
    notify((error as Error).message);
  } finally {
    scanSubmitting = false;
  }
}
async function enrich(one = false) {
  if (externalMode) return;
  if (demo) return;
  try {
    await request(
      "/api/library/enrich",
      one ? { albumIds: [currentAlbum()!.id] } : {},
    );
    notify("已开始补充流派和制作资料，结果将缓存在本机。");
    await loadLibrary();
  } catch (error) {
    notify((error as Error).message);
  }
}
async function queryIntroductions(one = false) {
  if (externalMode) return;
  const album = currentAlbum();
  if (demo || !library.albums.length || (one && !album)) return;
  if (introductionsStarting || library.introductions?.running) {
    notify("专辑介绍正在查询，进度可在设置中查看。");
    return;
  }
  introductionsStarting = true;
  introductionRequestError = "";
  updateIntroductionStatus();
  try {
    const next = await request<MusicLibrary>("/api/library/introductions", {
      ...(one ? { albumIds: [album!.id] } : {}),
      force: true,
    });
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
function playAlbum(id?: string) {
  if (externalMode) { void controlExternal("toggle"); return; }
  const a = currentAlbum();
  if (!a?.tracks.length || a.offline) return;
  void player?.play(id || a.tracks[0].id, a.tracks);
}

document.addEventListener("click", (e) => {
  if (boot?.active) return;
  const target = (e.target as HTMLElement).closest<HTMLElement>(
    "button, [data-action]",
  );
  if (!target) return;
  if (target instanceof HTMLButtonElement && target.disabled) return;
  if (target.dataset.mediaSource && externalMedia) {
    if (externalMedia.select(target.dataset.mediaSource)) void syncExternal();
    return;
  }
  if (target.dataset.mediaAction && externalMedia) {
    // Play / pause and stop answer with the selected case's hop; previous and next move it.
    if (target.dataset.mediaAction === "toggle") togglePlayback();
    else if (target.dataset.mediaAction === "stop") stopPlayback();
    else void controlExternal(target.dataset.mediaAction as MediaAction);
    return;
  }
  if (target.dataset.action === "dismiss-panel" && e.target !== target) return;
  if (target.dataset.theme) {
    setTheme(target.dataset.theme as Theme);
    return;
  }
  if (target.dataset.track) {
    playAlbum(target.dataset.track);
    return;
  }
  if (target.dataset.select) {
    const index = Number(target.dataset.select);
    const rulerStep = Number(target.dataset.rulerStep);
    queueFollowPaused = true;
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
  if (target.dataset.tab) {
    setTab(target.dataset.tab as "tracks" | "about");
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
    case "external-mode":
      changePlayerMode(true);
      break;
    case "local-mode":
      changePlayerMode(false);
      break;
    case "refresh-sources":
      void refreshExternal();
      break;
    case "disconnect-source":
      externalMedia?.disconnect();
      void syncExternal();
      break;
    case "netease-restart-debug":
      if (debugRestarting) break;
      if (target.dataset.confirm !== "true") {
        // Closing someone's player needs a second, deliberate click.
        target.dataset.confirm = "true";
        target.textContent = "再点一次确认：将关闭并重新启动网易云";
        break;
      }
      debugRestarting = true;
      updateExternalControls();
      void nativeDebugPort.restart()
        .then(() => notify(externalMedia?.followsPreferred
          ? "网易云已以调试端口重新启动，出现后会自动重新连接。"
          : "网易云已以调试端口重新启动。请在“播放器”面板重新选择网易云。"))
        .catch((error) => notify(String(error instanceof Error ? error.message : error)))
        .finally(() => {
          debugRestarting = false;
          debugProbed = false;
          delete target.dataset.confirm;
          target.textContent = "以调试端口重新启动网易云";
          void refreshExternal();
        });
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
    case "genres":
      openPanel("search");
      break;
    case "play-pause":
      togglePlayback();
      break;
    case "scan":
      void scan(true);
      break;
    case "rescan":
      void scan();
      break;
    case "enrich-album":
      void enrich(true);
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
    case "edit-genres":
      void editGenres();
      break;
    case "save-online":
      void (async () => {
        try {
          await request("/api/config", {
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
    case "save-genres":
      void (async () => {
        const editor = $<HTMLTextAreaElement>("#genre-json");
        try {
          const body = JSON.parse(editor.value);
          await request("/api/genre-rules", body);
          await loadLibrary(true);
          notify("分类规则已保存并应用。");
          if (editor.isConnected && panel === "library") renderLibraryPanel();
        } catch (error) {
          const errorNode = document.querySelector("#genre-error");
          if (editor.isConnected && errorNode)
            errorNode.textContent = (error as Error).message;
          else notify((error as Error).message);
        }
      })();
      break;
    case "demo":
      if (externalMode) break;
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
    if (externalMode) return;
    preferences.bgmVolume = Number(el.value) / 100;
    player?.setBgmVolume(preferences.bgmVolume);
    savePrefs();
  }
  if (el.id === "sound-volume") {
    if (externalMode) return;
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
  if (el.id === "volume") {
    if (externalMode) return;
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
  if (externalMedia && el.id === "netease-queue") {
    preferences.neteaseQueue = el.checked;
    savePrefs();
    externalQueue = undefined;
    queueStamp = undefined;
    queueStatus = el.checked ? "正在读取网易云播放队列…" : "";
    updateExternalControls();
    void refreshExternal();
    return;
  }
  if (externalMedia && el.id === "netease-playlists") {
    preferences.playlistColumns = el.checked;
    savePrefs();
    externalPlaylists = undefined;
    playlistStamp = undefined;
    playlistsCut = false;
    playlistsReadAt = -Infinity;
    playlistStatus = el.checked ? "正在读取网易云的本机歌单…" : "";
    updateExternalControls();
    void refreshExternal();
    return;
  }
  if (externalMedia && el.id === "netease-control") {
    preferences.neteaseControl = el.checked;
    savePrefs();
    debugProbed = false;
    if (!el.checked) forgetQueueJumps();
    updateExternalControls();
    void refreshExternal();
    return;
  }
  if (el.id === "music-sort" && ["genre", "artist", "album"].includes(el.value)) {
    if (externalMode) return;
    if (preferences.sortMode === el.value) return;
    preferences.sortMode = el.value as MusicSortMode;
    savePrefs();
    reloadPlayer();
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
    if (externalMode) return;
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
    if (externalMode) return;
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
  if (el.id === "bgm-setting") {
    if (externalMode) return;
    preferences.bgm = el.checked;
    player?.setBgmEnabled(el.checked);
    savePrefs();
  }
});
document.addEventListener("keydown", (e) => {
  if (boot?.active) return;
  if (viewer?.isOpen) return;
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
    (e.target as HTMLElement).matches("[role=tab]") &&
    ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)
  ) {
    e.preventDefault();
    setTab(
      e.key === "Home"
        ? "tracks"
        : e.key === "End"
          ? "about"
          : activeTab === "tracks"
            ? "about"
            : "tracks",
    );
    $(`#tab-${activeTab}`).focus();
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
    records.length > 1 && (!externalMode || !!shownQueue());
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
  // The playlist panel keeps the wheel to itself even when its list is too short to scroll.
  if (!wheelCanNavigate() || scrollsNatively(event.target) || songView.glass.contains(event.target as Node)) return;
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
      $("#runtime-info").textContent =
        `${Math.round((frameCount * 1000) / (ms - lastFrame))} FPS / ${themeNames[preferences.theme]}`;
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
  if (externalMode) await refreshExternal();
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
    ]);
    ready = true;
    $("#three-scene canvas").setAttribute(
      "aria-label",
      externalMode ? "三维卡片，显示所选外部播放器的当前曲目" : `三维专辑阵列，左右切${sortLabel.column}，上下切专辑`,
    );
    stage.classList.toggle("reduce-motion", preferences.reduced);
    // Skin mode starts on the song that is playing: with the default link the queue is there
    // before the scene, and the opening must not present another song and travel afterwards.
    if (externalMode && queuePlaying) {
      const playing = records.findIndex((record) => record.id === queuePlaying);
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
      if (externalMode && !shownQueue()) return;
      // A card of the chain becomes the large card, also when a short looping column shows
      // the same album or song again there.
      if (!songScene && presentation.phase !== "archive") return;
      queueFollowPaused = true;
      select(index, cell ? { cell } : undefined);
    };
    scene.onNavigate = (axis, direction) => {
      if ((!externalMode || shownQueue()) && !boot?.active && presentation.phase === "archive" && !panel)
        axis === "lane" ? stepGenre(direction) : stepAlbum(direction);
    };
    $("#music-loading").remove();
    updateSelection();
    if (albums.length && new URLSearchParams(location.search).get("scene") !== "archive") {
      boot?.start(performance.now() / 1000);
    } else {
      scene.showMusicArchiveImmediately(performance.now() / 1000);
      effects.setScene("archive");
      if (albums.length) showBrowseSurface();
      else browseTransition.hide(true);
      $("#music-browse").inert = !albums.length;
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
        allowGlobalMediaKeys: externalMedia.allowGlobalMediaKeys, warning: externalMedia.warning,
        error: externalMedia.error, busy: externalMedia.busy } : undefined;
    },
    stats: () => scene?.getStats(),
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
