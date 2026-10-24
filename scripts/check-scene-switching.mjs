import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { PLAY_GESTURE, playHop } from '../src/motion.ts';
import { MusicPresentation } from '../src/music-presentation.ts';
import { songSceneMarkup } from '../src/song-list.ts';
import { SHORTCUTS, shortcutTable } from '../src/shortcuts.ts';
import { joinShaped } from '../src/music-title.ts';

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
  const gesture = body(scene, '  playGesture({ hop = true }: { hop?: boolean } = {}) {', '  get songCardHop()');
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
  assert.match(css, /height: calc\(var\(--songs-card-top\) - var\(--songs-hop, 0px\) - var\(--songs-rail-start\)\);/);
  assert.match(css, /top: calc\(var\(--songs-card-bottom\) - var\(--songs-hop, 0px\)\);/);
  // Where the line would cross the header's wordmark side (回到当前's room included, 2026-10-17), it
  // starts 12 px under the header instead: a step, 0 or that.
  assert.match(css, /--songs-rail-start: clamp\(0px, calc\(\(var\(--identity-right, 0px\) \+ 16px - var\(--songs-rail-x\)\) \* 1000\), calc\(var\(--chrome-bottom, 0px\) \+ 12px\)\);\s*top: var\(--songs-rail-start\);/);
  assert.match(app, /stage\.style\.setProperty\("--identity-right", `\$\{Math\.round\(identity\)\}px`\);/);
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
  assert.match(app, /const sent = await pending;\s*if \(sent && \(action === "previous" \|\| action === "next"\)\) netease\.followNextAt = performance\.now\(\);/);
  assert.match(session, /if \(this\.queueJump \|\| now - this\.followNextAt < QUEUE_JUMP_TIMEOUT_MS\) this\.queueFollowPaused = false;\s*this\.followNextAt = -Infinity;/);
  const remote = body(app, 'function toggleExternal() {', '\nfunction ');
  assert.match(remote, /if \(!externalMedia\?\.can\("toggle"\)\) return;\s*void controlExternal\("toggle"\);\s*scene\?\.playGesture\(\);/);
  // Space is pause / resume (held down, once), unless the user gave it another key (设置 → 快捷键).
  assert.equal(shortcutTable({}).get('Space'), 'pause');
  assert.equal(SHORTCUTS.find((info) => info.id === 'pause').repeat, false);
  assert.match(body(app, 'function runShortcut(', '\n}'), /case "pause":\s*togglePlayback\(\);\s*return;/);
});

// The owner, 2026-10-08: "ring = pause/resume only" and Space with it, in the three scenes. This
// replaces the earlier rule that Space on a focused button (other than a song row) was that
// button's: the shelf focuses 查看这首歌 when it shows, so Space opened the details instead.
test('Space pauses or resumes in the three scenes whatever button has the focus; Enter activates it', () => {
  const keys = body(app, 'document.addEventListener("keydown", (e) => {', '\n});');
  // After the panels (the search, the settings, 播放器 …: Space and Enter are theirs) and the text
  // fields (a slider is not one), every key by its action (设置 → 快捷键), Space and Enter included.
  const press = keys.indexOf('if ((e.code === "Space" || e.key === "Enter") && !takesPress(e, action, target)) return;');
  assert.ok(press > keys.indexOf('if (panel) {') && press > keys.indexOf('"input:not([type=range]), textarea, select, [contenteditable=true]"') && press > keys.indexOf('const action = shortcutAt(e);'));
  // Their action comes first: the button is not pressed (Space's release is swallowed below).
  assert.match(keys, /&& !takesPress\(e, action, target\)\) return;\s*e\.preventDefault\(\);\s*if \(e\.code === "Space"\) spaceTaken = true;\s*if \(!e\.repeat \|\| shortcutInfo\(action\)\.repeat\) runShortcut\(action, e\);/);
  // But not where they stay the control's own; 查看这首歌 leaves a focused button its press; and
  // Enter presses the header's and a notice's buttons whatever it is bound to, so a keyboard still
  // reaches 设置 when the user gave Enter another action (the review, 2026-10-11).
  const takes = body(app, 'function takesPress(', '\n}');
  assert.match(takes, /if \(pressKeepsOwn\(target\)\) return false;\s*const control = target\.closest\("button, a"\);\s*if \(!control\) return true;\s*if \(action === "open"\) return false;\s*return !\(e\.key === "Enter" && !!control\.closest\("\.music-topnav, #music-toast"\)\);/);
  assert.match(app, /<nav class="music-topnav"[\s\S]*data-action="settings"[\s\S]*data-action="topnav-menu"[\s\S]*<\/nav>/, '设置 and the menu are in the header');
  // Ctrl or Win with Space or Enter is no shortcut and presses nothing where the key alone acts
  // (Chromium presses a focused button whatever the modifiers): before the lookup.
  const ctrl = keys.indexOf('if ((e.ctrlKey || e.metaKey) && !e.altKey');
  assert.ok(ctrl > keys.indexOf('if (target.matches("input[type=range]")') && ctrl < keys.indexOf('const action = shortcutAt(e);'));
  assert.match(keys, /\(e\.code === "Space" \|\| e\.key === "Enter"\)\) \{\s*const plain = shortcutKeys\.get\(eventCode\(e\)\);\s*if \(plain && takesPress\(e, plain, target\)\) \{\s*e\.preventDefault\(\);\s*if \(e\.code === "Space"\) spaceTaken = true;\s*\}\s*return;\s*\}/);
  // Alt+← and Alt+→ never take the page back to the other source's: a guard of its own, on the
  // window in the capture phase (before the opening, a key being set, panels and text fields).
  assert.match(app, /window\.addEventListener\("keydown", \(e\) => \{\s*if \(e\.altKey && \(e\.key === "ArrowLeft" \|\| e\.key === "ArrowRight"\)\) e\.preventDefault\(\);\s*\}, true\);/);
  assert.doesNotMatch(keys, /e\.altKey && \(e\.key === "ArrowLeft"/, 'not only where the scenes\' keys get to');
  // Nor the mouse's back and forward buttons (the review of 2026-10-23: they went back to the other
  // source's page, frozen mid-switch when it came from the back-forward cache). A source switch replaces
  // the page, so there is no entry to go back to (check-music-sources.mjs), and such a page starts again.
  assert.match(app, /window\.addEventListener\("mouseup", \(e\) => \{\s*if \(e\.button === 3 \|\| e\.button === 4\) e\.preventDefault\(\);\s*\}, true\);/);
  assert.match(app, /window\.addEventListener\("pageshow", \(e\) => \{\s*if \(e\.persisted\) location\.reload\(\);\s*\}\);/);
  assert.doesNotMatch(app, /location\.assign\(|history\.pushState\(/, 'no new entry in the page\'s history');
  // Under the loading cover (the start, a source switch) the scenes' keys and the wheel wait for it to go
  // (the review of 2026-10-23: Enter or P there played the first song unseen); the panels' keys before.
  assert.match(app, /\$\("#music-loading"\)\.remove\(\);\s*sceneShown = true;/);
  assert.equal((app.match(/\bsceneShown = true\b/g) || []).length, 1, 'only once the cover has gone');
  const shown = keys.indexOf('if (!sceneShown) return;');
  assert.ok(shown > keys.indexOf('if (panel) {') && shown < keys.indexOf('const target = e.target as HTMLElement;'));
  assert.match(body(app, 'function wheelCanNavigate() {', '\n}'), /return ready && sceneShown && !!scene/);
  assert.doesNotMatch(keys, /if \(e\.code === "Space"\) \{/, 'no Space of its own, nor one per focus');
  assert.doesNotMatch(keys, /closest\("#song-list"\)\)\) \{|Space stays play \/ pause on a playlist row/);
  assert.deepEqual([shortcutTable({}).get('Space'), shortcutTable({}).get('Enter')], ['pause', 'open']);
  // Where Space and Enter stay the focused control's: the header's open menu, the window's buttons, a page without songs (typing returned above).
  assert.match(body(app, 'function pressKeepsOwn(', '\n}'), /return stage\.dataset\.chromeMenu === "open" \|\| !!target\.closest\("\.window-bar"\)\s*\|\| \(!records\.length && !!target\.closest\("button, a"\)\);/);
  // The focused button is not clicked when Space is released (after any focus, not only a song row's).
  assert.match(app, /let spaceTaken = false;\s*document\.addEventListener\("keyup", \(e\) => \{\s*if \(e\.code !== "Space" \|\| !spaceTaken\) return;\s*spaceTaken = false;\s*e\.preventDefault\(\);\s*\}\);/);
  // Enter still activates the focused button (only away from one it opens the details, and since
  // 2026-10-09 plays their song: openCase).
  assert.match(body(app, 'function runShortcut(', '\n}'), /case "open":\s*openCase\(\);\s*return;/);
});

test('the play mode: browsing never switches the song; ▶ and P play the selection; the rings pause or resume what plays', () => {
  // No rest-to-play: a committed selection only updates the button.
  for (const source of [app, session]) assert.doesNotMatch(source, /scheduleQueueJump|jumpToSelectedSong|QUEUE_SETTLE_MS|queueJumpTimer|queueBrowsing/);
  const commit = body(app, 'function commitSelection(', '\nfunction ');
  assert.match(commit, /updateSelection\(navigation\);\s*syncPlayButton\(\);/);
  // The rings and Space (the owner, 2026-10-08: "ring = pause/resume only"): NetEase's own play /
  // pause, or, where it offers none, the port's action for the song it plays; never the selection.
  const toggle = body(app, 'function togglePlayback() {', '\nfunction ');
  assert.match(toggle, /if \(externalMedia\?\.offers\("toggle"\)\) \{\s*if \(!externalMedia\?\.can\("toggle"\)\) return;\s*void controlExternal\("toggle"\);\s*\} else \{\s*const current = playsCurrent\(\);\s*if \(!current\) return;\s*void netease\.playQueueSong\(current\);\s*\}/);
  // 本地音乐: the loaded song only; nothing loaded, nothing to do.
  assert.match(toggle, /\} else \{\s*if \(!player \|\| !loadedTrack\(\)\) return;\s*void player\.toggle\(\);\s*\}/);
  assert.doesNotMatch(toggle, /navigationSelection|playSong|queueSongToPlay|localSongWaits/, 'the rings never play the selection');
  // The playing song itself only when NetEase has no play / pause of its own (not merely busy) and
  // is not playing it: the port's action can start a song, never pause one.
  assert.match(app, /function playsCurrent\(\) \{\s*if \(externalMedia\?\.offers\("toggle"\) \|\| mediaPlayback\(\) === "playing"\) return undefined;\s*return netease\.queueSongToPlay\(true, playingRecord\(\)\);\s*\}/);
  const asked = method('async playQueueSong(');
  // (With its playlist it is: NetEase's queue becomes the playlist, which is waited for, answered.)
  assert.match(asked, /if \(key !== this\.queuePlaying \|\| playlist\) \{\s*if \(this\.queueJump\) this\.queueJumpsSuperseded\.set/, 'a request for the playing song is not a switch to wait for');
  assert.match(asked, /\.\.\.\(key === this\.queuePlaying \? \{ answered: true \} : \{\}\),/);
  // What may be asked (songRequest): a song of NetEase's queue as it is, or since 2026-10-10 a song of
  // another playlist column with its playlist (check-external-media.mjs runs both).
  const request = method('songRequest(');
  // Nothing while the media sessions cannot be read (no controls while retrying).
  assert.match(request, /const key = this\.host\.recordId\(index\);\s*\/\/[^\n]*\n\s*if \(!key \|\| !this\.shownQueue\(\) \|\| this\.host\.media\?\.unreadable\) return undefined;\s*const lane = this\.laneAt\(index\);/);
  assert.match(request, /if \(lane && !lane\.live\) \{[\s\S]*\/\/ The name NetEase stores \(its own 播放全部 hands over the same\), not the one shown\.\s*return \{ key: queueTrackKey\(song\), song, playlist: \{ id: lane\.id, name: lane\.sourceName \}, from: key \};\s*\}\s*const song = this\.queueSong\(key\);\s*return song \? \{ key, song \} : undefined;/);
  assert.match(app, /recordId: \(index\) => records\[index\]\?\.id,/, 'the record of a case, as before');
  const wanted = method('queueSongToPlay(');
  assert.match(wanted, /queueSongToPlay\(current = false, index = this\.host\.navigationSelection\(\)\) \{\s*const request = this\.songRequest\(index\);/);
  assert.match(wanted, /\(!request\.playlist && request\.key === this\.queuePlaying && !current\)/);
  assert.match(wanted, /if \(!this\.portPlays\(\)\) return undefined;/);
  // The port and not private FM (where the play button must not claim it plays the selection). No
  // switch (the owner, 2026-10-09: "do not make this a setting option").
  assert.match(method('portPlays() {'), /return this\.debugState\.available && this\.debugState\.mode !== "playFm";/);
  const play = method('async playQueueSong(');
  // The same queue action as before; for another playlist's song NetEase's own 播放全部 of it
  // (playPlaylist: the owner, 2026-10-10), and nothing else.
  assert.match(play, /if \(playlist\) await this\.ports\.debug\.playPlaylist\(playlist\.id, song\.id, playlist\.name\);\s*else await this\.ports\.debug\.play\(song\.id\);/);
  assert.equal((play.match(/this\.ports\.debug\./g) || []).length, 2);
  assert.match(play, /timeout: playlist \? PLAYLIST_JUMP_TIMEOUT_MS : QUEUE_JUMP_TIMEOUT_MS/);
  assert.match(session, /const NATIVE_PORTS: NeteasePorts = \{ queue: nativeQueuePort, playlists: nativePlaylistPort, debug: nativeDebugPort \};/);
  assert.match(play, /this\.host\.confirmSoon\(\);/);
  assert.match(app, /new NeteaseSession\(\{[\s\S]*?\n\s*confirmSoon,\s*refresh: refreshExternal,/, 'the app\'s quick reads and poll');
  // ▶ and P (the owner, 2026-10-07/08): what they do for a case (selectionPlay) and doing it
  // (playSelection). NetEase: its songs through the port (another playlist's with that playlist since
  // 2026-10-10), the paused current one resumed by its own play / pause where it has one; nothing for
  // a source with one card, nor for a song already asked for (the case it was asked from, too).
  const what = body(app, 'function selectionPlay(index: number)', '\nfunction ');
  assert.match(what, /if \(!netease\.shownQueue\(\)\) return undefined;/);
  assert.match(what, /if \(externalMedia\?\.offers\("toggle"\)\) return playback === "paused" \|\| playback === "stopped" \? "resume" : undefined;/);
  assert.match(what, /if \(netease\.isPending\(key\)\) return undefined;\s*return netease\.queueSongToPlay\(false, index\) \? "play" : undefined;/);
  assert.match(method('pendingKey() {'), /const jump = this\.queueJump;\s*if \(!jump\) return undefined;\s*return jump\.from && this\.host\.indexOf\(jump\.from\) >= 0 \? jump\.from : jump\.key;/);
  assert.doesNotMatch(app, /queueJump\?\.key ===/, 'every pending mark asks the session (pendingKey, isPending)');
  // 本地音乐: a song with a file the browser plays (not a demonstration cover, not offline, not ↗:
  // the review of 2026-10-08); the loaded one only while paused.
  assert.match(what, /if \(!song \|\| !album\?\.tracks\.length \|\| album\.offline \|\| !song\.track\.browserPlayable\) return undefined;\s*if \(loadedTrack\(\)\?\.id === song\.id\) return playerState\?\.transport === "paused" \? "resume" : undefined;\s*return "play";/);
  const doing = body(app, 'function playSelection(', '\n}');
  assert.match(doing, /const action = selectionPlay\(index\);\s*if \(!action\) return;/);
  // Another case is selected first, along its column (as a row's click); then it plays.
  assert.match(doing, /if \(index !== cursor\) \{\s*netease\.queueFollowPaused = true;\s*select\(index, rowNavigation\(cursor, index\)\);\s*\}/);
  assert.match(doing, /const wanted = netease\.queueSongToPlay\(action === "resume", index\);\s*if \(!wanted\) return;\s*void netease\.playQueueSong\(wanted\);/);
  assert.doesNotMatch(doing, /orpheus|\.debug\.|media_control/, 'no new action for NetEase');
  // Local mode (each case a song of a folder playlist, 2026-10-06): the song, from which the player
  // continues through its playlist; the shelf goes with the player's next song only while the
  // selection rests on the one that was playing (never playing).
  assert.match(doing, /else if \(action === "resume"\) void player\?\.toggle\(\);\s*else \{\s*const song = localSong\(index\);\s*if \(!song\) return;\s*void player\?\.play\(song\.id, playlistQueue\(localShelf, song\)\);\s*\}/);
  // The details' own ring (2026-10-09, below): this song by ▶'s rules when another one (or none) is
  // loaded, else pause / resume; no second way of playing a local song.
  assert.match(app, /case "detail-play":\s*ringPlay\(selected\);\s*break;/);
  assert.doesNotMatch(app, /function playSong\(|localSongWaits|toggleLocal|"local-toggle"/);
  const localFollow = body(app, 'function followLocalSong(', '\n}');
  assert.match(localFollow, /if \(!from \|\| !to \|\| from === to \|\| !ready \|\| boot\?\.active \|\| panel \|\| libraryRebuilding\) return;/);
  assert.match(localFollow, /if \(records\[cursor\]\?\.id !== from\) return;/);
  assert.match(localFollow, /select\(index, rowNavigation\(cursor, index\)\);/);
  assert.doesNotMatch(localFollow, /player\?\.|playSong|togglePlayback/, 'following never plays');
  assert.match(app, /updatePlayingRows\(\);\s*followLocalSong\(previous, state\.currentTrack\?\.id\);\s*\}\);/);
  // The header's ring says what it does: pause or resume (the reason in its title when it cannot).
  const button = body(app, 'function pauseResumeRing(): RingWords {', '\n}');
  assert.match(app, /applyRing\(document\.querySelector<HTMLButtonElement>\("#play-pause"\), pauseResumeRing\(\)\);/);
  assert.match(button, /const label = playback === "playing" \? "暂停" : playback === "unknown" \? "播放 \/ 暂停（状态未知）" : playback === "paused" \? "继续" : "播放";/);
  assert.doesNotMatch(button, /播放这首|播放：|当前"|queueSongToPlay\(|navigationSelection|records\[|(?<!\.)\bselected\b/, 'never the selection');
  assert.match(button, /pressed: playback === "playing"/);
  assert.match(button, /const disabled = !externalMedia\?\.offers\("toggle"\) && !playsCurrent\(\);/, 'not dimmed while a control is on its way');
  assert.match(button, /disabled: !loaded,/, '本地音乐: disabled while nothing is loaded');
  assert.match(button, /: disabled \? \(consent \? "需先在“播放器”面板中允许发送全局媒体键" : `\$\{source\.name\}没有提供\$\{playback === "playing" \? "暂停" : "播放 \/ 暂停"\}`\)/);
  assert.match(button, /title: loaded \? `\$\{label\}：\$\{loaded\.title\}` : "没有正在播放的歌"/);
  // P, L, ● and the key hints follow a selection still pending (a detail switch), which they already act on.
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
  assert.match(follow, /\} else if \(!unanswered && !this\.queueJumpsSuperseded\.delete\(key\)\) \{[^}]*if \(this\.queueJump \|\| now - this\.followNextAt < QUEUE_JUMP_TIMEOUT_MS\) this\.queueFollowPaused = false;/);
  // ... but not while NetEase still plays the song it played when asked: the case changed with the
  // queue (a 播放全部 replaced it), not because NetEase answered (2026-10-12).
  // A reading the port did not give (late: NetEase busy, or an error) cannot tell NetEase answered either.
  assert.match(follow, /const unanswered = !!this\.queueJump\?\.fromTrack\s*&& \(this\.debugState\.available \? this\.debugState\.trackId === this\.queueJump\.fromTrack : !!this\.debugError\);/);
  // A playlist's 播放全部 whose song plays before NetEase saved the playlist as its queue stands (answered)
  // until the queue is read: not taken for NetEase changing song by itself.
  assert.match(follow, /if \(this\.queueJump\?\.answered\) \{\s*\/\/[^\n]*\n\s*this\.queueJumpsSuperseded\.clear\(\);\s*\} else if \(this\.queueJump\?\.key === key\) \{/);
  // The header and the details show NetEase's own state when the port answers.
  assert.match(session, /return isNeteaseSource\(source\) && this\.debugState\.available && this\.debugState\.playback \? this\.debugState\.playback : source\?\.playback;/);
  assert.match(app, /function mediaPlayback\(source = externalMedia\?\.selected\) \{\s*return netease\.playback\(source\);\s*\}/);
  assert.equal((app.match(/mediaConnectionLabel\(externalMedia, mediaPlayback\(\)\)/g) || []).length, 2, 'the status lines too');
});

test('NetEase\'s answer to a play / pause is read again within a few hundred milliseconds', () => {
  const refresh = body(app, 'async function refreshExternal() {', '\nasync function controlExternal');
  // A read asked for while one runs is not dropped: it runs right after.
  assert.match(refresh, /if \(externalRefreshing\) \{\s*externalRefreshAgain = true;\s*return;\s*\}/);
  // A new song whose position NetEase does not show yet (its slider still has the last song's) is read
  // again as quickly.
  assert.match(refresh, /const settling = sessionSettling\(performance\.now\(\)\);\s*const delay = externalRefreshAgain \? 0 : confirmUntil \|\| netease\.playbackClock\.settling\(performance\.now\(\)\) \|\| settling \? CONFIRM_STEP_MS\s*: document\.hidden \? 2000 : netease\.awaiting\(\) \? AWAITING_STEP_MS : 1000;/);
  // Quick reads until the state changes, for at most 1.5 s; the same reads as the poll's. A play request
  // NetEase has not answered where it was asked for (a playlist's 播放全部: its queue saved a moment after
  // the song starts) is read every 250 ms after that, until it is or the request lapses (2026-10-17).
  assert.match(app, /const CONFIRM_STEP_MS = 150, CONFIRM_MS = 1500, AWAITING_STEP_MS = 250;/);
  // A media session's new song without its timeline yet (QQ Music) is read every 150 ms, at most 5 s:
  // only a session that writes timelines, never NetEase's (its timeline is the port's: 2026-10-24).
  assert.match(body(app, 'function sessionSettling(now: number) {', '\n}'), /if \(!source \|\| source\.kind !== "smtc" \|\| source\.player === "netease"\) return false;[\s\S]*return sessionTimed === source\.id && source\.playback === "playing" && typeof source\.duration !== "number" && now - sessionSongAt < 5000;/);
  // Two quick actions: each change read confirms one, so the second is not left to the next second's
  // read (one change ended the quick reads, and NetEase's answer to the second waited up to a second).
  assert.match(refresh, /if \(confirmUntil\) \{[^}]*const key = playbackKey\(\);\s*(\/\/[^\n]*\n\s*)*const selectedNow = externalMedia\?\.selected, playbackNow = mediaPlayback\(selectedNow\) \?\? "unknown";\s*const passing = selectedNow\?\.kind === "smtc" && \(playbackNow === "unknown" \|\| \(confirmSkip && playbackNow === "stopped"\)\);\s*if \(key !== confirmFrom && !passing\) \{\s*confirmFrom = key;\s*confirmLeft--;\s*\}\s*if \(performance\.now\(\) >= confirmUntil \|\| confirmLeft <= 0\) \{\s*confirmUntil = 0;\s*confirmSkip = false;\s*\}/);
  assert.match(app, /function confirmSoon\(skip = false\) \{\s*if \(!confirmUntil\) \{\s*confirmSkip = skip;\s*confirmFrom = playbackKey\(\);\s*confirmLeft = 0;\s*\} else if \(skip && !confirmSkip\) \{\s*confirmSkip = true;\s*confirmFrom = playbackKey\(\);\s*\}\s*confirmLeft\+\+;\s*confirmUntil = performance\.now\(\) \+ CONFIRM_MS;\s*\}/);
  // 上一曲 / 下一曲 are answered by the song, not by the stopped / changing a player passes through
  // first (QQ Music, 2026-10-24: the new title waited for the next second's read).
  assert.match(app, /return JSON\.stringify\(\[confirmSkip \? "" : mediaPlayback\(source\) \?\? "", source\?\.title \?\? "", netease\.debugState\.trackId \?\? ""\]\);/);
  const control = body(app, 'async function controlExternal(', '\nfunction ');
  assert.match(control, /if \(action !== "seek"\) confirmSoon\(action === "previous" \|\| action === "next"\);\s*const pending = externalMedia\.control\(action, position\);/);
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
  // The names' slots (fixed places on the screen; 2026-10-08: the selected one flat by the lifted
  // case, the neighbours printed on their own columns) are worked out from the shelf at rest: the
  // lifted case and the column nearer the lens where they stand once they have come toward the
  // lens, the column further from it where it stays (scene.ts restBracket, lanePlaces).
  assert.match(scene, /const ahead = \(lane: number\) => MUSIC_COLUMN_FORWARD \* THREE\.MathUtils\.smoothstep\(1 - lane, 0, 1\);/);
  assert.match(scene, /edge: \(lane: number\) => lane \* COLUMN_SPACING - ahead\(lane\) - MUSIC_MODEL\.width \/ 2,/);
  assert.match(scene, /const ahead = MUSIC_COLUMN_FORWARD \* THREE\.MathUtils\.smoothstep\(1 - lane, 0, 1\);/);
  assert.match(scene, /lane \* COLUMN_SPACING - ahead \+ MUSIC_MODEL\.center\.x - MUSIC_MODEL\.width \/ 2,/);
});

test('every scene leads to the other two, with the same keys everywhere', () => {
  // Enter (and the selected case) opens the details; S switches to the song scene and back;
  // Esc returns to the shelf, from the details and from the song scene alike. Since 2026-10-09 ("also
  // play this song") every way into the details from the shelf or the song scene plays their song
  // (openCase, run below); S into the song scene plays nothing.
  assert.match(body(app, 'function toggleSongs() {', '\n}'), /if \(menu !== "song" \|\| returningToShelf\(\)\) openSongs\(\);\s*(\/\/[^\n]*\n\s*)?else openCase\(true, swapToDetail\);/);
  assert.match(body(app, 'function leaveMenu() {', '\n}'), /^function leaveMenu\(\) \{\s*setMode\("archive"\);\s*$/);
  assert.match(body(app, 'function showDetails() {', '\n}'), /if \(menu === "song" && !returningToShelf\(\)\) return swapToDetail\(\);\s*(\/\/[^\n]*\n\s*)?menuAfterReturn = undefined;\s*setMode\("detail"\);\s*return true;/);
  // S and Enter while the shelf returns after Esc (the text leaving, the camera returning) mean what they
  // mean on the shelf, and wait for it as there (the review of 2026-10-23: S was dropped for 1.6 s, and
  // Enter right after Esc from the song scene). A swap or a step inside an opened album keeps its refusals.
  assert.match(body(app, 'function returningToShelf() {', '\n}'), /return !presentation\.openingOrDetail && \(phase === "hiding" \|\| phase === "returning" \|\| phase === "selecting"\);/);
  const songs = body(app, 'function openSongs() {', '\n}');
  assert.match(songs, /\|\| \(menu === "song" && !returningToShelf\(\)\)\) return;\s*if \(presentation\.phase === "archive" \|\| returningToShelf\(\)\) \{\s*songOrigin = "archive";/);
  // While the text still leaves the menu is the leaving one's: the song scene comes with the shelf (the mode port).
  assert.match(songs, /if \(mode === "archive"\) setMenu\("song"\);\s*else menuAfterReturn = "song";\s*presentation\.open\(\);/);
  assert.match(body(app, '  mode: (next) => {', '\n  prepareMenu:'), /if \(next === "archive"\) \{\s*setMenu\(menuAfterReturn && presentation\.openingOrDetail \? menuAfterReturn : "detail"\);\s*menuAfterReturn = undefined;/);
  assert.match(body(app, 'function select(', '\n}'), /if \(route === "archive"\) menuAfterReturn = undefined;/, 'a search result opens the details');
  // The song scene swaps to the details wherever it was opened from.
  assert.doesNotMatch(body(app, 'function swapToDetail() {', '\n}'), /songOrigin/);
  assert.match(app, /if \(e\.key === "Escape" && panel\) \{\s*closePanel\(\);\s*return;\s*\}/);
  assert.equal(shortcutTable({}).get('Escape'), 'back');
  assert.match(body(app, 'function runShortcut(', '\n}'), /case "back":\s*leaveMenu\(\);\s*return;/);
  assert.equal(shortcutTable({}).get('KeyS'), 'songs', 'S, unless the user gave 播放列表 another key (设置 → 快捷键)');
  assert.match(body(app, 'function runShortcut(', '\n}'), /case "songs":\s*toggleSongs\(\);\s*return;/);
  // Enter away from a button: the details, from the song scene too.
  assert.match(body(app, 'function takesPress(', '\n}'), /if \(action === "open"\) return false;/);
  assert.match(body(app, 'function runShortcut(', '\n}'), /case "open":\s*openCase\(\);\s*return;/);
  // 查看这首歌 opens them as it did (setMode), the song scene's 这首歌 by swapping (showDetails); a pointer
  // press that closed the header's open menu only opens (a key's click has no detail).
  assert.match(app, /case "open":\s*openCase\(!\(e\.detail > 0 && pressClosesMenu\), \(\) => setMode\("detail"\)\);\s*break;\s*case "songs":\s*toggleSongs\(\);\s*break;\s*case "details":\s*openCase\(!\(e\.detail > 0 && pressClosesMenu\)\);\s*break;\s*case "back":\s*leaveMenu\(\);/);
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

// The owner, 2026-10-08: "scene1: when I click a box to enter scene2, it should just switch to that
// song and play it". This replaces the rule of 2026-10-04 that clicking the selected case never
// plays: on the shelf it opens the details and plays the song as ▶ does. Since 2026-10-09 ("also play
// this song") the song scene's large card does too, as do Enter, 查看这首歌, 这首歌 and S from there.
test('clicking the selected case opens its details and plays it as ▶ does, never pauses', () => {
  const select = body(app, 'scene.onSelect = (index, cell, lifted) => {', 'scene.onNavigate');
  assert.match(select, /if \(lifted && presentation\.phase === "archive"\) return openCase\(!pressClosesMenu\);\s*if \(lifted && songScene\) return openCase\(!pressClosesMenu\);/);
  assert.doesNotMatch(select, /togglePlayback|controlExternal|player\?\.|playSelection|selectionPlay|showDetails/, 'the case plays and opens only through openCase');
  // A live card without a queue opens its details too (the checks come before the queue's).
  assert.ok(select.indexOf('return openCase(!pressClosesMenu)') < select.indexOf('if (playerCurrent && !netease.shownQueue()) return;'));
  assert.ok(select.lastIndexOf('return openCase(!pressClosesMenu)') < select.indexOf('if (playerCurrent && !netease.shownQueue()) return;'));
  // openCase: ▶'s own rules (selectionPlay: the song that plays goes on, a column only for browsing,
  // the port down, private FM, a source with one card have nothing to play) and its way of playing
  // (playSelection: 本地音乐's player, NetEase's 播放队列中这首歌 or its own play / pause for the
  // paused song it plays, the waves without the hop), through requestPlay (which says why where the
  // port may not be used: 2026-10-09, below), for the selected case only, not for the press that
  // closed the header's open menu; and the details. The rows the wheel still owes go: they would carry
  // the details away from the song that was clicked and plays. (Run with stand-ins below.)
  const open = body(app, 'function openCase(play = true, open: () => boolean | void = showDetails) {', '\n}');
  // From the shelf (also on its way back after Esc: ↓ then Enter) the song the details open on plays,
  // where the selection is going (the review of 2026-10-23); a library rebuild holds it (only the details).
  assert.match(open, /if \(presentation\.openingOrDetail && menu === "detail"\) return void open\(\);\s*(\/\/[^\n]*\n\s*)*const shelf = menu !== "song" \|\| returningToShelf\(\);\s*const index = shelf && !libraryRebuilding \? navigationSelection\(\) : selected;\s*const plays = play && navigationSelection\(\) === index;\s*wheelNavigation\.reset\(\);/);
  assert.doesNotMatch(open, /togglePlayback|controlExternal|player\?\.|playQueueSong|toggle|playSelection/, 'never a pause, nothing but ▶\'s play');
  assert.match(body(app, 'function requestPlay(', '\n}'), /if \(selectionPlay\(index\)\) \{\s*playSelection\(index, hop\);\s*return true;\s*\}\s*explainNoPlay\(index\);\s*return false;\s*$/);
  // A playing song is not one ▶ plays (so a click never pauses it), nor the one NetEase was just asked for.
  const rule = body(app, 'function selectionPlay(', '\n}');
  assert.match(rule, /if \(externalMedia\?\.offers\("toggle"\)\) return playback === "paused" \|\| playback === "stopped" \? "resume" : undefined;/);
  assert.match(rule, /if \(netease\.isPending\(key\)\) return undefined;/);
  assert.match(rule, /if \(loadedTrack\(\)\?\.id === song\.id\) return playerState\?\.transport === "paused" \? "resume" : undefined;/);
  // Enter (away from a button), 查看这首歌, the song scene's 这首歌 and S from there open the details and
  // play (the owner, 2026-10-09: "also play this song"); every way into the details goes through openCase.
  assert.match(body(app, 'function takesPress(', '\n}'), /if \(action === "open"\) return false;/);
  assert.match(body(app, 'function runShortcut(', '\n}'), /case "open":\s*openCase\(\);\s*return;/);
  assert.match(app, /case "open":\s*openCase\(!\(e\.detail > 0 && pressClosesMenu\), \(\) => setMode\("detail"\)\);\s*break;/);
  assert.match(app, /case "details":\s*openCase\(!\(e\.detail > 0 && pressClosesMenu\)\);\s*break;/);
  assert.equal((app.match(/(?<!function )\bshowDetails\(\)/g) || []).length, 0, 'showDetails is openCase\'s default, not called around it');
  assert.equal((app.match(/(?<!function )\bswapToDetail\(\)/g) || []).length, 1, 'showDetails\' own swap');
  assert.equal((app.match(/(?<!\.)\bsetMode\("detail"\)/g) || []).length, 2, 'showDetails\' and 查看这首歌\'s');
  // The second press of a double click: the presentation has left the shelf by then (open() is
  // synchronous), so onSelect answers nothing (a case of the shelf is selected only on the shelf).
  assert.match(select, /if \(!songScene && presentation\.phase !== "archive"\) return;/);
  const presentationSource = readFileSync(new URL('../src/music-presentation.ts', import.meta.url), 'utf8');
  assert.match(presentationSource, /open\(\) \{\s*this\.wantsDetail = true;\s*if \(this\.phase === "archive"\) \{\s*if \(this\.ports\.archiveReady\(\)\) this\.beginOpen\(\);\s*else \{[^}]*this\.phase = "selecting";/);
  assert.match(presentationSource, /private beginOpen\(\) \{\s*const revision = \+\+this\.revision;\s*this\.phase = "opening";/);
  // (Until 2026-10-10 the second press of a double press on the lifted case's own ▶ was kept from
  // opening the case; that ▶ is gone: "delete the marked button, we already have a play button on
  // the right".) Every press on the page reads, before the scene's canvas sees it (capture), whether
  // it closes the header's open menu (below), and nothing else.
  assert.doesNotMatch(app, /caseSecondPress|casePlayPress|casePlay\b/);
  assert.match(app, /const DOUBLE_PRESS = \{ ms: 500, px: 16 \} as const;/, 'the rings\' double press (ringPlay)');
  assert.match(app, /stage\.addEventListener\("pointerdown", \(\) => \{\s*pressClosesMenu = stage\.dataset\.chromeMenu === "open";\s*\}, true\);/);
});

// The review of 2026-10-23: after Esc, S did nothing until the shelf had settled (about 1.6 s), Enter
// right after Esc from the song scene did nothing, and Esc, ↓, Enter opened the new song's details
// while the old song went on. The app's own functions, run on the real presentation with stand-ins.
test('keys while the shelf returns after Esc: S and Enter mean what they mean on the shelf, and Enter plays the song it opens', () => {
  const fn = (name) => body(app, `function ${name}`, '\n}') + '\n}';
  const source = [
    fn('returningToShelf() {'), fn('openSongs() {'), fn('swapToDetail() {'), fn('toggleSongs() {'),
    fn('showDetails() {'), fn('setMode('), fn('openCase('), fn('navigationSelection() {'),
  ].join('\n');
  const modePort = body(app, '  mode: (next) => {', '\n  prepareMenu:');
  const { outputText } = ts.transpileModule(`
    let menu = "detail", mode = "archive", menuAfterReturn, songOrigin = "archive", menuSwapping = false;
    let songStay = false, pendingSongFocus = false, detailStay = false, selected = 4, libraryIntent;
    const libraryRebuilding = false, boot = undefined, ready = true, panel = null, viewer = undefined;
    const stage = { dataset: {} }, $ = () => ({ hidden: true, dataset: {}, setAttribute() {} });
    const preferences = { reduced: false }, detailTransition = { hide() {} }, scene = { setSongStage() {} };
    const syncSelectionMotion = () => {}, syncLyrics = () => {}, cancelSearchTrack = () => {};
    const songsAvailable = () => true, currentAlbum = () => ({}), wheelNavigation = { reset() {} };
    const requestPlay = (index, hop) => env.plays.push([index, hop]);
    function setMenu(next) { menu = next; }
    const ports = { ${modePort} };
    const presentation = new MusicPresentation({
      presentationReady: () => env.presentationReady, archiveReady: () => env.archiveReady,
      archiveInteractive: () => env.archiveInteractive, enterCamera() {}, returnCamera() {},
      select: ({ index }) => { selected = index; }, switchDetail: ({ index }) => { selected = index; },
      prepareMenu: () => env.log.push("prepare:" + menu), showMenu: () => env.log.push("show:" + menu),
      hideMenu: (done) => env.exits.push(done), hideBrowse: (done) => done(), showBrowse() {},
      mode: (next) => ports.mode(next),
    });
    ${source}
    return {
      presentation, toggleSongs, openCase, setMode,
      down: () => presentation.select({ index: navigationSelection() + 1 }, presentation.openingOrDetail),
      get state() { return { phase: presentation.phase, menu, selected, wants: presentation.openingOrDetail }; },
    };`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
  const start = (menu = 'detail') => {
    const env = { log: [], exits: [], plays: [], presentationReady: false, archiveReady: true, archiveInteractive: false };
    const run = new Function('MusicPresentation', 'env', outputText)(MusicPresentation, env);
    // A menu open and settled, then Esc: its text is leaving (the presentation's 'hiding').
    if (menu === 'song') run.toggleSongs(); else run.setMode('detail');
    env.presentationReady = true;
    run.presentation.update();
    assert.deepEqual([run.state.phase, run.state.menu], ['detail', menu]);
    env.log.length = 0;
    env.plays.length = 0;
    run.setMode('archive');
    assert.equal(run.state.phase, 'hiding');
    env.archiveReady = env.presentationReady = false;
    const left = () => env.exits.shift()();
    // The camera back, then the shelf settled.
    const settle = () => {
      env.archiveReady = env.archiveInteractive = true;
      for (let i = 0; i < 3; i++) run.presentation.update();
    };
    return { env, run, left, settle };
  };
  // S while the details' text leaves: the song scene opens once the shelf is back (not dropped).
  let t = start();
  t.run.toggleSongs();
  assert.deepEqual([t.run.state.menu, t.run.state.wants], ['detail', true], 'the leaving menu stays until it has left');
  t.left();
  assert.deepEqual([t.run.state.phase, t.run.state.menu], ['returning', 'song']);
  t.settle();
  assert.deepEqual([t.run.state.phase, t.env.log], ['opening', ['prepare:song']]);
  assert.deepEqual(t.env.plays, [], 'S plays nothing');
  // S while the camera returns.
  t = start();
  t.left();
  t.run.toggleSongs();
  t.settle();
  assert.deepEqual([t.run.state.phase, t.run.state.menu, t.env.log], ['opening', 'song', ['prepare:song']]);
  // Enter right after Esc from the song scene: the details open (and their song plays), as from the shelf.
  t = start('song');
  t.run.openCase();
  assert.deepEqual(t.env.plays, [[4, false]]);
  t.left();
  t.settle();
  assert.deepEqual([t.run.state.phase, t.run.state.menu, t.env.log], ['opening', 'detail', ['prepare:detail']]);
  // S right after Esc from the song scene: the song scene again, once the shelf is back.
  t = start('song');
  t.run.toggleSongs();
  t.left();
  t.settle();
  assert.deepEqual([t.run.state.phase, t.run.state.menu, t.env.log], ['opening', 'song', ['prepare:song']]);
  // Esc, ↓, Enter: the details open on the song ↓ went to, and that song plays (not the one that left).
  for (const early of [true, false]) {
    t = start();
    if (!early) t.left();
    t.run.down();
    t.run.openCase();
    assert.deepEqual(t.env.plays, [[5, false]], early ? 'its text leaving' : 'the camera returning');
    if (early) t.left();
    t.settle();
    assert.deepEqual([t.run.state.phase, t.run.state.selected, t.env.log], ['opening', 5, ['prepare:detail']]);
  }
  // Esc, S, Esc: the shelf, with the details as its menu again; nothing opens.
  t = start();
  t.run.toggleSongs();
  t.run.setMode('archive');
  t.left();
  t.settle();
  assert.deepEqual([t.run.state.phase, t.run.state.menu, t.env.log], ['archive', 'detail', []]);
  // Esc, S, Enter: the details instead (the song scene was only asked for).
  t = start();
  t.run.toggleSongs();
  t.run.openCase();
  t.left();
  t.settle();
  assert.deepEqual([t.run.state.phase, t.run.state.menu, t.env.log], ['opening', 'detail', ['prepare:detail']]);
  // A swap inside an opened album keeps its refusal: S while the details are still opening does nothing.
  const env = { log: [], exits: [], plays: [], presentationReady: false, archiveReady: true, archiveInteractive: true };
  const opening = new Function('MusicPresentation', 'env', outputText)(MusicPresentation, env);
  opening.setMode('detail');
  opening.toggleSongs();
  assert.deepEqual([opening.state.phase, opening.state.menu], ['opening', 'detail']);
});

// The review of 2026-10-23: the focus fell to <body> as a scene changed with 减少动态效果 on, and as a
// panel closed whose opener could not have it back.
test('the focus is never left on the page: reduced motion, a panel closing, a scene that cannot take it yet', () => {
  const css = readFileSync(new URL('../src/music.css', import.meta.url), 'utf8');
  // Reduced motion has no transitions at all: a 1 ms one kept a surface just shown visibility: hidden
  // for a frame, where its focus() did nothing. (The ?original=1 entry's style.css rule is its own.)
  const reduced = /\.music-app\.reduce-motion \* \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(reduced, /transition-duration: 0s !important;/);
  assert.doesNotMatch(reduced.replace(/\/\*[\s\S]*?\*\//g, ''), /transition-duration: (?!0s)/);
  assert.match(readFileSync(new URL('../src/style.css', import.meta.url), 'utf8'), /\.reduce-motion \* \{[^}]*transition-delay: 0s !important;/, 'and no delay');
  // The details' document (or its ‹ ›) and the shelf's 查看这首歌 try again where the focus was left on
  // the page: the details for a few frames at most (the loop does not rest meanwhile), the shelf once.
  assert.match(app, /pendingDetailFocus = \(!document\.activeElement \|\| document\.activeElement === document\.body\) && \+\+detailFocusTries < 6;/);
  // (A single card's new song rebuilds the shelf: focus outside the scenes, the header's, stays: 2026-10-24.)
  assert.match(body(app, '  showMenu: () => {', '\n  hideMenu:'), /pendingDetailFocus = !detailKeepFocus;\s*detailKeepFocus = false;\s*detailFocusTries = 0;/);
  assert.match(body(app, 'function showBrowseSurface(focus = true) {', '\n}'), /if \(!panel && focus\) \$\("\[data-action=open\]"\)\.focus\(\{ preventScroll: true \}\);\s*(\/\/[^\n]*\n\s*)?if \(!panel && focus && document\.activeElement === document\.body\) requestAnimationFrame\(\(\) => \{\s*if \(document\.activeElement === document\.body\) focusScene\(\);\s*\}\);/);
  assert.match(app, /const inScene = !!focused\?\.closest\("#music-browse, #music-detail, #music-song"\);\s*const sceneFocus = !focused \|\| focused === document\.body \|\| inScene \|\| !!focused\.closest\("#music-empty"\);/);
  assert.match(app, /\} else showBrowseSurface\(sceneFocus\);/);
  // A panel whose opener cannot have the focus back (none: the panel a source switch kept open over the
  // new page; a notice's button, gone with the notice) leaves it on the scene's selection.
  const close = body(app, 'function closePanel(', '\nfunction ');
  assert.match(close, /panelFocus\?\.focus\(\{ preventScroll: true \}\);\s*(\/\/[^\n]*\n\s*)*if \(!document\.activeElement \|\| document\.activeElement === document\.body\) focusScene\(\);/);
  const scene = body(app, 'function focusScene() {', '\n}');
  assert.match(scene, /if \(!albums\.length \|\| boot\?\.active \|\| panel\) return;/);
  assert.match(scene, /if \(presentation\.phase === "archive"\) \$\("\[data-action=open\]"\)\.focus\(\{ preventScroll: true \}\);\s*else if \(presentation\.phase === "detail" && menu === "song"\) songView\.focusCurrent\(\);\s*else if \(presentation\.phase === "detail"\) \$\("#album-detail-content"\)\.focus\(\{ preventScroll: true \}\);/);
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
  // In narrow windows a panel and the model viewer's header start below the strip; the intro's skip
  // button moves down with the header, whose row's end it stands at.
  const narrow = css.slice(css.indexOf('@media (max-width: 700px)'));
  assert.match(narrow, /\.music-app\[data-window-frame="custom"\] \.music-panel-scrim \{\s*padding-top: 40px;/);
  assert.match(narrow, /\.music-app\[data-window-frame="custom"\] \.viewer-header \{\s*top: 40px;/);
  assert.match(narrow, /\.music-app\[data-window-frame="custom"\] \.music-header,\s*\.music-app\[data-window-frame="custom"\] \.music-boot-skip \{\s*margin-top: 13px;/);
  // The skip button is the word 跳过 (the owner, 2026-10-17: "change this button's text just to 跳过 and
  // remove the box around it"): no border, no background, no focus ring.
  assert.match(musicBoot, /this\.skipButton\.textContent = "跳过";\s*this\.skipButton\.setAttribute\("aria-label", "跳过进场"\);/);
  assert.match(boot, /\.music-app \.music-boot-skip \{[^}]*border: 0;[^}]*background: none;/);
  assert.match(boot, /\.music-app \.music-boot-skip:focus-visible \{\s*outline: none;\s*\}/);
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
  assert.match(app, /if \(e\.key === "ArrowDown" \|\| e\.key === "ArrowUp"\) \{\s*e\.preventDefault\(\);[^}]*\.focus\(\);\s*return;\s*\}\s*if \(!!shortcutAt\(e\) && e\.code !== "Space" && e\.key !== "Enter"\) setChromeMenu\(false\);/);
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
  // The old song's title and body are out of reach at once; the tag row with its ‹ › only once the
  // document has faded, so a second press while it fades (a double click) adds up as ↓ does (the
  // review of 2026-10-23: it fell through the inert document to the canvas, which ignores it there).
  assert.match(hide, /if \(detailStay\) \{\s*(\/\/[^\n]*\n\s*)*\$\("#detail-title"\)\.inert = \$\("#detail-body"\)\.inert = true;\s*documentSwap\.hide\(preferences\.reduced, \(\) => \{\s*\$\("#album-detail-content"\)\.inert = true;\s*done\(\);\s*\}\);\s*return;\s*\}/);
  assert.match(body(app, '  showMenu: () => {', '\n  hideMenu:'), /content\.inert = \$\("#detail-title"\)\.inert = \$\("#detail-body"\)\.inert = false;/);
  // ‹ › pressed from the keyboard keep the focus: the new document's same button has it (a pointer's
  // press leaves it to the document, as before).
  assert.match(app, /case "prev":\s*case "next":\s*(\/\/[^\n]*\n\s*)*detailStepFocus = target\.classList\.contains\("detail-step"\) && e\.detail === 0 \? action : undefined;\s*stepAlbum\(action === "prev" \? -1 : 1\);\s*break;/);
  // (The details' player control that had the focus first: a single card's 下一曲 pressed from the keyboard.)
  assert.match(app, /const target = \(detailMediaFocus && document\.querySelector<HTMLElement>\(`#detail-body \[data-media-action="\$\{detailMediaFocus\}"\]:not\(:disabled\)`\)\) \|\|\s*\(detailStepFocus && document\.querySelector<HTMLElement>\(`#detail-head \[data-action="\$\{detailStepFocus\}"\]`\)\) \|\|\s*\$\("#album-detail-content"\);\s*target\.focus\(\{ preventScroll: true \}\);/);
  assert.match(hide, /detailStepFocus = detailMediaFocus = undefined;\s*detailKeepFocus = false;\s*\$\("#music-detail"\)\.inert = true;/, 'leaving the details forgets it');
  // A scan applied in place (or NetEase's queue growing) under the same song's open details: its tag
  // row says where the song now stands, of how many; only the row is written again, a focused ‹ › kept.
  assert.equal((app.match(/writeDetailHead\(songDetailHead\(\)\);/g) || []).length, 2, 'a local song\'s and NetEase\'s');
  assert.doesNotMatch(app, /\$\("#detail-head"\)\.innerHTML = detailHead\(/);
  assert.match(body(app, 'async function applyLibrary(', '\n}\n'), /menu === "song" \? renderSongs\(\) : renderDetail\(\);\s*(\/\/[^\n]*\n\s*)*else if \(mode === "detail" && menu === "detail"\) refreshDetailHead\(\);/);
  const head = body(app, 'function refreshDetailHead() {', '\n}\n');
  assert.match(head, /if \(markup === detailHeadShown\) return;/);
  assert.match(head, /writeDetailHead\(markup\);\s*if \(focused\) document\.querySelector<HTMLElement>\(`#detail-head \[data-action="\$\{focused\}"\]`\)\?\.focus\(\{ preventScroll: true \}\);/);
  assert.match(body(app, '  mode: (next) => {', '\n  prepareMenu:'), /detailStay = false;\s*detailStepFocus = detailMediaFocus = undefined;\s*detailKeepFocus = false;/, 'also with Esc during the swap');
  // Esc or a search while the document is away: the page leaves with the camera.
  assert.match(body(app, '  mode: (next) => {', '\n  prepareMenu:'), /detailStay = false;[\s\S]*detailTransition\.hide\(preferences\.reduced\);/);
  // The title has the shelf's reel (no per-character stagger), rolled in only when the document returns.
  assert.match(title, /export function setupDetailTitle\(title: HTMLElement\)/);
  assert.match(title, /const reels = createTitleReels\(visual, spacer\);[\s\S]*export function setupDetailTitle/);
  assert.match(app, /if \(detailStay\) \{\s*renderDetail\(\);\s*detailTitle\.hold\(\);\s*return;\s*\}/);
  assert.match(app, /detailTitle\.reveal\(swapped && !preferences\.reduced\);/);
  assert.doesNotMatch(app, /new DocumentDecryption\(\s*"h1/, 'the title is not redacted any more');
  // The transport row is NetEase's own (its previous, next and stop act on what plays, with the
  // gesture); the ring is a lone live track's own play / pause, and a song's own play button (a song
  // of NetEase's queue or playlists: ringPlay, 2026-10-09); its words are in its name, never invented.
  assert.match(app, /\? `<button data-action="detail-play" id="detail-toggle" class="detail-control detail-toggle"[^`]*`\s*: `<button data-media-action="toggle" id="detail-toggle" class="detail-control detail-toggle"/);
  assert.match(app, /\$\{externalControls\(true\)\}\$\{detailNote\}/, 'the queue\'s details: the song\'s ring');
  assert.match(app, /\$\{externalControls\(false\)\}\$\{detailNote\}/, 'a lone live track: its player\'s own');
  assert.match(app, /<button data-media-action="stop" class="detail-control detail-stop"/);
  assert.doesNotMatch(body(app, 'function updateExternalControls() {', '\nfunction '), /textContent = toggleLabel/);
  // The redesign for the lyrics (the owner, 2026-10-17: "Redesign scene 2. It shouldn't show 曲目数
  // anymore"): no facts in any document. The artist and the album on one line, the album muted after
  // a dot; NetEase's own song (网易云当前曲目) and local mode's 正在播放 rows went with the facts (the
  // header names what plays); the lyrics' box after the warning (none for a lone live track).
  assert.doesNotMatch(app, /detail-facts|detailFact|data-now-row|data-media-now|data-local-now|data-media-playback|"曲目数"/);
  assert.doesNotMatch(css, /\.detail-facts?\b/);
  assert.match(app, /const detailArtist = \(artist: string, album: string \| undefined, after = "", albumData = ""\) =>\s*`<p class="detail-artist"><span class="detail-artist-name">\$\{esc\(artist\)\}<\/span><span class="detail-album"\$\{albumData\}\$\{album \? "" : " hidden"\}>\$\{esc\(album \?\? ""\)\}<\/span>\$\{after\}<\/p>`;/);
  assert.match(app, /\$\{detailArtist\(a\.artist, song\?\.album\)\}\$\{externalControls\(true\)\}\$\{detailNote\}\$\{lyricsBox\}`;/, 'NetEase\'s queue: the lyrics after the warning');
  assert.match(app, /\$\{detailArtist\(source\.artist \|\| "歌手未提供", source\.album, "", " data-media-album"\)\}\$\{externalControls\(false\)\}\$\{detailNote\}`;/, 'a lone live track: no lyrics');
  assert.match(app, /\$\{detailTimeline\("local-seek", "播放位置", "local"\)\}\$\{lyricsBox\}\$\{songAbout\(song\)\}`;/, 'a local song: the lyrics before its album\'s introduction');
  assert.match(css, /\.music-app \.detail-album::before \{\s*content: "·";\s*margin-right: 12px;\s*\}/);
  assert.match(css, /\.music-app \.detail-transport \{[^}]*border-top: 1px solid var\(--rule\);[^}]*\}/, 'the transport carries the rule the facts had');
  // No descriptive line under the timeline any more (the owner, 2026-10-07; this replaces the
  // limit line of 2026-10-05): only the player's warning, when there is one.
  assert.doesNotMatch(app, /data-detail-limit|detail-limit|LONE_TRACK_NOTE|queueControlLimit|只显示当前曲目/);
  assert.doesNotMatch(session, /queueControlNote|queueControlLimit/);
  assert.match(app, /const detailNote = '<p class="detail-warning" data-media-warning role="status"><\/p>';/);
  assert.doesNotMatch(css, /\.detail-limit/);
  // An unknown length keeps the words 播放位置: the times say — and the dashed line has 时长不可用 in its title.
  assert.match(app, /if \(label\) setText\(label, "播放位置"\);/);
  assert.match(app, /const reason = !known \? "时长不可用"[\s\S]*?syncSeekFill\(slider, placed, reason\);/);
  assert.match(css, /input\.detail-seek\[data-known="false"\]::-webkit-slider-runnable-track \{\s*background: repeating-linear-gradient/);
  // Local songs (2026-10-06): the same document; the ring plays this song, or pauses / resumes it
  // once it is the one loaded (with the gesture: ringPlay, below); previous / next the header's; four
  // facts with Chinese keys; the album's introduction only when it is about this song's album.
  assert.match(app, /<button data-action="detail-play" id="detail-toggle" class="detail-control detail-toggle" aria-label="播放" aria-pressed="false" data-ring="plain">\$\{detailRing\}<\/button>\$\{detailDivider\}<button data-action="next-track"/);
  assert.match(app, /case "detail-play":\s*ringPlay\(selected\);\s*break;/);
  // The year, the format and the length on a quiet line under the artist (each only when known).
  assert.match(app, /const meta = \[track\?\.year \? String\(track\.year\) : "", format === "未提供" \? "" : format, !demo && track\?\.duration \? time\(track\.duration\) : ""\]\.filter\(Boolean\);/);
  assert.match(app, /<p class="detail-meta">\$\{meta\.map\(\(fact\) => `<span>\$\{esc\(fact\)\}<\/span>`\)\.join\(""\)\}<\/p>/);
  assert.match(app, /if \(!song \|\| !album\?\.description \|\| !introductionFits\(song\)\) return "";/);
  // The case does not carry its album's introduction: one that arrives while the details are open
  // redraws them (the library refresh compares the song's album record too, not only the case).
  assert.match(body(app, 'function detailKey() {', '\n}'), /const album = localSong\(\)\?\.album;\s*return JSON\.stringify\(\[currentAlbum\(\), album && \[album\.id, album\.title, album\.description, album\.descriptionSource\]\]\);/);
  const refresh = body(app, 'async function applyLibrary() {', '\nfunction ');
  assert.match(refresh, /const previousDetail = detailKey\(\);/);
  // (Not for a lone live card whose picture alone changed: its details do not show it.)
  assert.match(refresh, /if \(mode === "detail" && \(\(previousDetail !== detailKey\(\) && !coverOnly\) \|\| \(menu === "song" && shapeChanged\)\)\)\s*menu === "song" \? renderSongs\(\) : renderDetail\(\);/);
  assert.doesNotMatch(app, /RELEASE \/ 发行年份|ARTIST \/ 歌手/);
  // A search result's song: outlined with a 搜索结果 tag for 1100 ms, no accent pulse, no autoplay.
  assert.match(focus, /tag\.textContent = "搜索结果";/);
  assert.match(focus, /hold = setTimeout\(cancel, 1100\);/);
  assert.doesNotMatch(focus, /--accent|search-track-tint/);
  // Placement follows data-layout; width queries only size (large windows, narrow portrait); short
  // windows (desktop and compact, 700 px or less) put the two ways out on one line above the case.
  // (Forced colours only keep the transport's marks drawn.)
  assert.deepEqual([...css.matchAll(/@media ([^{]+)\{/g)].map((m) => m[1].trim()), ['(forced-colors: active)', '(min-width: 1700px)', '(max-height: 700px)', '(max-width: 700px)']);
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
  // The shelf's 42 px ring is the selected song's own play button (2026-10-09; it was the header's
  // play / pause): its own action, words and ring (ringPlay, songRing; below).
  assert.match(app, /<button data-action="shelf-play" id="shelf-play" class="play-ring play-ring-big"/);
  assert.match(app, /case "shelf-play":\s*ringPlay\(navigationSelection\(\)\);\s*break;/);
  assert.match(body(app, 'function syncPlayButton() {', '\nfunction '), /applyRing\(document\.querySelector<HTMLButtonElement>\("#shelf-play"\), songRing\(navigationSelection\(\)\)\);/);
  assert.match(body(app, 'function syncRing() {', '\nfunction '), /song\(document\.querySelector\("#shelf-play"\), navigationSelection\(\)\);/);
  // Beside it: the playing song's number as a button back to it (any column, 2026-10-07), or
  // 正在切换… (a status) while NetEase has not answered; no 只供浏览 (no descriptive text).
  const note = body(app, 'function syncPlayNote() {', '\nfunction ');
  assert.match(note, /if \(playerCurrent && netease\.isPending\(key\)\) status = "正在切换…";\s*else \{\s*playing = playingRecord\(\);\s*if \(playing >= 0 && playing !== cursor\)/);
  assert.match(note, /document\.querySelectorAll<HTMLButtonElement>\("#shelf-play-note, #song-go-playing"\)/);
  // Every scene has 回到当前 beside the wordmark (the owner, 2026-10-17: "add 回到当前 button to top left",
  // "add this button to every scene, but show it only when a different song is selected"; it replaced the
  // details' 正在播放 beside ‹ › of earlier that day): the dot, 回到当前 and its key. Hidden, it keeps its
  // room in the header (invisible), so the header's form does not change as it comes and goes.
  assert.match(app, /<div class="music-identity"><span class="music-brand"><strong>RHINE LAB<\/strong><\/span><button id="go-current" class="go-current" data-action="go-playing" data-shown="false" aria-label="回到当前"><i aria-hidden="true"><\/i><span>回到当前<\/span><kbd>L<\/kbd><\/button><\/div>/);
  assert.match(note, /const current = \$\("#go-current"\), shown = String\(!!number\);/);
  assert.match(note, /if \(current\.dataset\.shown !== shown\) current\.dataset\.shown = shown;/);
  assert.match(note, /mode === "archive" \? \$\("\[data-action=open\]"\)\.focus\(\{ preventScroll: true \}\)\s*: menu === "song" \? songView\.focusCurrent\(\)\s*: \$\("#album-detail-content"\)\.focus\(\{ preventScroll: true \}\);/);
  assert.match(app, /const box = header\.getBoundingClientRect\(\), brand = \$\("#go-current"\)\.getBoundingClientRect\(\);/);
  // The header refits when it or the wordmark's side changes size once laid out (a new layout's type can
  // come frames after the resize is reported; the form chosen then would otherwise stay).
  assert.match(app, /const chromeWatch = new ResizeObserver\(\(\) => fitChrome\(\)\);\s*chromeWatch\.observe\(\$\("\.music-header"\)\);\s*chromeWatch\.observe\(\$\("\.music-identity"\)\);/);
  assert.doesNotMatch(app, /detail-go-playing|detail-head-tools|detailGoPlaying/);
  assert.match(app, /for \(const button of \[\$\("#shelf-play-note"\), \$\("#song-go-playing"\), \$\("#go-current"\)\]\)\s*button\.addEventListener\("mousedown", \(event\) => event\.preventDefault\(\)\);/);
  assert.match(app, /write\('#music-keyhint \[data-hint="back"\] > kbd, #go-current > kbd', keyName\("playing"\)\);/);
  const chromeCss = readFileSync(new URL('../src/music-chrome.css', import.meta.url), 'utf8');
  assert.match(chromeCss, /\.music-app \.go-current\[data-shown="false"\] \{\s*visibility: hidden;\s*\}/);
  assert.match(app, /<button id="shelf-play-note" class="shelf-play-note" data-action="go-playing" hidden><i aria-hidden="true"><\/i><span><\/span><\/button><span id="shelf-play-status" class="shelf-play-status" role="status"><\/span>/);
  for (const source of [app, session]) assert.doesNotMatch(source, /只供浏览/);
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
  // Moving never plays: the hint says 选歌, not 换歌; P is a triangle and Space two bars (pause /
  // resume), their words for screen readers; L goes back to the playing song.
  const hints = body(app, 'function keyHintMarkup(', '\n}');
  // Every case is a song in both modes (local folder playlists since 2026-10-06).
  assert.match(hints, /hint\("move", "↑ ↓", "选歌"\)/);
  assert.doesNotMatch(hints, /换歌/);
  assert.match(hints, /\+ glyph\("play", "P", "hint-play", "播放选中的歌"\) \+ hint\("back", "L", "正在播放", true\) \+ glyph\("space", "SPACE", "hint-pause", "暂停 \/ 继续"\);/);
  // P, L and SPACE wait hidden for the first sync; nothing but the keys and their words.
  assert.match(hints, /const glyph = [^\n]*data-hint="\$\{name\}" hidden>/);
  // The hints follow what each key can do now (the owner's review, 2026-10-08): S says what its
  // link says; P while the lifted case has ▶ (playOffer: no demonstration cover, offline folder,
  // browse-only column, nor the song that plays; where NetEase's port may not be used for a reason
  // the user can change, P says why, as ▶ does: 2026-10-09); L only while another song is selected
  // than the one that plays or is paused; SPACE only while something can be paused or resumed.
  const keyHint = body(app, 'function syncKeyHint() {', '\n}');
  assert.match(keyHint, /const songs = playerCurrent \? \(browsing \? "歌单歌曲" : "播放列表"\) : "选歌";/);
  assert.match(keyHint, /play: shelf && !!playOffer\(navigationSelection\(\)\),\s*back: backTarget\(\) >= 0,\s*space: pauseResumeOffered\(\),/);
  assert.match(keyHint, /const shelf = !playerCurrent \|\| queue;\s*const shown: Record<string, boolean> = \{\s*move: shelf, songs: shelf,/, 'a lone live track: the details and pause / resume only');
  // Shown and hidden, never written again (the names keep clear of the hints' whole row, whichever keys it shows: lane-names.ts).
  assert.doesNotMatch(keyHint, /innerHTML/);
  assert.match(keyHint, /if \(hint\.hidden === on\) hint\.hidden = !on;/);
  assert.match(body(app, 'function backTarget() {', '\n}'), /if \(playerCurrent && !netease\.shownQueue\(\)\) return -1;\s*const target = playingRecord\(\), cursor = navigationSelection\(\);\s*return target >= 0 && target !== cursor && records\[cursor\] \? target : -1;/);
  assert.match(body(app, 'function pauseResumeOffered() {', '\n}'), /if \(playerCurrent\) return !!externalMedia && \(externalMedia\.offers\("toggle"\) \|\| !!playsCurrent\(\)\);\s*return !!player && !!loadedTrack\(\);/);
  // The header's ring is disabled by the same rule (pauseResumeRing).
  assert.match(body(app, 'function pauseResumeRing(): RingWords {', '\n}'), /const disabled = !externalMedia\?\.offers\("toggle"\) && !playsCurrent\(\);[\s\S]*const loaded = loadedTrack\(\)[\s\S]*disabled: !loaded,/);
  assert.match(app, /setText\(\$\("#open-songs-label"\), lane && !lane\.live \? "歌单歌曲" : "播放列表"\);/, 'the link\'s word, which S matches');
  assert.match(css, /\.music-app \.music-keyhint \.hint-pause \{/);
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
  assert.deepEqual([...css.matchAll(/@media ([^{]+)\{/g)].map((m) => m[1].trim()), ['(forced-colors: active)', '(max-height: 650px)', '(min-width: 1700px)', '(max-width: 700px)']);
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

test('the titles\' measuring probes never transition: after a resize a title breaks as one laid out at that size', () => {
  const music = readFileSync(new URL('../src/music.css', import.meta.url), 'utf8');
  const title = readFileSync(new URL('../src/music-title.ts', import.meta.url), 'utf8');
  // Reduced motion gives every element a tiny transition of every property (transition-property's
  // initial value is all): a probe's width or font size written and read in one task read the old one.
  assert.match(music, /\.music-app\.reduce-motion \* \{[^}]*transition-duration: 0s !important;/);
  assert.match(music, /\.music-title-probe,\s*\.music-title-probe \*,\s*\.detail-title-probe,\s*\.detail-title-probe \* \{\s*transition-property: none !important;\s*\}/);
  assert.match(title, /probe\.className = "music-title-probe";/);
  assert.match(title, /probe\.className = "detail-title-probe";/);
  // The shelf's probe sets its width and the candidates' sizes, the details' its width and data-long, then reads.
  assert.match(title, /if \(probe\.style\.width !== `\$\{width\}px`\) probe\.style\.width = `\$\{width\}px`;/);
  assert.match(title, /candidate\.root\.style\.fontSize = `\$\{size\}px`;/);
});

test('a run the font joins (an Arabic word, a conjunct its clusters leave open) rolls as one face; other titles keep a reel per grapheme', () => {
  const title = readFileSync(new URL('../src/music-title.ts', import.meta.url), 'utf8');
  assert.match(title, /for \(const glyph of joinShaped\(row, line\)\) \{/);
  const glyph = (text, x, width) => ({ key: '', text, kind: 'main', x, y: 0, width, height: 40, font: '700 38px MiSans', letterSpacing: 'normal' });
  const keyed = (row, line) => row.map((g, index) => ({ ...g, key: `main:${line}:${index}` }));
  // Latin, Han, an emoji and Devanagari (whose clusters hold its conjuncts): a face per grapheme, keys as before.
  const plain = [glyph('0', 0, 20), glyph('2', 20, 20), glyph(' ', 40, 10), glyph('雨', 50, 38), glyph('🎵', 88, 38), glyph('क्ष', 126, 30), glyph('त', 156, 18)];
  const before = JSON.stringify(plain);
  assert.deepEqual(joinShaped(plain, 2), keyed(plain, 2));
  assert.equal(JSON.stringify(plain), before, 'the measured glyphs are not changed');
  // A fictional Arabic word between Latin ones, laid out right to left: one face over its letters.
  const mixed = [glyph('A', 0, 20), glyph(' ', 20, 10), glyph('م', 72, 12), glyph('ر', 64, 8), glyph('ح', 50, 14), glyph('ب', 40, 10), glyph('ا', 30, 10), glyph(' ', 84, 10), glyph('B', 94, 20)];
  assert.deepEqual(joinShaped(mixed, 0), keyed([mixed[0], mixed[1], { ...mixed[2], text: 'مرحبا', x: 30, width: 54 }, mixed[7], mixed[8]], 0));
  // Two words stay two faces; tatweel joins; the Arabic comma (Common) and Arabic-Indic digits next to a word.
  const words = [glyph('ك', 90, 10), glyph('ـ', 80, 10), glyph('ل', 70, 10), glyph(' ', 60, 10), glyph('ن', 50, 10), glyph('ا', 40, 10), glyph('،', 30, 10)];
  assert.deepEqual(joinShaped(words, 1).map((g) => [g.text, g.x, g.width]), [['كـل', 70, 30], [' ', 60, 10], ['نا', 40, 20], ['،', 30, 10]]);
  assert.deepEqual(joinShaped([glyph('ب', 20, 10), glyph('١', 10, 10)], 0).map((g) => g.text), ['ب١']);
  // Syriac, N'Ko and Mongolian join as Arabic does.
  for (const word of [['ܫ', 'ܠ', 'ܡ'], ['ߒ', 'ߞ', 'ߏ'], ['ᠮ', 'ᠣ', 'ᠩ']])
    assert.equal(joinShaped(word.map((text, index) => glyph(text, index * 10, 10)), 0).length, 1, word.join(''));
  // A virama or a joiner left at a cluster's end joins the next letter (Kannada, Sinhala); a ZWNJ asks for no conjunct.
  assert.deepEqual(joinShaped([glyph('ಕ್', 0, 14), glyph('ಕ', 14, 12)], 0).map((g) => [g.text, g.width]), [['ಕ್ಕ', 26]]);
  assert.deepEqual(joinShaped([glyph('ශ්\u200D', 0, 14), glyph('රී', 14, 12)], 0).map((g) => g.text), ['ශ්\u200Dරී']);
  assert.equal(joinShaped([glyph('क्\u200C', 0, 14), glyph('ष', 14, 12)], 0).length, 2);
  assert.equal(joinShaped([glyph('ಕ್', 0, 14), glyph(' ', 14, 6)], 0).length, 2, 'not across a space');
});

test('Windows\' contrast themes (forced colours) keep the rings, the triangles and the bars drawn', () => {
  for (const file of ['music-chrome.css', 'music-shelf.css', 'music-detail.css', 'song-scene.css']) {
    const css = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
    // The forced-colours blocks (to their closing brace), and the rules outside them.
    const blocks = [];
    let rest = css;
    for (let at; (at = rest.indexOf('@media (forced-colors: active) {')) >= 0; ) {
      let depth = 0, end = rest.length;
      for (let i = rest.indexOf('{', at); i < rest.length; i++) {
        if (rest[i] === '{') depth++;
        else if (rest[i] === '}' && --depth === 0) { end = i + 1; break; }
      }
      blocks.push(rest.slice(rest.indexOf('{', at) + 1, end - 1));
      rest = rest.slice(0, at) + rest.slice(end);
    }
    assert.ok(blocks.length > 0, `${file} has its forced-colours rules`);
    const rules = (text) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map(([, selector, declarations]) => ({ selectors: selector.split(',').map((s) => s.trim().replace(/\s+/g, ' ')), declarations }));
    const forced = rules(blocks.join('\n'));
    const kept = new Set(forced.filter((rule) => /forced-color-adjust: none;/.test(rule.declarations)).flatMap((rule) => rule.selectors));
    // Every mark drawn with a gradient (gone), its own background (forced to the page's colour) or
    // transparent borders (forced to the text's: a block) keeps out of the forcing.
    const marks = rules(rest).filter((rule) => /solid transparent|conic-gradient\(|background: currentColor;/.test(rule.declarations))
      .flatMap((rule) => rule.selectors).filter((selector) => !selector.includes('::-webkit-scrollbar'));
    assert.ok(marks.length > 0, file);
    for (const selector of marks) assert.ok(kept.has(selector), `${file}: ${selector} keeps out of forced colours`);
    // Kept out, they are drawn in system colours only (an author colour would not be forced).
    assert.doesNotMatch(forced.map((rule) => rule.declarations).join('\n').replace(/var\(--progress, 0%\)/g, ''), /var\(--|#[0-9a-f]{3}|rgba?\(/i, file);
  }
  const chrome = readFileSync(new URL('../src/music-chrome.css', import.meta.url), 'utf8');
  const detail = readFileSync(new URL('../src/music-detail.css', import.meta.url), 'utf8');
  // The progress in Highlight over the button's own forced colour; a plain or unknown ring all of it.
  assert.match(chrome, /\.music-app \.play-ring::before \{\s*background: conic-gradient\(Highlight 0 var\(--progress, 0%\), currentColor var\(--progress, 0%\) 100%\);\s*\}\s*\.music-app \.play-ring\[data-ring="unknown"\]::before,\s*\.music-app \.play-ring\[data-ring="plain"\]::before \{\s*background: currentColor;/);
  assert.match(detail, /\.music-app \.detail-ring::before \{\s*background: conic-gradient\(Highlight 0 var\(--progress, 0%\), currentColor var\(--progress, 0%\) 100%\);\s*\}\s*\.music-app \.detail-toggle\[data-ring="unknown"\] \.detail-ring::before,\s*\.music-app \.detail-toggle\[data-ring="plain"\] \.detail-ring::before \{\s*background: currentColor;/);
  // The scene under them is not forced: the rings and previous / next get a plate, as text does.
  assert.match(chrome, /\.music-app \.play-ring \{\s*border-radius: 50%;\s*background: ButtonFace;\s*\}\s*\.music-app \.music-topnav \.transport-skip \{\s*background: ButtonFace;/);
  assert.match(detail, /\.music-app \.detail-ring \{\s*border-radius: 50%;\s*background: ButtonFace;\s*\}\s*\.music-app \.detail-control:not\(\.detail-toggle\) \{\s*background: ButtonFace;/);
});

test('the song rows\' ▶, P, and ● 012 / L back to the playing song (2026-10-07/08); the lifted case has no ▶ of its own (2026-10-10)', () => {
  const shelfCss = readFileSync(new URL('../src/music-shelf.css', import.meta.url), 'utf8');
  const songCss = readFileSync(new URL('../src/song-scene.css', import.meta.url), 'utf8');
  // The owner, 2026-10-10: "delete the marked button, we already have a play button on the right":
  // the lifted case's round ▶ (2026-10-07) is gone; the shelf's 42 px ring is the selected song's
  // play button (ringPlay), and a click on the case opens and plays it (openCase, above).
  assert.doesNotMatch(app, /case-play|casePlay|syncCasePlay|CASE_PLAY|casePlayAction/);
  assert.doesNotMatch(shelfCss, /case-play/);
  assert.match(app, /\[\$\("\.music-browse-veil"\), \$\("\.selection-bracket"\), \$\("\.album-callout"\), \$\("\.music-navigation"\), \$\("\.music-keyhint"\)\]/);
  assert.match(app, /syncBracket\(\);\s*syncSongHop\(\);/, 'every frame, nothing after the bracket');
  assert.match(body(app, 'function syncSelectionPlay() {', '\n}'), /^function syncSelectionPlay\(\) \{\s*syncKeyHint\(\);\s*$/);
  assert.match(app, /case "shelf-play":\s*ringPlay\(navigationSelection\(\)\);\s*break;/);
  // A row's ▶ (its number's cell): that row's song; the rest of the row only selects it. A tap or
  // a pen's press on a row whose ▶ was not shown before it only selects too (the review of
  // 2026-10-08: the tap hovered the row, so ▶ was under the finger; songView.playAllowed). Every
  // click on a row, its ▶ or the rest of it, goes to clickSongRow (the owner, 2026-10-08:
  // "double-click a song in the list to switch to it").
  assert.match(app, /const songRow = target\.closest<HTMLButtonElement>\("#song-list \.song-row"\);\s*if \(songRow\) \{\s*clickSongRow\(songRow, target\.dataset\.action === "play-row", e\);\s*return;\s*\}\s*if \(target\.dataset\.select\) \{/);
  assert.doesNotMatch(app, /case "play-row":/, 'no second way for ▶');
  const row = body(app, 'function clickSongRow(', '\n}');
  assert.match(row, /const click = songView\.rowClick\(clicked, event\);\s*const row = click\.row, index = Number\(row\.dataset\.select\);\s*if \(row\.disabled \|\| row\.dataset\.select === undefined \|\| !Number\.isInteger\(index\)\) return;/);
  // A double-click or a double tap (the second click of the burst): the song of the row it began on,
  // by ▶'s rules (requestPlay: it plays, or says why where the port may not be used), unless the
  // first click played it (or said why) already; never another select (the first one runs the
  // chain; a second would start that move again). A further click does nothing.
  assert.match(row, /if \(click\.kind !== "single"\) \{\s*if \(click\.kind === "double" && !click\.played\) \{\s*songView\.rowPlayed\(\);\s*requestPlay\(index\);\s*\}\s*return;\s*\}/);
  // One click: its ▶ plays (where the press found it shown); one that cannot play now says why and
  // selects the row, as the rest of the row only selects.
  assert.match(row, /if \(onPlay && songView\.playAllowed\(row\) && playOffer\(index\)\) \{\s*songView\.rowPlayed\(\);\s*if \(requestPlay\(index\)\) return;\s*\}\s*netease\.queueFollowPaused = true;\s*select\(index, rowNavigation\(navigationSelection\(\), index\)\);\s*$/);
  assert.doesNotMatch(row, /pointerType|detail|dblclick/, 'the view tells the clicks apart');
  assert.doesNotMatch(app, /dblclick/, 'no listener of its own: the burst is the clicks\'');
  // The shelf's ruler keeps its own select (rows of the song list never reach it).
  assert.match(app, /select\(index, target\.dataset\.rulerStep !== undefined && Number\.isInteger\(rulerStep\) \? \{ axis: "row", direction: rulerStep \} : undefined\);/);
  const rows = body(app, 'function syncSongRows(', '\nfunction ');
  assert.match(rows, /const play = queue \|\| !playerCurrent;\s*const resume = loaded >= 0 && playOffer\(loaded\)\?\.action === "resume";/);
  // The playing row is the song the player has loaded, as the shelf marks it (playingRecord): once
  // a local playlist has played to its end (idle), its last row has ▶ as its case does.
  assert.match(rows, /const playing = \(queue \? netease\.queuePlaying : loadedTrack\(\)\?\.id\) \|\| undefined;/);
  assert.doesNotMatch(rows, /currentTrack/);
  assert.match(body(app, 'function playingRecord() {', '\n}'), /const loaded = loadedTrack\(\)\?\.id;/);
  assert.match(songCss, /\.music-song\[data-play="true"\] \.song-row:not\(\.playing, \.pending\):is\(:hover, :focus-visible, \.selected\) \.song-row-play,\s*\.music-song\[data-resume="true"\] \.song-row\.playing:not\(\.pending\):is\(:hover, :focus-visible, \.selected\) \.song-row-play \{\s*display: block;/);
  // P: as ▶ (a focused song row's song where its ▶ is); L: back to the playing song. Like S: the
  // key's code, no modifier, no repeat, never in a text field.
  const run = body(app, 'function runShortcut(', '\n}');
  assert.match(run, /case "play": \{[\s\S]{0,420}requestPlay\(Number\.isInteger\(index\) \? index : navigationSelection\(\)\);\s*return;\s*\}/);
  assert.match(run, /case "playing":\s*goToPlaying\(\);\s*return;/);
  assert.deepEqual([shortcutTable({}).get('KeyP'), shortcutTable({}).get('KeyL')], ['play', 'playing']);
  // No modifier, and the user's keys (设置 → 快捷键).
  assert.match(body(app, 'function shortcutAt(', '\n}'), /return shortcutEvent\(e\) \? shortcutKeys\.get\(eventCode\(e\)\) : undefined;/);
  assert.match(app, /let shortcutKeys = shortcutTable\(preferences\.shortcuts\);/);
  assert.match(body(app, 'function setShortcuts(', '\n}'), /shortcutKeys = shortcutTable\(next\);/);
  assert.deepEqual(['play', 'playing'].map((id) => SHORTCUTS.find((info) => info.id === id).repeat), [false, false], 'held down, once');
  const keys = body(app, 'document.addEventListener("keydown", (e) => {', '\n});');
  assert.ok(keys.indexOf('"input:not([type=range]), textarea, select, [contenteditable=true]"') < keys.indexOf('const action = shortcutAt(e);'), 'not in a text field');
  assert.match(keys, /if \(menu === "song" && songView\.handleKey\(e\)\) return;\s*if \(target\.matches\("input\[type=range\]"\) && SLIDER_KEYS\.has\(e\.key\)\) return;[\s\S]*const action = shortcutAt\(e\);\s*if \(!action\) return;/, 'the playlist\'s and a focused slider\'s own keys first');
  // Back to the playing song: the follow path along its column, or a column step the shorter way
  // round the shelf; navigation only (no gesture, nothing played), following resumes.
  const back = body(app, 'function goToPlaying() {', '\n}');
  // Where it goes is the L hint's rule too (backTarget; a source with one card has none, see the shelf's test).
  assert.match(back, /const target = backTarget\(\), cursor = navigationSelection\(\);\s*if \(target < 0\) return;/);
  assert.match(body(app, 'function backTarget() {', '\n}'), /if \(playerCurrent && !netease\.shownQueue\(\)\) return -1;/, 'a source with one card has none');
  assert.match(back, /netease\.queueFollowPaused = false;\s*wheelNavigation\.reset\(\);/);
  assert.match(back, /if \(from === to\) \{\s*select\(target, rowNavigation\(cursor, target\)\);\s*return;\s*\}/);
  assert.match(back, /select\(target, \{ axis: "lane", direction: forward <= columns \/ 2 \? forward : forward - columns \}\);/);
  assert.doesNotMatch(back, /playGesture|ripple|player\?\.|playQueueSong|controlExternal/);
  assert.match(app, /case "go-playing":\s*goToPlaying\(\);\s*break;/);
  assert.match(songSceneMarkup(), /<span class="song-tally-row"><button id="song-go-playing" class="song-go-playing" data-action="go-playing" aria-label="回到正在播放的歌" hidden>/);
  // The play gesture answers ▶ too: at once on the lifted case, or once the selection has arrived
  // (a click that also opens the case leaves its hop out: below).
  assert.match(body(app, 'function answerPlay(', '\n}'), /if \(index === selected && navigationSelection\(\) === selected\) \{\s*gestureFor = undefined;\s*if \(hop\) scene\?\.playGesture\(\);\s*else playWaves\(\);\s*if \(records\.length\) tickMotion\.ripple\(\);\s*\} else \{\s*gestureFor = index;\s*gestureHop = hop;\s*\}/);
  // On arrival, with its hop, or only the waves where the case is being opened (Enter while the shelf
  // returns: openCase, the 2026-10-08 rule that the case drawn out does not hop first).
  assert.match(body(app, 'function commitSelection(', '\nfunction '), /if \(gestureFor !== undefined\) \{\s*const due = gestureFor === selected;\s*gestureFor = undefined;\s*if \(due\) \{\s*if \(gestureHop\) scene\?\.playGesture\(\);\s*else playWaves\(\);\s*if \(records\.length\) tickMotion\.ripple\(\);/);
  // The empty pages keep only what is under way or what the user must do, and their buttons.
  assert.doesNotMatch(app, /上次连接的是它，它出现后会自动连接|在运行时会自动连接，也可以选择其他播放器|这里只提供连接和控制|其中每个子文件夹是一个歌单，每首歌一张卡片/);
  assert.match(body(app, 'function updateStatus() {', '\n}'), /const emptyText = externalMedia\.ambiguous \? `\$\{preferredName\}有多个媒体会话，请选择要连接的一个`\s*: awaited \? `等待\$\{spacedName\(preferredName\)\}…` : "";/);
});

// The review of 2026-10-08 (of the clicks of that day): a local song the browser cannot play (↗:
// DSF / DFF, which are only indexed, and any other format it does not decode) is shown, never
// played. Asked to play one, the player stops the song that plays and says why, so nothing asks it:
// no ▶ on its case or its row, P does nothing, a click on its case only opens it, a double-click on
// its row only selects it.
test('a local song the browser cannot play (↗) is shown, never played: no ▶, no P, a click only opens, a double-click only selects', () => {
  const what = body(app, 'function selectionPlay(index: number)', '\nfunction ');
  assert.match(what, /if \(!song \|\| !album\?\.tracks\.length \|\| album\.offline \|\| !song\.track\.browserPlayable\) return undefined;/);
  assert.ok(what.indexOf('!song.track.browserPlayable') < what.indexOf('loadedTrack()'), 'whatever is loaded');
  // Every way to play asks selectionPlay first: the P hint (playOffer, which adds only NetEase's port
  // reasons: playBlock), a row's ▶ and P themselves, the click on the case, a row's double-click and
  // the shelf's and the details' ring (requestPlay, which plays only through playSelection, after
  // selectionPlay; otherwise it only explains). (The lifted case's own ▶ went on 2026-10-10.)
  assert.match(body(app, 'function playOffer(', '\n}'), /const action = selectionPlay\(index\);\s*if \(action\) return \{ action \};\s*const block = playBlock\(index\);/);
  assert.match(body(app, 'function playBlock(', '\n}'), /if \(!playerCurrent\) return undefined;/, 'nothing local: a ↗ song stays without ▶');
  assert.match(app, /play: shelf && !!playOffer\(navigationSelection\(\)\),/);
  assert.match(body(app, 'function playSelection(', '\n}'), /const action = selectionPlay\(index\);\s*if \(!action\) return;/);
  assert.match(body(app, 'function requestPlay(', '\n}'), /if \(selectionPlay\(index\)\) \{\s*playSelection\(index, hop\);/);
  assert.match(body(app, 'function openCase(', '\n}'), /requestPlay\(index, false\);/);
  assert.match(body(app, 'function clickSongRow(', '\n}'), /click\.kind === "double" && !click\.played\) \{\s*songView\.rowPlayed\(\);\s*requestPlay\(index\);/);
  assert.match(body(app, 'function ringPlay(', '\n}'), /else \{\s*requestPlay\(index\);/);
  // The details' ring of a local song says why it is disabled (no second note in the document).
  assert.match(body(app, 'function noPlayReason(', '\n}'), /if \(!song\.track\.browserPlayable\) return `\$\{song\.track\.format\} 需要兼容的播放内核`;/);
  // The list is told, and its row has no ▶ (check-song-list.mjs, the playlist rows).
  assert.match(body(app, 'function localSongModel() {', '\n}'), /format: track\.format,\s*browserPlayable: track\.browserPlayable,/);
  // Why it matters: the player refuses such a song, and the index marks DSF / DFF so.
  const player = readFileSync(new URL('../src/local_music/connector/music-player.ts', import.meta.url), 'utf8');
  assert.match(player, /if \(!track\.browserPlayable\)\s*return `\$\{track\.format\} 无法在当前浏览器中播放/);
  const library = readFileSync(new URL('../src-tauri/src/local_music/data/library.rs', import.meta.url), 'utf8');
  const playable = /"browserPlayable",\s*json!\(matches!\(\s*ext\.as_str\(\),\s*([^)]*)\)\),/.exec(library)?.[1] ?? '';
  assert.match(playable, /"flac" \| "wav"/);
  assert.doesNotMatch(playable, /dsf|dff/i, 'DSF / DFF are only indexed');
});

// The review of 2026-10-08: in the header's menu form (compact or portrait), a click on the lifted
// case that closed the open menu opened the details, as it always had, and now also played.
test('a press that closes the header\'s open menu opens the lifted case as before and plays nothing', () => {
  // Read at the press (the stage's capture, before the canvas sees it): the menu's focusout closes
  // it as the press takes the focus, and the page's click would after that.
  assert.match(app, /let pressClosesMenu = false;/);
  assert.match(app, /stage\.addEventListener\("pointerdown", \(\) => \{\s*pressClosesMenu = stage\.dataset\.chromeMenu === "open";\s*\}, true\);/);
  assert.match(app, /\$\("\.music-topnav"\)\.addEventListener\("focusout", \(event\) => \{[^}]*setChromeMenu\(false\);/);
  assert.match(app, /if \(stage\.dataset\.chromeMenu === "open" && !\(e\.target as Element\)\.closest\("\.topnav-menu-button"\) &&/);
  const select = body(app, 'scene.onSelect = (index, cell, lifted) => {', 'scene.onNavigate');
  assert.match(select, /if \(lifted && presentation\.phase === "archive"\) return openCase\(!pressClosesMenu\);/);
  // openCase, run with stand-ins: it always drops the wheel's owed rows and opens; it asks to play
  // (requestPlay: plays as ▶, or says why) only when asked to, while the selection is the selected
  // case, and then without the hop. From the song scene the song plays once the swap to the details
  // was accepted; with the details open (or opening) already, it only does what opening did there.
  const open = body(app, 'function openCase(', '\n}').replace(/\r/g, '').replace('open: () => boolean | void = showDetails', 'open = showDetails') + '\n}';
  const run = (arg, { cursor = 4, scene = 'shelf', swap = true, opener, rebuilding = false } = {}) => {
    const calls = [];
    // 'returning': the song scene's Esc, its text still leaving (the menu is still the song scene's).
    const menu = scene === 'song' || scene === 'returning' ? 'song' : 'detail';
    const showDetails = () => (calls.push(['open']), scene === 'song' ? swap : true);
    const custom = opener && (() => { calls.push(['open', opener]); });
    new Function('selected', 'navigationSelection', 'requestPlay', 'showDetails', 'wheelNavigation', 'presentation', 'menu', 'returningToShelf', 'libraryRebuilding', 'arg', 'custom',
      `${open}\nopenCase(arg, ...(custom ? [custom] : []));`)(
      4, () => cursor, (...args) => calls.push(['play', ...args]), showDetails, { reset: () => calls.push(['wheel']) },
      { openingOrDetail: scene === 'song' || scene === 'detail' }, menu, () => scene === 'returning', rebuilding, arg, custom);
    return calls;
  };
  assert.deepEqual(run(true), [['wheel'], ['play', 4, false], ['open']]);
  assert.deepEqual(run(undefined), [['wheel'], ['play', 4, false], ['open']], 'a click plays by default');
  assert.deepEqual(run(false), [['wheel'], ['open']], 'the press that closed the menu only opens');
  // A selection still moving (↓ while the shelf returns after Esc): the details open on it, and its song
  // plays (the review of 2026-10-23); while the library is rebuilt only the details open.
  assert.deepEqual(run(true, { cursor: 5 }), [['wheel'], ['play', 5, false], ['open']], 'the song the details open on');
  assert.deepEqual(run(true, { cursor: 5, rebuilding: true }), [['wheel'], ['open']], 'a rebuild: only the details');
  // Enter right after Esc from the song scene: the shelf's, not a swap of the scene that leaves.
  assert.deepEqual(run(true, { scene: 'returning' }), [['wheel'], ['play', 4, false], ['open']]);
  assert.deepEqual(run(true, { scene: 'returning', cursor: 6 }), [['wheel'], ['play', 6, false], ['open']]);
  // 查看这首歌 (its own way of opening, setMode) plays as the lifted case does.
  assert.deepEqual(run(true, { opener: 'setMode' }), [['wheel'], ['play', 4, false], ['open', 'setMode']]);
  // The song scene (its large card, 这首歌, S, Enter): the swap first, then the song, if it was accepted.
  assert.deepEqual(run(true, { scene: 'song' }), [['wheel'], ['open'], ['play', 4, false]]);
  assert.deepEqual(run(undefined, { scene: 'song', swap: false }), [['wheel'], ['open']], 'a refused swap plays nothing');
  assert.deepEqual(run(false, { scene: 'song' }), [['wheel'], ['open']], 'the press that closed the menu only swaps');
  assert.deepEqual(run(true, { scene: 'song', opener: 'swapToDetail' }), [['wheel'], ['open', 'swapToDetail'], ['play', 4, false]], 'S: its own swap');
  // The details open already (Enter there): what Enter did there, nothing plays again.
  assert.deepEqual(run(true, { scene: 'detail' }), [['open']]);
  // requestPlay, run with stand-ins: ▶'s play where selectionPlay has one, else the explanation (and
  // nothing played).
  const ask = body(app, 'function requestPlay(', '\n}').replace(/\r/g, '').replace(/index: number/g, 'index') + '\n}';
  const request = (action, hop) => {
    const calls = [];
    const result = new Function('selectionPlay', 'playSelection', 'explainNoPlay', 'hop', `${ask}\nreturn hop === undefined ? requestPlay(7) : requestPlay(7, hop);`)(
      (index) => (calls.push(['ask', index]), action), (...args) => calls.push(['play', ...args]), (index) => calls.push(['explain', index]), hop);
    return [result, calls];
  };
  assert.deepEqual(request('play'), [true, [['ask', 7], ['play', 7, true]]]);
  assert.deepEqual(request('resume', false), [true, [['ask', 7], ['play', 7, false]]]);
  assert.deepEqual(request(undefined), [false, [['ask', 7], ['explain', 7]]], 'nothing ▶ would play: only the explanation');
});

// The review of 2026-10-08: a click that played and opened the lifted case made it hop, land and
// then rise into the details. Its extraction is its motion, so it does not hop; the waves and the
// ruler's ring still answer the play. P, the rings and the song rows keep the hop.
test('a click that plays and opens the lifted case: no hop, the waves and the ruler\'s ring; P and the rows keep the hop', () => {
  assert.match(body(app, 'function playSelection(', '\n}'), /^function playSelection\(index = navigationSelection\(\), hop = true\) \{[\s\S]*\n\s*answerPlay\(index, hop\);\s*$/);
  assert.match(body(app, 'function answerPlay(', '\n}'), /^function answerPlay\(index: number, hop = true\) \{/);
  // Only opening the details (openCase: the click on the case, and since 2026-10-09 Enter, the links,
  // the large card and S) leaves the hop out: the case drawn out is the motion. Every way of playing
  // goes through requestPlay, which hands its `hop` to playSelection.
  assert.equal((app.match(/playSelection\([^;\n]*\bfalse\)/g) || []).length, 0);
  assert.equal((app.match(/requestPlay\([^;\n]*\bfalse\)/g) || []).length, 2);
  assert.equal((body(app, 'function openCase(', '\n}').match(/requestPlay\(index, false\);/g) || []).length, 2);
  assert.match(body(app, 'function requestPlay(', '\n}'), /^function requestPlay\(index: number, hop = true\) \{\s*if \(selectionPlay\(index\)\) \{\s*playSelection\(index, hop\);/);
  assert.match(app, /requestPlay\(Number\.isInteger\(index\) \? index : navigationSelection\(\)\);/);
  assert.equal((body(app, 'function clickSongRow(', '\n}').match(/requestPlay\(index\)/g) || []).length, 2);
  assert.equal((app.match(/\bplaySelection\(/g) || []).length, 2, 'its definition and requestPlay: no other way of playing');
  // playWaves asks the scene for the gesture's waves alone (no private state is touched).
  assert.match(body(app, 'function playWaves() {', '\n}'), /^function playWaves\(\) \{\s*scene\?\.playGesture\(\{ hop: false \}\);\s*$/);
  assert.doesNotMatch(app, /scene\["playStarted"\]/);
  // ... and the scene sends the wave whatever, but starts the hop only when asked: no hop begins,
  // and one still running lands as it would have (the hop is measured from playStarted).
  const gesture = body(scene, '  playGesture({ hop = true }: { hop?: boolean } = {}) {', '  get songCardHop()');
  assert.match(gesture, /if \(hop\) this\.playStarted = now;\s*this\.pulses\.push\(\{ \.\.\.this\.selectedCell, time: now \+ PLAY_GESTURE\.wave, play: true \}\);/);
  assert.match(scene, /private playStarted = -Infinity;/);
  assert.match(scene, /const hop = musicLibrary && !cinematic && !this\.reduced \? playHop\(time - this\.playStarted\) : 0;/);
});

// The owner, 2026-10-09, after "clicking the lifted box doesn't switch to that song or play it" (his
// NetEase ran without its debugging port): "when I click the play button, it should only play the
// selected song, not the previously playing one. Include scene2 too. When scene2 belongs to another
// song, the button should be a play button with zero progress while the currently playing song is
// shown at the top right."
test('the shelf\'s and the details\' ring are their song\'s play button; the header\'s ring and Space pause or resume what plays', () => {
  // On the song that plays or is paused (or a lone live track): pause / resume; on any other song,
  // or with nothing loaded: ▶'s play of that song (requestPlay, with the hop).
  assert.match(body(app, 'function ringPlay(', '\n}'), /if \(ringPauses\(index\)\) togglePlayback\(\);\s*else \{\s*requestPlay\(index\);\s*ringPlayed = \{ at: now, index \};/);
  assert.match(body(app, 'function ringPauses(', '\n}'), /if \(playerCurrent && !netease\.shownQueue\(\)\) return true;\s*return index >= 0 && index === playingRecord\(\);/);
  const ringPlay = body(app, 'function ringPlay(', '\n}').replace(/\r/g, '').replace(/index: number/g, 'index') + '\n}';
  // Run with stand-ins and a clock; `presses` are [ms, does the ring pause its song now?].
  const press = (...presses) => {
    const calls = [];
    let clock = 0;
    const run = new Function('ringPauses', 'togglePlayback', 'requestPlay', 'performance', 'DOUBLE_PRESS',
      `let ringPlayed = { at: -Infinity, index: -1 };\n${ringPlay}\nreturn ringPlay;`)(
      (index) => (calls.push(['mine?', index]), presses.current), () => calls.push(['toggle']), (...args) => calls.push(['play', ...args]),
      { now: () => clock }, { ms: 500, px: 16 });
    for (const [at, pauses] of presses) {
      clock = at;
      presses.current = pauses;
      run(3);
    }
    return calls;
  };
  assert.deepEqual(press([0, true]), [['mine?', 3], ['toggle']], 'the song that plays: pause / resume');
  assert.deepEqual(press([0, false]), [['mine?', 3], ['play', 3]], 'another song: that song, never a toggle of the previous one');
  // A double press on a ring that played its song (2026-10-09 review) plays once: its second press,
  // finding the ring now that song's pause button, does not pause it; a later press does.
  assert.deepEqual(press([0, false], [320, true]), [['mine?', 3], ['play', 3]], 'a double press plays once');
  assert.deepEqual(press([0, false], [900, true]), [['mine?', 3], ['play', 3], ['mine?', 3], ['toggle']], 'a press after the double-click time pauses');
  // A mouse press on these rings leaves the focus where it was, so Enter still opens the details.
  assert.match(app, /document\.addEventListener\("mousedown", \(event\) => \{\s*if \(\(event\.target as Element \| null\)\?\.closest\?\.\('#shelf-play, \[data-action="detail-play"\]'\)\) event\.preventDefault\(\);\s*\}, true\);/);
  // The shelf's ring is the selection's (where the selection is going), the details' the song they show.
  assert.match(app, /case "shelf-play":\s*ringPlay\(navigationSelection\(\)\);\s*break;/);
  assert.match(app, /case "detail-play":\s*ringPlay\(selected\);\s*break;/);
  // The header's ring and Space stay pause / resume of what plays.
  assert.match(app, /case "play-pause":\s*togglePlayback\(\);\s*break;/);
  assert.match(app, /<button data-action="play-pause" id="play-pause" class="play-ring"/);
  // The words: the header's on the song that plays; else 播放：<its title> (where pressing it only says
  // why it cannot play now, too), not dimmed while NetEase has not answered a request for it; else
  // disabled with the reason in the title.
  const words = body(app, 'function songRing(', '\n}');
  assert.match(words, /if \(ringPauses\(index\)\) return pauseResumeRing\(\);/);
  assert.match(words, /if \(playOffer\(index\)\) return \{ disabled: false, pressed: false, label: `播放：\$\{title\}`, title: `播放：\$\{title\}` \};/);
  assert.match(words, /if \(playerCurrent && title && netease\.isPending\(records\[index\]\?\.id\)\)\s*return \{ disabled: false, pressed: false, label: `正在切换：\$\{title\}`, title: "正在切换…" \};/);
  assert.match(words, /return \{ disabled: true, pressed: false, label: "播放", title: noPlayReason\(index\) \};/);
  assert.match(body(app, 'function syncPlayButton() {', '\nfunction '), /applyRing\(document\.querySelector<HTMLButtonElement>\('#detail-toggle\[data-action="detail-play"\]'\), songRing\(selected\)\);/);
  // The shape: what plays while it is their song, else a plain ring with no progress (a triangle:
  // aria-pressed is false); a lone live track's details ring is its player's, as before.
  const ring = body(app, 'function syncRing() {', '\nfunction ');
  assert.match(ring, /paint\(document\.querySelector\("#play-pause"\), ring, value\);/);
  assert.match(ring, /const theirs = ringPauses\(index\);\s*paint\(button, theirs \? ring : "plain", theirs \? value : "0%"\);/);
  assert.match(ring, /if \(detail\?\.dataset\.action === "detail-play"\) song\(detail, selected\);\s*else paint\(detail, own, value\);/);
  const chrome = readFileSync(new URL('../src/music-chrome.css', import.meta.url), 'utf8');
  const detailCss = readFileSync(new URL('../src/music-detail.css', import.meta.url), 'utf8');
  assert.match(chrome, /\.music-app \.play-ring\[data-ring="plain"\]::before \{\s*background: var\(--ink\);/);
  assert.match(chrome, /\.music-app \.play-ring \.transport-play,\s*\.music-app \.play-ring\[aria-pressed="true"\] \.transport-pause \{\s*opacity: 1;/);
  assert.match(detailCss, /\.music-app \.detail-toggle\[data-ring="plain"\] \.detail-ring::before \{\s*background: var\(--ink\);/);
  // The details' previous, next and stop stay what plays (NetEase's own controls).
  assert.match(app, /<button data-media-action="previous" class="detail-control"[^`]*\$\{ring\}\$\{detailDivider\}<button data-media-action="next" class="detail-control"[^`]*<button data-media-action="stop"/);
});

// The owner, 2026-10-09: "in the detail of a song isnt playing, dont show the timeline, when it starts
// to play, make an animation for the timeline to emerge".
test('the details\' timeline is the song\'s that plays: folded away on another song, it emerges when that song starts', () => {
  // Both details (a local song's, a player's) write their timeline through detailTimeline, in its fold,
  // open or shut as it is, without movement.
  assert.equal((app.match(/\$\{detailTimeline\("local-seek", "播放位置", "local"\)\}/g) || []).length, 1);
  assert.equal((app.match(/\$\{detailTimeline\("external-seek", "外部播放器播放位置", "media"\)\}/g) || []).length, 1);
  assert.equal((app.match(/class="detail-timeline"/g) || []).length, 1, 'no timeline outside the fold');
  assert.match(body(app, 'function detailTimeline(', '\n}'), /const state = timelineState\(\);\s*return `<div class="detail-timeline-wrap" data-timeline="\$\{state\}" data-motion="off"\$\{state === "hidden" \? " inert" : ""\}><div class="detail-timeline-clip"><label class="detail-timeline" for="\$\{id\}">/);
  // Shown on the song a ring pauses (the song that plays or is paused, or a lone live track), and
  // kept with the rings (syncPlayButton runs on every change of what plays and of the selection).
  assert.match(body(app, 'function timelineState() {', '\n}'), /return ringPauses\(selected\) \? "shown" : "hidden";/);
  // The lyrics (2026-10-17) belong to the same song and follow right after it.
  assert.match(body(app, 'function syncPlayButton() {', '\n}'), /syncDetailTimeline\(\);\s*syncLyrics\(\);\s*$/);
  // Run with stand-ins: a change moves (unless motion is reduced), and the folded timeline takes no focus.
  const sync = body(app, 'function syncDetailTimeline() {', '\n}').replace(/\r/g, '').replace('<HTMLElement>', '') + '\n}';
  const fold = (start, states, reduced = false) => {
    const wrap = { dataset: { timeline: start, motion: 'off' }, inert: start === 'hidden' };
    const seen = [];
    let state;
    const run = new Function('document', 'timelineState', 'preferences', `${sync}\nreturn syncDetailTimeline;`)(
      { querySelector: (selector) => (assert.equal(selector, '#detail-body .detail-timeline-wrap'), wrap) }, () => state, { reduced });
    for (const next of states) {
      state = next;
      run();
      seen.push([wrap.dataset.timeline, wrap.dataset.motion, wrap.inert]);
    }
    return seen;
  };
  assert.deepEqual(fold('hidden', ['hidden', 'shown', 'shown', 'hidden']), [['hidden', 'off', true], ['shown', 'on', false], ['shown', 'on', false], ['hidden', 'on', true]]);
  assert.deepEqual(fold('hidden', ['shown'], true), [['shown', 'off', false]], 'reduced motion: no movement');
  assert.doesNotThrow(() => new Function('document', 'timelineState', 'preferences', `${sync}\nsyncDetailTimeline();`)(
    { querySelector: () => null }, () => 'shown', { reduced: false }), 'no details written: nothing to do');
  // The fold closes to nothing with the line hidden, and opens downwards as the line draws in from the
  // left; only with data-motion on does anything move.
  const css = readFileSync(new URL('../src/music-detail.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(css, /\.music-app \.detail-timeline-wrap \{\s*display: grid;\s*grid-template-rows: 1fr;\s*\}/);
  assert.match(css, /\.music-app \.detail-timeline-clip \{\s*display: flow-root;\s*min-height: 0;\s*overflow: clip;/);
  assert.match(css, /\.music-app \.detail-timeline-wrap\[data-timeline="hidden"\] \{\s*grid-template-rows: 0fr;\s*\}/);
  assert.match(css, /\.music-app \.detail-timeline-wrap\[data-timeline="hidden"\] \.detail-timeline \{\s*opacity: 0;\s*visibility: hidden;\s*\}/);
  assert.match(css, /\.music-app \.detail-timeline-wrap\[data-motion="on"\] \{\s*transition: grid-template-rows 420ms /);
  assert.match(css, /\.music-app \.detail-timeline-wrap\[data-motion="on"\]\[data-timeline="shown"\] input\.detail-seek \{\s*animation: detail-timeline-draw 560ms [^;]*backwards;\s*\}/);
  assert.match(css, /@keyframes detail-timeline-draw \{\s*from \{\s*clip-path: inset\(0 100% 0 0\);\s*\}\s*to \{\s*clip-path: inset\(0 0 0 0\);\s*\}\s*\}/);
  let moving = 0;
  for (const [, selector, rule] of css.matchAll(/([^{}]*detail-timeline-wrap[^{}]*)\{([^}]*)\}/g))
    if (/transition|animation/.test(rule)) moving++, assert.match(selector, /\[data-motion="on"\]/, selector.trim());
  assert.equal(moving, 5);
});

test('本地音乐\'s timeline seeks where it is clicked or dragged: the position is written back after the range\'s change', () => {
  // Chromium's order for a click or a drag on a range: pointerdown, input, pointerup, then the range
  // commits (its change, which seeks) on the mouseup or the touchend of the same press.
  const listeners = body(app.replace(/\r\n/g, '\n'), '  // 本地音乐\'s details timeline:', '\n}\n')
    .replace(': ReturnType<typeof setTimeout> | undefined', '').replace(' as HTMLElement', '').replace(' as const', '');
  const on = new Map(), timers = [];
  const target = { addEventListener: (type, listener) => on.set(type, listener) };
  const slider = { id: 'local-seek', value: '5' };
  let position = 5;
  const run = new Function('document', 'window', 'setTimeout', 'clearTimeout', 'syncLocalTransport', 'held',
    `let localSeekHeld = false;\n${listeners}\nheld(() => localSeekHeld);`);
  let isHeld;
  // syncLocalTransport writes the player's position into the range unless it is held.
  run(target, target, (callback) => timers.push(callback), () => {}, () => { if (!isHeld()) slider.value = String(position); }, (get) => { isHeld = get; });
  const change = () => { position = Number(slider.value); };
  for (const [from, to] of [[5, 23], [23, 8]]) {
    on.get('pointerdown')({ target: slider });
    slider.value = String(to);
    on.get('pointerup')();
    assert.equal(slider.value, String(to), 'the range still has the value it was given when it commits it');
    change();
    timers.splice(0).forEach((callback) => callback());
    assert.equal(position, to, `seeked from ${from} to ${to}`);
    assert.equal(isHeld(), false);
  }
});

test('no silent failure: a song NetEase may not be asked for now says why, with a way to 播放器, and nothing is sent', () => {
  // playBlock: a song NetEase can be asked for (its queue's, or since 2026-10-10 another playlist's,
  // with that playlist: songRequest), or the song it plays that ▶ would start where NetEase has no
  // play / pause of its own, and the session's reason (port, error, FM).
  const block = body(app, 'function playBlock(', '\n}');
  assert.match(block, /if \(!playerCurrent\) return undefined;\s*const key = records\[index\]\?\.id, request = netease\.songRequest\(index\);/);
  assert.match(block, /if \(!key \|\| !request \|\| netease\.isPending\(key\)\) return undefined;/, 'nothing NetEase could be asked for, nor a song asked for already');
  assert.match(block, /if \(!request\.playlist && key === netease\.queuePlaying && \(externalMedia\?\.offers\("toggle"\) \|\| mediaPlayback\(\) === "playing"\)\) return undefined;\s*return netease\.portBlock\(\);/);
  // The notice: the session's words and the 播放器 panel's button; nothing else (the notice that a
  // column was only for browsing went with 2026-10-10). Nothing is sent, NetEase is never restarted.
  const explain = body(app, 'function explainNoPlay(', '\n}');
  assert.match(explain, /^function explainNoPlay\(index: number\) \{\s*const block = playBlock\(index\);\s*if \(block\) notify\(PORT_BLOCK_NOTICE\[block\], \{ label: "打开播放器", panel: "sources", section: "netease" \}\);\s*$/);
  assert.doesNotMatch(app, /browseNoticeShown|function browseOnly|这个歌单不是网易云的播放队列/);
  for (const fn of [explain, block, body(app, 'function requestPlay(', '\n}'), body(app, 'function ringPlay(', '\n}')])
    assert.doesNotMatch(fn, /restart|neteaseControl|controlSwitched|controlExternal|playQueueSong|\.debug\.|media_control|setPref|savePrefs/);
  const run = body(app, 'function explainNoPlay(', '\n}').replace(/\r/g, '').replace(/index: number/g, 'index') + '\n}';
  const notices = [];
  const blocks = { 1: 'port', 2: 'error', 3: 'fm' };
  const explainNoPlay = new Function('playBlock', 'notify', 'PORT_BLOCK_NOTICE', `${run}\nreturn explainNoPlay;`)(
    (index) => blocks[index], (...args) => notices.push(args), { port: 'PORT', error: 'ERROR', fm: 'FM' });
  for (const index of [1, 2, 3, 4, 8]) explainNoPlay(index);
  assert.deepEqual(notices, [
    ['PORT', { label: '打开播放器', panel: 'sources', section: 'netease' }], ['ERROR', { label: '打开播放器', panel: 'sources', section: 'netease' }], ['FM', { label: '打开播放器', panel: 'sources', section: 'netease' }],
  ], 'one notice per blocked request; nothing for a song with no reason to give');
  // The session's words (check-external-media.mjs runs its reasons).
  assert.match(session, /export const PORT_BLOCK_NOTICE: Record<PortBlock, string> = \{/);
  assert.match(app, /import \{ NeteaseSession, PORT_BLOCK_NOTICE, type PortBlock \} from "\.\/netease_music\/connector\/session";/);
  // ▶ stays on NetEase's queue songs then (on the case, the rows and P's hint), so the press can say why.
  assert.match(body(app, 'function playOffer(', '\n}'), /return block \? \{ action: records\[index\]\?\.id === netease\.queuePlaying \? "resume" : "play", block \} : undefined;/);
  // The notice: its words and one button that opens the panel through the page's click (data-action)
  // and closes it; hidden, it takes no press and no focus.
  assert.match(app, /<div id="music-toast" role="status" aria-live="polite"><span id="music-toast-text"><\/span><button id="music-toast-action" class="toast-action" type="button" hidden><\/button><\/div>/);
  const notify = body(app, 'function notify(', '\n}');
  assert.match(notify, /button\.hidden = !action;\s*if \(action\) \{\s*button\.textContent = action\.label;\s*button\.dataset\.action = action\.panel;\s*if \(action\.section\) button\.dataset\.section = action\.section;\s*else delete button\.dataset\.section;\s*\} else \{\s*delete button\.dataset\.action;\s*delete button\.dataset\.section;\s*\}/);
  assert.match(notify, /toastTimer = setTimeout\(hideToast, action \? 8000 : 5500\);/);
  assert.match(app, /\$\("#music-toast-action"\)\.addEventListener\("click", hideToast\);/);
  // The notice's button opens 播放器 on 网易云, where the port's state and the restart are.
  assert.match(app, /if \(\["library", "search", "settings", "sources"\]\.includes\(action \|\| ""\)\) \{\s*searchGenre = "";\s*(\/\/[^\n]*\s*)*const section = target\.dataset\.section;\s*if \(section && isIndexed\(action as Panel\)\) keepSection\(action as IndexedPanel, section\);\s*openPanel\(action as Panel\);/);
  const chrome = readFileSync(new URL('../src/music-chrome.css', import.meta.url), 'utf8');
  assert.match(chrome, /\.music-app #music-toast \{[^}]*opacity: 0;\s*visibility: hidden;[^}]*pointer-events: none;[^}]*visibility 0s linear 200ms;/);
  assert.match(chrome, /\.music-app #music-toast\.visible \{\s*opacity: 1;\s*visibility: visible;\s*transform: none;\s*transition-delay: 0s;\s*\}/);
  assert.match(chrome, /\.music-app #music-toast \.toast-action \{[^}]*pointer-events: auto;/);
  // Its words wrap inside the box, also a long path with no break in it (an offline main folder's).
  assert.match(chrome, /\.music-app #music-toast-text \{\s*min-width: 0;\s*overflow-wrap: anywhere;\s*\}/);
  // The header's open list (its menu form) stands above a notice under the row, which covered its first
  // items (the one focused) and took presses on them with its button; only while it is open, under the intro.
  const toastLayer = Number(/\.music-app #music-toast \{[^}]*z-index: (\d+);/.exec(chrome)[1]);
  const openLayer = Number(/\.music-app\[data-chrome="menu"\]\[data-chrome-menu="open"\] \.music-header \{\s*z-index: (\d+);\s*\}/.exec(chrome)[1]);
  assert.ok(openLayer > toastLayer, 'the open list above the notice');
  assert.ok(Number(/\.music-app \.music-header \{[^}]*z-index: (\d+);/.exec(chrome)[1]) < toastLayer, 'closed, the header stays under it');
  const boot = readFileSync(new URL('../src/music-boot.css', import.meta.url), 'utf8');
  assert.ok(openLayer < Number(/\.music-boot-overlay \{[^}]*z-index: (\d+);/.exec(boot)[1]), 'and under the intro');
});

// The owner, 2026-10-10: "a settings tab where users can customize the hotkeys"; 2026-10-24 (design
// A): an index of sections beside the one it shows, 快捷键 one of them; the same day every panel got
// that frame ("make it just like setting panel"): 播放器 and 音乐库 have sections, 搜索 its playlists.
test('设置 is an index of sections, 快捷键 among them, whose keys take the next key pressed before the page does', () => {
  const settings = body(app, 'function renderPanelIndex() {', '\n}');
  assert.match(settings, /<button role="tab" id="panel-tab-\$\{id\}" data-action="panel-tab" data-panel-tab="\$\{id\}" aria-selected="false" aria-controls="panel-tabpanel" tabindex="-1"/);
  assert.match(body(app, 'function panelSections(kind: IndexedPanel): [string, string][] {', '\n}'), /return kind === "settings" \? settingsSections\(\) : kind === "sources" \? sourcesSections\(\) : LIBRARY_SECTIONS;/);
  assert.match(app, /const LIBRARY_SECTIONS: \[LibrarySection, string\]\[\] = \[\["folder", "主文件夹"\], \["lists", "歌单"\], \["online", "在线资料"\]\];/);
  // 搜索's index is a filter: radios, the chosen one the one Tab reaches, the arrows choose.
  assert.match(body(app, 'function renderSearchPanel() {', '\n}'), /<button role="radio" data-filter="\$\{esc\(id\)\}" aria-checked="\$\{on\}" tabindex="\$\{on \? 0 : -1\}"/);
  assert.match(body(app, 'function panelTabKey(e: KeyboardEvent) {', '\n}'), /if \(next\.dataset\.filter !== undefined\) setSearchFilter\(next\.dataset\.filter\);\s*else setPanelSection\(next\.dataset\.panelTab!\);\s*next\.focus\(\);/);
  assert.match(app, /const SETTINGS_SECTIONS: \[SettingsSection, string\]\[\] = \[\s*\["look", "外观"\], \["motion", "动效与显示"\], \["sound", "声音"\], \["quality", "画质"\],\s*\["notes", "专辑介绍"\], \["keys", "快捷键"\], \["about", "关于"\],\s*\];/);
  assert.match(app, /<div class="settings-tabs" role="\$\{search \? "radiogroup" : "tablist"\}" aria-orientation="vertical" aria-label="\$\{titles\[next\]\[2\]\}"><\/div>/);
  assert.match(app, /<div id="panel-body" class="settings-body">\$\{search \? '<div id="album-results" class="panel-rows"><\/div>' : '<div id="panel-tabpanel" class="panel-rows" role="tabpanel"><\/div>'\}<\/div>/);
  assert.match(app, /settings: \["SYSTEM SETTINGS", "设置", "设置分类"\],/);
  assert.match(app, /sources: \["CONNECT YOUR PLAYER", "播放器", "播放器分类"\],/);
  assert.match(app, /<button data-action="settings" aria-label="设置">设置<i/);
  // A player as the current source keeps the sound and the library in its own player: no 声音, no 专辑介绍.
  assert.match(body(app, 'function settingsSections() {', '\n}'), /!playerCurrent \|\| \(id !== "sound" && id !== "notes"\)/);
  // The chosen section is shown by itself (the one tabpanel), and its index button says so.
  assert.match(body(app, 'function markPanelTab() {', '\n}'), /button\.setAttribute\("aria-selected", String\(on\)\);\s*button\.tabIndex = on \? 0 : -1;/);
  assert.match(body(app, 'function renderPanelSection() {', '\n}'), /body\.setAttribute\("aria-labelledby", `panel-tab-\$\{chosen\}`\);/);
  // The entrance and a section's rise never play when motion is reduced; the rise has its own
  // attribute, so choosing a section during the entrance does not cut the entrance off.
  assert.match(body(app, 'function playPanelMotion(kind: "enter" | "reveal") {', '\n}'), /if \(preferences\.reduced\) \{\s*delete node\.dataset\[key\];\s*return;\s*\}/);
  const musicCss = readFileSync(new URL('../src/music.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(musicCss, /\.music-app \.settings-panel \.panel-rows\[data-reveal\] > \* \{\s*animation: settings-rise/);
  // Reduced: no animation and no transition, on the pseudo-elements (marks, knobs) too.
  assert.match(musicCss, /\.music-app\.reduce-motion \.settings-panel \*::before,\s*\.music-app\.reduce-motion \.settings-panel \*::after \{\s*animation: none !important;\s*transition: none !important;\s*\}/);
  // The index's keys in the open panel, before its Tab trap; the chosen section takes the focus.
  const keys = body(app, 'document.addEventListener("keydown", (e) => {', '\n});');
  assert.ok(keys.indexOf('if (panelTabKey(e)) return;') > keys.indexOf('if (panel) {') && keys.indexOf('if (panelTabKey(e)) return;') < keys.indexOf('if (e.key === "Tab") {'));
  assert.match(app, /document\.querySelector<HTMLElement>\('#music-panel-root \[role="tab"\]\[aria-selected="true"\]'\)/);
  // The capture: in the capture phase, before the panel's Esc; Tab moves on; combinations stay the system's.
  const capture = body(app, 'function captureShortcutKey(e: KeyboardEvent) {', '\n}');
  assert.match(app, /document\.addEventListener\("keydown", captureShortcutKey, true\);\s*document\.addEventListener\("keyup", releaseShortcutKey, true\);/);
  assert.match(capture, /if \(e\.key === "Tab"\) \{\s*endShortcutCapture\("已取消"\);\s*return;\s*\}\s*e\.stopPropagation\(\);/, 'Tab is not taken');
  assert.match(capture, /if \(e\.ctrlKey \|\| e\.altKey \|\| e\.metaKey\) \{[^}]*return;\s*\}\s*e\.preventDefault\(\);/, 'Alt+F4 stays the system\'s');
  assert.match(capture, /if \(e\.key === "Escape"\) \{\s*endShortcutCapture\(/);
  assert.match(capture, /if \(e\.key === "Backspace" \|\| e\.key === "Delete"\) \{\s*setShortcuts\(clear\(preferences\.shortcuts, slot\)\);/);
  // A key another action holds: a second press swaps.
  assert.match(capture, /if \(other && other !== slot && shortcutCapture\.pending !== code\) \{\s*shortcutCapture\.pending = code;/);
  // The names follow the keys everywhere they are shown; a cleared key has no hint.
  const labels = body(app, 'function applyKeyLabels() {', '\n}');
  for (const selector of ['#music-keyhint [data-hint="play"] > kbd', '#music-keyhint [data-hint="songs"] > kbd', '#music-keyhint [data-hint="back"] > kbd', '.detail-songs > kbd, .song-details > kbd', '[data-action="search"] > .topnav-menu-value']) {
    assert.ok(labels.includes(selector), selector);
  }
  assert.match(body(app, 'function syncKeyHint() {', '\n}'), /shown\.enter = !!keyName\("open"\);\s*if \(!keyName\("songUp"\) && !keyName\("songDown"\)\) shown\.move = false;\s*if \(!keyName\("songs"\)\) shown\.songs = false;\s*if \(!keyName\("play"\)\) shown\.play = false;\s*if \(!keyName\("playing"\)\) shown\.back = false;\s*if \(!keyName\("pause"\)\) shown\.space = false;/);
  for (const selector of ['#music-keyhint [data-hint="move"] > kbd', '#music-keyhint [data-hint="enter"] > kbd', '#music-keyhint [data-hint="space"] > kbd', '.music-back[data-action="back"] > kbd']) {
    assert.ok(labels.includes(selector), selector);
  }
  // NetEase's port status and consent name the key of 播放选中的歌 (P by default: word for word).
  assert.match(labels, /netease\.playKey = keyName\("play"\);/);
  // Every key can be changed (the owner, 2026-10-11: "yes keep every key changable").
  assert.doesNotMatch(app, /固定按键|fixedHolder|slotEditable/);
  // Every action has its case.
  const run = body(app, 'function runShortcut(', '\n}');
  for (const info of SHORTCUTS) assert.match(run, new RegExp(`case "${info.id}":`), info.id);
  // A user's key for 上一首 / 下一首 moves along the playlist's rows, as the arrows do.
  assert.match(run, /songView\.handleKey\(e, action === "songUp" \? "ArrowUp" : "ArrowDown"\)/);
  // Saved with the other preferences, cleaned when read.
  assert.match(app, /shortcuts: \{\} as ShortcutOverrides,/);
  assert.match(app, /const savedShortcuts = sanitize\(preferences\.shortcuts\);\s*preferences\.shortcuts = savedShortcuts\.overrides;/);
});

// The owner, 2026-10-11: "add a max frame option in settings".
test('帧率上限 caps the frame loop (frame-cap.ts): a held-back frame only measures, the loop waits for the later of the rest slot and the cap', () => {
  assert.match(app, /const FRAME_CAPS = \[0, 144, 120, 90, 60, 30\];/);
  assert.match(app, /frameCap: 0,/);
  assert.match(app, /if \(!FRAME_CAPS\.includes\(preferences\.frameCap\)\) preferences\.frameCap = 0;/);
  // 动效与显示's row of words: 不限 and the caps (radios named frame-cap).
  const motion = app.slice(app.indexOf('  motion: () =>'), app.indexOf('  sound: () =>'));
  assert.match(motion, /role="radiogroup" aria-labelledby="frame-cap-label"[^>]*>\$\{FRAME_CAPS\.map\(\(cap\) => settingChoice\("frame-cap", cap, cap \? String\(cap\) : "不限", preferences\.frameCap === cap,/);
  assert.match(app, /if \(el\.name === "frame-cap"\) \{\s*const cap = Number\(el\.value\);/);
  assert.match(app, /const frameCap = new FrameCap\(\);\s*frameCap\.set\(preferences\.frameCap\);/);
  assert.match(app, /preferences\.frameCap = FRAME_CAPS\.includes\(cap\) \? cap : 0;\s*frameCap\.set\(preferences\.frameCap\);\s*requestFrame\(\);/);
  const loop = body(app, 'function frame(ms: number) {', '\n}');
  // A display frame before the cap's next run measures the display for the frame pacing (the
  // review, 2026-10-11: otherwise it took the cap's interval for the display's and rested at the cap).
  assert.match(loop, /const capped = !document\.hidden;\s*if \(capped && !frameCap\.admit\(ms\)\) \{\s*if \(scene && !viewer\?\.isOpen\) scene\.skipFrame\(ms \/ 1000\);\s*waitForFrame\(frameCap\.next\);\s*return;\s*\}/);
  assert.ok(loop.indexOf('frameCap.admit(ms)') < loop.indexOf('scene.update('), 'before anything is updated or drawn');
  // After a run: the later of the resting scene's slot and the cap's next run (no wake on a display
  // frame the cap would throw away); a timer only when that is more than a display frame away.
  assert.match(loop, /waitForFrame\(Math\.max\(quiet \? scene!\.nextFrameAt\(\) \* 1000 : 0, capped \? frameCap\.next : 0\)\);\s*$/);
  const wait = body(app, 'function waitForFrame(at: number) {', '\n}');
  assert.match(wait, /if \(wait > Math\.max\(1, \(scene\?\.displayFrame \?\? 0\) \* 1000\)\) \{[^}]*scene\?\.frameWaited\(\);\s*frameTimer = window\.setTimeout\(requestFrame, wait\);\s*\} else scheduleFrame\(\);/);
  // The rates against displays of 60 to 240 Hz are checked in check-frame-pacing.mjs.
});
