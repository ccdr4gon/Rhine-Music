import type { ExternalMediaSource, PlayerModule } from "../../external_player/external-media";

// Windows may only know NetEase as "cloudmusic.exe".
export const NETEASE_NAME = "网易云音乐";

export const isNeteaseSource = (source?: ExternalMediaSource) =>
  source?.kind === "netease" || source?.player === "netease";

/**
 * NetEase in the source list (music-sources.ts): the default link while nothing was ever
 * connected, then remembered by this module's id like any source it connected (2026-10-06).
 */
export const NETEASE_PLAYER: PlayerModule = { id: "netease", name: NETEASE_NAME, match: isNeteaseSource };
