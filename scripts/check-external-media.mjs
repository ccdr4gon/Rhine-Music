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
