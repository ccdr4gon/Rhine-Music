import test from 'node:test';
import assert from 'node:assert/strict';
import { playlistShelf, playlistSongs, playlistQueue, introductionFits } from '../src/local_music/data/playlists.ts';
import { demoLibrary } from '../src/local_music/data/demo-library.ts';
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

test('the demonstration is two playlists of cover-only songs: nothing to play', () => {
  const shelf = playlistShelf(demoLibrary, true);
  assert.deepEqual(shelf.genres.map((genre) => [genre.name, genre.albumCount]), [['氛围音乐', 2], ['器乐', 1]]);
  assert.deepEqual(shelf.albums.map((item) => item.id), ['demo-sun', 'demo-night', 'demo-mountain']);
  assert.ok(shelf.albums.every((item) => item.tracks.length === 0 && item.coverUrl?.startsWith('/demo-covers/')));
  assert.ok([...shelf.songs.values()].every((song) => !song.track.browserPlayable && !song.track.audioUrl));
});
