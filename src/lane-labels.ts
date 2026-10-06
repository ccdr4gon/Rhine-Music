/**
 * Names beside the shelf's columns (one NetEase playlist per column).
 *
 * Since 2026-10-06 the names are flat text over the picture (lane-names.ts), not writing in
 * the scene: the owner saw the names in the scene jiggle whenever the shelf switched
 * playlists and asked for "a relatively fixed 2D text". Each name has a FIXED place on the
 * screen for its role, a slot, and only moves from one slot to the next as the shelf slides
 * sideways:
 * - the selected column's: at the height of the top of the case right in front of the lifted
 *   one, along the width of the cases (it reads up and to the right, like their top edges),
 *   over the lower part of the lifted case's cover, half as large again as the other names;
 * - the column nearer the lens: written the same way across its own case in that row, at the
 *   other names' size (its edge runs down to the counter and the navigation);
 * - the column further from the lens: along its edge, falling toward the lens as the tops of
 *   the nearer column's cases do, and ending a few rows behind the selected row, where it
 *   shows above the selected column's shoulder and beside the lifted case's top edge. There
 *   is little room above that shoulder, so where it would reach the top of the picture it
 *   falls less steeply, and in short, wide windows (16:9 and wider) not at all: it is level
 *   there, never the other way.
 * Those are the places the owner marked on the shelf (2026-10-05) and approved with the names
 * in the scene. A slot is that place as the shelf shows it at rest, worked out once from the
 * shelf at rest and its camera at rest (laneLabelRest, laneLabelSlot): a point on the screen,
 * the angle of the baseline there, and the size the writing had. The camera does not move
 * while the shelf is browsed and the selected column is always in the middle, so the slots
 * change only with the window, its layout and the name itself (a name along an edge ends at
 * its place, so its length moves its start). Nothing that moves on the shelf moves a name:
 * not the waves, the lifted cases, the play gesture, the idle drift, nor a step along a
 * column; in a switch a name goes from slot to slot with the shelf's sideways track
 * (laneLabelPose). Opening an album or the song scene fades the names where they stand. In
 * the portrait layout the title and the navigation lie over the columns nearer the lens, so
 * those are not named there.
 */

/** What a column is called; `live` marks the column that is NetEase's playing queue. */
export interface LaneName { name: string; live: boolean }

export const LANE_LABEL = {
  /** The selected column's name (and the nearer column's): across the case this many rows in front of the selected row, */
  across: 1,
  /** starting this far in from the lifted case's edge that faces the lens (world units), */
  inset: 1.4,
  /** the selected one drawn this much larger than the other names, */
  size: 1.5,
  /** and this far in front of the case's front face (world units). */
  faceGap: 0.02,
  /**
   * Over this much of a column's width the selected column's name turns into the further
   * neighbour's along the edge as the shelf slides sideways (the one fades as the other fades
   * in). Toward the nearer neighbour it stays across and only shrinks.
   */
  turn: 0.5,
  /** Along the edge, a selected column's name would end this many rows from the selected row (behind it); it shows only while turning. */
  selected: -1,
  /** Each column further from the lens: its name ends this many rows further back. */
  behind: 2.5,
  /**
   * The further neighbour's name falls as the tops of the nearer column's cases do from this
   * many rows in front of the selected row (where that column's name started along its edge
   * until 2026-10-05).
   */
  front: 0.6,
  /** Columns up to this far from the selected one are named; the names fade out over `fade` more. */
  reach: 1.25,
  fade: 0.5,
  /**
   * The portrait layout's navigation lies over the top right of the picture, which is where a
   * name goes that slides on past the further column, and the selected name while it turns into
   * the further one's: there the further side fades from this far on instead of `reach`, and the
   * selected name turns within `portraitTurn` of a column instead of `turn`, so that neither
   * passes under the navigation while it can still be read (2026-10-06: up to 45 % of a name
   * crossed it in windows 600 to 1240 px wide).
   */
  portraitReach: 1,
  portraitTurn: 0.3,
  /**
   * Toward the lens a name fades from the nearer column on, within `nearFade` of a column: one
   * sliding further that way soon reaches the counter at the bottom left of the picture (at
   * 16:9 about a twentieth of a column further).
   */
  nearReach: 1,
  nearFade: 0.1,
  /** Above the top edge of the cases, and in front of the edge that faces the lens (world units). */
  rise: 0.03,
  stand: 0.12,
  /** Above the line of sight over a taller column in front (world units). */
  clear: 0.12,
  /**
   * The lifted case, in that line of sight, peaks at the selected row and slopes to nothing
   * this many rows to either side.
   */
  liftRamp: 0.6,
  /**
   * The line of sight may graze the top of the resting lifted case by this much (world units).
   * Until 2026-10-05 the sight line was taken at five places across the column in front, the
   * nearest about 0.06 rows off the lifted case's middle; taking it at the middle itself finds
   * the case about this much higher. Allowing for it keeps every name where it stood.
   */
  liftGraze: 0.03,
  /**
   * A name on an edge goes from standing on its own column to being seen over the one in front
   * over this much height (world units), not at a corner.
   */
  soften: 0.04,
  /**
   * The far neighbour's name falls less steeply rather than come nearer than this many CSS px
   * to the top of the picture; it never rises for it, so in short, wide windows (16:9) it is
   * level and can come nearer (about 20 px at 1920 x 1080, as before 2026-10-05).
   */
  margin: 44,
} as const;

/**
 * How a name is written, in world units of the shelf at its plain size (the measures it had as
 * writing in the scene, which were laid out at 256 pixels per unit): the room it takes across
 * its baseline, its widest and narrowest, the space before and after the writing, the baseline
 * above the bottom of that room, the name's font size, the number's, and the space between them.
 */
export const LANE_LABEL_TEXT = {
  height: 128 / 256,
  maxWidth: 2.5,
  minWidth: 0.3,
  margin: 20 / 256,
  baseline: 34 / 256,
  name: 54 / 256,
  index: 34 / 256,
  gap: 20 / 256,
} as const;

const smooth = (value: number) => {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
};
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const lerp = (from: number, to: number, share: number) => from + (to - from) * share;

/**
 * How much of a column's name is shown. `offset` is how many columns the column is from the
 * one the shelf is centred on (positive: further from the lens); it is fractional while the
 * shelf travels sideways. Columns too far to the side fade out; in the portrait layout
 * (`textBelow`, viewport-layout.ts) the nearer columns are not named and the further ones fade
 * out sooner (LANE_LABEL.portraitReach).
 */
export function laneLabelShare(offset: number, textBelow = false) {
  const share = offset < 0
    ? 1 - smooth((-offset - LANE_LABEL.nearReach) / LANE_LABEL.nearFade)
    : 1 - smooth((offset - (textBelow ? LANE_LABEL.portraitReach : LANE_LABEL.reach)) / LANE_LABEL.fade);
  return offset < 0 && textBelow ? share * (1 - smooth(-offset / LANE_LABEL.fade)) : share;
}

/**
 * The place of a name along a column's edge at rest (the further column's, and the selected
 * one's as it would stand along its own edge):
 * - `row`: where the name is anchored, in rows from the selected row along the column;
 * - `align`: which end of the name that is (1: it ends there, 0: it starts there).
 */
export function laneLabelPlace(offset: number) {
  return { row: LANE_LABEL.selected - LANE_LABEL.behind * Math.max(0, offset), align: 1 };
}

/**
 * How much of a column's name is written across its case in front of the selected row rather
 * than along its edge: all of the selected column's and the nearer ones'; the selected one's
 * turns into an edge name toward the further column (sooner in the portrait layout, `textBelow`:
 * LANE_LABEL.portraitTurn).
 */
export function laneLabelAcross(offset: number, textBelow = false) {
  return offset <= 0 ? 1 : 1 - smooth(offset / (textBelow ? LANE_LABEL.portraitTurn : LANE_LABEL.turn));
}

/** How large a name written across is: the selected column's LANE_LABEL.size, a nearer one's as large as the edge names. */
export function laneLabelSize(offset: number) {
  return 1 + (LANE_LABEL.size - 1) * (1 - smooth(-offset));
}

/** The rows a name of `length` rows covers at a place: from its start to its end. */
export function laneLabelSpan(place: { row: number; align: number }, length: number) {
  const from = place.row - place.align * length;
  return { from, to: from + length };
}

/** The columns whose names can be shown around a (fractional) centre column. */
export function laneLabelRange(centre: number) {
  const span = LANE_LABEL.reach + LANE_LABEL.fade;
  return { first: Math.ceil(centre - span), last: Math.floor(centre + span) };
}

/** The two digits a column is counted with (as the stepper does). */
export const laneLabelIndex = (column: number) => String(column + 1).padStart(2, "0");

/**
 * The larger of two heights, rounded over a band `soften` wide where they are close: the same
 * as Math.max outside the band, without a corner inside it (at most soften / 4 higher).
 */
export function laneLabelSoftMax(a: number, b: number, soften: number) {
  const d = a - b;
  if (soften <= 0 || Math.abs(d) >= soften) return Math.max(a, b);
  return (a + b) / 2 + (d * d) / (4 * soften) + soften / 4;
}

type Point = { x: number; y: number; z: number };

/** What a name on a column's edge is seen over: the shelf at rest around it and the eye. */
export interface LaneSight {
  eye: Point;
  /** The top of a column's cases `row` rows from the selected row, at rest. */
  top(lane: number, row: number): number;
  /** The world z of `row`. */
  depth(row: number): number;
  /** From the edge where a column's name stands to the far edge of the column in front (world x). */
  gap(lane: number): number;
  /** The width of the column in front (world x). */
  width: number;
  rowSpacing: number;
  /** How high the lifted case stands in a column, above its tops (world units). */
  lifted(lane: number): number;
}

/**
 * The lowest a name on the edge of column `lane` (at world x `x`, `row` rows from the selected
 * row) can stand and still be seen over the column in front: over its whole width (five
 * places across it) and over its lifted case, which peaks at the selected row and slopes to
 * nothing LANE_LABEL.liftRamp rows to either side; the line of sight is also taken exactly
 * where it crosses that peak and those feet over the column, so its highest point is never
 * missed.
 */
export function laneLabelSeen(s: LaneSight, lane: number, x: number, row: number) {
  const { eye } = s;
  const y = s.top(lane, row), z = s.depth(row), front = lane - 1, lift = s.lifted(front);
  const gap = s.gap(lane), ramp = LANE_LABEL.liftRamp;
  const toward = Math.max(1e-6, x - eye.x), rows = (eye.z - z) / s.rowSpacing;
  let over = -Infinity;
  const at = (reach: number) => {
    const along = row + reach * rows;
    over = Math.max(over, s.top(front, along) + lift * Math.max(0, 1 - Math.abs(along) / ramp) - reach * (eye.y - y) + LANE_LABEL.clear);
  };
  for (let step = 0; step <= 4; step++) at((gap + step * s.width / 4) / toward);
  if (Math.abs(rows) > 1e-6) {
    for (const along of [-ramp, 0, ramp]) {
      const reach = (along - row) / rows;
      if (reach > gap / toward && reach < (gap + s.width) / toward) at(reach);
    }
  }
  return laneLabelSoftMax(y, over, LANE_LABEL.soften);
}

/**
 * The shelf at rest around the selected column, which is lane 0 here (-1 is the column nearer
 * the lens, 1 the one further from it), with its lifted case at the resting lift, and the eye
 * of the shelf's camera at rest.
 */
export interface LaneRest extends LaneSight {
  /** The world x of a column's edge that faces the lens. */
  edge(lane: number): number;
  /** The world z of the front face of a case `row` rows from the selected row. */
  face(row: number): number;
  /** The highest a point at (x, z) can stand and stay LANE_LABEL.margin CSS px below the top of the picture. */
  ceiling(x: number, z: number): number;
}

/** Where a name stands on the shelf at rest: the line its writing stands on, from its start to its end, the way up, and how large it is. */
export interface LaneLabelLine { start: Point; end: Point; up: Point; size: number }

/**
 * The names' places on the shelf at rest, for a name `width` world units long at its plain size
 * (the names as they were written in the scene until 2026-10-06): the selected column's and the
 * nearer column's across their case in front of the selected row, the further column's along its
 * edge, and the selected column's as it would stand along its own edge (the place the further
 * name turns from as it becomes the selected one).
 */
export function laneLabelRest(s: LaneRest, width: number) {
  const across = (lane: number): LaneLabelLine => {
    const size = laneLabelSize(lane), row = LANE_LABEL.across;
    const start = { x: s.edge(lane) + LANE_LABEL.inset, y: s.top(lane, row), z: s.face(row) };
    return { start, end: { x: start.x + width * size, y: start.y, z: start.z }, up: { x: 0, y: 1, z: 0 }, size };
  };
  const length = width / s.rowSpacing;
  // How far the tops of the nearer column's cases fall over `length` rows toward the lens,
  // from just in front of the selected row, per unit.
  const slope = (s.top(-1, LANE_LABEL.front) - s.top(-1, LANE_LABEL.front + length)) / (length * s.rowSpacing);
  // How much of that fall a name along an edge keeps: all of it, or less where the further
  // neighbour's far end would come nearer than LANE_LABEL.margin to the top of the picture, or
  // none (level).
  const slant = (() => {
    const x = s.edge(1) - LANE_LABEL.stand, span = laneLabelSpan(laneLabelPlace(1), length);
    const from = s.depth(span.from), run = s.depth(span.to) - from;
    const low = Math.max(laneLabelSeen(s, 1, x, span.to), laneLabelSeen(s, 1, x, span.from) - slope * run);
    const high = s.ceiling(x, from) - LANE_LABEL_TEXT.height;
    return slope * run > 1e-6 ? Math.min(1, Math.max(0, (high - low) / (slope * run))) : 0;
  })();
  const along = (lane: number): LaneLabelLine => {
    const x = s.edge(lane) - LANE_LABEL.stand, span = laneLabelSpan(laneLabelPlace(lane), length);
    const from = s.depth(span.from), to = s.depth(span.to), run = to - from;
    // Falling toward the lens as the nearer column's tops do, as low as both ends are seen,
    // and less steeply where that would reach the top of the picture; never the other way.
    const near = laneLabelSeen(s, lane, x, span.from);
    const low = Math.max(laneLabelSeen(s, lane, x, span.to), near - slope * run);
    const start = { x, y: Math.max(low, near, low + slant * slope * run), z: from };
    const end = { x, y: low, z: to };
    const pitch = Math.atan2(end.y - start.y, end.z - start.z);
    return { start, end, up: { x: 0, y: Math.cos(pitch), z: -Math.sin(pitch) }, size: 1 };
  };
  return { selected: across(0), nearer: across(-1), turning: along(0), further: along(1) };
}

/**
 * A name's place on the screen: its anchor (CSS px from the picture's top left), the angle of
 * its baseline there (radians, clockwise), and the name's font size (CSS px). Across a case the
 * anchor is where the writing starts; along an edge, where it ends.
 */
export interface LaneLabelSlot { x: number; y: number; angle: number; font: number }
export interface LaneLabelSlots { selected: LaneLabelSlot; nearer: LaneLabelSlot; turning: LaneLabelSlot; further: LaneLabelSlot }

/**
 * Where a name standing on `line` is on the screen, seen through `project` (world to CSS px).
 * `align`: the anchor is the writing's start (0) or its end (1), its baseline LANE_LABEL_TEXT
 * above the line; the font size is the name's height on screen across the baseline.
 */
export function laneLabelSlot(line: LaneLabelLine, align: number, project: (x: number, y: number, z: number) => { x: number; y: number }): LaneLabelSlot {
  const { start, end, up, size } = line;
  const run = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z) || 1;
  const along = { x: (end.x - start.x) / run, y: (end.y - start.y) / run, z: (end.z - start.z) / run };
  const from = align ? end : start, inward = (align ? -1 : 1) * LANE_LABEL_TEXT.margin * size, rise = LANE_LABEL_TEXT.baseline * size;
  const anchor = { x: from.x + along.x * inward + up.x * rise, y: from.y + along.y * inward + up.y * rise, z: from.z + along.z * inward + up.z * rise };
  const step = 0.1;
  const a = project(anchor.x, anchor.y, anchor.z);
  const b = project(anchor.x + along.x * step, anchor.y + along.y * step, anchor.z + along.z * step);
  const c = project(anchor.x + up.x * step, anchor.y + up.y * step, anchor.z + up.z * step);
  const bx = b.x - a.x, by = b.y - a.y, length = Math.hypot(bx, by) || 1;
  // Across the baseline: the part of the way up that is not along it.
  const across = Math.abs(bx * (c.y - a.y) - by * (c.x - a.x)) / length;
  return { x: a.x, y: a.y, angle: Math.atan2(by, bx), font: LANE_LABEL_TEXT.name * size * across / step };
}

/**
 * Where a column's name is on the screen when its column is `offset` columns from the one the
 * shelf is centred on (fractional while the shelf slides sideways): it goes from slot to slot in
 * a straight line with the shelf's sideways track, and on along the same line beyond the last
 * slot while it fades out (laneLabelShare). Written across a case (`across`): the nearer
 * column's slot at -1, the selected column's at 0, growing to the selected one's size as
 * laneLabelSize does; along the edge (`along`): the selected column's edge at 0, the further
 * column's slot at 1. `share` is how much of each is shown: the selected name turns into the
 * further one's as a cross-fade (laneLabelAcross; sooner in the portrait layout, `textBelow`).
 */
export function laneLabelPose(offset: number, slots: LaneLabelSlots, textBelow = false) {
  const { nearer, selected, turning, further } = slots;
  const grown = (laneLabelSize(offset) - 1) / (LANE_LABEL.size - 1);
  const toward = offset + 1, turned = laneLabelAcross(offset, textBelow);
  return {
    across: {
      x: lerp(nearer.x, selected.x, toward), y: lerp(nearer.y, selected.y, toward),
      angle: lerp(nearer.angle, selected.angle, clamp01(toward)), font: lerp(nearer.font, selected.font, grown),
      align: 0, share: turned,
    },
    along: {
      x: lerp(turning.x, further.x, offset), y: lerp(turning.y, further.y, offset),
      angle: lerp(turning.angle, further.angle, clamp01(offset)), font: lerp(turning.font, further.font, clamp01(offset)),
      align: 1, share: 1 - turned,
    },
  };
}
