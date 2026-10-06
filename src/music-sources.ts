import { readSourceLink } from "./external_player/external-media";
import type { ExternalMediaSource, MediaPort, PreferredPlayer, SourceLink, SourceLinks } from "./external_player/external-media";
import { NETEASE_PLAYER } from "./netease_music/connector/player";
import { QQ_MUSIC_PLAYER } from "./qq_music/connector/player";

/**
 * The current source (the owner, 2026-10-06: "let's delete the concept of skin mode or local music
 * mode, now we only have the different concept"): 本地音乐, or a player (which player is the
 * connection's own choice, `playerLink`). A page shows one source; switching between 本地音乐 and a
 * player loads the page again with the other one (sourceAddress), without the opening animation
 * (takeSourceSwitch). Choosing another player is done in place.
 */
export type SourceKind = "local" | "player";

/** The source a page shows, from its address: a player for `?source=player` (or an earlier build's `?mode=external`), else 本地音乐. */
export function pageSource(search: string): SourceKind {
  const query = new URLSearchParams(search);
  return query.get("source") === "player" || query.get("mode") === "external" ? "player" : "local";
}

/**
 * The address of the page that shows `next`: `?source=player` for a player, nothing for 本地音乐.
 * Every other parameter stays; an earlier build's `mode` goes.
 */
export function sourceAddress(href: string, next: SourceKind): string {
  const url = new URL(href);
  url.searchParams.delete("mode");
  if (next === "player") url.searchParams.set("source", "player");
  else url.searchParams.delete("source");
  url.hash = "";
  return url.href;
}

/**
 * What a switch of the source hands to the page it loads, once: the page skips the opening
 * animation; `panel` opens the 播放器 panel again (a player was chosen in it), and `session` is the
 * media session the user picked there, connected even when what is remembered cannot tell it apart
 * (two sessions of one app, or a player without an app id). Never saved with the preferences.
 */
export interface SourceSwitch { to: SourceKind; panel: boolean; session?: string }
const SWITCH_KEY = "rhine-source-switch";
type SwitchStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function markSourceSwitch(storage: SwitchStorage | undefined, value: SourceSwitch): void {
  try { storage?.setItem(SWITCH_KEY, JSON.stringify(value)); } catch {}
}
/**
 * The switch that loaded this page, if one did: read and removed at once, so that a later load
 * (a reload, the next start) is an ordinary start; one meant for the other source counts as none.
 */
export function takeSourceSwitch(storage: SwitchStorage | undefined, page: SourceKind): SourceSwitch | undefined {
  try {
    const raw = storage?.getItem(SWITCH_KEY);
    storage?.removeItem(SWITCH_KEY);
    const value: unknown = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object" || (value as SourceSwitch).to !== page) return undefined;
    const { panel, session } = value as Partial<SourceSwitch>;
    return {
      to: page, panel: panel === true,
      ...(typeof session === "string" && session.length > 0 && session.length <= 200 ? { session } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * The players Rhine knows by name. Any other player that publishes a Windows media session is
 * still listed, as a source of its own. Each module keeps its data and its connector in its
 * own folder (docs/architecture/overview.md).
 */
export const PLAYER_MODULES = [NETEASE_PLAYER, QQ_MUSIC_PLAYER] as const;

/**
 * The default link while no player was ever connected (AGENTS.md, 2026-10-04): NetEase Cloud Music
 * is connected when it is found, once the user opens 播放器 (the first start is 本地音乐). QQ Music
 * and every other player are connected by themselves only once the user has picked them
 * (playerLinks).
 */
export const PREFERRED_PLAYER: PreferredPlayer = NETEASE_PLAYER;

/**
 * What the app's connection remembers (the owner, 2026-10-06: "when connected to a source like
 * netease, next time program starts, keep it connected and do not let the user choose again"):
 * the player it was last connected to, saved with the preferences (`playerLink`) and connected
 * again by itself: when it comes back, at the next start while a player was the current source,
 * and when the user opens 播放器 from 本地音乐; NetEase while no player was ever connected. `saved`
 * is what the preferences hold; `remember` saves a new one.
 */
export function playerLinks(saved: unknown, remember: (link: SourceLink | null) => void): SourceLinks {
  return { players: PLAYER_MODULES, fallback: PREFERRED_PLAYER, remembered: readSourceLink(saved, PLAYER_MODULES), remember };
}

/** The known player a source belongs to, if any. */
export const playerModule = (source?: ExternalMediaSource) =>
  source ? PLAYER_MODULES.find((player) => player.match(source)) : undefined;

/** A source as the module of its player shows it (QQ Music's and NetEase's under their own names); any other as listed. */
export const playerSource = (source: ExternalMediaSource): ExternalMediaSource =>
  playerModule(source)?.show?.(source) ?? source;

/**
 * The media port the app reads: each known player's sources as its module shows them, everything
 * else as the snapshot has it. Controls go to the port unchanged (the same source, action,
 * position and global media-key consent).
 */
export function playerMediaPort(port: MediaPort): MediaPort {
  return {
    async snapshot() {
      const snapshot = await port.snapshot();
      return { ...snapshot, sources: snapshot.sources.map(playerSource) };
    },
    control: (sourceId, action, position, allowGlobalMediaKeys) => port.control(sourceId, action, position, allowGlobalMediaKeys),
  };
}
