/**
 * One song of an external player's queue or playlist as Rhine shows it: display fields only,
 * never account data or the paths of local files. NetEase's queue and playlists have this
 * shape (netease_music/data/queue.ts); the song scene lists it (song-list.ts).
 */
export interface PlayerTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumId: string;
  coverUrl?: string;
  duration?: number;
}
