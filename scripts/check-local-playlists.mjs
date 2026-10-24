import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { playlistShelf, playlistSongs, playlistQueue, introductionFits } from '../src/local_music/data/playlists.ts';
import { demoLibrary } from '../src/local_music/data/demo-library.ts';
import { readLibraryChange } from '../src/local_music/connector/library-api.ts';
import { setMusicAlbums, archiveColumns, columnFiles, records } from '../src/data.ts';

// The owner, 2026-10-06: "Local music means choosing a main folder, and each playlist will be a
// subfolder." The service lists the playlists (library.rs / music-library.mjs); here they become
// the shelf: one column per playlist, one case per song. Fictional names only.
const track = (id, albumId, extra = {}) => ({
  id, albumId, title: `Song ${id}`, artist: 'Fictional Singer', duration: 200, format: 'FLAC',
  browserPlayable: true, audioUrl: `/api/audio/${id}`, relativePath: '', ...extra,
});
const album = (id, tracks, extra = {}) => ({
  id, title: `Record ${id}`, artist: 'Fictional Singer', genreId: 'unclassified', rawGenres: ['Jazz'],
  folder: `/music/${id}`, coverUrl: `/api/artwork/${id}?v=1`, tracks, producers: [], offline: false, ...extra,
});
const library = () => ({
  albums: [
    album('a', [track('t1', 'a', { year: 2001, album: 'Record a' }), track('t2', 'a'), track('t3', 'a', { format: 'DSF', browserPlayable: false })]),
    album('loose', [track('t4', 'loose')]),
    album('b', [track('t5', 'b')], { offline: true }),
  ],
  playlists: [
    { id: 'p-main', name: 'Main', folder: '/music', main: true, trackIds: ['t4'] },
    { id: 'p-alpha', name: 'Alpha', folder: '/music/Alpha', main: false, trackIds: ['t2', 't1', 'missing', 't3'] },
    { id: 'p-empty', name: 'Only missing', folder: '/music/x', main: false, trackIds: ['gone'] },
    { id: 'p-beta', name: 'Beta', folder: '/music/Beta', main: false, trackIds: ['t5', 't1'] },
  ],
});

test('each playlist is a column and each of its songs a case, in the service\'s order', () => {
  const shelf = playlistShelf(library());
  assert.deepEqual(shelf.genres, [
    { id: 'p-main', name: 'Main', albumCount: 1 }, { id: 'p-alpha', name: 'Alpha', albumCount: 3 }, { id: 'p-beta', name: 'Beta', albumCount: 1 },
  ], 'a playlist whose songs are all missing is left out');
  assert.deepEqual(shelf.albums.map((item) => [item.id, item.genreId]), [
    ['t4', 'p-main'], ['t2', 'p-alpha'], ['t1', 'p-alpha'], ['t3', 'p-alpha'], ['t5', 'p-beta'],
  ], 'a song is shown once (t1 stays in its first playlist); a missing song has no case');
  const one = shelf.albums.find((item) => item.id === 't1');
  // The case is the song: its own title, artist and year; its album's cover; the song as its one track.
  assert.deepEqual([one.title, one.artist, one.year, one.coverUrl, one.folder], ['Song t1', 'Fictional Singer', 2001, '/api/artwork/a?v=1', '/music/a']);
  assert.deepEqual(one.tracks.map((item) => item.id), ['t1']);
  assert.equal(shelf.albums.find((item) => item.id === 't5').offline, true, 'an offline folder\'s songs are offline');
  const song = shelf.songs.get('t1');
  assert.deepEqual([song.playlist.id, song.album.id, song.position], ['p-alpha', 'a', 1]);
  assert.deepEqual(playlistSongs(shelf, 'p-alpha').map((item) => item.id), ['t2', 't1', 't3']);
  assert.deepEqual(playlistSongs(shelf, 'nothing'), []);
  // The shelf model: the columns are the playlists, the rows their songs.
  setMusicAlbums(shelf.albums, shelf.genres, 'genre');
  assert.deepEqual(archiveColumns, ['Main', 'Alpha', 'Beta']);
  assert.deepEqual(columnFiles(1).map((index) => records[index].id), ['t2', 't1', 't3']);
});

test('the player continues through the playlist; songs it cannot play are left out unless asked for', () => {
  const shelf = playlistShelf(library());
  assert.deepEqual(playlistQueue(shelf, shelf.songs.get('t2')).map((item) => item.id), ['t2', 't1']);
  assert.deepEqual(playlistQueue(shelf, shelf.songs.get('t3')).map((item) => item.id), ['t2', 't1', 't3'], 'asked for: it says why it cannot play');
  assert.deepEqual(playlistQueue(shelf, shelf.songs.get('t5')).map((item) => item.id), ['t5']);
});

test('a song shows its album\'s introduction only when the introduction is about that album', () => {
  const shelf = playlistShelf(library());
  assert.equal(introductionFits(shelf.songs.get('t1')), true, 'the song names the record\'s album');
  assert.equal(introductionFits(shelf.songs.get('t2')), true, 'the song names no album: the record is its folder');
  assert.equal(introductionFits({ track: track('x', 'a', { album: 'Another record' }), album: album('a', [track('x', 'a'), track('y', 'a')]) }), false);
  assert.equal(introductionFits({ track: track('x', 'a', { album: 'Another record' }), album: album('a', [track('x', 'a')]) }), true, 'a record of one song');
});

// The 音乐库 panel (music-app.ts): a new main folder chosen during a scan is said to wait, not dropped
// (the service answers 409); what a scan could not read and the data files set aside at a start
// (library.rs) are stated; an offline main folder says its index was kept only when there was one.
test('the library panel states a refused folder change, unreadable entries and set-aside data files', () => {
  const app = readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const scan = app.slice(app.indexOf('async function scan('), app.indexOf('async function enrich('));
  assert.match(scan, /if \(library\.scan\.running\) \{\n(\s*\/\/[^\n]*\n)*\s*if \(saveRoots\) notify\("正在扫描，请在扫描完成后再更改音乐主文件夹。"\);\n\s*return;/);
  const status = app.slice(app.indexOf('function updateScanStatus('), app.indexOf('function renderSearchPanel('));
  assert.match(status, /main\?\.unreadable \?/);
  assert.match(status, /library\.setAside\?\.length \?/);
  assert.match(status, /暂时离线\$\{library\.albums\.length \? "，原索引已保留" : ""\}。/);
});

test('a scan changes the shelf in place: the page is not loaded again, and only a scan asked for here is announced', () => {
  const app = readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const body = (start, end = '\n}\n') => {
    const from = app.indexOf(start);
    assert.ok(from >= 0, start);
    return app.slice(from, app.indexOf(end, from));
  };
  // A reload stopped the song, closed the details and played the opening again, also after the
  // scan the service makes by itself at every start when it outlasted the page's first read.
  // (The one reload left is a page brought back from the back-forward cache: navigation, not a scan.)
  assert.equal(app.match(/location\.reload\(/g)?.length, 1);
  assert.match(app, /window\.addEventListener\("pageshow", \(e\) => \{\s*if \(e\.persisted\) location\.reload\(\);\s*\}\);/);
  const receive = body('async function receiveLibrary(');
  assert.doesNotMatch(receive, /setTimeout|reload|自动刷新/);
  assert.match(receive, /const asked = !!scanAsked && next\.scan\.startedAt === scanAsked;\s*const scanCompleted = asked && !next\.scan\.running && !next\.scan\.error && !!next\.scan\.finishedAt;/);
  assert.match(receive, /if \(asked && !next\.scan\.running\) scanAsked = undefined;/);
  assert.match(receive, /if \(changed \|\| force\) await applyLibrary\(\);/);
  // A main folder away (offline) is said to be, its index kept: not "扫描完成".
  assert.match(receive, /if \(scanCompleted\) \{\s*(\/\/[^\n]*\n\s*)*const main = next\.roots\[0\];\s*notify\(main\?\.status === "offline"\s*\? `\$\{main\.path\} 暂时离线\$\{next\.albums\.length \? "，原索引已保留" : ""\}。`\s*: changed \? "音乐库扫描完成，歌单已更新。" : "音乐库扫描完成，没有变化。"\);/);
  // The library panel follows a change while it is open (its counts and playlists), in place: only a
  // part whose words changed is written again, never its fields, so what is typed there, the focus and
  // the caret stay (an online lookup changes the library at every poll while it runs).
  assert.match(receive, /if \(panel === "library"\) refreshLibraryPanel\(\);/);
  const refresh = body('function refreshLibraryPanel(');
  assert.match(refresh, /if \(!node \|\| libraryPanelShown\.get\(selector\) === next\) continue;/);
  assert.doesNotMatch(refresh, /renderLibraryPanel|#music-root|#online-config|panel-body"\)\.innerHTML/);
  assert.match(app, /const libraryPanelParts: \[string, \(\) => string\]\[\] = \[\s*\["#library-metrics", libraryMetricsMarkup\], \["#library-lists", libraryListsMarkup\], \["#library-covers", libraryCoversMarkup\],\s*\];/);
  // The local player goes on through its playlist as the scan left it; a song the library no longer
  // has stops (MusicPlayer.setQueue, check-music-player.mjs).
  const apply = body('async function applyLibrary(');
  assert.ok(apply.indexOf('syncPlayerQueue();') > apply.indexOf('setMusicAlbums(albums, genres, displaySort);'), 'after the shelf is the new one');
  assert.ok(apply.indexOf('syncPlayerQueue();') < apply.indexOf('await scene.refreshLibrary('), 'before a rebuild waits');
  assert.match(body('function syncPlayerQueue('), /const song = localShelf\.songs\.get\(loaded\.id\);\s*const queue = song \? playlistQueue\(localShelf, song\) : \[\];\s*if \(JSON\.stringify\(queue\) !== JSON\.stringify\(player\.state\.queue\)\) player\.setQueue\(queue\);/);
  // The scan asked for: the one under way when the service answers (or one already running).
  assert.match(body('async function scan('), /const next = await scanLibrary\(roots\);\s*\+\+libraryStateVersion;[^\n]*\n(\s*\/\/[^\n]*\n)*\s*scanAsked = next\.scan\.startedAt;[\s\S]*await receiveLibrary\(next\);/);
  // 本地音乐's shelf keeps the selection's song, the camera and an open scene (scene.relayout; the
  // rest of that path is checked with NetEase's queue in check-external-media.mjs).
  assert.match(body('async function applyLibrary('), /const anchor = hadAlbums && \(!playerCurrent \|\| !!netease\.shownQueue\(\) \|\| coverOnly\) \? moved\(previousIndex\) : -1;/);
  // An idle poll sends the tag of the library the page has; an unchanged one is not read again.
  assert.match(body('async function loadLibrary('), /const next = await readLibraryChange\(force \? undefined : libraryTag\);\s*const available = apiAvailable;\s*apiAvailable = true;\s*if \(next && stateVersion === libraryStateVersion && !boot\?\.active\) await receiveLibrary\(next\.library, force, next\.tag\);\s*else if \(!next && !available\) \{/);
  assert.match(receive, /^async function receiveLibrary\(next: MusicLibrary, force = false, tag\?: string\) \{\s*libraryTag = tag;/, 'a library from a POST has no tag: the next poll reads it whole');
});

test('the library is read again only when the service says it changed (its ETag)', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  t.after(() => (previous ? Object.defineProperty(globalThis, 'fetch', previous) : delete globalThis.fetch));
  const sent = [];
  let reply;
  globalThis.fetch = async (url, init = {}) => (sent.push([url, init.headers?.['If-None-Match']]), reply);
  const library = { version: 1, albums: [], genres: [], roots: [], scan: { running: false }, onlineEnabled: false };
  reply = new Response(JSON.stringify(library), { status: 200, headers: { ETag: '"fictional-1"' } });
  assert.deepEqual(await readLibraryChange(), { library, tag: '"fictional-1"' });
  reply = new Response(null, { status: 304, headers: { ETag: '"fictional-1"' } });
  assert.equal(await readLibraryChange('"fictional-1"'), undefined, 'unchanged');
  reply = new Response(JSON.stringify(library), { status: 200 });
  assert.deepEqual(await readLibraryChange('"fictional-1"'), { library, tag: undefined }, 'a service without tags');
  assert.deepEqual(sent, [['/api/library', undefined], ['/api/library', '"fictional-1"'], ['/api/library', '"fictional-1"']]);
  reply = new Response(JSON.stringify({ error: '虚构的错误' }), { status: 500 });
  await assert.rejects(readLibraryChange(), /虚构的错误/);
});

test('the demonstration is two playlists of cover-only songs: nothing to play', () => {
  const shelf = playlistShelf(demoLibrary, true);
  assert.deepEqual(shelf.genres.map((genre) => [genre.name, genre.albumCount]), [['氛围音乐', 2], ['器乐', 1]]);
  assert.deepEqual(shelf.albums.map((item) => item.id), ['demo-sun', 'demo-night', 'demo-mountain']);
  assert.ok(shelf.albums.every((item) => item.tracks.length === 0 && item.coverUrl?.startsWith('/demo-covers/')));
  assert.ok([...shelf.songs.values()].every((song) => !song.track.browserPlayable && !song.track.audioUrl));
});
