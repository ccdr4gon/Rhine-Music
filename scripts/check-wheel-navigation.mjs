import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WheelNavigation, wheelGain,
  WHEEL_COMMIT_INTERVAL_MS, WHEEL_FAST_RATE, WHEEL_MAX_EVENT_ROWS, WHEEL_MAX_GAIN,
  WHEEL_RELEASE_MS, WHEEL_REMAINDER_MS, WHEEL_SLOW_RATE,
} from '../src/wheel-navigation.ts';

const PAGE = 900;

// Evenly spaced notches of one wheel: [{ time, deltaY, mode }].
function notches(count, perSecond, { start = 0, deltaY = 100, mode = 0 } = {}) {
  return Array.from({ length: count }, (_, i) => ({ time: start + i * 1000 / perSecond, deltaY, mode }));
}

// Drive the accumulator like the app: events arrive between frames, one take() per display frame.
function run(events, { hz = 60, until, immediate = false, wheel = new WheelNavigation() } = {}) {
  const frame = 1000 / hz;
  const last = events.length ? events[events.length - 1].time : 0;
  const end = until ?? last + 2000;
  const commits = [];
  let next = 0;
  let activeUntil = -1;
  for (let time = events.length ? events[0].time : 0; time <= end; time += frame) {
    while (next < events.length && events[next].time <= time) {
      const event = events[next++];
      wheel.push(event.deltaY, event.mode ?? 0, event.time, PAGE);
    }
    const rows = wheel.take(time, immediate);
    assert.ok(Number.isInteger(rows), `take() returned ${rows}`);
    if (rows) commits.push({ time, rows });
    if (wheel.active) activeUntil = time;
  }
  const total = commits.reduce((sum, commit) => sum + commit.rows, 0);
  return { commits, total, wheel, last, activeUntil };
}

function mostCommitsPerSecond(commits) {
  let most = 0;
  for (let i = 0; i < commits.length; i++) {
    let count = 0;
    for (let j = i; j < commits.length && commits[j].time < commits[i].time + 1000; j++) count++;
    most = Math.max(most, count);
  }
  return most;
}

test('pixels count as they are, lines x 40, pages x the viewport height', () => {
  const rows = (deltaY, mode, pageHeight = PAGE) => {
    const wheel = new WheelNavigation();
    wheel.push(deltaY, mode, 0, pageHeight);
    return wheel.take(0, true);
  };
  assert.equal(rows(100, 0), 1);
  assert.equal(rows(200, 0), 2);
  assert.equal(rows(5, 1), 2, '5 lines = 200 px');
  assert.equal(rows(-2.5, 1), -1, '2.5 lines = 100 px');
  assert.equal(rows(1, 2, 200), 2, 'one page of a 200 px viewport');
  assert.equal(rows(1, 2, NaN), WHEEL_MAX_EVENT_ROWS, 'an unusable page height still scrolls');
});

test('zero and non-finite deltas are ignored', () => {
  const wheel = new WheelNavigation();
  for (const deltaY of [0, NaN, Infinity, -Infinity]) wheel.push(deltaY, 0, 0, PAGE);
  wheel.push(100, 0, NaN, PAGE);
  assert.equal(wheel.active, false);
  assert.equal(wheel.take(0), 0);
});

test('a single huge event moves a few rows at most', () => {
  for (const [deltaY, mode] of [[1e9, 0], [-50000, 0], [400, 1], [30, 2]]) {
    const { total } = run([{ time: 0, deltaY, mode }]);
    assert.equal(total, Math.sign(deltaY) * WHEEL_MAX_EVENT_ROWS, `${deltaY} in mode ${mode}`);
  }
});

test('a notch after idle is released by the very next take', () => {
  const wheel = new WheelNavigation();
  wheel.push(100, 0, 1000, PAGE);
  assert.equal(wheel.take(1000), 1);
  assert.equal(wheel.active, false);
  assert.equal(wheel.take(1016), 0);
  wheel.push(-100, 0, 5000, PAGE);
  assert.equal(wheel.take(5003), -1);
});

test('slow deliberate notches are exactly one row each', () => {
  for (const perSecond of [1, 2, 3, 4, 5]) {
    for (const deltaY of [100, -100]) {
      const { commits, total } = run(notches(12, perSecond, { deltaY }));
      assert.equal(total, 12 * Math.sign(deltaY), `${perSecond} notches/s`);
      assert.equal(commits.length, 12, 'one commit per notch');
      assert.ok(commits.every(commit => Math.abs(commit.rows) === 1));
    }
  }
});

test('the gain is 1 up to the slow rate, continuous, monotonic and capped', () => {
  assert.equal(wheelGain(0), 1);
  assert.equal(wheelGain(WHEEL_SLOW_RATE), 1);
  assert.equal(wheelGain(WHEEL_FAST_RATE), WHEEL_MAX_GAIN);
  assert.equal(wheelGain(1e6), WHEEL_MAX_GAIN);
  assert.ok(WHEEL_MAX_GAIN >= 4 && WHEEL_MAX_GAIN <= 5);
  let previous = 1;
  for (let rate = 0; rate <= WHEEL_FAST_RATE + 5; rate += 0.05) {
    const gain = wheelGain(rate);
    assert.ok(gain >= previous, `gain falls at ${rate} rows/s`);
    assert.ok(gain - previous < 0.02, `gain jumps at ${rate} rows/s`);
    previous = gain;
  }
});

test('spinning the wheel fast covers far more rows than the same notches made slowly', () => {
  const slow = run(notches(25, 4)).total;
  const fast = run(notches(25, 25)).total;
  assert.equal(slow, 25);
  assert.ok(fast >= 50, `25 notches in one second moved ${fast} rows`);
  assert.ok(fast <= 25 * WHEEL_MAX_GAIN);
  assert.equal(run(notches(25, 25, { deltaY: -100 })).total, -fast, 'the same distance upwards');
});

test('rows per notch never fall as the notch rate rises, without a cliff', () => {
  let previous = 0;
  for (let perSecond = 1; perSecond <= 60; perSecond += 0.5) {
    const wheel = new WheelNavigation();
    let total = 0;
    // Take after every push so slow sequences are not dropped as stale, then drain.
    for (const event of notches(40, perSecond)) {
      wheel.push(event.deltaY, 0, event.time, PAGE);
      total += wheel.take(event.time);
    }
    for (let time = 39000 / perSecond; wheel.active; time += 10) total += wheel.take(time);
    assert.ok(total >= previous, `${perSecond} notches/s moved ${total} rows, slower input moved ${previous}`);
    if (previous) assert.ok(total - previous <= 12, `cliff at ${perSecond} notches/s: ${previous} -> ${total}`);
    previous = total;
  }
  assert.ok(previous >= 40 * (WHEEL_MAX_GAIN - 0.5), 'a very fast wheel reaches the cap');
});

test('an extra notch never yields fewer rows', () => {
  const base = notches(10, 12);
  const more = [...base, { time: base[9].time + 60, deltaY: 100, mode: 0 }];
  assert.ok(run(more).total > run(base).total);
});

test('commits stay under the cap and totals match at 60 and 144 Hz', () => {
  for (const perSecond of [8, 25, 60, 200]) {
    const events = notches(perSecond * 2, perSecond);
    const at60 = run(events, { hz: 60 });
    const at144 = run(events, { hz: 144 });
    const at240 = run(events, { hz: 240 });
    assert.equal(at60.total, at144.total, `${perSecond} notches/s`);
    assert.equal(at60.total, at240.total, `${perSecond} notches/s`);
    for (const { commits } of [at60, at144, at240]) {
      assert.ok(mostCommitsPerSecond(commits) <= 12, `${mostCommitsPerSecond(commits)} commits in one second`);
      for (let i = 1; i < commits.length; i++)
        assert.ok(commits[i].time - commits[i - 1].time >= WHEEL_COMMIT_INTERVAL_MS - 1e-6);
    }
  }
});

test('owed rows are released progressively, largest batch first, and all of them', () => {
  // A burst that arrives within one frame: 10 events of the largest size.
  const burst = Array.from({ length: 10 }, (_, i) => ({ time: i, deltaY: 300, mode: 0 }));
  const owed = run(burst, { immediate: true }).total;
  assert.ok(owed >= 30);
  for (const hz of [60, 144]) {
    const { commits, total, last, activeUntil } = run(burst, { hz });
    assert.equal(total, owed, 'the batches add up to exactly what is owed');
    assert.ok(commits.length >= 4, `released in ${commits.length} batches`);
    assert.ok(commits[0].rows < owed, 'not all at once');
    for (let i = 2; i < commits.length; i++)
      assert.ok(commits[i].rows <= commits[i - 1].rows, `batches ${commits.map(commit => commit.rows)} ease out`);
    const settled = commits[commits.length - 1].time - last;
    assert.ok(settled <= WHEEL_RELEASE_MS + WHEEL_COMMIT_INTERVAL_MS + 1000 / hz, `settled ${settled} ms after the last push`);
    assert.ok(settled <= 900);
    assert.ok(activeUntil - last <= 900, 'no frames requested after everything is released');
  }
});

test('after a long spin everything is out within 0.9 s of the last push', () => {
  for (const hz of [60, 144]) {
    const { commits, last, wheel } = run(notches(75, 25), { hz });
    assert.ok(commits[commits.length - 1].time - last <= 900);
    assert.equal(wheel.active, false);
  }
});

test('reduced motion releases everything owed at once, still no faster than the commit interval', () => {
  const wheel = new WheelNavigation();
  wheel.push(300, 0, 0, PAGE);
  assert.equal(wheel.take(0, true), 3);
  assert.equal(wheel.active, false);
  wheel.push(300, 0, 20, PAGE);
  wheel.push(300, 0, 30, PAGE);
  assert.equal(wheel.take(33, true), 0, 'inside the commit interval');
  const rows = wheel.take(WHEEL_COMMIT_INTERVAL_MS, true);
  assert.ok(rows >= 6);
  assert.equal(wheel.take(2 * WHEEL_COMMIT_INTERVAL_MS, true), 0);
  const events = notches(50, 25);
  assert.equal(run(events, { immediate: true }).total, run(events).total);
  assert.ok(mostCommitsPerSecond(run(events, { immediate: true, hz: 144 }).commits) <= 12);
});

test('a reversal drops what was owed and answers on the next take', () => {
  const wheel = new WheelNavigation();
  for (const event of notches(10, 40)) wheel.push(event.deltaY, 0, event.time, PAGE);
  assert.ok(wheel.take(230) > 0);
  wheel.push(30, 0, 240, PAGE);
  wheel.push(-100, 0, 250, PAGE);
  assert.equal(wheel.take(251), -1, 'no wait for the commit interval, no rows of the old direction, no gain');
  assert.equal(wheel.take(400), 0);
  assert.equal(wheel.active, false, 'the old remainder went with the old rows');
  // The rate estimate restarted: slow notches the other way are single rows.
  assert.equal(run(notches(5, 4, { start: 300, deltaY: -100 }), { wheel }).total, -5);
});

test('a lone short notch (fewer lines per notch, zoomed page) is still one row; trackpad-sized deltas are not', () => {
  for (const deltaY of [80, 67, 34, -80, -34]) {
    const wheel = new WheelNavigation();
    wheel.push(deltaY, 0, 1000, PAGE);
    assert.equal(wheel.take(1000), Math.sign(deltaY), `${deltaY} px`);
    assert.equal(wheel.active, false, 'nothing is left over');
  }
  // Deliberate short notches, one every 400 ms: one row each.
  assert.equal(run(notches(6, 2.5, { deltaY: 80 })).total, 6);
  assert.equal(run(notches(6, 2.5, { deltaY: -34 })).total, -6);
  // Inside a gesture the true size accumulates: five 80 px notches at 10 per second.
  const burst = run(notches(5, 10, { deltaY: 80 })).total;
  assert.ok(burst >= 4 && burst <= 5, `burst ${burst}`);
  // A trackpad's first small delta is not a notch.
  const pad = new WheelNavigation();
  pad.push(20, 0, 1000, PAGE);
  assert.equal(pad.take(1000), 0);
  assert.equal(pad.take(1000 + WHEEL_REMAINDER_MS + 20), 0);
  assert.equal(pad.active, false);
});

test('small deltas accumulate; a remainder survives while input continues and expires after it stops', () => {
  const wheel = new WheelNavigation();
  let total = 0;
  // 20 px every 100 ms (below a notch): slow enough for no gain, 10 events = 2 rows.
  for (let i = 0; i < 10; i++) {
    wheel.push(20, 0, i * 100, PAGE);
    total += wheel.take(i * 100);
    assert.equal(wheel.active, i % 5 !== 4, `after event ${i}`);
  }
  assert.equal(total, 2);

  const fine = new WheelNavigation();
  for (let i = 0; i < 10; i++) fine.push(0.25, 1, i * 100, PAGE);
  assert.equal(fine.take(900), 1, 'ten quarter lines are one row despite float error');

  const part = new WheelNavigation();
  for (const time of [0, 10, 20]) part.push(25, 0, time, PAGE);
  assert.equal(part.take(20), 0);
  assert.equal(part.active, true);
  assert.equal(part.take(20 + WHEEL_REMAINDER_MS - 1), 0);
  assert.equal(part.active, true, 'kept until the remainder window has passed');
  assert.equal(part.take(20 + WHEEL_REMAINDER_MS + 1), 0);
  assert.equal(part.active, false);
  for (const time of [1000, 1010]) part.push(25, 0, time, PAGE);
  assert.equal(part.take(1010), 0, 'the expired remainder does not complete a later row');
});

test('a trackpad stream scrolls continuously under the commit cap', () => {
  // 12 px at 120 Hz for one second: 14.4 rows of input at a moderate rate.
  const events = Array.from({ length: 120 }, (_, i) => ({ time: i * 1000 / 120, deltaY: 12, mode: 0 }));
  for (const hz of [60, 144]) {
    const { commits, total, wheel } = run(events, { hz });
    assert.ok(total >= 14 && total <= 14.4 * WHEEL_MAX_GAIN, `${total} rows`);
    assert.ok(mostCommitsPerSecond(commits) <= 12);
    assert.equal(wheel.active, false);
  }
});

test('active spans the first push to the last release; reset drops everything', () => {
  const wheel = new WheelNavigation();
  assert.equal(wheel.active, false);
  for (const event of notches(12, 60)) wheel.push(event.deltaY, 0, event.time, PAGE);
  assert.equal(wheel.active, true);
  let time = 200;
  let released = 0;
  while (wheel.active && time < 3000) {
    released += wheel.take(time);
    time += 1000 / 60;
  }
  assert.ok(released >= 12);
  assert.equal(wheel.active, false);
  assert.ok(time < 1100);

  for (const event of notches(12, 60, { start: 5000 })) wheel.push(event.deltaY, 0, event.time, PAGE);
  wheel.reset();
  assert.equal(wheel.active, false);
  assert.equal(wheel.take(5200), 0);
  wheel.push(-100, 0, 5210, PAGE);
  assert.equal(wheel.take(5210), -1, 'usable at once after a reset');
});

test('a clock running backwards or a long gap releases no burst and no NaN', () => {
  const idle = new WheelNavigation();
  for (const time of [0, 16, -500, 1e9, NaN, Infinity]) assert.equal(idle.take(time), 0);
  assert.equal(idle.active, false);

  // Rows are owed when the tab is hidden for seconds: they are dropped.
  const hidden = new WheelNavigation();
  for (const event of notches(20, 50)) hidden.push(event.deltaY, 0, event.time, PAGE);
  const first = hidden.take(400);
  assert.ok(first > 0 && hidden.active);
  assert.equal(hidden.take(6000), 0);
  assert.equal(hidden.active, false);
  hidden.push(100, 0, 6100, PAGE);
  assert.equal(hidden.take(6100), 1, 'the old spin does not accelerate the next notch');

  // The take clock jumps back: wait one commit interval from there, then go on.
  const back = new WheelNavigation();
  for (const event of notches(20, 50, { start: 10000 })) back.push(event.deltaY, 0, event.time, PAGE);
  const owed = run(notches(20, 50), { immediate: true }).total;
  let total = back.take(10400);
  assert.equal(back.take(5000), 0, 'no burst on the jump');
  for (let time = 5000 + 1000 / 60; time < 7000; time += 1000 / 60) {
    const rows = back.take(time);
    assert.ok(Number.isInteger(rows) && rows >= 0);
    total += rows;
  }
  assert.equal(total, owed);
  assert.equal(back.active, false);

  // The push clock jumps back: the rate estimate restarts, nothing breaks.
  const pushed = new WheelNavigation();
  pushed.push(100, 0, 9000, PAGE);
  assert.equal(pushed.take(9000), 1);
  pushed.push(100, 0, 100, PAGE);
  const rows = pushed.take(100) + pushed.take(300);
  assert.equal(rows, 1);
  assert.equal(pushed.active, false);
});
