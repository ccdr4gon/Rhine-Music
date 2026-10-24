import type { DebugState } from "../data/queue";

/** How long after a seek readings that still show the old position are ignored. */
const SEEK_HOLD_MS = 1500;
/** How long a new song's reading that still shows the last song's position is not taken. */
const SWITCH_HOLD_MS = 1500;

/**
 * NetEase reports its position in whole seconds, about once a second. This keeps a clock
 * running between readings so the timeline advances evenly and does not step back while a
 * song simply plays; a reading that disagrees (a seek, another song, a pause) resets it.
 * The clock never runs more than a second past the last reading, so slower playback or
 * buffering makes it wait instead of running ahead and jumping back.
 */
export class PlaybackClock {
  /** Seconds, when NetEase reports a length. */
  duration: number | undefined;
  private track = "";
  private base: number | undefined;
  private at = 0;
  private playing = false;
  private hold = -Infinity;
  /** The last reading taken as true (or the target of Rhine's own seek). */
  private read = 0;
  // A new song's first reading that still showed the last song's position, and until when it is not
  // taken (settling).
  private stale: number | undefined;
  private staleUntil = 0;

  /** A reading taken at `now` (monotonic milliseconds). */
  update(state: DebugState, now: number): void {
    const position = state.available ? state.position : undefined;
    const track = state.available ? state.trackId ?? "" : "";
    const playing = state.available && state.playback === "playing";
    this.duration = state.available ? state.duration : undefined;
    if (position === undefined) {
      this.base = undefined;
      this.track = track;
      this.playing = playing;
      this.staleUntil = 0;
      return;
    }
    // NetEase names the new song at once but its progress slider, where the position is read, still
    // shows the last song's for a moment (about 0.1 to 0.25 s on the owner's NetEase after Rhine asked
    // for another song): not a position of the new song. Nothing is shown for it until a reading moves
    // on (read again soon: settling), never later than SWITCH_HOLD_MS.
    if (track !== this.track && this.track !== "" && position >= 1) {
      const last = this.position(now);
      if (last !== undefined && position >= last - 1.25 && position < last + 1.25) {
        this.track = track;
        this.base = undefined;
        this.playing = playing;
        this.stale = position;
        this.staleUntil = now + SWITCH_HOLD_MS;
        return;
      }
    }
    if (now < this.staleUntil && track === this.track && position === this.stale) {
      this.playing = playing;
      return;
    }
    this.staleUntil = 0;
    const estimate = track === this.track ? this.position(now) : undefined;
    // A whole-second reading means the true position is somewhere within that second. Just after
    // Rhine's own seek only a reading of the target's own second agrees: NetEase may still report a
    // second it passed on its way there (2026-10-12: paused, → three times to 3 s, a reading of 2 s
    // was taken and shown for two seconds).
    const holding = now < this.hold;
    const agrees = estimate !== undefined && (holding
      ? estimate >= position - 0.05 && estimate < position + (playing ? 1.05 : 1)
      : estimate >= position - 0.25 && estimate < position + 1.25);
    this.track = track;
    if (estimate !== undefined && !agrees && holding) {
      // A seek was just sent and NetEase still shows where it was: keep the target.
      this.base = estimate;
      this.at = now;
      this.playing = playing;
      return;
    }
    if (!agrees || !playing || !this.playing) {
      this.base = position;
      this.at = now;
    }
    this.read = position;
    this.playing = playing;
  }

  /** The user moved the timeline: show the target at once. */
  seek(position: number, now: number): void {
    this.base = position;
    this.at = now;
    this.read = position;
    this.hold = now + SEEK_HOLD_MS;
    this.staleUntil = 0;
  }

  /** A new song's reading is not taken yet (it showed the last song's position): read again soon. */
  settling(now: number): boolean {
    return now < this.staleUntil;
  }

  /** The seek did not happen: believe NetEase's next reading at once. */
  release(): void {
    this.hold = -Infinity;
  }

  /** Estimated seconds into the song at `now`; undefined when NetEase reports none. */
  position(now: number): number | undefined {
    if (this.base === undefined) return undefined;
    const value = this.playing ? Math.min(this.base + Math.max(0, now - this.at) / 1000, this.read + 1) : this.base;
    return this.duration ? Math.min(value, this.duration) : value;
  }
}
