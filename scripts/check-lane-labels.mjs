import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  LANE_LABEL, LANE_LABEL_TEXT, laneLabelAcross, laneLabelIndex, laneLabelPlace, laneLabelPose, laneLabelRange, laneLabelRest, laneLabelSeen,
  laneLabelShare, laneLabelSize, laneLabelSlot, laneLabelSoftMax, laneLabelSpan,
} from '../src/lane-labels.ts';
import { columnStrength, damp, settlingWave } from '../src/motion.ts';

const near = (actual, expected, message, within = 1e-9) => assert.ok(Math.abs(actual - expected) < within, `${message}: ${actual} vs ${expected}`);
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const body = (source, from, to) => {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `${from} is in the source`);
  return source.slice(start, source.indexOf(to, start + from.length));
};

test('names stand on the clear side of the lifted case: across the cases in front for the selected and the nearer column, behind it for the further one', () => {
  // The selected column's name and the nearer column's are written across their case in front
  // of the selected row; toward the further column the selected one turns into an edge name
  // over LANE_LABEL.turn, toward the nearer one it stays across and shrinks to the others' size.
  assert.equal(laneLabelAcross(0), 1);
  assert.equal(laneLabelAcross(-1), 1, 'the nearer column too (2026-10-05: its edge runs into the counter)');
  assert.equal(laneLabelAcross(-LANE_LABEL.turn), 1);
  assert.equal(laneLabelAcross(LANE_LABEL.turn), 0);
  assert.equal(laneLabelAcross(1), 0);
  assert.ok(laneLabelAcross(LANE_LABEL.turn / 2) > 0.4 && laneLabelAcross(LANE_LABEL.turn / 2) < 0.6);
  for (let step = -40; step < 20; step++) assert.ok(laneLabelAcross(step * 0.05) >= laneLabelAcross((step + 1) * 0.05), 'it turns one way only');
  assert.equal(laneLabelSize(0), LANE_LABEL.size, 'the selected one larger');
  assert.equal(laneLabelSize(0.4), LANE_LABEL.size, 'also while it turns');
  assert.equal(laneLabelSize(-1), 1, 'the nearer one as large as the edge names');
  for (let step = -30; step < 10; step++) assert.ok(Math.abs(laneLabelSize(step * 0.05) - laneLabelSize((step + 1) * 0.05)) <= 0.05 * LANE_LABEL.size, 'it grows without a jump');
  const selected = laneLabelPlace(0);
  assert.deepEqual(selected, { row: LANE_LABEL.selected, align: 1 }, 'along its edge, the selected name would end behind the selected row');
  assert.ok(LANE_LABEL.selected <= -0.5, 'clear of the lifted case, which is under half a row thick (0.28 of 0.62)');
  // The column further from the lens: its name ends further back still, so the line of sight
  // to it passes behind the lifted case, not through it.
  const further = laneLabelPlace(1);
  assert.deepEqual(further, { row: LANE_LABEL.selected - LANE_LABEL.behind, align: 1 });
  assert.ok(further.row <= -1.5 && LANE_LABEL.behind >= 1.5);
  assert.deepEqual(laneLabelSpan(selected, 4), { from: LANE_LABEL.selected - 4, to: LANE_LABEL.selected });
  assert.deepEqual(laneLabelSpan(further, 4), { from: further.row - 4, to: further.row });
});

test('names fade two columns out, and toward the lens before the counter', () => {
  let shown = laneLabelShare(-2.5);
  for (let offset = -2.5 + 0.01; offset <= 2.5; offset += 0.01) {
    const share = laneLabelShare(offset);
    assert.ok(Math.abs(share - shown) <= 0.01 * 1.5 / Math.min(LANE_LABEL.fade, LANE_LABEL.nearFade) + 1e-9, `visibility jumps at ${offset}`);
    assert.ok(share >= 0 && share <= 1);
    shown = share;
  }
  assert.equal(laneLabelShare(LANE_LABEL.reach), 1, 'fully shown up to the reach');
  assert.equal(laneLabelShare(LANE_LABEL.reach + LANE_LABEL.fade), 0, 'gone a fade further');
  assert.equal(laneLabelShare(-1), 1, 'the nearer column is named');
  assert.ok(LANE_LABEL.nearReach >= 1 && LANE_LABEL.nearReach <= LANE_LABEL.reach);
  assert.equal(laneLabelShare(-LANE_LABEL.nearReach - LANE_LABEL.nearFade), 0, 'and toward the lens a name is gone before it reaches the counter');
  // At 16:9 a near name reaches the counter about a twentieth of a column beyond its place:
  // it is mostly faded by then (measured 2026-10-05: up to 65 % of it crossed the counter).
  assert.ok(LANE_LABEL.nearFade > 0 && LANE_LABEL.nearFade <= 0.15);
  assert.ok(laneLabelShare(-LANE_LABEL.nearReach - 0.07) < 0.25);
  assert.equal(laneLabelShare(-2), 0);
  assert.equal(laneLabelShare(2), 0);
});

test('the columns that can be named are exactly those with something to show', () => {
  for (const centre of [0, 2, 2.3, 2.5, 2.74, 2.76, -7.5, 40.999]) {
    const { first, last } = laneLabelRange(centre);
    for (let lane = Math.floor(centre) - 4; lane <= Math.ceil(centre) + 4; lane++) {
      const shown = laneLabelShare(lane - centre) > 0;
      if (shown) assert.ok(lane >= first && lane <= last, `lane ${lane} around ${centre} is in the range`);
    }
    assert.ok(last - first <= 3, 'at most four columns at once (three at rest)');
  }
  assert.deepEqual(laneLabelRange(2), { first: 1, last: 3 });
});

test('portrait: the columns under the title are not named, the others are', () => {
  assert.equal(laneLabelShare(-1, true), 0);
  assert.equal(laneLabelShare(-LANE_LABEL.fade, true), 0);
  assert.equal(laneLabelShare(0, true), 1);
  assert.equal(laneLabelShare(1, true), 1);
  assert.equal(laneLabelShare(-1, false), 1, 'landscape names it');
  const half = laneLabelShare(-LANE_LABEL.fade / 2, true);
  assert.ok(half > 0 && half < 1, 'and it fades in as its column becomes the selected one');
  // The navigation lies over the top right of the portrait picture, where the names leave past
  // the further column and the selected one turns: the further side fades sooner there, and the
  // selected name turns sooner; at rest nothing changes, and the landscape layouts keep theirs.
  assert.equal(laneLabelShare(LANE_LABEL.portraitReach, true), 1, 'the further column is named');
  assert.equal(laneLabelShare(LANE_LABEL.portraitReach + LANE_LABEL.fade, true), 0);
  assert.ok(LANE_LABEL.portraitReach >= 1 && LANE_LABEL.portraitReach < LANE_LABEL.reach);
  // Measured 2026-10-06 (600 x 900 to 1240 x 1200): a name past the further column reached the
  // navigation from 1.48 columns out, the selected one turning from 0.31 of a column on.
  assert.ok(laneLabelShare(1.48, true) * 0.92 < 0.2 && laneLabelAcross(0.31, true) < 0.2, 'faded where the navigation is');
  assert.ok(LANE_LABEL.portraitTurn > 0 && LANE_LABEL.portraitTurn < LANE_LABEL.turn);
  assert.equal(laneLabelAcross(0, true), 1);
  assert.equal(laneLabelAcross(LANE_LABEL.portraitTurn, true), 0);
  for (let step = 0; step < 40; step++) {
    const offset = step * 0.05;
    assert.ok(laneLabelAcross(offset, true) >= laneLabelAcross(offset + 0.05, true), 'it turns one way only');
    assert.ok(Math.abs(laneLabelShare(offset, true) - laneLabelShare(offset + 0.05, true)) <= 0.05 * 1.5 / LANE_LABEL.fade + 1e-9, 'without a jump');
    assert.ok(laneLabelAcross(offset, true) <= laneLabelAcross(offset), 'never later than in landscape');
  }
  assert.equal(laneLabelShare(LANE_LABEL.reach, false), 1, 'landscape keeps its reach');
  assert.equal(laneLabelAcross(LANE_LABEL.portraitTurn, false), laneLabelAcross(LANE_LABEL.portraitTurn), 'and its turn');
});

test('a column is counted as the stepper counts it', () => {
  assert.equal(laneLabelIndex(0), '01');
  assert.equal(laneLabelIndex(11), '12');
});

// The shelf at rest around the selected column (lane 0; -1 nearer the lens, 1 further), as the
// scene describes it to laneLabelRest (scene.ts laneLabelSlots): the camera at rest (SHELF_REST),
// the columns come toward the lens, the resting lift in the selected column.
const smoothstep = (v) => { const t = Math.min(1, Math.max(0, v)); return t * t * (3 - 2 * t); };
const restShelf = (ceiling = () => Infinity) => {
  const yaw = 59 * Math.PI / 180, el = 25 * Math.PI / 180;
  const eye = { x: -1.091 - Math.sin(yaw) * Math.cos(el) * 140, y: -0.045 + Math.sin(el) * 140, z: 0.481 + Math.cos(yaw) * Math.cos(el) * 140 };
  const ahead = (lane) => 1.8 * smoothstep(1 - lane);
  const depth = (row) => -2.17 + row * 0.62;
  const graze = 1 - LANE_LABEL.liftGraze / 1.035;
  return {
    eye, depth, width: 4.45, rowSpacing: 0.62, ahead,
    top: (lane, row) => -4.6 + settlingWave(row, 26.56) * columnStrength(lane, 0) + 1.85 + 3.35 / 2 + LANE_LABEL.rise,
    gap: (lane) => 5.2 - ahead(lane) + ahead(lane - 1) - 4.45 - LANE_LABEL.stand,
    lifted: (lane) => lane === 0 ? 1.035 * graze : 0,
    edge: (lane) => lane * 5.2 - ahead(lane) - 4.45 / 2,
    face: (row) => depth(row) + 0.28 / 2 + LANE_LABEL.faceGap,
    ceiling,
  };
};

test('at rest the names stand where they stood as writing in the scene', () => {
  const s = restShelf();
  for (const width of [0.3, 0.82, 1.41, 2.5]) {
    const rest = laneLabelRest(s, width);
    // The selected column's and the nearer one's: across their case LANE_LABEL.across rows in
    // front of the selected row, LANE_LABEL.inset in from the edge facing the lens, on the top
    // of that case, in front of its front face; the selected one LANE_LABEL.size as large.
    for (const [line, lane] of [[rest.selected, 0], [rest.nearer, -1]]) {
      const size = laneLabelSize(lane);
      assert.equal(line.size, size);
      near(line.start.x, s.edge(lane) + LANE_LABEL.inset, 'from the edge');
      near(line.start.y, s.top(lane, LANE_LABEL.across), 'on the case top');
      near(line.start.z, s.face(LANE_LABEL.across), 'in front of the case');
      near(line.end.x - line.start.x, width * size, 'as long as the name');
      assert.equal(line.end.y, line.start.y);
      assert.deepEqual(line.up, { x: 0, y: 1, z: 0 });
    }
    // The further column's: along its edge, ending LANE_LABEL.behind rows behind the selected
    // one's place, falling toward the lens, never rising.
    for (const [line, lane] of [[rest.further, 1], [rest.turning, 0]]) {
      const span = laneLabelSpan(laneLabelPlace(lane), width / 0.62);
      near(line.start.x, s.edge(lane) - LANE_LABEL.stand, 'beside its edge');
      near(line.end.x, line.start.x, 'along the edge');
      near(line.start.z, s.depth(span.from), 'from');
      near(line.end.z, s.depth(span.to), 'to its place');
      assert.ok(line.start.y >= line.end.y - 1e-12, 'never rising toward the lens');
      assert.ok(line.end.y >= laneLabelSeen(s, lane, line.end.x, span.to) - 1e-12, 'seen over the column in front');
      assert.equal(line.size, 1);
      near(Math.hypot(line.up.x, line.up.y, line.up.z), 1, 'the way up is a unit');
      near(line.up.y * (line.end.y - line.start.y) + line.up.z * (line.end.z - line.start.z), 0, 'square to the line', 1e-9);
    }
    // With no room above it the further name is level; with room, it falls as the nearer column's tops.
    const level = laneLabelRest(restShelf(() => -Infinity), width).further;
    assert.equal(level.start.y, Math.max(level.end.y, laneLabelSeen(s, 1, level.start.x, laneLabelSpan(laneLabelPlace(1), width / 0.62).from)));
  }

  // The further name stands where it stood before 2026-10-06 (and before 2026-10-05: five
  // places across the column in front, the lifted case a box 0.35 rows to either side of the
  // selected row at full height), for every share of the fall it keeps.
  const rest = 1.035;
  const old = (x, row) => {
    const y = s.top(1, row), z = s.depth(row), gap = s.gap(1);
    let need = y;
    for (let step = 0; step <= 4; step++) {
      const reach = (gap + step * 4.45 / 4) / Math.max(1e-6, x - s.eye.x);
      const at = row + reach * (s.eye.z - z) / 0.62;
      need = Math.max(need, s.top(0, at) + (Math.abs(at) < 0.35 ? rest : 0) - reach * (s.eye.y - y) + LANE_LABEL.clear);
    }
    return need;
  };
  const fall = (length) => (s.top(-1, LANE_LABEL.front) - s.top(-1, LANE_LABEL.front + length)) / (length * 0.62);
  for (const units of [0.3, 0.5, 0.82, 1.0, 1.41, 2.0, 2.5]) {
    const length = units / 0.62, span = laneLabelSpan(laneLabelPlace(1), length), x = s.edge(1) - LANE_LABEL.stand;
    const run = (span.to - span.from) * 0.62, slope = fall(length);
    const low = Math.max(old(x, span.to), old(x, span.from) - slope * run);
    for (const keep of [0, 0.5, 1]) {
      // A ceiling that leaves exactly this share of the fall.
      const ceiling = keep === 0 ? () => -Infinity : keep === 1 ? () => Infinity : () => low + keep * slope * run + LANE_LABEL_TEXT.height;
      const line = laneLabelRest(restShelf(ceiling), units).further;
      near(line.end.y, low, `a ${units}-unit name's far end`, 0.002);
      near(line.start.y, Math.max(low, old(x, span.from), low + keep * slope * run), `its near end keeping ${keep} of the fall`, 0.003);
    }
  }
});

test('a slot is the place at rest as the screen shows it: an anchor, the baseline\'s angle, the size', () => {
  // A plain projection: world x to the right and up, z to the right and down, y up.
  const project = (x, y, z) => ({ x: 100 * x + 80 * z, y: -60 * x - 90 * y + 20 * z });
  const line = { start: { x: 1, y: 2, z: 3 }, end: { x: 3, y: 2, z: 3 }, up: { x: 0, y: 1, z: 0 }, size: 1.5 };
  const start = laneLabelSlot(line, 0, project), end = laneLabelSlot(line, 1, project);
  const m = LANE_LABEL_TEXT.margin * 1.5, b = LANE_LABEL_TEXT.baseline * 1.5;
  const expect = (x, y, z) => project(x, y, z);
  near(start.x, expect(1 + m, 2 + b, 3).x, 'the writing starts a margin in', 1e-9);
  near(start.y, expect(1 + m, 2 + b, 3).y, 'on its baseline', 1e-9);
  near(end.x, expect(3 - m, 2 + b, 3).x, 'or ends a margin before the end', 1e-9);
  near(start.angle, Math.atan2(-60, 100), 'along the line on the screen', 1e-12);
  // The font size: the name's height across the baseline (the way up is not square to it on screen).
  const along = [100, -60], up = [0, -90], across = Math.abs(along[0] * up[1] - along[1] * up[0]) / Math.hypot(...along);
  near(start.font, LANE_LABEL_TEXT.name * 1.5 * across, 'the name\'s size on the screen', 1e-9);
  near(end.font, start.font, 'the same at either end of a plain projection', 1e-9);
});

const slotsFixture = {
  nearer: { x: 150, y: 680, angle: -0.6, font: 18 },
  selected: { x: 460, y: 330, angle: -0.59, font: 27 },
  turning: { x: 380, y: 260, angle: 0.35, font: 19.2 },
  further: { x: 490, y: 120, angle: 0.33, font: 19.5 },
};

test('between slots a name moves in a straight line with the shelf\'s sideways track, and only with it', () => {
  const s = slotsFixture;
  // At rest each role is exactly at its slot.
  const at = (offset) => laneLabelPose(offset, s);
  for (const [offset, kind, slot] of [[-1, 'across', s.nearer], [0, 'across', s.selected], [0, 'along', s.turning], [1, 'along', s.further]]) {
    const pose = at(offset)[kind];
    for (const key of ['x', 'y', 'angle', 'font']) near(pose[key], slot[key], `${kind} at ${offset}: ${key}`);
  }
  assert.equal(at(0).across.align, 0, 'across: anchored where the writing starts');
  assert.equal(at(1).along.align, 1, 'along: anchored where it ends');
  // Each kind of name lies on one straight line through its two slots, beyond them too, and
  // moves along it at a constant rate per column (no jump, no reversal, nothing else moving it).
  for (const [kind, from, to] of [['across', s.nearer, s.selected], ['along', s.turning, s.further]]) {
    const dx = to.x - from.x, dy = to.y - from.y;
    let previous = at(-2.5)[kind];
    for (let offset = -2.5 + 0.01; offset <= 2.5 + 1e-9; offset += 0.01) {
      const pose = at(offset)[kind];
      near(pose.x - previous.x, dx * 0.01, `${kind} x step at ${offset.toFixed(2)}`, 1e-6);
      near(pose.y - previous.y, dy * 0.01, `${kind} y step at ${offset.toFixed(2)}`, 1e-6);
      near((pose.x - from.x) * dy - (pose.y - from.y) * dx, 0, `${kind} on its line at ${offset.toFixed(2)}`, 1e-6);
      assert.ok(Math.abs(pose.angle - previous.angle) <= Math.abs(to.angle - from.angle) * 0.01 + 1e-9, 'the angle turns without a jump');
      assert.ok(Math.abs(pose.font - previous.font) <= Math.abs(to.font - from.font) * 0.05 + 1e-9, 'the size changes without a jump');
      previous = pose;
    }
  }
  // The angle and the size stay those of the last slot beyond it; the selected name keeps its size while it turns.
  near(at(-1.08).across.angle, s.nearer.angle, 'nearer angle beyond');
  near(at(0.4).across.font, s.selected.font, 'selected size while turning');
  near(at(1.5).along.font, s.further.font, 'further size beyond');
  // The selected name turns into the further one's as a cross-fade, and nothing else shows twice.
  for (let offset = -2; offset <= 2; offset += 0.05) {
    const pose = at(offset), portrait = laneLabelPose(offset, s, true);
    near(pose.across.share + pose.along.share, 1, 'cross-fade');
    near(pose.across.share, laneLabelAcross(offset), 'as the scene turned it');
    near(portrait.across.share + portrait.along.share, 1, 'cross-fade in portrait');
    near(portrait.across.share, laneLabelAcross(offset, true), 'turning sooner in portrait');
    for (const kind of ['across', 'along']) for (const key of ['x', 'y', 'angle', 'font', 'align'])
      assert.equal(portrait[kind][key], pose[kind][key], 'the same places in portrait, only the shares differ');
  }
});

test('a switch, a quick double press and steps along a column, as the shelf\'s track springs', () => {
  // The track is the column camera's spring (scene.ts: damp at 3.7 per second); a name's pose is
  // a function of its column's offset from it alone. Follow every name through a switch and a
  // double press (the second 300 ms later): straight, monotonic, no vertical reversal; then
  // steps along the column (the track stands still): not a hundredth of a pixel.
  const s = slotsFixture, dt = 1 / 60;
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
  for (const presses of [[{ at: 0, by: 1 }], [{ at: 0, by: -1 }], [{ at: 0, by: 1 }, { at: 0.3, by: 1 }]]) {
    const frames = run(presses);
    for (const lane of [0, 1, 2, 3, 4, 5]) for (const kind of ['across', 'along']) {
      let previousY, previousStep = 0, reversals = 0;
      for (const centre of frames) {
        const pose = laneLabelPose(lane - centre, s)[kind];
        if (previousY !== undefined) {
          const step = pose.y - previousY;
          if (Math.abs(step) > 1e-6) {
            if (previousStep && Math.sign(step) !== Math.sign(previousStep)) reversals++;
            previousStep = step;
          }
        }
        previousY = pose.y;
      }
      assert.equal(reversals, 0, `lane ${lane} ${kind}: vertical reversals with ${JSON.stringify(presses)}`);
    }
  }
  // Up / down: the track does not move, nor does any name.
  const before = laneLabelPose(1 - 2, s), after = laneLabelPose(1 - 2, s);
  assert.deepEqual(after, before);
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
  // Nothing that moves the shelf's cases, the camera or the selection's row reaches a name.
  assert.doesNotMatch(place, /field\(|idleWave|pulses|musicSelectionWave|this\.shoulder|this\.rail|this\.lift|this\.outgoing|this\.selectedCell|this\.camera\b|laneFocus|playHop|laneLabelSeen|columnForward/,
    'no wave, lift, row, live camera or line of sight per frame');
  assert.match(place, /const pose = laneLabelPose\(offset, this\.laneLabelSlots\(writing\.width\), textBelow\);/);
  assert.match(place, /const offset = lane - centre;/);
  // The spring's endless tail does not keep nudging them: near a column they stand at the slots.
  assert.match(place, /const nearest = Math\.round\(centre\);\s*if \(Math\.abs\(centre - nearest\) < 1e-5\) centre = nearest;/);
  assert.match(place, /isPortraitViewport\(/, 'the portrait rule comes from viewport-layout.ts');
  assert.doesNotMatch(place, /clientWidth\s*[<>]|innerWidth/, 'no screen-width threshold of its own');
  // A lone column repeats in every lane and is named once; the neighbours a little lighter.
  assert.match(place, /const lone = archiveColumns\.length === 1 \? Math\.max\(0, 1 - 2 \* Math\.abs\(offset\)\) : 1;/);
  assert.match(place, /const share = laneLabelShare\(offset, textBelow\) \* shown \* lone \* weight;/);
  // The rebased shelf keeps a lane's names.
  assert.match(place, /const key = lane \+ this\.coordinateOrigin\.lane;/);
  // The slots: worked out again only when the window, its layout or the fonts change; seen with
  // the shelf's camera at rest, never the live one.
  assert.match(place, /const width = this\.container\.clientWidth, height = this\.container\.clientHeight;\s*this\.syncLaneSlotView\(width, height\);/);
  const view = body(scene, '  private syncLaneSlotView(', '\n  }\n');
  assert.match(view, /const view = `\$\{width\}x\$\{height\}:\$\{compact\}:\$\{this\.laneNameLayer\?\.fonts \?\? 0\}`;\s*if \(view === this\.laneSlotView\) return;\s*this\.laneSlotView = view;\s*this\.laneSlots\.clear\(\);\s*this\.shelfRestCamera\(this\.restCamera, compact\);/);
  const slots = body(scene, '  private laneLabelSlots(', '  private shelfRestCamera(');
  assert.match(slots, /let slots = this\.laneSlots\.get\(width\);\s*if \(slots\) return slots;/, 'once per length of name');
  assert.match(slots, /const camera = this\.restCamera, probe = this\.restProbe;/);
  assert.doesNotMatch(slots, /this\.camera\b|this\.laneFocus|this\.lift|this\.columnCamera/);
  // The shelf at rest: the selected column (lane 0) and those in front come toward the lens, the
  // resting lift in the selected column, the columns' heights around it.
  assert.match(slots, /const ahead = \(lane: number\) => MUSIC_COLUMN_FORWARD \* THREE\.MathUtils\.smoothstep\(1 - lane, 0, 1\);/);
  assert.match(slots, /top: \(lane, row\) => -4\.6 \+ settlingWave\(row, 26\.56\) \* columnStrength\(lane, 0\) \+ caseTop \+ LANE_LABEL\.rise,/);
  assert.match(slots, /lifted: \(lane\) => lane === 0 \? MUSIC_PREVIEW_LIFT \* graze : 0,/);
  assert.match(slots, /ceiling: \(x, z\) => this\.ceiling\(x, z, LANE_LABEL\.margin, camera\),/);
  assert.match(slots, /turning: laneLabelSlot\(rest\.turning, 1, project\), further: laneLabelSlot\(rest\.further, 1, project\),/);
  // The camera at rest is where update() takes the music camera on the shelf.
  const rest = /const SHELF_REST = \{\s*yaw: 89 - 22 - 8,\s*elevation: 3 \+ 40 - 8 - 16 \+ 6,\s*span: 7\.33,\s*distance: 140,\s*aim: \[-1\.091, -0\.045, 0\.481\],\s*\} as const;/;
  assert.match(scene, rest);
  assert.match(scene, /const yaw = THREE\.MathUtils\.degToRad\(89 - 22 \* orbit - 8 \* settle\) \+ navigationOrbit\.yaw;/);
  assert.match(scene, /3 \+ 40 \* ease\(\(shot - 21\.96\) \/ 0\.22\) - 8 \* orbit - 16 \* settle \+\s*\(musicIntro \? 6 \* introSettle : musicLibrary && !cinematic \? 6 : 0\),/);
  assert.match(scene, /THREE\.MathUtils\.lerp\(10\.8, 10\.3, orbit\),\s*7\.33,\s*settle,/);
  assert.match(scene, /THREE\.MathUtils\.lerp\(28 \+ 7 \* orbit, 140, settle\),/);
  assert.match(scene, /-1\.091,\s*THREE\.MathUtils\.lerp\(-2\.55 \+ 0\.4 \* orbit, -0\.045, settle\),\s*THREE\.MathUtils\.lerp\(2\.48, 0\.481, settle\),/);
  const camera = body(scene, '  private shelfRestCamera(', '  /** The highest a point');
  assert.match(camera, /const framing = archiveFraming\(width, height, SHELF_REST\.span, 0, compact\);/);
  assert.match(camera, /aim\.set\(0, -4\.6 \+ settlingWave\(0, 26\.56\) \+ 0\.4 \+ 1\.85, -2\.17\)\.addScaledVector\(up, \(framing\.previewY - 0\.5\) \* framing\.span\);/, 'the portrait framing, as update() has it');
  assert.match(scene, /previewAim\.addScaledVector\(up, \(framing\.previewY - 0\.5\) \* height \/ pixelScale\);/);
  assert.doesNotMatch(camera, /pointer/, 'no pointer parallax');
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

test('a name over the picture is text only, out of the pointer\'s way and of assistive technology', () => {
  const names = read('src/lane-names.ts');
  const css = read('src/music-shelf.css');
  // The layer: in the scene's container (above its canvas, under the rest of the overlay), hidden from assistive technology.
  assert.match(names, /this\.element\.className = "lane-names";\s*this\.element\.setAttribute\("aria-hidden", "true"\);\s*host\.append\(this\.element\);/);
  assert.match(read('src/scene.ts'), /const layer = new LaneNameLayer\(this\.container\);/);
  // A name: its number and its name, nothing else (no image, drawing or mark).
  assert.match(names, /this\.element\.append\(this\.index, this\.text\);/);
  assert.doesNotMatch(names, /createElementNS|"svg"|"canvas"\)\.getContext\("2d"\)!\.fill|innerHTML/);
  assert.match(names, /this\.index\.textContent = writing\.index;\s*this\.text\.textContent = writing\.name;/, 'text, never markup');
  // Placed by a transform only: translate, rotate and scale (laid out once, at one size).
  assert.match(names, /const scale = pose\.font \/ LAYOUT_SIZE;\s*const transform = `translate\(\$\{pose\.x\.toFixed\(2\)\}px, \$\{pose\.y\.toFixed\(2\)\}px\) rotate\(\$\{pose\.angle\.toFixed\(5\)\}rad\) ` \+\s*`scale\(\$\{scale\.toFixed\(5\)\}\) translate\(\$\{-100 \* pose\.align\}%, \$\{\(-baseline\)\.toFixed\(3\)\}px\)`;/);
  // Laid out once at one size, the baseline measured where the layout puts it.
  assert.match(names, /this\.element\.style\.fontSize = `\$\{LAYOUT_SIZE\}px`;/);
  assert.match(names, /mark\.style\.cssText = "display: inline-block; width: 0; height: 0; vertical-align: baseline";/);
  assert.match(names, /if \(transform !== this\.shown\.transform\) style\.transform = this\.shown\.transform = transform;/, 'a name at rest writes nothing');
  // Measured as the scene measured its writing, so a name along an edge ends where it did.
  assert.match(names, /c\.font = `600 \$\{unit\(LANE_LABEL_TEXT\.name\)\}px \$\{FAMILY\}`;/);
  const rules = [...css.matchAll(/([^{}]*\.lane-name[^{}]*)\{([^}]*)\}/g)];
  assert.ok(rules.length >= 4, 'the layer, the name, the number and the playing column\'s number');
  for (const [, selector, declarations] of rules) {
    assert.doesNotMatch(declarations, /background|border|outline|box-shadow|padding|filter|z-index/, `${selector.trim()}: text only, no plate, frame or band`);
  }
  const layer = rules.find(([, selector]) => /\.lane-names\s*$/.test(selector.trim()))?.[2] ?? '';
  assert.match(layer, /pointer-events: none;/);
  const name = rules.find(([, selector]) => /\.lane-name\s*$/.test(selector.trim()))?.[2] ?? '';
  assert.match(name, /color: var\(--ink\);/);
  assert.match(name, /font-weight: 600;/);
  assert.match(name, /line-height: 1;/);
  // The thin rim: soft, in the ground colour, at most three screen pixels whatever a name's scale.
  const rim = /text-shadow:([^;]+);/.exec(name)?.[1] ?? '';
  assert.ok(rim, 'a rim');
  const blurs = [...rim.matchAll(/0 0 calc\(([\d.]+)px \* var\(--lane-unscale, 1\)\) var\(--lane-rim\)/g)].map((m) => Number(m[1]));
  assert.equal(blurs.length, 2);
  assert.ok(blurs.every((blur) => blur > 0 && blur <= 3), `the rim is thin (${blurs} px)`);
  assert.match(names, /const unscale = \(1 \/ Math\.max\(scale, 1e-3\)\)\.toFixed\(3\)/, 'undoing the name\'s scale');
  assert.match(name, /--lane-rim: color-mix\(in srgb, var\(--page-bg\) 70%, transparent\);/);
  assert.match(css, /\.lane-name-index \{[^}]*color: var\(--muted\);/);
  assert.match(css, /\.lane-name\[data-live="true"\] \.lane-name-index \{\s*color: var\(--state\);/, 'the playing queue\'s column by its number\'s colour');
  assert.match(read('src/music.css'), /font-family: MiSans, system-ui, sans-serif;/);
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

test('the rounded maximum the line of sight uses has no corner and no jump', () => {
  assert.equal(laneLabelSoftMax(1, 0.5, 0.04), 1);
  assert.equal(laneLabelSoftMax(0.2, 0.7, 0.04), 0.7);
  for (let d = -0.06; d <= 0.06; d += 0.0005) {
    const here = laneLabelSoftMax(d, 0, 0.04), next = laneLabelSoftMax(d + 0.0005, 0, 0.04);
    assert.ok(here >= Math.max(d, 0) - 1e-12 && here <= Math.max(d, 0) + 0.04 / 4 + 1e-12);
    assert.ok(Math.abs(next - here) <= 0.0005 + 1e-9, 'no jump');
    const slope = (next - here) / 0.0005, after = (laneLabelSoftMax(d + 0.001, 0, 0.04) - next) / 0.0005;
    assert.ok(Math.abs(after - slope) < 0.02, `no corner at ${d.toFixed(4)}`);
  }
});
