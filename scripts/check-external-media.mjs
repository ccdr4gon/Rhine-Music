import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExternalMediaConnection, mediaLibrary, mediaVisualKey, mediaTime,
  mediaPlaybackLabel, mediaConnectionLabel, mediaSourcesMarkup, mediaPermissionMarkup, nativeMediaPort,
  readSourceLink, sourceLink,
} from '../src/external_player/external-media.ts';
import { isNeteaseSource, NETEASE_PLAYER } from '../src/netease_music/connector/player.ts';
import { PLAYER_MODULES, PREFERRED_PLAYER, playerLinks, playerMediaPort } from '../src/music-sources.ts';

const source = (id, extra = {}) => ({
  id, name: `Player ${id}`, kind: 'smtc', title: '当前曲目', artist: '歌手', album: '专辑',
  playback: 'playing', position: 12, duration: 120,
  capabilities: { toggle: true, previous: true, next: true, stop: false, seek: true },
  ...extra,
});
// `links`: what the connection remembers (music-sources.ts playerLinks, here without saving);
// `wrap`: what the app puts between the native port and the connection (music-sources.ts playerMediaPort).
function fixture(initial = [source('a'), source('b')], links, wrap = port => port) {
  let snapshot = { sources: initial };
  const calls = [];
  const connection = new ExternalMediaConnection(wrap({
    async snapshot() { if (snapshot instanceof Error) throw snapshot; return snapshot; },
    async control(...args) { calls.push(args); },
  }), links);
  return { connection, calls, set: next => { snapshot = next; } };
}
// The app's links with nothing remembered yet: the known players, and NetEase (however Windows
// lists it) as the default link.
const NETEASE = { players: PLAYER_MODULES, fallback: NETEASE_PLAYER };
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
  // Nothing is the default link after a disconnect: no row says 默认.
  assert.match(mediaSourcesMarkup(connection), /data-media-source="n3" aria-pressed="false".*<em>连接<\/em>/);
  assert.doesNotMatch(mediaSourcesMarkup(connection), /默认/);
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

// QQ Music, connected through its media session only. Every session here is made up for the check:
// as Windows lists it (under its app id; the native side names it 「QQ音乐」 too), with QQ Music's
// controls at the time of the survey (no stop, no seeking, no timeline).
const qq = (id, extra = {}) => source(id, {
  name: 'QQMusic.exe', player: 'qqmusic', title: 'Fictional Song', artist: 'Fictional Artist', album: '',
  position: undefined, duration: undefined,
  capabilities: { toggle: true, previous: true, next: true, stop: false, seek: false }, ...extra,
});

test('the player modules: NetEase is the only default link while nothing was connected; QQ Music is known by its session\'s mark', async () => {
  const { playerModule, playerSource } = await import('../src/music-sources.ts');
  const { QQ_MUSIC_PLAYER, QQ_MUSIC_NAME, isQqMusicSource } = await import('../src/qq_music/connector/player.ts');
  assert.deepEqual(PLAYER_MODULES.map(player => player.id), ['netease', 'qqmusic']);
  assert.equal(PREFERRED_PLAYER, NETEASE_PLAYER, 'NetEase stays the default link');
  assert.equal(PREFERRED_PLAYER.name, '网易云音乐');
  assert.equal(PREFERRED_PLAYER.match, isNeteaseSource);
  assert.equal(QQ_MUSIC_NAME, 'QQ音乐');
  assert.equal(isQqMusicSource(qq('q')), true);
  for (const other of [source('s'), netease('n'), neteaseWindow('w'), source('x', { name: 'QQMusic.exe' }), source('y', { name: 'QQ音乐' }), source('z', { player: 'qq' }), undefined])
    assert.equal(isQqMusicSource(other), false, 'only the native side\'s mark, never a name');
  assert.equal(isNeteaseSource(qq('q')), false, 'QQ Music is not NetEase');
  assert.equal(playerModule(qq('q')), QQ_MUSIC_PLAYER);
  assert.equal(playerModule(netease('n')), NETEASE_PLAYER);
  assert.equal(playerModule(source('s')), undefined);
  assert.equal(playerModule(undefined), undefined);
  // Shown under its own name, whatever the snapshot calls it; every other field is the session's own.
  const shown = playerSource(qq('q'));
  assert.equal(shown.name, 'QQ音乐');
  assert.deepEqual({ ...shown, name: 'QQMusic.exe' }, qq('q'));
  assert.equal(playerSource(qq('q', { name: 'QQ音乐' })).name, 'QQ音乐');
  // NetEase's media session under its own name too (the owner, 2026-10-06: "show 网易云音乐 instead"),
  // every other field the session's own; its window-title fallback and everyone else exactly as listed.
  const neteaseShown = playerSource(netease('n'));
  assert.equal(neteaseShown.name, '网易云音乐');
  assert.deepEqual({ ...neteaseShown, name: 'cloudmusic.exe' }, netease('n'));
  assert.equal(playerSource(netease('n', { app: 'CloudMusic.exe' })).name, '网易云音乐');
  // Only its own program: another session taken for NetEase keeps the name Windows gives it.
  for (const other of [netease('o', { name: 'NetEase.CloudMusic', app: 'NetEase.CloudMusic' }), netease('p', { name: 'Some NetEase Client', app: 'Vendor.NeteaseClient!App' })])
    assert.equal(playerSource(other), other);
  for (const other of [neteaseWindow('w'), source('s'), source('x', { name: 'QQMusic.exe' })])
    assert.equal(playerSource(other), other);
  // The native side marks and names QQ Music's session with the same words.
  const { readFileSync } = await import('node:fs');
  const native = readFileSync(new URL('../src-tauri/src/qq_music/mod.rs', import.meta.url), 'utf8');
  assert.match(native, new RegExp(`pub const PLAYER: &str = "${QQ_MUSIC_PLAYER.id}";`));
  assert.match(native, new RegExp(`pub const NAME: &str = "${QQ_MUSIC_NAME}";`));
  // And NetEase's, under the name the page lists it by (2026-10-06).
  const neteaseNative = readFileSync(new URL('../src-tauri/src/netease_music/mod.rs', import.meta.url), 'utf8');
  assert.match(neteaseNative, new RegExp(`pub const PLAYER: &str = "${NETEASE_PLAYER.id}";`));
  assert.match(neteaseNative, new RegExp(`pub const NAME: &str = "${NETEASE_PLAYER.name}";`));
  // ... and every session it lists goes through the module of its player (media::player_source): the
  // mark that gates NetEase's features, and QQ Music's and NetEase's names. The Windows-only reader has no unit test.
  const windowsMedia = readFileSync(new URL('../src-tauri/src/media/windows_media.rs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const readStart = windowsMedia.indexOf('\nfn read_source(entry: &mut Entry, known: &HashMap<String, u64>) -> Source {\n');
  assert.ok(readStart >= 0, 'the native side reads each session in read_source');
  const readSource = windowsMedia.slice(readStart, windowsMedia.indexOf('\n}\n', readStart + 1) + 3);
  // (Its fields start from blank_source, also what a failed read keeps the last song in: 2026-10-24.)
  assert.match(readSource, /let mut source = blank_source\(&entry\.id, &entry\.name, &entry\.app\);/);
  const blank = windowsMedia.slice(windowsMedia.indexOf('\nfn blank_source('), windowsMedia.indexOf('\n}\n', windowsMedia.indexOf('\nfn blank_source(')) + 3);
  assert.match(blank, /\n        player: None,\n/, 'a session is marked by its player\'s module only');
  assert.match(readSource, /\n    player_source\(&entry\.app, source\)\n\}\n$/, 'each session ends in its player\'s module');
  // The app's connection takes its links from the registry (the saved link, NetEase while there is none), and reads through it.
  const app = readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8');
  assert.match(app, /new ExternalMediaConnection\(playerMediaPort\(nativeMediaPort\), playerLinks\(preferences\.playerLink, /);
});

test('the registry\'s port only renames QQ Music\'s and NetEase\'s media sessions: the window fallback, controls and errors pass through unchanged', async () => {
  const { playerMediaPort } = await import('../src/music-sources.ts');
  const calls = [];
  let fail;
  const port = playerMediaPort({
    async snapshot() { if (fail) throw fail; return { sources: [qq('q1'), netease('n1', { app: 'cloudmusic.exe' }), neteaseWindow('w1'), source('a')], warning: 'one warning' }; },
    async control(...args) { calls.push(args); return 'sent'; },
  });
  const snapshot = await port.snapshot();
  // NetEase's session is listed as 网易云音乐 (the owner, 2026-10-06), not as Windows names it.
  assert.deepEqual(snapshot.sources.map(item => item.name), ['QQ音乐', '网易云音乐', '网易云音乐（窗口标题）', 'Player a']);
  const listed = snapshot.sources[1];
  assert.deepEqual([listed.id, listed.player, listed.kind, listed.app, listed.title], ['n1', 'netease', 'smtc', 'cloudmusic.exe', '当前曲目']);
  assert.equal(snapshot.warning, 'one warning');
  assert.equal(await port.control('q1', 'seek', 12, false), 'sent');
  await port.control('n1', 'toggle', undefined, true);
  assert.deepEqual(calls, [['q1', 'seek', 12, false], ['n1', 'toggle', undefined, true]]);
  fail = new Error('unreadable');
  await assert.rejects(port.snapshot(), /unreadable/, 'an unreadable snapshot stays an error, never an empty list');
});

test('QQ Music is listed like any player: connected by itself only once the user picked it, never in place of another, no global keys, no NetEase features', async () => {
  const { queueSettingMarkup } = await import('../src/netease_music/connector/settings.ts');
  // As the app builds its connection: through the registry's port.
  const app = (initial) => fixture(initial, NETEASE, playerMediaPort);
  // Found alone or beside NetEase: listed under its own name, only NetEase is connected by itself.
  const alone = app([qq('q1')]);
  await alone.connection.refresh();
  assert.equal(alone.connection.selected, undefined);
  assert.equal(alone.connection.awaitsPreferred, true);
  const listed = mediaSourcesMarkup(alone.connection);
  assert.match(listed, /data-media-source="q1" aria-pressed="false"><span><strong>QQ音乐<\/strong><small>Fictional Song · Fictional Artist<\/small><\/span><em>连接<\/em>/);
  assert.doesNotMatch(listed, /默认|QQMusic\.exe/);
  assert.match(mediaConnectionLabel(alone.connection), /未发现网易云音乐/, 'the status names only the default link');
  const both = app([qq('q1'), netease('n1')]);
  await both.connection.refresh();
  assert.equal(both.connection.selected.id, 'n1');
  assert.match(mediaSourcesMarkup(both.connection), /<strong>QQ音乐<\/strong>.*<em>连接<\/em>.*<strong>网易云音乐<\/strong>.*已连接 · 默认/);
  // Picked by the user: connected under its name, and NetEase appearing does not replace it.
  // From now on it is the remembered source, the default link instead of NetEase (2026-10-06).
  const { connection, calls, set } = app([qq('q1')]);
  await connection.refresh();
  assert.equal(connection.select('q1'), true);
  assert.equal(connection.followsPreferred, true);
  assert.deepEqual(connection.remembered, { player: 'qqmusic' });
  assert.equal(connection.selected.name, 'QQ音乐');
  assert.match(mediaConnectionLabel(connection), /^QQ音乐 · 正在播放$/);
  set({ sources: [qq('q1'), netease('n1')] });
  await connection.refresh();
  assert.equal(connection.selected.id, 'q1');
  // The shelf: one card for the song it shows, under its name; never an album, a queue or columns.
  const shelf = mediaLibrary(connection.selected);
  assert.deepEqual(shelf.genres, [{ id: 'external', name: 'QQ音乐' }]);
  assert.deepEqual(shelf.albums.map(album => [album.id, album.title, album.artist, album.tracks.length]), [['external:q1', 'Fictional Song', 'Fictional Artist', 0]]);
  // Its own session's controls, never the global media keys.
  connection.setGlobalMediaKeys(true);
  assert.equal(connection.allowGlobalMediaKeys, false);
  assert.equal(mediaPermissionMarkup(connection), '');
  assert.equal(await connection.control('next'), true);
  assert.deepEqual(calls, [['q1', 'next', undefined, false]]);
  // None of NetEase's own features: no queue, no playing the selection, no playlist columns.
  assert.equal(queueSettingMarkup(connection.selected, true, '', { enabled: true, available: true, status: '', restart: false }), '');
  // Lost: nothing else is taken, NetEase included.
  set({ sources: [netease('n1')] });
  await connection.refresh();
  assert.equal(connection.disconnected, true);
  assert.equal(connection.selected, undefined);
  assert.equal(connection.awaitsPreferred, true);
  assert.match(mediaConnectionLabel(connection), /QQ音乐已断开，再次出现时会自动重新连接/);
  set({ sources: [netease('n2')] });
  await connection.refresh();
  assert.equal(connection.selected, undefined, 'NetEase does not replace a lost QQ Music');
  // ... and QQ Music coming back as a new session is connected again: it is the remembered player.
  set({ sources: [qq('q2'), netease('n2')] });
  await connection.refresh();
  assert.equal(connection.selected.id, 'q2');
  assert.equal(connection.allowGlobalMediaKeys, false);
  // And a lost NetEase is not replaced by QQ Music.
  const lost = app([qq('q1'), netease('n1')]);
  await lost.connection.refresh();
  lost.set({ sources: [qq('q1')] });
  await lost.connection.refresh();
  assert.equal(lost.connection.selected, undefined);
  assert.equal(lost.connection.selectedId, 'n1');
  assert.match(mediaConnectionLabel(lost.connection), /网易云音乐已断开，再次出现时会自动重新连接/);
  assert.equal(calls.length + alone.calls.length + both.calls.length + lost.calls.length, 1, 'only the one control the user sent');
});

test('QQ Music\'s controls are exactly the ones its session enables', async () => {
  const { connection, calls, set } = fixture([qq('q1')], NETEASE, playerMediaPort);
  await connection.refresh();
  connection.select('q1');
  // As surveyed: play / pause, previous, next; no stop, no seeking, no timeline.
  for (const action of ['toggle', 'previous', 'next']) assert.equal(connection.offers(action), true, action);
  for (const action of ['stop', 'seek']) assert.equal(connection.offers(action), false, action);
  assert.equal(await connection.control('stop'), false);
  assert.equal(await connection.control('seek', 30), false);
  assert.deepEqual(calls, [], 'an action the session does not enable is never sent');
  // Seeking needs both the session's permission and a length to seek in.
  set({ sources: [qq('q1', { capabilities: { toggle: true, previous: true, next: true, stop: false, seek: true } })] });
  await connection.refresh();
  assert.equal(connection.offers('seek'), false, 'no length, no seeking');
  set({ sources: [qq('q1', { position: 30, duration: 200, capabilities: { toggle: true, previous: true, next: true, stop: true, seek: true } })] });
  await connection.refresh();
  assert.equal(connection.offers('seek'), true);
  assert.equal(connection.offers('stop'), true, 'stop as soon as the session offers it');
  assert.equal(await connection.control('seek', 999), true);
  assert.deepEqual(calls, [['q1', 'seek', 200, false]], 'within the length, without global keys');
  // A session that enables nothing (QQ Music idle, between songs): no control at all.
  set({ sources: [qq('q1', { title: '', artist: '', playback: 'stopped', capabilities: { toggle: false, previous: false, next: false, stop: false, seek: false } })] });
  await connection.refresh();
  for (const action of ['toggle', 'previous', 'next', 'stop', 'seek']) assert.equal(connection.can(action), false, action);
  assert.equal(await connection.control('toggle'), false);
  assert.equal(calls.length, 1);
  // ... and its card says the song is missing rather than making one up.
  assert.deepEqual(mediaLibrary(connection.selected).albums.map(album => [album.title, album.artist]), [['曲名未提供', '歌手未提供']]);
});

test('with QQ Music connected, the NetEase session reads nothing, whatever NetEase\'s switches say', async () => {
  const { NeteaseSession } = await import('../src/netease_music/connector/session.ts');
  const reads = [];
  const refuse = name => async () => { reads.push(name); throw new Error(`${name} is never asked`); };
  const ports = {
    queue: { read: refuse('queue') }, playlists: { read: refuse('playlists') },
    debug: { state: refuse('state'), play: refuse('play'), seek: refuse('seek'), restart: refuse('restart') },
  };
  const { connection, calls } = fixture([qq('q1'), netease('n1')], NETEASE, playerMediaPort);
  await connection.refresh();
  connection.select('q1');
  const session = new NeteaseSession({
    media: connection, preferences: { neteaseQueue: true, playlistColumns: true },
    recordId: () => undefined, genreId: () => undefined, indexOf: () => -1,
    selected: () => 0, navigationSelection: () => 0, canFollow: () => true, follow() { throw new Error('nothing to follow'); }, songChanged() {}, jumpChanged() {},
    confirmSoon() {}, async refresh() {}, notify() {},
  }, ports);
  for (let poll = 0; poll < 3; poll++) await session.refresh();
  session.followQueue();
  assert.deepEqual(reads, [], 'no queue, playlists or debugging port for QQ Music');
  assert.equal(session.shownQueue(), undefined);
  assert.equal(session.shelf(connection.selected), undefined, 'the shelf is the one live card');
  assert.equal(session.queueSongToPlay(), undefined);
  assert.equal(session.playback(connection.selected), 'playing', 'its own session\'s word');
  assert.deepEqual(calls, []);
});

test('the QQ Music module reads nothing and sends nothing of its own', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const folder = new URL('../src/qq_music/', import.meta.url);
  const files = readdirSync(folder, { recursive: true }).map(String).filter(file => file.endsWith('.ts'));
  assert.ok(files.length >= 2, 'its data and connector');
  for (const file of files)
    assert.doesNotMatch(readFileSync(new URL(file.replace(/\\/g, '/'), folder), 'utf8'), /invoke\(|__TAURI__|fetch\(|localStorage|WebSocket|XMLHttpRequest/, file);
  // Nor the native side: recognising its media session is all it does (every file of the module, also one added later).
  const native = new URL('../src-tauri/src/qq_music/', import.meta.url);
  const rustFiles = readdirSync(native, { recursive: true }).map(String).filter(file => file.endsWith('.rs'));
  assert.ok(rustFiles.length >= 3, 'its mod.rs, data and connector');
  const rust = rustFiles.map(file => readFileSync(new URL(file.replace(/\\/g, '/'), native), 'utf8')).join('\n');
  assert.doesNotMatch(rust, /std::fs|File::|rusqlite|TcpStream|std::net|tungstenite|reqwest|process::Command|windows::|OpenProcess|tauri::command/);
  assert.match(rust, /app\.eq_ignore_ascii_case\("QQMusic\.exe"\)/, 'the whole app id, not a part of it');
});

// The owner (2026-10-06): "when connected to a source like netease, next time program starts, keep
// it connected and do not let the user choose again". A restart here is a new connection built from
// what the last one saved, through JSON as the preferences carry it.
const saving = (initial, remembered, wrap = port => port) => {
  const saved = [];
  let snapshot = { sources: initial };
  const calls = [];
  const port = wrap({
    async snapshot() { if (snapshot instanceof Error) throw snapshot; return snapshot; },
    async control(...args) { calls.push(args); },
  });
  const connection = new ExternalMediaConnection(port, { ...NETEASE, remembered, remember: link => saved.push(link) });
  return { connection, calls, saved, set: next => { snapshot = next; } };
};
// `link` undefined: nothing was saved (preferences of an older version).
const restart = (link, initial, wrap) => saving(initial, readSourceLink(link === undefined ? undefined : JSON.parse(JSON.stringify(link)), PLAYER_MODULES), wrap);
const fictionalApp = (id, extra = {}) => source(id, { name: 'Fictional Player', app: 'Fictional.Player_0abc!App', ...extra });

test('the connected source is remembered by what lasts: its player\'s module, else its session\'s app id', async () => {
  const { connection, saved, set } = saving([source('a'), netease('n1')]);
  await connection.refresh();
  // The default link connecting NetEase is a connection like any other: it is remembered, once.
  assert.equal(connection.selected.id, 'n1');
  assert.deepEqual(saved, [{ player: 'netease' }]);
  for (let poll = 0; poll < 3; poll++) await connection.refresh();
  // Lost and back as a new session (another id, or the window title instead of the media session): the same link.
  set({ sources: [source('a')] });
  await connection.refresh();
  set({ sources: [source('a'), neteaseWindow('w2')] });
  await connection.refresh();
  assert.equal(connection.selected.id, 'w2');
  assert.deepEqual(saved, [{ player: 'netease' }], 'nothing new to save while it is the same player');
  // Another player replaces it: QQ Music by its module, any other by its session's app id and listed name.
  set({ sources: [qq('q1'), fictionalApp('s1'), source('plain'), neteaseWindow('w2')] });
  await connection.refresh();
  assert.equal(connection.select('q1'), true);
  assert.equal(connection.select('s1'), true);
  assert.deepEqual(saved.slice(1), [{ player: 'qqmusic' }, { app: 'Fictional.Player_0abc!App', name: 'Fictional Player' }]);
  // A session without an app id cannot be remembered: none is, and nothing else is connected by itself.
  assert.equal(connection.select('plain'), true);
  assert.equal(saved.at(-1), null);
  assert.equal(connection.followsPreferred, false);
  // Only the identity is ever saved: never a session id, a song, a cover or a state.
  const words = JSON.stringify(saved);
  for (const never of ['n1', 'w2', 'q1', 's1', 'smtc', '当前曲目', '歌手', '专辑', 'Fictional Song', 'playing', 'cover', 'title'])
    assert.ok(!words.includes(never), `${never} in ${words}`);
});

test('after a restart the remembered player is connected as soon as it appears, and no other player instead', async () => {
  // QQ Music was connected last time; this time NetEase and another player are there first.
  const { connection, calls, saved, set } = restart({ player: 'qqmusic' }, [netease('n1'), fictionalApp('s1')], playerMediaPort);
  await connection.refresh();
  assert.equal(connection.selected, undefined, 'NetEase is not the default link any more');
  assert.equal(connection.selectedId, null);
  assert.equal(connection.awaitsPreferred, true);
  assert.equal(connection.remembers, true);
  // It is awaited by name; nothing asks to choose.
  assert.equal(mediaConnectionLabel(connection), '等待 QQ音乐…');
  const listed = mediaSourcesMarkup(connection);
  assert.doesNotMatch(listed, /默认/, 'neither present player is the default link');
  // A failed reading in between neither connects nor forgets.
  set(new Error('temporary read failure'));
  await connection.refresh();
  assert.equal(connection.awaitsPreferred, true);
  // QQ Music appears behind them: connected by itself, under its name, without global keys.
  set({ sources: [netease('n1'), fictionalApp('s1'), qq('q7')] });
  await connection.refresh();
  assert.equal(connection.selected.id, 'q7');
  assert.equal(connection.selected.name, 'QQ音乐');
  assert.equal(connection.allowGlobalMediaKeys, false);
  assert.match(mediaConnectionLabel(connection), /^QQ音乐 · 正在播放$/);
  assert.match(mediaSourcesMarkup(connection), /data-media-source="q7" aria-pressed="true">.*已连接 · 默认/);
  // It goes: nothing is taken instead, and it is connected again when it comes back.
  set({ sources: [netease('n1'), fictionalApp('s1')] });
  await connection.refresh();
  assert.equal(connection.selected, undefined);
  assert.equal(connection.disconnected, true);
  assert.match(mediaConnectionLabel(connection), /^QQ音乐已断开，再次出现时会自动重新连接$/);
  set({ sources: [netease('n1'), qq('q8'), fictionalApp('s1')] });
  await connection.refresh();
  assert.equal(connection.selected.id, 'q8');
  assert.deepEqual(saved, [], 'the same player: nothing new to save');
  assert.deepEqual(calls, [], 'connecting sends nothing to any player');
  // Present at the first reading: connected at once, before anything is shown.
  const ready = restart({ player: 'qqmusic' }, [netease('n1'), qq('q1')], playerMediaPort);
  await ready.connection.refresh();
  assert.equal(ready.connection.selected.id, 'q1');
});

test('a remembered NetEase comes back after a restart, without the global media-key consent', async () => {
  const { connection, calls, saved, set } = restart({ player: 'netease' }, []);
  await connection.refresh();
  assert.equal(mediaConnectionLabel(connection), '等待网易云音乐…');
  // Through its window title (no media session): connected, and the keys are asked for again.
  set({ sources: [qq('q1'), neteaseWindow('w1')] });
  await connection.refresh();
  assert.equal(connection.selected.id, 'w1');
  assert.equal(connection.allowGlobalMediaKeys, false, 'a reconnection is a new connection');
  assert.equal(connection.can('toggle'), false);
  assert.equal(await connection.control('toggle'), false);
  assert.match(mediaPermissionMarkup(connection), /id="external-global-keys" >/, 'the consent is offered unticked');
  assert.deepEqual(calls, []);
  assert.deepEqual(saved, []);
});

test('a remembered player Rhine does not know is found again by its app id only, never by a name or a guess', async () => {
  const link = { app: 'Fictional.Player_0abc!App', name: 'Fictional Player' };
  const { connection, saved, set } = restart(link, [netease('n1'), source('x', { name: 'Fictional Player', app: 'Other.Player!App' })]);
  await connection.refresh();
  assert.equal(connection.selected, undefined, 'the same name under another app id is another player');
  assert.equal(mediaConnectionLabel(connection), '等待 Fictional Player…');
  // Two sessions of it (two windows or tabs): no guess between them; the user picks one.
  set({ sources: [fictionalApp('s1'), fictionalApp('s2'), netease('n1')] });
  await connection.refresh();
  assert.equal(connection.selected, undefined);
  assert.equal(connection.ambiguous, true);
  assert.match(mediaConnectionLabel(connection), /^Fictional Player有多个媒体会话，请在“播放器”中选择要连接的一个$/);
  // One left: connected; the name it is listed under now is the one remembered.
  set({ sources: [fictionalApp('s2', { name: 'Fictional Player 2' }), netease('n1')] });
  await connection.refresh();
  assert.equal(connection.selected.id, 's2');
  assert.deepEqual(saved, [{ app: link.app, name: 'Fictional Player 2' }]);
  // A known player is remembered by its module even when an older link named its app id.
  const known = restart({ app: 'QQMusic.exe', name: 'QQMusic.exe' }, [qq('q1', { app: 'QQMusic.exe' })], playerMediaPort);
  await known.connection.refresh();
  assert.equal(known.connection.selected.id, 'q1');
  assert.deepEqual(known.saved, [{ player: 'qqmusic' }]);
});

test('a disconnect is remembered: after a restart nothing is connected by itself, not even NetEase', async () => {
  const before = saving([netease('n1')]);
  await before.connection.refresh();
  before.connection.disconnect();
  assert.deepEqual(before.saved, [{ player: 'netease' }, null]);
  const { connection, saved, set } = restart(before.saved.at(-1), [netease('n1'), qq('q1')], playerMediaPort);
  await connection.refresh();
  assert.equal(connection.selectedId, null);
  assert.equal(connection.followsPreferred, false);
  assert.equal(mediaConnectionLabel(connection), '选择播放器后显示当前曲目');
  assert.doesNotMatch(mediaSourcesMarkup(connection), /默认/);
  set({ sources: [netease('n2'), qq('q1')] });
  await connection.refresh();
  assert.equal(connection.selected, undefined);
  // The user selects a source: it is remembered again.
  connection.select('q1');
  assert.deepEqual(saved, [{ player: 'qqmusic' }]);
  // Nothing remembered yet (an older version's preferences): NetEase is the default link, as before.
  const fresh = restart(undefined, [qq('q1'), netease('n1')], playerMediaPort);
  await fresh.connection.refresh();
  assert.equal(fresh.connection.selected.id, 'n1');
  const unread = restart({ player: 'unknown-player' }, [netease('n1')]);
  await unread.connection.refresh();
  assert.equal(unread.connection.selected.id, 'n1', 'a link this version cannot read counts as none');
});

test('断开连接 also forgets a remembered source that has not appeared: no other player is picked first', async () => {
  // QQ Music was connected last time and is not running now; NetEase is.
  const { connection, calls, saved, set } = restart({ player: 'qqmusic' }, [netease('n1')], playerMediaPort);
  await connection.refresh();
  assert.equal(connection.awaitsPreferred, true);
  assert.equal(connection.remembers, true);
  assert.equal(connection.selectedId, null, 'nothing is connected to disconnect');
  connection.disconnect();
  assert.deepEqual(saved, [null], 'forgotten, and the forgetting is saved');
  assert.equal(connection.remembers, false);
  assert.equal(connection.followsPreferred, false);
  assert.equal(mediaConnectionLabel(connection), '选择播放器后显示当前曲目');
  // Neither it nor NetEase is connected by itself afterwards; nothing was sent to any player.
  set({ sources: [netease('n1'), qq('q1')] });
  await connection.refresh();
  assert.equal(connection.selectedId, null);
  assert.doesNotMatch(mediaSourcesMarkup(connection), /默认/);
  assert.deepEqual(calls, []);
  // The panel's button offers it: enabled while a source is connected or one is remembered.
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8');
  assert.match(app, /setDisconnect\(disconnected, !externalMedia\.selectedId && !externalMedia\.remembers\);/);
});

test('selecting a source again, the remembered one included, asks for the global media keys again', async () => {
  // NetEase through its window title, remembered; the consent is given, then the user picks QQ
  // Music and NetEase again (no session disappeared in between).
  const { connection, calls, saved } = restart({ player: 'netease' }, [neteaseWindow('w1'), qq('q1')], playerMediaPort);
  await connection.refresh();
  assert.equal(connection.selected.id, 'w1');
  connection.setGlobalMediaKeys(true);
  assert.equal(connection.can('toggle'), true);
  assert.equal(connection.select('w1'), true, 'the same source, picked again');
  assert.equal(connection.allowGlobalMediaKeys, false);
  connection.setGlobalMediaKeys(true);
  connection.select('q1');
  connection.select('w1');
  assert.equal(connection.allowGlobalMediaKeys, false, 'a new connection: the consent is asked for again');
  assert.equal(connection.can('toggle'), false);
  assert.match(mediaPermissionMarkup(connection), /id="external-global-keys" >/);
  assert.deepEqual(saved, [{ player: 'qqmusic' }, { player: 'netease' }], 'only the identity, each time it changed');
  assert.deepEqual(calls, []);
});

test('a long name is clipped between characters, so the preferences stay readable for the native side', () => {
  // serde_json (save_preferences) refuses a lone half of a character ("\udXXX" in JSON), and with
  // it every later save of the preferences. 199 letters and an emoji straddle the 200-unit limit.
  const half = /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i;
  const name = `${'x'.repeat(199)}\u{1F600} Fictional Player`;
  const link = sourceLink(source('s', { name, app: 'Fictional.Player_0abc!App' }), PLAYER_MODULES);
  assert.deepEqual(link, { app: 'Fictional.Player_0abc!App', name: 'x'.repeat(199) });
  assert.doesNotMatch(JSON.stringify(link), half);
  assert.deepEqual(readSourceLink({ app: 'A!B', name }, PLAYER_MODULES), { app: 'A!B', name: 'x'.repeat(199) });
  // A whole character at the limit stays, and so does every name within it.
  const whole = `${'x'.repeat(198)}\u{1F600} more`;
  assert.equal(sourceLink(source('s', { name: whole, app: 'A!B' }), PLAYER_MODULES).name, `${'x'.repeat(198)}\u{1F600}`);
  assert.equal(readSourceLink({ app: 'A!B', name: 'y'.repeat(300) }, PLAYER_MODULES).name, 'y'.repeat(200));
  assert.equal(readSourceLink({ app: 'A!B', name: '\u{1F600} Player' }, PLAYER_MODULES).name, '\u{1F600} Player');
  assert.doesNotMatch(JSON.stringify(readSourceLink({ app: 'A!B', name: whole }, PLAYER_MODULES)), half);
});

test('a long name without spaces (an app id) wraps wherever it is written, as in the list of players', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../src/external-media.css', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8');
  // The panel's status line (等待 X…, X · 正在播放, 上次连接的是 X…) and the empty page's note (等待 X…).
  assert.match(app, /<p id="external-connection-status" role="status"><\/p>/);
  assert.match(app, /<p id="external-empty-note" role="status" hidden><\/p>/);
  const wrapping = /([^{}]+)\{\s*overflow-wrap: anywhere;\s*\}/.exec(css)[1].split(',').map((selector) => selector.trim());
  for (const selector of ['.external-source strong', '.external-source small', '#external-connection-status', '#external-empty-note'])
    assert.ok(wrapping.includes(selector), selector);
});

test('a saved link is read as main.rs reads it, and the app saves the source and the link where main.rs looks', async () => {
  const { readFileSync } = await import('node:fs');
  for (const value of [{ player: 'netease' }, { player: 'qqmusic' }, { app: 'fictional.exe' }, { app: 'x'.repeat(512) }, { app: 'A!B', name: '  Named  ' }])
    assert.ok(readSourceLink(value, PLAYER_MODULES), JSON.stringify(value));
  assert.deepEqual(readSourceLink({ app: 'A!B', name: '  Named  ' }, PLAYER_MODULES), { app: 'A!B', name: 'Named' });
  assert.deepEqual(readSourceLink({ app: 'A!B' }, PLAYER_MODULES), { app: 'A!B', name: 'A!B' });
  assert.deepEqual(readSourceLink({ player: 'netease', app: 'cloudmusic.exe' }, PLAYER_MODULES), { player: 'netease' });
  assert.equal(readSourceLink(null, PLAYER_MODULES), null);
  for (const value of [undefined, {}, { player: 'spotify' }, { player: 'NETEASE' }, { player: 'spotify', app: 'spotify.exe' }, { player: 7 }, { app: '' }, { app: 7 }, { app: 'x'.repeat(513) }, 'netease', ['netease'], 7, true])
    assert.equal(readSourceLink(value, PLAYER_MODULES), undefined, JSON.stringify(value));
  // playerLinks: the registry's players, NetEase as the fallback, the saved link read through readSourceLink.
  const told = [];
  const links = playerLinks({ player: 'qqmusic' }, link => told.push(link));
  assert.equal(links.players, PLAYER_MODULES);
  assert.equal(links.fallback, PREFERRED_PLAYER);
  assert.deepEqual(links.remembered, { player: 'qqmusic' });
  links.remember(null);
  assert.deepEqual(told, [null]);
  assert.equal(playerLinks('garbage', () => {}).remembered, undefined);
  // main.rs decides a plain start from the same keys and the same module ids (its unit tests cover
  // the rest): the source chosen last (an earlier build's mode until the page has saved one) and the
  // remembered player; the page it opens is the one pageSource reads as a player. No argument decides.
  const main = readFileSync(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(main, /let player = match preferences\.get\("source"\) \{\n\s*Some\(source\) => source\.as_str\(\) == Some\("player"\),\n\s*None => preferences\.get\("playerMode"\)\.and_then\(serde_json::Value::as_str\) == Some\("external"\),\n\s*\};\n\s*player && preferences\.get\("playerLink"\)\.is_some_and\(remembers_source\)/);
  assert.match(main, /player == rhine_music::netease_music::PLAYER \|\| player == rhine_music::qq_music::PLAYER/);
  assert.match(main, /app\.encode_utf16\(\)\.count\(\) <= 512/);
  assert.match(main, /let entry = entry_url\(&origin, &preferences\);/);
  const entry = main.match(/format!\("\{origin\}\/(\?[^"]+)"\)/);
  assert.ok(entry, 'main.rs opens a player at an address of its own');
  const { pageSource } = await import('../src/music-sources.ts');
  assert.equal(pageSource(entry[1]), 'player', 'the address main.rs opens is the page of a player');
  assert.doesNotMatch(main, /"--skin"|"--local"|mode=external/, 'no launcher argument decides any more');
  assert.deepEqual(PLAYER_MODULES.map(player => player.id), ['netease', 'qqmusic'], 'the module ids main.rs accepts');
  // The page saves both under those keys: its source on every load where it changed (dropping an
  // earlier build's mode) and on a switch, the link when it changes.
  const app = readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(app, /const earlierMode = Object\.hasOwn\(preferences, "playerMode"\);\ndelete \(preferences as Record<string, unknown>\)\.playerMode;\nif \(preferences\.source !== currentSource \|\| earlierMode\) \{\n  preferences\.source = currentSource;\n  save\("rhine-music-preferences", preferences\);\n\}/);
  assert.match(app, /preferences\.source = next;\n  savePrefs\(\);/);
  assert.match(app, /function rememberPlayer\(link: SourceLink \| null\) \{\n  preferences\.playerLink = link;\n  save\("rhine-music-preferences", preferences\);\n\}/);
  assert.equal(app.match(/playerLinks\(preferences\.playerLink, rememberPlayer\)/g)?.length, 2, 'the connection and the chooser remember alike');
  // The native side gives each session's app id, never inventing one for the window-title fallback.
  const windowsMedia = readFileSync(new URL('../src-tauri/src/media/windows_media.rs', import.meta.url), 'utf8');
  assert.match(windowsMedia, /app: \(!app\.is_empty\(\)\)\.then\(\|\| app\.into\(\)\),/);
  assert.match(readFileSync(new URL('../src-tauri/src/netease_music/connector/window.rs', import.meta.url), 'utf8').replace(/\r\n/g, '\n'), /\n\s+app: None,\n/);
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

test('seeks asked for while a control is on its way: the newest goes once it is back, for the same song only', async () => {
  let snapshot = { sources: [source('a', { position: 60, duration: 240 })] };
  const calls = [], answers = [];
  const connection = new ExternalMediaConnection({
    async snapshot() { return snapshot; },
    control(...args) { calls.push(args); return new Promise((done, fail) => answers.push({ done, fail })); },
  });
  await connection.refresh();
  connection.select('a');
  const first = connection.control('seek', 61);
  // The timeline stays usable meanwhile (offers, as the buttons and rings: 2026-10-23, a disabled
  // slider dropped the keyboard's focus); a seek now is taken, not dropped.
  assert.equal(connection.busy, true);
  assert.equal(connection.can('seek'), false);
  assert.equal(connection.offers('seek'), true);
  for (const position of [62, 63, 64]) assert.equal(await connection.control('seek', position), true);
  assert.deepEqual(calls, [['a', 'seek', 61, false]], 'one control at a time');
  answers.shift().done();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.map(call => call[2]), [61, 64], 'only the newest of those waiting');
  answers.shift().done();
  assert.equal(await first, true);
  assert.equal(connection.busy, false);
  // A toggle on its way, then a seek: it goes after the toggle.
  const toggle = connection.control('toggle');
  assert.equal(await connection.control('seek', 80), true);
  answers.shift().done();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.at(-1), ['a', 'seek', 80, false]);
  answers.shift().done();
  await toggle;
  // Another song meanwhile (a snapshot read while the control was on its way): the seek is dropped.
  const next = connection.control('next');
  await connection.control('seek', 30);
  snapshot = { sources: [source('a', { title: '下一首', position: 0, duration: 240 })] };
  await connection.refresh();
  answers.shift().done();
  await next;
  assert.deepEqual(calls.at(-1), ['a', 'next', undefined, false]);
  // A failure of the control on its way is still told when the seek after it went well.
  const failing = connection.control('toggle');
  await connection.control('seek', 31);
  answers.shift().fail(new Error('来源未接受此操作'));
  await new Promise(resolve => setImmediate(resolve));
  answers.shift().done();
  await failing;
  assert.equal(connection.error, '来源未接受此操作');
  assert.deepEqual(calls.at(-1), ['a', 'seek', 31, false]);
  // Still nothing for a player that does not offer seeking.
  const fixed = fixture([source('c', { capabilities: { toggle: true, previous: false, next: false, stop: false, seek: false } })]);
  await fixed.connection.refresh();
  fixed.connection.select('c');
  const pending = fixed.connection.control('toggle');
  assert.equal(await fixed.connection.control('seek', 10), false);
  await pending;
  assert.deepEqual(fixed.calls, [['c', 'toggle', undefined, false]]);
});

test('a cover crosses once: the snapshot leaves out the ones the connection holds, which it keeps', async () => {
  const asked = [];
  let snapshot;
  const cover = n => `data:image/png;base64,${'A'.repeat(n)}`;
  const connection = new ExternalMediaConnection(playerMediaPort({
    async snapshot(known) { asked.push(known); if (snapshot instanceof Error) throw snapshot; return snapshot; },
    async control() {},
  }));
  snapshot = { sources: [source('a', { coverUrl: cover(4), coverRev: 1 }), source('b'), source('q', { app: 'QQMusic.exe', player: 'qqmusic', coverUrl: cover(8), coverRev: 2 })] };
  await connection.refresh();
  assert.deepEqual(asked.at(-1), {});
  // The native side leaves out what is held at the same revision; the connection keeps it (QQ Music's renamed source too).
  snapshot = { sources: [source('a', { coverRev: 1 }), source('b'), source('q', { app: 'QQMusic.exe', player: 'qqmusic', coverRev: 2 })] };
  await connection.refresh();
  assert.deepEqual(asked.at(-1), { a: 1, q: 2 });
  assert.equal(connection.sources[0].coverUrl, cover(4));
  assert.equal(connection.sources[2].coverUrl, cover(8));
  assert.equal(connection.sources[2].name, 'QQ音乐');
  assert.equal(connection.sources[1].coverUrl, undefined);
  // A new revision without a picture: the cover is gone; with one: it is the new one.
  snapshot = { sources: [source('a', { coverRev: 2 }), source('b', { coverUrl: cover(6), coverRev: 1 }), source('q', { app: 'QQMusic.exe', player: 'qqmusic', coverRev: 2 })] };
  await connection.refresh();
  assert.equal(connection.sources[0].coverUrl, undefined);
  assert.equal(connection.sources[1].coverUrl, cover(6));
  assert.deepEqual(asked.at(-1), { a: 1, q: 2 });
  // After a snapshot that could not be read, every cover is asked for again.
  snapshot = new Error('读取媒体来源超时');
  await connection.refresh();
  snapshot = { sources: [source('b', { coverUrl: cover(6), coverRev: 1 })] };
  await connection.refresh();
  assert.deepEqual(asked.at(-1), {});
  // The card's key does not carry the picture's bytes where it has a revision, and still changes with it.
  const keyed = source('a', { coverUrl: cover(5000), coverRev: 3 });
  assert.ok(mediaVisualKey(keyed).length < 300);
  assert.notEqual(mediaVisualKey(keyed), mediaVisualKey({ ...keyed, coverRev: 4 }));
  assert.notEqual(mediaVisualKey(keyed), mediaVisualKey({ ...keyed, coverUrl: undefined }));
  assert.equal(mediaVisualKey(keyed), mediaVisualKey({ ...keyed, position: 30 }));
});

test('whether the last snapshot was read: a failed one says nothing of the sessions, one with a warning does', async () => {
  const { connection, set } = fixture([source('a')]);
  assert.equal(connection.unread, false);
  set(new Error('媒体读取请求已过期'));
  await connection.refresh();
  assert.equal(connection.unread, true);
  assert.equal(connection.select('a'), false);
  set({ sources: [source('a')], warning: 'Windows 媒体服务：枚举失败' });
  await connection.refresh();
  assert.equal(connection.unread, false);
  assert.equal(connection.select('a'), true);
});

test('the app keeps the players\' timeline, covers, focus and panel words in step with the connection', async () => {
  const { readFileSync } = await import('node:fs');
  const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const app = read('src/music-app.ts');
  const body = (start, end) => {
    const from = app.indexOf(start);
    assert.ok(from >= 0, start);
    return app.slice(from, app.indexOf(end, from + start.length));
  };
  // The timeline: usable while a control is on its way (offers), running between snapshots, and a
  // seek goes through seekExternal (the target held until the player shows it).
  const timeline = body('function externalTimeline() {', '\n}\n');
  assert.match(timeline, /position: sessionClock\.position\(source, performance\.now\(\)\) \?\? source\?\.position/);
  assert.match(timeline, /seekable: !!externalMedia\?\.offers\("seek"\)/);
  assert.doesNotMatch(app, /externalMedia\?\.can\("seek"\)/);
  assert.match(app, /if \(externalTimeline\(\)\.debug\) requestSeek\(Number\(el\.value\)\);\n\s*else seekExternal\(Number\(el\.value\)\);/);
  assert.match(body('function seekExternal(', '\n}\n'), /sessionClock\.seek\(source, position, performance\.now\(\)\);\s*updateExternalTimeline\(\);\s*void controlExternal\("seek", position\);/);
  // A failed control is told once, in a notice, unless its player went meanwhile (the header says what
  // follows then: QQ Music, 2026-10-24); its error is not left in the details' warning line.
  assert.match(body('async function controlExternal(', '\n}\n'), /if \(externalMedia\.error\) \{\s*const error = externalMedia\.error;\s*(\/\/[^\n]*\s*)*sessionClock\.release\(\);\s*(\/\/[^\n]*\s*)*await externalMedia\.refresh\(\);\s*if \(!externalMedia\.disconnected\) notify\(error\);\s*\} else if \(action === "seek" && !sent\) sessionClock\.release\(\);/);
  assert.match(app, /const warning = \[externalMedia\.warning, source\?\.warning\]\.filter\(Boolean\)\.join\("\\n"\);/);
  // The 播放器 panel's list is drawn again when what it says changes: which row is the default (断开连接),
  // or which empty-list words apply (nothing read yet: no "没有发现播放器" before the first read).
  assert.match(app, /const markup = mediaSourcesMarkup\(externalMedia\);\s*if \(markup !== sourcesVisual\) \{\s*sourcesVisual = markup;\s*writeSources\(\$\("#external-sources"\), markup\);\s*\}/);
  assert.match(app, /const markup = mediaSourcesMarkup\(playerChooser\);\s*if \(list && markup !== chooserVisual\) \{\s*chooserVisual = markup;\s*writeSources\(list, markup\);\s*\}/);
  // A control the session does not offer says why, in its title and name; the lone track's ring uses the header ring's words.
  assert.match(app, /if \(action === "toggle"\) \{\s*applyRing\(button, pauseResumeRing\(\)\);\s*return;\s*\}/);
  // A control that stops being usable under the focus keeps it, its presses ignored, until the focus
  // leaves (QQ Music quitting and coming back, 2026-10-24); the 播放器 list never hands a gone row's
  // focus to another player's row; an emptied shelf hands it to the waiting page.
  assert.match(body('function setUsable(button: HTMLButtonElement, usable: boolean) {', '\n}\n'), /if \(document\.activeElement !== button\) \{[\s\S]*button\.setAttribute\("aria-disabled", "true"\);[\s\S]*const settle = \(\) => \{\s*if \(document\.activeElement === button\) return;/);
  assert.match(app, /if \(target instanceof HTMLButtonElement && \(target\.disabled \|\| target\.getAttribute\("aria-disabled"\) === "true"\)\) return;/);
  assert.match(app, /\(list\.querySelector<HTMLElement>\(`\[data-media-source="\$\{CSS\.escape\(had\)\}"\]`\) \?\? sourcesPanelFocus\(\)\)\?\.focus\(\{ preventScroll: true \}\);/);
  assert.match(app, /if \(!albums\.length && hadAlbums && inScene && !panel && !boot\?\.active\)\s*document\.querySelector<HTMLElement>\("#music-empty button"\)\?\.focus\(\{ preventScroll: true \}\);/);
  assert.match(app, /: `：\$\{source\.name\}没有提供\$\{title\}`;/);
  // A snapshot read while a seek is on its way (or waits behind another control) is not its answer.
  assert.match(body('async function refreshExternal() {', '\n}\n'), /await externalMedia\.refresh\(\);[\s\S]*sessionClock\.update\(externalMedia\.selected, performance\.now\(\), externalMedia\.seeking\);/);
  // The 播放器 panel: its list written again keeps the focus on the same player; 断开连接 going off
  // under the focus hands it on; the empty page behind the dialog is out of reach while it is open.
  assert.equal((app.match(/writeSources\(/g) || []).length, 3, 'both lists, and the helper');
  assert.doesNotMatch(app, /\.innerHTML = mediaSourcesMarkup\(/);
  assert.match(body('function writeSources(', '\n}\n'), /list\.querySelector<HTMLElement>\(`\[data-media-source="\$\{CSS\.escape\(had\)\}"\]`\)/);
  assert.equal((app.match(/setDisconnect\(/g) || []).length, 3);
  assert.match(body('function setDisconnect(', '\n}\n'), /if \(off && document\.activeElement === button\) sourcesPanelFocus\(\)\?\.focus/);
  assert.equal((app.match(/\$\("#music-empty"\),\n/g) || []).length, 2, 'inert with the panel, and back');
  // The handed-over session waits for a snapshot that was read, and the user's own choice wins.
  assert.match(body('async function refreshExternal() {', '\n}\n'), /if \(handedSession && !externalMedia\.unread\) \{/);
  assert.match(app, /if \(target\.dataset\.mediaSource && externalMedia\) \{\n\s*\/\/[^\n]*\n\s*handedSession = undefined;/);
  assert.match(app, /handedSession = undefined;\n\s*externalMedia\?\.disconnect\(\);/);
  // A lone live card whose picture alone changed is painted again in place (no rebuild of the shelf).
  assert.match(app, /const coverOnly = playerCurrent && !netease\.shownQueue\(\) && oldBare === bareKey\(albums, genres\);/);
  assert.match(app, /const anchor = hadAlbums && \(!playerCurrent \|\| !!netease\.shownQueue\(\) \|\| coverOnly\) \? moved\(previousIndex\) : -1;/);
  // The panel's opening words no longer promise a 切歌 switch (gone 2026-10-09: "do not make this a
  // setting option"): the queue and its playlist columns are switched below, and NetEase plays a
  // chosen song once started with its debugging port.
  assert.doesNotMatch(app, /切歌在下方另行开关/);
  // The debugging port's section is there only with NetEase's queue shown: the words point to it only then.
  assert.match(app, /网易云的播放队列与按歌单分列在下方另行开关<span id=\\"sources-intro-port\\"><\/span>。/);
  assert.match(app, /if \(pointer\) pointer\.textContent = queueSetting\.querySelector\("\.external-debug-port"\) \? "；要让网易云播放选中的歌，需以调试端口启动它（见下方）" : "";/);
  assert.doesNotMatch(app, /需以调试端口启动它（见下方）。/);
  // The native side: a failed enumeration keeps the sessions (their ids and covers); a cover goes
  // out only when the page does not hold it at its revision; the command takes what the page holds.
  const windowsMedia = read('src-tauri/src/media/windows_media.rs');
  assert.match(windowsMedia, /Err\(error\) => \{\n(\s*\/\/[^\n]*\n)*\s*self\.manager = None;\n\s*return Err\(win_error\(error\)\);/);
  assert.doesNotMatch(windowsMedia, /self\.entries\.clear\(\)/);
  assert.match(windowsMedia, /if known\.get\(&entry\.id\) != Some\(&entry\.cover_rev\) \{\n\s*source\.cover_url = entry\.cover\.clone\(\);/);
  assert.match(read('src-tauri/src/main.rs'), /async fn media_snapshot\(\n\s*known_covers: Option<std::collections::HashMap<String, u64>>,\n\) -> Result<rhine_music::media::Snapshot, String> \{/);
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
      ['media_snapshot', { knownCovers: {} }],
      ['media_control', { sourceId: 'chosen-source', action: 'next', position: undefined, allowGlobalMediaKeys: false }],
    ]);
  } finally { globalThis.window = previousWindow; }
});

test('the NetEase queue becomes one case per song in queue order and never a playable library', async () => {
  const { queueLibrary, queueCover, queueTrackKey } = await import('../src/netease_music/data/queue.ts');
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
  const { playingQueueTrack, queueTrackKey } = await import('../src/netease_music/data/queue.ts');
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
  const { queueSettingMarkup, queueControlStatus } = await import('../src/netease_music/connector/settings.ts');
  const netease = source('n', { player: 'netease' });
  const on = { available: true, status: 'ok', restart: false };
  const closed = { available: false, status: '<none>', restart: true };
  const unprobed = { available: false, status: '正在检测网易云调试端口…', restart: false };
  assert.equal(queueSettingMarkup(source('s'), true, '', on), '', 'only NetEase sources have a queue');
  const hidden = queueSettingMarkup(netease, false, '<status>', on);
  assert.match(hidden, /id="netease-queue"(?! checked)/);
  assert.match(hidden, /&lt;status&gt;/);
  assert.match(hidden, /歌曲编号、歌名、歌手、专辑、时长和封面地址/, 'the consent names every field that is read');
  assert.doesNotMatch(hidden, /网易云调试端口|data-debug-status|netease-restart-debug/, 'the port is used only with the queue shown');
  const shown = queueSettingMarkup(netease, true, '', on);
  assert.match(shown, /id="netease-queue" checked/);
  assert.match(shown, /127\.0\.0\.1:9233/);
  assert.match(shown, /data-debug-restart hidden/, 'no restart button while the port answers');
  // The owner, 2026-10-09: "do not make this a setting option". The port is no switch: the panel says
  // what it is used for, with its status and the restart; no input, no saved key.
  assert.doesNotMatch(shown, /netease-control|neteaseControl|点 ▶ 时让网易云播放选中的歌/);
  assert.equal((shown.match(/<input /g) || []).length, 2, 'the queue and the playlist columns, nothing else');
  assert.match(shown, /<div class="settings-row external-queue-consent external-debug-port"><span>网易云调试端口<small>/);
  const absent = queueSettingMarkup(netease, true, '', closed);
  assert.match(absent, /data-debug-restart ><button id="netease-restart-debug" data-action="netease-restart-debug">/);
  assert.match(absent, /&lt;none&gt;/);
  assert.match(queueSettingMarkup(netease, true, '', unprobed), /data-debug-restart hidden/, 'not before the port was actually asked');
  assert.match(queueControlStatus({ available: false }), /未检测到网易云调试端口/);
  // The owner's play mode (2026-10-05): browsing never switches the song. Since 2026-10-08 the
  // selection plays by ▶ or P (the header's ring and Space pause or resume): the panel says so.
  assert.match(queueControlStatus({ available: true }, { available: true, mode: 'playOrder' }), /浏览时不切歌，点 ▶（或按 P）时网易云播放选中的歌/);
  assert.match(queueControlStatus({ available: false }), /点 ▶ 或按 P 才能播放选中的歌/);
  assert.match(shown, /网易云调试端口<small>浏览时不切歌。以调试端口启动网易云后，点队列中一首歌的 ▶（或选中它后按 P、打开它的详情），通过网易云的调试端口（仅本机 127\.0\.0\.1:9233）让它播放这首歌，不改变队列顺序；/);
  // The consent's scope: those actions, the progress, and since 2026-10-17 (the owner: "Rhine asks
  // NetEase to load them") the lyrics of the song that plays, which NetEase is asked to load as its
  // playing page does, kept in memory only.
  assert.match(shown, /同时显示播放进度，并可拖动进度条。正在播放的歌的详情里显示它的歌词：Rhine 请网易云载入这首歌的歌词（与打开网易云的播放页时相同，网易云从它的缓存或服务器取得，界面不变），再读取每行歌词的时间、文字、翻译与逐字时间；只读取正在播放的这首歌的歌词，只留在 Rhine 的内存里，不保存、不发送。端口开启期间，本机其他程序也能控制网易云。<\/small>/);
  const said = shown + queueControlStatus({ available: true }, { available: true, mode: 'playOrder' }) + queueControlStatus({ available: false });
  assert.doesNotMatch(said, /约半秒|选中盒子时让网易云切歌|点播放|按空格/);
  assert.match(queueControlStatus({ available: true }, { available: true, mode: 'playFm' }), /私人 FM/);
});

test('the playback clock runs evenly between whole-second readings and follows seeks, pauses and song changes', async () => {
  const { PlaybackClock } = await import('../src/netease_music/connector/playback-clock.ts');
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

test('a media session\'s timeline runs on between snapshots while it plays, and shows Rhine\'s own seek until the player does', async () => {
  const { SessionClock } = await import('../src/external_player/session-clock.ts');
  const qq = (position, extra = {}) => source('q', { name: 'QQ音乐', player: 'qqmusic', position, duration: 240, ...extra });
  const clock = new SessionClock();
  assert.equal(clock.position(qq(10), 0), undefined, 'nothing is shown before the first reading');
  // Readings as the native side takes them (at the moment of each snapshot), about every 1.1 s:
  // the seconds count on in between and never skip or step back (2026-10-23: 3 of 22 skipped).
  let shown = [], at = 0, truth = 10;
  for (let poll = 0; poll < 20; poll++) {
    clock.update(qq(truth), at);
    for (let tick = 0; tick < 1100; tick += 250) shown.push(clock.position(qq(truth), at + tick));
    at += 1100;
    truth += 1.1;
  }
  shown.forEach((value, i) => i && assert.ok(value >= shown[i - 1] - 1e-9, `never steps back: ${value} after ${shown[i - 1]}`));
  const seconds = shown.map(Math.floor);
  seconds.forEach((value, i) => i && assert.ok(value - seconds[i - 1] <= 1, `no second skipped: ${seconds[i - 1]} → ${value}`));
  // Never more than 1.25 s past the last reading (a snapshot that is late does not run away), nor past the end.
  clock.update(qq(50), 30000);
  assert.equal(clock.position(qq(50), 40000), 51.25);
  clock.update(qq(239.5), 41000);
  assert.equal(clock.position(qq(239.5), 43000), 240);
  // Paused, stopped or unknown: the reading, nothing runs.
  for (const playback of ['paused', 'stopped', 'unknown']) {
    clock.update(qq(70, { playback }), 50000);
    assert.equal(clock.position(qq(70, { playback }), 52000), 70, playback);
  }
  // Another song, or another session: its own reading; no reading: nothing.
  clock.update(qq(0, { title: '下一首' }), 60000);
  assert.equal(clock.position(qq(0, { title: '下一首' }), 60500), 0.5);
  assert.equal(clock.position(qq(0), 60500), undefined, 'the clock is for the song it read');
  clock.update(qq(undefined), 61000);
  assert.equal(clock.position(qq(undefined), 61000), undefined);
  // A player whose readings stand still while it says it plays (no timeline): not run on.
  const still = new SessionClock();
  for (const now of [0, 1100, 2200]) still.update(qq(5), now);
  assert.equal(still.position(qq(5), 3000), 5);
  // Rhine's seek shows at once and stands while it is on its way (`seeking`: a snapshot answered
  // meanwhile still has where the song was); the next step goes on from it. Once the player has
  // answered, the target runs on from then, and a reading of where the song was (one second off: the
  // arrow keys' step) does not pull it back; a reading of the target takes over; one that never comes
  // ends the hold, and a refused seek ends it at once.
  const seeking = new SessionClock();
  seeking.update(qq(60), 0);
  seeking.seek(qq(60), 61, 100);
  assert.equal(seeking.position(qq(60), 100), 61);
  seeking.update(qq(60.3), 300, true);
  assert.equal(seeking.position(qq(60.3), 300), 61, 'on its way: the target stands, the old position does not pull it back');
  seeking.seek(qq(60.3), 62, 350);
  assert.equal(seeking.position(qq(60.3), 350), 62, 'the next step goes on from the target');
  seeking.update(qq(61.1), 600, true);
  assert.equal(seeking.position(qq(61.1), 600), 62, 'nor does the step before');
  seeking.update(qq(60.7), 700);
  assert.equal(seeking.position(qq(60.7), 700), 62, 'answered, but the player shows where the song was: not taken');
  assert.ok(Math.abs(seeking.position(qq(60.7), 1000) - 62.3) < 1e-9, 'it runs on from the answer');
  seeking.update(qq(61.35), 1000);
  assert.ok(Math.abs(seeking.position(qq(61.35), 1000) - 62.3) < 1e-9, 'nor the step before it, shown late');
  seeking.update(qq(62.5), 1100);
  assert.equal(seeking.position(qq(62.5), 1100), 62.5, 'the player has it: on from there');
  seeking.seek(qq(62.5), 100, 1200);
  seeking.update(qq(63), 1300, true);
  seeking.update(qq(64.6), 2900, true);
  assert.equal(seeking.position(qq(64.6), 2900), 100, 'a slow seek holds as long as it is on its way');
  seeking.update(qq(64.7), 3000);
  assert.equal(seeking.position(qq(64.7), 3000), 100, 'and for the hold from its answer');
  seeking.update(qq(66.3), 4600);
  assert.equal(seeking.position(qq(66.3), 4600), 66.3, 'after the hold the player is believed again');
  seeking.seek(qq(66.3), 120, 4700);
  seeking.release();
  seeking.update(qq(66.5), 4800);
  assert.equal(seeking.position(qq(66.5), 4800), 66.5);
  // Paused, one second at a time (the slider's own step): where the song was, one second from the
  // target, is never the seek done; the next press steps on from the target.
  const paused = new SessionClock();
  const halted = (position) => qq(position, { playback: 'paused' });
  paused.update(halted(60), 0);
  paused.seek(halted(60), 61, 100);
  paused.update(halted(60), 300);
  assert.equal(paused.position(halted(60), 300), 61);
  paused.seek(halted(60), 62, 400);
  paused.update(halted(61), 700);
  assert.equal(paused.position(halted(61), 700), 62, 'the step before, shown late');
  paused.update(halted(62), 1000);
  assert.equal(paused.position(halted(62), 1000), 62);
  paused.seek(halted(62), 63, 1100);
  paused.update(halted(62), 1200);
  assert.equal(paused.position(halted(62), 1200), 63);
  paused.update(halted(62), 2800);
  assert.equal(paused.position(halted(62), 2800), 62, 'a seek the player never shows: believed after the hold');
  // Playing, one step: the target runs on; a reading of it a hair behind keeps the clock.
  const playing = new SessionClock();
  playing.update(qq(60.6), 0);
  playing.seek(qq(60.6), 61, 100);
  playing.update(qq(60.8), 200);
  assert.equal(playing.position(qq(60.8), 200), 61, 'where the song was (60.6 run on), as it is answered: not taken');
  playing.update(qq(61.25), 500);
  assert.ok(Math.abs(playing.position(qq(61.25), 500) - 61.3) < 1e-9, 'its own reading, a hair behind: the clock stays');
});

test('arrow steps on a media session\'s timeline each go one second on from the last, while controls are on their way', async () => {
  const { SessionClock } = await import('../src/external_player/session-clock.ts');
  // A fictional session, paused at 60. The native media worker answers snapshots and controls one at
  // a time in the order asked (windows_media.rs); a seek takes effect when it is answered, and `late`
  // snapshots after it still show where the song was (a player that shows it a moment late).
  function player(late = 0) {
    let position = 60, playing = false, shownLate = 0, before = 60;
    const jobs = [], seeks = [];
    const port = {
      snapshot: () => new Promise(done => jobs.push(() => {
        const shown = shownLate > 0 ? before : position;
        shownLate--;
        done({ sources: [source('q', { name: 'QQ音乐', player: 'qqmusic', playback: playing ? 'playing' : 'paused', position: shown, duration: 240 })] });
      })),
      control: (id, action, target) => new Promise(done => jobs.push(() => {
        if (action === 'toggle') playing = !playing;
        if (action === 'seek') { before = position; position = target; seeks.push(target); shownLate = late; }
        done();
      })),
    };
    const connection = new ExternalMediaConnection(port);
    const clock = new SessionClock();
    // The page (music-app.ts): each snapshot read goes to the clock, with whether a seek is on its way;
    // a control is followed by a snapshot once it is back (a seek waiting for another: at once).
    const refresh = async () => { await connection.refresh(); clock.update(connection.selected, 0, connection.seeking); };
    const control = (action, value) => void connection.control(action, value).then(refresh);
    const shown = () => Math.floor(clock.position(connection.selected, 0));
    // ArrowRight on the range: one second on from what it shows.
    const press = () => { const value = shown() + 1; clock.seek(connection.selected, value, 0); control('seek', value); return value; };
    // The worker answers the oldest request; the page runs what follows from it.
    const answer = async () => { jobs.shift()(); for (let i = 0; i < 50; i++) await Promise.resolve(); };
    const settle = async (each = () => {}) => { while (jobs.length) { await answer(); each(); } };
    const start = async () => {
      const ready = refresh();
      await answer();
      await ready;
      connection.select('q');
      clock.update(connection.selected, 0, false);
    };
    return { connection, seeks, press, control, shown, settle, start, get position() { return position; } };
  }
  for (const late of [0, 1]) {
    // Three quick presses while the first seek is on its way; two more once it is all answered.
    const p = player(late);
    await p.start();
    const pressed = [p.press(), p.press(), p.press()];
    const shown = [p.shown()];
    await p.settle(() => shown.push(p.shown()));
    pressed.push(p.press());
    await p.settle();
    pressed.push(p.press());
    await p.settle();
    shown.push(p.shown());
    assert.deepEqual(pressed, [61, 62, 63, 64, 65], `late ${late}: each press steps on from the last target`);
    assert.equal(p.position, 65, `late ${late}: the player ends where the last press went`);
    assert.equal(p.seeks.at(-1), 65);
    shown.forEach((value, i) => i && assert.ok(value >= shown[i - 1], `late ${late}: the slider never goes back (${shown})`));
  }
  // Space (play / pause on its way), then three arrow presses: the newest target goes once it is back.
  const p = player(1);
  await p.start();
  p.control('toggle');
  assert.deepEqual([p.press(), p.press(), p.press()], [61, 62, 63]);
  await p.settle();
  assert.equal(p.shown(), 63);
  assert.deepEqual(p.seeks, [63], 'only the newest target, once the toggle is back');
  assert.equal(p.position, 63);
});

// The JavaScript Rhine evaluates inside NetEase's page lives in the Rust module as raw strings;
// run it here against stand-ins for NetEase's store and progress slider.
async function neteaseScripts() {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src-tauri/src/netease_music/connector/debug_port.rs', import.meta.url), 'utf8');
  const body = name => {
    const found = source.match(new RegExp('const ' + name + ': &str = r#"([^]*?)"#;'));
    assert.ok(found, `${name} is in netease_music/connector/debug_port.rs`);
    return found[1];
  };
  return {
    seek: new Function('id', 'seconds', 'findStore', body('SEEK_BODY')),
    playlist: new Function('playlist', 'track', 'name', 'findStore', body('PLAYLIST_BODY')),
    state: new Function('findStore', 'document', body('STATE_BODY')),
    lyrics: new Function('id', 'load', 'findStore', body('LYRICS_BODY')),
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
  const { queueLanes, QUEUE_LANE } = await import('../src/netease_music/data/queue.ts');
  const queue = { tracks: [laneTrack(23), laneTrack(21), laneTrack(99)], truncated: false, source: { id: '2', name: 'Beta' } };
  const lanes = queueLanes(queue, lanePlaylists());
  // NetEase's order; the playlist with no songs on this PC is left out; Beta is the queue, in queue order.
  // The liked-songs playlist (Alpha here) is shown as NetEase shows it, 我喜欢的音乐 (2026-10-17: NetEase stores
  // it under the account's nickname + 喜欢的音乐); its stored name stays for 播放全部.
  assert.deepEqual(laneShape(lanes), [['1', '我喜欢的音乐', false, '11,12'], ['2', 'Beta', true, '23,21,99'], ['4', 'Gamma', false, '22,41']]);
  assert.deepEqual(lanes.map(lane => [lane.liked, lane.truncated, lane.sourceName]), [[true, false, 'Alpha'], [false, false, 'Beta'], [false, true, 'Gamma']]);
  const nicknamed = queueLanes({ tracks: [], truncated: false }, [laneList(5, 'Somebody喜欢的音乐', [laneTrack(51)], { liked: true }), laneList(6, 'Somebody喜欢的音乐', [laneTrack(61)])]);
  assert.deepEqual(nicknamed.map(lane => [lane.name, lane.sourceName]), [['我喜欢的音乐', 'Somebody喜欢的音乐'], ['Somebody喜欢的音乐', 'Somebody喜欢的音乐']], 'only the marked playlist: one named so by its owner stays');
  // A queue from anywhere else (an album, a search, a playlist that is not the user's) is a column of its own in front.
  const loose = queueLanes({ tracks: [laneTrack(90)], truncated: true }, lanePlaylists());
  assert.deepEqual(laneShape(loose), [[QUEUE_LANE, '播放队列', true, '90'], ['1', '我喜欢的音乐', false, '11,12'], ['2', 'Beta', false, '21,22,23'], ['4', 'Gamma', false, '22,41']]);
  assert.equal(loose[0].truncated, true, 'the queue column says when the queue was cut short');
  assert.equal(queueLanes({ tracks: [laneTrack(90)], truncated: false, source: { id: '77', name: 'Somebody\'s list' } }, lanePlaylists())[0].name, 'Somebody\'s list');
  // The queue's own playlist is a column even when its songs were never saved on this PC.
  const fresh = queueLanes({ tracks: [laneTrack(5)], truncated: false, source: { id: '3', name: 'Never opened' } }, lanePlaylists());
  assert.deepEqual(laneShape(fresh), [['1', '我喜欢的音乐', false, '11,12'], ['2', 'Beta', false, '21,22,23'], ['3', 'Never opened', true, '5'], ['4', 'Gamma', false, '22,41']]);
  // Exactly one live column, and none without a queue.
  for (const result of [lanes, loose, fresh]) assert.equal(result.filter(lane => lane.live).length, 1);
  const idle = queueLanes({ tracks: [], truncated: false, source: { id: '2', name: 'Beta' } }, lanePlaylists());
  assert.deepEqual(laneShape(idle), [['1', '我喜欢的音乐', false, '11,12'], ['2', 'Beta', false, '21,22,23'], ['4', 'Gamma', false, '22,41']]);
  // Without playlists the queue is the single column it always was.
  assert.deepEqual(laneShape(queueLanes(queue)), [[QUEUE_LANE, 'Beta', true, '23,21,99']]);
  // A playlist without a name is still a column.
  assert.deepEqual(queueLanes({ tracks: [], truncated: false }, [laneList(8, '', [laneTrack(1)]), laneList(9, '', [laneTrack(2)], { liked: true })]).map(lane => lane.name), ['未命名歌单', '我喜欢的音乐']);
});

test('playlist columns: the queue\'s cases keep the queue\'s keys, every other column has cases of its own', async () => {
  const { queueLanes, laneLibrary, laneTrackKey, laneGenre, queueTrackKey, queueLibrary, caseSong } = await import('../src/netease_music/data/queue.ts');
  const queue = { tracks: [laneTrack(23), laneTrack(22), laneTrack(23)], truncated: false, source: { id: '2', name: 'Beta' } };
  const lanes = queueLanes(queue, lanePlaylists());
  assert.equal(laneTrackKey(lanes[1], laneTrack(23)), queueTrackKey(laneTrack(23)), 'what follows and switches NetEase\'s song finds its cases in the queue\'s column');
  assert.equal(laneTrackKey(lanes[2], laneTrack(22)), 'netease-list:4:22');
  assert.equal(laneTrackKey(lanes[0]), '', 'no song, no case');
  // A song's case in a playlist and in the queue show one song (the ruler's ticks: 2026-10-10).
  assert.equal(caseSong(laneTrackKey(lanes[2], laneTrack(22))), caseSong(queueTrackKey(laneTrack(22))));
  assert.equal(caseSong('netease-track:22'), 'netease-song:22');
  assert.equal(caseSong('netease-list:4:22'), 'netease-song:22');
  assert.equal(caseSong('track-abc'), 'track-abc', 'a local song keeps its key');
  assert.equal(caseSong('external:live'), 'external:live');
  const library = laneLibrary(lanes);
  assert.deepEqual(library.genres, [{ id: 'netease-lane:1', name: '我喜欢的音乐' }, { id: 'netease-lane:2', name: 'Beta' }, { id: 'netease-lane:4', name: 'Gamma' }]);
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

test('a NetEase picture is one picture on any of its image servers, and the shelf is not built again for it', async () => {
  // 2026-10-16, the owner: "when I switch to a new playlist and click the play button, it reloads the
  // whole scene1". On the owner's NetEase the copy of a playlist saved on this PC and NetEase's queue
  // of it named the same pictures on other image servers (3 of 3 covers; 20 of 38), and the playlist
  // saved one song short gave the queue a song more (39 against 38): each rebuilt the whole shelf.
  // Every song and address here is made up for the check.
  const { queueCoverKey, laneLibrary, queueLanes } = await import('../src/netease_music/data/queue.ts');
  const on = host => `https://${host}.music.126.net/AbC==/109951.jpg`;
  assert.equal(queueCoverKey(on('p1')), queueCoverKey(on('p3')), 'the same path on another server');
  assert.equal(queueCoverKey(`${on('p2')}?param=1024y1024`), queueCoverKey(on('p4')), 'whatever size is asked for');
  assert.notEqual(queueCoverKey(on('p1')), queueCoverKey('https://p1.music.126.net/AbC==/109952.jpg'), 'another picture');
  for (const other of ['https://example.com/AbC==/109951.jpg', '/api/covers/1.jpg', 'not an address', undefined]) assert.equal(queueCoverKey(other), undefined, String(other));
  // The cases carry it: the queue's case and the saved playlist's for one song, on two servers.
  const track = (id, host) => laneTrack(id, { coverUrl: on(host) });
  const queue = { tracks: [track(22, 'p1'), track(41, 'p1')], truncated: false, source: { id: '4', name: 'Gamma' } };
  const saved = [laneList(4, 'Gamma', [track(22, 'p3'), track(41, 'p2')])];
  const live = laneLibrary(queueLanes(queue, saved)).albums, listed = laneLibrary(queueLanes({ ...queue, source: undefined }, saved)).albums.filter(album => album.id.startsWith('netease-list:'));
  assert.deepEqual(live.map(album => album.coverKey), listed.map(album => album.coverKey));
  assert.notDeepEqual(live.map(album => album.coverUrl), listed.map(album => album.coverUrl), 'each still loads from its own server');
  // The page compares the shelf by it, and keeps it (scene.relayout) whenever the selected song is
  // still in its column; only otherwise is it emptied and built again (scene.refreshLibrary).
  const app = (await import('node:fs')).readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const apply = app.slice(app.indexOf('async function applyLibrary() {'), app.indexOf('\n}\n', app.indexOf('async function applyLibrary() {')));
  assert.match(apply, /items\.map\(\(a\) => \[a\.title, a\.artist, a\.genreId, a\.coverKey \?\? a\.coverUrl\]\)/);
  assert.match(apply, /const same = records\.findIndex\(\(record\) => record\.id === before\.id\);\s*if \(same >= 0\) return same;\s*const song = caseSong\(before\.id\), column = before\.album\?\.genreId;\s*return records\.findIndex\(\(record\) => record\.album\?\.genreId === column && caseSong\(record\.id\) === song\);/);
  // NetEase's queue shelf and 本地音乐's (a scan); a source with one card is built again for each song,
  // as before, and kept only while the same song merely shows another picture (coverOnly: the same id,
  // title, artist and column).
  assert.match(apply, /const anchor = hadAlbums && \(!playerCurrent \|\| !!netease\.shownQueue\(\) \|\| coverOnly\) \? moved\(previousIndex\) : -1;/);
  assert.match(apply, /const bareKey = \(items: MusicAlbum\[\], groups: MusicGenre\[\]\) =>\s*JSON\.stringify\(\[items\.map\(\(a\) => \[a\.id, a\.title, a\.artist, a\.genreId\]\), groups\.map\(\(g\) => \[g\.id, g\.name\]\)\]\);/);
  assert.match(apply, /if \(scene && ready && oldVisual !== visualKey\(albums, genres\) && anchor >= 0\) \{/);
  assert.match(apply, /const target = selected;\s*selected = anchor;\s*scene\.relayout\(anchor\);\s*if \(target !== anchor\) select\(target\);\s*\} else if \(scene && ready && oldVisual !== visualKey\(albums, genres\)\) \{/);
  assert.doesNotMatch(apply, /oldShape === shapeKey/, 'the same shape is no longer the only way to keep the shelf');
  const keep = apply.slice(apply.indexOf('anchor >= 0) {'), apply.indexOf('} else if (scene && ready && oldVisual'));
  assert.doesNotMatch(keep, /refreshLibrary|presentation\.reset\(\)|\.hide\(true\)|libraryRebuilding = true/, 'nothing is torn down');
  // A selection on its way, and a hop waiting for one, keep their song.
  assert.match(keep, /const index = moved\(pending\.index\);\s*if \(index >= 0\) presentation\.pendingSelection = \{ \.\.\.pending, index, navigation: undefined \};\s*else presentation\.pendingSelection = undefined;/);
  assert.match(keep, /const index = moved\(gestureFor\);\s*gestureFor = index >= 0 \? index : undefined;/);
  // The song scene lists the selected column: again when its songs changed under the selection.
  assert.match(apply, /if \(mode === "detail" && \(\(previousDetail !== detailKey\(\) && !coverOnly\) \|\| \(menu === "song" && shapeChanged\)\)\)\s*menu === "song" \? renderSongs\(\) : renderDetail\(\);/);
  // The scene keeps the lifted case, its motion and the camera; a column that came or went before
  // the selected one moves the view with it by whole columns, as rebaseCoordinates does.
  const scene = (await import('node:fs')).readFileSync(new URL('../src/scene.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const relayout = scene.slice(scene.indexOf('  relayout(index: number) {'), scene.indexOf('\n  }\n', scene.indexOf('  relayout(index: number) {')));
  assert.doesNotMatch(relayout, /this\.lift =|this\.musicCamera =|this\.shoulder =|covers\.reset|musicPresentation|this\.outgoing = \[\]/);
  assert.match(relayout, /lane: nearestOccurrence\(location\.lane, before\.lane, archiveColumns\.length\),\s*row: nearestOccurrence\(location\.row, before\.row, columnFiles\(location\.lane\)\.length\),/);
  assert.match(relayout, /this\.coordinateOrigin\.lane -= lanes;\s*this\.laneFocus\.value \+= lanes;\s*this\.columnCamera\.value \+= lanes \* COLUMN_SPACING;/);
  assert.match(relayout, /if \(this\.covers && !this\.covers\.shows\(records\[index\]\)\) void this\.covers\.select\(records\[index\]\);/);
  // Its song moved along the column (the owner's playlist saved one song short: the chosen song a
  // row further on in NetEase's queue): the lifted case keeps its place on screen and goes with the
  // shelf, an offset that the rail's own spring cancels (the same rate, from rest).
  assert.match(relayout, /this\.relayoutRows\.value \+= cell\.row - before\.row;/);
  assert.match(scene, /damp\(this\.relayoutRows, 0, this\.reduced \? 35 : detailNavigation \? MUSIC_ALBUM_SWITCH_RATE : 3\.7, dt\);/);
  assert.match(scene, /damp\(\s*this\.rail,\s*cinematic \? 0 : -2\.17 - chosen\.z,\s*this\.reduced \? 35 : detailNavigation \? MUSIC_ALBUM_SWITCH_RATE : 3\.7,/, 'the rail at that same rate');
  assert.match(scene, /chosen\.z \+ entryZ \+ this\.rail\.value - this\.relayoutRows\.value \* ROW_SPACING,/);
  assert.equal((scene.match(/this\.relayoutRows = \{ value: 0, velocity: 0 \};/g) || []).length, 4, 'snapped with the rail, and afresh with a rebuilt shelf');
});

test('playlist columns are on by default once the queue is shown, say what is read, and have no style setting', async () => {
  const { queueSettingMarkup } = await import('../src/netease_music/connector/settings.ts');
  const netease = source('n', { player: 'netease' });
  const control = { enabled: true, available: true, status: 'ok', restart: false };
  // The queue itself stays opt-in; its consent says that playlist columns come with it.
  const hidden = queueSettingMarkup(netease, false, '', control);
  assert.doesNotMatch(hidden, /netease-playlists/, 'offered only with the queue shown');
  assert.match(hidden, /打开后默认同时按歌单分列（读取本机歌单，见下方），可单独关闭。/);
  const on = queueSettingMarkup(netease, true, '', control);
  assert.match(on, /id="netease-playlists" checked/, 'on unless switched off');
  assert.match(on, /<span>按歌单分列<small>默认打开。/);
  for (const said of [/webdb\.dat，只读/, /你创建的歌单（含“我喜欢的音乐”）/, /编号、名称、歌曲数与封面地址/, /编号、歌名、歌手、专辑、时长和封面地址/, /来源歌单编号与名称/, /列旁标出歌单名称/, /其余各列里点一首歌的 ▶，网易云从这首歌开始播放那个歌单（见上方的网易云调试端口）/, /不读取收藏的歌单、账号、Cookie 或播放历史/, /Rhine 不保存歌单名称和歌曲列表/, /封面图片从网易云公开图片服务器加载，会留在界面缓存里/])
    assert.match(on, said, 'the consent names what is read and what is not');
  // Since 2026-10-10 ("Play that playlist from the song you picked") the other columns play with their
  // playlist, and the port's consent names that third action, what it changes and what NetEase is given.
  assert.doesNotMatch(on, /只供浏览|不会切歌/);
  assert.match(on, /点其他歌单里一首歌的 ▶（同样可按 P、打开详情），让网易云从这首歌开始播放这个歌单，与在网易云的歌单里双击这首歌相同：网易云的播放队列换成这个歌单，歌单的编号与名称交给网易云作为队列的来源。/);
  const off = queueSettingMarkup(netease, true, '<q>', control, { enabled: false, status: '<3 lists>' });
  assert.match(off, /id="netease-playlists" ><\/label>/);
  assert.match(off, /data-playlist-status role="status"><\/p>/, 'no status while it is off');
  assert.match(queueSettingMarkup(netease, true, '', control, { enabled: true, status: '<3 lists>' }), /data-playlist-status role="status">&lt;3 lists&gt;<\/p>/);
  // There is one way to show the names (flat text at fixed places over the shelf): no style to choose.
  for (const markup of [on, off]) assert.doesNotMatch(markup, /netease-lane-labels|歌单名称的样式|文字标签|<select/);
  // The preference: a new key, so the old default (off, saved with every preference) does not outlive the new one.
  const app = (await import('node:fs')).readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8');
  const session = (await import('node:fs')).readFileSync(new URL('../src/netease_music/connector/session.ts', import.meta.url), 'utf8');
  assert.match(app, /playlistColumns: true,/);
  assert.match(app, /for \(const key of \["laneLabels", "laneNameStyle", "neteasePlaylists", "neteaseControl"\]\) delete \(preferences as Record<string, unknown>\)\[key\];/);
  for (const source of [app, session]) assert.doesNotMatch(source, /preferences\.neteasePlaylists|laneNameStyle =|netease-lane-labels/);
  // The queue itself stays off until switched on.
  assert.match(app, /neteaseQueue: false,/);
});

test('the playlist port asks the native side with the last stamp and nothing else, and only in the client', async () => {
  const { nativePlaylistPort } = await import('../src/netease_music/connector/ports.ts');
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
  const { nativeQueuePort } = await import('../src/netease_music/connector/ports.ts');
  calls.length = 0;
  globalThis.window = { __TAURI__: { core: { invoke: async (command, args) => { calls.push([command, args]); return { status: 'missing' }; } } } };
  try {
    await nativeQueuePort.read('q1');
    await nativeQueuePort.read('q1', false);
    await nativeQueuePort.read('q1', true);
  } finally { globalThis.window = before; }
  assert.deepEqual(calls, [['netease_queue', { stamp: 'q1', source: false }], ['netease_queue', { stamp: 'q1', source: false }], ['netease_queue', { stamp: 'q1', source: true }]]);
  const app = (await import('node:fs')).readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8');
  const session = (await import('node:fs')).readFileSync(new URL('../src/netease_music/connector/session.ts', import.meta.url), 'utf8');
  assert.match(session, /this\.ports\.queue\.read\(this\.queueStamp, this\.host\.preferences\.playlistColumns\)/);
  assert.equal((session.match(/\.queue\.read\(/g) || []).length, 1, 'the one place the queue is read');
  assert.match(session, /\{ queue: nativeQueuePort, playlists: nativePlaylistPort, debug: nativeDebugPort \}/, 'by the native ports');
  assert.doesNotMatch(app, /nativeQueuePort|nativePlaylistPort|nativeDebugPort|\.queue\.read\(/, 'the app reads NetEase only through its session');
});

test('the NetEase session reads each thing only with its switch on, and only for a selected NetEase source', async () => {
  const { NeteaseSession } = await import('../src/netease_music/connector/session.ts');
  const reads = [];
  const ports = {
    queue: { async read(stamp, source) { reads.push(['queue', stamp ?? null, source]); return { status: 'queue', stamp: 'q1', truncated: false, tracks: [laneTrack(1), laneTrack(2)] }; } },
    playlists: { async read(stamp) { reads.push(['playlists', stamp ?? null]); return { status: 'playlists', stamp: 'p1', truncated: false, playlists: lanePlaylists() }; } },
    debug: {
      async state() { reads.push(['debug']); return { available: true, trackId: '2', playback: 'playing', mode: 'playOrder', duration: 100, position: 5 }; },
      async play(id) { reads.push(['play', id]); }, async seek(id, at) { reads.push(['seek', id, at]); return at; }, async restart() { reads.push(['restart']); },
    },
  };
  const { connection } = fixture([netease('n1'), source('a')], NETEASE);
  await connection.refresh();
  const preferences = { neteaseQueue: false, playlistColumns: true };
  const records = ['netease-track:1', 'netease-track:2'];
  let cursor = 0;
  const session = new NeteaseSession({
    media: connection, preferences, recordId: index => records[index], genreId: () => undefined, indexOf: id => records.indexOf(id),
    selected: () => cursor, navigationSelection: () => cursor, canFollow: () => false, follow() {}, songChanged() {}, jumpChanged() {},
    confirmSoon() {}, async refresh() {}, notify() {},
  }, ports);
  // The queue switch is off (its default): nothing of NetEase is read.
  await session.refresh();
  assert.deepEqual(reads, []);
  assert.equal(session.shownQueue(), undefined);
  assert.equal(session.playback(connection.selected), 'playing', 'Windows\' word while the port is not asked');
  // Switched on: the queue (with its source playlist, playlist columns being on by default), the playlists, the port.
  preferences.neteaseQueue = true;
  await session.refresh();
  assert.deepEqual(reads, [['queue', null, true], ['playlists', null], ['debug']]);
  assert.deepEqual(session.shownQueue().tracks.map(track => track.id), ['1', '2']);
  assert.equal(session.playingKey(), 'netease-track:2', 'the port names the song that plays');
  assert.equal(session.shelf(connection.selected).lanes.length, 4, 'one column per playlist with songs, and the queue');
  // Read again: the playlists only when the queue changed or half a minute passed.
  reads.length = 0;
  await session.refresh();
  assert.deepEqual(reads, [['queue', 'q1', true], ['debug']]);
  // The play button: the selected queue song through the port, never a new action.
  assert.deepEqual(session.queueSongToPlay(), { key: 'netease-track:1', song: laneTrack(1) });
  reads.length = 0;
  await session.playQueueSong(session.queueSongToPlay());
  assert.deepEqual(reads, [['play', '1']]);
  // Each switch off stops its own reads: the playlist columns' the playlists. The port has no switch of
  // its own (the owner, 2026-10-09: "do not make this a setting option"): it is asked while the queue is.
  preferences.playlistColumns = false;
  reads.length = 0;
  await session.refresh();
  assert.deepEqual(reads, [['queue', 'q1', false], ['debug']], 'playlistColumns');
  // Another player selected: nothing of NetEase is read, and the queue read before is let go.
  connection.select('a');
  reads.length = 0;
  await session.refresh();
  assert.deepEqual(reads, []);
  assert.equal(session.shownQueue(), undefined);
  assert.equal(session.externalQueue, undefined);
  assert.deepEqual(session.debugState, { available: false });
  assert.equal(session.queueSongToPlay(), undefined, 'no queue, no port, no song to play');
  // NetEase again with its queue switched off: nothing is read, the port neither.
  assert.equal(connection.select('n1'), true);
  preferences.neteaseQueue = false;
  reads.length = 0;
  await session.refresh();
  assert.deepEqual(reads, [], 'neteaseQueue');
  assert.deepEqual(session.debugState, { available: false });
  assert.equal(session.portBlock(), 'probing', 'never asked since');
});

test('NetEase is restarted only from the panel button\'s second click, never by a poll or by the session itself', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const session = readFileSync(new URL('../src/netease_music/connector/session.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal((session.match(/\.debug\.restart\(/g) || []).length, 1, 'one place in the session asks for the restart');
  assert.match(session, /\n  async restart\(\) \{\n    this\.debugRestarting = true;\n    try \{\n      await this\.ports\.debug\.restart\(\);/);
  assert.equal((app.match(/netease\.restart\(/g) || []).length, 1, 'one place in the app starts it');
  assert.match(app, /case "netease-restart-debug":\s*if \(netease\.debugRestarting\) break;\s*if \(target\.dataset\.confirm !== "true"\) \{[^}]*break;\s*\}\s*void netease\.restart\(\)/, 'only after the second, confirming click');
  assert.doesNotMatch(app, /nativeDebugPort|\.debug\.restart\(/, 'the app reaches the port only through the session');
});

test('the NetEase session follows the playing song in the queue\'s own column and never pulls a browsing user back', async () => {
  const { NeteaseSession } = await import('../src/netease_music/connector/session.ts');
  let debug = { available: true, trackId: '23', playback: 'playing', mode: 'playOrder', duration: 100, position: 5 };
  const ports = {
    queue: { async read() { return { status: 'queue', stamp: 'q1', truncated: false, tracks: [laneTrack(23), laneTrack(21), laneTrack(99)], source: { id: '2', name: 'Beta' } }; } },
    playlists: { async read() { return { status: 'playlists', stamp: 'p1', truncated: false, playlists: lanePlaylists() }; } },
    debug: { async state() { return debug; }, async play() { throw new Error('nothing is played'); }, async seek() { throw new Error('nothing is sought'); }, async restart() { throw new Error('never restarted'); } },
  };
  const { connection, calls } = fixture([netease('n1')], NETEASE);
  await connection.refresh();
  let albums = [], cursor = 0;
  const followed = [];
  const session = new NeteaseSession({
    media: connection, preferences: { neteaseQueue: true, playlistColumns: true },
    recordId: index => albums[index]?.id, genreId: index => albums[index]?.genreId, indexOf: id => albums.findIndex(album => album.id === id),
    selected: () => cursor, navigationSelection: () => cursor, canFollow: () => true,
    follow(index, from) { followed.push([index, from]); cursor = index; }, songChanged() {}, jumpChanged() {},
    confirmSoon() {}, async refresh() {}, notify() {},
  }, ports);
  await session.refresh();
  const shelf = session.shelf(connection.selected);
  session.queueLanesShown = shelf.lanes;
  albums = shelf.library().albums;
  const at = id => albums.findIndex(album => album.id === id);
  // Resting on the playing song in the queue's column (Beta): NetEase's next song takes the shelf along.
  cursor = at('netease-track:23');
  session.followQueue();
  assert.deepEqual(followed, []);
  debug = { ...debug, trackId: '21' };
  await session.refresh();
  session.followQueue();
  assert.deepEqual(followed, [[at('netease-track:21'), at('netease-track:23')]]);
  // Browsing a playlist's column (Gamma, browse only): NetEase changing song does not pull the shelf back.
  cursor = at('netease-list:4:41');
  debug = { ...debug, trackId: '99' };
  await session.refresh();
  session.followQueue();
  assert.equal(followed.length, 1);
  assert.equal(session.queuePlaying, 'netease-track:99');
  assert.deepEqual(calls, [], 'following sends nothing to NetEase');
});

test('▶ asks NetEase for a song of its queue by 播放队列中这首歌, for another playlist\'s song by that playlist\'s 播放全部, and never in private FM', async () => {
  // The owner, 2026-10-07/08: ▶ (the lifted case's, a song row's) and P play the selected song;
  // the ring only pauses or resumes. 2026-10-10 ("Play that playlist from the song you picked"):
  // another playlist's song plays with its playlist. Every song here is made up for the check.
  const { NeteaseSession } = await import('../src/netease_music/connector/session.ts');
  let debug = { available: true, trackId: '23', playback: 'paused', mode: 'playOrder', duration: 100, position: 5 };
  const played = [], playlistsPlayed = [];
  const ports = {
    queue: { async read() { return { status: 'queue', stamp: 'q1', truncated: false, tracks: [laneTrack(23), laneTrack(21), laneTrack(99)], source: { id: '2', name: 'Beta' } }; } },
    playlists: { async read() { return { status: 'playlists', stamp: 'p1', truncated: false, playlists: lanePlaylists() }; } },
    debug: {
      async state() { return debug; }, async play(id) { played.push(id); }, async playPlaylist(...args) { playlistsPlayed.push(args); },
      async seek() { throw new Error('nothing is sought'); }, async restart() { throw new Error('never restarted'); },
    },
  };
  const { connection, calls } = fixture([netease('n1')], NETEASE);
  await connection.refresh();
  let albums = [], cursor = 0;
  const preferences = { neteaseQueue: true, playlistColumns: true };
  const session = new NeteaseSession({
    media: connection, preferences,
    recordId: index => albums[index]?.id, genreId: index => albums[index]?.genreId, indexOf: id => albums.findIndex(album => album.id === id),
    selected: () => cursor, navigationSelection: () => cursor, canFollow: () => false, follow() {}, songChanged() {}, jumpChanged() {},
    confirmSoon() {}, async refresh() {}, notify() {},
  }, ports);
  await session.refresh();
  const shelf = session.shelf(connection.selected);
  session.queueLanesShown = shelf.lanes;
  albums = shelf.library().albums;
  session.followQueue();
  const at = id => albums.findIndex(album => album.id === id);
  assert.equal(session.queuePlaying, 'netease-track:23');
  assert.equal(session.portPlays(), true);
  // The selection (P), or the case of a row's ▶, in the queue's own column.
  cursor = at('netease-track:21');
  assert.deepEqual(session.queueSongToPlay(), { key: 'netease-track:21', song: laneTrack(21) });
  assert.deepEqual(session.queueSongToPlay(false, at('netease-track:99')), { key: 'netease-track:99', song: laneTrack(99) });
  // The playing song only when asked for itself: the rings, where NetEase has no play / pause of its own.
  assert.equal(session.queueSongToPlay(false, at('netease-track:23')), undefined);
  assert.deepEqual(session.queueSongToPlay(true, at('netease-track:23')), { key: 'netease-track:23', song: laneTrack(23) });
  // Another playlist's column (until 2026-10-10 only for browsing): its song with its playlist, which
  // becomes NetEase's queue; the request's key is the case the song then has, `from` the case it was
  // asked from. The same with the ring's `current` (a song of another playlist is never the queue's).
  const fromGamma = { key: 'netease-track:22', song: laneTrack(22), playlist: { id: '4', name: 'Gamma' }, from: 'netease-list:4:22' };
  for (const current of [false, true]) assert.deepEqual(session.queueSongToPlay(current, at('netease-list:4:22')), fromGamma, `another playlist (${current})`);
  assert.deepEqual(session.songRequest(at('netease-list:4:22')), fromGamma, 'what would be asked, whatever the port');
  assert.deepEqual(session.songRequest(at('netease-list:1:11')), { key: 'netease-track:11', song: laneTrack(11), playlist: { id: '1', name: 'Alpha' }, from: 'netease-list:1:11' }, '我喜欢的音乐 too');
  assert.equal(session.queueSongToPlay(false, -1), undefined, 'no case');
  await session.playQueueSong(session.queueSongToPlay(false, at('netease-track:99')));
  assert.deepEqual(played, ['99'], 'NetEase\'s own 播放队列中这首歌 for a song of its queue');
  assert.deepEqual(playlistsPlayed, []);
  assert.equal(session.pendingKey(), 'netease-track:99');
  // The playlist: NetEase's own 播放全部 of it from the song, with its name as the queue's source.
  await session.playQueueSong(fromGamma);
  assert.deepEqual(played, ['99']);
  assert.deepEqual(playlistsPlayed, [['4', '22', 'Gamma']]);
  assert.deepEqual(session.queueJump && { ...session.queueJump, at: 0 }, { key: 'netease-track:22', song: '22', at: 0, from: 'netease-list:4:22', timeout: 15000, fromTrack: '23' }, 'NetEase loads the playlist first');
  // 正在切换… on the case it was asked from while it is there; once the playlist is NetEase's queue
  // (the case is gone), on the song's case of the queue. Asked again meanwhile: nothing is sent.
  assert.equal(session.pendingKey(), 'netease-list:4:22');
  assert.equal(session.isPending('netease-list:4:22'), true);
  assert.equal(session.isPending('netease-track:22'), false);
  await session.playQueueSong(fromGamma);
  assert.equal(playlistsPlayed.length, 1, 'a request still on its way is not sent again');
  const gamma = albums;
  albums = albums.filter(album => album.id !== 'netease-list:4:22');
  assert.equal(session.pendingKey(), 'netease-track:22');
  albums = gamma;
  assert.deepEqual(calls, [], 'no media key, no other control');
  // Private FM plays no queue: nothing claims the selection can be played there.
  debug = { ...debug, trackId: '99', mode: 'playFm' };
  await session.refresh();
  assert.equal(session.portPlays(), false);
  for (const id of ['netease-track:21', 'netease-track:99', 'netease-list:4:41']) assert.equal(session.queueSongToPlay(true, at(id)), undefined, id);
  // Nor with the port down.
  debug = { ...debug, mode: 'playOrder', available: false };
  await session.refresh();
  assert.equal(session.portPlays(), false);
  assert.equal(session.queueSongToPlay(false, at('netease-track:21')), undefined);
  assert.equal(session.queueSongToPlay(false, at('netease-list:4:41')), undefined);
  // And again once it answers: there is no switch to turn off (the owner, 2026-10-09).
  debug = { ...debug, available: true };
  await session.refresh();
  assert.deepEqual(session.queueSongToPlay(false, at('netease-track:21')), { key: 'netease-track:21', song: laneTrack(21) });
  assert.equal(session.queueSongToPlay(false, at('netease-list:4:41'))?.playlist?.id, '4');
  // The notes that explained these limits are gone (the owner, 2026-10-07): no descriptive text.
  const source = (await import('node:fs')).readFileSync(new URL('../src/netease_music/connector/session.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /songQueueNote|queueControlNote|queueControlLimit|只供浏览|盒子与列表/);
});

test('a play request NetEase has not answered where it was asked keeps the poll quick, until NetEase has or the request lapses', async () => {
  // The owner, 2026-10-17: switching to another playlist and playing a song in it took longer than it
  // should. NetEase starts the song and saves its new queue a moment later (0.3 to 1 s on the owner's
  // NetEase); the column shows the song only once that queue is read. Every song here is made up.
  const { NeteaseSession } = await import('../src/netease_music/connector/session.ts');
  let debug = { available: true, trackId: '23', playback: 'playing', mode: 'playOrder', duration: 100, position: 5 };
  let queue = { status: 'queue', stamp: 'q1', truncated: false, tracks: [laneTrack(23), laneTrack(21), laneTrack(99)], source: { id: '2', name: 'Beta' } };
  let fail = false;
  const ports = {
    queue: { async read(stamp) { return stamp === queue.stamp ? { status: 'unchanged', stamp } : queue; } },
    playlists: { async read() { return { status: 'playlists', stamp: 'p1', truncated: false, playlists: lanePlaylists() }; } },
    debug: {
      async state() { return debug; }, async play() {}, async playPlaylist() { if (fail) throw new Error('fictional port error'); },
      async seek() { return 0; }, async restart() {},
    },
  };
  const { connection } = fixture([netease('n1')], NETEASE);
  await connection.refresh();
  let albums = [], cursor = 0;
  const session = new NeteaseSession({
    media: connection, preferences: { neteaseQueue: true, playlistColumns: true },
    recordId: index => albums[index]?.id, genreId: index => albums[index]?.genreId, indexOf: id => albums.findIndex(album => album.id === id),
    selected: () => cursor, navigationSelection: () => cursor, canFollow: () => false, follow() {}, songChanged() {}, jumpChanged() {},
    confirmSoon() {}, async refresh() {}, notify() {},
  }, ports);
  const poll = async () => {
    await session.refresh();
    const shelf = session.shelf(connection.selected);
    session.queueLanesShown = shelf.lanes;
    albums = shelf.library().albums;
    session.followQueue();
  };
  await poll();
  assert.equal(session.awaiting(), false, 'nothing asked: the poll keeps its second');
  // Gamma's song 22 with Gamma's 播放全部.
  const fromGamma = { key: 'netease-track:22', song: laneTrack(22), playlist: { id: '4', name: 'Gamma' }, from: 'netease-list:4:22' };
  await session.playQueueSong(fromGamma);
  assert.equal(session.awaiting(), true, 'asked');
  // NetEase plays 22, but its saved queue is still Beta's (which has no 22): still waiting. The song is
  // answered, and the request stands where it was asked (正在切换…, nothing to ask again, no ▶) until
  // the queue is read; previous / next are not refused for a song outside a queue NetEase has replaced.
  debug = { ...debug, trackId: '22' };
  await poll();
  assert.equal(session.awaiting(), true, 'the song plays, its queue is not saved yet');
  assert.equal(session.queueJump?.answered, true);
  assert.equal(session.isPending('netease-list:4:22'), true);
  assert.equal(session.outsideQueue(), false, 'NetEase\'s queue is Gamma already');
  // NetEase saves Gamma as its queue: the request is answered, the poll goes back to its second.
  queue = { status: 'queue', stamp: 'q2', truncated: false, tracks: [laneTrack(22), laneTrack(41)], source: { id: '4', name: 'Gamma' } };
  await poll();
  assert.equal(session.queueJump, undefined, 'NetEase reported the song asked for');
  assert.equal(session.awaiting(), false, 'and its queue comes from the playlist');
  // A song that is in both queues: NetEase playing it answers the song at once, but the playlist's
  // column shows it only once the new queue is read, so the request (and the quick poll) stands until then.
  queue = { status: 'queue', stamp: 'q3', truncated: false, tracks: [laneTrack(21), laneTrack(22), laneTrack(23)], source: { id: '2', name: 'Beta' } };
  debug = { ...debug, trackId: '21' };
  await poll();
  await session.playQueueSong({ key: 'netease-track:22', song: laneTrack(22), playlist: { id: '4', name: 'Gamma' }, from: 'netease-list:4:22' });
  debug = { ...debug, trackId: '22' };
  await poll();
  assert.equal(session.queueJump?.answered, true, 'the song was reported (it is in Beta too), its playlist not yet');
  assert.equal(session.isPending('netease-list:4:22'), true);
  assert.equal(session.awaiting(), true, 'Gamma is not the queue yet');
  queue = { status: 'queue', stamp: 'q4', truncated: false, tracks: [laneTrack(22), laneTrack(41)], source: { id: '4', name: 'Gamma' } };
  await poll();
  assert.equal(session.queueJump, undefined);
  assert.equal(session.awaiting(), false);
  // The playing song asked for with its playlist (NetEase replaces its queue, the song plays on): the
  // case it was asked from shows the request until the playlist is the queue, and it is not sent twice.
  queue = { status: 'queue', stamp: 'q5', truncated: false, tracks: [laneTrack(22), laneTrack(23)], source: { id: '2', name: 'Beta' } };
  await poll();
  assert.equal(session.queuePlaying, 'netease-track:22');
  let sent = 0;
  ports.debug.playPlaylist = async () => { sent++; };
  const again = { key: 'netease-track:22', song: laneTrack(22), playlist: { id: '4', name: 'Gamma' }, from: 'netease-list:4:22' };
  await session.playQueueSong(again);
  assert.equal(session.isPending('netease-list:4:22'), true);
  await session.playQueueSong(again);
  assert.equal(sent, 1, 'pressed again meanwhile: nothing more is sent');
  queue = { status: 'queue', stamp: 'q6', truncated: false, tracks: [laneTrack(22), laneTrack(41)], source: { id: '4', name: 'Gamma' } };
  await poll();
  assert.equal(session.queueJump, undefined);
  assert.equal(session.awaiting(), false);
  ports.debug.playPlaylist = async () => { if (fail) throw new Error('fictional port error'); };
  // A request that lapses (NetEase never switched) ends the quick reads with it.
  debug = { ...debug, trackId: '41' };
  await poll();
  await session.playQueueSong({ key: 'netease-track:23', song: laneTrack(23), playlist: { id: '2', name: 'Beta' }, from: 'netease-list:2:23' });
  assert.equal(session.awaiting(), true);
  assert.equal(session.awaiting(performance.now() + 16000) && !!session.queueJump, true, 'the song request still stands until followQueue retires it');
  session.queueJump.at -= 16000;
  await poll();
  assert.equal(session.queueJump, undefined, 'retired after its time');
  assert.equal(session.awaiting(performance.now() + 16000), false, 'and the playlist with it');
  // A request the port refused is not waited for.
  fail = true;
  await session.playQueueSong({ key: 'netease-track:21', song: laneTrack(21), playlist: { id: '2', name: 'Beta' }, from: 'netease-list:2:21' });
  assert.equal(session.awaiting(), false, 'the port refused it');
});

test('why ▶ cannot ask NetEase now is a reason the user can change, read from the last poll, and asking it sends nothing', async () => {
  // The owner, 2026-10-09 (NetEase ran without its port, and a click played nothing, silently): the
  // page says which (PORT_BLOCK_NOTICE) with a way to 播放器. Every song here is made up for the check.
  const { NeteaseSession, PORT_BLOCK_NOTICE } = await import('../src/netease_music/connector/session.ts');
  let debug = { available: true, trackId: '23', playback: 'playing', mode: 'playOrder', duration: 100, position: 5 }, broken = false;
  const sent = [];
  const ports = {
    queue: { async read() { return { status: 'queue', stamp: 'q1', truncated: false, tracks: [laneTrack(23), laneTrack(21)] }; } },
    playlists: { async read() { return { status: 'playlists', stamp: 'p1', truncated: false, playlists: [] }; } },
    debug: {
      async state() { if (broken) throw new Error('fictional page error'); return debug; },
      async play(id) { sent.push(['play', id]); }, async seek() { sent.push(['seek']); return 0; }, async restart() { sent.push(['restart']); },
    },
  };
  const { connection, calls } = fixture([netease('n1')], NETEASE);
  await connection.refresh();
  const preferences = { neteaseQueue: true, playlistColumns: false };
  const session = new NeteaseSession({
    media: connection, preferences, recordId: () => undefined, genreId: () => undefined, indexOf: () => -1,
    selected: () => 0, navigationSelection: () => 0, canFollow: () => false, follow() {}, songChanged() {}, jumpChanged() {},
    confirmSoon() {}, async refresh() {}, notify() {},
  }, ports);
  const original = console.warn;
  console.warn = () => {};
  try {
    // Not asked yet (the queue was just shown): still being probed.
    assert.equal(session.portBlock(), 'probing');
    await session.refresh();
    assert.equal(session.portBlock(), undefined, 'the port may be used');
    assert.equal(session.portPlays(), true);
    debug = { ...debug, mode: 'playFm' };
    await session.refresh();
    assert.equal(session.portBlock(), 'fm');
    debug = { ...debug, mode: 'playOrder', available: false };
    await session.refresh();
    assert.equal(session.portBlock(), 'port', 'closed: NetEase runs without its debugging port');
    broken = true;
    await session.refresh();
    assert.equal(session.portBlock(), 'error', 'answering with an error');
    broken = false;
    // The queue switched off and on again: the port is asked afresh. It has no switch of its own (the
    // owner, 2026-10-09: "do not make this a setting option"); the queue's is the only one.
    preferences.neteaseQueue = false;
    await session.refresh();
    assert.equal(session.portBlock(), 'probing');
    preferences.neteaseQueue = true;
    debug = { ...debug, available: true };
    await session.refresh();
    assert.equal(session.portBlock(), undefined);
  } finally {
    console.warn = original;
  }
  // Only the poll's reads: no play, seek or restart, no media key.
  assert.deepEqual(sent, []);
  assert.deepEqual(calls, []);
  // Each reason in a few words, an error notice (no paragraph); the button to 播放器 is the page's.
  assert.deepEqual(Object.keys(PORT_BLOCK_NOTICE).sort(), ['error', 'fm', 'port', 'probing']);
  for (const [reason, words] of Object.entries(PORT_BLOCK_NOTICE)) assert.ok(words.length <= 32 && !/[。\n]/.test(words), `${reason}: ${words}`);
  assert.equal(PORT_BLOCK_NOTICE.port, '网易云没有开启调试端口，不能切到这首歌');
  assert.doesNotMatch(Object.values(PORT_BLOCK_NOTICE).join(), /开关|点 ▶ 时让网易云播放选中的歌/, 'no switch to name');
  const source = (await import('node:fs')).readFileSync(new URL('../src/netease_music/connector/session.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const reason = source.slice(source.indexOf('\n  portBlock(): PortBlock | undefined {'), source.indexOf('\n  }\n', source.indexOf('\n  portBlock(): PortBlock | undefined {')));
  assert.doesNotMatch(reason, /ports\.|restart|preferences|await/, 'it reads what the last poll found, nothing more');
  assert.doesNotMatch(source, /neteaseControl:|preferences\.neteaseControl|controlSwitched/, 'no switch for the port');
});

test('the playlist script starts NetEase\'s 播放全部 at the chosen song in the type of NetEase\'s own song ids', async () => {
  // 2026-10-12, on the owner's NetEase: its song ids are strings and it looks for the song to start
  // with strictly; given a number it replaced the queue and went on with the old song. Every id here
  // is made up for the check.
  const { playlist } = await neteaseScripts();
  const run = state => { const dispatched = []; const store = { getState: () => state, dispatch: action => { dispatched.push(action); } }; return [playlist(770077, 22, 'Gamma', () => store), dispatched]; };
  const started = dispatched => dispatched[0]?.payload?.data?.from?.assignedPlayId;
  const queued = id => ({ resourceId: id, track: { id } });
  let [result, sent] = run({ playing: { playingMode: 'playOrder', resourceTrackId: '23' }, playingList: { curPlayingList: [queued('23'), queued('21')] } });
  assert.equal(result, 'sent');
  assert.equal(started(sent), '22', 'a string, as NetEase gives its song ids');
  assert.equal(sent[0].type, 'async:action/doAction');
  assert.equal(sent[0].payload.actionId, 'playAll');
  assert.deepEqual(sent[0].payload.data.resource, { id: 770077 }, 'the playlist as a number, as its pages give it');
  assert.deepEqual(sent[0].payload.data.from.sourceData, { id: 770077, name: 'Gamma' });
  [, sent] = run({ playing: { playingMode: 'playOrder', resourceTrackId: 23 }, playingList: { curPlayingList: [queued(23)] } });
  assert.equal(started(sent), 22, 'a number where NetEase gives numbers');
  [, sent] = run({ playing: { playingMode: 'playOrder', resourceTrackId: '23' }, playingList: { curPlayingList: [] } });
  assert.equal(started(sent), '22', 'an empty queue: the playing song tells');
  [, sent] = run({ playing: { playingMode: 'playOrder' }, playingList: { curPlayingList: [{ resourceId: '5' }] } });
  assert.equal(started(sent), '22', 'an entry without its song: its own id tells');
  assert.deepEqual(run({ playing: { playingMode: 'playFm' }, playingList: { curPlayingList: [queued('23')] } }), ['fm', []]);
  assert.equal(playlist(1, 2, 'x', () => null), 'store');
});

test('a seek NetEase is still carrying out: a reading of a second it passed on the way is not taken', async () => {
  // 2026-10-12, on the owner's NetEase: paused at 0 s, → three times; NetEase reported 2 s on its way
  // to 3 s, the clock took it and the timeline showed 2 for two seconds.
  const { PlaybackClock } = await import('../src/netease_music/connector/playback-clock.ts');
  const paused = position => ({ available: true, trackId: '7', playback: 'paused', duration: 200, position });
  const clock = new PlaybackClock();
  clock.update(paused(0), 0);
  for (const [at, target] of [[100, 1], [160, 2], [220, 3]]) clock.seek(target, at);
  clock.update(paused(2), 500);
  assert.equal(clock.position(500), 3, 'the target stands');
  clock.update(paused(3), 900);
  assert.equal(clock.position(900), 3);
  clock.update(paused(3), 2000);
  assert.equal(clock.position(2000), 3);
  // Playing: a reading a whole second behind the target is not taken during the hold either; one of
  // the target's own second is, and the clock runs on.
  const playing = position => ({ ...paused(position), playback: 'playing' });
  const live = new PlaybackClock();
  live.update(playing(40), 0);
  live.seek(10, 100);
  live.update(playing(9), 300);
  assert.ok(Math.abs(live.position(300) - 10.2) < 1e-9, `${live.position(300)}`);
  live.update(playing(10), 1100);
  assert.ok(Math.abs(live.position(1100) - 11) < 1e-9, 'NetEase caught up; the clock runs on');
  // After the hold NetEase is believed again, as before (the seek did not happen).
  const refused = new PlaybackClock();
  refused.update(paused(20), 0);
  refused.seek(90, 100);
  refused.update(paused(20), 2000);
  assert.equal(refused.position(2000), 20);
});

test('NetEase playing a song outside its queue: previous / next are not offered, and a 播放全部 that keeps the old song is no answer', async () => {
  // 2026-10-12, on the owner's NetEase: its own previous / next look for the playing song in its queue
  // and do nothing when it is not there; and a 播放全部 can replace the queue and go on with the old
  // song (the start song's type was wrong), which Rhine took for NetEase changing song by itself.
  // Every song here is made up for the check.
  const { NeteaseSession } = await import('../src/netease_music/connector/session.ts');
  let debug = { available: true, trackId: '77', playback: 'paused', mode: 'playOrder', duration: 100, position: 0 };
  let queue = { status: 'queue', stamp: 'q1', truncated: false, tracks: [laneTrack(23), laneTrack(21)], source: { id: '2', name: 'Beta' } };
  const notices = [], playlistsPlayed = [];
  const ports = {
    queue: { async read() { return queue; } },
    playlists: { async read() { return { status: 'playlists', stamp: 'p1', truncated: false, playlists: lanePlaylists() }; } },
    debug: { async state() { return debug; }, async play() {}, async playPlaylist(...args) { playlistsPlayed.push(args); }, async seek() { return 0; }, async restart() {} },
  };
  const { connection, calls } = fixture([netease('n1')], NETEASE);
  await connection.refresh();
  let albums = [];
  const session = new NeteaseSession({
    media: connection, preferences: { neteaseQueue: true, playlistColumns: true },
    recordId: index => albums[index]?.id, genreId: index => albums[index]?.genreId, indexOf: id => albums.findIndex(album => album.id === id),
    selected: () => 0, navigationSelection: () => 0, canFollow: () => false, follow() {}, songChanged() {}, jumpChanged() {},
    confirmSoon() {}, async refresh() {}, notify(message) { notices.push(message); },
  }, ports);
  const reread = async () => { session.queueStamp = undefined; await session.refresh(); };
  await session.refresh();
  assert.equal(session.outsideQueue(), true, 'song 77 is in no entry of the queue');
  debug = { ...debug, mode: 'playFm' };
  await session.refresh();
  assert.equal(session.outsideQueue(), false, 'private FM has its own previous / next');
  debug = { ...debug, mode: 'playOrder', trackId: '21' };
  await session.refresh();
  assert.equal(session.outsideQueue(), false, 'a song of the queue');
  debug = { ...debug, trackId: '77', available: false };
  await session.refresh();
  assert.equal(session.outsideQueue(), false, 'it cannot be told without the port');
  debug = { ...debug, available: true };
  queue = { ...queue, truncated: true };
  await reread();
  assert.equal(session.outsideQueue(), false, 'nor in a queue cut at its limit');
  queue = { ...queue, truncated: false };
  debug = { ...debug, trackId: '23' };
  await reread();
  const rebuild = () => { const shelf = session.shelf(connection.selected); session.queueLanesShown = shelf.lanes; albums = shelf.library().albums; };
  rebuild();
  session.followQueue();
  assert.equal(session.queuePlaying, 'netease-track:23');
  // Song 41 of Gamma, with Gamma.
  await session.playQueueSong(session.songRequest(albums.findIndex(album => album.id === 'netease-list:4:41')));
  assert.deepEqual(playlistsPlayed, [['4', '41', 'Gamma']]);
  assert.equal(session.queueJump?.fromTrack, '23');
  // NetEase's queue is Gamma now, but it goes on with song 23, which is not in it: still waiting.
  queue = { status: 'queue', stamp: 'q2', truncated: false, tracks: [laneTrack(22), laneTrack(41)], source: { id: '4', name: 'Gamma' } };
  await session.refresh();
  rebuild();
  session.followQueue();
  assert.equal(session.queuePlaying, '');
  assert.equal(session.queueJump?.key, 'netease-track:41', 'not taken for NetEase changing song by itself');
  assert.equal(session.outsideQueue(), true);
  // ... and said when NetEase never plays it.
  session.queueJump.at -= 16000;
  session.followQueue();
  assert.equal(session.queueJump, undefined);
  assert.deepEqual(notices, ['网易云没有切换到选中的歌曲。']);
  // Asked again and answered: the song plays, nothing is said.
  await session.playQueueSong({ key: 'netease-track:41', song: laneTrack(41) });
  debug = { ...debug, trackId: '41', playback: 'playing' };
  await session.refresh();
  session.followQueue();
  assert.equal(session.queueJump, undefined);
  assert.equal(session.queuePlaying, 'netease-track:41');
  assert.deepEqual(notices, ['网易云没有切换到选中的歌曲。']);
  // NetEase answering with another song (one it skipped to) still ends the request as before.
  await session.playQueueSong({ key: 'netease-track:22', song: laneTrack(22) });
  debug = { ...debug, trackId: '99' };
  queue = { ...queue, stamp: 'q3', tracks: [laneTrack(22), laneTrack(41), laneTrack(99)] };
  await session.refresh();
  rebuild();
  session.followQueue();
  assert.equal(session.queueJump, undefined);
  assert.deepEqual(calls, [], 'no media key, no other control');
  // The page: both previous / next buttons follow it, the reason only in their titles and names.
  const app = (await import('node:fs')).readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const controls = app.slice(app.indexOf('function updateExternalControls() {'), app.indexOf('\n}\n', app.indexOf('function updateExternalControls() {')));
  assert.match(controls, /const stuck = netease\.outsideQueue\(\);\s*document\.querySelectorAll<HTMLButtonElement>\("\[data-media-action\]"\)\.forEach\(button => \{\s*const action = button\.dataset\.mediaAction as MediaAction, skip = action === "previous" \|\| action === "next";\s*setUsable\(button, externalMedia\.offers\(action\) && !\(skip && stuck\)\);/);
  assert.match(controls, /if \(button\.getAttribute\("aria-label"\) !== name \+ reason\) button\.setAttribute\("aria-label", name \+ reason\);\s*if \(button\.title !== title \+ reason\) button\.title = title \+ reason;/);
});

test('a reading NetEase\'s port does not answer in time is no closed port: no restart, its own reason, and the timeline keeps the last reading a while', async () => {
  // NetEase busy (it misses a reading now and then while it loads a playlist): the native side says so
  // (debug_port.rs ERR_NO_REPLY) instead of the closed port's `available: false`, which offered to
  // restart a NetEase that was only busy and said its port was not open. Every song here is made up.
  const { NeteaseSession, PORT_GRACE_MS } = await import('../src/netease_music/connector/session.ts');
  const { PORT_NO_REPLY, PLAY_UNANSWERED } = await import('../src/netease_music/connector/ports.ts');
  let debug = { available: true, trackId: '23', playback: 'playing', mode: 'playOrder', duration: 100, position: 30 }, answer = 'ok';
  const played = [], notices = [];
  const ports = {
    queue: { async read() { return { status: 'queue', stamp: 'q1', truncated: false, tracks: [laneTrack(23), laneTrack(21)] }; } },
    playlists: { async read() { return { status: 'playlists', stamp: 'p1', truncated: false, playlists: [] }; } },
    debug: {
      async state() { if (answer === 'late') throw new Error(PORT_NO_REPLY); if (answer === 'error') throw new Error('fictional page error'); return debug; },
      async play(id) { played.push(id); throw new Error(PLAY_UNANSWERED); }, async seek() { return 0; }, async restart() { throw new Error('never restarted'); },
    },
  };
  const { connection, set } = fixture([netease('n1', { title: 'Song 23' })], NETEASE);
  await connection.refresh();
  let albums = [];
  const session = new NeteaseSession({
    media: connection, preferences: { neteaseQueue: true, playlistColumns: false },
    recordId: index => albums[index]?.id, genreId: () => 'external', indexOf: id => albums.findIndex(album => album.id === id),
    selected: () => 0, navigationSelection: () => 0, canFollow: () => false, follow() {}, songChanged() {}, jumpChanged() {},
    confirmSoon() {}, async refresh() {}, notify(message) { notices.push(message); },
  }, ports);
  const original = console.warn;
  console.warn = () => {};
  try {
    await session.refresh();
    albums = session.shelf(connection.selected).library().albums;
    session.followQueue();
    assert.equal(session.timeline(connection.selected).duration, 100);
    // One late reading: its reason is that the port does not answer, and nothing offers a restart.
    answer = 'late';
    await session.refresh();
    assert.equal(session.portBlock(), 'error');
    assert.deepEqual({ ...session.queueControl() }, { available: false, status: PORT_NO_REPLY, restart: false });
    // The timeline keeps the last reading (a second past it at most, as between any two), and can be dragged.
    const kept = session.timeline(connection.selected);
    assert.ok(kept && kept.duration === 100 && kept.seekable && kept.debug && kept.position >= 30 && kept.position <= 31, JSON.stringify(kept));
    // ... while the media session names the same song, for PORT_GRACE_MS.
    set({ sources: [netease('n1', { title: 'Song 21' })] });
    await connection.refresh();
    assert.equal(session.timeline(connection.selected), undefined, 'another song by the media session');
    set({ sources: [netease('n1', { title: 'Song 23' })] });
    await connection.refresh();
    assert.ok(session.timeline(connection.selected));
    session.portSeen.at -= PORT_GRACE_MS;
    await session.refresh();
    assert.equal(session.timeline(connection.selected), undefined, 'not past PORT_GRACE_MS');
    // An error the port gave is no late reading: nothing is kept.
    answer = 'ok';
    await session.refresh();
    answer = 'error';
    await session.refresh();
    assert.equal(session.timeline(connection.selected), undefined);
    assert.equal(session.queueControl().restart, false);
    // A closed port: the restart is offered, as before.
    answer = 'ok';
    debug = { available: false };
    await session.refresh();
    assert.equal(session.portBlock(), 'port');
    assert.equal(session.queueControl().restart, true);
    // A play request that reached NetEase without an answer in time is waited for, and said nothing of.
    debug = { available: true, trackId: '23', playback: 'playing', mode: 'playOrder', duration: 100, position: 30 };
    await session.refresh();
    session.followQueue();
    await session.playQueueSong({ key: 'netease-track:21', song: laneTrack(21) });
    assert.deepEqual(played, ['21']);
    assert.equal(session.queueJump?.key, 'netease-track:21');
    assert.deepEqual(notices, []);
    // A late reading as the queue changes is no answer either: the request stands until its time.
    answer = 'late';
    albums = albums.filter(album => album.id !== 'netease-track:23');
    await session.refresh();
    session.followQueue();
    assert.equal(session.queueJump?.key, 'netease-track:21');
    session.queueJump.at -= 7000;
    session.followQueue();
    assert.equal(session.queueJump, undefined);
    assert.deepEqual(notices, ['网易云没有切换到选中的歌曲。']);
  } finally {
    console.warn = original;
  }
  // The words the native side gives are the ones the page knows.
  const rust = (await import('node:fs')).readFileSync(new URL('../src-tauri/src/netease_music/connector/debug_port.rs', import.meta.url), 'utf8');
  assert.match(rust, new RegExp(`const ERR_NO_REPLY: &str = "${PORT_NO_REPLY}";`));
  assert.match(rust, new RegExp(`const ERR_UNANSWERED: &str = "${PLAY_UNANSWERED}";`));
});

test('a timeline target belongs to the song the drag began in: NetEase changing song meanwhile does not get it', async () => {
  // A drag (or a held arrow key) on one song, let go after NetEase moved on to the next: the target went
  // to the next song, which jumped to the middle. Every song here is made up.
  const { NeteaseSession } = await import('../src/netease_music/connector/session.ts');
  let debug = { available: true, trackId: '23', playback: 'playing', mode: 'playOrder', duration: 191, position: 30 };
  const seeks = [], notices = [];
  const ports = {
    queue: { async read() { return { status: 'queue', stamp: 'q1', truncated: false, tracks: [laneTrack(23), laneTrack(21)] }; } },
    playlists: { async read() { return { status: 'playlists', stamp: 'p1', truncated: false, playlists: [] }; } },
    debug: {
      async state() { return debug; }, async play() {}, async restart() {},
      // As the native side answers: only for the song NetEase plays.
      async seek(id, position) { seeks.push([id, position]); if (id !== debug.trackId) throw new Error('网易云已经换歌，没有调整进度'); return position; },
    },
  };
  const { connection } = fixture([netease('n1', { title: 'Song 23' })], NETEASE);
  await connection.refresh();
  const session = new NeteaseSession({
    media: connection, preferences: { neteaseQueue: true, playlistColumns: false },
    recordId: () => undefined, genreId: () => undefined, indexOf: () => -1, selected: () => 0, navigationSelection: () => 0,
    canFollow: () => false, follow() {}, songChanged() {}, jumpChanged() {}, confirmSoon() {}, async refresh() {}, notify(message) { notices.push(message); },
  }, ports);
  await session.refresh();
  session.beginSeek();
  debug = { ...debug, trackId: '21', duration: 198, position: 0 };
  await session.refresh();
  session.beginSeek();
  session.seekTarget(154);
  assert.ok(session.timeline(connection.selected).position < 2, 'the next song\'s timeline is not moved');
  await session.sendSeeks();
  session.endSeek();
  assert.deepEqual(seeks, [['23', 154]], 'asked for the song it was dragged in, which NetEase no longer plays');
  assert.deepEqual(notices, ['网易云已经换歌，没有调整进度']);
  // On the song that plays: sent for it, and shown at once.
  session.beginSeek();
  session.seekTarget(50);
  assert.ok(Math.abs(session.timeline(connection.selected).position - 50) < 0.01);
  await session.sendSeeks();
  session.endSeek();
  assert.deepEqual(seeks.at(-1), ['21', 50]);
  // A change without a drag (assistive technology) goes to the song that plays.
  session.seekTarget(60);
  await session.sendSeeks();
  assert.deepEqual(seeks.at(-1), ['21', 60]);
  const app = (await import('node:fs')).readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8');
  assert.match(app, /function beginExternalSeek\(\) \{[^}]*netease\.beginSeek\(\);\s*\}/);
  assert.match(app, /void netease\.sendSeeks\(\);\s*netease\.endSeek\(\);/);
});

test('one media snapshot that cannot be read keeps NetEase\'s shelf, playlists and port, and offers nothing meanwhile', async () => {
  // external-media.ts: an unreadable snapshot is no proof the session disappeared. The NetEase session
  // took it for "not NetEase": the shelf emptied (选择播放器 flashed), open details closed, the playlists
  // were read again. Every song and playlist here is made up.
  const { NeteaseSession } = await import('../src/netease_music/connector/session.ts');
  let playlistReads = 0;
  const ports = {
    queue: { async read() { return { status: 'queue', stamp: 'q1', truncated: false, tracks: [laneTrack(23), laneTrack(21), laneTrack(99)], source: { id: '2', name: 'Beta' } }; } },
    playlists: { async read() { playlistReads++; return { status: 'playlists', stamp: 'p1', truncated: false, playlists: lanePlaylists() }; } },
    debug: { async state() { return { available: true, trackId: '23', playback: 'playing', mode: 'playOrder', duration: 100, position: 5 }; }, async play() {}, async seek() { return 0; }, async restart() {} },
  };
  const { connection, set, calls } = fixture([netease('n1')], NETEASE);
  await connection.refresh();
  let albums = [];
  const session = new NeteaseSession({
    media: connection, preferences: { neteaseQueue: true, playlistColumns: true },
    recordId: index => albums[index]?.id, genreId: index => albums[index]?.genreId, indexOf: id => albums.findIndex(album => album.id === id),
    selected: () => 0, navigationSelection: () => 0, canFollow: () => false, follow() {}, songChanged() {}, jumpChanged() {},
    confirmSoon() {}, async refresh() {}, notify() {},
  }, ports);
  await session.refresh();
  const shelf = session.shelf(connection.selected);
  session.queueLanesShown = shelf.lanes;
  albums = shelf.library().albums;
  const at = id => albums.findIndex(album => album.id === id);
  assert.ok(session.songRequest(at('netease-track:21')));
  set(new Error('媒体来源正在刷新，请稍后重试'));
  await connection.refresh();
  assert.equal(connection.unreadable, true);
  await session.refresh();
  assert.ok(session.shownQueue(), 'the queue stays');
  assert.equal(session.externalPlaylists?.length, 4, 'and the playlists');
  assert.equal(session.debugState.available, true, 'and the port');
  assert.equal(session.songRequest(at('netease-track:21')), undefined, 'nothing is offered while retrying');
  set({ sources: [netease('n1')] });
  await connection.refresh();
  assert.equal(connection.unreadable, false);
  await session.refresh();
  assert.equal(playlistReads, 1, 'the playlists are not read again');
  assert.ok(session.songRequest(at('netease-track:21')));
  // A session that is gone from a snapshot that was read: NetEase is no longer the current source.
  set({ sources: [] });
  await connection.refresh();
  assert.equal(connection.unreadable, false);
  await session.refresh();
  assert.equal(session.shownQueue(), undefined);
  assert.deepEqual(calls, []);
  // The page keeps the shelf, the selection and an open details page through the unreadable snapshot.
  const app = (await import('node:fs')).readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8');
  // (2026-10-24, QQ Music: a single card of the session still selected stays too.)
  assert.match(app, /const source = externalMedia\.selected;\s*(\/\/[^\n]*\n\s*)*if \(!source && externalMedia\.unreadable && \(netease\.shownQueue\(\) \|\| externalVisualId === externalMedia\.selectedId\)\) return;/);
  assert.match(app, /await applyLibrary\(\);\s*externalVisual = nextVisual;\s*externalVisualId = source\?\.id;/);
});

test('a new song\'s first reading that still shows the last song\'s position is not taken', async () => {
  // On the owner's NetEase, for about 0.1 to 0.25 s after Rhine asked for another song, the port named the
  // new song with the old one's position (its progress slider had not moved yet): the new song showed
  // 1:40 for about a second, its timeline opened there and its lyrics lit a late line.
  const { PlaybackClock } = await import('../src/netease_music/connector/playback-clock.ts');
  const reading = (position, trackId = '7', extra = {}) => ({ available: true, trackId, playback: 'playing', duration: 200, position, ...extra });
  const clock = new PlaybackClock();
  clock.update(reading(100), 0);
  clock.update(reading(100, '8'), 200);
  assert.equal(clock.position(200), undefined, 'nothing is shown for the new song yet');
  assert.equal(clock.settling(200), true, 'and it is read again soon');
  clock.update(reading(100, '8'), 350);
  assert.equal(clock.position(350), undefined);
  clock.update(reading(0, '8'), 500);
  assert.equal(clock.position(500), 0, 'its own position');
  assert.equal(clock.settling(500), false);
  // Paused the same way.
  const paused = new PlaybackClock();
  paused.update(reading(100, '7', { playback: 'paused' }), 0);
  paused.update(reading(100, '8'), 200);
  assert.equal(paused.position(200), undefined);
  // A new song that really is where the last one was: taken once a reading moves on, or after the hold.
  const same = new PlaybackClock();
  same.update(reading(40), 0);
  same.update(reading(40, '9'), 100);
  assert.equal(same.position(100), undefined);
  same.update(reading(40, '9'), 1700);
  assert.equal(same.position(1700), 40);
  // Another song at another position, or at its start, is taken at once, as before.
  const other = new PlaybackClock();
  other.update(reading(100), 0);
  other.update(reading(12, '8'), 200);
  assert.equal(other.position(200), 12);
  other.update(reading(0, '9'), 400);
  assert.equal(other.position(400), 0);
  // The first reading of all is taken whatever it says.
  const first = new PlaybackClock();
  first.update(reading(100), 0);
  assert.equal(first.position(0), 100);
});

test('the lyrics script cuts a line at whole characters and sends no lone half of one', async () => {
  // A line cut inside a character, or NetEase's own broken text, carried a lone surrogate, which the
  // native side could not read: the song's lyrics never showed. Every line here is made up.
  const { lyrics } = await neteaseScripts();
  const lone = String.fromCharCode(0xD83D), low = String.fromCharCode(0xDE00);
  const lyric = {
    resourceTrackId: '7', displayType: 'default', offset: 0,
    lyricLines: [{ time: 1, lyric: 'x'.repeat(299) + '\u{1F600}more' }, { time: 2, lyric: 'line ' + lone }, { time: 3, lyric: '\u{1F600}'.repeat(400) }],
    tlyricLines: [{ lyric: low + 'a' }, { lyric: '' }, { lyric: '' }],
    yrcInfo: { yrc: 'w' + lone, yrcTrans: '' },
  };
  const store = { getState: () => ({ playing: { resourceTrackId: '7' }, 'async:lyric': lyric }), dispatch() { throw new Error('nothing is dispatched'); } };
  const reply = lyrics('7', false, () => store);
  assert.equal(reply.status, 'ready');
  assert.equal(reply.lines[0][1], 'x'.repeat(299) + '\u{1F600}', 'cut after 300 whole characters');
  assert.equal(reply.lines[1][1], 'line \u{FFFD}');
  assert.equal([...reply.lines[2][1]].length, 300);
  assert.equal(reply.translations[0], '\u{FFFD}a');
  assert.equal(reply.words, 'w\u{FFFD}');
  assert.doesNotMatch(JSON.stringify(reply), /\\u[dD][89a-fA-F]/, 'no lone half reaches the reply');
});

test('the playlists status: what is waiting for NetEase, what the limits cut, and no stale error', async () => {
  const { playlistSummary } = await import('../src/netease_music/connector/settings.ts');
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
  const session = (await import('node:fs')).readFileSync(new URL('../src/netease_music/connector/session.ts', import.meta.url), 'utf8');
  assert.match(session, /\/\/ Also for "unchanged": a read that failed before left its error in the status\.[\s\S]{0,120}if \(this\.externalPlaylists\) this\.playlistStatus = playlistSummary\(this\.externalPlaylists, this\.playlistsCut\);/);
});

test('following survives a rebuilt shelf: the song asked for with its playlist, else the playing song of the new queue, never another column by default', async () => {
  const app = (await import('node:fs')).readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8');
  const block = app.slice(app.indexOf('const gone = playerCurrent && records.length > 0 && records[selected]?.id !== previousId;'), app.indexOf('// A column opens where it was left'));
  assert.ok(block.length > 200, 'the block is in applyLibrary');
  // A playlist asked to play from one of its songs (2026-10-10) became NetEase's queue: the case it was
  // asked from is gone and the selection moves to the song's case of the queue, the request standing.
  // Only then: a rebuild that keeps the case (the request still on its way) leaves the selection.
  // NetEase moving its queue to or from the column of a song the user browses, by itself: the song is
  // still in its column with the other kind of key, and the user stays on it (never pulled to the song
  // NetEase plays; an open details page with it). Only a selection that was following goes along.
  assert.match(block, /^const gone = playerCurrent && records\.length > 0 && records\[selected\]\?\.id !== previousId;\s*const jump = gone \? netease\.queueJump : undefined;\s*const asked = jump\?\.from && jump\.from === previousId \? records\.findIndex\(\(record\) => record\.id === jump\.key\) : -1;\s*(\/\/[^\n]*\n\s*)*const browsed = gone && netease\.queueFollowPaused && netease\.shownQueue\(\) \? moved\(previousIndex\) : -1;\s*if \(asked >= 0\) selected = asked;\s*else if \(browsed >= 0\) selected = browsed;\s*else if \(gone\) \{/);
  assert.ok(app.indexOf('const moved = (index: number) => {') < app.indexOf('const browsed = gone'), 'where a case of the shelf as it was stands now');
  assert.ok(block.indexOf('if (asked >= 0) selected = asked;') < block.indexOf('netease.forgetQueueJumps();'), 'the request is not forgotten');
  // The playing song is asked of the queue just read, not of the last poll's key.
  assert.match(block, /const key = netease\.playingKey\(\);/);
  const session = (await import('node:fs')).readFileSync(new URL('../src/netease_music/connector/session.ts', import.meta.url), 'utf8');
  assert.match(session, /playingKey\(\) \{\s*const queue = this\.shownQueue\(\);\s*return queue \? queueTrackKey\(playingQueueTrack\(queue\.tracks, this\.host\.media\?\.selected, this\.debugState\)\) : "";/);
  assert.doesNotMatch(block, /record\.id === (netease\.)?queuePlaying/);
  assert.match(block, /const liveColumn = archiveColumns\.findIndex\(\(_, column\) => netease\.laneAt\(columnFiles\(column\)\[0\]\)\?\.live\);/);
  assert.match(block, /if \(playing >= 0\) selected = playing;\s*else if \(liveColumn >= 0\) selected = columnFiles\(liveColumn\)\[0\];/);
  // Stepping into the queue's column never plays: following resumes whether or not the playing song has a case there.
  assert.match(app, /const live = !!netease\.laneAt\(columnFiles\(lane\)\[0\]\)\?\.live;[\s\S]{0,280}if \(live\) netease\.queueFollowPaused = false;/);
  // A column opens where it was left across rebuilds.
  assert.match(app, /const kept = columnFiles\(lane\)\.find\(\(index\) => remembered\.has\(records\[index\]\.id\)\);\s*return kept === undefined \? \[\] : /, 'only cases that exist are carried over; an unvisited column has no entry');
  // A column step ends the wheel's glide, so rows still owed cannot move (and play) in the queue's column.
  assert.match(app, /if \(live\) netease\.queueFollowPaused = false;[\s\S]{0,160}wheelNavigation\.reset\(\);/);
});

// The music modules (docs/architecture/overview.md): each source keeps its data and connector in
// its own folder; the shared external-player code uses no source; the sources do not use each other.
test('the module folders keep their dependency rules', async () => {
  const { readdirSync, readFileSync, existsSync } = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  const modules = ['external_player', 'local_music', 'netease_music', 'qq_music'];
  const area = file => {
    const first = path.relative(src, file).split(path.sep)[0];
    return modules.includes(first) ? first : 'core';
  };
  const allowed = {
    external_player: ['core', 'external_player'],
    local_music: ['core', 'local_music'],
    netease_music: ['core', 'external_player', 'netease_music'],
    qq_music: ['core', 'external_player', 'qq_music'],
  };
  const files = readdirSync(src, { recursive: true }).map(String).filter(file => file.endsWith('.ts')).map(file => path.join(src, file));
  let seen = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const name = path.relative(src, file).replace(/\\/g, '/');
    for (const [, specifier] of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      seen++;
      const target = path.resolve(path.dirname(file), specifier);
      const resolved = path.extname(target) ? target : `${target}.ts`;
      // A file, never a folder or an index: the checks' TypeScript loader resolves files only.
      assert.ok(existsSync(resolved) || /\.(css|json|png|glb|svg)$/.test(target), `${name} imports a file: ${specifier}`);
      const from = area(file), to = area(resolved);
      if (from === 'core') {
        if (to === 'core') continue;
        const ok = ['music-app.ts', 'music-sources.ts'].includes(name) || (name === 'song-list.ts' && specifier === './external_player/player-track.ts');
        assert.ok(ok, `${name} reaches into ${to} (${specifier}): only music-app.ts and music-sources.ts may`);
      } else assert.ok(allowed[from].includes(to), `${name} (${from}) may not use ${to} (${specifier})`);
    }
  }
  assert.ok(seen > 100, 'the imports were read');
  // Rust: local music never uses the players, nor the page's server that hands it its routes (only
  // the shared HTTP plumbing, crate::http); NetEase and QQ Music never use each other, local music or
  // the page's server.
  const rust = fileURLToPath(new URL('../src-tauri/src/', import.meta.url));
  const banned = {
    local_music: /crate::(media|netease_music|qq_music|app_server)\b/,
    netease_music: /crate::(local_music|qq_music|library|metadata|online|app_server|http)\b/,
    qq_music: /crate::(local_music|netease_music|library|metadata|online|app_server|http)\b/,
  };
  // Code only: a comment may point at another module.
  const code = text => text.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  for (const [folder, pattern] of Object.entries(banned))
    for (const file of readdirSync(path.join(rust, folder), { recursive: true }).map(String).filter(file => file.endsWith('.rs')))
      assert.doesNotMatch(code(readFileSync(path.join(rust, folder, file), 'utf8')), pattern, `${folder}/${file}`);
  // The page's server is outside the source modules (2026-10-06: it serves the page for every
  // source) and reads no player; the local music's /api routes are the one source it reaches.
  for (const file of ['app_server.rs', 'http.rs']) {
    const text = code(readFileSync(path.join(rust, file), 'utf8'));
    assert.doesNotMatch(text, /crate::(media|netease_music|qq_music)\b/, file);
    assert.doesNotMatch(text, /\b(netease|qqmusic|qq_music|cloudmusic)\b/i, file);
  }
  assert.match(code(readFileSync(path.join(rust, 'app_server.rs'), 'utf8').replace(/\r\n/g, '\n')), /if route\.starts_with\("\/api\/"\) \{\n\s*return api::respond\(request, &route, url\.query\(\), get, post, &input, store\);/,
    'every /api/ route goes to the local music');
  assert.ok(!existsSync(path.join(rust, 'local_music', 'connector', 'server.rs')), 'the page is no longer served from the local music');
  // The shared media code uses QQ Music only to mark and name its sessions (media::player_of and
  // media::player_source): nothing QQ-specific is read or sent from the shared worker.
  const qqUses = new Set([...code(readFileSync(path.join(rust, 'media.rs'), 'utf8')).matchAll(/crate::qq_music::[\w:]+/g)].map(match => match[0]));
  assert.deepEqual([...qqUses].sort(), ['crate::qq_music::PLAYER', 'crate::qq_music::connector::is_app', 'crate::qq_music::data::now_playing']);
  // NetEase's the same way: recognised, marked and named there (2026-10-06), nothing else of it.
  const neteaseUses = new Set([...code(readFileSync(path.join(rust, 'media.rs'), 'utf8')).matchAll(/crate::netease_music::[\w:]+/g)].map(match => match[0]));
  assert.deepEqual([...neteaseUses].sort(), ['crate::netease_music::NAME', 'crate::netease_music::PLAYER', 'crate::netease_music::connector::is_app', 'crate::netease_music::connector::is_program']);
  assert.doesNotMatch(code(readFileSync(path.join(rust, 'media', 'windows_media.rs'), 'utf8')), /qq_music|qqmusic/i, 'media/windows_media.rs');
});
