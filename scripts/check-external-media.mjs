import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExternalMediaConnection, mediaLibrary, mediaVisualKey, mediaTime,
  mediaPlaybackLabel, mediaConnectionLabel, mediaSourcesMarkup, nativeMediaPort,
} from '../src/external-media.ts';
import { isNeteaseSource } from '../src/external-queue.ts';

const source = (id, extra = {}) => ({
  id, name: `Player ${id}`, kind: 'smtc', title: '当前曲目', artist: '歌手', album: '专辑',
  playback: 'playing', position: 12, duration: 120,
  capabilities: { toggle: true, previous: true, next: true, stop: false, seek: true },
  ...extra,
});
function fixture(initial = [source('a'), source('b')], preferred) {
  let snapshot = { sources: initial };
  const calls = [];
  const connection = new ExternalMediaConnection({
    async snapshot() { if (snapshot instanceof Error) throw snapshot; return snapshot; },
    async control(...args) { calls.push(args); },
  }, preferred);
  return { connection, calls, set: next => { snapshot = next; } };
}
// The app's default link: NetEase Cloud Music, however Windows lists it.
const NETEASE = { name: '网易云音乐', match: isNeteaseSource };
const netease = (id, extra = {}) => source(id, { name: 'cloudmusic.exe', player: 'netease', ...extra });
const neteaseWindow = (id, extra = {}) => source(id, { name: '网易云音乐（窗口标题）', kind: 'netease', player: 'netease', ...extra });

test('without a preferred player sources never auto-select; refresh and another playing source do not transfer user control', async () => {
  const { connection, calls, set } = fixture();
  await connection.refresh();
  assert.equal(connection.selected, undefined);
  assert.equal(await connection.control('toggle'), false);
  assert.equal(connection.select('missing'), false);
  assert.equal(connection.select('a'), true);
  set({ sources: [source('b'), source('a', { playback: 'paused' })] });
  await connection.refresh();
  connection.setGlobalMediaKeys(true);
  assert.equal(connection.allowGlobalMediaKeys, false);
  assert.equal(await connection.control('toggle'), true);
  assert.deepEqual(calls, [['a', 'toggle', undefined, false]]);
  assert.equal(connection.selected.playback, 'paused', 'do not invent an optimistic playing state');
});

test('disconnection clears the current card and controls; returning sessions still need explicit selection', async () => {
  const { connection, calls, set } = fixture();
  await connection.refresh();
  connection.select('a');
  set({ sources: [source('b')] });
  await connection.refresh();
  assert.equal(connection.disconnected, true);
  assert.equal(connection.selectedId, 'a');
  assert.equal(connection.selected, undefined);
  assert.equal(mediaLibrary(connection.selected).albums.length, 0);
  assert.equal(await connection.control('next'), false);
  set(new Error('temporary read failure after confirmed disappearance'));
  await connection.refresh();
  assert.equal(connection.disconnected, true);
  set({ sources: [source('a'), source('b')] });
  await connection.refresh();
  assert.equal(connection.selected, undefined);
  connection.select('a');
  assert.equal(connection.selected.id, 'a');
  assert.equal(calls.length, 0);
});

test('the preferred player is the default link: connected when found, whatever else is playing', async () => {
  // Not running yet: nothing is connected, and another player is not taken instead.
  const { connection, calls, set } = fixture([source('a')], NETEASE);
  await connection.refresh();
  assert.equal(connection.selected, undefined);
  assert.equal(connection.selectedId, null);
  assert.equal(connection.awaitsPreferred, true);
  assert.match(mediaConnectionLabel(connection), /未发现网易云音乐.*自动连接/);
  assert.equal(await connection.control('toggle'), false);
  // It appears, behind a player that is playing: it is connected by itself.
  set({ sources: [source('a', { playback: 'playing' }), netease('n1', { playback: 'paused' })] });
  await connection.refresh();
  assert.equal(connection.selected.id, 'n1');
  assert.equal(connection.followsPreferred, true);
  assert.equal(connection.awaitsPreferred, false);
  assert.equal(connection.allowGlobalMediaKeys, false);
  assert.match(mediaConnectionLabel(connection), /cloudmusic\.exe · 已暂停/);
  assert.equal(await connection.control('next'), true);
  assert.deepEqual(calls, [['n1', 'next', undefined, false]]);
  // Present at the first reading: connected at once; either way Windows lists NetEase.
  for (const first of [netease('n'), neteaseWindow('w')]) {
    const other = fixture([source('a'), first], NETEASE);
    await other.connection.refresh();
    assert.equal(other.connection.selected.id, first.id);
    assert.equal(other.connection.allowGlobalMediaKeys, false, 'the default link never grants the global media keys');
  }
  // The list marks the default, connected or not.
  const marked = mediaSourcesMarkup(connection);
  assert.match(marked, /data-media-source="n1" aria-pressed="true".*已连接 · 默认/);
  assert.match(marked, /data-media-source="a" aria-pressed="false".*<em>连接<\/em>/);
});

test('the user\'s own choice wins over the default: another player is never replaced, a disconnect is final', async () => {
  const { connection, set } = fixture([source('a'), netease('n1')], NETEASE);
  await connection.refresh();
  assert.equal(connection.selected.id, 'n1');
  // The user selects another player: the default no longer applies, also when that player is lost.
  assert.equal(connection.select('a'), true);
  assert.equal(connection.followsPreferred, false);
  await connection.refresh();
  assert.equal(connection.selected.id, 'a');
  set({ sources: [netease('n1')] });
  await connection.refresh();
  assert.equal(connection.disconnected, true);
  assert.equal(connection.selected, undefined, 'a lost player is never replaced by another one');
  assert.equal(connection.awaitsPreferred, false);
  assert.match(mediaConnectionLabel(connection), /来源已断开，请重新选择播放器/);
  set({ sources: [netease('n2')] });
  await connection.refresh();
  assert.equal(connection.selected, undefined);
  // The user disconnects: nothing is connected by itself afterwards, not even the preferred player.
  connection.select('n2');
  assert.equal(connection.followsPreferred, true);
  connection.disconnect();
  assert.equal(connection.followsPreferred, false);
  for (const next of [[netease('n2')], [], new Error('unreadable'), [netease('n3'), source('a')]]) {
    set(next instanceof Error ? next : { sources: next });
    await connection.refresh();
    assert.equal(connection.selected, undefined);
    assert.equal(connection.selectedId, null, 'a disconnect holds through empty and failed readings');
  }
  assert.match(mediaConnectionLabel(connection), /选择播放器后显示当前曲目/);
  assert.match(mediaSourcesMarkup(connection), /data-media-source="n3" aria-pressed="false".*连接 · 默认/);
  // Selecting it again makes it the default link again.
  assert.equal(connection.select('n3'), true);
  assert.equal(connection.followsPreferred, true);
});

test('the preferred player is connected again when it comes back, as a new connection', async () => {
  const { connection, calls, set } = fixture([neteaseWindow('w1')], NETEASE);
  await connection.refresh();
  assert.equal(connection.selected.id, 'w1');
  connection.setGlobalMediaKeys(true);
  assert.equal(connection.allowGlobalMediaKeys, true);
  // While it stays, the default link is not made again: the consent and the controls survive every reading.
  for (let poll = 0; poll < 3; poll++) await connection.refresh();
  assert.equal(connection.allowGlobalMediaKeys, true, 'a present default link keeps the consent across polls');
  assert.equal(connection.can('toggle'), true);
  // NetEase closes: the card and the controls go, nothing else is taken.
  set({ sources: [source('a')] });
  await connection.refresh();
  assert.equal(connection.disconnected, true);
  assert.equal(connection.selected, undefined);
  assert.equal(connection.allowGlobalMediaKeys, false);
  assert.equal(connection.awaitsPreferred, true);
  assert.match(mediaConnectionLabel(connection), /网易云音乐已断开，再次出现时会自动重新连接/);
  assert.equal(await connection.control('toggle'), false);
  // A failed reading in between neither connects nor forgets.
  set(new Error('temporary read failure'));
  await connection.refresh();
  assert.equal(connection.selected, undefined);
  assert.equal(connection.awaitsPreferred, true);
  // It returns as another session (here through the system media session): connected again,
  // and the consent for global media keys is not carried over.
  set({ sources: [source('a'), netease('n2')] });
  await connection.refresh();
  assert.equal(connection.selected.id, 'n2');
  assert.equal(connection.disconnected, false);
  assert.equal(connection.allowGlobalMediaKeys, false);
  // The same holds for a NetEase source the user selected by hand, and for the same ID returning.
  const manual = fixture([source('a'), neteaseWindow('w1')], NETEASE);
  await manual.connection.refresh();
  manual.connection.select('a');
  manual.connection.select('w1');
  manual.connection.setGlobalMediaKeys(true);
  manual.set({ sources: [source('a')] });
  await manual.connection.refresh();
  assert.equal(manual.connection.selected, undefined);
  manual.set({ sources: [source('a'), neteaseWindow('w1')] });
  await manual.connection.refresh();
  assert.equal(manual.connection.selected.id, 'w1');
  assert.equal(manual.connection.allowGlobalMediaKeys, false, 'every new connection asks for the global media keys again');
  assert.equal(await manual.connection.control('next'), false);
  assert.equal(calls.length + manual.calls.length, 0, 'nothing was sent to any player on the way');
});

test('a reading that fails does not connect the default; the surviving default link recovers', async () => {
  const { connection, set } = fixture([netease('n1')], NETEASE);
  set(new Error('snapshot unavailable'));
  await connection.refresh();
  assert.equal(connection.selectedId, null);
  assert.equal(connection.awaitsPreferred, true);
  set({ sources: [netease('n1')] });
  await connection.refresh();
  assert.equal(connection.selected.id, 'n1');
  set(new Error('snapshot unavailable'));
  await connection.refresh();
  assert.equal(connection.selectedId, 'n1');
  assert.equal(connection.selected, undefined);
  assert.equal(connection.awaitsPreferred, false, 'an unreadable snapshot is not a disappearance');
  assert.match(mediaConnectionLabel(connection), /正在重试/);
  set({ sources: [netease('n1')] });
  await connection.refresh();
  assert.equal(connection.selected.id, 'n1');
});

test('global media keys require opt-in for the selected NetEase session and reset on reconnect', async () => {
  const unknown = source('netease:1', { kind: 'netease', playback: 'unknown', duration: undefined, position: undefined });
  const { connection, calls, set } = fixture([unknown]);
  await connection.refresh();
  connection.select(unknown.id);
  assert.equal(connection.can('toggle'), false);
  assert.equal(await connection.control('toggle'), false);
  connection.setGlobalMediaKeys(true);
  assert.equal(connection.can('toggle'), true);
  assert.equal(connection.can('seek'), false);
  assert.equal(mediaPlaybackLabel(connection.selected), '播放状态未知');
  assert.equal(mediaTime(connection.selected.duration), '—');
  assert.equal(await connection.control('toggle'), true);
  assert.deepEqual(calls, [['netease:1', 'toggle', undefined, true]]);
  set({ sources: [] });
  await connection.refresh();
  assert.equal(connection.allowGlobalMediaKeys, false);
  set({ sources: [unknown] });
  await connection.refresh();
  connection.select(unknown.id);
  assert.equal(connection.can('toggle'), false);
});

test('progress and status polls keep the card key stable and never fabricate an audio queue', () => {
  const first = source('a');
  assert.equal(mediaVisualKey(first), mediaVisualKey({ ...first, position: 50, duration: 180, playback: 'paused' }));
  assert.notEqual(mediaVisualKey(first), mediaVisualKey({ ...first, title: '下一首' }));
  const library = mediaLibrary(first);
  assert.equal(library.albums.length, 1);
  assert.deepEqual(library.albums[0].tracks, []);
  assert.equal(library.albums[0].title, first.title);
  assert.equal(library.albums[0].artist, first.artist);
  assert.equal(library.albums[0].coverUrl, undefined);
  assert.equal(mediaLibrary({ ...first, coverUrl: 'file:///private/cover.png' }).albums[0].coverUrl, undefined);
  assert.equal(mediaLibrary({ ...first, coverUrl: 'data:image/png;base64,AQID' }).albums[0].coverUrl, 'data:image/png;base64,AQID');
});

test('only supported controls are sent and seek is bounded by an actual supplied duration', async () => {
  const { connection, calls } = fixture();
  await connection.refresh();
  connection.select('a');
  assert.equal(await connection.control('stop'), false);
  assert.equal(await connection.control('seek', NaN), false);
  assert.equal(await connection.control('seek', Infinity), false);
  assert.equal(await connection.control('seek'), false);
  await connection.control('seek', 999);
  await connection.control('seek', -5);
  assert.deepEqual(calls, [['a', 'seek', 120, false], ['a', 'seek', 0, false]]);
});

test('snapshot failure disables control but an exact surviving session can recover after retry', async () => {
  const { connection, calls, set } = fixture();
  await connection.refresh();
  connection.select('a');
  set(new Error('connection unavailable'));
  await connection.refresh();
  assert.deepEqual(connection.sources, []);
  assert.equal(connection.selected, undefined);
  assert.equal(connection.warning, 'connection unavailable');
  assert.equal(connection.selectedId, 'a');
  assert.equal(connection.disconnected, false);
  assert.match(mediaConnectionLabel(connection), /正在重试/);
  assert.match(mediaSourcesMarkup(connection), /正在重试/);
  assert.equal(connection.can('toggle'), false);
  assert.equal(await connection.control('toggle'), false);
  assert.equal(calls.length, 0);
  set({ sources: [source('b'), source('a', { position: 40 })] });
  await connection.refresh();
  assert.equal(connection.selected.id, 'a');
  assert.equal(connection.selected.position, 40);
  assert.equal(connection.warning, '');
  assert.equal(connection.can('toggle'), true);
  set(new Error('retry again'));
  await connection.refresh();
  set({ sources: [source('different-id', { name: 'Player a' })] });
  await connection.refresh();
  assert.equal(connection.selected, undefined, 'matching player names cannot transfer control');
  assert.equal(connection.selectedId, 'a');
  assert.equal(connection.disconnected, true);
  set({ sources: [source('a')] });
  await connection.refresh();
  assert.equal(connection.selected, undefined, 'a confirmed missing session requires reselection');
});

test('transient snapshot recovery never restores global media-key consent automatically', async () => {
  const selected = source('netease:1', { kind: 'netease', playback: 'unknown' });
  const { connection, calls, set } = fixture([selected]);
  await connection.refresh();
  connection.select(selected.id);
  connection.setGlobalMediaKeys(true);
  assert.equal(connection.can('toggle'), true);
  set(new Error('temporary native timeout'));
  await connection.refresh();
  assert.equal(connection.allowGlobalMediaKeys, false);
  assert.equal(await connection.control('toggle'), false);
  set({ sources: [selected] });
  await connection.refresh();
  assert.equal(connection.selected.id, selected.id);
  assert.equal(connection.allowGlobalMediaKeys, false);
  assert.equal(connection.can('toggle'), false);
  assert.equal(calls.length, 0);
  connection.setGlobalMediaKeys(true);
  assert.equal(await connection.control('toggle'), true);
  assert.deepEqual(calls, [[selected.id, 'toggle', undefined, true]]);
});

test('a pending command keeps its chosen target and a late failure cannot overwrite another selection', async () => {
  let reject;
  const calls = [];
  const connection = new ExternalMediaConnection({
    async snapshot() { return { sources: [source('a'), source('b')] }; },
    control(...args) { calls.push(args); return new Promise((_, fail) => { reject = fail; }); },
  });
  await connection.refresh();
  connection.select('a');
  const pending = connection.control('toggle');
  assert.equal(connection.can('next'), false);
  connection.select('b');
  reject(new Error('old session vanished'));
  await pending;
  assert.equal(connection.error, '');
  assert.deepEqual(calls, [['a', 'toggle', undefined, false]]);
  assert.equal(connection.selected.id, 'b');
});

test('source markup escapes metadata and native requests carry an explicit global-key decision', async () => {
  const { connection } = fixture([source('"<script>', { title: '<img src=x onerror=alert(1)>' })]);
  await connection.refresh();
  const markup = mediaSourcesMarkup(connection);
  assert.ok(!markup.includes('<img'));
  assert.ok(!markup.includes('<script>'));
  const previousWindow = globalThis.window;
  const calls = [];
  globalThis.window = { __TAURI__: { core: { async invoke(...args) { calls.push(args); return { sources: [] }; } } } };
  try {
    await nativeMediaPort.snapshot();
    await nativeMediaPort.control('chosen-source', 'next', undefined, false);
    assert.deepEqual(calls, [
      ['media_snapshot'],
      ['media_control', { sourceId: 'chosen-source', action: 'next', position: undefined, allowGlobalMediaKeys: false }],
    ]);
  } finally { globalThis.window = previousWindow; }
});

test('the NetEase queue becomes one case per song in queue order and never a playable library', async () => {
  const { queueLibrary, queueCover, queueTrackKey, isNeteaseSource } = await import('../src/external-queue.ts');
  const tracks = [
    { id: '1', title: 'A1', artist: 'X', album: 'Album A', albumId: '10', coverUrl: 'https://p3.music.126.net/a/1.jpg', duration: 200 },
    { id: '2', title: 'Single', artist: '', album: '', albumId: '' },
    { id: '3', title: 'A2', artist: 'X', album: 'Album A', albumId: '10', coverUrl: 'https://p3.music.126.net/a/1.jpg', duration: 180 },
    { id: '1', title: 'A1', artist: 'X', album: 'Album A', albumId: '10', duration: 200 },
  ];
  const library = queueLibrary(tracks, '网易云音乐');
  assert.deepEqual(library.albums.map(a => a.title), ['A1', 'Single', 'A2'], 'queue order; a repeated song once');
  assert.deepEqual(library.albums.map(a => a.id), ['netease-track:1', 'netease-track:2', 'netease-track:3']);
  assert.equal(new Set(library.albums.map(a => a.genreId)).size, 1, 'one column, so one step is one song');
  assert.deepEqual(library.albums.map(a => a.tracks.length), [1, 1, 1]);
  assert.equal(library.albums[0].tracks[0].id, queueTrackKey(tracks[0]), 'a box and its song share the ID');
  assert.equal(library.albums[0].coverUrl, 'https://p3.music.126.net/a/1.jpg?param=1024y1024');
  assert.equal(library.albums[2].coverUrl, library.albums[0].coverUrl, 'songs of one album repeat its cover');
  assert.equal(library.albums[1].coverUrl, undefined);
  assert.equal(library.albums[1].artist, '歌手未提供');
  assert.ok(library.albums.flatMap(a => a.tracks).every(t => !t.browserPlayable && !t.audioUrl && !t.relativePath));
  assert.deepEqual(library.genres, [{ id: 'external', name: '网易云音乐' }]);
  assert.deepEqual(queueLibrary([], 'N').genres, []);
  for (const url of ['http://p3.music.126.net/a.jpg', 'https://evil.example/a.jpg', 'https://p3.music.126.net.evil.example/a.jpg', 'javascript:alert(1)'])
    assert.equal(queueCover(url), undefined, url);
  assert.equal(isNeteaseSource(source('n', { kind: 'smtc', player: 'netease' })), true);
  assert.equal(isNeteaseSource(source('n', { kind: 'netease' })), true);
  assert.equal(isNeteaseSource(source('s')), false);
});

test('the playing song is NetEase\'s own ID when its debug port answers, otherwise title then artist', async () => {
  const { playingQueueTrack, queueTrackKey } = await import('../src/external-queue.ts');
  const tracks = [
    { id: '1', title: 'Same', artist: 'First', album: 'A', albumId: '1' },
    { id: '2', title: 'Ｓａｍｅ', artist: 'Second / Guest', album: 'B', albumId: '2' },
    { id: '3', title: 'Other <b>', artist: 'Z', album: 'C', albumId: '3' },
  ];
  assert.equal(playingQueueTrack(tracks, source('n', { title: ' same ', artist: 'Guest' }))?.id, '2', 'full-width text and the shared artist decide');
  assert.equal(playingQueueTrack(tracks, source('n', { title: 'Same', artist: 'Nobody' }))?.id, '1');
  assert.equal(playingQueueTrack(tracks, source('n', { title: 'Missing' })), undefined);
  assert.equal(playingQueueTrack(tracks, source('n', { title: '' })), undefined);
  // The media session may still show the previous title for a moment after a jump.
  assert.equal(playingQueueTrack(tracks, source('n', { title: 'Same', artist: 'First' }), { available: true, trackId: '3' })?.id, '3');
  assert.equal(playingQueueTrack(tracks, source('n', { title: 'Same' }), { available: true, trackId: '99' }), undefined, 'a song outside the queue is not guessed from its title');
  assert.equal(playingQueueTrack(tracks, source('n', { title: 'Other <b>' }), { available: false, trackId: '1' })?.id, '3', 'a closed port falls back to the title');
  assert.equal(queueTrackKey(tracks[2]), 'netease-track:3');
  assert.equal(queueTrackKey(undefined), '');
});

test('queue settings: display is opt-in, song switching names the debug port and offers a restart only when a probe found it closed', async () => {
  const { queueSettingMarkup, queueControlStatus } = await import('../src/external-queue.ts');
  const netease = source('n', { player: 'netease' });
  const on = { enabled: true, available: true, status: 'ok', restart: false };
  const closed = { enabled: true, available: false, status: '<none>', restart: true };
  const unprobed = { enabled: true, available: false, status: '正在检测网易云调试端口…', restart: false };
  assert.equal(queueSettingMarkup(source('s'), true, '', on), '', 'only NetEase sources have a queue');
  const hidden = queueSettingMarkup(netease, false, '<status>', on);
  assert.match(hidden, /id="netease-queue"(?! checked)/);
  assert.match(hidden, /&lt;status&gt;/);
  assert.match(hidden, /歌曲编号、歌名、歌手、专辑、时长和封面地址/, 'the consent names every field that is read');
  assert.doesNotMatch(hidden, /netease-control/, 'song switching is offered only with the queue shown');
  const shown = queueSettingMarkup(netease, true, '', on);
  assert.match(shown, /id="netease-queue" checked/);
  assert.match(shown, /id="netease-control" checked/);
  assert.match(shown, /127\.0\.0\.1:9233/);
  assert.match(shown, /data-debug-restart hidden/, 'no restart button while the port answers');
  const absent = queueSettingMarkup(netease, true, '', closed);
  assert.match(absent, /data-debug-restart ><button id="netease-restart-debug" data-action="netease-restart-debug">/);
  assert.match(absent, /&lt;none&gt;/);
  assert.match(queueSettingMarkup(netease, true, '', unprobed), /data-debug-restart hidden/, 'not before the port was actually asked');
  assert.match(queueSettingMarkup(netease, true, '', { enabled: false, available: false, status: '', restart: false }), /id="netease-control" ><\/label>.*data-debug-restart hidden/s);
  assert.equal(queueControlStatus({ enabled: false, available: true }), '');
  assert.match(queueControlStatus({ enabled: true, available: false }), /未检测到网易云调试端口/);
  assert.match(queueControlStatus({ enabled: true, available: true }, { available: true, mode: 'playOrder' }), /约半秒后/);
  assert.match(queueControlStatus({ enabled: true, available: true }, { available: true, mode: 'playFm' }), /私人 FM/);
});

test('the playback clock runs evenly between whole-second readings and follows seeks, pauses and song changes', async () => {
  const { PlaybackClock } = await import('../src/external-queue.ts');
  const reading = (position, extra = {}) => ({ available: true, trackId: '7', playback: 'playing', duration: 200, position, ...extra });
  const clock = new PlaybackClock();
  assert.equal(clock.position(0), undefined, 'nothing is shown before the first reading');
  clock.update(reading(27), 1000);
  assert.equal(clock.duration, 200);
  assert.equal(clock.position(1000), 27);
  assert.equal(clock.position(1500), 27.5, 'it keeps running between readings');
  // Polls arrive unevenly and NetEase floors: none of these may move the clock.
  let previous = 27;
  for (const [now, position] of [[2000, 28], [3100, 29], [3950, 29], [5000, 31], [6040, 32]]) {
    clock.update(reading(position), now);
    const shown = clock.position(now);
    assert.ok(shown >= previous, `never steps back while playing: ${shown} after ${previous}`);
    assert.ok(Math.abs(shown - (27 + (now - 1000) / 1000)) < 1e-9, 'the clock itself was not reset');
    previous = shown;
  }
  // A seek inside NetEase: the reading disagrees, so the clock takes it.
  clock.update(reading(90), 7000);
  assert.equal(clock.position(7000), 90);
  clock.update(reading(40), 8000);
  assert.equal(clock.position(8000), 40, 'backwards as well');
  // Paused: the reading is exact and nothing runs.
  clock.update(reading(41, { playback: 'paused' }), 9000);
  assert.equal(clock.position(9000), 41);
  assert.equal(clock.position(12000), 41);
  clock.update(reading(41), 13000);
  assert.equal(clock.position(13500), 41.5, 'resumes from the reading');
  // Another song starts at its own position; the end of a song is not passed.
  clock.update(reading(0, { trackId: '8', duration: 100 }), 14000);
  assert.equal(clock.position(14200), 0.2);
  clock.update(reading(99, { trackId: '8', duration: 100 }), 15000);
  assert.equal(clock.position(20000), 100);
  // Rhine's own seek shows at once, and a reading that still has the old position is ignored briefly.
  clock.update(reading(10, { trackId: '8', duration: 100 }), 21000);
  clock.seek(60, 21500);
  assert.equal(clock.position(21500), 60);
  clock.update(reading(10, { trackId: '8', duration: 100 }), 22000);
  assert.equal(clock.position(22000), 60.5, 'the stale reading does not pull it back');
  clock.update(reading(61, { trackId: '8', duration: 100 }), 22700);
  assert.ok(Math.abs(clock.position(22700) - 61.2) < 1e-9, 'NetEase caught up; the clock was not reset');
  clock.update(reading(10, { trackId: '8', duration: 100 }), 24000);
  assert.equal(clock.position(24000), 10, 'after the hold, NetEase is believed again (the seek did not happen)');
  // NetEase playing at half speed (or buffering): the clock waits at the next second instead
  // of running ahead and jumping back.
  const slow = new PlaybackClock();
  let shown = -1;
  for (const [now, position] of [[0, 10], [1000, 10], [2000, 11], [3000, 11], [4000, 12], [5000, 12], [6000, 13]]) {
    slow.update(reading(position), now);
    for (const at of [now, now + 400, now + 900]) {
      const value = slow.position(at);
      assert.ok(value >= shown, `half speed never steps back: ${value} after ${shown}`);
      assert.ok(value <= position + 1, 'never more than a second past the reading');
      shown = value;
    }
  }
  // A seek NetEase refused: once released, its next reading is believed at once.
  const refused = new PlaybackClock();
  refused.update(reading(20), 0);
  refused.seek(90, 100);
  refused.release();
  refused.update(reading(20), 600);
  assert.equal(refused.position(600), 20);
  // No reading, or the port gone: nothing to show.
  clock.update({ available: true, trackId: '8', playback: 'playing', duration: 100 }, 25000);
  assert.equal(clock.position(25000), undefined);
  clock.update({ available: false }, 26000);
  assert.equal(clock.position(26000), undefined);
  assert.equal(clock.duration, undefined);
});

// The JavaScript Rhine evaluates inside NetEase's page lives in the Rust module as raw strings;
// run it here against stand-ins for NetEase's store and progress slider.
async function neteaseScripts() {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src-tauri/src/media/netease_debug.rs', import.meta.url), 'utf8');
  const body = name => {
    const found = source.match(new RegExp('const ' + name + ': &str = r#"([^]*?)"#;'));
    assert.ok(found, `${name} is in netease_debug.rs`);
    return found[1];
  };
  return {
    seek: new Function('id', 'seconds', 'findStore', body('SEEK_BODY')),
    state: new Function('findStore', 'document', body('STATE_BODY')),
  };
}
const neteaseStore = playing => {
  const dispatched = [];
  return { dispatched, getState: () => ({ playing }), dispatch: action => { dispatched.push(action); return new Promise(() => {}); } };
};

test('the seek script moves only the song it was asked about, inside its playable range', async () => {
  const { seek } = await neteaseScripts();
  const loaded = extra => ({ resourceTrackId: 42, playId: '42_abc', playingState: 2, resourceDuration: 200, ...extra });
  const run = (playing, seconds, id = '42') => { const store = neteaseStore(playing); return [seek(id, seconds, () => store), store.dispatched]; };
  assert.equal(seek('42', 10, () => null), 'store');
  assert.deepEqual(run(loaded(), 10, '43'), ['changed', []], 'NetEase moved on to another song');
  assert.deepEqual(run({ playingState: 2, playId: 'x', resourceDuration: 200 }, 10), ['changed', []], 'no current song');
  assert.deepEqual(run(loaded({ playingState: 0, playId: '' }), 10), ['unloaded', []], 'a stopped song is not sought: the native player would never answer');
  assert.deepEqual(run(loaded({ resourceDuration: 1 }), 0), ['unloaded', []]);
  const action = duration => [{ type: 'playing/setPlayingPosition', payload: { duration } }];
  assert.deepEqual(run(loaded(), 83.5), [83.5, action(83.5)]);
  assert.deepEqual(run(loaded({ playingState: 1 }), 12), [12, action(12)], 'paused songs can be sought; nothing resumes them');
  assert.deepEqual(run(loaded(), 500), [199, action(199)], 'never to or past the end');
  assert.deepEqual(run(loaded(), -5), [0, action(0)]);
  assert.deepEqual(run(loaded({ playingState: 1, playId: '', restoreResource: { current: 30 } }), 50), [50, action(50)], 'a song restored at launch stores the position');
  assert.deepEqual(run(loaded({ playingState: 0, playId: '', isLoadingFirst: true }), 50), [50, action(50)]);
  // A trial clip of 60-90 s: the range is the clip, and NetEase counts from the clip's start.
  const trial = loaded({ freeTrialInfo: { start: 60, end: 90 } });
  assert.deepEqual(run(trial, 10), [60, action(0)]);
  assert.deepEqual(run(trial, 75), [75, action(15)]);
  assert.deepEqual(run(trial, 500), [89, action(29)]);
});

test('the state script reads the position from the progress slider and dispatches nothing', async () => {
  const { state } = await neteaseScripts();
  const playing = { resourceTrackId: 42, playingState: 2, playingMode: 'playOrder', resourceDuration: 265, loadingSeekDuration: 0 };
  const component = seconds => ({
    type: function Progress() {}, memoizedProps: { restoreResource: null, resourceDuration: 265, dispatch() {} },
    memoizedState: { memoizedState: seconds }, return: null,
  });
  const page = bar => ({ querySelector: selector => (selector === 'div[aria-label="播放进度调节"]' ? bar : null) });
  const slider = (fibre, input) => ({ '__reactFiber$x1': fibre, querySelector: () => input });
  const read = (bar, extra = {}) => { const store = neteaseStore({ ...playing, ...extra }); const value = state(() => store, page(bar)); assert.deepEqual(store.dispatched, []); return value; };
  const wrapped = { type: 'div', memoizedProps: {}, return: { type: function Other() {}, memoizedProps: { curProcess: 0.1 }, memoizedState: { memoizedState: 5 }, return: component(27) } };
  assert.deepEqual(read(slider(wrapped, null)), { store: true, trackId: '42', state: 2, mode: 'playOrder', duration: 265, position: 27 }, 'the component with the store props, not a nearer one');
  assert.equal(read(slider({ type: 'div', memoizedProps: {}, return: null }, { value: '31' })).position, 31, 'falls back to the range input');
  assert.equal(read(slider(component('27'), { value: '' })).position, 0, 'an unusable hook value falls back to the input');
  assert.equal(read(null).position, null, 'no slider, no position');
  assert.equal(read(slider(component(27), null), { loadingSeekDuration: 50 }).position, 50, 'a pending seek shows its target');
  assert.equal(read(slider(component(27), null), { loadingSeekDuration: 15, freeTrialInfo: { start: 60, end: 90 } }).position, 75, 'on the full-song scale for a trial clip');
  assert.deepEqual(state(() => null, page(null)), { store: false });
});

// Playlist columns. Every playlist and song here is made up for the check.
const laneTrack = (id, extra = {}) => ({ id: String(id), title: `Song ${id}`, artist: 'Singer', album: 'Record', albumId: '1', duration: 100, ...extra });
const laneList = (id, name, tracks, extra = {}) => ({ id: String(id), name, trackCount: tracks.length, liked: false, complete: true, truncated: false, tracks, ...extra });
const lanePlaylists = () => [
  laneList(1, 'Alpha', [laneTrack(11), laneTrack(12)], { liked: true }),
  laneList(2, 'Beta', [laneTrack(21), laneTrack(22), laneTrack(23)]),
  laneList(3, 'Never opened', [], { trackCount: 20, complete: false }),
  laneList(4, 'Gamma', [laneTrack(22), laneTrack(41)], { truncated: true }),
];
const laneShape = lanes => lanes.map(lane => [lane.id, lane.name, lane.live, lane.tracks.map(track => track.id).join()]);

test('playlist columns: one per playlist with songs; the playlist the queue came from shows the queue itself', async () => {
  const { queueLanes, QUEUE_LANE } = await import('../src/external-queue.ts');
  const queue = { tracks: [laneTrack(23), laneTrack(21), laneTrack(99)], truncated: false, source: { id: '2', name: 'Beta' } };
  const lanes = queueLanes(queue, lanePlaylists());
  // NetEase's order; the playlist with no songs on this PC is left out; Beta is the queue, in queue order.
  assert.deepEqual(laneShape(lanes), [['1', 'Alpha', false, '11,12'], ['2', 'Beta', true, '23,21,99'], ['4', 'Gamma', false, '22,41']]);
  assert.deepEqual(lanes.map(lane => [lane.liked, lane.truncated]), [[true, false], [false, false], [false, true]]);
  // A queue from anywhere else (an album, a search, a playlist that is not the user's) is a column of its own in front.
  const loose = queueLanes({ tracks: [laneTrack(90)], truncated: true }, lanePlaylists());
  assert.deepEqual(laneShape(loose), [[QUEUE_LANE, '播放队列', true, '90'], ['1', 'Alpha', false, '11,12'], ['2', 'Beta', false, '21,22,23'], ['4', 'Gamma', false, '22,41']]);
  assert.equal(loose[0].truncated, true, 'the queue column says when the queue was cut short');
  assert.equal(queueLanes({ tracks: [laneTrack(90)], truncated: false, source: { id: '77', name: 'Somebody\'s list' } }, lanePlaylists())[0].name, 'Somebody\'s list');
  // The queue's own playlist is a column even when its songs were never saved on this PC.
  const fresh = queueLanes({ tracks: [laneTrack(5)], truncated: false, source: { id: '3', name: 'Never opened' } }, lanePlaylists());
  assert.deepEqual(laneShape(fresh), [['1', 'Alpha', false, '11,12'], ['2', 'Beta', false, '21,22,23'], ['3', 'Never opened', true, '5'], ['4', 'Gamma', false, '22,41']]);
  // Exactly one live column, and none without a queue.
  for (const result of [lanes, loose, fresh]) assert.equal(result.filter(lane => lane.live).length, 1);
  const idle = queueLanes({ tracks: [], truncated: false, source: { id: '2', name: 'Beta' } }, lanePlaylists());
  assert.deepEqual(laneShape(idle), [['1', 'Alpha', false, '11,12'], ['2', 'Beta', false, '21,22,23'], ['4', 'Gamma', false, '22,41']]);
  // Without playlists the queue is the single column it always was.
  assert.deepEqual(laneShape(queueLanes(queue)), [[QUEUE_LANE, 'Beta', true, '23,21,99']]);
  // A playlist without a name is still a column.
  assert.deepEqual(queueLanes({ tracks: [], truncated: false }, [laneList(8, '', [laneTrack(1)]), laneList(9, '', [laneTrack(2)], { liked: true })]).map(lane => lane.name), ['未命名歌单', '我喜欢的音乐']);
});

test('playlist columns: the queue\'s cases keep the queue\'s keys, every other column has cases of its own', async () => {
  const { queueLanes, laneLibrary, laneTrackKey, laneGenre, queueTrackKey, queueLibrary } = await import('../src/external-queue.ts');
  const queue = { tracks: [laneTrack(23), laneTrack(22), laneTrack(23)], truncated: false, source: { id: '2', name: 'Beta' } };
  const lanes = queueLanes(queue, lanePlaylists());
  assert.equal(laneTrackKey(lanes[1], laneTrack(23)), queueTrackKey(laneTrack(23)), 'what follows and switches NetEase\'s song finds its cases in the queue\'s column');
  assert.equal(laneTrackKey(lanes[2], laneTrack(22)), 'netease-list:4:22');
  assert.equal(laneTrackKey(lanes[0]), '', 'no song, no case');
  const library = laneLibrary(lanes);
  assert.deepEqual(library.genres, [{ id: 'netease-lane:1', name: 'Alpha' }, { id: 'netease-lane:2', name: 'Beta' }, { id: 'netease-lane:4', name: 'Gamma' }]);
  assert.deepEqual(library.genres.map(genre => genre.id), lanes.map(laneGenre));
  // Song 22 is in the queue and in Gamma: one case in each column. Song 23 is twice in the queue: one case.
  assert.deepEqual(library.albums.map(album => [album.id, album.genreId]), [
    ['netease-list:1:11', 'netease-lane:1'], ['netease-list:1:12', 'netease-lane:1'],
    ['netease-track:23', 'netease-lane:2'], ['netease-track:22', 'netease-lane:2'],
    ['netease-list:4:22', 'netease-lane:4'], ['netease-list:4:41', 'netease-lane:4'],
  ]);
  // The live column is the queue's own shelf, case for case.
  assert.deepEqual(library.albums.filter(album => album.genreId === 'netease-lane:2').map(album => album.id), queueLibrary(queue.tracks, 'x').albums.map(album => album.id));
  // Nothing in any column is playable by Rhine itself, and no local path is invented.
  for (const album of library.albums) {
    assert.equal(album.folder, '');
    assert.deepEqual(album.tracks.map(track => [track.browserPlayable, track.audioUrl, track.relativePath]), [[false, '', '']]);
  }
  assert.deepEqual(laneLibrary([]).albums, []);
});

test('playlist columns are on by default once the queue is shown, say what is read, and have no style setting', async () => {
  const { queueSettingMarkup } = await import('../src/external-queue.ts');
  const netease = source('n', { player: 'netease' });
  const control = { enabled: true, available: true, status: 'ok', restart: false };
  // The queue itself stays opt-in; its consent says that playlist columns come with it.
  const hidden = queueSettingMarkup(netease, false, '', control);
  assert.doesNotMatch(hidden, /netease-playlists/, 'offered only with the queue shown');
  assert.match(hidden, /打开后默认同时按歌单分列（读取本机歌单，见下方），可单独关闭。/);
  const on = queueSettingMarkup(netease, true, '', control);
  assert.match(on, /id="netease-playlists" checked/, 'on unless switched off');
  assert.match(on, /<span>按歌单分列<small>默认打开。/);
  for (const said of [/webdb\.dat，只读/, /你创建的歌单（含“我喜欢的音乐”）/, /编号、名称、歌曲数与封面地址/, /编号、歌名、歌手、专辑、时长和封面地址/, /来源歌单编号与名称/, /列旁标出歌单名称/, /只供浏览、不会切歌/, /不读取收藏的歌单、账号、Cookie 或播放历史/, /Rhine 不保存歌单名称和歌曲列表/, /封面图片从网易云公开图片服务器加载，会留在界面缓存里/])
    assert.match(on, said, 'the consent names what is read and what is not');
  const off = queueSettingMarkup(netease, true, '<q>', control, { enabled: false, status: '<3 lists>' });
  assert.match(off, /id="netease-playlists" ><\/label>/);
  assert.match(off, /data-playlist-status role="status"><\/p>/, 'no status while it is off');
  assert.match(queueSettingMarkup(netease, true, '', control, { enabled: true, status: '<3 lists>' }), /data-playlist-status role="status">&lt;3 lists&gt;<\/p>/);
  // There is one way to show the names (written in the scene): no style to choose.
  for (const markup of [on, off]) assert.doesNotMatch(markup, /netease-lane-labels|歌单名称的样式|文字标签|<select/);
  // The preference: a new key, so the old default (off, saved with every preference) does not outlive the new one.
  const app = (await import('node:fs')).readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8');
  assert.match(app, /playlistColumns: true,/);
  assert.match(app, /for \(const key of \["laneLabels", "laneNameStyle", "neteasePlaylists"\]\) delete \(preferences as Record<string, unknown>\)\[key\];/);
  assert.doesNotMatch(app, /preferences\.neteasePlaylists|laneNameStyle =|netease-lane-labels/);
  // The queue itself stays off until switched on.
  assert.match(app, /neteaseQueue: false,/);
});

test('the playlist port asks the native side with the last stamp and nothing else, and only in the client', async () => {
  const { nativePlaylistPort } = await import('../src/external-queue.ts');
  const calls = [];
  const before = globalThis.window;
  globalThis.window = {};
  try {
    await assert.rejects(nativePlaylistPort.read('p1'), /需要 Windows 客户端/);
    globalThis.window = { __TAURI__: { core: { invoke: async (command, args) => { calls.push([command, args]); return { status: 'missing' }; } } } };
    assert.deepEqual(await nativePlaylistPort.read('p1'), { status: 'missing' });
    assert.deepEqual(await nativePlaylistPort.read(), { status: 'missing' });
  } finally { globalThis.window = before; }
  assert.deepEqual(calls, [['netease_playlists', { stamp: 'p1' }], ['netease_playlists', { stamp: null }]]);
  // The queue's source playlist is asked for only when the caller says playlist columns are on.
  const { nativeQueuePort } = await import('../src/external-queue.ts');
  calls.length = 0;
  globalThis.window = { __TAURI__: { core: { invoke: async (command, args) => { calls.push([command, args]); return { status: 'missing' }; } } } };
  try {
    await nativeQueuePort.read('q1');
    await nativeQueuePort.read('q1', false);
    await nativeQueuePort.read('q1', true);
  } finally { globalThis.window = before; }
  assert.deepEqual(calls, [['netease_queue', { stamp: 'q1', source: false }], ['netease_queue', { stamp: 'q1', source: false }], ['netease_queue', { stamp: 'q1', source: true }]]);
  const app = (await import('node:fs')).readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8');
  assert.match(app, /nativeQueuePort\.read\(queueStamp, preferences\.playlistColumns\)/);
  assert.equal((app.match(/nativeQueuePort\.read\(/g) || []).length, 1, 'the one place the queue is read');
});

test('the playlists status: what is waiting for NetEase, what the limits cut, and no stale error', async () => {
  const { playlistSummary } = await import('../src/external-queue.ts');
  const lists = [
    laneList(1, 'Alpha', [laneTrack(11)]),
    laneList(2, 'Never opened', [], { trackCount: 20, complete: false }),
    laneList(3, 'Empty', [], { trackCount: 0 }),
  ];
  assert.equal(playlistSummary(lists, false), '已读取 1 个歌单；另有 1 个歌单在这台电脑上还没有歌曲数据，在网易云里打开或播放一次后出现。');
  assert.equal(playlistSummary(lists.slice(0, 1), false), '已读取 1 个歌单。');
  assert.match(playlistSummary([lists[1]], false), /^网易云在这台电脑上还没有保存任何歌单的歌曲。/);
  assert.match(playlistSummary([], false), /^网易云在这台电脑上还没有保存任何歌单的歌曲。/);
  // A playlist the reader cut to nothing is not waiting for NetEase: opening it there changes nothing.
  const cut = [...lists, laneList(4, 'Beyond the limit', [], { trackCount: 500, truncated: true })];
  const said = playlistSummary(cut, true);
  assert.match(said, /^已读取 1 个歌单；另有 1 个歌单在这台电脑上还没有歌曲数据/, 'still one waiting, not two');
  assert.match(said, /超过上限（200 个歌单、每个 3,000 首、合计 12,000 首）的部分没有显示。$/);
  assert.match(playlistSummary([laneList(5, 'Long', [laneTrack(1)], { truncated: true })], false), /超过上限/, 'a playlist cut partway says so too');
  assert.match(playlistSummary(lists, true), /超过上限/, 'more playlists than the limit');
  assert.doesNotMatch(playlistSummary(lists, false), /超过上限/);
  // The app rebuilds the status from the playlists it holds on every answer, "unchanged" included.
  const app = (await import('node:fs')).readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8');
  assert.match(app, /\/\/ Also for "unchanged": a read that failed before left its error in the status\.[\s\S]{0,120}if \(externalPlaylists\) playlistStatus = playlistSummary\(externalPlaylists, playlistsCut\);/);
});

test('following survives a rebuilt shelf: the playing song of the new queue, never a browse-only column by default', async () => {
  const app = (await import('node:fs')).readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8');
  const block = app.slice(app.indexOf('if (externalMode && records.length && records[selected]?.id !== previousId) {'), app.indexOf('// A column opens where it was left'));
  assert.ok(block.length > 200, 'the block is in applyLibrary');
  // The playing song is asked of the queue just read, not of the last poll's key.
  assert.match(block, /queueTrackKey\(playingQueueTrack\(queue\.tracks, externalMedia\?\.selected, debugState\)\)/);
  assert.doesNotMatch(block, /record\.id === queuePlaying/);
  assert.match(block, /const liveColumn = archiveColumns\.findIndex\(\(_, column\) => laneAt\(columnFiles\(column\)\[0\]\)\?\.live\);/);
  assert.match(block, /if \(playing >= 0\) selected = playing;\s*else if \(liveColumn >= 0\) selected = columnFiles\(liveColumn\)\[0\];/);
  // Stepping into the queue's column never plays: following resumes whether or not the playing song has a case there.
  assert.match(app, /const live = !!laneAt\(columnFiles\(lane\)\[0\]\)\?\.live;[\s\S]{0,260}if \(live\) queueFollowPaused = false;/);
  // A column opens where it was left across rebuilds.
  assert.match(app, /const kept = columnFiles\(lane\)\.find\(\(index\) => remembered\.has\(records\[index\]\.id\)\);\s*return kept === undefined \? \[\] : /, 'only cases that exist are carried over; an unvisited column has no entry');
  // A column step ends the wheel's glide, so rows still owed cannot move (and play) in the queue's column.
  assert.match(app, /if \(live\) queueFollowPaused = false;[\s\S]{0,160}wheelNavigation\.reset\(\);/);
});
