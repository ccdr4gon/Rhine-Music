import type { ExternalMediaSource } from "./external-media";

/** How far past its last reading the clock runs before the next one (the poll is about once a second). */
const RUN_LIMIT_S = 1.25;
/** A reading this little behind the clock, of a song that plays on, is the clock's own second. */
const BEHIND_S = 0.3;
/** How long after the player answered Rhine's own seek readings that are not of its target are not taken. */
const SEEK_HOLD_MS = 1500;
/** A reading farther than this from the target is not of it. */
const SEEK_NEAR_S = 1.5;
/** Where the song stood before each seek of one hold that are remembered (the first is always kept). */
const SEEK_FROM_LIMIT = 16;

/** The song a reading belongs to: another session, or another song in it, starts the clock again. */
const songOf = (source: ExternalMediaSource) => JSON.stringify([source.id, source.title, source.artist, source.album]);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * The position of a media session (QQ Music, or any player but NetEase over its debugging port,
 * which has its own PlaybackClock) between snapshots. The native side reads the position at the
 * moment of each snapshot; the page reads once a second, so without this the details' seconds and
 * the rings moved only when a reading came, and now and then skipped a second (2026-10-23). While
 * the session says it plays, the clock runs on from the last reading, never more than RUN_LIMIT_S
 * past it and never past the length; paused, stopped or unknown, it is the reading. A reading of
 * the same song a hair behind the clock does not move it back; any other (a seek, another song,
 * a pause) is taken. A session whose readings stand still while it says it plays is not run on.
 * Nothing is shown without a reading.
 *
 * Rhine's own seek (an arrow key moves it one second) shows at once, and each next one steps on
 * from it. While it is on its way to the player, or waits behind another control (`seeking`), the
 * clock stands at the target and no reading is taken: a snapshot answered before the seek (the
 * native media worker answers in order) still has where the song was, and one second from a
 * one-second target is no proof of anything (2026-10-23). Once the player has answered, the target
 * runs on from then, and for SEEK_HOLD_MS a reading is taken only when it is nearer the target
 * than where the song stood before (a player that shows its new position a moment late).
 */
export class SessionClock {
  private song = "";
  private base: number | undefined;
  private at = 0;
  /** The last reading taken (or Rhine's own seek target), and when. */
  private read = 0;
  private readAt = 0;
  private playing = false;
  private still = false;
  private duration: number | undefined;
  /** Rhine's own seek is held (-Infinity: none): readings that are not of it are not taken until then. */
  private hold = -Infinity;
  /** The held seek has not been answered by the player yet: the clock stands at the target. */
  private sending = false;
  /** Where the song stood before each seek of the hold (the last reading's run, then each earlier target), and when. */
  private before: { position: number; at: number }[] = [];

  /**
   * The selected session as the last snapshot read it, at `now` (monotonic milliseconds).
   * `seeking`: a seek of Rhine's is still on its way to the player, or waits behind another control
   * (ExternalMediaConnection.seeking).
   */
  update(source: ExternalMediaSource | undefined, now: number, seeking = false): void {
    const song = source ? songOf(source) : "";
    const position = source && finite(source.position) ? source.position : undefined;
    const playing = source?.playback === "playing";
    const estimate = song === this.song ? this.estimate(now) : undefined;
    if (song !== this.song) {
      this.song = song;
      this.endHold();
      this.still = false;
    }
    this.duration = source && finite(source.duration) && source.duration > 0 ? source.duration : undefined;
    if (position === undefined) {
      this.base = undefined;
      this.playing = playing;
      return;
    }
    if (this.hold !== -Infinity && estimate !== undefined && (seeking || this.sending || now < this.hold)) {
      if (this.sending && !seeking) {
        // The player has answered: the target runs on from now, and the hold counts from now.
        this.sending = false;
        this.at = this.readAt = now;
        this.hold = now + SEEK_HOLD_MS;
      }
      const off = Math.abs(position - estimate);
      const run = (from: { position: number; at: number }) =>
        from.position + (playing && !this.still ? Math.max(0, now - from.at) / 1000 : 0);
      // Still on its way (a snapshot answered before it), or a reading of where the song was: not taken.
      if (seeking || off > SEEK_NEAR_S || this.before.some(from => Math.abs(position - run(from)) < off)) {
        this.base = estimate;
        this.at = now;
        this.playing = playing;
        if (seeking) this.hold = Math.max(this.hold, now + SEEK_HOLD_MS);
        return;
      }
      this.endHold();
    } else if (this.hold !== -Infinity) this.endHold();
    // The player's readings stand still while it says it plays (it keeps no timeline): not run on.
    this.still = playing && this.playing && estimate !== undefined && now - this.readAt >= 500 && Math.abs(position - this.read) < 0.05;
    const agrees = estimate !== undefined && playing && this.playing && !this.still &&
      position <= estimate && position >= estimate - BEHIND_S;
    this.base = agrees ? estimate : position;
    this.at = now;
    this.read = position;
    this.readAt = now;
    this.playing = playing;
  }

  /**
   * The user moved the timeline: the target shows at once, and stands while the seek is on its way;
   * then until a reading of it (or the hold ends). Another seek meanwhile steps on from this target.
   */
  seek(source: ExternalMediaSource, position: number, now: number): void {
    if (songOf(source) !== this.song) this.update(source, now);
    const from = this.estimate(now);
    // A new hold (none, or the last one ran out unanswered by any reading): where the song stands now.
    if (this.hold === -Infinity || (!this.sending && now >= this.hold)) this.before = [];
    if (from !== undefined) this.before.push({ position: from, at: now });
    if (this.before.length > SEEK_FROM_LIMIT) this.before.splice(1, 1);
    this.base = this.read = position;
    this.at = this.readAt = now;
    this.hold = now + SEEK_HOLD_MS;
    this.sending = true;
  }

  /** The seek did not happen: the next reading is taken at once. */
  release(): void {
    this.endHold();
  }

  /** Seconds into the song at `now`, for the session on show; undefined without a reading of it. */
  position(source: ExternalMediaSource | undefined, now: number): number | undefined {
    return source && songOf(source) === this.song ? this.estimate(now) : undefined;
  }

  private endHold(): void {
    this.hold = -Infinity;
    this.sending = false;
    this.before = [];
  }

  private estimate(now: number): number | undefined {
    if (this.base === undefined) return undefined;
    const run = this.playing && !this.still && !this.sending
      ? Math.min(this.base + Math.max(0, now - this.at) / 1000, this.read + RUN_LIMIT_S) : this.base;
    return Math.max(0, this.duration ? Math.min(run, this.duration) : run);
  }
}
