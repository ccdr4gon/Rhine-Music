/**
 * Names beside the shelf's columns (one NetEase playlist per column).
 *
 * Since 2026-10-06 the names are flat text over the picture (lane-names.ts), not writing in
 * the scene: the owner saw the names in the scene jiggle whenever the shelf switched
 * playlists and asked for "a relatively fixed 2D text". They were then turned along the
 * cases with a soft rim (2026-10-06), and hung upright on the selection bracket without one
 * (2026-10-07: "too ugly ... redesign the text direction and post effect"). On 2026-10-08 the
 * owner asked: "the playlist name : selected face to the viewer, others face to the right
 * (parrallel)". Now:
 * - the selected column's name faces the viewer: flat and upright, the lifted case's caption by
 *   its bracket (the four squares on its box). Since 2026-10-18 (the owner chose "A · Display
 *   name" from five designs) it is a heading: a kicker as the playlist list's head (PLAYLIST 04 /
 *   11) over the name, which takes a second line where it needs one; its place is kept free for
 *   both lines. Since 2026-10-10 (the owner marked the empty corner
 *   left of the lifted case's top: "the selected playlist name move here") first left of the
 *   bracket (landscape), ending just before its left squares, near its top. Where that has no
 *   room, as before: above the bracket where that line lies wholly LANE_LABEL.header under the
 *   header's band; else, beside the shelf (landscape), level with the bracket's top (as high as
 *   the header allows), right of its top right square. They stand in the fog over the shelf,
 *   which reads in both themes on any covers (2026-10-08 review: beside the case's lower corner
 *   the name stood on the covers in front of it, on the line of the right column's play ring, and
 *   above the bracket it stood just under the header's line). Beside the shelf it never reaches
 *   over the right column, and level with its rows not within LANE_LABEL.clear of it. Under the
 *   bracket, on the covers, only where none has room;
 * - the names of the two columns beside it face to the right, parallel to each other: drawn in
 *   true perspective as if printed on a vertical plane of the shelf (LANE_PLANE: by default
 *   the plane of the cases' fronts, the shelf's planes that face right in the picture), each
 *   standing on the top edge of one case of its own column and reading along it, up and to
 *   the right as the case tops do. The column's own right-hand side (+x, toward the further
 *   columns) faces away from the camera (its normal and the view make 141 degrees) and cannot
 *   carry them; its left-hand side faces the camera but turns to the left in the picture.
 * Which case of the column and how far along its top edge is worked out once per view
 * (laneLabelSlots): the first place, in LANE_PLANE's order, where the name has room to be read
 * and keeps clear of everything else.
 *
 * Text only, nothing behind or around the strokes (no plate, band, border or rim): the contrast
 * comes from where the names stand. They keep clear of the overlay (the header, the right
 * column, the counter and ruler, the key hints, the window's buttons), of each other, of the
 * lifted case through the idle drift, and of the paths the bracket's squares take when the
 * selection steps along the column (up to three rows at once, as three wheel notches do) or hops
 * (`keep`, from scene.ts). (The case's own ▶, whose paths they kept clear of too, went on
 * 2026-10-10.)
 *
 * Each role has a FIXED place on the screen, a slot, worked out once from the shelf at rest
 * seen with the shelf's camera at rest (scene.ts restBracket, lanePlaces) and from the overlay
 * around it, as boxes that do not change with what the overlay shows (lane-names.ts). Only the
 * window, its layout, the fonts and the names change a slot.
 * Nothing that moves on the shelf moves a name: not the waves, the lifted case, the play
 * gesture's hop, the idle drift, the wheel, nor a step along a column. When the shelf slides
 * sideways a name does not travel from slot to slot (that would carry it across the lifted
 * case): it fades out at its slot while the next one fades in at its own, each drifting a few
 * pixels the way the shelf slides (along the neighbours' plane), as a function of its column's
 * offset from the sideways track alone (laneLabelShares). With reduced motion they swap at half
 * a column, without the drift. Opening an album or the song scene fades the names where they
 * stand. In the portrait layout the title and the navigation lie over the column nearer the
 * lens, which is not named there.
 */

import { ROW_SPACING } from "./archive-loop.ts";
import { columnStrength, damp, settlingWave } from "./motion.ts";

/** What a column is called; `live` marks the column that is NetEase's playing queue. */
export interface LaneName { name: string; live: boolean }

/** The role a column's name has on the shelf: the column nearer the lens, the selected one, the one further from it. */
export type LaneRole = "nearer" | "selected" | "further";
/** The roles of the columns beside the selected one, whose names are printed on a plane. */
export type LaneSide = "nearer" | "further";
/** Each role and the offset (in columns from the selected one) of the column it names at rest. */
export const LANE_ROLES: readonly (readonly [LaneRole, number])[] = [["nearer", -1], ["selected", 0], ["further", 1]];

/** Where the names stand and how they change places (CSS px unless noted). */
export const LANE_LABEL = {
  /** The bracket's squares are 6 px, centred on the box's corners: they reach this far out of it. */
  square: 3,
  /**
   * Left of the bracket (2026-10-10), the selected name ends this far before its left squares ...
   */
  outside: 14,
  /**
   * ... the middle of its name's first line these shares of the bracket's height under its top,
   * tried in order (the top left square's paths sweep down to the left of it: a lower line has
   * more room there; the heading of 2026-10-18 is taller, and at 1225 x 772, 1100 x 820 and in
   * the compact layout only a third of the way down leaves it room).
   */
  left: [0.12, 0.15, 0.18, 0.21, 0.24, 0.27, 0.3, 0.33, 0.36, 0.09],
  /** Above or under the bracket, the selected name starts this far right of the left squares ... */
  inset: 9,
  /** ... or, where the squares' paths are in the way there, this much further right. */
  shift: [0, 8, 16, 24],
  /** Above the bracket, its line ends this far above the top squares (its descenders included) ... */
  above: 8,
  /**
   * ... and this much higher, the highest first (2026-10-08: in the portrait layout the fog over
   * the shelf reads better in both themes a little further up);
   */
  lift: [24, 16, 8, 4, 0],
  /** but the selected name's line always stays this far under the header's band (never by its line). */
  header: 24,
  /**
   * Beside the shelf the selected name ends `clear` before the right column's left edge level
   * with its rows and down to this far above its top; higher up, only `gap` before it: it never
   * reaches over the right column.
   */
  over: 48,
  /** Level with the bracket's top, the selected name starts this far right of the top right square, */
  beside: 18,
  /** or this much further where the squares' paths are in the way there (a few rows' step sweeps it); */
  along: Array.from({ length: 31 }, (_, i) => i * 4),
  /** its line's top level with the top squares' (as high as the header allows), or this much lower. */
  drop: [0, 6, 12],
  /** Under the bracket, its line starts this far below the bottom squares. */
  below: 20,
  /** Above or under the bracket, the selected name ends this far before the right squares. */
  end: 3,
  /** A name keeps this far from the overlay's text and controls, and from the picture's edges. */
  clear: 24,
  /** ... and this far above or below them. */
  clearY: 12,
  /** A name keeps this far (in its own px) from the lifted case's face, the squares' paths and the other names. */
  gap: 8,
  /** A name with less room than this (its number included) is not shown; the selected heading, with less than its kicker. */
  least: 48,
  /** A place with this much room for a name (its number included) is taken; otherwise the one with the most. */
  room: 180,
  /** Over this much of a column (from its slot's offset) a name fades out at its slot as the shelf slides. */
  fade: 0.55,
  /**
   * While it fades a name drifts this far per column it is away from its slot: down and to the
   * left as the shelf slides toward the lens, up and to the right as it slides away, as the
   * cases move in the picture (the shelf's x axis, at 35 degrees). At most `fade` times this,
   * where it is all but gone.
   */
  drift: { x: -21, y: 14.7 },
  /** The neighbours' names are a little lighter than the selected one's. */
  neighbour: 0.92,
} as const;

/**
 * The plane the neighbours' names are printed on, and where on their column (scene.ts
 * lanePlaces). `turn`: the plane's normal, turned from the cases' fronts (0 degrees: the
 * shelf's +z, the cases' covers, which face right in the picture) toward the lens (90 degrees:
 * the column's side toward the lens, -x, which faces left); the name reads along the plane,
 * level. `lift`: how far (world units) its baseline stands above the case's top edge. For each
 * neighbour, `rows`: the cases of its column tried, in order (rows from the selected one:
 * positive is nearer the lens), and for each case `along`: how far along its top edge (world
 * units from its end nearer the lens) the name may start, in order. One place is taken per view
 * (laneLabelSlots). The orders were chosen (2026-10-08) for where the picture lets a name be
 * read in both themes with no rim: the fogged band above and right of the selection, the far
 * front of the column nearer the lens; the lit cases next to the lifted one are light in both.
 * The portrait layout frames the shelf higher (viewport-layout.ts): there the further column's
 * name stands further back on it, where the shelf fades into the top of the picture.
 */
export const LANE_PLANE = {
  turn: 0,
  lift: 0.06,
  further: { rows: [0, 1, -1, 2, -2, 3, 4], along: [1.3, 1.6, 1, 1.9, 0.7, 2.2, 0.4, 2.5, 2.8] },
  nearer: { rows: [6, 7, 5, 8, 4, 9, 3], along: [1.9, 2.2, 1.6, 2.5, 1.3, 1, 2.8, 0.7, 0.4] },
  portrait: { further: { rows: [-3, -4, -2, -5, -1, 0], along: [2.8, 3.1, 2.5, 3.4, 2.2, 1.9, 1.6] } },
} as const;

/**
 * How the selection's steps along its column carry the lifted case, for the names to keep clear
 * of (scene.ts restKeepOut): update() moves the selection at once, and the newly selected case
 * starts unlifted at its own place on its own shoulder; then the shelf's track (`rail` a second),
 * the shoulder (`shoulder`) and the lift (`lift`) spring back to the bracket's rest. The lift
 * rises while the track is still on its way, so a case coming back from a few rows away rises
 * above the line between there and the rest (2026-10-08: three wheel notches at 1280 x 720 took a
 * square 23 px beyond that line, onto the selected name). `steps`: the rows a step releases at
 * once, `apart` seconds apart (the wheel hands rows out in commits at least 90 ms apart,
 * wheel-navigation.ts), up to three rows in all (three notches); each new selection's lift
 * starts again from 0. `dt` and `time`: how often and how long the springs are followed.
 */
export const LANE_STEP = {
  rail: 3.7,
  shoulder: 5,
  lift: 4.2,
  apart: 0.09,
  steps: [[1], [2], [3], [1, 1], [1, 2], [2, 1], [1, 1, 1]],
  dt: 1 / 60,
  time: 2.4,
} as const;

/**
 * Every pose the lifted case passes through in LANE_STEP's steps toward the lens (`way` 1) or away
 * from it (-1), as shifts from the bracket's rest (world units: along the column, and up), with
 * `lift` the resting lift (scene.ts MUSIC_PREVIEW_LIFT).
 */
export function laneStepPoses(way: 1 | -1, lift: number): { z: number; y: number }[] {
  const { dt, time, apart } = LANE_STEP, poses: { z: number; y: number }[] = [];
  for (const releases of LANE_STEP.steps) {
    const track = { value: 0, velocity: 0 }, shoulder = { value: 0, velocity: 0 }, height = { value: lift, velocity: 0 };
    let target = 0, released = 0;
    for (let frame = 0, frames = Math.round(time / dt); frame < frames; frame++) {
      const t = frame * dt;
      while (released < releases.length && t >= released * apart - 1e-9) {
        target += way * releases[released++];
        height.value = 0;
        height.velocity = 0;
      }
      damp(track, target, LANE_STEP.rail, dt);
      damp(shoulder, target, LANE_STEP.shoulder, dt);
      damp(height, lift, LANE_STEP.lift, dt);
      // The case stands (target - track) rows from the bracket's rest, on the shoulder that still lags.
      poses.push({
        z: (target - track.value) * ROW_SPACING,
        y: height.value - lift - (settlingWave(0, 26.56) - settlingWave(target - shoulder.value, 26.56)) * columnStrength(0, 0),
      });
    }
  }
  return poses;
}

const smooth = (value: number) => {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
};

/** How much of one role a column's name shows, and how far it has drifted from that role's slot (CSS px). */
export interface LaneLabelShare { role: LaneRole; share: number; dx: number; dy: number }

/**
 * The roles a column's name shows in and how much of each, for a column `offset` columns from
 * the one the shelf is centred on (positive: further from the lens; fractional while the shelf
 * slides sideways). At a role's slot (its offset, LANE_ROLES) the name is shown in full there;
 * it fades out within LANE_LABEL.fade of a column either way, drifting LANE_LABEL.drift for
 * each column it is away, so a column on its way from one role to the next fades out at the one
 * slot as it fades in at the other, and never travels between them. A function of the offset
 * alone: steps along a column, waves, hops and the idle drift do not reach it. In the portrait
 * layout (viewport-layout.ts) the nearer column is not named. With reduced motion a name swaps
 * from one slot to the next at half a column, without drifting.
 */
export function laneLabelShares(offset: number, portrait = false, reduced = false): LaneLabelShare[] {
  const shares: LaneLabelShare[] = [];
  for (const [role, slot] of LANE_ROLES) {
    if (portrait && role === "nearer") continue;
    const away = offset - slot;
    // Reduced: the nearest slot only (Math.round(-0.5) is -0, the selected slot's).
    const shown = reduced ? Number(Math.round(offset) === slot) : 1 - smooth(Math.abs(away) / LANE_LABEL.fade);
    if (shown <= 0) continue;
    const drift = reduced ? 0 : -away;
    shares.push({
      role,
      share: shown * (role === "selected" ? 1 : LANE_LABEL.neighbour),
      // (+ 0: a name at its slot has drifted 0, not -0.)
      dx: drift * LANE_LABEL.drift.x + 0,
      dy: drift * LANE_LABEL.drift.y + 0,
    });
  }
  return shares;
}

/** The columns whose names can be shown around a (fractional) centre column. */
export function laneLabelRange(centre: number) {
  const span = 1 + LANE_LABEL.fade;
  return { first: Math.ceil(centre - span), last: Math.floor(centre + span) };
}

/** The two digits a column is counted with (as the stepper does). */
export const laneLabelIndex = (column: number) => String(column + 1).padStart(2, "0");

/** A box on the screen, in CSS px from the picture's top left. */
export interface LaneBox { left: number; top: number; right: number; bottom: number }
/** A point on the screen, in CSS px from the picture's top left. */
export interface LanePoint { x: number; y: number }
/**
 * How a role's name is set (lane-names.ts measures it from music-shelf.css): from the top of
 * its line to the baseline, from the baseline to the line's bottom, and from its start to where
 * the name starts (the number and the gap after it). The selected one is a block (2026-10-18):
 * from its top (the kicker's) to its name's first baseline, from there to that line's bottom,
 * the line's own height (`line`: its middle is where the place left of the bracket puts it) and
 * the room kept free under it for a second line (`more`), and the least room it is shown in
 * (`least`: its kicker's width).
 */
export interface LaneLabelType { ascent: number; descent: number; lead: number; line?: number; more?: number; least?: number }
/**
 * The picture the names are placed in: its size, whether its layout is the portrait one, the
 * header's band (from its top to its bottom line), the boxes of the overlay a name keeps clear of
 * (the header's band, the right column, the counter and ruler, the key hints' row, the window's
 * buttons) and, beside the shelf, the right column's box (`column`).
 */
export interface LaneLabelView { width: number; height: number; portrait: boolean; header: { top: number; bottom: number }; avoid: readonly LaneBox[]; column?: LaneBox }
/**
 * A place a neighbour's name may be printed: the homography (row-major 3 x 3) taking its line's
 * box in its own px (its top left at 0, 0; the baseline at the type's ascent) to the picture,
 * how long (in its own px) it may be there, and where it is on the column (its row, and how far
 * along the case's top edge it starts, in world units).
 */
export interface LanePlace { matrix: readonly number[]; reach: number; row: number; along: number }
/**
 * Where a role's name is. A flat one (the selected): where its block starts and its name's first
 * baseline. One on a plane (the neighbours): `matrix`, from its line's box to the picture, and
 * (x, y) where its baseline starts in the picture. With the most it may be wide (in its own px,
 * its number included), whether it is shown at all and how it was placed.
 */
export interface LaneLabelSlot {
  x: number;
  y: number;
  width: number;
  shown: boolean;
  matrix?: readonly number[];
  place?: string;
  /** A flat name that ends where its slot ends (left of the bracket): its lines end at x + width. */
  align?: "end";
  /** How many lines of its name a flat one has room for: two, or one where two fit nowhere at the bracket's top. */
  lines?: number;
}
export type LaneLabelSlots = Record<LaneRole, LaneLabelSlot>;

/** The homography (row-major 3 x 3) taking a w x h box (its top left at 0, 0) to `quad` (its top left, top right, bottom right and bottom left corners). */
export function quadMatrix(w: number, h: number, quad: readonly LanePoint[]): number[] {
  const [p0, p1, p2, p3] = quad;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / det, k = (dx1 * dy3 - dx3 * dy1) / det;
  const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + k * p3.x;
  const d = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + k * p3.y;
  // (+ 0: no -0 in a flat one.)
  return [a / w, b / h, p0.x, d / w, e / h, p0.y, g / w, k / h, 1].map((v) => v + 0);
}

/** Where a homography takes a point. */
export function mapPoint(m: readonly number[], x: number, y: number): LanePoint {
  const w = m[6] * x + m[7] * y + m[8];
  return { x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w };
}

/** A homography as a CSS matrix3d (for an element whose transform origin is its top left), moved by (dx, dy) px in the picture. */
export function cssMatrix(m: readonly number[], dx = 0, dy = 0): string {
  const s = 1 / m[8];
  const v = [
    (m[0] + dx * m[6]) * s, (m[3] + dy * m[6]) * s, 0, m[6] * s,
    (m[1] + dx * m[7]) * s, (m[4] + dy * m[7]) * s, 0, m[7] * s,
    0, 0, 1, 0,
    (m[2] + dx * m[8]) * s, (m[5] + dy * m[8]) * s, 0, 1,
  ];
  return `matrix3d(${v.map((n) => Number(n.toPrecision(9)) + 0).join(", ")})`;
}

/** The convex hull of some points (counter-clockwise in the picture's y-down frame, or clockwise: SAT does not mind). */
export function convexHull(points: readonly LanePoint[]): LanePoint[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length < 3) return sorted;
  const cross = (o: LanePoint, a: LanePoint, b: LanePoint) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: LanePoint[] = [], upper: LanePoint[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Whether two convex polygons meet (separating axes). */
export function polygonsMeet(a: readonly LanePoint[], b: readonly LanePoint[]) {
  for (const shape of [a, b]) for (let i = 0; i < shape.length; i++) {
    const p = shape[i], q = shape[(i + 1) % shape.length], nx = q.y - p.y, ny = p.x - q.x;
    let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
    for (const r of a) { const t = r.x * nx + r.y * ny; minA = Math.min(minA, t); maxA = Math.max(maxA, t); }
    for (const r of b) { const t = r.x * nx + r.y * ny; minB = Math.min(minB, t); maxB = Math.max(maxB, t); }
    if (maxA < minB || maxB < minA) return false;
  }
  return true;
}

const boxPolygon = (box: LaneBox, x = 0, y = 0): LanePoint[] => [
  { x: box.left - x, y: box.top - y }, { x: box.right + x, y: box.top - y },
  { x: box.right + x, y: box.bottom + y }, { x: box.left - x, y: box.bottom + y },
];

/** The flat homography of a line whose top left is at (x, top): a translation. */
const flat = (x: number, top: number) => [1, 0, x, 0, 1, top, 0, 0, 1];

/**
 * The slots, for the shelf at rest in `view`, set in `type`:
 * - `bracket`: the selection bracket at rest (the box of the lifted case at the resting lift,
 *   seen with the shelf's camera at rest), and `face`, the case's front face at rest (its top
 *   left corner is face[3]);
 * - `keep`: what else no name may meet (convex polygons: the lifted case through the idle drift,
 *   the paths of the bracket's squares as the selection steps and hops);
 * - `places`: where each neighbour's name may be printed, in order (LANE_PLANE).
 * The selected name, flat, by the bracket, as a block: its kicker, its name's first line and room
 * for a second (`type.selected`: the whole block keeps clear of everything), or, where no place at
 * the top of the bracket has room for that, for one (`lines`). First (2026-10-10;
 * not in portrait) left of it, ending LANE_LABEL.outside before its left squares (right-aligned:
 * align "end"), the middle of its name's first line a LANE_LABEL.left share of the bracket's
 * height under its top; then at the top of the bracket:
 * above it (from LANE_LABEL.inset right of
 * its top left square, or a `shift` further where the squares' paths are in the way, ending
 * before the top right square; its descenders LANE_LABEL.above and a `lift` over the top squares,
 * the highest lift first), only where that line's top is LANE_LABEL.header under the header's
 * bottom; or, beside the shelf (not in portrait), level with its top (the line's top level with
 * the top squares' tops, or as high as the header allows, or a `drop` lower), starting
 * LANE_LABEL.beside right of the top right square (or an `along` further where the squares'
 * paths are in the way). The first of all these with LANE_LABEL.room is taken, else the widest;
 * only where none has LANE_LABEL.least, under the bracket. Beside the shelf it ends LANE_LABEL.clear
 * before the right column's left edge level with its rows, `gap` before it well above them
 * (LANE_LABEL.over; `view.column`), never over it. Then the further name and
 * the nearer one (not in portrait), each at the first of its places with that room, else at the
 * one with the most. A name ends before anything it keeps clear of (the overlay's boxes by
 * LANE_LABEL.clear and clearY, the face, `keep` and the other names by LANE_LABEL.gap, the
 * picture's edges by `clear` and clearY), and is not shown with less room than LANE_LABEL.least.
 */
export function laneLabelSlots(
  bracket: LaneBox,
  view: LaneLabelView,
  type: Readonly<Record<LaneRole, LaneLabelType>>,
  face: readonly LanePoint[],
  keep: readonly (readonly LanePoint[])[] = [],
  places: Readonly<Record<LaneSide, readonly LanePlace[]>> = { nearer: [], further: [] },
): LaneLabelSlots {
  const { square, inset, above, beside, below, end, clear, clearY, gap, least, room } = LANE_LABEL;
  const boxes = view.avoid.filter((box) => box.right > box.left && box.bottom > box.top).map((box) => boxPolygon(box, clear, clearY));
  const taken: LanePoint[][] = [];
  // Whether a name `length` px long on homography `m` (its line `height` px) keeps clear of
  // everything (and of `also`: what only it keeps clear of).
  const clearAt = (m: readonly number[], length: number, height: number, also: readonly LanePoint[][]) => {
    const at = (x: number, y: number) => mapPoint(m, x, y);
    const line = [at(0, 0), at(length, 0), at(length, height), at(0, height)];
    if (line.some((p) => !(p.x >= clear && p.x <= view.width - clear && p.y >= clearY && p.y <= view.height - clearY))) return false;
    if (boxes.some((box) => polygonsMeet(line, box)) || also.some((shape) => polygonsMeet(line, shape))) return false;
    const wide = [at(-gap, -gap), at(length + gap, -gap), at(length + gap, height + gap), at(-gap, height + gap)];
    return !(face.length > 2 && polygonsMeet(wide, face)) && !keep.some((shape) => shape.length > 2 && polygonsMeet(wide, shape)) &&
      !taken.some((shape) => polygonsMeet(wide, shape));
  };
  // The longest length (whole px, at most `most`) that `fits`, or 0 where less than `floor` does
  // (a name that fits is clear at any shorter length, from its start or before its end alike).
  const longest = (fits: (length: number) => boolean, most: number, floor: number) => {
    if (!(most >= floor) || !fits(floor)) return 0;
    let low: number = floor, high = Math.floor(most);
    if (fits(high)) return high;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (fits(mid)) low = mid; else high = mid;
    }
    return low;
  };
  // The most room a name has from its start, or 0 where it has less than `floor` ...
  const roomOn = (m: readonly number[], height: number, most: number, also: readonly LanePoint[][] = [], floor: number = least) =>
    longest((length) => clearAt(m, length, height, also), most, floor);
  // ... and, flat, before its end: its line (its top at `top`) ends at `ends` and reaches left.
  const roomBefore = (ends: number, top: number, height: number, most: number, also: readonly LanePoint[][] = [], floor: number = least) =>
    longest((length) => clearAt(flat(ends - length, top), length, height, also), most, floor);
  const hidden = (place: string): LaneLabelSlot => ({ x: 0, y: 0, width: 0, shown: false, place });

  // The selected name, flat: its places in order (where its block starts, its name's first
  // baseline, the most it may be wide), at the top of the bracket, and under it only where those
  // have no room at all. The block is as tall as its kicker and two lines of the name, or, where
  // no place at the top has room for two, one (2026-10-18); it is shown only where it is as wide as
  // its kicker.
  const set = type.selected, line = set.line ?? set.ascent + set.descent, floor = Math.max(least, Math.ceil(set.least ?? 0));
  const ceiling = view.header.bottom + LANE_LABEL.header;
  const column = !view.portrait && view.column && view.column.right > view.column.left && Number.isFinite(view.column.left) ? view.column : undefined;
  // Beside the shelf, the right column's side: level with its rows the name keeps well clear (it
  // never reads as one of them); well above them it still never reaches over the column.
  const side = column ? [
    boxPolygon({ left: column.left, top: column.top - LANE_LABEL.over, right: column.left + view.width, bottom: 2 * view.height }, clear, 0),
    boxPolygon({ left: column.left, top: -view.height, right: column.left + view.width, bottom: column.top }, gap, 0),
  ] : [];
  // A place: where its line starts (`x`), or where it ends (`ends`: right-aligned), its baseline,
  // and the most it may be wide.
  type NamePlace = { place: string; x?: number; ends?: number; y: number; most: number };
  // Its places with `more` kept free under its name's first line: at the top of the bracket, and under it.
  const placesFor = (more: number) => {
    const atTop: NamePlace[] = [];
    // First left of the bracket (the owner, 2026-10-10: "the selected playlist name move here", the
    // empty corner left of the lifted case's top), not in portrait: right-aligned before its left
    // squares, near its top.
    if (!view.portrait) {
      const ends = bracket.left - square - LANE_LABEL.outside;
      for (const share of LANE_LABEL.left)
        atTop.push({ place: "left", ends, y: bracket.top + share * (bracket.bottom - bracket.top) + line / 2 - set.descent, most: ends - clear });
    }
    for (const lift of LANE_LABEL.lift) for (const shift of LANE_LABEL.shift) {
      const y = bracket.top - square - above - lift - set.descent - more, x = bracket.left + square + inset + shift;
      if (y - set.ascent >= ceiling) atTop.push({ place: "above", x, y, most: bracket.right - square - end - x });
    }
    // Beside the corner only beside the shelf: in portrait the further column there is lit.
    const level = Math.max(bracket.top - square, ceiling);
    if (!view.portrait) for (const drop of LANE_LABEL.drop) for (const along of LANE_LABEL.along) {
      const x = bracket.right + square + beside + along;
      atTop.push({ place: "corner", x, y: level + drop + set.ascent, most: (column ? column.left - gap : view.width - clear) - x });
    }
    const start = bracket.left + square + inset;
    const under: NamePlace[] = [{ place: "below", x: start, y: bracket.bottom + square + below + set.ascent, most: bracket.right - square - end - start }];
    return { atTop, under };
  };
  // Room for two lines of its name, else for one; at the top of the bracket before under it.
  const two = set.more ?? 0, plans = two > 0 ? [{ more: two, lines: 2 }, { more: 0, lines: 1 }] : [{ more: 0, lines: 1 }];
  let selected = hidden("none"), selectedLine: LanePoint[] = [];
  const tried: string[] = [];
  search: for (const where of ["atTop", "under"] as const) for (const { more, lines } of plans) {
    const height = set.ascent + set.descent + more;
    for (const option of placesFor(more)[where]) {
      const anchor = option.ends ?? option.x;
      if (anchor === undefined || !Number.isFinite(anchor) || !Number.isFinite(option.y)) continue;
      const top = option.y - set.ascent;
      const width = option.ends !== undefined ? roomBefore(option.ends, top, height, option.most, side, floor) : roomOn(flat(anchor, top), height, option.most, side, floor);
      tried.push(`${option.place} ${width}`);
      if (width > selected.width) {
        const x = option.ends !== undefined ? option.ends - width : anchor, matrix = flat(x, top);
        selected = { x: Math.round(x), y: Math.round(option.y), width, shown: true, place: option.place, lines, ...(option.ends !== undefined ? { align: "end" as const } : {}) };
        selectedLine = [mapPoint(matrix, 0, 0), mapPoint(matrix, width, 0), mapPoint(matrix, width, height), mapPoint(matrix, 0, height)];
      }
      if (width >= room) break;
    }
    if (selected.shown) break search;
  }
  if (selected.shown) taken.push(selectedLine);
  selected.place = `${selected.place} (${tried.slice(-3).join(", ")}; ${tried.length} tried)`;

  // The neighbours, on their planes.
  const neighbour = (role: LaneSide): LaneLabelSlot => {
    if (role === "nearer" && view.portrait) return hidden("portrait");
    const set = type[role], height = set.ascent + set.descent;
    let best: { place: LanePlace; width: number } | undefined;
    for (const place of places[role]) {
      const width = roomOn(place.matrix, height, place.reach);
      if (width > (best?.width ?? 0)) best = { place, width };
      if (width >= room) break;
    }
    if (!best) return hidden("none");
    const m = best.place.matrix, base = mapPoint(m, 0, set.ascent);
    taken.push([mapPoint(m, 0, 0), mapPoint(m, best.width, 0), mapPoint(m, best.width, height), mapPoint(m, 0, height)]);
    return { x: base.x, y: base.y, width: best.width, shown: true, matrix: m, place: `row ${best.place.row}, ${best.place.along}` };
  };
  const further = neighbour("further");
  return { selected, further, nearer: neighbour("nearer") };
}
