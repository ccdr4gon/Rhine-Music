import test from 'node:test';
import assert from 'node:assert/strict';
import { FramePacing } from '../src/frame-pacing.ts';

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
