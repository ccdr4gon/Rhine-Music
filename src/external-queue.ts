import type { MusicAlbum, MusicLibrary, MusicTrack } from "./music-types";
import type { ExternalMediaSource } from "./external-media";
import { escapeHtml as esc } from "./html";

/** Display fields of one song in NetEase Cloud Music's saved play queue. */
export interface QueueTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumId: string;
  coverUrl?: string;
  duration?: number;
}
export type QueueReply =
  | { status: "missing" }
  | { status: "unchanged"; stamp: string }
  | { status: "queue"; stamp: string; tracks: QueueTrack[]; truncated: boolean };
export interface QueuePort {
  read(stamp?: string): Promise<QueueReply>;
}

export const nativeQueuePort: QueuePort = {
  async read(stamp) {
    if (!window.__TAURI__) throw new Error("读取网易云播放队列需要 Windows 客户端。");
    return window.__TAURI__.core.invoke<QueueReply>("netease_queue", { stamp: stamp ?? null });
  },
};

/** What NetEase reports through its local DevTools port, when it was started with one. */
export interface DebugState {
  available: boolean;
  trackId?: string;
  playback?: "playing" | "paused" | "stopped";
  mode?: string;
  duration?: number;
  /** Seconds into the song; NetEase reports whole seconds. */
  position?: number;
}
export interface DebugPort {
  state(): Promise<DebugState>;
  /** Ask NetEase to play a song that is already in its queue; the queue order is untouched. */
  play(trackId: string): Promise<void>;
  /**
   * Move to `position` seconds in `trackId`, which must still be the song NetEase plays.
   * Resolves with the position NetEase was sent to (a trial clip limits the range).
   */
  seek(trackId: string, position: number): Promise<number>;
  /** Close NetEase and start it again with the debugging port. Only from an explicit button. */
  restart(): Promise<void>;
}
export const nativeDebugPort: DebugPort = {
  async state() {
    if (!window.__TAURI__) return { available: false };
    return window.__TAURI__.core.invoke<DebugState>("netease_debug_state");
  },
  async play(trackId) {
    if (!window.__TAURI__) throw new Error("让网易云切歌需要 Windows 客户端。");
    await window.__TAURI__.core.invoke("netease_debug_play", { trackId });
  },
  async seek(trackId, position) {
    if (!window.__TAURI__) throw new Error("调整网易云的播放进度需要 Windows 客户端。");
    return window.__TAURI__.core.invoke<number>("netease_debug_seek", { trackId, position });
  },
  async restart() {
    if (!window.__TAURI__) throw new Error("重新启动网易云需要 Windows 客户端。");
    await window.__TAURI__.core.invoke("netease_debug_restart");
  },
};

/** NetEase's public image server resizes on request; 1024 matches the sharp lifted print. */
export function queueCover(url?: string, size = 1024): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !/^p\d+\.music\.126\.net$/i.test(parsed.hostname) || parsed.port) return undefined;
    parsed.search = `?param=${size}y${size}`;
    parsed.hash = "";
    return parsed.href;
  } catch {
    return undefined;
  }
}

export const isNeteaseSource = (source?: ExternalMediaSource) =>
  source?.kind === "netease" || source?.player === "netease";

/** A queue song's box and its single track share this ID. */
export const queueTrackKey = (track?: QueueTrack) => (track ? `netease-track:${track.id}` : "");

/**
 * One shelf case per song, in queue order: moving one case is moving one song. Songs from
 * the same album repeat its cover. Nothing here is playable by Rhine itself.
 */
export function queueLibrary(tracks: readonly QueueTrack[], sourceName: string): MusicLibrary {
  const albums = new Map<string, MusicAlbum>();
  tracks.forEach((track, position) => {
    const key = queueTrackKey(track);
    // The same song can be queued twice; one case per song keeps the IDs unique.
    if (albums.has(key)) return;
    albums.set(key, {
      id: key, title: track.title, artist: track.artist || "歌手未提供",
      genreId: "external", rawGenres: [], folder: "", coverUrl: queueCover(track.coverUrl),
      tracks: [{
        id: key, albumId: key, title: track.title, artist: track.artist,
        trackNumber: position + 1, duration: track.duration ?? 0, format: "网易云音乐",
        browserPlayable: false, audioUrl: "", relativePath: "",
      } satisfies MusicTrack],
      producers: [], offline: false,
    });
  });
  return {
    version: 1, roots: [], scan: { running: false }, onlineEnabled: false,
    genres: albums.size ? [{ id: "external", name: sourceName }] : [],
    albums: [...albums.values()],
  };
}

const normalize = (text: string) =>
  text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const artistNames = (text: string) =>
  new Set(normalize(text).split(/\s*(?:\/|,|，|、|&|;|；| feat\.? | ft\.? )\s*/).filter(Boolean));

/**
 * The queue entry that is playing. NetEase's own song ID decides when its debugging port
 * reports one; otherwise the title the media session reports, preferring a shared artist
 * when several songs share it. Undefined when the song is not in the queue.
 */
export function playingQueueTrack(tracks: readonly QueueTrack[], source?: ExternalMediaSource, debug?: DebugState) {
  if (debug?.available && debug.trackId) return tracks.find((track) => track.id === debug.trackId);
  const title = normalize(source?.title ?? "");
  if (!title) return undefined;
  const candidates = tracks.filter((track) => normalize(track.title) === title);
  if (candidates.length < 2) return candidates[0];
  const reported = artistNames(source?.artist ?? "");
  return candidates.find((track) => [...artistNames(track.artist)].some((name) => reported.has(name))) ?? candidates[0];
}

/** How long after a seek readings that still show the old position are ignored. */
const SEEK_HOLD_MS = 1500;

/**
 * NetEase reports its position in whole seconds, about once a second. This keeps a clock
 * running between readings so the timeline advances evenly and does not step back while a
 * song simply plays; a reading that disagrees (a seek, another song, a pause) resets it.
 * The clock never runs more than a second past the last reading, so slower playback or
 * buffering makes it wait instead of running ahead and jumping back.
 */
export class PlaybackClock {
  /** Seconds, when NetEase reports a length. */
  duration: number | undefined;
  private track = "";
  private base: number | undefined;
  private at = 0;
  private playing = false;
  private hold = -Infinity;
  /** The last reading taken as true (or the target of Rhine's own seek). */
  private read = 0;

  /** A reading taken at `now` (monotonic milliseconds). */
  update(state: DebugState, now: number): void {
    const position = state.available ? state.position : undefined;
    const track = state.available ? state.trackId ?? "" : "";
    const playing = state.available && state.playback === "playing";
    this.duration = state.available ? state.duration : undefined;
    if (position === undefined) {
      this.base = undefined;
      this.track = track;
      this.playing = playing;
      return;
    }
    const estimate = track === this.track ? this.position(now) : undefined;
    // A whole-second reading means the true position is somewhere within that second.
    const agrees = estimate !== undefined && estimate >= position - 0.25 && estimate < position + 1.25;
    this.track = track;
    if (estimate !== undefined && !agrees && now < this.hold) {
      // A seek was just sent and NetEase still shows where it was: keep the target.
      this.base = estimate;
      this.at = now;
      this.playing = playing;
      return;
    }
    if (!agrees || !playing || !this.playing) {
      this.base = position;
      this.at = now;
    }
    this.read = position;
    this.playing = playing;
  }

  /** The user moved the timeline: show the target at once. */
  seek(position: number, now: number): void {
    this.base = position;
    this.at = now;
    this.read = position;
    this.hold = now + SEEK_HOLD_MS;
  }

  /** The seek did not happen: believe NetEase's next reading at once. */
  release(): void {
    this.hold = -Infinity;
  }

  /** Estimated seconds into the song at `now`; undefined when NetEase reports none. */
  position(now: number): number | undefined {
    if (this.base === undefined) return undefined;
    const value = this.playing ? Math.min(this.base + Math.max(0, now - this.at) / 1000, this.read + 1) : this.base;
    return this.duration ? Math.min(value, this.duration) : value;
  }
}

export interface QueueControl {
  /** The user wants selecting a case to switch NetEase's song. */
  enabled: boolean;
  /** NetEase's debugging port answered the last poll. */
  available: boolean;
  status: string;
  /** A poll found the port closed: offer to restart NetEase with it. */
  restart: boolean;
}
export function queueControlStatus(control: Pick<QueueControl, "enabled" | "available">, debug?: DebugState) {
  if (!control.enabled) return "";
  if (!control.available) return "未检测到网易云调试端口（9233）。以调试端口启动网易云后，选中盒子才会切歌。";
  return debug?.mode === "playFm"
    ? "已连接网易云调试端口。私人 FM 模式下不切歌。"
    : "已连接网易云调试端口：选中盒子约半秒后，网易云播放这首歌。";
}

export function queueSettingMarkup(source: ExternalMediaSource | undefined, enabled: boolean, status: string, control: QueueControl) {
  if (!isNeteaseSource(source)) return "";
  const queue = `<label class="settings-row external-queue-consent"><span>显示网易云播放队列<small>读取网易云保存在本机的当前播放队列，仅取歌曲编号、歌名、歌手、专辑、时长和封面地址；封面从网易云公开图片服务器加载。不读取账号、Cookie、播放历史或本地歌曲路径。</small></span><input type="checkbox" id="netease-queue" ${enabled ? "checked" : ""}></label><p class="external-note" data-queue-status role="status">${esc(status)}</p>`;
  if (!enabled) return queue;
  return `${queue}<label class="settings-row external-queue-consent"><span>选中盒子时让网易云切歌<small>通过网易云的调试端口（仅本机 127.0.0.1:9233）让它播放队列中的这首歌，不改变队列顺序；同时显示播放进度，并可拖动进度条。需要以调试端口启动网易云；端口开启期间，本机其他程序也能控制网易云。</small></span><input type="checkbox" id="netease-control" ${control.enabled ? "checked" : ""}></label><p class="external-note" data-debug-status role="status">${esc(control.status)}</p><div class="panel-actions" data-debug-restart ${control.restart ? "" : "hidden"}><button data-action="netease-restart-debug">以调试端口重新启动网易云</button></div>`;
}
