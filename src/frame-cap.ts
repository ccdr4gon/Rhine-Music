/**
 * 帧率上限 (设置 → 通用 → 动效与显示): which display frames the frame loop may run on.
 *
 * The next run's earliest time advances by the interval from the one before it, so a cap between
 * two multiples of the display's frame (90 on 240 Hz) alternates between them and averages the
 * cap. Two runs are never closer than half an interval (1 ms tolerance), and after a gap (a stall,
 * a hidden page, a resting scene) the loop does not catch up.
 */
export class FrameCap {
  /** Runs a second; 0: no cap. */
  private perSecond = 0;
  /** When the next run may start (ms, the animation-frame clock). */
  private due = 0;

  set(perSecond: number) {
    this.perSecond = perSecond > 0 ? perSecond : 0;
    this.due = 0;
  }

  /** Whether the display frame at `ms` may run; a run sets the next one's time. */
  admit(ms: number) {
    if (!this.perSecond) return true;
    if (ms < this.due - 1) return false;
    const interval = 1000 / this.perSecond;
    this.due = Math.max(this.due + interval, ms + interval / 2);
    return true;
  }

  /** The earliest time (ms) the next run may start; 0 without a cap. */
  get next() {
    return this.perSecond ? this.due - 1 : 0;
  }
}
