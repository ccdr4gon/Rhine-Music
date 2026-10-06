import type { MusicAlbum, MusicGenre, MusicLibrary, MusicPlaylist, MusicTrack } from "../../music-types";

/**
 * Local music as the owner defined it (2026-10-06): "Local music means choosing a main folder, and
 * each playlist will be a subfolder." The service lists the main folder's playlists (each direct
 * subfolder with its songs at any depth, and the main folder's own songs first); here each playlist
 * becomes a shelf column and each song a case of its own, as NetEase's queue maps its songs.
 */

/** One song of a folder playlist, as its case shows it. */
export interface LocalSong {
  /** The case's ID: the song's own track ID. */
  id: string;
  track: MusicTrack;
  /** The album record the song was indexed with: its cover and, when it is the song's album, its introduction. */
  album: MusicAlbum;
  playlist: MusicPlaylist;
  /** The song's place in its playlist, from 0. */
  position: number;
}

/** The shelf for the local library: one column per playlist, one case per song. */
export interface LocalShelf {
  albums: MusicAlbum[];
  genres: MusicGenre[];
  /** Each case's song, by case ID. */
  songs: Map<string, LocalSong>;
  /** Each playlist's songs in order, by playlist ID (the column's genre ID). */
  lists: Map<string, LocalSong[]>;
}

/**
 * A song's case. It holds the song as its one track, so the play button and the details act on
 * that song; a demonstration song holds none (it has a cover and nothing to play).
 */
function songCase(song: LocalSong, demo: boolean): MusicAlbum {
  const { track, album, playlist } = song;
  return {
    id: song.id, title: track.title, artist: track.artist, year: track.year,
    genreId: playlist.id, rawGenres: [], folder: album.folder, coverUrl: album.coverUrl,
    tracks: demo ? [] : [track], producers: [], offline: album.offline,
  };
}

/**
 * The columns are the playlists in the service's order; the cases are their songs in playlist
 * order. A song the albums do not hold (an index from before a rescan) has no case, and a song
 * is shown once. Playlists without a case are left out.
 */
export function playlistShelf(library: Pick<MusicLibrary, "albums" | "playlists">, demo = false): LocalShelf {
  const tracks = new Map<string, { track: MusicTrack; album: MusicAlbum }>();
  for (const album of library.albums) for (const track of album.tracks) tracks.set(track.id, { track, album });
  const songs = new Map<string, LocalSong>();
  const lists = new Map<string, LocalSong[]>();
  const albums: MusicAlbum[] = [];
  const genres: MusicGenre[] = [];
  for (const playlist of library.playlists ?? []) {
    const list: LocalSong[] = [];
    for (const id of playlist.trackIds) {
      const found = tracks.get(id);
      if (!found || songs.has(id)) continue;
      const song: LocalSong = { id, ...found, playlist, position: list.length };
      songs.set(id, song);
      list.push(song);
      albums.push(songCase(song, demo));
    }
    if (!list.length || lists.has(playlist.id)) continue;
    lists.set(playlist.id, list);
    genres.push({ id: playlist.id, name: playlist.name, albumCount: list.length });
  }
  return { albums, genres, songs, lists };
}

/** The songs of one playlist, in its order (the song scene's rows, the player's queue). */
export function playlistSongs(shelf: Pick<LocalShelf, "lists">, playlistId: string): LocalSong[] {
  return shelf.lists.get(playlistId) ?? [];
}

/**
 * Whether the album record's introduction describes this song's album: the song names that
 * album, or names none (the record is its folder), or is the record's only song.
 */
export function introductionFits(song: Pick<LocalSong, "track" | "album">): boolean {
  return !song.track.album || song.track.album === song.album.title || song.album.tracks.length === 1;
}

/**
 * The player's queue for a song: the playable songs of its playlist in order, from which the
 * player continues; the song itself always (so a song the browser cannot play says why).
 */
export function playlistQueue(shelf: Pick<LocalShelf, "lists">, song: LocalSong): MusicTrack[] {
  return playlistSongs(shelf, song.playlist.id)
    .filter((other) => other.id === song.id || (other.track.browserPlayable && !other.album.offline))
    .map((other) => other.track);
}
