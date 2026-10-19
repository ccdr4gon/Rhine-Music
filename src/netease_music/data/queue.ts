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

/**
 * A NetEase picture whatever image server it is addressed on. NetEase gives one picture on p1, p2…
 * as it pleases: the copy of a playlist saved on this PC and NetEase's own queue of it name
 * different servers, and so can two loads of one playlist (2026-10-16: the same pictures on other
 * servers rebuilt the whole shelf when the queue moved to another playlist). Its path names it.
 */
export function queueCoverKey(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return /^p\d+\.music\.126\.net$/i.test(parsed.hostname) ? `netease-picture:${parsed.pathname}` : undefined;
  } catch {
    return undefined;
  }
}

// One case per song: the album record of a song in the column `genreId`.
function songAlbum(key: string, track: QueueTrack, position: number, genreId: string): MusicAlbum {
  const coverUrl = queueCover(track.coverUrl);
  return {
    id: key, title: track.title, artist: track.artist || "歌手未提供",
    genreId, rawGenres: [], folder: "", coverUrl, coverKey: queueCoverKey(coverUrl),
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
 * How NetEase shows the user's own liked-songs playlist, on its playlist page and in its sidebar. It
 * stores it under the account's nickname + 喜欢的音乐 (its local database has that name), and its
 * pages put this name in its place for the playlist that is the account's liked one (2026-10-17).
 */
export const LIKED_PLAYLIST_NAME = "我喜欢的音乐";
/**
 * One shelf column when the columns are NetEase playlists. The live lane is NetEase's play
 * queue: ▶ on a case there plays its song. Every other lane is a playlist as the local database
 * has it: ▶ on one of its cases has NetEase play the playlist from that song, and the playlist
 * becomes the queue (the owner, 2026-10-10; until then such a lane was only for browsing).
 */
export interface QueueLane {
  /** The playlist's ID, or QUEUE_LANE. */
  id: string;
  /** What Rhine shows: the playlist's name, LIKED_PLAYLIST_NAME for the liked-songs playlist. */
  name: string;
  /**
   * The name as NetEase stores it: what its own playlist page hands over with 播放全部 as the queue's
   * source, so Rhine's 播放全部 hands over the same.
   */
  sourceName: string;
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
      id: playlist.id, name: playlist.liked ? LIKED_PLAYLIST_NAME : playlist.name || "未命名歌单", sourceName: playlist.name, live,
      liked: playlist.liked, tracks: live ? queue.tracks : playlist.tracks, truncated: live ? queue.truncated : playlist.truncated,
    });
  }
  if (!placed && queue.tracks.length)
    lanes.unshift({
      id: QUEUE_LANE, name: queue.source?.name || "播放队列", sourceName: queue.source?.name ?? "", live: true, liked: false,
      tracks: queue.tracks, truncated: queue.truncated,
    });
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

/**
 * The song a case shows, whichever lane holds it: a playlist's case and the queue's for one song
 * answer alike, so what follows the shelf's songs (the ruler's ticks) is unmoved when NetEase's queue
 * moves to another playlist and the same songs take the other keys. Other keys are their own.
 */
export const caseSong = (key: string) => key.replace(/^netease-(?:track|list:[^:]*):/, "netease-song:");

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
