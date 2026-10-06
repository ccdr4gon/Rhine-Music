import type { DebugState } from "../data/queue";

/** How long after a seek readings that still show the old position are ignored. */
const SEEK_HOLD_MS = 1500;

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
      return;
    }
    const estimate = track === this.track ? this.position(now) : undefined;
    // A whole-second reading means the true position is somewhere within that second.
    const agrees = estimate !== undefined && estimate >= position - 0.25 && estimate < position + 1.25;
    this.track = track;
    if (estimate !== undefined && !agrees && now < this.hold) {
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
