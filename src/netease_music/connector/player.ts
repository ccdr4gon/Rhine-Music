import type { ExternalMediaSource, PlayerModule } from "../../external_player/external-media";

// Windows may only know NetEase as "cloudmusic.exe".
export const NETEASE_NAME = "网易云音乐";

export const isNeteaseSource = (source?: ExternalMediaSource) =>
  source?.kind === "netease" || source?.player === "netease";

/**
 * NetEase in the source list (music-sources.ts): the default link while nothing was ever
 * connected, then remembered by this module's id like any source it connected (2026-10-06).
 * The media session of its own program is listed as 网易云音乐, not by its app id `cloudmusic.exe`
 * (the owner, 2026-10-06: "show 网易云音乐 instead"), as the native side does (media::player_source).
 * Any other session taken for NetEase keeps the name Windows gives it, so that it can be told apart;
 * the window-title fallback keeps its own name, which says what it is.
 */
export const NETEASE_PLAYER: PlayerModule = {
  id: "netease",
  name: NETEASE_NAME,
  match: isNeteaseSource,
  show: (source) => isNeteaseProgram(source) ? { ...source, name: NETEASE_NAME } : source,
};
/** NetEase's own program's media session: its app id (or, without one, its name) is `cloudmusic.exe`. */
function isNeteaseProgram(source: ExternalMediaSource) {
  return source.kind === "smtc" && (source.app ?? source.name).toLowerCase() === "cloudmusic.exe";
}
