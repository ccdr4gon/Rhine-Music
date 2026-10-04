/**
 * Names beside the shelf's columns (one NetEase playlist per column).
 *
 * The shelf camera looks along the rows from above and to one side, so a column shows the
 * lens the edge of its cases that faces it; everything below that edge's top is covered by
 * the column in front. A name therefore stands on that top edge. Along the edge it is placed
 * in rows from the selected row, close to it, where the picture is centred and the lens is
 * sharp, and on the side of the lifted case that the interface leaves clear (the detail
 * text and, at night, its dark veil lie over the other side):
 * - the selected column: the name ends just behind the lifted case, so the case and its
 *   spine stay clear;
 * - the column further from the lens: the name ends a few rows further back, where it shows
 *   above the selected column's shoulder and beside the lifted case's top edge;
 * - the column nearer the lens: its rows behind the selected one have left the picture, so
 *   its name starts just in front of the selected row instead.
 * In the portrait layout the title and the navigation lie over the columns nearer the lens,
 * so those are not named there. The names are written in the scene (lane-plates.ts).
 */
/** What a column is called; `live` marks the column that is NetEase's playing queue. */
export interface LaneName { name: string; live: boolean }

export const LANE_LABEL = {
  /** The selected column's name ends this many rows from the selected row (behind it). */
  selected: -1,
  /** Each column further from the lens: its name ends this many rows further back. */
  behind: 2.5,
  /** The column nearer the lens: its name starts this many rows in front of the selected row. */
  front: 0.6,
  /** Each column nearer still starts this many rows further to the front. */
  step: 4,
  /** Columns up to this far from the selected one are named; the names fade out over `fade` more. */
  reach: 1.25,
  fade: 0.5,
  /** Above the top edge of the cases, and in front of the edge that faces the lens (world units). */
  rise: 0.03,
  stand: 0.12,
  /** Above the line of sight over a taller column in front (world units). */
  clear: 0.12,
} as const;

const smooth = (value: number) => {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
};

/**
 * The place of a column's name. `offset` is how many columns the column is from the one the
 * shelf is centred on (positive: further from the lens); it is fractional while the shelf
 * travels sideways, and the place moves with it without a jump.
 * - `row`: where the name is anchored, in rows from the selected row along the column;
 * - `align`: which end of the name that is (1: it ends there, 0: it starts there);
 * - `share`: how much of the name is shown (0 for columns too far to the side).
 * `textBelow` is the portrait layout (viewport-layout.ts).
 */
export function laneLabelPlace(offset: number, textBelow = false) {
  const { selected, behind, front, step, reach, fade } = LANE_LABEL;
  const share = 1 - smooth((Math.abs(offset) - reach) / fade);
  if (offset >= 0) return { row: selected - behind * offset, align: 1, share };
  const near = Math.min(1, -offset);
  return {
    // Exact at both ends.
    row: (1 - near) * selected + near * front + step * Math.max(0, -offset - 1),
    align: 1 - near,
    share: share * (1 - (textBelow ? smooth(-offset / fade) : 0)),
  };
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
