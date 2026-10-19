import test from 'node:test';
import assert from 'node:assert/strict';
import { FramePacing } from '../src/frame-pacing.ts';
import { FrameCap } from '../src/frame-cap.ts';

// Drive the pacer like a host: one call per display frame, drawing what it asks.
function run(pacing, { hz, seconds, resting = true, inputs = () => [0], start = 0 }) {
  const frame = 1 / hz;
  let updates = 0, draws = 0;
  for (let i = 0; i < Math.round(seconds * hz); i++) {
    const time = start + i * frame;
    if (!pacing.due(time)) continue;
    updates++;
    pacing.begin();
    pacing.values(inputs(time));
    const draw = pacing.needsDraw();
    if (draw) draws++;
    pacing.finish(time, draw, resting);
  }
  return { updates, draws };
}

test('a moving scene that is not resting updates and draws on every display frame', () => {
  const pacing = new FramePacing();
  const { updates, draws } = run(pacing, { hz: 240, seconds: 1, resting: false, inputs: t => [t] });
  assert.equal(updates, 240);
  assert.equal(draws, 240);
});

test('the slow idle drift keeps about 60 Hz, never below, on faster displays', () => {
  for (const [hz, expected] of [[240, 60], [144, 72], [165, 82.5], [120, 60], [75, 75], [60, 60]]) {
    const pacing = new FramePacing();
    run(pacing, { hz, seconds: 0.2, resting: false, inputs: t => [t] });
    const { updates, draws } = run(pacing, { hz, seconds: 2, start: 0.2, inputs: t => [t] });
    assert.ok(Math.abs(updates / 2 - expected) <= 1.5, `${hz} Hz display: ${updates / 2} updates/s, expected ~${expected}`);
    assert.equal(draws, updates, 'every update of a moving picture draws');
  }
});

test('an unchanged picture is not drawn again, but keeps checking at about 60 Hz', () => {
  const pacing = new FramePacing();
  run(pacing, { hz: 240, seconds: 0.1, resting: false });
  const { updates, draws } = run(pacing, { hz: 240, seconds: 2, start: 0.1, resting: false });
  assert.equal(draws, 0, 'equal inputs: the canvas keeps the last drawn frame');
  assert.ok(Math.abs(updates / 2 - 60) <= 1.5, `${updates / 2} checks/s`);
});

test('changes below the tolerance do not draw, but their sum against the drawn frame does', () => {
  const pacing = new FramePacing();
  const at = value => { pacing.begin(); pacing.value(value); return pacing.needsDraw(); };
  assert.ok(at(0)); pacing.finish(0, true, false);
  assert.equal(at(5e-7), false, 'well below a pixel');
  pacing.finish(0.004, false, false);
  assert.equal(at(1.2e-6), true, 'compared with the drawn frame, not the previous update');
});

test('a mutator forces one draw; input wakes the next frame without forcing a draw', () => {
  const pacing = new FramePacing();
  let woken = 0;
  pacing.onWake = () => woken++;
  run(pacing, { hz: 240, seconds: 0.5 });
  // Step to the frame that updates, then to the one after it.
  let time = 0.5;
  while (!pacing.due(time)) time += 1 / 240;
  pacing.begin(); pacing.value(0); pacing.finish(time, pacing.needsDraw(), true);
  time += 1 / 240;
  assert.equal(pacing.due(time), false, 'resting: waits for its slot');
  pacing.wake();
  assert.equal(pacing.due(time + 1 / 240), true, 'input: updates at once');
  pacing.begin(); pacing.value(0);
  assert.equal(pacing.needsDraw(), false, 'nothing moved: nothing to draw');
  pacing.finish(time + 1 / 240, false, true);
  pacing.invalidate();
  assert.equal(pacing.due(time + 2 / 240), true);
  pacing.begin(); pacing.value(0);
  assert.equal(pacing.needsDraw(), true, 'theme, quality or size changed outside the description');
  assert.equal(woken, 2, 'a waiting host loop is resumed both times');
});

test('a host may wait until just after the slot, and waiting does not skew the display rate', () => {
  const pacing = new FramePacing();
  run(pacing, { hz: 240, seconds: 0.5, resting: false, inputs: t => [t] });
  pacing.begin(); pacing.value(1); pacing.finish(0.5, pacing.needsDraw(), true);
  const at = pacing.nextFrameAt();
  assert.ok(Math.abs(at - (0.5 + 4.25 / 240)) < 1e-9, 'requested a quarter frame after the fourth display frame began');
  pacing.waited();
  // The host's frame after a wait is stamped with that display frame.
  assert.equal(pacing.due(0.5 + 4 / 240), true);
  pacing.begin(); pacing.value(1); pacing.finish(0.5 + 4 / 240, pacing.needsDraw(), true);
  assert.ok(Math.abs(pacing.nextFrameAt() - (0.5 + 8.25 / 240)) < 1e-9, 'the 16.7 ms gap was not taken as the refresh interval');
  const sixty = new FramePacing();
  run(sixty, { hz: 60, seconds: 0.5 });
  assert.equal(sixty.nextFrameAt(), 0, 'a 60 Hz display needs every frame: no wait');
});

test('a pause, a hidden page or an open viewer redraws on return', () => {
  const pacing = new FramePacing();
  run(pacing, { hz: 240, seconds: 0.5 });
  assert.equal(pacing.due(2), true);
  pacing.begin(); pacing.value(0);
  assert.equal(pacing.needsDraw(), true);
});

// 帧率上限 (frame-cap.ts), with the music page's frame loop (music-app.ts frame() and
// waitForFrame()) driven against a display: one animation frame per display frame; a frame asked
// for from a timer between two display frames runs at once, stamped with the earlier one (as
// WebView2 does: stamped), or, in an engine that does not, at the next display frame. The scene
// rests after `motion` seconds; its slow idle drift changes the picture on every update.
function loop({ hz, cap = 0, motion = 1, seconds = 3, stamped = true, work = 0.0015 }) {
  const frame = 1 / hz, pacing = new FramePacing(), limit = new FrameCap();
  limit.set(cap);
  const after = (t) => (Math.floor(t / frame + 1e-9) + 1) * frame;
  const atOrBefore = (t) => Math.floor(t / frame + 1e-9) * frame;
  const windows = { motion: [0.2, motion], rest: [motion + 0.3, seconds] };
  const counts = { motion: { wakes: 0, draws: 0 }, rest: { wakes: 0, draws: 0 } };
  const count = (stamp, key) => {
    for (const [name, [from, to]] of Object.entries(windows)) if (stamp >= from && stamp < to) counts[name][key]++;
  };
  let next = [0, 0];
  // waitForFrame(at): a timer, or the next display frame when that is less than a display frame away.
  const waitFor = (atMs, now, stamp) => {
    const at = atMs / 1000;
    if (at - now > Math.max(0.001, pacing.displayFrame())) {
      pacing.waited();
      next = stamped ? [at, atOrBefore(at)] : [after(at), after(at)];
    } else next = [after(stamp), after(stamp)];
  };
  while (next[0] < seconds) {
    const [now, stamp] = next;
    count(stamp, 'wakes');
    if (!limit.admit(stamp * 1000)) {
      pacing.skip(stamp);
      waitFor(limit.next, now, stamp);
      continue;
    }
    if (pacing.due(stamp)) {
      pacing.begin();
      pacing.value(stamp);
      const draw = pacing.needsDraw();
      if (draw) count(stamp, 'draws');
      pacing.finish(stamp, draw, stamp >= motion);
    }
    waitFor(Math.max(pacing.nextFrameAt() * 1000, limit.next), now + work, stamp);
  }
  const rate = (name, key) => counts[name][key] / (windows[name][1] - windows[name][0]);
  return {
    moving: rate('motion', 'draws'), movingWakes: rate('motion', 'wakes'),
    resting: rate('rest', 'draws'), restingWakes: rate('rest', 'wakes'),
    displayFrame: pacing.displayFrame(),
  };
}

test('帧率上限: runs average no more than the cap, never closer than half an interval, and do not catch up', () => {
  const limit = new FrameCap();
  limit.set(90);
  const runs = [];
  for (let i = 0; i < 240; i++) if (limit.admit(i * 1000 / 240)) runs.push(i * 1000 / 240);
  assert.ok(Math.abs(runs.length - 90) <= 1, `${runs.length} runs in a second on 240 Hz`);
  const gaps = runs.slice(1).map((t, i) => t - runs[i]);
  assert.ok(Math.min(...gaps) >= 1000 / 90 / 2 - 1, 'no two runs closer than half an interval');
  assert.deepEqual([...new Set(gaps.map((gap) => Math.round(gap / (1000 / 240))))].sort(), [2, 3], 'alternates between two and three display frames');
  // After a stall of 200 ms: one run, then the cap's pace again (no burst to catch up).
  const after = [];
  for (let t = 1200; t < 1300; t += 1000 / 240) if (limit.admit(t)) after.push(t);
  assert.ok(after[1] - after[0] >= 1000 / 90 / 2 - 1 && after.length <= 10, after.map((t) => (t - 1200).toFixed(1)).join(' '));
  limit.set(0);
  assert.equal(limit.admit(1300.1), true);
  assert.equal(limit.next, 0, 'no cap: no time to wait for');
});

test('帧率上限 against the display: moving at most the cap, resting never more often than without it', () => {
  for (const hz of [240, 165, 144, 120, 60]) {
    const free = loop({ hz });
    for (const cap of [144, 120, 90, 60, 30]) {
      const capped = loop({ hz, cap });
      const label = `${cap} on ${hz} Hz: moving ${capped.moving.toFixed(1)}/s (${capped.movingWakes.toFixed(1)} wakes), resting ${capped.resting.toFixed(1)}/s (${capped.restingWakes.toFixed(1)} wakes); no cap ${free.moving.toFixed(1)}, ${free.resting.toFixed(1)}`;
      assert.ok(capped.moving <= Math.min(cap, hz) * 1.02 + 1, label);
      if (cap < hz) assert.ok(capped.moving >= cap * 0.85, label);
      // The major finding of the review: 90 on 240 Hz rested at 90 a second, against 60 without a cap.
      assert.ok(capped.resting <= Math.min(free.resting, cap) + 1, label);
      // A frame held back only measures the display: the rest cadence still knows the display's frame.
      assert.ok(Math.abs(capped.displayFrame - 1 / hz) < 1e-6, `${label}: display frame ${(capped.displayFrame * 1000).toFixed(2)} ms`);
      // The loop does not wake on display frames it then throws away: at most twice per run, never
      // more often than without the cap.
      assert.ok(capped.movingWakes <= Math.max(2 * capped.moving, 1) + 1 && capped.movingWakes <= free.movingWakes + 1, label);
      assert.ok(capped.restingWakes <= Math.max(2 * capped.resting, free.restingWakes) + 1, label);
    }
  }
});

test('帧率上限 in an engine whose frames asked for between display frames wait for the next one', () => {
  for (const hz of [240, 144, 60]) {
    const free = loop({ hz, stamped: false });
    for (const cap of [144, 120, 90, 60, 30]) {
      const capped = loop({ hz, cap, stamped: false });
      const label = `${cap} on ${hz} Hz: moving ${capped.moving.toFixed(1)}/s, resting ${capped.resting.toFixed(1)}/s; no cap ${free.resting.toFixed(1)}`;
      assert.ok(capped.moving <= Math.min(cap, hz) * 1.02 + 1, label);
      assert.ok(capped.resting <= Math.min(free.resting, cap) + 1, label);
    }
  }
});
