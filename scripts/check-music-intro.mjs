import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  archiveWave, cinematicField, columnStrength, extraction, musicIntroWave, MUSIC_INTRO, settlingWave, smooth,
} from '../src/motion.ts';
// The film's wave functions as they were recorded (the original entry, ?original=1, plays them).
import * as film from '../reference/baseline-motion.ts';

// The music opening (the owner, 2026-10-06: "now it has like 2 times of wave diffusion, cut it to
// 1 time wave diffusion and add a setting option to remove the opening animation").
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const app = read('src/music-app.ts'), scene = read('src/scene.ts'), boot = read('src/music-boot.ts');
const lerp = (a, b, t) => a + (b - a) * t;
const rest = (row, lane) => settlingWave(row, 26.56) * columnStrength(lane, 0);
const { start, lead, end } = MUSIC_INTRO;
// The shelf's height in the opening as scene.ts composes it (pinned below), for a row and lane
// counted from the selected case: the one wave, eased into the resting shelf as the view forms.
const opening = (row, lane, time) => lerp(musicIntroWave(row, lane, time), rest(row, lane), smooth((time + lead - 25.3) / 1.42));
// ... and as it was until 2026-10-06: the film's two scans recentred on the selection.
const twoScans = (row, lane, time) => lerp(cinematicField(row + 12, lane + 2, time), rest(row, lane), smooth((time - 25.3) / 1.42));
// The cells the opening moves: 48 rows of the looping pool, nine lanes, half rows for the tilt.
const cells = [];
for (let lane = -4; lane <= 4; lane++) for (let row = -24; row <= 24; row += 0.5) cells.push([row, lane]);
const series = (field, row, lane, to) => {
  const values = [];
  for (let frame = 0; start + frame / 120 <= to + 1e-9; frame++) values.push(field(row, lane, start + frame / 120));
  return values;
};
// Crests a row rides through: each rise of at least `size` that is followed by a fall of at least
// `size` (or that ends the opening still raised).
function crests(values, size = 0.25) {
  let count = 0, low = values[0], high = -Infinity, rising = false;
  for (const value of values) {
    if (!rising) {
      low = Math.min(low, value);
      if (value - low >= size) { rising = true; high = value; }
    } else {
      high = Math.max(high, value);
      if (high - value >= size) { count++; rising = false; low = value; }
    }
  }
  return count + (rising ? 1 : 0);
}

test('the original film is unchanged: its scans and shoulders are the recorded ones, sample by sample', () => {
  let samples = 0, different = 0;
  // 25 fps, from before the film's first live frame to past its second extraction.
  for (let frame = 540; frame <= 700; frame++) {
    const time = frame / 25;
    for (let lane = -1; lane <= 5; lane++) for (let row = -12; row <= 60; row += 0.5) {
      samples++;
      if (archiveWave(row, lane, time) !== film.archiveWave(row, lane, time)) different++;
      if (cinematicField(row, lane, time) !== film.cinematicField(row, lane, time)) different++;
      if (cinematicField(row, lane, time, 14, 3) !== film.cinematicField(row, lane, time, 14, 3)) different++;
    }
  }
  assert.equal(different, 0, `${different} of ${samples * 3} samples differ`);
  // ... and so it still scans out and back.
  const peak = (time) => Array.from({ length: 32 }, (_, row) => archiveWave(row, 2, time))
    .reduce((best, y, row, values) => (y > values[best] ? row : best), 0);
  assert.ok(peak(23.3) > peak(22.7) + 6, 'the film\'s first crest travels out');
  assert.ok(peak(24.8) < peak(24.2) - 8, 'the film\'s second crest returns');
});

test('the music opening has one wave: the film\'s outward scan, which leaves the resting shelf behind it', () => {
  // Ahead of its crest the wave is the film's first packet, exactly, as long as the film has only
  // that one (its returning scan starts at 24.17).
  let compared = 0;
  for (let time = 22; time <= 24.17; time += 1 / 100) for (const [row, lane] of cells) {
    if (row + 12 + lane * 0.65 - (3 + (time - 22) * 19) < 0) continue;
    compared++;
    assert.equal(musicIntroWave(row, lane, time), archiveWave(row + 12, lane + 2, time), `the outward scan at row ${row}, lane ${lane}, ${time.toFixed(2)} s`);
  }
  assert.ok(compared > 40000);
  let raised = 0, twice = 0;
  for (const [row, lane] of cells) {
    const values = series(opening, row, lane, end);
    // One crest per row (none for the rows behind where the scan starts) ...
    const count = crests(values);
    assert.ok(count <= 1, `row ${row}, lane ${lane} rides ${count} crests`);
    if (count === 1) raised++;
    // ... after which the row only settles, into its resting height.
    let top = 0;
    for (let i = 1; i < values.length; i++) if (values[i] > values[top]) top = i;
    for (let i = top + 1; i < values.length; i++)
      assert.ok(values[i] <= values[i - 1] + 1e-9, `row ${row}, lane ${lane} rises again ${((i - top) / 120).toFixed(2)} s after its crest`);
    assert.ok(values.at(-1) === rest(row, lane), 'the opening ends on the resting shelf');
    if (crests(series(twoScans, row, lane, 27.12)) >= 2) twice++;
  }
  assert.ok(raised > 600, `the scan crosses the shelf (${raised} rows)`);
  assert.ok(twice > 400, `the earlier opening had two waves through most rows (${twice}): the count tells them apart`);
  // No pause where the second wave was: once the crest has passed the selected case, it and its
  // neighbours stand at their shoulders, where they used to drop back to the flat shelf first.
  const passed = 22 + 9 / 19 + 0.3;
  for (const row of [-2, -1, 0, 1, 2]) {
    let low = Infinity, before = Infinity;
    for (let time = passed; time <= end; time += 1 / 120) low = Math.min(low, opening(row, 0, time));
    for (let time = passed; time <= 25.3; time += 1 / 120) before = Math.min(before, twoScans(row, 0, time));
    assert.ok(low >= rest(row, 0) - 1e-9, `row ${row} stays up after the scan (${low.toFixed(3)})`);
    assert.ok(before < 0.2, `row ${row} fell back between the two scans before (${before.toFixed(3)})`);
  }
  // Exactly the resting shelf once the scan has faded, well before the hold; no step at that moment.
  for (const [row, lane] of cells) {
    assert.equal(musicIntroWave(row, lane, 24.8), rest(row, lane));
    assert.ok(Math.abs(musicIntroWave(row, lane, 24.8 - 1e-9) - rest(row, lane)) < 1e-6);
    assert.equal(musicIntroWave(row, lane, 22), 0, 'flat before the scan');
  }
  // As smooth as the film's scan: no case moves further in one 60 Hz frame than it did.
  let fastest = 0, earlier = 0;
  for (let time = start; time < end; time += 1 / 60) for (const [row, lane] of cells)
    fastest = Math.max(fastest, Math.abs(opening(row, lane, time + 1 / 60) - opening(row, lane, time)));
  for (let time = start; time < 27.12; time += 1 / 60) for (const [row, lane] of cells)
    earlier = Math.max(earlier, Math.abs(twoScans(row, lane, time + 1 / 60) - twoScans(row, lane, time)));
  assert.ok(fastest <= earlier, `largest step in a frame ${fastest.toFixed(3)} (the film's two scans: ${earlier.toFixed(3)})`);
});

test('the music opening is shorter: the pull back follows the orbit without stopping, then the same hold', () => {
  assert.equal(start, 21.92, 'from the film\'s first live 3D frame');
  assert.ok(Math.abs(end - start - 4.2) < 1e-9, `about 4.2 s (was 5.2 s): ${(end - start).toFixed(2)}`);
  assert.ok(Math.abs(end + lead - 27.12) < 1e-9, 'the film\'s last phase is taken `lead` earlier and ends as it did');
  // The browsing view is whole 400 ms before the hand-over, as before.
  assert.ok(Math.abs(end + lead - (25.3 + 1.42) - 0.4) < 1e-9);
  // The camera's turn (yaw, as scene.ts has it): the orbit eases out at 24.2; the film's pull back
  // eased in at 24.25, a standstill between them. Taken `lead` earlier the turn never stops.
  const yaw = (time, shift) => 89 - 22 * smooth((time - 22.6) / 1.6) - 8 * smooth((time + shift - 24.25) / 2.25);
  const speed = (time, shift) => Math.abs(yaw(time + 1e-4, shift) - yaw(time - 1e-4, shift)) / 2e-4;
  let slowest = Infinity;
  for (let time = 23; time <= 24.9; time += 1 / 120) slowest = Math.min(slowest, speed(time, lead));
  assert.ok(slowest > 2, `the camera keeps turning (${slowest.toFixed(1)}°/s at the slowest)`);
  assert.ok(speed(24.22, 0) < 0.05, 'the film\'s camera stood still there');
  // The pull back starts after the scan has passed the selected case; the selected case lifts (with
  // the browsing view) once the scan's crest has left the 24 rows in front of it.
  assert.ok(24.25 - lead > 22 + 9 / 19);
  assert.ok(3 + (25.3 - lead - 22) * 19 - 12 > 24);
  assert.equal(extraction(25.3), 0, 'the lift reads the film\'s first extraction, which starts later still');
});

test('scene.ts and music-boot.ts play it: one wave, the late phase `lead` earlier, the film\'s own camera moves left out', () => {
  assert.match(scene, /const shot = musicIntro \? Math\.min\(cinematic!\.time, MUSIC_INTRO\.end\) : cinematic\?\.time \?\? 29\.1;/);
  assert.match(scene, /const late = musicIntro \? shot \+ MUSIC_INTRO\.lead : shot;\n\s*const introSettle = musicIntro \? ease\(\(late - 25\.3\) \/ 1\.42\) : 0;/);
  assert.match(scene, /THREE\.MathUtils\.lerp\(extraction\(late\), previewLift, introSettle\)\n\s*: extraction\(shot\);/);
  assert.match(scene, /const opening = musicIntroWave\(row - selectedRow, lane - selectedLane, shot\);\n\s*const resting = settlingWave\(row - selectedRow, 26\.56\) \* columnStrength\(lane, selectedLane\);\n\s*return THREE\.MathUtils\.lerp\(opening, resting, introSettle\);/);
  assert.match(scene, /const orbit = ease\(\(shot - 22\.6\) \/ 1\.6\);\n(\s*\/\/[^\n]*\n)*\s*const settle = ease\(\(late - 24\.25\) \/ 2\.25\);/);
  // The film's turn aside and its tracking of the selected corner follow its returning scan.
  assert.match(scene, /if \(cinematic && !musicIntro\) \{\n\s*const pan = ease\(\(shot - 25\.4\) \/ 0\.95\);/);
  assert.match(scene, /if \(cinematic && !musicIntro && shot >= 25\.05 && shot <= 27\.3\) \{/);
  // The film's own path is untouched: outside the music opening `late` is `shot`, and only these read it.
  assert.deepEqual(scene.split('\n').filter((line) => /[(\s]late\b/.test(line) && !/^\s*\/\//.test(line)).map((line) => line.trim()), [
    'const late = musicIntro ? shot + MUSIC_INTRO.lead : shot;',
    'const introSettle = musicIntro ? ease((late - 25.3) / 1.42) : 0;',
    '? THREE.MathUtils.lerp(extraction(late), previewLift, introSettle)',
    'const settle = ease((late - 24.25) / 2.25);',
  ]);
  assert.match(boot, /const START_TIME = MUSIC_INTRO\.start;/);
  assert.match(boot, /const END_TIME = MUSIC_INTRO\.end;/);
});

// A few elements are enough for MusicBoot: it only builds its overlay, hides the page's other
// layers while the opening runs, and fades the controls in afterwards.
class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.hidden = false;
    this.inert = false;
    this.className = '';
    const styles = new Map();
    this.style = {
      getPropertyValue: (name) => styles.get(name)?.[0] ?? '',
      getPropertyPriority: (name) => styles.get(name)?.[1] ?? '',
      setProperty: (name, value, priority = '') => styles.set(name, [value, priority]),
      removeProperty: (name) => styles.delete(name),
    };
    this.classList = { contains: (name) => this.className.split(/\s+/).includes(name) };
  }
  setAttribute() {}
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  addEventListener(type, listener) { (this.listeners ??= {})[type] = listener; }
  focus() { globalThis.document.activeElement = this; }
  contains(node) { for (let at = node; at; at = at.parentNode) if (at === this) return true; return false; }
  closest() { return null; }
  get isConnected() { return true; }
  querySelector() { return null; }
  animate() { return { finished: Promise.resolve(), cancel() {} }; }
  remove() {}
}
globalThis.HTMLElement = FakeElement;
// The page's keys and clicks reach the opening first (listeners in the capture phase on the document).
const documentListeners = new Map();
const captured = (type) => documentListeners.get(type) ?? new Set();
const documentKeys = captured('keydown');
documentListeners.set('keydown', documentKeys);
globalThis.document = {
  createElement: (tag) => new FakeElement(tag), body: new FakeElement('body'), activeElement: null,
  addEventListener: (type, listener, capture) => {
    if (capture !== true) return;
    if (!documentListeners.has(type)) documentListeners.set(type, new Set());
    documentListeners.get(type).add(listener);
  },
  removeEventListener: (type, listener, capture) => { if (capture === true) documentListeners.get(type)?.delete(listener); },
};
globalThis.getComputedStyle = () => ({ opacity: '1', translate: 'none' });
const { MusicBoot } = await import('../src/music-boot.ts');
function opened({ intro, reduced = false }) {
  const stage = new FakeElement('main');
  stage.appendChild(new FakeElement('div')).className = 'three-scene';
  const header = stage.appendChild(new FakeElement('header'));
  const events = [];
  const music = new MusicBoot(stage, {
    intro: () => intro, reduced: () => reduced,
    onStart: () => events.push('start'), onComplete: (reason) => events.push(reason),
    onRevealCut: () => events.push('cut'),
  });
  return { music, stage, header, events };
}

test('「开场动画」 on: the opening plays its 4.2 s and hands over', () => {
  const { music, events } = opened({ intro: true });
  music.start(100);
  assert.deepEqual(events, ['start']);
  let frames = 0, frame, last;
  while ((frame = music.update(100 + (frames + 1) / 60))) {
    frames++;
    assert.equal(frame.cinema.musicIntro, true);
    last = frame.cinema.time;
  }
  assert.equal(last, end, 'its last frame is the resting shelf\'s hold');
  assert.ok(Math.abs(frames / 60 - (end - start)) < 2 / 60, `${frames} frames at 60 Hz`);
  assert.deepEqual(events, ['start', 'complete']);
});

test('「开场动画」 off (and reduced motion): every start goes straight to the shelf by the skip path, drawing no frame of the opening', async () => {
  for (const [intro, reduced] of [[false, false], [false, true], [true, true]]) {
    const { music, stage, header, events } = opened({ intro, reduced });
    music.start(100);
    // Skipped inside start(): the scene shows the shelf (showMusicArchiveImmediately) before any frame.
    assert.deepEqual(events, ['start', 'skip'], JSON.stringify({ intro, reduced }));
    assert.equal(music.update(100 + 1 / 60), undefined, 'no opening frame');
    assert.equal(header.style.getPropertyValue('visibility'), '', 'the page is shown again');
    await Promise.resolve(); await Promise.resolve();
    assert.equal(stage.dataset.musicBoot, 'done');
    assert.equal(music.active, false);
  }
});

// An event as the page receives it (through the capture listeners on the document), and whether
// the opening kept it from the page and from its default.
function dispatch(type, fields) {
  const event = {
    ctrlKey: false, altKey: false, metaKey: false, repeat: false, target: document.body, ...fields,
    stopped: false, prevented: false,
    stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; },
  };
  for (const listener of [...captured(type)]) listener(event);
  return event;
}
const press = (key, extra = {}) => dispatch('keydown', { key, code: extra.code ?? `Key:${key}`, ...extra });
const release = (key, extra = {}) => dispatch('keyup', { key, code: extra.code ?? `Key:${key}`, ...extra });
const click = () => dispatch('click', {});
const pointer = (music, extra = {}) => music.root.listeners.pointerdown({ isPrimary: true, button: 0, ...extra });

test('a click or a key ends the opening (2026-10-06): skipped while it runs, the fade-in completed at a press; the press does nothing else', () => {
  // The pointer pressed anywhere on the opening: the skip path, as 跳过进场.
  let { music, stage, events } = opened({ intro: true });
  music.start(100);
  music.update(100.5);
  pointer(music, { button: 2 });
  pointer(music, { isPrimary: false });
  assert.deepEqual(events, ['start'], 'another button, or a second finger, does not end it');
  pointer(music);
  assert.deepEqual(events, ['start', 'skip']);
  assert.ok(click().stopped, 'the click of that press is kept from the page');
  assert.ok(!click().stopped, '... and only that one');
  assert.equal(music.update(100.6), undefined, 'no further frame of the opening');
  assert.equal(stage.dataset.musicBoot, 'revealing', 'the page fades in');
  pointer(music);
  assert.equal(stage.dataset.musicBoot, 'done', 'pressed again during the fade-in: the whole page at once');
  assert.deepEqual(events, ['start', 'skip', 'cut'], 'the page\'s own fades end with it');
  const tap = click();
  assert.ok(tap.stopped && tap.prevented, 'a tap\'s click, aimed after the page is shown, does not act on the control under the finger');
  assert.equal(music.active, false);
  pointer(music);
  assert.ok(!click().stopped, 'once the opening is over, a press is the page\'s own');

  // A key: anything but a modifier alone or a system shortcut, Tab and Escape included.
  ({ music, stage, events } = opened({ intro: true }));
  music.start(200);
  for (const [key, extra] of [['Shift'], ['Control'], ['Alt'], ['Meta'], ['r', { ctrlKey: true }], ['F4', { altKey: true }], ['d', { metaKey: true }]]) {
    const event = press(key, extra);
    assert.ok(!event.prevented && event.stopped, `${key}: its default kept, the page not reached`);
  }
  assert.deepEqual(events, ['start'], 'a modifier alone or a shortcut does not end it');
  const arrow = press('ArrowDown');
  assert.ok(arrow.prevented && arrow.stopped, 'the key is kept from the page: it does not also move the selection');
  assert.deepEqual(events, ['start', 'skip']);
  assert.equal(stage.dataset.musicBoot, 'revealing');
  const held = press('ArrowDown', { repeat: true });
  assert.ok(held.prevented && stage.dataset.musicBoot === 'revealing', 'a held key repeating does not cut the fade-in short');
  press(' ');
  assert.equal(stage.dataset.musicBoot, 'done');
  assert.deepEqual(events, ['start', 'skip', 'cut']);
  // Both keys still held after the end: their repeats stay off the page until they are let go.
  const late = press(' ', { repeat: true });
  assert.ok(late.prevented && late.stopped, 'the repeats of the key that ended it do not reach the page');
  assert.ok(release(' ').stopped, 'nor does its release (a focused button would take it as a click)');
  const freed = press(' ');
  assert.ok(!freed.prevented && !freed.stopped, 'pressed again, it is the page\'s');
  const after = press('Enter');
  assert.ok(!after.prevented && !after.stopped, 'afterwards the page has its keys again');
  // A key that comes without a code (sent by some tools) is remembered by its name instead.
  ({ music, stage, events } = opened({ intro: true }));
  music.start(240);
  press('Enter', { code: '' });
  press('Enter', { code: '' });
  assert.equal(stage.dataset.musicBoot, 'done');
  assert.ok(press('Enter', { code: '', repeat: true }).stopped && release('Enter', { code: '' }).stopped, 'its repeats and release stay off the page');
  assert.ok(!press('Enter', { code: '' }).stopped);
  for (const key of ['Tab', 'Escape']) {
    ({ music, stage, events } = opened({ intro: true }));
    music.start(250);
    assert.ok(press(key).prevented && events.at(-1) === 'skip', `${key} ends it too`);
  }

  // The window's own title bar keeps its keys; the opening's listeners go with it.
  const count = documentKeys.size, ups = captured('keyup').size;
  ({ music, events } = opened({ intro: true }));
  assert.equal(documentKeys.size, count + 1);
  music.start(300);
  const onBar = press('Enter', { target: { closest: (selector) => selector === '.window-bar' ? {} : null } });
  assert.ok(!onBar.prevented && !onBar.stopped && events.length === 1);
  music.dispose();
  assert.equal(documentKeys.size, count);
  assert.equal(captured('keyup').size, ups);
});

test('reduced motion: a press ends the opening at once, and its click still does not reach the page shown beneath', () => {
  const { music, stage, events } = opened({ intro: true, reduced: true });
  music.replay(400);   // the opening forced on, as replay() does; reduced motion hides it without a fade-in
  pointer(music);
  assert.deepEqual(events, ['start', 'skip']);
  assert.equal(stage.dataset.musicBoot, 'done');
  assert.ok(click().stopped, 'the tap\'s click lands on the page, which is kept from it');
});

test('the setting: on by default, saved with the other preferences, in 动效与显示, read only at the next start', () => {
  assert.match(app, /reduced: false,\n(\s*\/\/[^\n]*\n)*\s*intro: true,\n/, 'on unless switched off');
  assert.match(app, /reduced: boolean;\n\s*intro: boolean;\n/);
  assert.match(app, /if \(typeof preferences\.intro !== "boolean"\) preferences\.intro = true;/);
  assert.match(app, /boot = new MusicBoot\(stage, \{\n\s*reduced: \(\) => preferences\.reduced,\n\s*intro: \(\) => preferences\.intro,\n/);
  const motion = app.slice(app.indexOf('<h3>动效与显示</h3>'), app.indexOf('</section>', app.indexOf('<h3>动效与显示</h3>')));
  assert.match(motion, /<label class="settings-row"><span>开场动画<small>[^<]*下次启动时生效<\/small><\/span><input type="checkbox" id="intro-setting" \$\{preferences\.intro \? "checked" : ""\}><\/label>/);
  // Switching it saves it and does nothing else: the opening is decided when the page starts.
  const change = app.slice(app.indexOf('if (el.id === "intro-setting") {'), app.indexOf('if (el.id === "bgm-setting")'));
  assert.match(change, /^if \(el\.id === "intro-setting"\) \{\n\s*preferences\.intro = el\.checked;\n\s*savePrefs\(\);\n\s*\}\n\s*$/);
  assert.equal(app.match(/boot\?\.start\(/g).length, 1, 'the opening starts only when the page starts');
  // Every earlier key is still saved (and the new one with them, in data/preferences.json too).
  for (const key of ['theme', 'sortMode', 'quality', 'reduced', 'volume', 'songFade', 'bgm', 'bgmVolume', 'sound', 'soundVolume', 'renderQuality', 'neteaseQueue', 'neteaseControl', 'playlistColumns'])
    assert.match(app.slice(app.indexOf('const preferences = {'), app.indexOf('>("rhine-music-preferences", {}),')), new RegExp(`\\n\\s*${key}: `), key);
  assert.match(app, /if \(key === "rhine-music-preferences"\) saveDesktopPreferences\(value\);/);
});
