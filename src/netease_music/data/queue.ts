import type { MusicAlbum, MusicLibrary, MusicTrack } from "../../music-types";
import type { ExternalMediaSource } from "../../external_player/external-media";
import type { PlayerTrack } from "../../external_player/player-track";

/** Display fields of one song in NetEase Cloud Music's saved play queue. */
export type QueueTrack = PlayerTrack;
/** The playlist a queue was started from, when every song in it names the same one. */
export interface QueueSource {
  id: string;
  name: string;
}
export type QueueReply =
  | { status: "missing" }
  | { status: "unchanged"; stamp: string }
  | { status: "queue"; stamp: string; tracks: QueueTrack[]; truncated: boolean; source?: QueueSource };

/**
 * One of the playlists the user created in NetEase (the liked-songs list included), as its
 * local database has it: the name, NetEase's own song count, and the songs it has saved on
 * this PC, which may be none (a playlist that was never opened here).
 */
export interface NeteasePlaylist {
  id: string;
  name: string;
  coverUrl?: string;
  trackCount: number;
  liked: boolean;
  complete: boolean;
  truncated: boolean;
  tracks: QueueTrack[];
}
export type PlaylistsReply =
  | { status: "missing" }
  | { status: "unchanged"; stamp: string }
  | { status: "playlists"; stamp: string; truncated: boolean; playlists: NeteasePlaylist[] };

/** What NetEase reports through its local DevTools port, when it was started with one. */
export interface DebugState {
  available: boolean;
  trackId?: string;
  playback?: "playing" | "paused" | "stopped";
  mode?: string;
  duration?: number;
  /** Seconds into the song; NetEase reports whole seconds. */
  position?: number;
}

/** NetEase's public image server resizes on request; 1024 matches the sharp lifted print. */
export function queueCover(url?: string, size = 1024): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !/^p\d+\.music\.126\.net$/i.test(parsed.hostname) || parsed.port) return undefined;
    parsed.search = `?param=${size}y${size}`;
    parsed.hash = "";
    return parsed.href;
  } catch {
    return undefined;
  }
}

/** A queue song's box and its single track share this ID. */
export const queueTrackKey = (track?: QueueTrack) => (track ? `netease-track:${track.id}` : "");

// One case per song: the album record of a song in the column `genreId`.
function songAlbum(key: string, track: QueueTrack, position: number, genreId: string): MusicAlbum {
  return {
    id: key, title: track.title, artist: track.artist || "歌手未提供",
    genreId, rawGenres: [], folder: "", coverUrl: queueCover(track.coverUrl),
    tracks: [{
      id: key, albumId: key, title: track.title, artist: track.artist,
      trackNumber: position + 1, duration: track.duration ?? 0, format: "网易云音乐",
      browserPlayable: false, audioUrl: "", relativePath: "",
    } satisfies MusicTrack],
    producers: [], offline: false,
  };
}

/**
 * One shelf case per song, in queue order: moving one case is moving one song. Songs from
 * the same album repeat its cover. Nothing here is playable by Rhine itself.
 */
export function queueLibrary(tracks: readonly QueueTrack[], sourceName: string): MusicLibrary {
  const albums = new Map<string, MusicAlbum>();
  tracks.forEach((track, position) => {
    const key = queueTrackKey(track);
    // The same song can be queued twice; one case per song keeps the IDs unique.
    if (!albums.has(key)) albums.set(key, songAlbum(key, track, position, "external"));
  });
  return {
    version: 1, roots: [], scan: { running: false }, onlineEnabled: false,
    genres: albums.size ? [{ id: "external", name: sourceName }] : [],
    albums: [...albums.values()],
  };
}

/** The lane ID of NetEase's play queue when it did not come from one of the user's playlists. */
export const QUEUE_LANE = "queue";
/**
 * One shelf column when the columns are NetEase playlists. The live lane is NetEase's play
 * queue: resting on a case there can switch its song. Every other lane is a playlist as the
 * local database has it, for browsing only.
 */
export interface QueueLane {
  /** The playlist's ID, or QUEUE_LANE. */
  id: string;
  name: string;
  live: boolean;
  liked: boolean;
  tracks: readonly QueueTrack[];
  truncated: boolean;
}

/**
 * The columns: the user's playlists that have songs, in NetEase's own order. The playlist
 * the play queue was started from shows the queue itself (its order, and what NetEase
 * dropped or added), so the playing song has exactly one case; a queue from anywhere else
 * (an album, a search, a collected playlist) is a column of its own in front.
 */
export function queueLanes(
  queue: { tracks: readonly QueueTrack[]; truncated: boolean; source?: QueueSource },
  playlists: readonly NeteasePlaylist[] = [],
): QueueLane[] {
  const lanes: QueueLane[] = [];
  let placed = false;
  for (const playlist of playlists) {
    const live = !placed && !!queue.tracks.length && queue.source?.id === playlist.id;
    if (live) placed = true;
    else if (!playlist.tracks.length) continue;
    lanes.push({
      id: playlist.id, name: playlist.name || (playlist.liked ? "我喜欢的音乐" : "未命名歌单"), live, liked: playlist.liked,
      tracks: live ? queue.tracks : playlist.tracks, truncated: live ? queue.truncated : playlist.truncated,
    });
  }
  if (!placed && queue.tracks.length)
    lanes.unshift({ id: QUEUE_LANE, name: queue.source?.name || "播放队列", live: true, liked: false, tracks: queue.tracks, truncated: queue.truncated });
  return lanes;
}

/** The column ID (a genre in the shelf's terms) of a lane. */
export const laneGenre = (lane: Pick<QueueLane, "id">) => `netease-lane:${lane.id}`;
/**
 * A song's case in a lane. The live lane keeps the queue's keys, so everything that follows
 * and switches NetEase's song finds its cases there and nowhere else; a song that is in
 * several playlists has one case in each.
 */
export const laneTrackKey = (lane: Pick<QueueLane, "id" | "live">, track?: QueueTrack) =>
  !track ? "" : lane.live ? queueTrackKey(track) : `netease-list:${lane.id}:${track.id}`;

/** The shelf for playlist columns: one column per lane, one case per song in it. */
export function laneLibrary(lanes: readonly QueueLane[]): MusicLibrary {
  const albums = new Map<string, MusicAlbum>();
  const genres: MusicLibrary["genres"] = [];
  for (const lane of lanes) {
    const before = albums.size;
    lane.tracks.forEach((track, position) => {
      const key = laneTrackKey(lane, track);
      if (!albums.has(key)) albums.set(key, songAlbum(key, track, position, laneGenre(lane)));
    });
    if (albums.size > before) genres.push({ id: laneGenre(lane), name: lane.name });
  }
  return {
    version: 1, roots: [], scan: { running: false }, onlineEnabled: false,
    genres, albums: [...albums.values()],
  };
}

const normalize = (text: string) =>
  text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const artistNames = (text: string) =>
  new Set(normalize(text).split(/\s*(?:\/|,|，|、|&|;|；| feat\.? | ft\.? )\s*/).filter(Boolean));

/**
 * The queue entry that is playing. NetEase's own song ID decides when its debugging port
 * reports one; otherwise the title the media session reports, preferring a shared artist
 * when several songs share it. Undefined when the song is not in the queue.
 */
export function playingQueueTrack(tracks: readonly QueueTrack[], source?: ExternalMediaSource, debug?: DebugState) {
  if (debug?.available && debug.trackId) return tracks.find((track) => track.id === debug.trackId);
  const title = normalize(source?.title ?? "");
  if (!title) return undefined;
  const candidates = tracks.filter((track) => normalize(track.title) === title);
  if (candidates.length < 2) return candidates[0];
  const reported = artistNames(source?.artist ?? "");
  return candidates.find((track) => [...artistNames(track.artist)].some((name) => reported.has(name))) ?? candidates[0];
}
