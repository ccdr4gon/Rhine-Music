import { MUSIC_MODEL } from "./music-model.ts";
import { COLUMN_SPACING, ROW_SPACING } from "./archive-loop.ts";
import { smooth } from "./motion.ts";

/**
 * The song scene. The lifted case becomes a large card left of centre, the cases around
 * it in its shelf row leave the row and line up as a chain of covers that runs from the
 * far left, under the card, off the bottom of the picture, and the rest of the shelf
 * sinks out of view. The chain is the shelf row itself: it shows what the row shows and
 * moves when the row moves. The lifted case's own place is at the chain's bend, right
 * below the large card: a newly selected case leaves from the place next to it while the
 * chain flows by one, and rises almost straight, with no dip and no swing in from the
 * side; the case it replaces returns the same way. The queue runs the way it runs on the
 * shelf and under the opened case, towards the camera: the cases after the lifted one come
 * down towards the bottom (nearest the camera), the cases before it go back towards the
 * far left. Moving on through the queue, the chain flows from the bottom to the far left.
 *
 * Chain coordinates are camera-aligned world units at the large card's depth: x to the
 * right, y up, z towards the camera, origin at the large card's centre.
 */
export const SONG_VIEW = {
  /** Camera direction in degrees; the album detail uses 8 and 20. */
  yaw: 8,
  elevation: 9,
  /** World units across the picture's height: the 4.45-wide case is about 37 % of it. */
  span: 12,
  /** The camera's distance from the large card's plane: the album detail's, which the song view keeps. */
  distance: 72,
} as const;

/** The least the shelf sinks: at the landscape song camera this is below the picture and in the fog. */
export const SONG_SHELF_DROP = 10;
/**
 * How far the shelf sinks when the picture shows `below` world units under the large
 * card's centre: tall windows show more, and the shelf must still end below the picture.
 */
export const songShelfDrop = (below: number) => Math.max(SONG_SHELF_DROP, below + 1);
/** The chain's last position in an ordinary window; wide, short windows show further ones (songChainCards). */
export const SONG_CHAIN_CARDS = 13;
const CHAIN_LIMIT = 32;
/**
 * The chain position of the lifted case's own slot: the bend right below the large card
 * (the owner marked it there). An unlifted case stands straight below the large card, almost
 * exactly at this place, so from here and from the places beside it (where a step starts) it
 * rises nearly straight; further along the chain it would have to drop first and swing in
 * from the lower left.
 */
export const SONG_CHAIN_CENTRE = 2;
/** The first card of the chain in an ordinary window: its top edge is just below the picture. */
export const SONG_CHAIN_FIRST = -1;
const CHAIN_FIRST_LIMIT = -10;

// The middles of the cards' top edges lie on this quadratic curve, nearest card first.
const NEAR = [1.3, -6.1], BEND = [-0.73, -1.46], FAR = [-6.7, 0.46];
const STEP = 0.875;
const NEAR_SCALE = 0.52;
const SCALE_RATIO = 0.95;
// Each card stands this much farther from the camera than the one before it: they are
// parallel sheets that never touch, the far ones dissolve in the fog and soften in the
// depth of field, and all of them pass behind the large card.
const NEAR_DEPTH = -1;
const DEPTH_STEP = 0.35;
// Upright cards seen from in front and above: turned to the right and leaning to the camera.
const YAW = 28;
const PITCH = 18;
const NEAR_ROLL = -5;
const FAR_ROLL = 2;

const point = (t: number, axis: 0 | 1) =>
  (1 - t) * (1 - t) * NEAR[axis] + 2 * (1 - t) * t * BEND[axis] + t * t * FAR[axis];

// Arc length along the curve, so that cards sit at equal distances on screen.
const SAMPLES = 96;
const lengths = new Float64Array(SAMPLES + 1);
for (let i = 1; i <= SAMPLES; i++) {
  const a = (i - 1) / SAMPLES, b = i / SAMPLES;
  lengths[i] = lengths[i - 1] + Math.hypot(point(b, 0) - point(a, 0), point(b, 1) - point(a, 1));
}
const LENGTH = lengths[SAMPLES];

function along(distance: number): [number, number] {
  if (distance <= 0 || distance >= LENGTH) {
    // Beyond either end the chain continues straight along the curve's end tangent.
    const [from, to, end] = distance <= 0 ? [NEAR, BEND, NEAR] : [BEND, FAR, FAR];
    const dx = to[0] - from[0], dy = to[1] - from[1], size = Math.hypot(dx, dy);
    const beyond = distance <= 0 ? distance : distance - LENGTH;
    return [end[0] + (dx / size) * beyond, end[1] + (dy / size) * beyond];
  }
  let low = 0, high = SAMPLES;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (lengths[middle] <= distance) low = middle; else high = middle;
  }
  const t = (low + (distance - lengths[low]) / (lengths[high] - lengths[low])) / SAMPLES;
  return [point(t, 0), point(t, 1)];
}

export interface SongChainPose {
  /** Middle of the card's top edge. */
  x: number; y: number; z: number;
  /** Degrees, applied as roll · yaw · pitch on the camera-aligned frame. */
  yaw: number; pitch: number; roll: number;
  scale: number;
}

/**
 * `u` is the position along the chain: SONG_CHAIN_CENTRE is the lifted case's own slot, smaller
 * values run towards the bottom of the picture (down to songChainFirst: the songs after it),
 * larger ones towards the far left (up to songChainCards: the songs before it). The row's
 * motion makes it fractional.
 */
export function songChainPose(u: number): SongChainPose {
  const [x, y] = along((u + 1) * STEP);
  const bounded = Math.max(CHAIN_FIRST_LIMIT - 2, Math.min(CHAIN_LIMIT, u));
  return {
    x, y,
    z: NEAR_DEPTH - DEPTH_STEP * bounded,
    yaw: YAW,
    pitch: PITCH,
    roll: NEAR_ROLL + (FAR_ROLL - NEAR_ROLL) * Math.max(0, Math.min(1, bounded / 8)),
    scale: NEAR_SCALE * SCALE_RATIO ** bounded,
  };
}

/**
 * How much a slot belongs to the chain, by its position along it: every card from `first`
 * onwards, none before it. The first card lies below the picture (songChainFirst) and the
 * last one past its left edge (songChainCards), so the row joins and leaves the chain out of
 * sight; a slot between `first - 1` and `first` travels straight between its sunken shelf
 * place and the first card's.
 */
export function songChainWeight(u: number, first = SONG_CHAIN_FIRST) {
  return smooth(u - first + 1);
}

/**
 * How far a slot stands above its shelf height on the way between the shelf and the chain:
 * `weight` of the way to its chain place at `chainY`, the rest of the way down with the
 * sunken shelf (`drop` below `shelfY`), all scaled by the scene's `progress`. Linear in the
 * weight: a slot joining or leaving the chain's near end travels straight between two
 * places that are both below the picture.
 */
export function songSlotRise(shelfY: number, chainY: number, drop: number, weight: number, progress: number) {
  return ((chainY - shelfY) * weight - drop * (1 - weight)) * progress;
}

/**
 * The first card the chain needs when the picture shows `below` world units under the
 * large card's centre: tall and narrow windows show more, and the chain must still enter
 * from below the picture.
 */
export function songChainFirst(below: number) {
  let first = SONG_CHAIN_FIRST;
  while (first > CHAIN_FIRST_LIMIT && songChainPose(first).y > -below) first--;
  return first;
}

/** The right-most reach of a chain card on screen, in the chain's coordinates. */
export function songChainReach(u: number) {
  const pose = songChainPose(u);
  const yaw = (pose.yaw * Math.PI) / 180, lean = (pose.pitch * Math.PI) / 180;
  return pose.x + (Math.cos(yaw) * MUSIC_MODEL.width / 2 + Math.sin(yaw) * Math.sin(lean) * SONG_CARD_TOP) * pose.scale;
}

/**
 * How many cards the chain needs before it has left a picture whose left edge is `left`
 * world units from the large card's centre. Short, wide windows show more of the row.
 * `centre` is the picture's centre measured from the large card (world units to its right)
 * and `distance` the camera's distance from the card's plane; without them the count is
 * the orthographic one.
 */
export function songChainCards(left: number, centre = 0, distance = Infinity) {
  // The far cards lie behind the large card's plane, where the camera's perspective draws
  // them nearer the picture's centre: in a wide window that is well to their right. A card's
  // right edge, turned away from the camera, is the deepest part of it.
  const shown = (u: number) => {
    const pose = songChainPose(u);
    const edge = pose.z - Math.sin((pose.yaw * Math.PI) / 180) * MUSIC_MODEL.width / 2 * pose.scale;
    return centre + (songChainReach(u) - centre) * (Number.isFinite(distance) ? distance / (distance - edge) : 1);
  };
  let cards = SONG_CHAIN_CARDS;
  while (cards < CHAIN_LIMIT && shown(cards + 0.5) > -left) cards++;
  return cards;
}

/** Only the lane under the camera forms a chain; lanes cross-fade while the shelf slides. */
export function songLaneWeight(lanes: number) {
  return smooth(1 - Math.abs(lanes));
}

/**
 * A slot's position along the chain from its offset to the inspection slot (world units):
 * the lifted case's own slot is the chain's centre. Later rows lie nearer the camera on the
 * shelf (+z) and count down towards the chain's near end; earlier rows count up towards
 * its far end. So the queue keeps its direction from the shelf and the opened case into
 * the song scene, and no case crosses another on the way.
 */
export const songChainIndex = (z: number) => SONG_CHAIN_CENTRE - z / ROW_SPACING;
export const songLaneOffset = (x: number) => x / COLUMN_SPACING;

/**
 * A lifted case sheds the chain's displacement during the first part of its rise: 1 on
 * the shelf, 0 from this share of the inspection lift upwards.
 */
export function songLiftHold(lift: number, inspectionLift: number) {
  return 1 - smooth(lift / (0.45 * inspectionLift));
}

/** Distance from a case's origin (the middle of its base) to the middle of its top edge. */
export const SONG_CARD_TOP = MUSIC_MODEL.center.y + MUSIC_MODEL.height / 2;
