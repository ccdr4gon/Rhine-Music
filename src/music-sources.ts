import { readSourceLink } from "./external_player/external-media";
import type { ExternalMediaSource, MediaPort, PreferredPlayer, SourceLink, SourceLinks } from "./external_player/external-media";
import { NETEASE_PLAYER } from "./netease_music/connector/player";
import { QQ_MUSIC_PLAYER } from "./qq_music/connector/player";

/**
 * The players Rhine knows by name. Any other player that publishes a Windows media session is
 * still listed, as a source of its own. Each module keeps its data and its connector in its
 * own folder (docs/architecture/overview.md).
 */
export const PLAYER_MODULES = [NETEASE_PLAYER, QQ_MUSIC_PLAYER] as const;

/**
 * The default link while nothing was ever connected (AGENTS.md, 2026-10-04): NetEase Cloud Music
 * is connected when it is found. QQ Music and every other player are connected by themselves only
 * once the user has picked them (playerLinks).
 */
export const PREFERRED_PLAYER: PreferredPlayer = NETEASE_PLAYER;

/**
 * What the app's connection remembers (the owner, 2026-10-06: "when connected to a source like
 * netease, next time program starts, keep it connected and do not let the user choose again"):
 * the source it was last connected to, saved with the preferences (`playerLink`) and connected
 * again by itself, also after a restart; NetEase while nothing was ever connected. `saved` is
 * what the preferences hold; `remember` saves a new one.
 */
export function playerLinks(saved: unknown, remember: (link: SourceLink | null) => void): SourceLinks {
  return { players: PLAYER_MODULES, fallback: PREFERRED_PLAYER, remembered: readSourceLink(saved, PLAYER_MODULES), remember };
}

/** The known player a source belongs to, if any. */
export const playerModule = (source?: ExternalMediaSource) =>
  source ? PLAYER_MODULES.find((player) => player.match(source)) : undefined;

/** A source as the module of its player shows it (QQ Music's under its own name); any other as listed. */
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
