import type { MusicLibrary } from "../music-types";
import { escapeHtml as esc } from "../html";

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
  /**
   * The player the source belongs to (music-sources.ts): "netease" for NetEase Cloud Music
   * (either connection kind), "qqmusic" for QQ Music's media session.
   */
  player?: "netease" | "qqmusic";
  /**
   * The app id Windows reports for the media session (its AppUserModelId), when it has one: the
   * same for every session of that player and across restarts, unlike `id`. A player Rhine does
   * not know by name is remembered by it (SourceLink).
   */
  app?: string;
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

/** The player that is connected by default: its display name and how to recognise its sources. */
export interface PreferredPlayer { name: string; match(source: ExternalMediaSource): boolean }
/** A player Rhine knows by name (music-sources.ts), by its `player` mark in the snapshot. */
export interface PlayerModule extends PreferredPlayer {
  id: NonNullable<ExternalMediaSource["player"]>;
  /** Its sources as its module shows them (QQ Music's under its own name); as listed when absent. */
  show?(source: ExternalMediaSource): ExternalMediaSource;
}

/**
 * A source as it is remembered across restarts (`playerLink` in the preferences; the owner,
 * 2026-10-06): a player Rhine knows by its module id; any other by the app id of its media
 * session, with the name it was listed under (to say what is awaited). Never a source id, which
 * lasts one session, and never anything the player plays.
 */
export type SourceLink = { player: string } | { app: string; name: string };
const APP_ID_LIMIT = 512, NAME_LIMIT = 200;
const appId = (app: unknown): app is string => typeof app === "string" && app.length > 0 && app.length <= APP_ID_LIMIT;
/**
 * At most `limit` UTF-16 units, never ending in the first half of a character: JSON would carry
 * the half as "\udXXX", which the native side (serde_json in save_preferences) refuses, and with
 * it every later save of the preferences.
 */
const clip = (text: string, limit: number) =>
  text.slice(0, text.length > limit && /[\uD800-\uDBFF]/.test(text[limit - 1]) ? limit - 1 : limit);

/** How a source is remembered: by its player's module, else by its session's app id; without either, it cannot be. */
export function sourceLink(source: ExternalMediaSource, players: readonly PlayerModule[] = []): SourceLink | undefined {
  const player = players.find(player => player.match(source));
  if (player) return { player: player.id };
  return appId(source.app) ? { app: source.app, name: clip(source.name.trim() || source.app, NAME_LIMIT) } : undefined;
}

/**
 * A saved link, checked: undefined while nothing was ever connected (or what is saved cannot be
 * read), null after the user disconnected. main.rs (`remembers_source`) accepts the same when it
 * decides whether a plain start resumes the player skin.
 */
export function readSourceLink(value: unknown, players: readonly PlayerModule[]): SourceLink | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { player, app, name } = value as Record<string, unknown>;
  if (typeof player === "string") return players.some(known => known.id === player) ? { player } : undefined;
  if (!appId(app)) return undefined;
  return { app, name: typeof name === "string" && name.trim() ? clip(name.trim(), NAME_LIMIT) : app };
}

/** What the connection remembers, and from where (music-sources.ts playerLinks). */
export interface SourceLinks {
  /** The players Rhine knows by name: a source of theirs is remembered by its module. */
  players?: readonly PlayerModule[];
  /** The default link while nothing was ever connected (NetEase, AGENTS.md 2026-10-04). */
  fallback?: PreferredPlayer;
  /** What an earlier session remembered (readSourceLink): undefined while nothing was ever connected, null after a disconnect. */
  remembered?: SourceLink | null;
  /** Told the source to remember each time it changes, to be saved with the preferences. */
  remember?(link: SourceLink | null): void;
}

/**
 * Selection belongs to the user. A missing session never transfers its controls to another
 * player. The connection remembers the source it was last connected to, also across restarts
 * (`links.remembered`), and that source is the default link: it is connected when it is found
 * while nothing is connected, and connected again when it comes back as a new session (only when
 * exactly one session is its own: never a guess between two). Selecting another source replaces
 * it; a disconnect forgets it, and then nothing is connected by itself until the user selects a
 * source. While nothing was ever connected, the fallback (NetEase) is the default link. A new
 * connection never carries the global media-key consent over.
 */
export class ExternalMediaConnection {
  sources: ExternalMediaSource[] = [];
  selectedId: string | null = null;
  disconnected = false;
  allowGlobalMediaKeys = false;
  warning = "";
  error = "";
  busy = false;
  private refreshTask?: Promise<void>;
  /**
   * The source to connect by itself: the one last connected, also in an earlier session;
   * undefined while nothing was ever connected (the fallback is the default link then); null once
   * the user disconnected, or connected a source that cannot be remembered.
   */
  private link: SourceLink | null | undefined;
  private linked?: PreferredPlayer;
  constructor(private readonly port: MediaPort, private readonly links: SourceLinks = {}) {
    this.link = links.remembered;
    this.linked = this.linkedPlayer();
  }

  get selected(): ExternalMediaSource | undefined {
    return this.disconnected ? undefined : this.sources.find(source => source.id === this.selectedId);
  }
  /** The default link: the remembered source, or the fallback while nothing was ever connected. */
  get preferred(): PreferredPlayer | undefined {
    return this.linked;
  }
  /** The source remembered for the next start (what `remember` was last told). */
  get remembered(): SourceLink | null | undefined {
    return this.link;
  }
  /** The default link is a source the user was connected to, rather than the fallback. */
  get remembers(): boolean {
    return !!this.link;
  }
  /** The default link is in force: the preferred player is, or will be, the connected one. */
  get followsPreferred(): boolean {
    return !!this.preferred;
  }
  /** ... and it is not there now: it will be connected by itself as soon as it is found. */
  get awaitsPreferred(): boolean {
    return this.followsPreferred && (this.selectedId === null || this.disconnected);
  }
  /** ... but it is there more than once (two sessions of one app): the user has to pick one. */
  get ambiguous(): boolean {
    return this.awaitsPreferred && this.sources.filter(source => this.preferred!.match(source)).length > 1;
  }
  select(id: string): boolean {
    const source = this.sources.find(source => source.id === id);
    if (!source) return false;
    this.selectedId = id;
    this.disconnected = false;
    this.allowGlobalMediaKeys = false;
    this.error = "";
    // It replaces the remembered source; one that cannot be remembered leaves none to connect by itself.
    this.setLink(sourceLink(source, this.links.players) ?? null);
    return true;
  }
  disconnect(): void {
    this.selectedId = null;
    this.disconnected = false;
    this.allowGlobalMediaKeys = false;
    this.error = "";
    this.setLink(null);
  }
  private setLink(link: SourceLink | null): void {
    if (JSON.stringify(link) === JSON.stringify(this.link)) return;
    this.link = link;
    this.linked = this.linkedPlayer();
    this.links.remember?.(link);
  }
  private linkedPlayer(): PreferredPlayer | undefined {
    const link = this.link;
    if (link === undefined) return this.links.fallback;
    if (link === null) return undefined;
    if ("player" in link) {
      return this.links.players?.find(player => player.id === link.player)
        ?? { name: link.player, match: source => source.player === link.player };
    }
    return { name: link.name, match: source => source.app === link.app };
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
      this.connectPreferred();
    } catch (error) {
      this.sources = [];
      this.warning = String(error instanceof Error ? error.message : error);
      // An unreadable snapshot is not proof that a session disappeared.
      // Keep its exact ID, but expose no stale metadata or controls while retrying.
      // A prior confirmed disappearance remains locked until explicit selection.
      this.allowGlobalMediaKeys = false;
    }
  }
  /** The default link. A new connection: the global media-key consent is asked for again. */
  private connectPreferred(): void {
    if (!this.awaitsPreferred) return;
    const found = this.sources.filter(source => this.preferred!.match(source));
    // Two sessions of the one player: never a guess between them.
    if (found.length !== 1) return;
    const [source] = found;
    this.selectedId = source.id;
    this.disconnected = false;
    this.allowGlobalMediaKeys = false;
    this.error = "";
    // Remembered from now on (the fallback becomes NetEase itself; a name it is listed under anew is kept).
    const link = sourceLink(source, this.links.players);
    if (link) this.setLink(link);
  }
  can(action: MediaAction): boolean {
    return !this.busy && this.offers(action);
  }
  /** Whether the player offers the action, also while another control is still on its way. */
  offers(action: MediaAction): boolean {
    const source = this.selected;
    if (!source || !source.capabilities[action]) return false;
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
/** A player's name after a word of Chinese: a space before a Latin one (「等待 QQ音乐…」). */
export const spacedName = (name: string) => /^[A-Za-z0-9]/.test(name) ? ` ${name}` : name;
/**
 * `playback`: the state to show when a better reading than the session's is known (NetEase's own).
 * While a remembered source is awaited, the words are only that it is awaited: nothing asks the
 * user to choose (the 播放器 panel still can change it).
 */
export function mediaConnectionLabel(connection: ExternalMediaConnection, playback?: ExternalMediaSource["playback"]): string {
  const source = connection.selected;
  if (source) return `${source.name} · ${mediaPlaybackLabel({ ...source, playback: playback ?? source.playback })}`;
  const preferred = connection.awaitsPreferred ? connection.preferred!.name : "";
  if (connection.ambiguous) return `${preferred}有多个媒体会话，请在“播放器”中选择要连接的一个`;
  if (connection.disconnected) return preferred ? `${preferred}已断开，再次出现时会自动重新连接` : "来源已断开，请重新选择播放器";
  if (connection.selectedId) return "暂时无法读取播放器，正在重试";
  if (preferred && connection.remembers) return `等待${spacedName(preferred)}…`;
  return preferred ? `未发现${preferred}；它出现后会自动连接，也可以选择其他播放器` : "选择播放器后显示当前曲目";
}

export function mediaSourcesMarkup(connection: ExternalMediaConnection): string {
  return connection.sources.length ? connection.sources.map(source => {
    const selected = connection.selected?.id === source.id;
    const preferred = connection.preferred?.match(source) ? " · 默认" : "";
    return `<button class="external-source" data-media-source="${esc(source.id)}" aria-pressed="${selected}"><span><strong>${esc(source.name)}</strong><small>${esc(source.title || "曲名未提供")}${source.artist ? ` · ${esc(source.artist)}` : ""}</small></span><em>${selected ? "已连接" : "连接"}${preferred}</em></button>`;
  }).join("") : connection.selectedId && !connection.disconnected
    ? '<p class="external-unavailable">播放器资料暂时不可用，正在重试。恢复前已暂停控制。</p>'
    : '<p class="external-unavailable">没有发现播放器。请在外部播放器中开始播放，再刷新来源。</p>';
}

export function mediaPermissionMarkup(connection: ExternalMediaConnection): string {
  if (connection.selected?.kind !== "netease") return "";
  return `<label class="settings-row external-global-consent"><span>允许发送全局媒体键<small>仅在当前来源缺少定向控制时使用，可能影响其他播放器。每次重新连接都需要确认。</small></span><input type="checkbox" id="external-global-keys" ${connection.allowGlobalMediaKeys ? "checked" : ""}></label>`;
}
