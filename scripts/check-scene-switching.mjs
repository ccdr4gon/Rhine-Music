import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLAY_GESTURE, playHop } from '../src/motion.ts';
import { songSceneMarkup } from '../src/song-list.ts';

const app = readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8');
const scene = readFileSync(new URL('../src/scene.ts', import.meta.url), 'utf8');
// NetEase's session (its queue, the song asked for, following): moved out of music-app.ts on 2026-10-06.
const session = readFileSync(new URL('../src/netease_music/connector/session.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const body = (source, start, end) => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `${start} is in the source`);
  return source.slice(from, source.indexOf(end, from + start.length));
};
// A method of the NetEase session, up to its closing brace.
const method = (start) => {
  const found = body(session, `\n  ${start}`, '\n  }\n');
  assert.ok(found.length < 4000, `${start} ends at its closing brace`);
  return found;
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
  assert.match(scene, /if \(songProgress > 0\) this\.poseSongCase\(this\.model, selectedBase, songProgress, liftHold\);\s*\/\/[^\n]*\n\s*this\.model\.position\.x -= columnForward\(selectedLane\);\s*\/\/[^\n]*\n\s*const hop = musicLibrary && !cinematic && !this\.reduced \? playHop\(time - this\.playStarted\) : 0;\s*this\.model\.position\.y \+= hop;/);
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
  // The details page's controls work NetEase as it is (its play / pause too, with the gesture).
  assert.match(app, /if \(target\.dataset\.mediaAction === "toggle"\) toggleExternal\(\);\s*else if \(target\.dataset\.mediaAction === "stop"\) stopPlayback\(\);\s*else void controlExternal\(target\.dataset\.mediaAction as MediaAction\);/);
  // NetEase's own previous / next: the shelf follows its next change of song, once it was sent (not before).
  assert.match(app, /if \(await pending && \(action === "previous" \|\| action === "next"\)\) netease\.followNextAt = performance\.now\(\);/);
  assert.match(session, /if \(this\.queueJump \|\| now - this\.followNextAt < QUEUE_JUMP_TIMEOUT_MS\) this\.queueFollowPaused = false;\s*this\.followNextAt = -Infinity;/);
  const remote = body(app, 'function toggleExternal() {', '\nfunction ');
  assert.match(remote, /if \(!externalMedia\?\.can\("toggle"\)\) return;\s*void controlExternal\("toggle"\);\s*scene\?\.playGesture\(\);/);
  // Space is play / pause.
  assert.match(app, /if \(e\.code === "Space" [^\n]*\n\s*e\.preventDefault\(\);\s*togglePlayback\(\);/);
});

test('the play mode: browsing never switches the song; the play button plays the selection, or pauses / resumes it', () => {
  // No rest-to-play: a committed selection only updates the button.
  for (const source of [app, session]) assert.doesNotMatch(source, /scheduleQueueJump|jumpToSelectedSong|QUEUE_SETTLE_MS|queueJumpTimer|queueBrowsing/);
  const commit = body(app, 'function commitSelection(', '\nfunction ');
  assert.match(commit, /updateSelection\(navigation\);\s*syncPlayButton\(\);/);
  // Player skin: the selected queue song, when it is not the playing one and the port may be used.
  const toggle = body(app, 'function togglePlayback() {', '\nfunction ');
  assert.match(toggle, /const wanted = netease\.queueSongToPlay\(playsCurrent\(\)\);\s*if \(wanted\) void netease\.playQueueSong\(wanted\);/);
  // The playing song itself only when NetEase has no play / pause of its own (not merely busy) and
  // is not playing it: the port's action can start a song, never pause one.
  assert.match(app, /function playsCurrent\(\) \{\s*return !externalMedia\?\.offers\("toggle"\) && mediaPlayback\(\) !== "playing";\s*\}/);
  const asked = method('async playQueueSong(');
  assert.match(asked, /if \(key !== this\.queuePlaying\) \{\s*if \(this\.queueJump\) this\.queueJumpsSuperseded\.set/, 'a request for the playing song is not a switch to wait for');
  const wanted = method('queueSongToPlay(');
  assert.match(wanted, /const key = this\.host\.recordId\(this\.host\.navigationSelection\(\)\), song = this\.queueSong\(key\);/, 'only NetEase\'s own queue: a playlist column is never played');
  assert.match(app, /recordId: \(index\) => records\[index\]\?\.id,/, 'the record of a case, as before');
  assert.match(wanted, /\(key === this\.queuePlaying && !current\)/);
  assert.match(wanted, /if \(!this\.host\.preferences\.neteaseControl \|\| !this\.debugState\.available \|\| this\.debugState\.mode === "playFm"\) return undefined;/);
  const play = method('async playQueueSong(');
  assert.match(play, /await this\.ports\.debug\.play\(song\.id\);/, 'the same queue action as before, no new one');
  assert.match(session, /const NATIVE_PORTS: NeteasePorts = \{ queue: nativeQueuePort, playlists: nativePlaylistPort, debug: nativeDebugPort \};/);
  assert.match(play, /this\.host\.confirmSoon\(\);/);
  assert.match(app, /new NeteaseSession\(\{[\s\S]*?\n\s*confirmSoon,\s*refresh: refreshExternal,/, 'the app\'s quick reads and poll');
  // Local mode (each case a song of a folder playlist, 2026-10-06): the selected song when it is
  // not the one loaded ...
  assert.match(toggle, /\} else if \(localSongWaits\(\)\) playSong\(\);/);
  assert.match(app, /return !!song\?\.tracks\.length && !song\.offline && \(!loaded \|\| loaded\.id !== song\.id\);/);
  // ... from which the player continues through that song's playlist; the shelf goes with the
  // player's next song only while the selection rests on the one that was playing (never playing).
  assert.match(body(app, 'function playSong() {', '\n}'), /void player\?\.play\(song\.id, playlistQueue\(localShelf, song\)\);/);
  const localFollow = body(app, 'function followLocalSong(', '\n}');
  assert.match(localFollow, /if \(!from \|\| !to \|\| from === to \|\| !ready \|\| boot\?\.active \|\| panel \|\| libraryRebuilding\) return;/);
  assert.match(localFollow, /if \(records\[cursor\]\?\.id !== from\) return;/);
  assert.match(localFollow, /select\(index, rowNavigation\(cursor, index\)\);/);
  assert.doesNotMatch(localFollow, /player\?\.|playSong|togglePlayback/, 'following never plays');
  assert.match(app, /updatePlayingRows\(\);\s*followLocalSong\(previous, state\.currentTrack\?\.id\);\s*\}\);/);
  // The button says what it will do.
  const button = body(app, 'function syncPlayButton() {', '\nfunction ');
  assert.match(button, /const label = wanted \? "播放这首"/);
  assert.match(button, /button\.setAttribute\("aria-pressed", String\(!wanted && playback === "playing"\)\);/);
  assert.match(button, /button\.disabled = !wanted && !externalMedia\.offers\("toggle"\) && !netease\.queueSongToPlay\(playsCurrent\(\)\);/, 'not dimmed while a control is on its way');
  // The label follows a selection still pending (a detail switch), which the button already acts on.
  assert.match(app, /presentation\.select\(\{ index: wrap\(index, records\.length\), navigation, route \}, openAfter\);\s*\/\/[^\n]*\n\s*syncPlayButton\(\);/);
  // NetEase changing song by itself leaves a user browsing elsewhere where they are; the shelf
  // goes with it only while the selection was on the playing song.
  const follow = method('followQueue() {');
  assert.doesNotMatch(follow, /queueFollowPaused = false;[\s\S]*\} else if|if \(!queueBrowsing\(\)\)/);
  assert.match(follow, /if \(index === cursor\) \{\s*this\.queueFollowPaused = false;\s*return;\s*\}\s*if \(this\.queueFollowPaused\) return;/);
  // Following moves the selection the way it always did, and only while the shelf may move.
  assert.match(follow, /if \(!key \|\| !this\.host\.canFollow\(\)\) return;/);
  assert.match(app, /canFollow: \(\) => ready && !boot\?\.active && !panel && !libraryRebuilding,\s*follow: \(index, from\) => select\(index, rowNavigation\(from, index\)\),/);
  // ... except when NetEase answers the user's own play request with another song (a skipped one).
  assert.match(follow, /\} else if \(!this\.queueJumpsSuperseded\.delete\(key\)\) \{[^}]*if \(this\.queueJump \|\| now - this\.followNextAt < QUEUE_JUMP_TIMEOUT_MS\) this\.queueFollowPaused = false;/);
  // The header and the details show NetEase's own state when the port answers.
  assert.match(session, /return isNeteaseSource\(source\) && this\.debugState\.available && this\.debugState\.playback \? this\.debugState\.playback : source\?\.playback;/);
  assert.match(app, /function mediaPlayback\(source = externalMedia\?\.selected\) \{\s*return netease\.playback\(source\);\s*\}/);
  assert.equal((app.match(/mediaConnectionLabel\(externalMedia, mediaPlayback\(\)\)/g) || []).length, 2, 'the status lines too');
});

test('NetEase\'s answer to a play / pause is read again within a few hundred milliseconds', () => {
  const refresh = body(app, 'async function refreshExternal() {', '\nasync function controlExternal');
  // A read asked for while one runs is not dropped: it runs right after.
  assert.match(refresh, /if \(externalRefreshing\) \{\s*externalRefreshAgain = true;\s*return;\s*\}/);
  assert.match(refresh, /const delay = externalRefreshAgain \? 0 : confirmUntil \? CONFIRM_STEP_MS : document\.hidden \? 2000 : 1000;/);
  // Quick reads until the state changes, for at most 1.5 s; the same reads as the poll's.
  assert.match(app, /const CONFIRM_STEP_MS = 150, CONFIRM_MS = 1500;/);
  assert.match(refresh, /if \(confirmUntil && \(performance\.now\(\) >= confirmUntil \|\| playbackKey\(\) !== confirmFrom\)\) confirmUntil = 0;/);
  const control = body(app, 'async function controlExternal(', '\nfunction ');
  assert.match(control, /if \(action !== "seek"\) confirmSoon\(\);\s*const pending = externalMedia\.control\(action, position\);/);
  // Still no invented state: the button changes when NetEase says so.
  assert.doesNotMatch(app, /aria-pressed", "true"|optimistic/);
});

test('the selected playlist\'s column comes toward the lens, with the columns in front of it', () => {
  // The owner (2026-10-05): "move the entire selected playlist closer to the viewer".
  const forward = Number(/export const MUSIC_COLUMN_FORWARD = ([\d.]+);/.exec(scene)?.[1]);
  assert.ok(forward >= 1.5 && forward <= 5.2, `forward (${forward})`);
  assert.doesNotMatch(scene, /MUSIC_PREVIEW_SHIFT|MUSIC_MAKE_ROOM|shelfShift/, 'no single case leaves its column any more');
  // The selected column and every column in front (a smaller lane is nearer the lens): they move
  // together, so none meets another; the gap opens behind the selected one. It glides with the focus.
  assert.match(scene, /const columnForward = \(lane: number\) => forward \* THREE\.MathUtils\.smoothstep\(this\.laneFocus\.value - lane \+ 1, 0, 1\);/);
  // On the shelf only: undone in the details and the song scene, eased in with the intro.
  assert.match(scene, /\? \(cinematic \? \(musicIntro \? introSettle : 0\) : 1\) \* \(1 - detail\) \* \(1 - songProgress\) \* MUSIC_COLUMN_FORWARD/);
  // Every case of a column, after the song pose (which reads a case's own place): the shelf, the lifted case, the returning copies.
  assert.match(scene, /const chained = songProgress > 0 \? this\.poseSongCase\(this\.dummy, this\.dummy\.position\.y, songProgress\) : true;\s*if \(forward\) this\.dummy\.position\.x -= columnForward\(lane\);/);
  assert.match(scene, /if \(songProgress > 0\) this\.poseSongCase\(o\.group, baseY, songProgress, copyHold\);\s*\/\/[^\n]*\n\s*o\.group\.position\.x -= columnForward\(o\.cell\.lane\);/);
  // The names' slots (2026-10-06: fixed places on the screen) are worked out from the shelf at
  // rest: the columns where they stand once they have come toward the lens, seen over the wider
  // gap behind the selected one, across the whole width of the column in front, the lifted case included.
  assert.match(scene, /const ahead = \(lane: number\) => MUSIC_COLUMN_FORWARD \* THREE\.MathUtils\.smoothstep\(1 - lane, 0, 1\);/);
  assert.match(scene, /edge: \(lane\) => lane \* COLUMN_SPACING - ahead\(lane\) - MUSIC_MODEL\.width \/ 2,/);
  assert.match(scene, /gap: \(lane\) => COLUMN_SPACING - ahead\(lane\) \+ ahead\(lane - 1\) - MUSIC_MODEL\.width - LANE_LABEL\.stand,/);
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
  // The details' two ways out stand together at the left (the 2026-10-05 design), as the song scene's do.
  assert.match(app, /<section id="music-detail"[^>]*>\s*<div class="detail-exits">\s*<button class="music-back" data-action="back"><span>← 返回专辑架<\/span> <kbd>ESC<\/kbd><\/button>\s*<button class="music-back detail-songs" data-action="songs"><span>↗ <span id="detail-songs-label">/);
  const song = songSceneMarkup();
  assert.match(song, /<button class="music-back" data-action="back"><span>← <span id="song-back-label">返回专辑架<\/span><\/span> <kbd>ESC<\/kbd><\/button>/);
  assert.match(song, /<button class="music-back song-details" data-action="details"><span>↗ <span id="song-details-label">专辑详情<\/span><\/span> <kbd>S<\/kbd><\/button>/);
  // Every case is a song (NetEase's, or a local playlist's): the song scene's way to the details names it.
  assert.match(app, /\$\("#song-details-label"\)\.textContent = "这首歌";/);
});

test('clicking the selected case opens its details; it never plays or pauses', () => {
  const select = body(app, 'scene.onSelect = (index, cell, lifted) => {', 'scene.onNavigate');
  assert.match(select, /if \(lifted && \(presentation\.phase === "archive" \|\| songScene\)\) return showDetails\(\);/);
  assert.doesNotMatch(select, /togglePlayback|controlExternal|player\?\./, 'no playback from a click on a case');
  // A live card without a queue opens its details too (the check comes before the queue's).
  assert.ok(select.indexOf('return showDetails()') < select.indexOf('if (externalMode && !netease.shownQueue()) return;'));
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

test('the overlay\'s chrome (2026-10-05 design): a text row or its menu form, the status in the now-playing slot, no readouts', () => {
  const css = readFileSync(new URL('../src/music-chrome.css', import.meta.url), 'utf8');
  // The wordmark alone (no subtitle, no link); no bottom line, library count or visible frame rate.
  assert.match(app, /<span class="music-brand"><strong>RHINE LAB<\/strong><\/span>/);
  // Keyboard focus in the header and on the counter steps is the scenes' thin ink ring, not the accent.
  assert.match(css, /\.music-app \.music-header :is\(button, a\):focus-visible,\s*\.music-app \.album-stepper > button:focus-visible \{\s*outline: 1px solid var\(--ink\);\s*\}/);
  assert.doesNotMatch(app, /music-bottomline|id="library-count"|id="runtime-info"/);
  assert.match(app, /\$\("#three-scene"\)\.dataset\.fps = String\(/, 'the frame rate stays as diagnostics');
  // The form follows the layout and the room the items really take (no width threshold): the
  // row where it fits, the menu form in portrait or where the compact row does not fit.
  assert.match(app, /let chrome: "row" \| "menu" = layout === "portrait" \? "menu" : "row", stacked = false;/);
  assert.match(app, /if \(chrome === "row" && layout === "compact" && space < ROW_TITLE_MIN\)/);
  // The status: in the slot while no song is there; under the wordmark only when unusual and
  // the slot holds a song. Skin mode words it as before (mediaConnectionLabel, counted above).
  assert.match(app, /const status = title \? "" : externalMedia \|\| libraryStatus\.unusual \? libraryStatus\.text : "";/);
  assert.match(app, /line\.hidden = !\(libraryStatus\.unusual && title\);/);
  // The playback colour is the player's word only: muted unless it says playing or paused.
  assert.match(css, /\.music-app \{\s*--state: var\(--muted\);\s*\}\s*\.music-app\[data-playback="playing"\] \{\s*--state: var\(--playing\);\s*\}\s*\.music-app\[data-playback="paused"\] \{\s*--state: var\(--paused\);\s*\}/);
  // Local previous / next are the player's own queue and move nothing on the shelf (no gesture).
  assert.match(app, /case "previous-track":\s*void player\?\.previous\(\);\s*break;\s*case "next-track":\s*void player\?\.next\(\);\s*break;/);
  // The menu form is a disclosure: open while the focus is in its list or on 菜单; the arrows move
  // along its items (not the shelf); the scene's keys close it before they act.
  assert.match(app, /!\$\("#topnav-modes"\)\.contains\(next\) && !\$\("\.topnav-menu-button"\)\.contains\(next\)/);
  assert.match(app, /if \(e\.key === "ArrowDown" \|\| e\.key === "ArrowUp"\) \{\s*e\.preventDefault\(\);[^}]*\.focus\(\);\s*return;\s*\}\s*if \(e\.key === "ArrowLeft" \|\| e\.key === "ArrowRight" \|\| e\.code === "KeyS"\) setChromeMenu\(false\);/);
  // The now-playing words reach assistive technology once (#now-status); the reel stays hidden.
  const reel = readFileSync(new URL('../src/music-transport-title.ts', import.meta.url), 'utf8');
  assert.match(app, /<span id="transport-track" class="transport-track" aria-hidden="true">[\s\S]{0,120}<span id="now-status" class="sr-only" role="status">/);
  assert.doesNotMatch(reel, /slot\.setAttribute\("aria-hidden"/);
  // The lifted case's screen box for the overlay: read on drawn frames, only on the shelf.
  assert.match(scene, /this\.liftedBox = musicLibrary && !cinematic && this\.model\.visible && records\.length > 0 &&\s*detail < 0\.001 && songProgress < 0\.001 \? this\.measureLiftedCase\(\) : null;/);
  assert.match(scene, /get liftedCaseRect\(\) \{\s*return this\.liftedBox;\s*\}/);
});

test('the details (2026-10-05 design): the page stays while its document swaps; NetEase\'s own controls; the album carried over', () => {
  const css = readFileSync(new URL('../src/music-detail.css', import.meta.url), 'utf8');
  const transitions = readFileSync(new URL('../src/ui-transitions.ts', import.meta.url), 'utf8');
  const title = readFileSync(new URL('../src/music-title.ts', import.meta.url), 'utf8');
  const focus = readFileSync(new URL('../src/music-track-focus.ts', import.meta.url), 'utf8');
  // No bottom-left card caption or drag hint: the code is the tag, the songs are the second exit.
  assert.doesNotMatch(app, /card-caption|detail-card-id|拖动卡片/);
  // Previous / next keep the page (the exits and the section label): only the document leaves,
  // 170 ms rising 6 px, and returns 250 ms after 70 ms, once the new case is drawn out (the gate).
  assert.match(transitions, /export const DETAIL_SWAP: SurfaceMotion = \{ from: "translateY\(-6px\)", to: "translateY\(-6px\)", enterDelay: 70, hold: true \};/);
  assert.match(transitions, /export const DETAIL_SCENE: SurfaceMotion = \{ from: "translateY\(6px\)", to: "translateY\(6px\)" \};/);
  assert.match(app, /new SurfaceTransition\(\s*\$\("#music-detail"\),\s*\$\("#music-detail"\),\s*420,\s*200,\s*DETAIL_SCENE,\s*\)/);
  assert.match(app, /new SurfaceTransition\(\s*\$\("#album-detail-content"\),\s*\$\("#album-detail-content"\),\s*250,\s*170,\s*DETAIL_SWAP,\s*\)/);
  const hide = body(app, '  hideMenu: (done) => {', '\n  hideBrowse:');
  assert.match(hide, /detailStay = presentation\.openingOrDetail && !menuSwapping && presentation\.pendingSelection\?\.route !== "archive"/);
  assert.match(hide, /if \(detailStay\) \{\s*\$\("#album-detail-content"\)\.inert = true;\s*documentSwap\.hide\(preferences\.reduced, done\);\s*return;\s*\}/);
  // Esc or a search while the document is away: the page leaves with the camera.
  assert.match(body(app, '  mode: (next) => {', '\n  prepareMenu:'), /detailStay = false;[\s\S]*detailTransition\.hide\(preferences\.reduced\);/);
  // The title has the shelf's reel (no per-character stagger), rolled in only when the document returns.
  assert.match(title, /export function setupDetailTitle\(title: HTMLElement\)/);
  assert.match(title, /const reels = createTitleReels\(visual, spacer\);[\s\S]*export function setupDetailTitle/);
  assert.match(app, /if \(detailStay\) \{\s*renderDetail\(\);\s*detailTitle\.hold\(\);\s*return;\s*\}/);
  assert.match(app, /detailTitle\.reveal\(swapped && !preferences\.reduced\);/);
  assert.doesNotMatch(app, /new DocumentDecryption\(\s*"h1/, 'the title is not redacted any more');
  // The transport row is NetEase's own (its play / pause and stop act on what plays, with the gesture);
  // the ring's words are in its name, never invented.
  assert.match(app, /<button data-media-action="toggle" id="detail-toggle" class="detail-control detail-toggle"/);
  assert.match(app, /<button data-media-action="stop" class="detail-control detail-stop"/);
  assert.doesNotMatch(body(app, 'function updateExternalControls() {', '\nfunction '), /textContent = toggleLabel/);
  // 网易云当前曲目 only when the document is rendered while the selection is not NetEase's song;
  // 正在切换… while a request waits. Once placed it keeps its place until the next document (the
  // controls below it never jump under the pointer); local mode's 正在播放 likewise.
  const rows = body(app, 'function updateQueueRows() {', '\nfunction ');
  assert.match(rows, /for \(const row of document\.querySelectorAll<HTMLElement>\("\[data-now-row\]"\)\) \{\s*if \(row\.dataset\.nowRow\) continue;\s*row\.dataset\.nowRow = "placed";\s*row\.hidden = playing;\s*\}/);
  assert.match(rows, /netease\.queueJump\?\.key === key && !!key \? "正在切换…"/);
  assert.match(app, /for \(const row of document\.querySelectorAll<HTMLElement>\("\[data-local-now-row\]"\)\) \{\s*if \(row\.dataset\.localNowRow\) continue;\s*row\.dataset\.localNowRow = "placed";\s*row\.hidden = !other;\s*\}/);
  // What the controls cannot do here stays on the page (nothing when the port plays the selection).
  assert.match(session, /return this\.host\.preferences\.neteaseControl && this\.debugState\.available && \(!lane \|\| lane\.live\) \? "" : this\.queueControlNote\(\);/);
  assert.match(rows, /const limit = netease\.shownQueue\(\) \? netease\.queueControlLimit\(\) : externalMedia\?\.selected \? LONE_TRACK_NOTE : "";/);
  // An unknown length keeps the words 播放位置: the times say — and the dashed line has 时长不可用 in its title.
  assert.match(app, /if \(label\) setText\(label, "播放位置"\);/);
  assert.match(app, /syncSeekFill\(slider, placed, !known \? "时长不可用"/);
  assert.match(css, /input\.detail-seek\[data-known="false"\]::-webkit-slider-runnable-track \{\s*background: repeating-linear-gradient/);
  // Local songs (2026-10-06): the same document; the ring plays this song, or pauses / resumes it
  // once it is the one loaded (with the gesture); previous / next the header's; four facts with
  // Chinese keys; the album's introduction only when it is about this song's album.
  assert.match(app, /case "local-toggle":\s*toggleLocal\(\);\s*break;/);
  const local = body(app, 'function toggleLocal() {', '\nfunction ');
  assert.match(local, /if \(localSongWaits\(\)\) playSong\(\);\s*else if \(playerState\?\.currentTrack\) void player\.toggle\(\);\s*else return;/);
  assert.match(local, /scene\?\.playGesture\(\);\s*if \(records\.length\) tickMotion\.ripple\(\);/);
  assert.match(app, /detailFact\("专辑"[^\n]*detailFact\("年份"[^\n]*detailFact\("格式"[^\n]*detailFact\("时长"/);
  assert.match(app, /if \(!song \|\| !album\?\.description \|\| !introductionFits\(song\)\) return "";/);
  // The case does not carry its album's introduction: one that arrives while the details are open
  // redraws them (the library refresh compares the song's album record too, not only the case).
  assert.match(body(app, 'function detailKey() {', '\n}'), /const album = localSong\(\)\?\.album;\s*return JSON\.stringify\(\[currentAlbum\(\), album && \[album\.id, album\.title, album\.description, album\.descriptionSource\]\]\);/);
  const refresh = body(app, 'async function applyLibrary() {', '\nfunction ');
  assert.match(refresh, /const previousDetail = detailKey\(\);/);
  assert.match(refresh, /if \(mode === "detail" && previousDetail !== detailKey\(\)\)\s*menu === "song" \? renderSongs\(\) : renderDetail\(\);/);
  assert.doesNotMatch(app, /RELEASE \/ 发行年份|ARTIST \/ 歌手/);
  // A search result's song: outlined with a 搜索结果 tag for 1100 ms, no accent pulse, no autoplay.
  assert.match(focus, /tag\.textContent = "搜索结果";/);
  assert.match(focus, /hold = setTimeout\(cancel, 1100\);/);
  assert.doesNotMatch(focus, /--accent|search-track-tint/);
  // Placement follows data-layout; width queries only size (large windows, narrow portrait); short
  // windows (desktop and compact, 700 px or less) put the two ways out on one line above the case.
  assert.deepEqual([...css.matchAll(/@media ([^{]+)\{/g)].map((m) => m[1].trim()), ['(min-width: 1700px)', '(max-height: 700px)', '(max-width: 700px)']);
  assert.match(css, /@media \(max-height: 700px\) \{\s*\.music-app:is\(\[data-layout="desktop"\], \[data-layout="compact"\]\) \.detail-exits \{\s*flex-direction: row;/);
  assert.match(css, /\.music-app #album-detail-content \{[^}]*left: 52%;[^}]*right: max\(60px, calc\(48% - 632px\)\);/);
  assert.match(css, /\.music-app\[data-layout="portrait"\] \.detail-exits \{[^}]*flex-direction: row;/);
});

test('the shelf (2026-10-05 design): tag, facts, a play ring with its note, the playlist list, counter and ruler, hints, bracket', () => {
  const css = readFileSync(new URL('../src/music-shelf.css', import.meta.url), 'utf8');
  const ruler = readFileSync(new URL('../src/music-ruler.ts', import.meta.url), 'utf8');
  const ticks = readFileSync(new URL('../src/music-ticks.ts', import.meta.url), 'utf8');
  // The old callout pieces and the column stepper are gone; the list takes over the stepper's ids.
  assert.doesNotMatch(app, /music-eyebrow|selection-rule|id="selection-genre"|id="selection-format"|genre-stepper|id="genre-name"|data-action="genres"/);
  assert.match(app, /<span id="selection-code" class="selection-tag"><span id="selection-code-label">/);
  assert.match(app, /<section id="playlist-drum" class="playlist-drum"[^>]*hidden>\s*<div class="drum-head"><span id="genre-position" class="drum-position"><span id="genre-code">/);
  // The shelf's 42 px ring is the header's play / pause: the same action, label, state and ring.
  assert.match(app, /<button data-action="play-pause" id="shelf-play" class="play-ring play-ring-big"/);
  assert.match(body(app, 'function syncPlayButton() {', '\nfunction '), /for \(const button of document\.querySelectorAll<HTMLButtonElement>\("#play-pause, #shelf-play"\)\)/);
  assert.match(body(app, 'function syncRing() {', '\nfunction '), /document\.querySelectorAll<HTMLElement>\("#play-pause, #shelf-play"\)/);
  // Its note: the playing song's number, 正在切换… while NetEase has not answered, 只供浏览 in a playlist column.
  const note = body(app, 'function syncPlayNote() {', '\nfunction ');
  assert.match(note, /else if \(lane && !lane\.live\) text = "只供浏览";\s*else if \(netease\.queueJump\?\.key === key\) text = "正在切换…";/);
  // The play gesture brings the ruler's ripple (never with reduced motion, nor for previous / next).
  for (const name of ['function togglePlayback() {', 'function toggleExternal() {', 'function stopPlayback() {'])
    assert.match(body(app, name, '\nfunction '), /scene\?\.playGesture\(\);\s*if \(records\.length\) tickMotion\.ripple\(\);/);
  assert.doesNotMatch(body(app, 'case "previous-track":', 'case "topnav-menu":'), /ripple/);
  assert.match(ruler, /ripple\(\) \{\s*const box = host\.parentElement;\s*if \(disposed \|\| instantMotion\(\) \|\| !box\) return;/);
  assert.match(ticks, /setPlaying\(_index: number \| undefined\) \{\},\s*ripple\(\) \{\},/, 'the earlier navigation (?nav=previous) keeps working');
  // The ruler: 13 ticks, the selection always the centre one; short columns show their own ticks only.
  assert.match(ruler, /const CAPACITY = 13;/);
  assert.match(ruler, /const ANCHOR = 6;/);
  assert.match(ruler, /scrollTarget = selectedOrdinal - ANCHOR;\s*scroll\.value = scrollTarget;/);
  assert.match(ruler, /const validOrdinal = \(ordinal: number\) => items\.length > 0 &&\s*\(overflowing\(\) \|\| \(ordinal >= 0 && ordinal < items\.length\)\);/);
  // The playlist list steps through stepGenre (as ← → do), its wheel turns it one column per notch
  // at most every 110 ms, and elsewhere the wheel still moves along the column.
  assert.match(app, /if \(target\.dataset\.laneStep !== undefined\) \{\s*const step = Number\(target\.dataset\.laneStep\);\s*if \(step && Number\.isInteger\(step\)\) stepGenre\(step\);/);
  assert.match(app, /const DRUM_WHEEL_STEP = 40, DRUM_WHEEL_GAP_MS = 110;/);
  const wheel = body(app, 'stage.addEventListener("wheel", (event) => {', '}, { passive: false });');
  assert.ok(wheel.indexOf('closest?.(".playlist-drum")') > 0 && wheel.indexOf('turnDrum(event)') < wheel.indexOf('wheelNavigation.push('), 'the list first, then the rows');
  assert.match(body(app, 'function turnDrum(', '\n}'), /stepGenre\(direction\);/);
  // The 110 ms are measured between the notches themselves, not between their handlers.
  assert.match(body(app, 'function turnDrum(', '\n}'), /const now = event\.timeStamp \|\| performance\.now\(\);/);
  // Moving never plays: the hint says 选歌, not 换歌; Space is a triangle, its words for screen readers.
  const hints = body(app, 'function keyHintMarkup(', '\n}');
  // Every case is a song in both modes (local folder playlists since 2026-10-06).
  assert.match(hints, /hint\("↑ ↓", "选歌"\)/);
  assert.doesNotMatch(hints, /换歌/);
  assert.match(css, /\.music-app\[data-layout="portrait"\] \.music-keyhint \{\s*display: none;/);
  // The bracket follows the scene's box of the lifted case on the shelf only.
  assert.match(app, /scene\.update\(ms \/ 1000, opening\?\.cinema\);\s*syncBracket\(\);/);
  assert.match(body(app, 'function syncBracket() {', '\n}'), /presentation\.phase === "archive" \? scene\?\.liftedCaseRect \?\? null : null/);
  // The right column ends above the key hints beside the bottom-left navigation; in portrait
  // (where the navigation spans the width) above the navigation, as before.
  const title = readFileSync(new URL('../src/music-title.ts', import.meta.url), 'utf8');
  assert.match(title, /const nextBottomGap = root\.dataset\.layout !== "portrait" && hints\?\.offsetHeight\s*\? root\.clientHeight - hints\.offsetTop \+ 24/);
  // A list that grows into the room left counts at its least in the title's budget.
  assert.match(title, /const grows = Number\.parseFloat\(style\.flexGrow\) > 0;/);
  // The design's 1.14 lines are shorter than the glyphs: the reels keep room under each face
  // for descenders (faces stack with that gap), and a long title's floor still fits two lines.
  const reels = readFileSync(new URL('../src/music-title-reels.ts', import.meta.url), 'utf8');
  assert.match(reels, /const DESCENT_ROOM = 0\.16;/);
  assert.match(reels, /y \+= value\.height \+ descentRoom\(value\.height\);/);
  assert.match(reels, /slot\.host\.style\.paddingBottom = `\$\{descentRoom\(lineHeight\)\}px`;/);
  assert.match(title, /const min = Math\.min\(base, floor, Math\.max\(14, budget \/ \(lineRatio \* 2\)\)\);/);
  // Placement follows data-layout; width queries only size (large windows inside the desktop layout).
  assert.deepEqual([...css.matchAll(/@media ([^{]+)\{/g)].map((m) => m[1].trim()), ['(max-height: 650px)', '(min-width: 1700px)', '(max-width: 700px)']);
  assert.match(css, /\.music-app \.album-callout \{[^}]*left: max\(60\.5%, calc\(100% - 568px\)\);[^}]*right: 40px;/);
});

test('the song scene (2026-10-05 design, direction B): one pane, its tab and reel, the rise, the wheel, the column name', () => {
  const css = readFileSync(new URL('../src/song-scene.css', import.meta.url), 'utf8');
  const transitions = readFileSync(new URL('../src/ui-transitions.ts', import.meta.url), 'utf8');
  const markup = songSceneMarkup();
  // The ways out stand together where the details' do; the song scene keeps its own two buttons.
  assert.match(markup, /<div class="song-exits">\s*<button class="music-back" data-action="back">/);
  assert.match(css, /\.song-exits \{\s*position: absolute;\s*left: var\(--scene-side\);\s*top: calc\(var\(--scene-top\) \+ 4px\);/);
  // The chrome and the pane rise 6 px into place (420 ms) and sink away (200 ms) with the individual
  // translate property: the pane's own transform is its turn, and the section never moves or fades.
  assert.match(transitions, /export const SONG_SCENE: SurfaceMotion = \{ from: "none", to: "none", rise: "0 6px" \};/);
  assert.match(app, /new SurfaceTransition\(\$\("#music-song"\), undefined, 420, 200, SONG_SCENE, undefined, songView\.fadeTargets\);/);
  // The tab: the playlist column's number (two digits in both modes) on the shelf's 460 ms reel, rolling only on screen.
  assert.match(app, /const songTabNumber = setupRollingNumber\(songView\.tabNumber, 2\);/);
  const render = body(app, 'function renderSongs() {', '\nfunction ');
  assert.match(render, /column: \{ number: fileLocation\(selected\)\.lane \+ 1, total: archiveColumns\.length \},/);
  // A local song lists its playlist: the column's number, a row per song selecting its case.
  assert.match(render, /\}\)\(\) : localSongModel\(\);/);
  assert.match(body(app, 'function localSongModel() {', '\n}'), /column: \{ number: fileLocation\(selected\)\.lane \+ 1, total: archiveColumns\.length \},/);
  assert.match(render, /songTabNumber\.update\(model\.tab\.number, !preferences\.reduced && !section\.hidden && section\.dataset\.transition !== "closed"\);/);
  // The tab's dot: the listed column holds NetEase's queue (always for the lone queue), or the listed local playlist what is loaded.
  assert.match(body(app, 'function syncSongRows(', '\nfunction '), /const live = queue \? !lane \|\| lane\.live : loaded >= 0 && fileLocation\(loaded\)\.lane === fileLocation\(selected\)\.lane;/);
  // Only the list keeps the wheel; the rest of the pane moves along the column like the scene around it.
  const wheel = body(app, 'stage.addEventListener("wheel", (event) => {', '}, { passive: false });');
  assert.match(wheel, /songView\.list\.contains\(event\.target as Node\)/);
  assert.doesNotMatch(app, /songView\.glass/);
  // The pane stays under the header's row (fitChrome writes where it ends).
  assert.match(body(app, 'function syncSongCard() {', '\n}'), /songView\.setCard\(songCardRect\([^\n]*\), chromeBottom\);/);
  // The steps say what they do in their tooltip as well as their name.
  assert.match(render, /\$\(id\)\.setAttribute\("aria-label", words\);\s*\$\(id\)\.title = words;/);
});
