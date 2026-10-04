import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLAY_GESTURE, playHop } from '../src/motion.ts';
import { songSceneMarkup } from '../src/song-list.ts';

const app = readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8');
const scene = readFileSync(new URL('../src/scene.ts', import.meta.url), 'utf8');
const body = (source, start, end) => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `${start} is in the source`);
  return source.slice(from, source.indexOf(end, from + start.length));
};

test('the play gesture: a little hop, smooth at both ends, back on the ground in half a second', () => {
  assert.equal(playHop(0), 0);
  assert.equal(playHop(-0.1), 0);
  assert.equal(playHop(PLAY_GESTURE.time), 0);
  assert.equal(playHop(Infinity), 0, 'no gesture yet (the start is -Infinity)');
  assert.ok(Math.abs(playHop(PLAY_GESTURE.time / 2) - PLAY_GESTURE.height) < 1e-12, 'its height half way');
  assert.ok(PLAY_GESTURE.height > 0.2 && PLAY_GESTURE.height < 0.5, 'less than the 0.9 a selection lifts the case');
  // Smooth: it leaves and meets the ground without a jolt, rises then falls.
  const dt = 1e-4;
  assert.ok(playHop(dt) / dt < 0.01 && playHop(PLAY_GESTURE.time - dt) / dt < 0.01);
  // One rise and one fall, about the middle (sampled at whole hundredths of the hop).
  for (let step = 1; step < 100; step++) {
    const t = PLAY_GESTURE.time * step / 100, before = playHop(PLAY_GESTURE.time * (step - 1) / 100);
    assert.ok(step <= 50 ? playHop(t) >= before : playHop(t) <= before, `one rise and one fall (${t})`);
  }
  assert.ok(PLAY_GESTURE.wave > 0 && PLAY_GESTURE.wave < PLAY_GESTURE.time / 2, 'the wave leaves as the case rises');
});

test('the play gesture is the scene\'s: hop of the selected case, the wave on the shelf and along the chain, then rest', () => {
  const gesture = body(scene, '  playGesture() {', '  get songCardHop()');
  assert.match(gesture, /if \(!musicLibrary \|\| !this\.loaded \|\| this\.reduced \|\| !records\.length\) return;/, 'reduced motion has neither');
  assert.match(gesture, /this\.pacing\.invalidate\(\);/, 'a resting scene wakes for it');
  assert.match(gesture, /this\.pulses\.push\(\{ \.\.\.this\.selectedCell, time: now \+ PLAY_GESTURE\.wave, play: true \}\);/);
  // The hop is applied to the selected case after every pose, the song scene's included.
  assert.match(scene, /if \(songProgress > 0\) this\.poseSongCase\(this\.model, selectedBase, songProgress, liftHold\);\s*\/\/[^\n]*\n\s*const hop = musicLibrary && !cinematic && !this\.reduced \? playHop\(time - this\.playStarted\) : 0;\s*this\.model\.position\.y \+= hop;/);
  // A selection's wave fades under an opened case; the gesture's does not.
  assert.match(scene, /THREE\.MathUtils\.clamp\(ripple, -limit, limit\) \* this\.pulseGain \+ THREE\.MathUtils\.clamp\(playRipple, -limit, limit\)/);
  // The chain does not take the shelf's height: the wave is added along it, by rows from the lifted slot.
  assert.match(scene, /const ripple = this\.chainRipple\(Math\.abs\(u - SONG_CHAIN_CENTRE\)\);\s*if \(ripple\) object\.position\.addScaledVector\(basis\.up, ripple \* share\);/);
  assert.match(scene, /time - this\.playStarted >= PLAY_GESTURE\.time;/, 'the scene rests only once the hop is over');
  // The selected case hops; it does not also ride its own wave (the song scene's line follows the hop).
  assert.match(scene, /const selectedBase = chosen\.y \+ field\(selectedRow, selectedLane, false\);/);
  assert.match(scene, /chosen\.y \+ field\(selectedRow, selectedLane, false\) \+ this\.lift\.value,/);
  assert.match(scene, /if \(p\.play && !played\) continue;/);
  // A hop still running stays with the case that leaves when the selection changes.
  assert.match(scene, /const hop = musicLibrary && changed \? playHop\(performance\.now\(\) \/ 1000 - this\.playStarted\) : 0;\s*if \(musicLibrary && changed\) this\.playStarted = -Infinity;/);
  assert.match(scene, /lift: \{ value: this\.lift\.value \+ hop, velocity: this\.lift\.velocity \},/);
  // Reduced motion: no hop and no wave, also for a gesture already running.
  assert.match(scene, /const hop = musicLibrary && !cinematic && !this\.reduced \? playHop\(time - this\.playStarted\) : 0;/);
  assert.match(scene, /private chainRipple\(rows: number\) \{\s*if \(this\.reduced\) return 0;/);
  assert.match(scene, /this\.pulses = this\.pulses\.filter\(\(pulse\) => !pulse\.play\);/);
  // The song scene's line meets the large card's edges while it hops.
  assert.match(app, /\$\("#music-song"\)\.style\.setProperty\("--songs-hop", `\$\{hop\}px`\);/);
  const css = readFileSync(new URL('../src/song-scene.css', import.meta.url), 'utf8');
  assert.match(css, /height: calc\(var\(--songs-card-top\) - var\(--songs-hop, 0px\)\);/);
  assert.match(css, /top: calc\(var\(--songs-card-bottom\) - var\(--songs-hop, 0px\)\);/);
});

test('play / pause and an external player\'s stop, by button or key, answer with the gesture; previous and next do not', () => {
  const toggle = body(app, 'function togglePlayback() {', '\nfunction ');
  const stop = body(app, 'function stopPlayback() {', '\nfunction ');
  for (const fn of [toggle, stop]) {
    assert.match(fn, /scene\?\.playGesture\(\);/);
    assert.match(fn, /if \(!externalMedia\?\.can\("(toggle|stop)"\)\) return;/, 'not for a control the player does not offer');
  }
  assert.match(app, /case "play-pause":\s*togglePlayback\(\);\s*break;/);
  // The header has play / pause but no stop (the owner removed the square, 2026-10-04); stop
  // remains where an external player offers it, on its details page.
  assert.doesNotMatch(app, /stop-playback|data-action="stop"|case "stop":/);
  assert.match(app, /if \(target\.dataset\.mediaAction === "toggle"\) togglePlayback\(\);\s*else if \(target\.dataset\.mediaAction === "stop"\) stopPlayback\(\);\s*else void controlExternal\(target\.dataset\.mediaAction as MediaAction\);/);
  // Space is play / pause.
  assert.match(app, /if \(e\.code === "Space" [^\n]*\n\s*e\.preventDefault\(\);\s*togglePlayback\(\);/);
});

test('every scene leads to the other two, with the same keys everywhere', () => {
  // Enter (and the selected case) opens the details; S switches to the song scene and back;
  // Esc returns to the shelf, from the details and from the song scene alike.
  assert.match(body(app, 'function toggleSongs() {', '\n}'), /if \(menu !== "song"\) openSongs\(\);\s*else swapToDetail\(\);/);
  assert.match(body(app, 'function leaveMenu() {', '\n}'), /^function leaveMenu\(\) \{\s*setMode\("archive"\);\s*$/);
  assert.match(body(app, 'function showDetails() {', '\n}'), /if \(menu === "song"\) swapToDetail\(\);\s*else setMode\("detail"\);/);
  // The song scene swaps to the details wherever it was opened from.
  assert.doesNotMatch(body(app, 'function swapToDetail() {', '\n}'), /songOrigin/);
  assert.match(app, /if \(e\.key === "Escape"\) \{\s*panel \? closePanel\(\) : leaveMenu\(\);/);
  assert.match(app, /if \(e\.code === "KeyS" [^\n]*\n\s*e\.preventDefault\(\);\s*toggleSongs\(\);/);
  // Enter away from a button: the details, from the song scene too.
  assert.match(app, /if \(e\.key === "Enter" && !\(e\.target as HTMLElement\)\.closest\("button, a"\)\) \{\s*e\.preventDefault\(\);\s*showDetails\(\);/);
  assert.match(app, /case "open":\s*setMode\("detail"\);\s*break;\s*case "songs":\s*toggleSongs\(\);\s*break;\s*case "details":\s*showDetails\(\);\s*break;\s*case "back":\s*leaveMenu\(\);/);
  // The buttons: the shelf has open and songs, the details back and songs, the song scene back and details.
  assert.match(app, /<button class="open-album" data-action="open">/);
  assert.match(app, /<button class="open-songs" data-action="songs">/);
  assert.match(app, /<section id="music-detail"[^>]*>\s*<button class="music-back" data-action="back">← 返回专辑架 <kbd>ESC<\/kbd><\/button>\s*<div class="card-caption">[^\n]*data-action="songs"/);
  const song = songSceneMarkup();
  assert.match(song, /<button class="music-back" data-action="back"><span>← <span id="song-back-label">返回专辑架<\/span><\/span> <kbd>ESC<\/kbd><\/button>/);
  assert.match(song, /<button class="music-back song-details" data-action="details"><span>↗ <span id="song-details-label">专辑详情<\/span><\/span> <kbd>S<\/kbd><\/button>/);
  assert.match(app, /\$\("#song-details-label"\)\.textContent = queue \? "这首歌" : "专辑详情";/);
});

test('clicking the selected case opens its details; it never plays or pauses', () => {
  const select = body(app, 'scene.onSelect = (index, cell, lifted) => {', 'scene.onNavigate');
  assert.match(select, /if \(lifted && \(presentation\.phase === "archive" \|\| songScene\)\) return showDetails\(\);/);
  assert.doesNotMatch(select, /togglePlayback|controlExternal|player\?\./, 'no playback from a click on a case');
  // A live card without a queue opens its details too (the check comes before the queue's).
  assert.ok(select.indexOf('return showDetails()') < select.indexOf('if (externalMode && !shownQueue()) return;'));
});

test('the desktop window draws its own title bar: no title, three buttons, the top edge drags it', () => {
  const frame = readFileSync(new URL('../src/window-frame.ts', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const capability = JSON.parse(readFileSync(new URL('../src-tauri/capabilities/desktop.json', import.meta.url), 'utf8'));
  const css = readFileSync(new URL('../src/window-frame.css', import.meta.url), 'utf8');
  // No native title bar; the window keeps its shadow (and with it its border and rounded corners).
  assert.match(main, /\.decorations\(false\)\s*\.shadow\(true\)/);
  // Only in the desktop client; three buttons and nothing else, no title text.
  assert.match(frame, /const current = isDesktop \? tauri\?\.window\?\.getCurrentWindow\(\) : undefined;\s*if \(!current\) return;/);
  assert.equal((frame.match(/<button type="button" data-window="/g) || []).length, 3);
  for (const action of ['minimize', 'maximize', 'close']) assert.match(frame, new RegExp(`data-window="${action}"`));
  assert.doesNotMatch(frame, /Rhine Music|<h1|<span[^>]*title/, 'no title');
  assert.match(frame, /bar\.setAttribute\("data-tauri-drag-region", ""\);/);
  assert.match(frame, /bar\.hidden = Boolean\(document\.fullscreenElement\);/, 'not in fullscreen');
  // Exactly the window permissions the bar uses.
  for (const permission of ['core:window:allow-minimize', 'core:window:allow-toggle-maximize', 'core:window:allow-internal-toggle-maximize', 'core:window:allow-close', 'core:window:allow-start-dragging', 'core:window:allow-is-maximized'])
    assert.ok(capability.permissions.includes(permission), permission);
  assert.ok(!capability.permissions.some(permission => /allow-(set-|destroy|create|hide|show)/.test(permission)), 'nothing else about windows');
  // Over everything (the intro's overlay included), at the top right, in Windows' own button size.
  assert.match(css, /\.window-bar \{[^}]*position: fixed;[^}]*z-index: 1000;[^}]*top: 0;[^}]*height: 32px;/);
  const boot = readFileSync(new URL('../src/music-boot.css', import.meta.url), 'utf8');
  assert.ok(Number(/\.music-boot-overlay \{[^}]*z-index: (\d+);/.exec(boot)[1]) < 1000, 'the bar lies above the intro');
  assert.match(css, /\.window-controls button \{[^}]*width: 46px;/);
  const app = readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8');
  assert.match(app, /installWindowFrame\(stage\);/);
  // The intro locks the page but not the bar: the window can be moved, minimized and closed while it runs.
  const musicBoot = readFileSync(new URL('../src/music-boot.ts', import.meta.url), 'utf8');
  assert.match(musicBoot, /node !== this\.root &&\s*!node\.classList\.contains\("window-bar"\)\)/);
  // A click leaves no keyboard focus on a window button, and the page's keys are not swallowed.
  assert.match(frame, /bar\.addEventListener\("mousedown", \(event\) => \{\s*if \(\(event\.target as Element\)\.closest\("\[data-window\]"\)\) event\.preventDefault\(\);/);
  assert.doesNotMatch(frame, /keydown/);
  // In narrow windows a panel, the intro's skip button and the model viewer's header start below the strip.
  const narrow = css.slice(css.indexOf('@media (max-width: 700px)'));
  assert.match(narrow, /\.music-app\[data-window-frame="custom"\] \.music-panel-scrim \{\s*padding-top: 40px;/);
  assert.match(narrow, /\.music-app\[data-window-frame="custom"\] \.music-boot-skip,\s*\.music-app\[data-window-frame="custom"\] \.viewer-header \{\s*top: 40px;/);
});
