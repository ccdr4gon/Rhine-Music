/** Below this a described value counts as unchanged: about 1/5000 px in scene units. */
const TOLERANCE = 1e-6;
/** A resting scene still updates at least this often (60 Hz) on faster displays. */
const REST_INTERVAL = 1 / 60;

type Transform = {
  position: { x: number; y: number; z: number };
  quaternion: { x: number; y: number; z: number; w: number };
  scale: { x: number; y: number; z: number };
  intensity?: number;
  color?: { r: number; g: number; b: number };
};

/**
 * Decides which display frames update and draw the scene.
 *
 * Interaction and transitions update and draw on every display frame. Once the
 * scene rests (only the slow idle drift moves, or nothing does), it updates on
 * a ~60 Hz cadence on faster displays, and a frame whose described inputs
 * equal the last drawn frame is not drawn again: the canvas keeps showing it.
 */
export class FramePacing {
  private inputs = new Float64Array(1024);
  private count = 0;
  private drawnInputs = new Float64Array(0);
  private drawnCount = -1;
  private forced = true;
  private awake = false;
  private resting = false;
  private lastUpdate = -Infinity;
  private previousTick = NaN;
  private readonly intervals: number[] = [];
  private intervalIndex = 0;
  private hostWaited = false;
  /** Drawn frames, for diagnostics. */
  drawn = 0;
  /** A host loop that waits between frames (nextFrameAt) resumes here. */
  onWake?: () => void;

  /** The next display frame updates and draws, whatever its inputs. */
  invalidate() {
    this.forced = true;
    this.onWake?.();
  }

  /** The next display frame updates; it draws only if its inputs changed. */
  wake() {
    this.awake = true;
    this.onWake?.();
  }

  get isResting() {
    return this.resting && !this.forced;
  }

  /** Called on every display frame (seconds); false skips this frame's update. */
  due(time: number, always = false) {
    const elapsed = time - this.previousTick;
    this.previousTick = time;
    if (elapsed > 0 && elapsed < 0.1) {
      // An interval across a host's wait is not a display frame.
      if (!this.hostWaited) {
        this.intervals[this.intervalIndex] = elapsed;
        this.intervalIndex = (this.intervalIndex + 1) % 9;
      }
    } else {
      // First frame, or the first after a pause (hidden page, open viewer).
      this.forced = true;
    }
    this.hostWaited = false;
    if (always || this.forced || this.awake || !this.resting) return true;
    const frame = this.displayFrame();
    return time - this.lastUpdate >= (this.restEvery(frame) - 0.5) * frame;
  }

  /** Every Nth display frame, N = floor(refresh / 60): 240 Hz rests on every fourth, 144 Hz every second. */
  private restEvery(frame: number) {
    return Math.max(1, Math.floor(REST_INTERVAL / frame + 0.05));
  }

  /**
   * For a host loop that can wait between display frames instead of requesting
   * every one: the time (seconds, animation-frame clock) of the next frame
   * this scene needs, or 0 when it needs the very next one. Input and mutators
   * call onWake to end a wait early.
   */
  nextFrameAt() {
    if (!this.isResting || this.awake) return 0;
    const frame = this.displayFrame();
    const every = this.restEvery(frame);
    if (every < 2) return 0;
    this.hostWaited = true;
    // An animation frame requested between two display frames runs at once,
    // stamped with the earlier one: ask just after the slot's frame began.
    return this.lastUpdate + (every + 0.25) * frame;
  }

  private displayFrame() {
    if (!this.intervals.length) return REST_INTERVAL;
    const sorted = [...this.intervals].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  }

  /** Start describing this frame: every value that decides what it shows. */
  begin() {
    this.count = 0;
  }

  value(value: number) {
    if (this.count === this.inputs.length) this.grow(this.count + 1);
    this.inputs[this.count++] = value;
  }

  values(values: ArrayLike<number>) {
    if (this.count + values.length > this.inputs.length) this.grow(this.count + values.length);
    for (let i = 0; i < values.length; i++) this.inputs[this.count + i] = values[i];
    this.count += values.length;
  }

  /** Local transform, plus intensity and color for lights. */
  transform(object: Transform) {
    const { position: p, quaternion: q, scale: s } = object;
    this.value(p.x); this.value(p.y); this.value(p.z);
    this.value(q.x); this.value(q.y); this.value(q.z); this.value(q.w);
    this.value(s.x); this.value(s.y); this.value(s.z);
    if (object.intensity !== undefined) this.value(object.intensity);
    if (object.color) {
      this.value(object.color.r); this.value(object.color.g); this.value(object.color.b);
    }
  }

  private grow(size: number) {
    const inputs = new Float64Array(Math.max(size, this.inputs.length * 2));
    inputs.set(this.inputs.subarray(0, this.count));
    this.inputs = inputs;
  }

  /** Whether every value described so far equals the last drawn frame's. */
  unchanged() {
    if (this.count > this.drawnCount) return false;
    for (let i = 0; i < this.count; i++)
      if (Math.abs(this.inputs[i] - this.drawnInputs[i]) > TOLERANCE) return false;
    return true;
  }

  /** Whether the described frame differs from the last drawn one (or a draw was requested). */
  needsDraw() {
    return this.forced || this.count !== this.drawnCount || !this.unchanged();
  }

  /** Record this update: whether it drew, and whether the scene may rest until its next slot. */
  finish(time: number, drew: boolean, resting: boolean) {
    if (drew) {
      if (this.drawnInputs.length < this.count) this.drawnInputs = new Float64Array(this.inputs.length);
      this.drawnInputs.set(this.inputs.subarray(0, this.count));
      this.drawnCount = this.count;
      this.forced = false;
      this.drawn++;
    }
    this.lastUpdate = time;
    this.awake = false;
    // An unchanged frame rests too: its next update decides whether motion resumed.
    this.resting = resting || !drew;
  }
}
