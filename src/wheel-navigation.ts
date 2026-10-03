/** Wheel distance of one shelf row before gain: one notch of a standard mouse wheel. */
export const WHEEL_PIXELS_PER_ROW = 100;
/** WheelEvent.deltaMode 1 reports lines; one line counts as this many pixels. */
export const WHEEL_LINE_PIXELS = 40;
/** Page height used for deltaMode 2 when the caller's viewport height is unusable. */
export const WHEEL_PAGE_FALLBACK_PIXELS = 800;
/** One event moves at most this many rows before gain, whatever its delta. */
export const WHEEL_MAX_EVENT_ROWS = 3;
/** The input rate is measured over this long, newer events weighing more. */
export const WHEEL_RATE_WINDOW_MS = 280;
/** Up to this measured rate (rows per second) a notch is exactly one row. */
export const WHEEL_SLOW_RATE = 10;
/** From this measured rate on, the gain stays at its cap. */
export const WHEEL_FAST_RATE = 36;
/** Rows owed per row of input at and above the fast rate. */
export const WHEEL_MAX_GAIN = 4.5;
/** Shortest time between two non-zero take() results (about 11 commits per second). */
export const WHEEL_COMMIT_INTERVAL_MS = 90;
/** Each commit releases at least this share of the whole rows still owed. */
export const WHEEL_RELEASE_SHARE = 0.5;
/** Commits are sized so the rows owed are out this long after the last push (plus one commit interval). */
export const WHEEL_RELEASE_MS = 600;
/** A remainder below one row is dropped after this long without input. */
export const WHEEL_REMAINDER_MS = 250;
/**
 * A lone event of at least this share of a row is a whole notch of a wheel set to fewer
 * lines per notch (or on a zoomed page) and counts as one row; smaller ones are a trackpad.
 */
export const WHEEL_NOTCH_MIN_ROWS = 0.3;
/** Rows still owed this long after the last push (hidden tab, stalled loop) are dropped, not released. */
export const WHEEL_STALE_MS = 1000;

/** Absorbs float error of summed fractional deltas (ten 10 px events are one row). */
const EPSILON = 1e-9;

type Sample = { time: number; rows: number };

/**
 * Turns wheel events into signed whole-row steps for the album shelf.
 *
 * push() adds each event's rows, multiplied by a gain that grows with the
 * measured input rate; take(), called once per animation frame, hands the rows
 * out in a few batches: the first at once, later ones a commit interval apart,
 * each a share of what is still owed. Time only comes in through arguments.
 */
export class WheelNavigation {
  /** Signed rows not handed out yet, including the part below one row. */
  private pending = 0;
  private direction = 0;
  private samples: Sample[] = [];
  private lastPush = -Infinity;
  private lastCommit = -Infinity;
  private lastTake = -Infinity;

  /** deltaMode: 0 pixels, 1 lines, 2 pages (WheelEvent.deltaMode). pageHeight: viewport height in px. timeMs: monotonic time. */
  push(deltaY: number, deltaMode: number, timeMs: number, pageHeight: number): void {
    if (!Number.isFinite(deltaY) || deltaY === 0 || !Number.isFinite(timeMs)) return;
    const unit = deltaMode === 1 ? WHEEL_LINE_PIXELS
      : deltaMode === 2 ? (Number.isFinite(pageHeight) && pageHeight > 0 ? pageHeight : WHEEL_PAGE_FALLBACK_PIXELS)
      : 1;
    let size = Math.min(Math.abs(deltaY) * unit / WHEEL_PIXELS_PER_ROW, WHEEL_MAX_EVENT_ROWS);
    const direction = Math.sign(deltaY);
    if (direction !== this.direction) {
      // Reversal: nothing of the old direction survives, and the first step
      // the other way does not wait for the commit interval.
      this.pending = 0;
      this.samples.length = 0;
      this.lastCommit = -Infinity;
      this.direction = direction;
    }
    // A deliberate single notch must always move one row, however short the device makes it.
    const lone = this.pending === 0 && timeMs - this.lastPush > WHEEL_REMAINDER_MS;
    if (lone && size >= WHEEL_NOTCH_MIN_ROWS && size < 1) size = 1;
    // A clock that went backwards restarts the rate estimate.
    if (timeMs < this.lastPush) this.samples.length = 0;
    this.lastPush = timeMs;
    // A large single event counts as one notch for the rate, so it is not accelerated by itself.
    this.samples.push({ time: timeMs, rows: Math.min(size, 1) });
    this.pending += direction * size * wheelGain(this.rate(timeMs));
  }

  /** Signed whole rows to move the selection by now; 0 when nothing is due. immediate = reduced motion: release everything owed at once. */
  take(timeMs: number, immediate = false): number {
    if (!Number.isFinite(timeMs)) return 0;
    if (timeMs < this.lastTake) {
      // The clock went backwards: wait a commit interval from here instead of
      // staying blocked until it catches up.
      this.lastCommit = Math.min(this.lastCommit, timeMs);
      this.lastPush = Math.min(this.lastPush, timeMs);
    }
    this.lastTake = timeMs;
    if (this.pending === 0) return 0;
    const idle = timeMs - this.lastPush;
    const owed = Math.trunc(Math.abs(this.pending) + EPSILON);
    if (owed === 0) {
      if (idle > WHEEL_REMAINDER_MS) this.pending = 0;
      return 0;
    }
    if (idle > WHEEL_STALE_MS) {
      this.pending = 0;
      return 0;
    }
    if (timeMs - this.lastCommit < WHEEL_COMMIT_INTERVAL_MS) return 0;
    // Commits left before the release deadline, this one included.
    const commits = Math.max(1, Math.floor((this.lastPush + WHEEL_RELEASE_MS - timeMs) / WHEEL_COMMIT_INTERVAL_MS) + 1);
    const batch = immediate ? owed
      : Math.min(owed, Math.max(Math.ceil(owed * WHEEL_RELEASE_SHARE), Math.ceil(owed / commits)));
    this.lastCommit = timeMs;
    this.pending -= this.direction * batch;
    if (Math.abs(this.pending) < 1e-6) this.pending = 0;
    return this.direction * batch;
  }

  /** Drop everything (panel opened, library rebuilt, focus lost). */
  reset(): void {
    this.pending = 0;
    this.direction = 0;
    this.samples.length = 0;
    this.lastPush = -Infinity;
    this.lastCommit = -Infinity;
    this.lastTake = -Infinity;
  }

  /** True while rows are owed or a sub-row remainder may still complete; the caller keeps animation frames coming. */
  get active(): boolean {
    return this.pending !== 0;
  }

  /**
   * Rows per second over the window, each event weighted from 1 (now) to 0
   * (a window ago). Dense input measures its true rate; a lone notch measures
   * 2000 / window, about 7, which is below the slow rate.
   */
  private rate(timeMs: number) {
    let first = 0;
    while (first < this.samples.length && timeMs - this.samples[first].time >= WHEEL_RATE_WINDOW_MS) first++;
    if (first) this.samples.splice(0, first);
    let weighted = 0;
    for (const sample of this.samples) weighted += sample.rows * (1 - (timeMs - sample.time) / WHEEL_RATE_WINDOW_MS);
    return weighted / (WHEEL_RATE_WINDOW_MS / 2000);
  }
}

/** Rows owed per row of input at a measured rate (rows per second): 1 up to the slow rate, then a smoothstep to the cap. */
export function wheelGain(rate: number) {
  const t = Math.min(1, Math.max(0, (rate - WHEEL_SLOW_RATE) / (WHEEL_FAST_RATE - WHEEL_SLOW_RATE)));
  return 1 + (WHEEL_MAX_GAIN - 1) * t * t * (3 - 2 * t);
}
