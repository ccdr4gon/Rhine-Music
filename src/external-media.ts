import type { MusicLibrary } from "./music-types";
import { escapeHtml as esc } from "./html";

export type MediaAction = "toggle" | "previous" | "next" | "stop" | "seek";
export interface ExternalMediaSource {
  id: string;
  name: string;
  kind: "smtc" | "netease";
  title: string;
  artist: string;
  album: string;
  coverUrl?: string;
  playback: "playing" | "paused" | "stopped" | "unknown";
  position?: number;
  duration?: number;
  capabilities: Record<MediaAction, boolean>;
  warning?: string;
}
export interface MediaSnapshot { sources: ExternalMediaSource[]; warning?: string }
export interface MediaPort {
  snapshot(): Promise<MediaSnapshot>;
  control(sourceId: string, action: MediaAction, position: number | undefined, allowGlobalMediaKeys: boolean): Promise<unknown>;
}

export const nativeMediaPort: MediaPort = {
  async snapshot() {
    if (!window.__TAURI__) throw new Error("连接外部播放器需要 Windows 客户端。");
    return window.__TAURI__.core.invoke<MediaSnapshot>("media_snapshot");
  },
  async control(sourceId, action, position, allowGlobalMediaKeys) {
    if (!window.__TAURI__) throw new Error("连接外部播放器需要 Windows 客户端。");
    return window.__TAURI__.core.invoke("media_control", { sourceId, action, position, allowGlobalMediaKeys });
  },
};

/** Selection belongs to the user. A missing session never transfers its controls. */
export class ExternalMediaConnection {
  sources: ExternalMediaSource[] = [];
  selectedId: string | null = null;
  disconnected = false;
  allowGlobalMediaKeys = false;
  warning = "";
  error = "";
  busy = false;
  private refreshTask?: Promise<void>;
  constructor(private readonly port: MediaPort) {}

  get selected(): ExternalMediaSource | undefined {
    return this.disconnected ? undefined : this.sources.find(source => source.id === this.selectedId);
  }
  select(id: string): boolean {
    if (!this.sources.some(source => source.id === id)) return false;
    this.selectedId = id;
    this.disconnected = false;
    this.allowGlobalMediaKeys = false;
    this.error = "";
    return true;
  }
  disconnect(): void {
    this.selectedId = null;
    this.disconnected = false;
    this.allowGlobalMediaKeys = false;
    this.error = "";
  }
  setGlobalMediaKeys(allowed: boolean): void {
    this.allowGlobalMediaKeys = allowed && this.selected?.kind === "netease";
  }
  refresh(): Promise<void> {
    if (this.refreshTask) return this.refreshTask;
    this.refreshTask = this.readSnapshot().finally(() => { this.refreshTask = undefined; });
    return this.refreshTask;
  }
  private async readSnapshot(): Promise<void> {
    try {
      const snapshot = await this.port.snapshot();
      this.sources = snapshot.sources;
      this.warning = snapshot.warning || "";
      if (this.selectedId && !this.sources.some(source => source.id === this.selectedId)) {
        this.disconnected = true;
        this.allowGlobalMediaKeys = false;
      }
    } catch (error) {
      this.sources = [];
      this.warning = String(error instanceof Error ? error.message : error);
      // An unreadable snapshot is not proof that a session disappeared.
      // Keep its exact ID, but expose no stale metadata or controls while retrying.
      // A prior confirmed disappearance remains locked until explicit selection.
      this.allowGlobalMediaKeys = false;
    }
  }
  can(action: MediaAction): boolean {
    const source = this.selected;
    if (!source || this.busy || !source.capabilities[action]) return false;
    if (source.kind === "netease" && !this.allowGlobalMediaKeys) return false;
    return action !== "seek" || typeof source.duration === "number" && Number.isFinite(source.duration) && source.duration > 0;
  }
  async control(action: MediaAction, position?: number): Promise<boolean> {
    const source = this.selected;
    if (!source || !this.can(action)) return false;
    if (action === "seek" && (typeof position !== "number" || !Number.isFinite(position))) return false;
    const targetId = source.id;
    this.busy = true;
    this.error = "";
    try {
      await this.port.control(targetId, action,
        action === "seek" ? Math.max(0, Math.min(source.duration!, position!)) : undefined,
        source.kind === "netease" && this.allowGlobalMediaKeys);
      return true;
    } catch (error) {
      // A late response for a previous selection must not overwrite its successor.
      if (this.selectedId === targetId) this.error = String(error instanceof Error ? error.message : error);
      return false;
    } finally {
      this.busy = false;
    }
  }
}

export function mediaCover(source?: ExternalMediaSource): string | undefined {
  return source?.coverUrl && /^data:image\/(?:png|jpe?g|webp|gif|bmp);base64,/i.test(source.coverUrl)
    ? source.coverUrl : undefined;
}
export function mediaVisualKey(source?: ExternalMediaSource): string {
  return source ? JSON.stringify([source.id, source.name, source.title, source.artist, source.album, mediaCover(source)]) : "";
}
/** A single observed song is a card, never a fabricated album or audio queue. */
export function mediaLibrary(source?: ExternalMediaSource): MusicLibrary {
  return {
    version: 1, roots: [], scan: { running: false }, onlineEnabled: false,
    genres: source ? [{ id: "external", name: source.name }] : [],
    albums: source ? [{
      id: `external:${source.id}`, title: source.title.trim() || "曲名未提供",
      artist: source.artist.trim() || "歌手未提供", genreId: "external",
      rawGenres: [], folder: "", coverUrl: mediaCover(source),
      tracks: [], producers: [], offline: false,
    }] : [],
  };
}
export function mediaPlaybackLabel(source?: ExternalMediaSource): string {
  if (!source) return "未连接";
  return { playing: "正在播放", paused: "已暂停", stopped: "已停止", unknown: "播放状态未知" }[source.playback];
}
export function mediaTime(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
  const seconds = Math.floor(value);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function mediaConnectionLabel(connection: ExternalMediaConnection): string {
  const source = connection.selected;
  if (source) return `${source.name} · ${mediaPlaybackLabel(source)}`;
  if (connection.disconnected) return "来源已断开，请重新选择播放器";
  return connection.selectedId ? "暂时无法读取播放器，正在重试" : "选择播放器后显示当前曲目";
}

export function mediaSourcesMarkup(connection: ExternalMediaConnection): string {
  return connection.sources.length ? connection.sources.map(source => {
    const selected = connection.selected?.id === source.id;
    return `<button class="external-source" data-media-source="${esc(source.id)}" aria-pressed="${selected}"><span><strong>${esc(source.name)}</strong><small>${esc(source.title || "曲名未提供")}${source.artist ? ` · ${esc(source.artist)}` : ""}</small></span><em>${selected ? "已连接" : "连接"}</em></button>`;
  }).join("") : connection.selectedId && !connection.disconnected
    ? '<p class="external-unavailable">播放器资料暂时不可用，正在重试。恢复前已暂停控制。</p>'
    : '<p class="external-unavailable">没有发现播放器。请在外部播放器中开始播放，再刷新来源。</p>';
}

export function mediaPermissionMarkup(connection: ExternalMediaConnection): string {
  if (connection.selected?.kind !== "netease") return "";
  return `<label class="settings-row external-global-consent"><span>允许发送全局媒体键<small>仅在当前来源缺少定向控制时使用，可能影响其他播放器。每次重新连接都需要确认。</small></span><input type="checkbox" id="external-global-keys" ${connection.allowGlobalMediaKeys ? "checked" : ""}></label>`;
}
