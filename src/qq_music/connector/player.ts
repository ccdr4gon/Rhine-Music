import type { ExternalMediaSource, PlayerModule } from "../../external_player/external-media";
import { qqNowPlaying } from "../data/now-playing";

/**
 * QQ Music is connected only through the Windows media session it publishes (the owner,
 * 2026-10-06: "for qq music, you can just use the SMTC"): the song it shows, play / pause,
 * previous / next, and its position, seeking and stop when the session reports them. Nothing
 * else of QQ Music is read or sent (no files, database, ports, COM, window titles or process
 * memory, no global media keys). The native side recognises its session by the whole app id
 * `QQMusic.exe` and marks it (src-tauri qq_music/connector, media::player_of).
 */
export const QQ_MUSIC_NAME = "QQ音乐";

/** By the native side's mark only, never by a name. */
export const isQqMusicSource = (source?: ExternalMediaSource) => source?.player === "qqmusic";

/**
 * QQ Music in the source list (music-sources.ts), shown under its own name. Not connected by
 * itself until the user picks it in 播放器; from then on it is the remembered source (by this
 * module's id, 2026-10-06), connected again when it comes back, also after a restart, until
 * another source is picked or the user disconnects. Nothing switches to it when another player goes.
 */
export const QQ_MUSIC_PLAYER: PlayerModule = {
  id: "qqmusic",
  name: QQ_MUSIC_NAME,
  match: isQqMusicSource,
  show: (source) => qqNowPlaying(source, QQ_MUSIC_NAME),
};
