import type { MusicAlbum, MusicLibrary, MusicPlaylist, MusicTrack } from "../../music-types";

/**
 * Visual samples only: two playlists of cover-only songs, in the shape the local service lists
 * a main folder (local_music/data/playlists.ts makes them columns and cases). Nothing here can
 * be played, and nothing is ever inserted into the user's actual music index.
 */
const ARTIST = "RHINE · 演示封面";
const song = (id: string, title: string, cover: string, folder: string): MusicAlbum => {
  const track: MusicTrack = {
    id, albumId: `${id}-album`, title, artist: ARTIST, year: 2026, duration: 0, format: "演示",
    browserPlayable: false, audioUrl: "", relativePath: "",
  };
  return {
    id: `${id}-album`, title, artist: ARTIST, year: 2026, coverUrl: `/demo-covers/${cover}.png`,
    genreId: "", rawGenres: [], folder, tracks: [track], producers: [], offline: false,
  };
};
const albums = [
  song("demo-sun", "日光留声", "square", "演示歌单 · 氛围音乐"),
  song("demo-night", "夜间航线", "portrait", "演示歌单 · 氛围音乐"),
  song("demo-mountain", "远山来信", "landscape", "演示歌单 · 器乐"),
];
const playlists: MusicPlaylist[] = [
  { id: "demo-ambient", name: "氛围音乐", folder: "演示歌单 · 氛围音乐", main: false, trackIds: ["demo-sun", "demo-night"] },
  { id: "demo-instrumental", name: "器乐", folder: "演示歌单 · 器乐", main: false, trackIds: ["demo-mountain"] },
];
export const demoLibrary: Pick<MusicLibrary, "albums" | "playlists"> = { albums, playlists };
