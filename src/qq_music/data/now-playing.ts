import type { ExternalMediaSource } from "../../external_player/external-media";

/**
 * QQ Music's data: the song its Windows media session shows, as the media snapshot carries it,
 * held in memory while it is shown and never saved. Nothing of QQ Music is read from disk, and
 * there is no queue or playlist: the shelf shows this one song as a card, like any other
 * player's (external-media.ts mediaLibrary). Reading its queue or playlists would need the
 * owner's consent first, field by field, as NetEase's have (AGENTS.md).
 */
export type QqNowPlaying = ExternalMediaSource & { player: "qqmusic" };

/**
 * QQ Music's session under its own name, whatever the snapshot calls it (Windows knows an
 * unpackaged program's session only by its app id, `QQMusic.exe`). Every other field is the
 * session's own reading, unchanged: nothing is added or guessed. QQ Music keeps an idle session
 * open while no song is loaded, and then there is simply no song; its controls are the ones the
 * session enables, nothing more.
 */
export function qqNowPlaying(source: ExternalMediaSource, name: string): QqNowPlaying {
  return { ...source, name, player: "qqmusic" };
}
