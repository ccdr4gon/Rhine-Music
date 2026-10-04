import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SONG_CARD_TOP, SONG_CHAIN_CARDS, SONG_CHAIN_CENTRE, SONG_CHAIN_FIRST, SONG_SHELF_DROP, SONG_VIEW,
  songChainCards, songChainFirst, songChainIndex, songChainPose, songChainReach, songChainWeight, songLaneOffset, songLaneWeight, songLiftHold, songShelfDrop, songSlotRise,
} from '../src/song-pose.ts';
import { MUSIC_MODEL } from '../src/music-model.ts';
import { COLUMN_SPACING, ROW_SPACING } from '../src/archive-loop.ts';
import { songCardRect, songFraming, isPortraitViewport } from '../src/viewport-layout.ts';
import { damp } from '../src/motion.ts';

const radians = (degrees) => degrees * Math.PI / 180;
// The card's axes in the camera-aligned frame: roll · yaw · pitch, as the scene applies them.
function axes(pose) {
  const [p, y, r] = [radians(pose.pitch), radians(pose.yaw), radians(pose.roll)];
  const rotate = ([vx, vy, vz]) => {
    // pitch about x
    [vy, vz] = [vy * Math.cos(p) - vz * Math.sin(p), vy * Math.sin(p) + vz * Math.cos(p)];
    // yaw about y
    [vx, vz] = [vx * Math.cos(y) + vz * Math.sin(y), -vx * Math.sin(y) + vz * Math.cos(y)];
    // roll about z
    [vx, vy] = [vx * Math.cos(r) - vy * Math.sin(r), vx * Math.sin(r) + vy * Math.cos(r)];
    return [vx, vy, vz];
  };
  return { right: rotate([1, 0, 0]), up: rotate([0, 1, 0]), normal: rotate([0, 0, 1]) };
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

test('the rows around the lifted case, in the lane under the camera, form the chain', () => {
  assert.equal(songChainWeight(-2), 0);
  assert.equal(songChainWeight(-7), 0);
  assert.equal(songChainWeight(-1), 1);
  assert.equal(songChainWeight(0), 1);
  assert.equal(songChainWeight(40), 1);
  for (let u = -2; u < -1; u += 0.05) assert.ok(songChainWeight(u + 0.05) >= songChainWeight(u), 'the hand-over is monotonic');
  assert.equal(songLaneWeight(0), 1);
  assert.equal(songLaneWeight(1), 0);
  assert.equal(songLaneWeight(-1), 0);
  assert.equal(songLaneWeight(3), 0);
  assert.ok(Math.abs(songLaneWeight(0.5) + songLaneWeight(-0.5) - 1) < 1e-9, 'two lanes cross-fade while the shelf slides');
  // Slot offsets from the inspection slot, in world units.
  assert.equal(songChainIndex(0), SONG_CHAIN_CENTRE, 'the lifted case owns the slot in the middle of the chain');
  // The queue keeps the shelf's direction: later rows (nearer the camera on the shelf, +z) come
  // to the chain's near end, under the large card; earlier rows go back to its far end.
  assert.equal(songChainIndex(ROW_SPACING), SONG_CHAIN_CENTRE - 1, 'later rows run on towards the near end');
  assert.equal(songChainIndex(-3 * ROW_SPACING), SONG_CHAIN_CENTRE + 3, 'earlier rows run on towards the far end');
  assert.ok(songChainPose(songChainIndex(ROW_SPACING)).z > songChainPose(songChainIndex(-ROW_SPACING)).z, 'the later card is the nearer one, as on the shelf');
  // The chain can start earlier (tall windows): the hand-over moves with its first card.
  assert.equal(songChainWeight(-4, -4), 1);
  assert.equal(songChainWeight(-5, -4), 0);
  assert.equal(songChainWeight(SONG_CHAIN_FIRST), 1);
  assert.equal(songLaneOffset(COLUMN_SPACING), 1);
});

test('cards sit at equal steps along the curve, shrink and recede towards the far end', () => {
  const poses = Array.from({ length: SONG_CHAIN_CARDS + 3 }, (_, i) => songChainPose(i - 1));
  const steps = poses.slice(1).map((pose, i) => Math.hypot(pose.x - poses[i].x, pose.y - poses[i].y));
  for (const step of steps) assert.ok(Math.abs(step - steps[0]) < 0.02, `equal screen steps, got ${steps.map((s) => s.toFixed(3))}`);
  for (let i = 1; i < poses.length; i++) {
    assert.ok(poses[i].scale < poses[i - 1].scale, 'farther cards are smaller');
    assert.ok(poses[i].z < poses[i - 1].z, 'farther cards stand farther from the camera');
    assert.ok(poses[i].x < poses[i - 1].x, 'the chain runs to the left');
  }
  assert.ok(poses.every((pose) => pose.z < -MUSIC_MODEL.depth), 'every card passes behind the large card');
  assert.ok(poses[1].scale < 0.6 && poses[1].scale > 0.4, 'card 0 is about half the large card');
  // Fractional positions (the row is moving) lie between their neighbours.
  const half = songChainPose(2.5), a = songChainPose(2), b = songChainPose(3);
  for (const key of ['x', 'y', 'z', 'scale']) assert.ok(half[key] <= Math.max(a[key], b[key]) && half[key] >= Math.min(a[key], b[key]));
});

test('neighbouring cards are parallel sheets that never touch, nearer ones in front', () => {
  for (let u = -2; u <= SONG_CHAIN_CARDS + 1; u++) {
    const near = songChainPose(u), far = songChainPose(u + 1);
    const { normal } = axes(near);
    assert.ok(normal[2] > 0.7, 'cards face the camera');
    const gap = dot([far.x - near.x, far.y - near.y, far.z - near.z], normal);
    assert.ok(gap < -MUSIC_MODEL.depth * near.scale * 1.5, `card ${u + 1} stands clear behind card ${u} (gap ${gap.toFixed(3)})`);
  }
});

// Where a case's origin (the middle of its base) stands at a chain place.
function chainOrigin(u) {
  const pose = songChainPose(u), { up } = axes(pose);
  return [pose.x - up[0] * SONG_CARD_TOP * pose.scale, pose.y - up[1] * SONG_CARD_TOP * pose.scale];
}

test('the lifted case leaves its place at the bend right below the large card', () => {
  // 16:9: the picture reaches half the span below the card and 0.505 heights to its left.
  const below = (1 - songFraming(1920, 1080, SONG_VIEW.span).y) * SONG_VIEW.span, left = 0.505 * SONG_VIEW.span;
  const inside = (u) => { const pose = songChainPose(u); return pose.y - 0.6 > -below && songChainReach(u) - 1 > -left; };
  assert.ok(inside(SONG_CHAIN_CENTRE), 'its own slot is inside the picture');
  // The near end (u below the centre) holds the songs after the selection, the far end those before it.
  const after = [], before = [];
  for (let u = SONG_CHAIN_FIRST; u < SONG_CHAIN_CENTRE; u++) if (inside(u)) after.push(u);
  for (let u = SONG_CHAIN_CENTRE + 1; u <= SONG_CHAIN_CARDS; u++) if (inside(u)) before.push(u);
  assert.ok(after.length >= 1 && before.length >= 4, `cards on both sides: ${after.length} after, ${before.length} before`);
  // Later rows are the nearer, larger cards; earlier rows recede.
  assert.ok(songChainPose(SONG_CHAIN_CENTRE - 1).scale > songChainPose(SONG_CHAIN_CENTRE + 1).scale);
  // Its slot is under the large card: below its bottom edge, within its width.
  const slot = songChainPose(SONG_CHAIN_CENTRE);
  assert.ok(Math.abs(slot.x) < MUSIC_MODEL.width / 2 && slot.y < -MUSIC_MODEL.height / 2 - 1, `slot at ${slot.x.toFixed(2)}, ${slot.y.toFixed(2)}`);
});

test('a case rises from its chain place to the large card without dipping or swinging', () => {
  // The large card's centre is the origin; unlifted, the case's origin stands the whole lift below its lifted place.
  const lift = MUSIC_MODEL.height + 0.12;   // scene.ts MUSIC_INSPECTION_LIFT
  const home = [0, -MUSIC_MODEL.center.y - lift];
  // As the scene poses it: the shelf place plus the lift, plus what is left of the way to the chain place.
  const path = (u) => {
    const [x, y] = chainOrigin(u), points = [];
    for (let step = 0; step <= 200; step++) {
      const risen = lift * step / 200, hold = songLiftHold(risen, lift);
      points.push([home[0] + (x - home[0]) * hold, home[1] + risen + (y - home[1]) * hold]);
    }
    return points;
  };
  const turns = (points) => {
    let down = 0, sideways = 0;
    for (let i = 1; i < points.length; i++) {
      down = Math.max(down, points[i - 1][1] - points[i][1]);
      sideways = Math.max(sideways, Math.abs(points[i][0] - points[0][0]));
    }
    return { down, sideways, start: points[0], end: points[points.length - 1] };
  };
  const own = turns(path(SONG_CHAIN_CENTRE));
  assert.ok(Math.abs(own.end[0]) < 1e-9 && Math.abs(own.end[1] + MUSIC_MODEL.center.y) < 1e-9, 'it ends as the large card');
  assert.equal(own.down, 0, 'it never moves down on the way up');
  assert.ok(own.sideways < 0.5, `and stays under the large card (${own.sideways.toFixed(2)} to the side)`);
  // The place is almost where an unlifted case stands anyway.
  const [slotX, slotY] = chainOrigin(SONG_CHAIN_CENTRE);
  assert.ok(Math.hypot(slotX - home[0], slotY - home[1]) < 0.5, `the chain place is the case's own lowered place (${(slotX - home[0]).toFixed(2)}, ${(slotY - home[1]).toFixed(2)} apart)`);
  let sunk = 0;
  for (const [, y] of path(SONG_CHAIN_CENTRE)) sunk = Math.max(sunk, own.start[1] - y);
  assert.equal(sunk, 0, 'nor below where it started');
  // The reason for the place: from further along the chain a case first drops, then swings in from the left.
  const far = turns(path(6));
  let farSunk = 0;
  for (const [, y] of path(6)) farSunk = Math.max(farSunk, far.start[1] - y);
  assert.ok(farSunk > 0.3 && far.sideways > 2.5, `from place 6 it would dip ${farSunk.toFixed(2)} and travel ${far.sideways.toFixed(2)} sideways`);
});

test('a step to the next or the previous case rises without a real dip while the chain flows', () => {
  // What a step does: the newly selected case stands one place beside the selection's place and
  // the row flows it there while it lifts, both on the scene's springs (rate 9, scene.ts
  // MUSIC_ALBUM_SWITCH_RATE). The path is that of the case's origin, as in the test above.
  const lift = MUSIC_MODEL.height + 0.12, home = [0, -MUSIC_MODEL.center.y - lift], rate = 9;
  const step = (centre, direction) => {
    const place = { value: centre + direction, velocity: 0 }, risen = { value: 0, velocity: 0 };
    const points = [];
    for (let frame = 0; frame <= 240; frame++) {
      const hold = songLiftHold(risen.value, lift), [x, y] = chainOrigin(place.value);
      points.push([home[0] + (x - home[0]) * hold, home[1] + risen.value + (y - home[1]) * hold]);
      damp(place, centre, rate, 1 / 120); damp(risen, lift, rate, 1 / 120);
    }
    let down = 0, sunk = 0, sideways = 0;
    for (let i = 1; i < points.length; i++) {
      down = Math.max(down, points[i - 1][1] - points[i][1]);
      sunk = Math.max(sunk, points[0][1] - points[i][1]);
      sideways = Math.max(sideways, Math.abs(points[i][0] - points[0][0]));
    }
    return { down, sunk, sideways, end: points[points.length - 1] };
  };
  for (const direction of [1, -1]) {
    // A step along u: the later songs lie at smaller u, so +1 is a step back to the previous song.
    const own = step(SONG_CHAIN_CENTRE, direction), label = direction > 0 ? 'previous' : 'next';
    assert.ok(Math.abs(own.end[0]) < 0.01 && Math.abs(own.end[1] + MUSIC_MODEL.center.y) < 0.01, `${label}: it ends as the large card`);
    // The origin may ease down by a hair while the row carries the case to its place (under a tenth of a unit, 7 px at 1080p).
    assert.ok(own.sunk < 0.1, `${label}: no dip to speak of (${own.sunk.toFixed(3)} below its start)`);
    assert.ok(own.sideways < 1, `${label}: it stays under the large card (${own.sideways.toFixed(2)} sideways)`);
    // From the old place (6) the same step dropped well below its start and swung in from the lower left.
    const old = step(6, direction);
    assert.ok(old.sunk > 0.5 && old.sideways > 2 * own.sideways, `${label}: place 6 dipped ${old.sunk.toFixed(2)} and travelled ${old.sideways.toFixed(2)}`);
  }
});

test('a slot joining the chain travels straight from the sunken shelf, below the picture', () => {
  // Heights measured from the large card's centre; a shelf slot stands about there before it sinks.
  for (const [width, height] of [[1920, 1080], [1280, 1024], [960, 1040], [900, 1400], [640, 1400], [1920, 500]]) {
    const framing = songFraming(width, height, SONG_VIEW.span);
    const below = (1 - framing.y) * framing.span, drop = songShelfDrop(below), first = songChainFirst(below);
    for (const shelfY of [-1, 0, 0.6]) {
      assert.equal(songSlotRise(shelfY, 5, drop, 0, 1), -drop, 'outside the chain a slot sinks with the shelf');
      assert.equal(songSlotRise(shelfY, 5, drop, 1, 1), 5 - shelfY, 'in the chain it stands at its chain place');
      assert.equal(Math.abs(songSlotRise(shelfY, 5, drop, 0.4, 0)), 0, 'and nothing moves before the scene opens');
      // The hand-over: between the place before the first card and the first card.
      for (let u = first - 1; u <= first + 1e-9; u += 0.05) {
        const weight = songChainWeight(u, first), chainY = songChainPose(u).y;
        const y = shelfY + songSlotRise(shelfY, chainY, drop, weight, 1);
        const straight = (shelfY - drop) * (1 - weight) + chainY * weight;
        assert.ok(Math.abs(y - straight) < 1e-9, `${width}x${height}: u ${u.toFixed(2)} lies on the straight path`);
        assert.ok(y <= Math.max(shelfY - drop, songChainPose(first).y) + 1e-9, `${width}x${height}: u ${u.toFixed(2)} never rises above both ends (${y.toFixed(2)})`);
        assert.ok(y < -below, `${width}x${height}: u ${u.toFixed(2)} stays below the picture (${y.toFixed(2)} < ${(-below).toFixed(2)})`);
      }
    }
  }
});

test('the chain enters from below the picture in every window', () => {
  for (const [width, height] of [[1920, 1080], [2560, 1080], [1440, 900], [1366, 730]]) {
    const framing = songFraming(width, height, SONG_VIEW.span);
    assert.equal(songChainFirst((1 - framing.y) * framing.span), SONG_CHAIN_FIRST, `${width}x${height}: ordinary windows start at the same card`);
  }
  for (const [width, height] of [[1280, 1024], [1100, 1000], [900, 1400], [640, 1400], [390, 844]]) {
    const framing = songFraming(width, height, SONG_VIEW.span), below = (1 - framing.y) * framing.span;
    const first = songChainFirst(below);
    assert.ok(first < SONG_CHAIN_FIRST, `${width}x${height}: a taller picture starts the chain earlier (${first})`);
    assert.ok(songChainPose(first).y <= -below || first === -10, `${width}x${height}: its first card starts below the picture`);
  }
  // Cards before the ordinary first one keep clear of each other too.
  for (let u = -10; u < 0; u++) {
    const near = songChainPose(u), far = songChainPose(u + 1), { normal } = axes(near);
    const gap = dot([far.x - near.x, far.y - near.y, far.z - near.z], normal);
    assert.ok(gap < -MUSIC_MODEL.depth * near.scale * 1.2, `card ${u + 1} stands clear behind card ${u} (${gap.toFixed(3)})`);
  }
});

test('the chain enters from below the picture and leaves past its left edge', () => {
  const half = SONG_VIEW.span / 2;
  // The chain's first card and the place before it: the middle of their top edge is below the bottom edge.
  for (const u of [-1, -2]) assert.ok(songChainPose(u).y < -half, `card ${u} starts below the picture`);
  // Card 0 shows its top; the cards beside the large card are fully inside.
  assert.ok(songChainPose(0).y > -half && songChainPose(0).y < -half + 1.2);
  // The first hidden row is outside every landscape framing's left edge; short windows,
  // whose card keeps its distance from the brand, show a longer chain.
  for (const [width, height, cards] of [[1920, 1080, 13], [2560, 1080, 13], [3440, 1440, 13], [1440, 900, 13], [1280, 1024, 13], [1100, 1000, 13], [1000, 700, 13], [1366, 730, 13], [1920, 700], [1920, 650], [1920, 600], [1920, 500], [2560, 720], [3840, 480]]) {
    const framing = songFraming(width, height, SONG_VIEW.span);
    assert.equal(framing.portrait, false);
    const across = (width / height) * framing.span, left = framing.x * across, centre = (0.5 - framing.x) * across;
    // As the scene asks: the camera stands SONG_VIEW.distance from the card's plane, aimed at the picture's centre.
    const count = songChainCards(left, centre, SONG_VIEW.distance);
    if (cards) assert.equal(count, cards, `${width}x${height}: ordinary windows keep the shortest chain`);
    else assert.ok(count > SONG_CHAIN_CARDS && count < 32, `${width}x${height}: a short window shows a longer chain (${count})`);
    // Where the camera's perspective draws the first hidden card's right edge: behind the card's plane, nearer the centre.
    const first = songChainPose(count + 0.5), edge = first.z - Math.sin(radians(first.yaw)) * MUSIC_MODEL.width / 2 * first.scale;
    assert.ok(edge < first.z, 'the right edge is turned away from the camera');
    const depth = SONG_VIEW.distance / (SONG_VIEW.distance - edge);
    assert.ok(centre + (songChainReach(count + 0.5) - centre) * depth < -left, `${width}x${height}: the first hidden card is past the left edge`);
    assert.ok(count >= songChainCards(left), `${width}x${height}: perspective never shortens the chain`);
    // The estimate covers the card's turned width and its lean.
    const hidden = songChainPose(count + 0.5), { right } = axes(hidden);
    assert.ok(hidden.x + Math.abs(right[0]) * MUSIC_MODEL.width / 2 * hidden.scale <= songChainReach(count + 0.5) + 1e-9);
  }
  // Cards far along the chain still stand clear of each other.
  for (let u = SONG_CHAIN_CARDS; u < 30; u++) {
    const near = songChainPose(u), far = songChainPose(u + 1);
    assert.ok(far.z < near.z && far.scale < near.scale && far.x < near.x);
  }
});

test('short windows keep the card clear of the brand and the return control', () => {
  for (const [width, height] of [[1920, 500], [1280, 540], [1366, 730], [1280, 720], [1600, 600]]) {
    const card = songCardRect(width, height, SONG_VIEW.span, MUSIC_MODEL.width, MUSIC_MODEL.height);
    // The brand ends near 290 px and the return control near 245 px, whatever the window's size.
    assert.ok(card.x - card.width / 2 + 0.2125 * card.width >= 300, `${width}x${height}: the line passes right of the brand (${(card.x - card.width / 2 + 0.2125 * card.width).toFixed(0)})`);
    // The return control ends near 245 px and 190 px down: the drawn card is beside it or below it.
    assert.ok(card.x - card.width / 2 * 1.18 >= 250 || card.y - card.height / 2 * 1.14 >= 200, `${width}x${height}: the drawn card keeps clear of the return control`);
  }
  // Tall enough windows are untouched: the card sits 50.5 % of the height from the left.
  for (const [width, height] of [[1920, 1080], [2560, 1440], [1440, 900], [1600, 900]])
    assert.ok(Math.abs(songFraming(width, height, SONG_VIEW.span).x * width - 0.505 * height) < 1e-9);
  // Shortening a window moves the card continuously.
  let previous = songFraming(1920, 1100, SONG_VIEW.span);
  for (let height = 1099; height >= 480; height--) {
    const next = songFraming(1920, height, SONG_VIEW.span);
    assert.ok(Math.abs(next.x - previous.x) < 0.0004 && Math.abs(next.span - previous.span) < 1e-9);
    previous = next;
  }
});

test('a lifted case sheds the chain displacement early in its rise', () => {
  const lift = MUSIC_MODEL.height + 0.12;
  assert.equal(songLiftHold(0, lift), 1);
  assert.equal(songLiftHold(lift, lift), 0);
  assert.equal(songLiftHold(0.5 * lift, lift), 0, 'free of the chain before half of the rise');
  assert.equal(songLiftHold(-3, lift), 1);
  for (let value = 0; value < lift; value += 0.1) assert.ok(songLiftHold(value + 0.1, lift) <= songLiftHold(value, lift));
  assert.ok(SONG_SHELF_DROP >= 8, 'the sunken shelf is below the picture at the song camera');
});

test('the shelf sinks below the picture in every window, and by the same amount in landscape', () => {
  for (const [width, height] of [[1920, 1080], [2560, 1080], [1440, 900], [1280, 1024], [1100, 1050], [1000, 700]]) {
    const framing = songFraming(width, height, SONG_VIEW.span);
    assert.equal(songShelfDrop((1 - framing.y) * framing.span), SONG_SHELF_DROP, `${width}x${height}: the landscape picture keeps the fixed drop`);
  }
  for (const [width, height] of [[900, 1400], [640, 1300], [640, 1400], [430, 932], [390, 844], [360, 800], [320, 800]]) {
    const framing = songFraming(width, height, SONG_VIEW.span), below = (1 - framing.y) * framing.span;
    assert.ok(songShelfDrop(below) >= below + 1, `${width}x${height}: the shelf ends below the bottom edge`);
    assert.ok(songShelfDrop(below) >= SONG_SHELF_DROP);
  }
});

test('the song framing keeps the card in the picture and beside the panel', () => {
  for (const [width, height] of [[1920, 1080], [2560, 1080], [3440, 1440], [1440, 900], [1280, 1024], [1000, 700], [900, 1400], [390, 844]]) {
    const framing = songFraming(width, height, SONG_VIEW.span);
    assert.equal(framing.portrait, isPortraitViewport(width, height), 'the portrait boundary is the shared one');
    const card = songCardRect(width, height, SONG_VIEW.span, MUSIC_MODEL.width, MUSIC_MODEL.height);
    assert.ok(card.x - card.width / 2 > 0 && card.x + card.width / 2 < width, `${width}x${height}: card inside horizontally`);
    assert.ok(card.y - card.height / 2 > 64 && card.y + card.height / 2 < height, `${width}x${height}: card clears the header`);
    if (!framing.portrait) assert.ok(card.x + card.width / 2 < width * 0.55, `${width}x${height}: card leaves the right half to the panel`);
    else assert.ok(card.y + card.height / 2 < height * 0.45, `${width}x${height}: card leaves the lower half to the panel`);
  }
  // 16:9 is the reference: card centre 28.4 % / 50.8 %, 400 px wide at 1080p.
  const reference = songCardRect(1920, 1080, SONG_VIEW.span, MUSIC_MODEL.width, MUSIC_MODEL.height);
  assert.ok(Math.abs(reference.x - 545) < 1 && Math.abs(reference.y - 549) < 1 && Math.abs(reference.width - 400.5) < 0.1);
  // Wider windows keep the card at the same distance from the left edge.
  assert.ok(Math.abs(songCardRect(3440, 1440, SONG_VIEW.span, MUSIC_MODEL.width, MUSIC_MODEL.height).x / 1440 - reference.x / 1080) < 1e-9);
  // Narrowing a landscape window changes the framing continuously (no jump at a threshold),
  // also in short windows, where the card keeps a minimum distance from the left edge that
  // differs between the desktop and the compact header.
  let previous = songFraming(2000, 1000, SONG_VIEW.span);
  for (let width = 1999; width > 1060; width--) {
    const next = songFraming(width, 1000, SONG_VIEW.span);
    assert.ok(Math.abs(next.span - previous.span) < 0.02 && Math.abs(next.x - previous.x) < 0.001);
    previous = next;
  }
  for (const height of [600, 720]) {
    let before = songFraming(2000, height, SONG_VIEW.span);
    for (let width = 1999; width > 900; width--) {
      const next = songFraming(width, height, SONG_VIEW.span);
      assert.ok(Math.abs(next.span - before.span) < 0.02 && Math.abs(next.x - before.x) < 0.001, `${width}x${height}`);
      before = next;
    }
  }
});
