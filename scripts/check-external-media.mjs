import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExternalMediaConnection, mediaLibrary, mediaVisualKey, mediaTime,
  mediaPlaybackLabel, mediaConnectionLabel, mediaSourcesMarkup, nativeMediaPort,
} from '../src/external-media.ts';

const source = (id, extra = {}) => ({
  id, name: `Player ${id}`, kind: 'smtc', title: '当前曲目', artist: '歌手', album: '专辑',
  playback: 'playing', position: 12, duration: 120,
  capabilities: { toggle: true, previous: true, next: true, stop: false, seek: true },
  ...extra,
});
function fixture(initial = [source('a'), source('b')]) {
  let snapshot = { sources: initial };
  const calls = [];
  const connection = new ExternalMediaConnection({
    async snapshot() { if (snapshot instanceof Error) throw snapshot; return snapshot; },
    async control(...args) { calls.push(args); },
  });
  return { connection, calls, set: next => { snapshot = next; } };
}

test('sources never auto-select; refresh and another playing source do not transfer user control', async () => {
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
  assert.match(absent, /data-debug-restart ><button data-action="netease-restart-debug">/);
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
