import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  LANE_LABEL, LANE_PLANE, LANE_ROLES, LANE_STEP, convexHull, cssMatrix, laneLabelIndex, laneLabelRange, laneLabelShares, laneLabelSlots, laneStepPoses, mapPoint, polygonsMeet, quadMatrix,
} from '../src/lane-labels.ts';
import { twoLines } from '../src/lane-names.ts';
import { PLAY_GESTURE, columnStrength, damp, settlingWave } from '../src/motion.ts';
import { archiveFraming, isPortraitViewport } from '../src/viewport-layout.ts';
import { MUSIC_COVER, MUSIC_MODEL } from '../src/music-model.ts';

const near = (actual, expected, message, within = 1e-9) => assert.ok(Math.abs(actual - expected) < within, `${message}: ${actual} vs ${expected}`);
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const body = (source, from, to) => {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `${from} is in the source`);
  return source.slice(start, source.indexOf(to, start + from.length));
};

// The roles a column at `offset` shows in, as a map role -> share (and its drift).
const roles = (offset, portrait = false, reduced = false) => Object.fromEntries(laneLabelShares(offset, portrait, reduced).map((s) => [s.role, s]));
const slotOf = Object.fromEntries(LANE_ROLES);

test('the roles: the nearer column, the selected one and the further one, each at its own slot', () => {
  assert.deepEqual(LANE_ROLES.map(([role, offset]) => [role, offset]), [['nearer', -1], ['selected', 0], ['further', 1]]);
  // At rest each column is named in its own role only, in full (the neighbours a little lighter), where its slot is.
  for (const [role, offset] of LANE_ROLES) {
    const shown = laneLabelShares(offset);
    assert.equal(shown.length, 1, `a column at ${offset} has one name`);
    assert.deepEqual(shown[0], { role, share: role === 'selected' ? 1 : LANE_LABEL.neighbour, dx: 0, dy: 0 });
  }
  assert.ok(LANE_LABEL.neighbour > 0.8 && LANE_LABEL.neighbour < 1);
  // Columns further out than the neighbours are not named.
  for (const offset of [-2, -1 - LANE_LABEL.fade, 1 + LANE_LABEL.fade, 2, 7.5]) assert.deepEqual(laneLabelShares(offset), [], `none at ${offset}`);
});

test('as the shelf slides a name fades out at its slot and the next fades in at its own: it never travels between slots', () => {
  // The owner (2026-10-06) asked for names that do not jiggle; a name carried from one slot to
  // the next would cross the lifted case. Each role's name: shown within LANE_LABEL.fade of its
  // slot's offset, drifting LANE_LABEL.drift per column away from it (down and left toward the
  // lens, along the shelf's x axis, which the neighbours' plane contains), at most about 14 px.
  const reach = LANE_LABEL.fade * Math.hypot(LANE_LABEL.drift.x, LANE_LABEL.drift.y);
  assert.ok(LANE_LABEL.fade > 0.5 && LANE_LABEL.fade < 0.75, 'a little more than half a column: the two names barely overlap');
  assert.ok(reach > 6 && reach < 20, `a short drift (${reach.toFixed(1)} px)`);
  assert.ok(LANE_LABEL.drift.x < 0 && LANE_LABEL.drift.y > 0, 'toward the lens: down and to the left, as the cases move');
  near(Math.atan2(LANE_LABEL.drift.y, -LANE_LABEL.drift.x) * 180 / Math.PI, 35, 'along the shelf\'s x axis in the picture (35 degrees)', 0.2);
  let previous = roles(-2);
  for (let step = 1; step <= 400; step++) {
    const offset = -2 + step * 0.01, now = roles(offset);
    assert.ok(Object.keys(now).length <= 2, `at most two roles at ${offset.toFixed(2)}`);
    for (const role of ['nearer', 'selected', 'further']) {
      const share = now[role]?.share ?? 0, before = previous[role]?.share ?? 0;
      assert.ok(Math.abs(share - before) <= 0.01 * 1.5 / LANE_LABEL.fade + 1e-9, `${role} fades without a jump at ${offset.toFixed(2)}`);
      if (!now[role]) continue;
      const away = slotOf[role] - offset;
      assert.ok(Math.abs(away) < LANE_LABEL.fade, `${role} shows only near its slot`);
      assert.ok(Math.abs(now[role].dx - away * LANE_LABEL.drift.x) < 1e-9 && Math.abs(now[role].dy - away * LANE_LABEL.drift.y) < 1e-9, 'its drift is a function of the offset alone');
    }
    previous = now;
  }
  // Half way between two slots both names are all but gone: a swap, not two names on top of each other.
  for (const offset of [-0.5, 0.5]) for (const { share } of laneLabelShares(offset)) assert.ok(share < 0.03, `${share} at ${offset}`);
});

test('the columns that can be named are exactly those with something to show', () => {
  for (const centre of [0, 2, 2.3, 2.5, 2.74, 2.76, -7.5, 40.999]) {
    const { first, last } = laneLabelRange(centre);
    for (let lane = Math.floor(centre) - 4; lane <= Math.ceil(centre) + 4; lane++) {
      if (laneLabelShares(lane - centre).length || laneLabelShares(lane - centre, false, true).length)
        assert.ok(lane >= first && lane <= last, `lane ${lane} around ${centre} is in the range`);
    }
    assert.ok(last - first <= 3, 'at most four columns at once (three at rest)');
  }
  assert.deepEqual(laneLabelRange(2), { first: 1, last: 3 });
});

test('portrait: the column under the title is not named, the others are as in landscape', () => {
  for (let offset = -2; offset <= 2; offset += 0.05) {
    const portrait = roles(offset, true), landscape = roles(offset);
    assert.equal(portrait.nearer, undefined, 'never the nearer column');
    assert.deepEqual(portrait.selected, landscape.selected);
    assert.deepEqual(portrait.further, landscape.further);
  }
});

test('reduced motion: a name swaps at half a column, without a drift', () => {
  for (let offset = -1.75; offset <= 1.75; offset += 0.05) {
    const shown = laneLabelShares(offset, false, true);
    const nearest = Math.round(offset);
    if (Math.abs(nearest) > 1) { assert.deepEqual(shown, []); continue; }
    assert.equal(shown.length, 1, `one name at ${offset.toFixed(2)}`);
    assert.equal(slotOf[shown[0].role], nearest + 0, 'at the nearest slot');
    assert.equal(shown[0].dx, 0);
    assert.equal(shown[0].dy, 0);
    assert.equal(shown[0].share, shown[0].role === 'selected' ? 1 : LANE_LABEL.neighbour);
  }
  assert.deepEqual(laneLabelShares(-0.5, false, true).map((s) => s.role), ['selected']);
  assert.deepEqual(laneLabelShares(0.5, false, true).map((s) => s.role), ['further']);
  assert.deepEqual(laneLabelShares(-1, true, true), [], 'not the nearer column in portrait');
});

test('a column is counted as the stepper counts it', () => {
  assert.equal(laneLabelIndex(0), '01');
  assert.equal(laneLabelIndex(11), '12');
});

test('the selected heading\'s name: one line where it fits, else two balanced ones, else an ellipsis at the end of the second', () => {
  // A stand-in for the canvas: Chinese characters and the ellipsis 32 px, letters 16, a space 8
  // (MiSans 700 at 32 px is about so); made-up names.
  const c = { measureText: (text) => ({ width: [...text].reduce((w, ch) => w + (/[　-鿿＀-￯…]/.test(ch) ? 32 : ch === ' ' ? 8 : 16), 0) }) };
  const wide = (line) => c.measureText(line).width;
  assert.deepEqual(twoLines(c, '雨天爵士', 241), ['雨天爵士']);
  assert.deepEqual(twoLines(c, '  雨天   爵士 ', 241), ['雨天 爵士'], 'its spaces as one');
  // Too long for one line: two of as nearly the same width as its words allow.
  assert.deepEqual(twoLines(c, '周末清晨的咖啡与爵士', 241), ['周末清晨的', '咖啡与爵士']);
  assert.deepEqual(twoLines(c, 'Late Night Study Sessions', 241), ['Late Night', 'Study Sessions'], 'a word stays whole');
  // Too long for two: the first as full as it can be, the second ending in an ellipsis (as Chrome wrote it at 1440 x 900).
  assert.deepEqual(twoLines(c, '适合一个人在深夜开车时听的温柔歌曲合集', 241), ['适合一个人在', '深夜开车时听…']);
  // Where its slot has room for one line only: one, ending in an ellipsis where it must.
  assert.deepEqual(twoLines(c, '周末清晨的咖啡与爵士', 241, 1), ['周末清晨的咖…']);
  assert.deepEqual(twoLines(c, '雨天爵士', 241, 1), ['雨天爵士']);
  // No line starts with a closing mark or ends with an opening one.
  for (const lines of [twoLines(c, '雨天爵士（现场版）合集', 241), twoLines(c, '城市漫游「夜」与「昼」之间的歌', 241)]) {
    assert.equal(lines.length, 2);
    assert.ok(!/^[）」』〕》，。、]/.test(lines[1]) && !/[（「『〔《]$/.test(lines[0]), JSON.stringify(lines));
  }
  // A word too wide for a line is broken where it must be.
  const long = twoLines(c, 'Supercalifragilisticexpialidocious', 241);
  assert.equal(long.length, 2);
  assert.ok(long.every((line) => wide(line) <= 241) && long[1].endsWith('…'), JSON.stringify(long));
  // (A heading is never shown narrower than its kicker, about 100 px: lane-labels.ts `least`.)
  for (const name of ['我喜欢的音乐', '通勤路上的歌', 'Lo-Fi 学习时间与雨声', '夏日公路 Summer Road Trip 2026'])
    for (const width of [100, 120, 155, 241, 335]) assert.ok(twoLines(c, name, width).every((line) => wide(line) <= width), `${name} in ${width} px`);
});

test('a name on a plane: the homography takes its line\'s box onto the projected quad, and CSS draws it so', () => {
  // A true perspective quad (not a parallelogram): every corner, and the box's middle where the diagonals cross.
  const quad = [{ x: 100, y: 200 }, { x: 260, y: 140 }, { x: 250, y: 175 }, { x: 102, y: 230 }];
  const m = quadMatrix(160, 24, quad);
  [[0, 0], [160, 0], [160, 24], [0, 24]].forEach(([x, y], i) => {
    const p = mapPoint(m, x, y);
    near(p.x, quad[i].x, `corner ${i} x`, 1e-6);
    near(p.y, quad[i].y, `corner ${i} y`, 1e-6);
  });
  const cross = (a, b, c, d) => {
    const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / ((b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x));
    return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
  };
  const middle = mapPoint(m, 80, 12), diagonals = cross(quad[0], quad[2], quad[1], quad[3]);
  near(middle.x, diagonals.x, 'the box\'s middle is where the diagonals cross (projective, not affine)', 1e-6);
  near(middle.y, diagonals.y, 'the box\'s middle (y)', 1e-6);
  assert.ok(Math.abs(m[6]) > 1e-6 || Math.abs(m[7]) > 1e-6, 'it has a perspective row');
  // matrix3d is column-major: (x, y) goes to (m0 x + m1 y + m2, m3 x + m4 y + m5) / (m6 x + m7 y + m8); a drift moves the picture.
  const css = cssMatrix(m, 5, -3);
  const v = /^matrix3d\(([^)]*)\)$/.exec(css)[1].split(',').map(Number);
  assert.equal(v.length, 16);
  assert.deepEqual([v[2], v[6], v[8], v[9], v[10], v[11], v[14], v[15]], [0, 0, 0, 0, 1, 0, 0, 1]);
  for (const [x, y] of [[0, 0], [160, 0], [37, 19]]) {
    const w = v[3] * x + v[7] * y + v[15], p = mapPoint(m, x, y);
    near((v[0] * x + v[4] * y + v[12]) / w, p.x + 5, `css x at ${x}, ${y}`, 1e-4);
    near((v[1] * x + v[5] * y + v[13]) / w, p.y - 3, `css y at ${x}, ${y}`, 1e-4);
  }
  // A flat name: a translation (no perspective, no turn).
  assert.deepEqual(quadMatrix(10, 10, [{ x: 5, y: 7 }, { x: 15, y: 7 }, { x: 15, y: 17 }, { x: 5, y: 17 }]), [1, 0, 5, 0, 1, 7, 0, 0, 1]);
});

test('convex shapes: hulls and whether two of them meet', () => {
  const hull = convexHull([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 3, y: 3 }]);
  assert.equal(hull.length, 4, 'the inner points are not on the hull');
  const box = (l, t, r, b) => [{ x: l, y: t }, { x: r, y: t }, { x: r, y: b }, { x: l, y: b }];
  assert.ok(polygonsMeet(hull, box(9, 9, 20, 20)));
  assert.ok(!polygonsMeet(hull, box(11, 0, 20, 20)));
  // A slanted shape whose box meets the other's but which does not.
  assert.ok(!polygonsMeet([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 9, y: 11 }], box(5, -5, 12, 2)));
});

// How the names are set at 1440 x 900 (measured in Chrome from music-shelf.css: the top of the
// line to the baseline, the baseline to its bottom, the number and its gap), the header's band
// and the overlay's boxes there (scene.ts stats().laneLabels.page, 2026-10-08): the header as one
// band across the picture, the right column, the counter and ruler with room for four-digit
// numbers, the key hints' row across the picture, the window's buttons (lane-names.ts), and the
// right column's left edge. The selected one is a heading since 2026-10-18 (measured in Chrome
// then): from its kicker's top to its name's first baseline, that line's bottom, its height, as
// much again kept for a second line, and its kicker's width; 24 px in the compact and portrait layouts.
const TYPE = { selected: { ascent: 49, descent: 6.46875, lead: 0, line: 36.46875, more: 36.46875, least: 110.046875 }, nearer: { ascent: 14, descent: 2, lead: 28.77 }, further: { ascent: 14, descent: 2, lead: 28.77 } };
const SMALL = { ascent: 38, descent: 5.359375, lead: 0, line: 27.359375, more: 27.359375, least: 99.046875 };
const box = ([left, top, right, bottom]) => ({ left, top, right, bottom });
const OVERLAY_1440 = [[0, 40, 1440, 71], [872, 196, 1400, 844], [40, 770, 397.78, 826], [0, 868, 1440, 878], [1302, 0, 1440, 32]].map(box);
const OVERLAY_1280 = [[0, 40, 1280, 71], [774, 157, 1240, 664], [40, 590, 397.78, 646], [0, 688, 1280, 698], [1142, 0, 1280, 32]].map(box);
const COLUMN = { 1440: box([872, 196, 1400, 844]), 1280: box([774, 157, 1240, 664]) };
// The bracket at rest at 1440 x 900 (restBracket, measured in Chrome).
const BRACKET = { left: 282.68, top: 104.79, right: 571.44, bottom: 622.12 };
// (The case's own ▶, whose paths the names kept clear of too, went on 2026-10-10.)

// The shelf at rest seen with the shelf's camera at rest: a replica of scene.ts shelfRestCamera
// (SHELF_REST), restBracket, restKeepOut and lanePlaces (their source is pinned below).
const shelf = (width, height, compact = false) => {
  const framing = archiveFraming(width, height, 7.33, 0, compact);
  const yaw = THREE.MathUtils.degToRad(89 - 22 - 8), elevation = THREE.MathUtils.degToRad(3 + 40 - 8 - 16 + 6);
  const direction = new THREE.Vector3(-Math.sin(yaw) * Math.cos(elevation), Math.sin(elevation), Math.cos(yaw) * Math.cos(elevation));
  const aim = new THREE.Vector3(-1.091, -0.045, 0.481);
  if (framing.portrait) {
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right).normalize();
    aim.set(0, -4.6 + settlingWave(0, 26.56) + 0.4 + 1.85, -2.17).addScaledVector(up, (framing.previewY - 0.5) * framing.span);
  }
  const camera = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(2 * Math.atan(framing.span / (2 * 140))), width / height, 1, 1000);
  camera.position.copy(aim).addScaledVector(direction, 140);
  camera.lookAt(aim);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  const project = (v) => { const p = v.clone().project(camera); return { x: (p.x + 1) * width / 2, y: (1 - p.y) * height / 2 }; };
  const COLUMN = 5.2, ROW = 0.62, FORWARD = 1.8, LIFT = 1.035, { width: W, height: H, depth: D, center } = MUSIC_MODEL;
  const ahead = (lane) => FORWARD * THREE.MathUtils.smoothstep(1 - lane, 0, 1);
  const bracketAt = (shiftZ = 0, shiftY = 0) => {
    const base = -4.6 + settlingWave(0, 26.56) * columnStrength(0, 0) + LIFT + shiftY;
    // A point of the case (its own coordinates, from the middle of its base) on the screen.
    const seen = (x, y, z) => project(new THREE.Vector3(-ahead(0) - W / 2 + W / 2 + x, base + y, -2.17 + shiftZ + z));
    const corners = [];
    for (let c = 0; c < 8; c++) corners.push(seen(center.x + (c & 1 ? 0.5 : -0.5) * W, center.y + (c & 2 ? 0.5 : -0.5) * H, center.z + (c & 4 ? 0.5 : -0.5) * D));
    const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
    const bracket = { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
    return { bracket, face: [corners[4], corners[5], corners[7], corners[6]], corners };
  };
  const { bracket, face } = bracketAt();
  // restKeepOut: the case through the idle drift; each square through the hop and the steps of up
  // to three rows each way, every pose on the way back (laneStepPoses).
  const idle = 0.1, square = LANE_LABEL.square;
  const rest = [bracketAt(0, idle), bracketAt(0, -idle)];
  const fall = (step) => -LIFT - (settlingWave(0, 26.56) - settlingWave(step, 26.56)) * columnStrength(0, 0);
  const steps = (way) => laneStepPoses(way, LIFT).map(({ z, y }) => bracketAt(z, y));
  const hop = [bracketAt(0, PLAY_GESTURE.height + idle)];
  const keep = [convexHull(rest.flatMap((b) => b.corners))];
  const cornersOf = ({ bracket: b }) => [{ x: b.left, y: b.top }, { x: b.right, y: b.top }, { x: b.left, y: b.bottom }, { x: b.right, y: b.bottom }];
  const around = ({ x, y }) => [{ x: x - square, y: y - square }, { x: x + square, y: y - square }, { x: x + square, y: y + square }, { x: x - square, y: y + square }];
  for (let corner = 0; corner < 4; corner++)
    for (const moves of [hop, steps(1), steps(-1)]) keep.push(convexHull([...rest, ...moves].flatMap((b) => around(cornersOf(b)[corner]))));
  // The top left square's paths, for the checks below (the selected name stands left of it since 2026-10-10).
  const squarePaths = [hop, steps(1), steps(-1)].map((moves) => [...rest, ...moves].map((b) => cornersOf(b)[0]));
  // lanePlaces.
  const places = (role, type) => {
    const order = (isPortraitViewport(width, height) && role === 'further' ? LANE_PLANE.portrait.further : null) ?? LANE_PLANE[role];
    const lane = role === 'further' ? 1 : -1, turn = THREE.MathUtils.degToRad(LANE_PLANE.turn);
    const along = new THREE.Vector3(Math.cos(turn), 0, Math.sin(turn)), line = type.ascent + type.descent;
    const out = [];
    for (const row of order.rows) {
      const base = -4.6 + settlingWave(row, 26.56) * columnStrength(lane, 0);
      const corner = new THREE.Vector3(lane * COLUMN - ahead(lane) + center.x - W / 2, base + center.y + H / 2 + LANE_PLANE.lift, -2.17 + row * ROW + center.z + D / 2);
      for (const start of order.along) {
        const origin = corner.clone().addScaledVector(along, start);
        const foot = project(origin), head = project(origin.clone().setY(origin.y + 1));
        const scale = 1 / Math.hypot(head.x - foot.x, head.y - foot.y);
        const point = (u, v) => project(origin.clone().addScaledVector(along, u * scale).setY(origin.y + (type.ascent - v) * scale));
        out.push({ matrix: quadMatrix(100, line, [point(0, 0), point(100, 0), point(100, line), point(0, line)]), reach: (W * Math.abs(along.x) + 8 * ROW * Math.abs(along.z) - start) / scale, row, along: start, origin });
      }
    }
    return out;
  };
  return { camera, project, bracket, face, keep, squarePaths, places, bracketAt, fall, direction };
};
const slotsFor = (width, height, { compact = false, overlay = [], header = { top: 40, bottom: 71 }, type = TYPE, column } = {}) => {
  const s = shelf(width, height, compact);
  const portrait = isPortraitViewport(width, height);
  return { s, slots: laneLabelSlots(s.bracket, { width, height, portrait, header, avoid: overlay, column }, type, s.face, s.keep, { further: s.places('further', type.further), nearer: s.places('nearer', type.nearer) }) };
};
// A name's box in the picture: a neighbour's line on its plane; the selected heading's block, from
// its kicker's top to under a second line of its name (where its slot has room for two).
const lineOf = (slot, set) => {
  if (slot.matrix) return [mapPoint(slot.matrix, 0, 0), mapPoint(slot.matrix, slot.width, 0), mapPoint(slot.matrix, slot.width, set.ascent + set.descent), mapPoint(slot.matrix, 0, set.ascent + set.descent)];
  const top = slot.y - set.ascent, bottom = slot.y + set.descent + (slot.lines === 2 ? set.more ?? 0 : 0);
  return [{ x: slot.x, y: top }, { x: slot.x + slot.width, y: top }, { x: slot.x + slot.width, y: bottom }, { x: slot.x, y: bottom }];
};
// A window's overlay as lane-names.ts measures it: the header's band and the key hints' row across
// the picture, the right column, the counter and ruler (with room for four-digit numbers), the
// window's buttons; and the right column's left edge. As Chrome measured them (2026-10-18; the
// window's buttons as the client draws them: the page in Chrome has none), else as music-shelf.css
// places them.
const MEASURED = {
  '1920x1080': { header: [52, 91], avoid: [[1240, 235, 1860, 1015], [60, 927, 473, 992], [0, 1039, 1920, 1052]] },
  '1225x772': { header: [40, 71], avoid: [[741, 168, 1185, 716], [40, 642, 397.78, 698], [0, 740, 1225, 750]] },
  '1366x768': { header: [40, 71], avoid: [[826, 167, 1326, 712], [40, 638, 397.78, 694], [0, 736, 1366, 746]] },
  '2560x1080': { header: [52, 91], avoid: [[1880, 235, 2500, 1015], [60, 927, 473, 992], [0, 1039, 2560, 1052]] },
  '1100x820': { header: [40, 71], avoid: [[666, 179, 1061, 764], [40, 690, 397.78, 746], [0, 788, 1100, 798]] },
  '1000x700': { header: [25, 51], avoid: [[570, 153, 975, 648], [25, 598, 361.97, 648], [0, 672, 1000, 682]] },
  '1000x720': { header: [25, 51], avoid: [[570, 157, 975, 668], [25, 618, 361.97, 668], [0, 692, 1000, 702]] },
  '820x1180': { header: [21, 47], avoid: [[21, 682, 787, 1075], [20, 1104, 348.7, 1152]] },
  '600x900': { header: [21, 47], avoid: [[12, 496, 576, 796], [20, 824, 348.7, 872]] },
};
const overlayOf = (width, height, portrait, compact = false) => {
  if (width === 1440 && height === 900) return { overlay: OVERLAY_1440, column: COLUMN[1440], header: { top: 40, bottom: 71 } };
  if (width === 1280 && height === 720) return { overlay: OVERLAY_1280, column: COLUMN[1280], header: { top: 40, bottom: 71 } };
  const measured = MEASURED[`${width}x${height}`];
  if (measured) {
    const [top, bottom] = measured.header, [column, ...rest] = measured.avoid.map(box);
    return { overlay: [{ left: 0, top, right: width, bottom }, column, ...rest, { left: width - 138, top: 0, right: width, bottom: 32 }], column, header: { top, bottom } };
  }
  // The right column as music-shelf.css places it (left: max(60.5 %, 100 % - 568 px), 680 px from 1700 px, compact 57 % and 553 px).
  const left = compact ? Math.max(width * 0.57, width - 553) : Math.max(width * 0.605, width - (width >= 1700 ? 680 : 568));
  const column = portrait ? { left: 21, top: height * 0.58, right: width - 33, bottom: height * 0.91 } : { left, top: Math.max(110, height * 0.218), right: width - 40, bottom: height - 56 };
  const navigation = portrait ? { left: 20, top: height - 76, right: 349, bottom: height - 28 } : { left: 40, top: height - 130, right: 398, bottom: height - 74 };
  const header = portrait ? { top: 21, bottom: 47 } : compact ? { top: 25, bottom: 51 } : { top: 40, bottom: 71 };
  const overlay = [{ left: 0, ...header, right: width }, column, navigation, { left: width - 138, top: 0, right: width, bottom: 32 }];
  if (!portrait) overlay.push({ left: 0, top: height - 32, right: width, bottom: height - 22 });
  return { overlay, column, header };
};
const rect = ({ left, top, right, bottom }, x = 0, y = 0) => [{ x: left - x, y: top - y }, { x: right + x, y: top - y }, { x: right + x, y: bottom + y }, { x: left - x, y: bottom + y }];

test('the shelf at rest in node is the scene\'s: the bracket, the squares\' paths and the slots it worked out in Chrome', () => {
  const { s, slots } = slotsFor(1440, 900, { overlay: OVERLAY_1440, column: COLUMN[1440] });
  for (const key of ['left', 'top', 'right', 'bottom']) near(s.bracket[key], BRACKET[key], `rest bracket ${key}`, 0.06);
  // A step's model against the live bracket measured in Chrome (2026-10-08, 1440 x 900): one row
  // down moved it (+59.2, +124.9), one row up (-54.9, +96.4); three wheel notches (+163.3,
  // +167.5) and (-158.9, +96.7); the hop -37 (with the idle drift). The model's three rows reach
  // as far or further.
  const step = (rows) => { const b = s.bracketAt(rows * 0.62, s.fall(rows)).bracket; return { x: b.left - s.bracket.left, y: b.top - s.bracket.top }; };
  near(step(1).x, 59.2, 'a step down (x)', 2.5); near(step(1).y, 124.9, 'a step down (y)', 2.5);
  near(step(-1).x, -54.9, 'a step up (x)', 2.5); near(step(-1).y, 96.4, 'a step up (y)', 2.5);
  assert.ok(step(3).x >= 163.3 && step(3).y >= 167.5 && step(-3).x <= -158.9 && step(-3).y >= 96.7 - 2, 'three rows cover three notches');
  near(s.bracketAt(0, PLAY_GESTURE.height).bracket.top - s.bracket.top, -37, 'the hop', 2);
  // The steps' poses (laneStepPoses): each step starts where the step model has it (unlifted, on
  // its own shoulder, k rows away) and ends at the bracket's rest.
  const per = Math.round(LANE_STEP.time / LANE_STEP.dt), poses = laneStepPoses(1, 1.035);
  assert.equal(poses.length, per * LANE_STEP.steps.length);
  assert.ok(LANE_STEP.steps.every((releases) => releases.reduce((a, b) => a + b, 0) <= 3), 'up to three rows in all');
  LANE_STEP.steps.forEach((releases, i) => {
    const first = poses[i * per], last = poses[(i + 1) * per - 1];
    near(first.z, releases[0] * 0.62, `${releases}: the first release at once (z)`, 0.03);
    near(first.y, s.fall(releases[0]), `${releases}: unlifted on its shoulder`, 0.12);
    assert.ok(Math.abs(last.z) < 0.02 && Math.abs(last.y) < 0.02, `${releases}: back at rest`);
  });
  // Chrome (2026-10-08, 1280 x 720, three notches): coming back, the top right square passed
  // (590, 116) and (603, 132) (its box's top left), 23 px beyond the line from three rows away to
  // the rest, onto the selected name then (from 593), as the case rose before the track was back.
  // The steps' fan follows the springs: those squares now keep clear of the selected name.
  const measured = [[590, 116], [603, 132], [578, 101], [617, 150]].map(([x, y]) => rect({ left: x, top: y, right: x + 6, bottom: y + 6 }));
  const tight = slotsFor(1280, 720, { overlay: OVERLAY_1280, column: COLUMN[1280] }).slots.selected;
  for (const square of measured) assert.ok(!polygonsMeet(square, lineOf(tight, TYPE.selected)), `the measured square at ${square[0].x}, ${square[0].y} keeps clear of the selected name`);
  // The slots at 1440 x 900 and 1280 x 720 (2026-10-18; scene.ts stats().laneLabels.slots in
  // Chrome gives the same: DESIGN). The selected name left of the bracket (the owner, 2026-10-10:
  // "the selected playlist name move here"), right-aligned, ending before its left squares, on the
  // highest line the top left square's paths leave free for the heading (its kicker, its name and
  // room for a second line); the further name, the corner free again, on its first place.
  assert.equal(slots.selected.place.split(' ')[0], 'left');
  assert.equal(slots.selected.align, 'end');
  assert.deepEqual([slots.selected.x, slots.selected.y], [25, 272]);
  near(slots.selected.width, 241, 'selected width', 1.5);
  assert.equal(slots.further.place, 'row 0, 1.3');
  near(slots.further.x, 785.05, 'further x', 0.5); near(slots.further.y, 194.88, 'further y', 0.5);
  assert.equal(slots.nearer.place, 'row 6, 1.9');
  near(slots.nearer.x, 470.43, 'nearer x', 0.5); near(slots.nearer.y, 788.84, 'nearer y', 0.5);
  const wide = slotsFor(1280, 720, { overlay: OVERLAY_1280, column: COLUMN[1280] }).slots;
  assert.equal(wide.selected.place.split(' ')[0], 'left', '16:9: left of the bracket too');
  assert.deepEqual([wide.selected.x, wide.selected.y], [24, 203]);
  near(wide.selected.width, 210, 'selected width (1280)', 1.5);
  assert.equal(wide.further.place, 'row 0, 0.4');
  near(wide.further.x, 654.05, 'further x (1280)', 0.5); near(wide.further.y, 163.12, 'further y (1280)', 0.5);
  assert.equal(wide.nearer.place, 'row 6, 2.2');
  near(wide.nearer.x, 434.28, 'nearer x (1280)', 0.5); near(wide.nearer.y, 649.6, 'nearer y (1280)', 0.5);
});

test('the slots do not change with what the overlay shows: its boxes are its layout\'s, not its content\'s', () => {
  // The 2026-10-08 review: at 1225 x 772 the nearer name jumped about 54 px whenever the key hints
  // showed or hid P and L (the layer kept clear of each hint). Now every box a name keeps clear of
  // is one the overlay's content does not size (lane-names.ts): the key hints' row and the header's
  // band across the picture, the counter with room for four-digit numbers.
  const names = read('src/lane-names.ts');
  assert.doesNotMatch(names, /\.music-keyhint > \*|querySelectorAll\(selector\)/, 'no single hint, no matched list');
  assert.match(names, /const HEADER = \["\.music-identity", "\.music-topnav"\];/);
  assert.match(names, /const COLUMN = "\.album-callout";/);
  assert.match(names, /const NAVIGATION = "\.music-navigation", COUNTS = \["#selection-number", "#selection-total"\];/);
  assert.match(names, /const HINTS = "\.music-keyhint";/);
  assert.match(names, /const WINDOW = "\.window-controls";/);
  assert.match(names, /const DIGITS = "0000";/);
  const measure = body(names, '  measure(view: string)', '\n  }\n');
  assert.match(measure, /if \(halves\.length\) avoid\.push\(\{ left: 0, top: header\.top, right: origin\.width, bottom: header\.bottom \}\);/, 'the header: one band across');
  assert.match(measure, /for \(const control of stage\.querySelectorAll\(`\$\{HEADER\.join\(", "\)\} button`\)\) \{\s*const b = box\(control\);\s*if \(sized\(b\) && b\.top < line\) halves\.push\(b\);\s*\}/, 'as low as the controls in its row reach (the play ring overhangs it), not a menu dropped under it');
  assert.match(measure, /avoid\.push\(\{ \.\.\.counted, right: counted\.left \+ navigation\.getBoundingClientRect\(\)\.width \+ roomForCounts\(navigation\) \}\);/, 'the counter with room for four digits');
  assert.match(measure, /avoid\.push\(\{ left: 0, top: row\.bottom - tall, right: origin\.width, bottom: row\.bottom \}\);/, 'the key hints: their row across');
  assert.match(measure, /column: sized\(column\) \? column : undefined/);
  // Their layout boxes (offsets): the overlay's entrance and the opening's reveal translate it for a moment.
  const layout = body(names, 'function layoutBox(', '\n}\n');
  assert.match(layout, /x \+= at\.offsetLeft;\s*y \+= at\.offsetTop;/);
  assert.match(layout, /right: left \+ element\.offsetWidth, bottom: top \+ element\.offsetHeight/);
  assert.doesNotMatch(body(names, '  measure(view: string)', '\n  }\n'), /\.getBoundingClientRect\(\);\s*return \{ left: r\.left/, 'not the boxes on the screen');
  // The counter's four digits: each number's own type, longhand by longhand (the computed `font` shorthand is empty for tabular figures).
  const counts = body(names, 'function roomForCounts(', '\n}\n');
  assert.match(counts, /for \(const property of \["font-style", "font-weight", "font-stretch", "font-size", "font-family", "font-variant-numeric", "font-feature-settings", "letter-spacing"\]\)/);
  assert.match(counts, /more \+= Math\.max\(0, probe\.getBoundingClientRect\(\)\.width - number\.getBoundingClientRect\(\)\.width\);/);
  // The slots, given the same boxes, are the same whatever else: a function of the window, its layout, the type and those boxes.
  const once = slotsFor(1440, 900, { overlay: OVERLAY_1440, column: COLUMN[1440] }).slots, again = slotsFor(1440, 900, { overlay: OVERLAY_1440.map((b) => ({ ...b })), column: COLUMN[1440] }).slots;
  assert.deepEqual(again, once);
});

test('the neighbours face to the right, parallel, readable; the column\'s own right-hand side cannot carry them', () => {
  // The owner (2026-10-08): "selected face to the viewer, others face to the right (parrallel)".
  const { camera, places, direction } = shelf(1440, 900);
  const toCamera = direction.clone().normalize();
  // The column's right-hand side (+x, toward the further columns) faces away from the camera; its
  // left-hand side (-x) faces it but turns to the left in the picture; the cases' fronts (+z) face it and turn right.
  const facing = (normal) => normal.dot(toCamera);
  near(facing(new THREE.Vector3(1, 0, 0)), -0.777, 'the right-hand side is seen from behind', 0.002);
  near(facing(new THREE.Vector3(-1, 0, 0)), 0.777, 'the left-hand side faces the camera', 0.002);
  near(facing(new THREE.Vector3(0, 0, 1)), 0.467, 'the cases\' fronts face the camera', 0.002);
  const screenward = (normal) => normal.clone().transformDirection(camera.matrixWorldInverse).x;
  assert.ok(screenward(new THREE.Vector3(-1, 0, 0)) < 0, 'the left-hand side turns left');
  assert.ok(screenward(new THREE.Vector3(0, 0, 1)) > 0, 'the cases\' fronts turn right');
  assert.equal(LANE_PLANE.turn, 0, 'the names are printed on the plane of the cases\' fronts');
  // Every place either neighbour may take: on that plane, reading up and to the right as the case
  // tops do, the same way for both (parallel), letters at least 11 px tall, its number's digits at
  // least 10 px tall (2026-10-08 review: at 10 px they were 7 px and all but unreadable; MiSans'
  // figures stand 0.7 of the size), and squeezed no more than to 0.35.
  const numberSize = Number(/\.music-app \.lane-name-index \{[^}]*font-size: (\d+)px;/.exec(read('src/music-shelf.css'))?.[1]);
  assert.ok(numberSize >= 15, `the neighbours' numbers are ${numberSize} px`);
  for (const [width, height, compact] of [[1440, 900], [1280, 720], [1920, 1080], [1225, 772], [1000, 700, true], [820, 1180], [600, 900]]) {
    const s = shelf(width, height, compact);
    const angles = [];
    for (const role of ['further', 'nearer']) for (const place of s.places(role, TYPE[role])) {
      const m = place.matrix, base = TYPE[role].ascent;
      const a = mapPoint(m, 0, base), b = mapPoint(m, 10, base), cap = mapPoint(m, 0, base - 0.7 * 16), figure = mapPoint(m, 0, base - 0.7 * numberSize);
      const angle = Math.atan2(a.y - b.y, b.x - a.x) * 180 / Math.PI;
      angles.push(angle);
      assert.ok(angle > 30 && angle < 40, `${width} x ${height} ${role}: rising to the right (${angle.toFixed(1)})`);
      assert.ok(Math.hypot(cap.x - a.x, cap.y - a.y) >= 11, `${width} x ${height} ${role}: capitals at least 11 px tall at 16 px`);
      assert.ok(Math.hypot(figure.x - a.x, figure.y - a.y) >= 10, `${width} x ${height} ${role}: its number's figures at least 10 px tall`);
      const squeeze = Math.hypot(b.x - a.x, b.y - a.y) / 10;
      assert.ok(squeeze >= 0.35 && squeeze < 0.9, `${width} x ${height} ${role}: foreshortened to ${squeeze.toFixed(2)}`);
      assert.ok(Math.abs(m[6]) + Math.abs(m[7]) > 0, 'in perspective');
    }
    // One plane for both (LANE_PLANE.turn): parallel on the shelf; in the picture the long lens
    // turns parallel lines a little apart across its width (a vanishing point far off).
    assert.ok(Math.max(...angles) - Math.min(...angles) < 4, `${width} x ${height}: the planes are parallel (${Math.min(...angles).toFixed(2)}..${Math.max(...angles).toFixed(2)})`);
    const { slots } = slotsFor(width, height, { compact });
    const slant = (slot, set) => { const a = mapPoint(slot.matrix, 0, set.ascent), b = mapPoint(slot.matrix, 10, set.ascent); return Math.atan2(a.y - b.y, b.x - a.x) * 180 / Math.PI; };
    if (slots.nearer.shown) assert.ok(Math.abs(slant(slots.further, TYPE.further) - slant(slots.nearer, TYPE.nearer)) < 2, `${width} x ${height}: the two names run parallel in the picture`);
  }
});

test('the selected name is the lifted case\'s caption: left of its bracket where there is room, else above it with room under the header, else beside its top right corner; never by the header or the right column', () => {
  // The 2026-10-08 review: beside the case's lower corner the name stood on the covers in front of
  // it (3.3:1 on a red cover) and on the line of the right column's play ring ("Late Night Study…
  // ▶ ● 012"); above the bracket at 1440 x 900 it stood 3 px under the header's band. 2026-10-10:
  // the owner marked the empty corner left of the lifted case's top: "the selected playlist name
  // move here".
  const set = TYPE.selected, portraitType = { ...TYPE, selected: SMALL };
  assert.equal(LANE_LABEL.header, 24);
  // 1440 x 900: left of the bracket, right-aligned, ending LANE_LABEL.outside before its left
  // squares, the middle of its name's first line a LANE_LABEL.left share of the bracket's height
  // under its top (the first with room for the heading: the top left square's paths sweep down to
  // the left of it), a little under a third of the way down.
  let { s, slots } = slotsFor(1440, 900, { overlay: OVERLAY_1440, column: COLUMN[1440] });
  assert.equal(slots.selected.matrix, undefined, 'flat: a translation, no plane');
  assert.equal(slots.selected.place.split(' ')[0], 'left');
  assert.equal(slots.selected.align, 'end');
  near(slots.selected.x + slots.selected.width, s.bracket.left - LANE_LABEL.square - LANE_LABEL.outside, 'ending before the left squares', 1);
  const middle = slots.selected.y + set.descent - set.line / 2, share = (middle - s.bracket.top) / (s.bracket.bottom - s.bracket.top);
  assert.ok(LANE_LABEL.left.some((left) => Math.abs(left - share) < 0.004), `at one of the shares (${share.toFixed(3)})`);
  assert.ok(share <= 0.3 + 0.004, `in the upper third of the bracket (${share.toFixed(3)})`);
  for (const path of s.squarePaths) for (const p of path)
    assert.ok(!polygonsMeet(lineOf(slots.selected, set), rect({ left: p.x - 3, top: p.y - 3, right: p.x + 3, bottom: p.y + 3 })), 'clear of the top left square\'s paths');
  // Where the left has no room (here: a box over it), at the top of the bracket as before (2026-10-08):
  // beside the top right corner, the block's top level with the top squares' tops, in the fog over the shelf.
  // (The box with its clear margin reaches exactly to where the left place ends, and no further.)
  const leftCovered = (overlay, b) => [...overlay, { left: 0, top: 0, right: b.left - LANE_LABEL.square - LANE_LABEL.outside - LANE_LABEL.clear, bottom: 900 }];
  ({ s, slots } = slotsFor(1440, 900, { overlay: leftCovered(OVERLAY_1440, s.bracket), column: COLUMN[1440] }));
  assert.equal(slots.selected.place.split(' ')[0], 'corner');
  assert.equal(slots.selected.align, undefined);
  assert.equal(slots.selected.y - set.ascent, Math.round(s.bracket.top - LANE_LABEL.square), 'its block\'s top level with the top squares\'');
  assert.ok(slots.selected.x >= s.bracket.right + LANE_LABEL.square + LANE_LABEL.beside, 'right of the top right square');
  assert.ok(slots.selected.x + slots.selected.width <= COLUMN[1440].left - LANE_LABEL.gap, 'ending before the right column');
  // Above the bracket the heading (two lines of the name kept free) needs the room portrait gives
  // it: 1440 x 900 has none under the header's band any more.
  assert.ok(!/above/.test(slots.selected.place.split(';')[0]), 'not above the bracket at 1440 x 900');
  // 16:9 and wider: left of the bracket too. With the left covered, beside its top right corner (the
  // bracket reaches the header's height), 24 px under the header, as before: where the steps of the
  // top right square leave no room for two lines of the name there, with room for one.
  for (const [width, height] of [[1280, 720], [1225, 772], [1366, 768], [1920, 1080], [2560, 1080]]) {
    const { overlay, column, header } = overlayOf(width, height, false);
    const out = slotsFor(width, height, { overlay, column, header });
    const line = lineOf(out.slots.selected, set);
    assert.equal(out.slots.selected.place.split(' ')[0], 'left', `${width} x ${height}`);
    assert.equal(out.slots.selected.lines, 2, `${width} x ${height}: room for two lines`);
    near(line[1].x, out.s.bracket.left - LANE_LABEL.square - LANE_LABEL.outside, `${width} x ${height}: ending before the left squares`, 1);
    assert.ok(line[0].y >= header.bottom + LANE_LABEL.header - 0.5, `${width} x ${height}: 24 px under the header`);
    const covered = slotsFor(width, height, { overlay: leftCovered(overlay, out.s.bracket), column, header });
    const corner = lineOf(covered.slots.selected, set);
    assert.equal(covered.slots.selected.place.split(' ')[0], 'corner', `${width} x ${height}, the left covered`);
    assert.ok([1, 2].includes(covered.slots.selected.lines) && covered.slots.selected.width >= set.least, `${width} x ${height}, the left covered: ${covered.slots.selected.lines} line(s), ${covered.slots.selected.width} px`);
    assert.ok(corner[0].y >= header.bottom + LANE_LABEL.header - 0.5, `${width} x ${height}: 24 px under the header`);
    assert.ok(corner[0].y <= Math.max(covered.s.bracket.top, header.bottom + LANE_LABEL.header) + Math.max(...LANE_LABEL.drop), `${width} x ${height}: at the top of the bracket`);
    assert.ok(corner[1].x <= column.left - (corner[2].y >= column.top - LANE_LABEL.over ? LANE_LABEL.clear : LANE_LABEL.gap) + 1e-6, `${width} x ${height}: ending before the right column`);
  }
  // Portrait (no left place: the bracket far under the header): above it, between the squares'
  // columns, its block's bottom (a second line of the name included) over the top squares by the
  // highest lift that leaves room under the header. Compact (a small bracket, the right column
  // close by): above it the heading no longer fits under the header (2026-10-18); left of it, a
  // third of the way down, it has 155 px at 1000 x 720.
  for (const [width, height, compact] of [[820, 1180], [600, 900], [1000, 720, true]]) {
    const portrait = isPortraitViewport(width, height);
    const { overlay, column, header } = overlayOf(width, height, portrait, compact);
    const out = slotsFor(width, height, { compact, overlay, column, header, type: portraitType });
    const slot = out.slots.selected, small = portraitType.selected;
    assert.ok(slot.y - small.ascent >= header.bottom + LANE_LABEL.header, `${width} x ${height}: 24 px under the header`);
    assert.equal(slot.lines, 2, `${width} x ${height}: room for two lines`);
    if (portrait) {
      assert.equal(slot.place.split(' ')[0], 'above', `${width} x ${height}`);
      const bottom = slot.y + small.descent + small.more, over = out.s.bracket.top - LANE_LABEL.square - LANE_LABEL.above - bottom;
      assert.ok(LANE_LABEL.lift.some((lift) => Math.abs(lift - over) < 1), `${width} x ${height}: a second line's room over the top squares by a lift (${over.toFixed(1)})`);
      assert.ok(slot.x > out.s.bracket.left + LANE_LABEL.square && slot.x + slot.width < out.s.bracket.right - LANE_LABEL.square, `${width} x ${height}: between the squares' columns`);
      assert.equal(out.slots.nearer.shown, false, `${width} x ${height}: no nearer name in portrait`);
      assert.ok(out.slots.further.shown);
    } else {
      assert.equal(slot.place.split(' ')[0], 'left', `${width} x ${height}`);
      const share = (slot.y + small.descent - small.line / 2 - out.s.bracket.top) / (out.s.bracket.bottom - out.s.bracket.top);
      assert.ok(share > 0.3 && share < 0.37, `${width} x ${height}: a third of the way down (${share.toFixed(3)})`);
      assert.ok(slot.width >= 120, `${width} x ${height}: ${slot.width} px`);
    }
  }
  // The first place of each kind with room for a heading of either size, a few windows the overlay
  // places as the page does (2026-10-18, in Chrome): 1225 x 772 and 1100 x 820 a third of the way
  // down left of the bracket too.
  for (const [width, height] of [[1225, 772], [1100, 820]]) {
    const { overlay, column, header } = overlayOf(width, height, false);
    const out = slotsFor(width, height, { overlay, column, header });
    assert.equal(out.slots.selected.place.split(' ')[0], 'left', `${width} x ${height}`);
    assert.ok(out.slots.selected.width >= 150, `${width} x ${height}: ${out.slots.selected.width} px`);
  }
  // Under the bracket (on the covers) only where nothing at its top has room; nothing anywhere: not shown.
  const none = laneLabelSlots(BRACKET, { width: 1440, height: 900, portrait: false, header: { top: 40, bottom: 70 }, avoid: [{ left: 0, top: 0, right: 1440, bottom: 900 }] }, TYPE, shelf(1440, 900).face);
  assert.equal(none.selected.shown, false);
  const lane = read('src/lane-labels.ts');
  assert.match(lane, /search: for \(const where of \["atTop", "under"\] as const\) for \(const \{ more, lines \} of plans\) \{/, 'two lines, else one, at the top before under the bracket');
  assert.match(lane, /plans = two > 0 \? \[\{ more: two, lines: 2 \}, \{ more: 0, lines: 1 \}\] : \[\{ more: 0, lines: 1 \}\];/);
  assert.doesNotMatch(lane, /place: "right"|backward/, 'no longer beside the case\'s lower corner');
  assert.match(lane, /if \(!view\.portrait\) \{\s*const ends = bracket\.left - square - LANE_LABEL\.outside;/, 'left of the bracket only in landscape');
});

test('in every window the names keep clear of the overlay, each other, the lifted case and the squares\' paths', () => {
  for (const [width, height, compact] of [[1440, 900], [1280, 720], [1225, 772], [1366, 768], [1920, 1080], [2560, 1080], [1100, 820], [1000, 700, true], [1000, 720, true], [820, 1180], [600, 900]]) {
    const portrait = isPortraitViewport(width, height);
    const { overlay, column, header } = overlayOf(width, height, portrait, compact);
    const { s, slots } = slotsFor(width, height, { compact, overlay, column, header, type: compact || portrait ? { ...TYPE, selected: SMALL } : TYPE });
    const shown = Object.entries(slots).filter(([, slot]) => slot.shown);
    assert.equal(shown.length, portrait ? 2 : 3, `${width} x ${height}: ${shown.map(([role]) => role)}`);
    for (const [role, slot] of shown) {
      const set = role === 'selected' && (compact || portrait) ? SMALL : TYPE[role];
      const line = lineOf(slot, set);
      assert.ok(slot.width >= LANE_LABEL.least, `${width} x ${height} ${role}: room`);
      assert.ok(line.every((p) => p.x >= LANE_LABEL.clear - 1e-6 && p.x <= width - LANE_LABEL.clear + 1e-6 && p.y >= 0 && p.y <= height), `${width} x ${height} ${role}: in the picture`);
      for (const b of overlay) assert.ok(!polygonsMeet(line, rect(b, LANE_LABEL.clear - 0.5, LANE_LABEL.clearY - 0.5)), `${width} x ${height} ${role}: clear of the overlay`);
      for (const [i, shape] of s.keep.entries()) assert.ok(!polygonsMeet(line, shape), `${width} x ${height} ${role}: clear of keep-out ${i}`);
      assert.ok(!polygonsMeet(line, s.face), `${width} x ${height} ${role}: off the lifted case's face`);
      // The top left square through the hop and 1-3 rows each way (the selected name stands beside its path).
      for (const path of s.squarePaths) for (const p of path)
        assert.ok(!polygonsMeet(line, rect({ left: p.x - LANE_LABEL.square, top: p.y - LANE_LABEL.square, right: p.x + LANE_LABEL.square, bottom: p.y + LANE_LABEL.square })), `${width} x ${height} ${role}: clear of the top left square's path`);
      for (const [other, otherSlot] of shown) if (other !== role) assert.ok(!polygonsMeet(line, lineOf(otherSlot, other === 'selected' && (compact || portrait) ? SMALL : TYPE[other])), `${width} x ${height}: ${role} and ${other} apart`);
      if (role === 'selected') {
        assert.ok(line[0].y >= header.bottom + LANE_LABEL.header - 0.5, `${width} x ${height}: the selected name 24 px under the header's band`);
        if (!portrait) assert.ok(line[1].x <= column.left - (line[2].y >= column.top - LANE_LABEL.over ? LANE_LABEL.clear : LANE_LABEL.gap) + 1e-6, `${width} x ${height}: the selected name never reaches over the right column, and level with its rows keeps well clear of it`);
      }
      // Each takes a place with room for a name of some length (five characters or about ten
      // letters), where there is one; 16:9 at 720 px high is the tightest (1280 x 720: 157, 111, 147).
      if (!portrait && width >= 1200) assert.ok(slot.width >= 100, `${width} x ${height} ${role}: ${slot.width} px of room`);
    }
  }
});

test('a name ends before what it keeps clear of, and a place with no room is passed over', () => {
  const { s } = slotsFor(1440, 900);
  const view = { width: 1440, height: 900, portrait: false, header: { top: 40, bottom: 70 }, avoid: [] };
  const places = { further: s.places('further', TYPE.further), nearer: s.places('nearer', TYPE.nearer) };
  const free = laneLabelSlots(s.bracket, view, TYPE, s.face, s.keep, places);
  // A box right after the further name's start shortens it to end LANE_LABEL.clear before it ...
  const start = mapPoint(free.further.matrix, 0, TYPE.further.ascent);
  const wall = { left: start.x + 70, top: 0, right: 1440, bottom: 900 };
  const short = laneLabelSlots(s.bracket, { ...view, avoid: [wall] }, TYPE, s.face, s.keep, places).further;
  assert.ok(short.shown && short.width < free.further.width);
  const end = lineOf(short, TYPE.further);
  assert.ok(Math.max(...end.map((p) => p.x)) <= wall.left - LANE_LABEL.clear + 1, 'ending before it');
  // ... or, where a place has less room than LANE_LABEL.room, the next place with room is taken.
  const covered = laneLabelSlots(s.bracket, { ...view, avoid: [{ left: start.x - 10, top: start.y - 10, right: start.x + 10, bottom: start.y + 10 }] }, TYPE, s.face, s.keep, places).further;
  assert.ok(covered.shown && covered.place !== free.further.place, `${covered.place} instead of ${free.further.place}`);
  // No places: no neighbours.
  const bare = laneLabelSlots(s.bracket, view, TYPE, s.face, s.keep);
  assert.equal(bare.further.shown, false);
  assert.equal(bare.nearer.shown, false);
});

test('a switch, a quick double press and steps along a column, as the shelf\'s track springs', () => {
  // The track is the column camera's spring (scene.ts: damp at 3.7 per second); a name's place
  // is its slot and a drift that is a function of its column's offset from the track alone.
  // Follow every name through a switch and a double press (the second 300 ms later): it moves
  // one way only (no reversal) and no further than its drift.
  const dt = 1 / 60;
  const run = (presses) => {
    const track = { value: 2, velocity: 0 };
    let target = 2;
    const frames = [];
    for (let frame = 0; frame < 240; frame++) {
      for (const press of presses) if (Math.round(press.at / dt) === frame) target += press.by;
      damp(track, target, 3.7, dt);
      frames.push(track.value);
    }
    return frames;
  };
  const most = LANE_LABEL.fade * Math.hypot(LANE_LABEL.drift.x, LANE_LABEL.drift.y);
  for (const presses of [[{ at: 0, by: 1 }], [{ at: 0, by: -1 }], [{ at: 0, by: 1 }, { at: 0.3, by: 1 }]]) {
    const frames = run(presses);
    for (const lane of [0, 1, 2, 3, 4, 5]) for (const role of ['nearer', 'selected', 'further']) {
      let previous, previousStep = 0, reversals = 0;
      for (const centre of frames) {
        const shown = roles(lane - centre)[role];
        if (!shown) continue;
        assert.ok(Math.hypot(shown.dx, shown.dy) <= most + 1e-9, 'never further than its drift');
        if (previous) {
          const step = shown.dy - previous.dy;
          if (Math.abs(step) > 1e-6) {
            if (previousStep && Math.sign(step) !== Math.sign(previousStep)) reversals++;
            previousStep = step;
          }
        }
        previous = shown;
      }
      assert.equal(reversals, 0, `lane ${lane} ${role}: reversals with ${JSON.stringify(presses)}`);
    }
  }
  // Up / down (and the wheel): only the row changes, so the track's target stays and the spring
  // stands still at its column: in every frame each named column is in its own role, at its slot,
  // in full and not drifted, exactly as at rest.
  const still = run([]);
  assert.ok(still.every((centre) => centre === 2), 'the track does not move');
  for (const centre of still) for (const [role, slot] of LANE_ROLES) {
    assert.deepEqual(laneLabelShares(2 + slot - centre), [{ role, share: role === 'selected' ? 1 : LANE_LABEL.neighbour, dx: 0, dy: 0 }], `${role} at rest while the rows change`);
  }
});

test('the scene places the names from their slots and the sideways track alone', () => {
  const scene = read('src/scene.ts');
  const place = body(scene, 'private placeLaneLabels(', 'private createLaneNameLayer(');
  assert.match(place, /private placeLaneLabels\(centre: number, shown: number\)/);
  assert.match(scene, /this\.placeLaneLabels\(center\.lane,\s*musicLibrary && !cinematic \|\| musicIntro \? \(musicIntro \? introSettle : 1\) \* \(1 - detail\) \* \(1 - songProgress\) : 0\);/,
    'the shelf\'s track, and the browsing view\'s share (opening an album or the song scene fades them where they stand)');
  // Written last in a frame: after the picture is drawn and the lifted case's box is read, so no
  // read of the page's layout in the frame waits for the names' new styles (measured 2026-10-06:
  // 0.26 ms a frame of forced style work while the shelf slid, 0.09 ms with the names last).
  const frameEnd = body(scene, '      this.liftedBox = musicLibrary', '  /**');
  assert.match(frameEnd, /\? this\.measureLiftedCase\(\) : null;\s*\}\s*(\/\/[^\n]*\n\s*)*this\.placeLaneLabels\(center\.lane,[^;]*;\s*this\.pacing\.finish\(time, draw, resting\);/);
  assert.equal(scene.match(/this\.placeLaneLabels\(/g).length, 1, 'once a frame');
  // Nothing that moves the shelf's cases, the camera or the selection's row reaches a name: not
  // the waves, the lifted case and its hop, the idle drift, the rows, the wheel, the live bracket.
  assert.doesNotMatch(place, /field\(|idleWave|pulses|musicSelectionWave|this\.shoulder|this\.rail|this\.lift|this\.outgoing|this\.selectedCell|this\.camera\b|laneFocus|playHop|columnForward|liftedBox|measureLiftedCase|wheel/,
    'no wave, lift, hop, row, live camera or live bracket per frame');
  assert.match(place, /const offset = lane - centre;/);
  assert.match(place, /for \(const \{ role, share, dx, dy \} of laneLabelShares\(offset, portrait, this\.reduced\)\) \{/);
  assert.match(place, /const slot = slots\[role\], opacity = share \* shown;/);
  // The count of columns for the selected heading's kicker (PLAYLIST 04 / 11), as the playlist list's head counts them.
  assert.match(place, /layer\.show\(`\$\{key\}:\$\{role\}`, role, column, archiveColumns\.length, name, slot, dx, dy, opacity\);/);
  assert.match(read('src/music-app.ts'), /genresTotal: archiveColumns\.length,/);
  assert.match(place, /const nearest = Math\.round\(centre\);\s*if \(Math\.abs\(centre - nearest\) < 1e-5\) centre = nearest;/);
  assert.match(place, /const portrait = isPortraitViewport\(width, height\);/, 'the portrait rule comes from viewport-layout.ts');
  assert.doesNotMatch(place, /clientWidth\s*[<>]|innerWidth/, 'no screen-width threshold of its own');
  assert.match(place, /const lone = archiveColumns\.length === 1;/);
  assert.match(place, /if \(\(lone && role !== "selected"\) \|\| !slot\.shown \|\| opacity <= 0\.001\) continue;/);
  assert.match(place, /const key = lane \+ this\.coordinateOrigin\.lane;/);
  // The slots: worked out again only when the window, its layout or what the layer measures (the
  // fonts, the overlay's boxes) change; from the shelf at rest, seen with the camera at rest.
  assert.match(place, /const slots = visible \? this\.laneLabelSlots\(layer, width, height\) : null;/);
  const slots = body(scene, '  private laneLabelSlots(', '  /**');
  assert.match(slots, /const view = `\$\{width\}x\$\{height\}:\$\{layout\}:\$\{layer\.version\}`;\s*if \(this\.laneSlots\?\.view === view\) return this\.laneSlots\.slots;\s*const page = layer\.measure\(view\);/);
  assert.match(read('src/lane-names.ts'), /measure\(view: string\): LaneNamePage \| undefined \{\s*if \(this\.page\?\.view === view\) return this\.page\.page;/);
  assert.match(slots, /this\.shelfRestCamera\(this\.restCamera, layout === "compact"\);\s*const \{ bracket, face \} = this\.restBracket\(width, height\);\s*const keep = this\.restKeepOut\(width, height\);/);
  assert.match(slots, /further: this\.lanePlaces\("further", width, height, page\.type\.further\),\s*nearer: this\.lanePlaces\("nearer", width, height, page\.type\.nearer\),/);
  assert.match(slots, /laneLabelSlots\(bracket, \{ width, height, portrait: isPortraitViewport\(width, height\), header: page\.header, avoid: page\.avoid, column: page\.column \}, page\.type, face, keep, places\)/);
  const rest = body(scene, '  private laneLabelSlots(', '  private shelfRestCamera(');
  assert.doesNotMatch(rest, /this\.camera\b|this\.laneFocus|this\.lift\b|this\.lift\.|this\.columnCamera|this\.model|liftedBox|idleWave\(|playHop\(/, 'only the shelf at rest and the camera at rest');
  // The replica in this file: restBracket ...
  const bracket = body(scene, '  private restBracket(', '  /**');
  assert.match(bracket, /private restBracket\(width: number, height: number, shiftZ = 0, shiftY = 0\)/);
  assert.match(bracket, /const camera = this\.restCamera, probe = this\.restProbe;/);
  assert.match(bracket, /const ahead = \(lane: number\) => MUSIC_COLUMN_FORWARD \* THREE\.MathUtils\.smoothstep\(1 - lane, 0, 1\);/);
  assert.match(bracket, /edge: \(lane: number\) => lane \* COLUMN_SPACING - ahead\(lane\) - MUSIC_MODEL\.width \/ 2,/);
  assert.match(bracket, /base: -4\.6 \+ settlingWave\(0, 26\.56\) \* columnStrength\(0, 0\) \+ MUSIC_PREVIEW_LIFT \+ shiftY,/);
  assert.match(bracket, /depth: -2\.17 \+ shiftZ,/);
  assert.match(bracket, /const p = probe\.set\(rest\.edge\(0\) \+ MUSIC_MODEL\.width \/ 2 \+ x, rest\.base \+ y, rest\.depth \+ z\)\.project\(camera\);/);
  assert.match(bracket, /MUSIC_MODEL\.center\.x \+ \(corner & 1 \? 0\.5 : -0\.5\) \* MUSIC_MODEL\.width,\s*MUSIC_MODEL\.center\.y \+ \(corner & 2 \? 0\.5 : -0\.5\) \* MUSIC_MODEL\.height,\s*MUSIC_MODEL\.center\.z \+ \(corner & 4 \? 0\.5 : -0\.5\) \* MUSIC_MODEL\.depth,/);
  assert.match(bracket, /return \{ bracket: \{ left, top, right, bottom \}, face: \[corners\[4\], corners\[5\], corners\[7\], corners\[6\]\], corners \};/);
  // (The case's own ▶ is gone, the owner, 2026-10-10: "delete the marked button, we already have a
  // play button on the right". Nothing models or places it any more.)
  assert.doesNotMatch(scene + read('src/music-app.ts') + read('src/music-shelf.css'), /LANE_CASE_PLAY|CASE_PLAY|syncCasePlay|case-play|casePlay/);
  // ... restKeepOut ...
  const keep = body(scene, '  private restKeepOut(', '  /**');
  assert.match(scene, /const LANE_SWEEP = \{ idle: 0\.1 \} as const;/);
  assert.match(keep, /const rest = \[at\(0, idle\), at\(0, -idle\)\];/);
  assert.match(keep, /const steps = \(way: 1 \| -1\) => laneStepPoses\(way, MUSIC_PREVIEW_LIFT\)\.map\(\(\{ z, y \}\) => at\(z, y\)\);/);
  // The steps' springs are update()'s on the shelf, and the wheel's commits come at least 90 ms apart.
  assert.deepEqual([LANE_STEP.rail, LANE_STEP.shoulder, LANE_STEP.lift, LANE_STEP.apart], [3.7, 5, 4.2, 0.09]);
  assert.match(scene, /damp\(this\.shoulder, selectedRow, this\.reduced \? 35 : detailNavigation \? MUSIC_ALBUM_SWITCH_RATE : 5, dt\);/);
  assert.match(scene, /damp\(\s*this\.rail,\s*cinematic \? 0 : -2\.17 - chosen\.z,\s*this\.reduced \? 35 : detailNavigation \? MUSIC_ALBUM_SWITCH_RATE : 3\.7,\s*dt,\s*\);/);
  assert.match(scene, /else damp\(this\.lift, liftTarget, detailNavigation \? MUSIC_ALBUM_SWITCH_RATE : 4\.2, dt\);/);
  assert.match(scene, /this\.lift\.value = 0;\s*this\.lift\.velocity = 0;\s*\}\s*this\.selectedSlot = next;/, 'each new selection lifts from 0');
  assert.match(read('src/wheel-navigation.ts'), /export const WHEEL_COMMIT_INTERVAL_MS = 90;/);
  assert.match(keep, /const hop = \[at\(0, PLAY_GESTURE\.height \+ idle\)\];\s*const keep = \[convexHull\(rest\.flatMap\(\(b\) => b\.corners\)\)\];/);
  assert.match(keep, /for \(const moves of \[hop, steps\(1\), steps\(-1\)\]\) keep\.push\(convexHull\(\[\.\.\.rest, \.\.\.moves\]\.flatMap\(\(b\) => around\(corners\(b\)\[corner\]\)\)\)\);\s*return keep;/);
  // ... and lanePlaces.
  const lanes = body(scene, '  private lanePlaces(', '  /**');
  assert.match(lanes, /const order = \(isPortraitViewport\(width, height\) && role === "further" \? LANE_PLANE\.portrait\.further : null\) \?\? LANE_PLANE\[role\];/);
  assert.match(lanes, /const ahead = MUSIC_COLUMN_FORWARD \* THREE\.MathUtils\.smoothstep\(1 - lane, 0, 1\);/);
  assert.match(lanes, /const along = new THREE\.Vector3\(Math\.cos\(turn\), 0, Math\.sin\(turn\)\);/);
  assert.match(lanes, /const base = -4\.6 \+ settlingWave\(row, 26\.56\) \* columnStrength\(lane, 0\);/);
  assert.match(lanes, /lane \* COLUMN_SPACING - ahead \+ MUSIC_MODEL\.center\.x - MUSIC_MODEL\.width \/ 2,\s*base \+ MUSIC_MODEL\.center\.y \+ MUSIC_MODEL\.height \/ 2 \+ LANE_PLANE\.lift,\s*-2\.17 \+ row \* ROW_SPACING \+ MUSIC_MODEL\.center\.z \+ MUSIC_MODEL\.depth \/ 2,/);
  assert.match(lanes, /const scale = 1 \/ Math\.hypot\(head\.x - foot\.x, head\.y - foot\.y\);/);
  assert.match(lanes, /const matrix = quadMatrix\(size, line, \[point\(0, 0\), point\(size, 0\), point\(size, line\), point\(0, line\)\]\);/);
  assert.match(lanes, /const reach = \(MUSIC_MODEL\.width \* Math\.abs\(along\.x\) \+ 8 \* ROW_SPACING \* Math\.abs\(along\.z\) - start\) \/ scale;/);
  assert.match(scene, /export const MUSIC_PREVIEW_LIFT = 1\.035;/);
  assert.match(scene, /export const MUSIC_COLUMN_FORWARD = 1\.8;/);
  assert.match(read('src/archive-loop.ts'), /export const COLUMN_SPACING = 5\.2;\s*export const ROW_SPACING = 0\.62;/);
  // ... as update() poses the lifted case on the shelf (the cell, the shoulder, the lift, the column come forward).
  assert.match(scene, /\(cell\.lane - 2\) \* COLUMN_SPACING,\s*-4\.6,\s*\(cell\.row - 15\.5\) \* ROW_SPACING,/);
  assert.match(scene, /chosen\.y \+ field\(selectedRow, selectedLane, false\) \+ this\.lift\.value,/);
  assert.match(scene, /this\.model\.position\.x -= columnForward\(selectedLane\);/);
  assert.match(scene, /if \(forward\) this\.dummy\.position\.x -= columnForward\(lane\);/);
  // The camera at rest is where update() takes the music camera on the shelf.
  const restCamera = /const SHELF_REST = \{\s*yaw: 89 - 22 - 8,\s*elevation: 3 \+ 40 - 8 - 16 \+ 6,\s*span: 7\.33,\s*distance: 140,\s*aim: \[-1\.091, -0\.045, 0\.481\],\s*\} as const;/;
  assert.match(scene, restCamera);
  assert.match(scene, /const yaw = THREE\.MathUtils\.degToRad\(89 - 22 \* orbit - 8 \* settle\) \+ navigationOrbit\.yaw;/);
  assert.match(scene, /3 \+ 40 \* ease\(\(shot - 21\.96\) \/ 0\.22\) - 8 \* orbit - 16 \* settle \+\s*\(musicIntro \? 6 \* introSettle : musicLibrary && !cinematic \? 6 : 0\),/);
  assert.match(scene, /THREE\.MathUtils\.lerp\(10\.8, 10\.3, orbit\),\s*7\.33,\s*settle,/);
  assert.match(scene, /THREE\.MathUtils\.lerp\(28 \+ 7 \* orbit, 140, settle\),/);
  assert.match(scene, /-1\.091,\s*THREE\.MathUtils\.lerp\(-2\.55 \+ 0\.4 \* orbit, -0\.045, settle\),\s*THREE\.MathUtils\.lerp\(2\.48, 0\.481, settle\),/);
  const camera = body(scene, '  private shelfRestCamera(', '  /** Cases of the shelf and of the chain can be picked');
  assert.match(camera, /const framing = archiveFraming\(width, height, SHELF_REST\.span, 0, compact\);/);
  assert.match(camera, /aim\.set\(0, -4\.6 \+ settlingWave\(0, 26\.56\) \+ 0\.4 \+ 1\.85, -2\.17\)\.addScaledVector\(up, \(framing\.previewY - 0\.5\) \* framing\.span\);/, 'the portrait framing, as update() has it');
  assert.match(scene, /previewAim\.addScaledVector\(up, \(framing\.previewY - 0\.5\) \* height \/ pixelScale\);/);
  assert.doesNotMatch(camera, /pointer/, 'no pointer parallax');
  // The geometry of the names along the cases (2026-10-06) and the captions hung on the bracket (2026-10-07) are gone.
  assert.doesNotMatch(scene, /laneLabelRest|laneLabelPose|laneLabelSeen|LANE_LABEL\.(stand|rise|liftGraze|margin|faceGap)|private ceiling\(/);
  assert.doesNotMatch(read('src/lane-labels.ts'), /reachBetween|view\.top \+ ascent|LANE_LABEL\.face\b/);
});

test('the names in the scene are gone: no plates, no pass after the lens, no lifts per column', () => {
  const scene = read('src/scene.ts');
  assert.ok(!existsSync(new URL('../src/lane-plates.ts', import.meta.url)), 'lane-plates.ts is removed');
  assert.doesNotMatch(scene, /LanePlate|lanePlate|LANE_PLATE|LaneLifts|laneLifts|labelCamera|laneTags|laneStyle|LaneLabelStyle/);
  assert.doesNotMatch(read('src/lane-labels.ts'), /class LaneLifts|liftRate/);
  assert.doesNotMatch(read('src/depth-of-field.ts'), /depthWidth|depthHeight/, 'the depth size was read only by the names\' pass');
  // The frame description no longer carries names (they are not in the picture the scene draws).
  assert.doesNotMatch(body(scene, '  private describeFrame() {', '\n  }\n'), /lane/i);
});

test('a name over the picture is text only, above the veils, out of the pointer\'s way and of assistive technology', () => {
  const names = read('src/lane-names.ts');
  const css = read('src/music-shelf.css');
  // The layer: in the scene's container, hidden from assistive technology.
  assert.match(names, /this\.element\.className = "lane-names";\s*this\.element\.setAttribute\("aria-hidden", "true"\);\s*host\.append\(this\.element\);/);
  assert.match(read('src/scene.ts'), /const layer = new LaneNameLayer\(this\.container\);/);
  // A neighbour's name: its number and its name; the selected one's (2026-10-18, the owner chose
  // "A · Display name"): its kicker (PLAYLIST, its number, / and the count) and its name. Nothing
  // else (no image, drawing or mark).
  assert.match(names, /\} else this\.element\.append\(this\.index, this\.text\);/);
  assert.match(names, /const KICKER = "PLAYLIST";/);
  assert.match(names, /kicker\.append\(`\$\{KICKER\} `, this\.index, of\);\s*this\.element\.append\(kicker, this\.text\);/);
  assert.match(names, /const of = ` \/ \$\{String\(count\)\.padStart\(2, "0"\)\}`;/);
  assert.doesNotMatch(names, /createElementNS|"svg"|innerHTML|\.fill(Rect|Text)?\(|\.stroke\(/);
  assert.match(names, /this\.index\.textContent = index;\s*if \(this\.of\) this\.of\.textContent = of;\s*this\.text\.textContent = name;/, 'text, never markup');
  // The selected one flat (a translation, no turn or scale); the neighbours by their slot's
  // homography as a matrix3d (2026-10-08: printed in perspective on a plane that faces right).
  assert.match(names, /if \(slot\.matrix\) \{\s*view\.place\(\{ role, x: slot\.x \+ dx, y: slot\.y \+ dy, opacity \}, cssMatrix\(slot\.matrix, dx, dy\)\);\s*return;\s*\}/);
  // The selected one is a block as wide as its slot; a right-aligned slot (left of the bracket,
  // 2026-10-10) has its lines end where the slot ends (music-shelf.css: text-align end).
  assert.match(names, /view\.size\(slot\.width, slot\.align === "end"\);\s*const x = slot\.x \+ dx, y = slot\.y \+ dy;/);
  assert.match(names, /if \(wide !== this\.shown\.width\) this\.element\.style\.width = this\.shown\.width = wide;/, 'its width written only when it changes');
  // Its name in as many lines as its slot has room for (twoLines), measured in its own type; a neighbour's shortened to one.
  assert.match(names, /const written = this\.fit\(role, label, slot\.width, slot\.lines \?\? 1\);/);
  assert.match(names, /if \(role === "selected"\) \{\s*const broken = twoLines\(c, label\.name, width, lines\);\s*written = \{ name: broken\.join\("\\n"\)/);
  assert.match(names, /`translate\(\$\{x\.toFixed\(2\)\}px, \$\{\(y - page\.type\[role\]\.ascent\)\.toFixed\(2\)\}px\)`/);
  assert.doesNotMatch(names, /rotate\(|scale\(|skew|--lane-unscale|LAYOUT_SIZE/);
  assert.match(names, /if \(transform !== this\.shown\.transform\) style\.transform = this\.shown\.transform = transform;/, 'a name at rest writes nothing');
  // Its type measured where the layout puts it; what it keeps clear of measured from the page.
  assert.match(names, /mark\.style\.cssText = "display: inline-block; width: 0; height: 0; vertical-align: baseline";/);
  assert.match(names, /const HEADER = \["\.music-identity", "\.music-topnav"\];/);
  // Watched elements no longer in the page are let go: no leak.
  assert.match(names, /for \(const element of this\.watched\) \{\s*if \(found\.has\(element\)\) continue;\s*this\.watch\?\.unobserve\(element\);\s*this\.watched\.delete\(element\);\s*\}/);
  const rules = [...css.matchAll(/([^{}]*\.lane-name[^{}]*)\{([^}]*)\}/g)];
  assert.ok(rules.length >= 6, 'the layer, the name, the selected one, the number, the selected number, the playing column\'s number');
  for (const [, selector, declarations] of rules) {
    // The owner (2026-10-04): only the text, nothing behind or around it; (2026-10-07) no rim.
    assert.doesNotMatch(declarations, /background|border|outline|box-shadow|text-shadow|padding|filter|transform(?!-origin: 0 0;)|transition|mask|--lane-rim|--lane-unscale/, `${selector.trim()}: text only, no plate, frame, band or rim; placed and faded by the scene`);
    if (!/\.lane-names\s*$/.test(selector.trim())) assert.doesNotMatch(declarations, /z-index/, `${selector.trim()}: only the layer is stacked`);
  }
  const rule = (pattern) => rules.find(([, selector]) => pattern.test(selector.trim().split('\n').pop().trim()))?.[2] ?? '';
  const layer = rule(/^\.music-app \.lane-names$/);
  assert.match(layer, /pointer-events: none;/);
  // Above the vignette (1) and the reading veil, which wash out a name right of the picture's
  // middle; under the bracket (2, later in the page), the right column (3), the counter (4) and
  // the header (6). #three-scene makes no stacking context that would trap it under the veil.
  assert.match(layer, /z-index: 2;/);
  assert.match(css, /\.music-app \.selection-bracket \{[^}]*z-index: 2;/);
  assert.match(css, /\.music-app \.album-callout \{[^}]*z-index: 3;/);
  assert.match(css, /\.music-app \.music-navigation \{[^}]*z-index: 4;/);
  assert.match(read('src/music.css'), /\.music-vignette \{[^}]*z-index: 1;/);
  for (const file of ['src/music.css', 'src/style.css']) {
    for (const [, declarations] of read(file).matchAll(/(?:^|\n)(?:\.music-app )?\.three-scene \{([^}]*)\}/g))
      assert.doesNotMatch(declarations, /z-index|isolation|transform|filter|will-change|contain/, `${file}: #three-scene makes no stacking context`);
  }
  assert.doesNotMatch(read('src/music-app.ts'), /\$\("#three-scene"\)\.style\.(zIndex|transform|filter|isolation)/);
  // The type: the overlay's own. The names as the artist line (600); the selected one larger;
  // the neighbours at 16 px upright on their plane (foreshortened there, their capitals stay at
  // least 11 px tall), their numbers 15 px (17 px from 1700 px), 700, in ink like the name
  // (2026-10-08 review: 10 px muted numbers were 7 px tall at about 2:1); the selected one's
  // number as the tag (10 px, 700, .14em, muted). Tabular figures. A name's transform is taken
  // from its top left.
  const name = rule(/^\.music-app \.lane-name$/);
  assert.match(name, /transform-origin: 0 0;/);
  assert.match(name, /color: var\(--ink\);/);
  assert.match(name, /line-height: 1;/);
  assert.match(name, /font-size: 16px;/);
  assert.match(name, /font-weight: 600;/);
  // The selected one (2026-10-18) a heading: a column of its kicker and its name, its name as the
  // song title is set (700, -0.015em, 1.14) at 32 px (24 px in compact and portrait, 37 px from
  // 1700 px), in lines of its own (a line break, nothing wrapped or clipped by CSS); the kicker as
  // the playlist list's head (10 px, 700, .14em; 9 and 12 px), the count 400, its number as the
  // kicker's (only the playing queue's column in the playback colour). All in ink.
  const selected = rule(/^\.music-app \.lane-name\[data-role="selected"\]$/);
  assert.match(selected, /display: flex;\s*flex-direction: column;\s*gap: 9px;\s*font-size: 32px;\s*font-weight: 700;\s*letter-spacing: -0\.015em;/);
  assert.match(rule(/^\.music-app \.lane-name\[data-align="end"\]$/), /text-align: end;/);
  const kicker = rule(/^\.music-app \.lane-name-kicker$/);
  assert.match(kicker, /overflow: hidden;\s*font-size: 10px;\s*letter-spacing: 0\.14em;\s*text-overflow: ellipsis;/);
  assert.doesNotMatch(kicker + selected, /color:/, 'in ink, as the layer\'s names');
  assert.match(rule(/^\.music-app \.lane-name-of$/), /font-weight: 400;/);
  const heading = rule(/^\.music-app \.lane-name\[data-role="selected"\] \.lane-name-text$/);
  assert.match(heading, /display: block;\s*line-height: 1\.14;\s*white-space: pre;/);
  assert.doesNotMatch(heading, /overflow|clamp/, 'nothing clipped: lane-names.ts breaks the lines');
  assert.match(css, /\.music-app:is\(\[data-layout="compact"\], \[data-layout="portrait"\]\) \.lane-name\[data-role="selected"\] \{\s*gap: 7px;\s*font-size: 24px;\s*\}/);
  assert.match(css, /\.music-app:is\(\[data-layout="compact"\], \[data-layout="portrait"\]\) \.lane-name-kicker \{\s*font-size: 9px;\s*\}/);
  assert.match(css, /\.music-app\[data-layout="desktop"\] \.lane-name\[data-role="selected"\] \{\s*gap: 10px;\s*font-size: 37px;\s*\}/);
  assert.match(css, /\.music-app\[data-layout="desktop"\] \.lane-name-kicker \{\s*font-size: 12px;\s*\}/);
  const index = rule(/^\.music-app \.lane-name-index$/);
  assert.match(index, /font-size: 15px;/);
  assert.match(index, /font-weight: 700;/);
  assert.match(index, /font-variant-numeric: tabular-nums;/, 'every number as wide: the measured type holds for all');
  assert.match(index, /color: var\(--ink\);/);
  const selectedIndex = rule(/^\.music-app \.lane-name\[data-role="selected"\] \.lane-name-index$/);
  assert.match(selectedIndex, /margin-right: 0;\s*font-size: inherit;\s*letter-spacing: inherit;\s*color: inherit;/);
  assert.match(css, /\.music-app\[data-layout="desktop"\] \.lane-name-index \{\s*margin-right: 9px;\s*font-size: 17px;/);
  assert.doesNotMatch(css, /\.music-app\[data-layout="desktop"\] \.lane-name\[data-role="selected"\] \.lane-name-index/, 'the kicker sizes its number');
  // The playing queue's column's number in the playback colour, wherever it stands (its rule comes after the selected one's).
  assert.match(css, /\.lane-name\[data-live="true"\] \.lane-name-index \{\s*color: var\(--state\);/, 'the playing queue\'s column by its number\'s colour');
  assert.ok(css.indexOf('.lane-name[data-live="true"] .lane-name-index') > css.indexOf('.music-app .lane-name[data-role="selected"] .lane-name-index {'));
  assert.doesNotMatch(css, /:is\(\[data-layout="compact"\], \[data-layout="portrait"\]\) \.lane-name(-index)? \{/, 'the neighbours (and their numbers) are not set smaller in compact and portrait');
  // MiSans (the overlay's font), and the colours follow the theme over 650 ms (registered colours).
  assert.match(read('src/music.css'), /font-family: MiSans, system-ui, sans-serif;/);
  assert.match(read('src/music-theme.css'), /transition-property:[^;]*--ink,\s*--muted,[^;]*;\s*transition-duration: 650ms;/);
});

test('the app names columns from the playlists shown, in one way only', () => {
  const app = read('src/music-app.ts');
  // The names follow the library's columns the moment the library changes.
  assert.match(app, /setMusicAlbums\(albums, genres, displaySort\);\s*syncLaneLabels\(\);/);
  assert.match(app, /laneNames = netease\.queueLanesShown\.length\s*\? archiveColumns\.map/, 'no playlist columns, no names');
  assert.match(app, /scene\?\.setLaneLabels\(laneNames\);/);
  // The tag style is gone: no element, no placement, no style preference.
  assert.doesNotMatch(app, /lane-tags|placeLaneTags|preferences\.laneNameStyle|LANE_LABEL_STYLES/);
  const css = read('src/external-media.css');
  assert.doesNotMatch(css, /\.lane-tag/);
});
