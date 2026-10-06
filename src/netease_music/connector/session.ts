import type { ExternalMediaConnection, ExternalMediaSource } from "../../external_player/external-media";
import {
  laneGenre, laneLibrary, laneTrackKey, playingQueueTrack, queueLanes, queueLibrary, queueTrackKey,
  type DebugState, type NeteasePlaylist, type QueueLane, type QueueSource, type QueueTrack,
} from "../data/queue";
import { nativeDebugPort, nativePlaylistPort, nativeQueuePort, type DebugPort, type PlaylistPort, type QueuePort } from "./ports";
import { PlaybackClock } from "./playback-clock";
import { NETEASE_NAME, isNeteaseSource } from "./player";
import { playlistSummary, queueControlStatus } from "./settings";

/** NetEase's switches, saved with the app's other preferences (rhine-music-preferences). */
export interface NeteasePreferences {
  /** Show NetEase's saved play queue. Off until the user switches it on. */
  neteaseQueue: boolean;
  /** The play button (and Space) asks NetEase to play the selected queue song through its debugging port. */
  neteaseControl: boolean;
  /** One shelf column per NetEase playlist, read once the queue is shown. */
  playlistColumns: boolean;
}

/**
 * What the app lends the NetEase session. The session keeps what NetEase reported and what
 * Rhine asked of it; the app keeps the shelf, the selection, the page and the poll.
 */
export interface NeteaseSessionHost {
  /** The connection to the external players; undefined outside the player skin. */
  readonly media: ExternalMediaConnection | undefined;
  readonly preferences: NeteasePreferences;
  /** A case of the shelf: its record ID, and its column's (genre) ID. */
  recordId(index: number): string | undefined;
  genreId(index: number): string | undefined;
  /** The case with this record ID; -1 when there is none. */
  indexOf(recordId: string): number;
  /** The selected case, and the case the selection is moving to (during a glide). */
  selected(): number;
  navigationSelection(): number;
  /** Whether the selection may follow NetEase now: the shelf is ready, not rebuilding, no intro or panel. */
  canFollow(): boolean;
  /** Move the selection to `index`, the shorter way round its column from `from`. */
  follow(index: number, from: number): void;
  /** NetEase's song changed (or the song asked for arrived): the rows and the selection's words. */
  songChanged(): void;
  /** A request to play a song was sent or failed: the rows and the play button. */
  jumpChanged(): void;
  /** Read again within a few hundred milliseconds until NetEase's state changes. */
  confirmSoon(): void;
  /** Read NetEase again now. */
  refresh(): Promise<void>;
  notify(message: string): void;
}

/** The native readers and the debugging port (ports.ts); a check can lend stand-ins. */
export interface NeteasePorts {
  queue: QueuePort;
  playlists: PlaylistPort;
  debug: DebugPort;
}
const NATIVE_PORTS: NeteasePorts = { queue: nativeQueuePort, playlists: nativePlaylistPort, debug: nativeDebugPort };

// The database is not watched (NetEase rewrites it every few minutes for other reasons): read
// it again when the queue changes, which is when NetEase saves a playlist it started, and
// otherwise at this interval.
const PLAYLIST_REFRESH_MS = 30_000;
const QUEUE_JUMP_TIMEOUT_MS = 6000;

/**
 * NetEase in the player skin, between two polls: its saved queue and the user's playlists (each
 * read only with its switch on), what its debugging port reports, the song Rhine asked it to
 * play, whether the shelf follows the song it plays, and seeking. Moved out of music-app.ts
 * (2026-10-06) without changing what is read, sent or shown.
 */
export class NeteaseSession {
  externalQueue: { tracks: QueueTrack[]; truncated: boolean; source?: QueueSource } | undefined;
  queueStamp: string | undefined;
  queueStatus = "";
  // The user's NetEase playlists, read from its local database after the second opt-in.
  externalPlaylists: NeteasePlaylist[] | undefined;
  playlistStamp: string | undefined;
  playlistStatus = "";
  // Whether the last playlists read met the reader's limits.
  private playlistsCut = false;
  private playlistsReadAt = -Infinity;
  private playlistsReadFor: string | undefined;
  /** The shelf's columns while they are playlists; empty for the single queue column. */
  queueLanesShown: QueueLane[] = [];
  // The queue song the player reports, and whether the user browsed away from it. Following
  // resumes when NetEase changes song by itself or the user returns to the playing song.
  queuePlaying = "";
  queueFollowPaused = false;
  // NetEase's debugging port: the exact playing song, and the way to make it play another.
  debugState: DebugState = { available: false };
  // NetEase's position, kept running between the once-a-second readings.
  readonly playbackClock = new PlaybackClock();
  // Whether the port has been asked since it was last wanted, and what it answered if not a state.
  private debugProbed = false;
  private debugError = "";
  debugRestarting = false;
  // The song Rhine asked NetEase to play and NetEase has not reported yet, and earlier
  // requests the user moved on from before NetEase reported them (song -> time asked).
  queueJump: { key: string; at: number } | undefined;
  private readonly queueJumpsSuperseded = new Map<string, number>();
  // When the user's previous / next reached NetEase: its next change of song is followed.
  followNextAt = -Infinity;
  // The newest place the user moved NetEase's timeline to and that has not been sent yet.
  private pendingSeek: number | undefined;
  private seekSending = false;

  constructor(private readonly host: NeteaseSessionHost, private readonly ports: NeteasePorts = NATIVE_PORTS) {}

  /** NetEase's queue is shown only for a selected NetEase source after the user opted in. */
  shownQueue() {
    const media = this.host.media;
    return media && this.host.preferences.neteaseQueue && isNeteaseSource(media.selected) && this.externalQueue?.tracks.length
      ? this.externalQueue : undefined;
  }
  /** The playlist column a case stands in, when the columns are playlists. */
  laneAt(index = this.host.selected()) {
    const genre = this.queueLanesShown.length ? this.host.genreId(index) : undefined;
    return genre ? this.queueLanesShown.find((lane) => laneGenre(lane) === genre) : undefined;
  }
  /** The song a case shows: in its playlist column, or in NetEase's queue. */
  laneSong(index = this.host.selected()) {
    const lane = this.laneAt(index), id = this.host.recordId(index);
    return lane ? lane.tracks.find((track) => laneTrackKey(lane, track) === id) : this.queueSong(id);
  }
  /** Only NetEase's own queue has songs it can be asked to play; a playlist column is for browsing. */
  queueSong(boxId?: string) {
    return boxId ? this.shownQueue()?.tracks.find((track) => queueTrackKey(track) === boxId) : undefined;
  }
  queueControl() {
    const control = { enabled: this.host.preferences.neteaseControl, available: this.debugState.available };
    const status = !control.enabled ? ""
      : this.debugRestarting ? "正在以调试端口重新启动网易云…"
      : !this.debugProbed ? "正在检测网易云调试端口…"
      : this.debugError || queueControlStatus(control, this.debugState);
    // Offer a restart only once a probe has really found the port closed.
    return { ...control, status, restart: control.enabled && this.debugProbed && !control.available && !this.debugError && !this.debugRestarting };
  }
  forgetQueueJumps() {
    this.queueJump = undefined;
    this.queueJumpsSuperseded.clear();
  }

  /** NetEase's playback as its own player reports it when the port answers, else as Windows does. */
  playback(source?: ExternalMediaSource) {
    return isNeteaseSource(source) && this.debugState.available && this.debugState.playback ? this.debugState.playback : source?.playback;
  }
  /**
   * Position and length for the timeline while NetEase's debugging port answers (its media
   * session has neither); the timeline can then be dragged. Undefined otherwise.
   */
  timeline(source?: ExternalMediaSource) {
    const position = this.playbackClock.position(performance.now());
    if (isNeteaseSource(source) && this.debugState.available && position !== undefined && this.playbackClock.duration)
      // A stopped or finished song has nothing loaded to seek in.
      return { position, duration: this.playbackClock.duration, seekable: this.host.preferences.neteaseControl && this.debugState.playback !== "stopped", debug: true };
    return undefined;
  }
  /** The user moved the timeline: the target shows at once; sendSeeks asks NetEase. */
  seekTarget(position: number) {
    this.pendingSeek = position;
    this.playbackClock.seek(position, performance.now());
  }
  /** One request at a time, always the newest target: a held arrow key is one seek, not thirty. */
  async sendSeeks() {
    if (this.seekSending) return;
    this.seekSending = true;
    try {
      while (this.pendingSeek !== undefined) {
        const position = this.pendingSeek;
        this.pendingSeek = undefined;
        await this.seekNetease(position);
      }
    } finally {
      this.seekSending = false;
    }
  }
  private async seekNetease(position: number) {
    const trackId = this.debugState.trackId;
    if (!trackId || !this.host.preferences.neteaseControl || !this.debugState.available) return this.playbackClock.release();
    try {
      const sent = await this.ports.debug.seek(trackId, position);
      // A trial clip limits the range: show where NetEase really went.
      if (this.pendingSeek === undefined && Number.isFinite(sent) && Math.abs(sent - position) > 0.5) this.playbackClock.seek(sent, performance.now());
    } catch (error) {
      this.playbackClock.release();
      this.host.notify(String(error instanceof Error ? error.message : error));
    }
    void this.host.refresh();
  }

  /** A poll's reads after the media session's: the queue, the playlists, the debugging port. */
  async refresh() {
    await this.refreshQueue();
    await this.refreshPlaylists();
    await this.refreshDebug();
  }
  private async refreshQueue() {
    const source = this.host.media?.selected;
    if (!this.host.preferences.neteaseQueue || !isNeteaseSource(source)) {
      this.externalQueue = undefined;
      this.queueStamp = undefined;
      return;
    }
    try {
      // The playlist the queue came from is asked for only with playlist columns on.
      const reply = await this.ports.queue.read(this.queueStamp, this.host.preferences.playlistColumns);
      if (reply.status === "missing") {
        this.externalQueue = undefined;
        this.queueStamp = undefined;
        this.queueStatus = "没有找到网易云保存的播放队列。请先在网易云中播放歌曲。";
      } else if (reply.status === "queue") {
        this.queueStamp = reply.stamp;
        this.externalQueue = reply.tracks.length ? { tracks: reply.tracks, truncated: reply.truncated, source: reply.source } : undefined;
        this.queueStatus = reply.tracks.length
          ? `已读取播放队列 ${reply.tracks.length} 首${reply.truncated ? "（只显示前 3000 首）" : ""}，随网易云更新。`
          : "网易云的播放队列为空。";
      }
    } catch (error) {
      // A file being rewritten keeps the queue already shown; the next poll reads it again.
      this.queueStatus = String(error instanceof Error ? error.message : error);
    }
  }
  /** The user's playlists from NetEase's local database, only with both switches on. */
  private async refreshPlaylists() {
    if (!this.host.preferences.neteaseQueue || !this.host.preferences.playlistColumns || !isNeteaseSource(this.host.media?.selected)) {
      this.externalPlaylists = undefined;
      this.playlistStamp = undefined;
      this.playlistsCut = false;
      this.playlistsReadAt = -Infinity;
      return;
    }
    const now = performance.now();
    if (now - this.playlistsReadAt < PLAYLIST_REFRESH_MS && this.playlistsReadFor === this.queueStamp) return;
    this.playlistsReadAt = now;
    this.playlistsReadFor = this.queueStamp;
    try {
      const reply = await this.ports.playlists.read(this.playlistStamp);
      if (reply.status === "missing") {
        this.externalPlaylists = undefined;
        this.playlistStamp = undefined;
        this.playlistsCut = false;
        this.playlistStatus = "没有找到网易云的本机歌单数据。";
      } else {
        if (reply.status === "playlists") {
          this.playlistStamp = reply.stamp;
          this.externalPlaylists = reply.playlists;
          this.playlistsCut = reply.truncated;
        }
        // Also for "unchanged": a read that failed before left its error in the status.
        // (An answer to a read from before the switch was toggled finds nothing held.)
        if (this.externalPlaylists) this.playlistStatus = playlistSummary(this.externalPlaylists, this.playlistsCut);
      }
    } catch (error) {
      // A database being written keeps the playlists already shown; the next read tries again.
      this.playlistStatus = String(error instanceof Error ? error.message : error);
      this.playlistsReadAt = now - PLAYLIST_REFRESH_MS + 3000;
    }
  }
  private async refreshDebug() {
    if (!this.host.preferences.neteaseQueue || !this.host.preferences.neteaseControl || !isNeteaseSource(this.host.media?.selected)) {
      this.debugState = { available: false };
      this.debugProbed = false;
      this.debugError = "";
      this.playbackClock.update(this.debugState, performance.now());
      return;
    }
    try {
      this.debugState = await this.ports.debug.state();
      this.debugError = "";
    } catch (error) {
      // Polled every second: e.g. NetEase's page is still starting. Report a change once.
      this.debugState = { available: false };
      const message = String(error instanceof Error ? error.message : error);
      if (message !== this.debugError) console.warn(message);
      this.debugError = message;
    }
    this.debugProbed = true;
    this.playbackClock.update(this.debugState, performance.now());
  }

  /**
   * The shelf NetEase's queue makes, with a key that changes only with the queue (a new song
   * just moves the selection): one column per playlist once the playlists are read, else the
   * queue as the one column. Undefined while no queue is shown.
   */
  shelf(source?: ExternalMediaSource) {
    const queue = this.shownQueue();
    if (!queue || !source) return undefined;
    const lanes = this.host.preferences.playlistColumns && this.externalPlaylists ? queueLanes(queue, this.externalPlaylists) : [];
    return {
      key: JSON.stringify(["queue", source.id, source.name, this.queueStamp, ...(lanes.length ? [this.playlistStamp] : [])]),
      lanes,
      library: () => (lanes.length ? laneLibrary(lanes) : queueLibrary(queue.tracks, NETEASE_NAME)),
    };
  }
  /** The case of the song NetEase plays, asked of the queue as it is now; "" when it is not in it. */
  playingKey() {
    const queue = this.shownQueue();
    return queue ? queueTrackKey(playingQueueTrack(queue.tracks, this.host.media?.selected, this.debugState)) : "";
  }

  /**
   * The song the play button asks NetEase to play: the selected song of NetEase's queue (the
   * one the selection is moving to, during a glide), when it is not the one playing and the
   * debugging port may be used. `current`: also the playing one, for when NetEase offers no
   * play / pause of its own.
   */
  queueSongToPlay(current = false) {
    const key = this.host.recordId(this.host.navigationSelection()), song = this.queueSong(key);
    if (!key || !song || (key === this.queuePlaying && !current)) return undefined;
    if (!this.host.preferences.neteaseControl || !this.debugState.available || this.debugState.mode === "playFm") return undefined;
    return { key, song };
  }
  /** Ask NetEase to play a song of its queue; the poll confirms it (quickly: confirmSoon). */
  async playQueueSong({ key, song }: { key: string; song: QueueTrack }) {
    if (this.queueJump?.key === key) return;
    // The playing song itself (NetEase offers no play / pause): not a switch the poll can see.
    if (key !== this.queuePlaying) {
      if (this.queueJump) this.queueJumpsSuperseded.set(this.queueJump.key, this.queueJump.at);
      this.queueJumpsSuperseded.delete(key);
      this.queueJump = { key, at: performance.now() };
    }
    this.host.confirmSoon();
    this.host.jumpChanged();
    try {
      await this.ports.debug.play(song.id);
    } catch (error) {
      if (this.queueJump?.key === key) this.queueJump = undefined;
      this.host.jumpChanged();
      this.host.notify(String(error instanceof Error ? error.message : error));
      return;
    }
    void this.host.refresh();
  }
  /** Bring the playing song forward unless the user is browsing elsewhere. */
  followQueue() {
    const key = this.playingKey();
    const now = performance.now();
    for (const [asked, at] of this.queueJumpsSuperseded) if (now - at > QUEUE_JUMP_TIMEOUT_MS) this.queueJumpsSuperseded.delete(asked);
    if (this.queueJump && now - this.queueJump.at > QUEUE_JUMP_TIMEOUT_MS) {
      this.queueJump = undefined;
      this.host.notify("网易云没有切换到选中的歌曲。");
    }
    if (key !== this.queuePlaying) {
      this.queuePlaying = key;
      if (this.queueJump?.key === key) {
        // NetEase reports the song Rhine asked for.
        this.queueJump = undefined;
        this.queueJumpsSuperseded.clear();
      } else if (!this.queueJumpsSuperseded.delete(key)) {
        // NetEase changed song by itself. The shelf goes with it only while the selection was on
        // the playing song: a user browsing elsewhere stays. But if it answered the user's own
        // play request with another song (it skips one it cannot play), the user asked to hear
        // something: show what plays.
        // So does a change after the user's own previous / next.
        if (this.queueJump || now - this.followNextAt < QUEUE_JUMP_TIMEOUT_MS) this.queueFollowPaused = false;
        this.followNextAt = -Infinity;
        this.queueJump = undefined;
        this.queueJumpsSuperseded.clear();
      }
      // Otherwise an earlier request landed after the user had moved on: the newer request,
      // or the box the user rests on, still stands.
      this.host.songChanged();
    }
    if (!key || !this.host.canFollow()) return;
    const index = this.host.indexOf(key);
    const cursor = this.host.navigationSelection();
    // Browsing another playlist's column: NetEase changing song does not pull the shelf back.
    if (this.queueLanesShown.length && !this.laneAt(cursor)?.live) return;
    if (index < 0) return;
    if (index === cursor) {
      this.queueFollowPaused = false;
      return;
    }
    if (this.queueFollowPaused) return;
    this.host.follow(index, cursor);
  }

  /** The song scene's note: the order its list shows, then what the play button does there. */
  songQueueNote() {
    const lane = this.laneAt();
    return `${lane && !lane.live ? "盒子与列表按这个歌单在网易云里的顺序排列。" : "盒子与列表按网易云播放队列的顺序排列。"}${this.queueControlNote()}`;
  }
  /** The control note when it says what the play button cannot do here; empty when it plays the selection. */
  queueControlLimit() {
    const lane = this.laneAt();
    return this.host.preferences.neteaseControl && this.debugState.available && (!lane || lane.live) ? "" : this.queueControlNote();
  }
  queueControlNote() {
    const lane = this.laneAt();
    if (lane && !lane.live) return "这一列是歌单，不是网易云当前的播放队列：只供浏览，点播放不会切到这里的歌。在网易云里播放这个歌单后，它就是播放队列。";
    return !this.host.preferences.neteaseControl ? "切歌未开启：可在“播放器”面板中打开“点播放时让网易云播放选中的歌”。"
      : this.debugState.available ? "浏览时不切歌；点播放或按空格，网易云播放选中的歌。"
      : this.host.media?.offers("toggle") ? "调试端口未连接：点播放只暂停或继续网易云当前的歌，详见“播放器”面板。"
      : "调试端口未连接：播放键不能控制网易云，详见“播放器”面板。";
  }

  /** The queue switch changed: what was read goes, and the next poll reads again. */
  queueSwitched(on: boolean) {
    this.externalQueue = undefined;
    this.queueStamp = undefined;
    this.queueStatus = on ? "正在读取网易云播放队列…" : "";
  }
  /** The playlist-columns switch changed: what was read goes, and the next poll reads again. */
  playlistsSwitched(on: boolean) {
    this.externalPlaylists = undefined;
    this.playlistStamp = undefined;
    this.playlistsCut = false;
    this.playlistsReadAt = -Infinity;
    this.playlistStatus = on ? "正在读取网易云的本机歌单…" : "";
  }
  /** The play-the-selection switch changed: the port is asked again; switched off, no request waits. */
  controlSwitched(on: boolean) {
    this.debugProbed = false;
    if (!on) this.forgetQueueJumps();
  }
  /** Close NetEase and start it again with the debugging port; only from the user's confirmed button. */
  async restart() {
    this.debugRestarting = true;
    try {
      await this.ports.debug.restart();
    } finally {
      this.debugRestarting = false;
      this.debugProbed = false;
    }
  }
}
