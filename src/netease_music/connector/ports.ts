import type { DebugState, PlaylistsReply, QueueReply } from "../data/queue";

// How Rhine reaches NetEase, through the native side: its saved play queue and playlists
// (each read only after the user switched it on) and its local debugging port. The command
// names are the client's own (src-tauri/src/main.rs, src-tauri/permissions/music.toml).
export interface QueuePort {
  /** `source` asks for the playlist the queue came from as well (playlist columns are on). */
  read(stamp?: string, source?: boolean): Promise<QueueReply>;
}
export interface PlaylistPort {
  read(stamp?: string): Promise<PlaylistsReply>;
}
export const nativePlaylistPort: PlaylistPort = {
  async read(stamp) {
    if (!window.__TAURI__) throw new Error("读取网易云歌单需要 Windows 客户端。");
    return window.__TAURI__.core.invoke<PlaylistsReply>("netease_playlists", { stamp: stamp ?? null });
  },
};

export const nativeQueuePort: QueuePort = {
  async read(stamp, source = false) {
    if (!window.__TAURI__) throw new Error("读取网易云播放队列需要 Windows 客户端。");
    return window.__TAURI__.core.invoke<QueueReply>("netease_queue", { stamp: stamp ?? null, source });
  },
};

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
