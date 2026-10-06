// Times are seconds from the reference video's 05:00 frame (25 fps).
export const smooth = (t: number) => {
  t = Math.max(0, Math.min(1, t));
  return t * t * t * (10 + t * (-15 + 6 * t));
};
const bell = (x: number, width: number) => Math.exp(-0.5 * (x / width) ** 2);
export function archiveWave(row: number, lane: number, time: number) {
  const t = time - 22;
  // Exactly zero outside the scan: before it `enter` is 0, and from 4.35 s both
  // packets are fully faded. The shelf keeps evaluating this every frame.
  if (t <= 0 || t >= 4.35) return 0;
  const phase = row + (lane - 2) * 0.65;
  const enter = smooth(t / 0.32);
  const first = 3 + t * 19;
  const returning = 32 - (t - 2.3) * 24;
  // A crest has shoulders and a trailing trough: neighboring files describe
  // one continuous surface, rather than independent staggered tweens.
  const packet = (distance: number) =>
    2.5 * bell(distance, 3.8) - 0.58 * bell(distance - 6, 3.5);
  return (
    enter *
    (packet(phase - first) * (1 - smooth((t - 2.15) / 0.65)) +
      packet(phase - returning) *
        smooth((t - 2.17) / 0.32) *
        (1 - smooth((t - 3.5) / 0.85)))
  );
}
export function extraction(time: number) {
  return (
    0.4 * smooth((time - 25.58) / 0.82) + 2.95 * smooth((time - 27.55) / 1.3)
  );
}
// The returning scan leaves two moving shoulders around the selected file.
// Their delay grows with distance, so the neighboring files keep moving during
// the first extraction and settle before the second extraction.
export function settlingWave(distance: number, time: number) {
  const age = time - 25.05 - Math.abs(distance) * 0.065;
  const envelope = Math.max(
    -0.42,
    2.15 - 0.17 * (Math.sqrt(distance * distance + 1) - 1),
  );
  const rise = smooth(age / 0.62);
  const ring = age > 0 ? Math.sin(age * 5.1) * Math.exp(-age * 1.3) : 0;
  return envelope * (rise + 0.18 * ring * smooth(age / 0.16));
}
export function baselineSelectionWave(distance: number, age: number) {
  if (age < 0 || age > 3.2) return 0;
  return (
    0.8 *
    smooth(age / 0.2) *
    Math.exp(-age * 1.15) *
    Math.cos((distance - age * 8) * 0.58) *
    bell(distance - age * 8, 3.4)
  );
}

// Music's taller 0.9 preview lift must not stack with the archive's fast crest.
// Start with zero slope, retain a small signed settling wave, and propagate it
// outwards without changing the archive/reference timeline.
export function musicSelectionWave(distance: number, age: number) {
  if (age < 0 || age > 3.2) return 0;
  return (
    0.32 * smooth(age / 0.46) * Math.exp(-age * 1.35) *
    Math.cos((distance - age * 5.5) * 0.58) * bell(distance - age * 5.5, 3.4)
  );
}

/**
 * The play / stop gesture: the selected case makes a little hop (`height` world units, over
 * `time` seconds, smooth at both ends) and, `wave` seconds after it leaves the ground, sends
 * the selection wave (musicSelectionWave) out from its place.
 */
export const PLAY_GESTURE = { height: 0.36, time: 0.5, wave: 0.12 } as const;
/** How high the gesture's hop is `age` seconds after the click. */
export function playHop(age: number) {
  if (!(age > 0 && age < PLAY_GESTURE.time)) return 0;
  const lift = Math.sin((Math.PI * age) / PLAY_GESTURE.time);
  return PLAY_GESTURE.height * lift * lift;
}

// Retained for the comparison experiments; the user chose the signed baseline.
export function selectionWave(distance: number, age: number) {
  return Math.max(0, baselineSelectionWave(distance, age));
}

// The source stays still while the crest expands around it. Squaring the
// positive cosine gives the ripple zero velocity at its leading/trailing edge.
export function rippleEnvelope(distance: number, age: number) {
  return (
    smooth(distance / 2.5) * Math.max(0, Math.cos((distance - age * 8) * 0.58))
  );
}

export function columnStrength(lane: number, focus: number, progress = 1) {
  const selected = 0.25 + 0.75 * bell(lane - focus, 0.55);
  return 1 + (selected - 1) * smooth(progress);
}

// A quiet idle drift, with neighboring cards slightly out of phase.
// Maximum displacement is 0.102, under 3% of a card's height.
export function idleWave(row: number, lane: number, time: number) {
  return (
    0.075 * Math.sin((time * Math.PI * 2) / 8 + row * 0.3 - lane * 0.45) +
    0.027 * Math.sin((time * Math.PI * 2) / 13 - row * 0.17 + lane * 0.3)
  );
}

export function cinematicField(
  row: number,
  lane: number,
  time: number,
  center = 12,
  focus = 2,
) {
  const handoff = smooth((time - 24.95) / 0.45);
  const selection = smooth((time - 25.4) / 0.95);
  const shoulderTime = time + 0.3 * handoff * (1 - selection);
  return (
    archiveWave(row, lane, time) * (1 - handoff) +
    settlingWave(row - center, shoulderTime) *
      columnStrength(lane, focus, (time - 25.4) / 0.95)
  );
}

/**
 * The music opening's timing (music-boot.ts, scene.ts), in the film's seconds. It begins at the
 * film's first live 3D frame and has one wave (musicIntroWave; the owner, 2026-10-06: two waves
 * were too many). The film waits for its returning scan before it pulls back onto the selection;
 * without that scan the music opening takes the film's last phase (the pull back onto the shelf,
 * the browsing view forming, the selected case's lift) `lead` seconds earlier, while the camera
 * is still finishing its orbit, so it never stops between the two. It ends `lead` earlier as well,
 * after the same 400 ms hold on the resting shelf. The film's own times are unchanged.
 */
const MUSIC_INTRO_LEAD = 1;
export const MUSIC_INTRO = { start: 21.92, lead: MUSIC_INTRO_LEAD, end: 27.12 - MUSIC_INTRO_LEAD } as const;

/**
 * The music opening's one wave. Ahead of its crest it is the film's outward scan (archiveWave's
 * first packet, recentred so that the selected case stands where the film's row 12, lane 2
 * does); behind the crest the shelf settles into its resting shape, the selected column's
 * shoulders (settlingWave at 26.56, columnStrength) and the other columns' lower ones, so the
 * one scan leaves the selection standing where the film needed a second scan to bring it.
 * `row` and `lane` count from the selected case. Flat before the scan, exactly the resting
 * shelf once it has faded. Each row the scan passes rises to its crest once and then only
 * settles; the rows behind where it starts take their resting height as the shelf appears.
 */
export function musicIntroWave(row: number, lane: number, time: number) {
  const t = time - 22;
  if (t <= 0) return 0;
  const rest = settlingWave(row, 26.56) * columnStrength(lane, 0);
  if (t >= 2.8) return rest;
  const distance = row + 12 + lane * 0.65 - (3 + t * 19);
  const crest = bell(distance, 3.8);
  const packet = 2.5 * crest - 0.58 * bell(distance - 6, 3.5);
  const wake = distance < 0 ? 1 - crest : 0;
  return smooth(t / 0.32) * (packet * (1 - smooth((t - 2.15) / 0.65)) + rest * wake);
}

export const INSPECTION_LIFT = 4.05;
export const ALIGNMENT_EPSILON = 0.001;
// Hold altitude while facing back into the slot. Descent begins only once
// alignment is complete; this also applies to independently returning copies.
export function returnStep(angle: number, dt: number, reduced = false) {
  const next = angle * Math.exp(-dt * (reduced ? 35 : 7));
  return Math.abs(next) <= ALIGNMENT_EPSILON ? 0 : next;
}
export interface Spring {
  value: number;
  velocity: number;
}
export function damp(s: Spring, target: number, rate: number, dt: number) {
  const delta = s.value - target;
  const impulse = s.velocity + rate * delta;
  const decay = Math.exp(-rate * dt);
  s.value = target + (delta + impulse * dt) * decay;
  s.velocity = (s.velocity - rate * impulse * dt) * decay;
}
