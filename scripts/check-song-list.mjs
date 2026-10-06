import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  albumSongModel, queueSongModel, playlistSongModel, songSceneMarkup, songRowsMarkup, rovingIndex, revealScrollTop,
  songPaneType, selectedBlockHeight, songSceneLayout, songLayoutStyle, projectSheet, SONG_BLOCK_ROWS, CARD_REACH, PANE,
} from '../src/song-list.ts';
import { songCardRect, isPortraitViewport } from '../src/viewport-layout.ts';

const css = readFileSync(new URL('../src/song-scene.css', import.meta.url), 'utf8');
const time = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const track = (id, extra = {}) => ({
  id, albumId: 'album', title: `Title ${id}`, artist: 'Artist', duration: 245, format: 'FLAC',
  browserPlayable: true, audioUrl: '', relativePath: '', ...extra,
});
const album = (tracks, extra = {}) => ({
  id: 'album', title: 'Album', artist: 'Album Artist', genreId: 'g', rawGenres: [], folder: '',
  tracks, producers: [], offline: false, ...extra,
});
const albumModel = (value, options = {}) => albumSongModel(value, { number: 12, demo: false, time, ...options });
const song = (id, extra = {}) => ({ id: String(id), title: `Song ${id}`, artist: `Singer ${id}`, album: `Record ${id}`, albumId: 'r', duration: 200 + id, ...extra });
const keyOf = item => `netease-track:${item.id}`;
function queueModel(tracks, options = {}) {
  // The shelf holds one box per song: a repeated song has one index.
  const index = new Map();
  for (const item of tracks) if (!index.has(keyOf(item))) index.set(keyOf(item), index.size);
  return queueSongModel(tracks, { stamp: 's1', truncated: false, keyOf, indexOf: key => index.get(key) ?? -1, time, ...options });
}
const count = (text, pattern) => (text.match(pattern) || []).length;

test('album rows: numbers, format and time, play target, offline', () => {
  const model = albumModel(album([
    track('a', { trackNumber: 3 }), track('b'), track('c', { format: 'DSF', browserPlayable: false, duration: 61 }),
  ], { year: 2019 }));
  assert.equal(model.kind, 'album');
  assert.deepEqual(model.rows.map(row => row.number), ['03', '02', '03'], 'the tag number, else the position');
  assert.deepEqual(model.rows.map(row => row.meta), ['FLAC · 4:05', 'FLAC · 4:05', 'DSF ↗ · 1:01']);
  assert.deepEqual(model.rows.map(row => [row.key, row.track, row.select]), [['a', 'a', undefined], ['b', 'b', undefined], ['c', 'c', undefined]]);
  assert.ok(model.rows.every(row => !row.disabled && row.group === undefined), 'a single disc has no headings');
  // The tab: ALBUM and the album's number in the library (the shelf's ALBUM 012), out of how many.
  assert.deepEqual(model.tab, { label: 'ALBUM', number: 12, total: undefined, digits: 3, name: '专辑 12' });
  assert.deepEqual(albumModel(album([track('a')]), { total: 40 }).tab, { label: 'ALBUM', number: 12, total: 40, digits: 3, name: '专辑 12 / 40' });
  assert.equal(model.subtitle, 'Album Artist · 2019', 'artist · year');
  assert.equal(albumModel(album([track('a')])).subtitle, 'Album Artist', 'no year, no dot');
  // Bottom left: the shelf column the album stands in; the album's artist when none is given.
  assert.deepEqual([model.title, model.label, model.listLabel], ['Album', 'Album Artist', 'Album 曲目']);
  assert.equal(albumModel(album([track('a')]), { column: 'Ambient' }).label, 'Ambient');
  assert.deepEqual([model.count, model.countNote], ['共 3 首', '9:11'], 'the tag and, quietly under it, the album\'s length');
  assert.deepEqual([albumModel(album([track('a')])).count, albumModel(album([track('a')])).countNote], ['共 1 首', '4:05']);
  assert.equal(model.empty, undefined);
  assert.match(model.note, /兼容的播放内核/);
  const offline = albumModel(album([track('a'), track('b')], { offline: true }));
  assert.ok(offline.rows.every(row => row.disabled));
  assert.match(offline.note, /离线/);
  assert.match(songRowsMarkup(offline), /data-track="a" tabindex="-1" disabled>/);
});

test('album rows: disc headings only for several discs', () => {
  const tracks = [track('a', { discNumber: 1 }), track('b', { discNumber: 1 }), track('c', { discNumber: 2 }), track('d', { discNumber: 2 })];
  const model = albumModel(album(tracks));
  assert.deepEqual(model.rows.map(row => row.group), ['DISC 01', 'DISC 01', 'DISC 02', 'DISC 02']);
  const markup = songRowsMarkup(model);
  assert.equal(count(markup, /class="song-group"/g), 2, 'one heading per disc');
  assert.ok(markup.indexOf('DISC 02') > markup.indexOf('data-track="b"') && markup.indexOf('DISC 02') < markup.indexOf('data-track="c"'));
  assert.equal(albumModel(album([track('a'), track('b')], { discCount: 2 })).rows[1].group, 'DISC 01', 'discCount alone makes it a set');
  assert.equal(count(songRowsMarkup(albumModel(album([track('a', { discNumber: 1 }), track('b')]))), /song-group/g), 0);
});

test('an album without tracks explains itself', () => {
  const demo = albumModel(album([]), { demo: true });
  assert.equal(demo.empty, '这是一张封面演示卡片，扫描本地音乐库后这里会显示真实曲目。');
  assert.equal(albumModel(album([])).empty, '这个专辑还没有可播放曲目。');
  assert.deepEqual([demo.count, demo.countNote], ['共 0 首', undefined]);
  assert.equal(songRowsMarkup(demo), `<p class="song-empty">${demo.empty}</p>`);
  assert.equal(songRowsMarkup({ rows: [] }), '');
});

test('an album id follows everything its rows show', () => {
  const base = () => album([track('a'), track('b')]);
  const id = albumModel(base()).id;
  assert.equal(albumModel(base()).id, id, 'the same album keeps its rows');
  assert.equal(albumModel(base(), { number: 40, total: 90, column: 'x' }).id, id, 'the tab and the column are not part of the rows');
  for (const change of [
    value => { value.tracks[1].title = 'Renamed'; }, value => { value.tracks[1].artist = 'Someone'; },
    value => { value.tracks[1].duration = 9; }, value => { value.tracks[1].trackNumber = 7; },
    value => { value.tracks[1].format = 'MP3'; }, value => { value.offline = true; },
    value => { value.tracks.pop(); }, value => { value.tracks[1].discNumber = 2; }, value => { value.id = 'other'; },
  ]) {
    const changed = base();
    change(changed);
    assert.notEqual(albumModel(changed).id, id, String(change));
  }
});

test('queue rows: one per song in order, positions, durations, boxes', () => {
  const tracks = [song(1), song(2, { duration: undefined }), song(3, { artist: '' }), ...Array.from({ length: 1000 }, (_, i) => song(10 + i))];
  const model = queueModel(tracks, { selected: tracks[2], note: 'note' });
  assert.equal(model.kind, 'queue');
  assert.equal(model.rows.length, 1003);
  assert.deepEqual(model.rows.slice(0, 3).map(row => row.number), ['001', '002', '003']);
  assert.equal(model.rows[1002].number, '1003');
  assert.deepEqual(model.rows.slice(0, 3).map(row => row.meta), ['3:21', '', '3:23'], 'no time when the length is unknown');
  assert.deepEqual(model.rows.slice(0, 3).map(row => [row.key, row.select, row.disabled, row.track]),
    [['netease-track:1', 0, false, undefined], ['netease-track:2', 1, false, undefined], ['netease-track:3', 2, false, undefined]]);
  assert.equal(model.rows[2].artist, '歌手未提供');
  // NetEase's queue as the one column: the QUEUE tab, without a number.
  assert.deepEqual(model.tab, { label: 'QUEUE', digits: 2, name: '播放队列' });
  assert.deepEqual([model.title, model.subtitle], ['Song 3', '歌手未提供 · Record 3']);
  assert.deepEqual([model.label, model.listLabel, model.count, model.countNote, model.note], ['播放队列', '播放队列', '共 1003 首', undefined, 'note']);
  assert.deepEqual([queueModel(tracks, { truncated: true }).count, queueModel(tracks, { truncated: true }).countNote], ['共 1003 首', '前 3000 首']);
  assert.equal(queueModel([song(1)]).count, '共 1 首');
  const none = queueModel(tracks);
  assert.deepEqual([none.tab.label, none.title, none.subtitle], ['QUEUE', '播放队列', '']);
  assert.equal(queueModel(tracks, { column: { number: 3, total: 7 } }).tab.number, undefined, 'the lone queue has no column number');
  assert.match(queueModel([]).empty, /空/);
  assert.match(songRowsMarkup(model), /data-row="1" data-select="1" tabindex="-1"><span class="song-row-number">002</);
});

test('queue rows: a song without a box is disabled; a song queued twice keeps both rows', () => {
  const tracks = [song(1), song(2), song(1), song(3)];
  const twice = queueModel(tracks, { selected: tracks[2] });
  assert.deepEqual(twice.rows.map(row => row.key), ['netease-track:1', 'netease-track:2', 'netease-track:1', 'netease-track:3']);
  assert.deepEqual(twice.rows.map(row => row.select), [0, 1, 0, 2], 'both rows select the one box');
  assert.deepEqual([twice.title, twice.subtitle], ['Song 1', 'Singer 1 · Record 1'], 'a repeated song is selected as itself');
  assert.equal(count(songRowsMarkup(twice), /<button /g), 4);
  const missing = queueSongModel(tracks, { stamp: 's', truncated: false, keyOf, indexOf: key => (key === 'netease-track:2' ? -1 : 5), time });
  assert.deepEqual(missing.rows.map(row => [row.select, row.disabled]), [[5, false], [undefined, true], [5, false], [5, false]]);
  const markup = songRowsMarkup(missing);
  assert.equal(count(markup, / disabled>/g), 1);
  assert.equal(count(markup, /data-select=/g), 3, 'a disabled row selects nothing');
});

test('a queue id follows the stamp, the length and the boxes, not the selection', () => {
  const tracks = [song(1), song(2), song(3)];
  const id = queueModel(tracks).id;
  assert.ok(id.includes('s1') && id.includes(':3:'));
  assert.equal(queueModel(tracks, { selected: tracks[1] }).id, id, 'moving along the queue keeps the rows');
  assert.equal(queueModel(tracks, { selected: tracks[2], note: 'other' }).id, id);
  assert.notEqual(queueModel(tracks, { stamp: 's2' }).id, id);
  assert.notEqual(queueModel(tracks.slice(0, 2)).id, id);
  assert.notEqual(queueSongModel(tracks, { stamp: 's1', truncated: false, keyOf, indexOf: () => -1, time }).id, id, 'the shelf lost its boxes');
  assert.notEqual(queueSongModel(tracks, { stamp: 's1', truncated: false, keyOf, indexOf: key => (key.endsWith('1') ? 1 : key.endsWith('2') ? 0 : 2), time }).id, id, 'the boxes moved');
});

// A local folder playlist (2026-10-06): one row per song, each selecting its case (moving never plays).
const local = (id, extra = {}) => ({ id: `track-${id}`, title: `Song ${id}`, artist: `Singer ${id}`, album: `Record ${id}`, format: 'FLAC', browserPlayable: true, duration: 245, offline: false, ...extra });
const playlistModel = (songs, options = {}) => playlistSongModel(songs, {
  name: 'Alpha', indexOf: id => songs.findIndex(song => song.id === id) + 10, time, column: { number: 3, total: 7 }, ...options,
});

test('playlist rows: the folder playlist in order, its songs\' cases, format and time', () => {
  const songs = [local(1), local(2, { artist: '', album: undefined }), local(3, { format: 'DSF', browserPlayable: false, duration: 61 })];
  const model = playlistModel(songs, { selected: 'track-2' });
  assert.equal(model.kind, 'playlist');
  assert.deepEqual(model.rows.map(row => [row.key, row.number, row.select, row.disabled, row.track]),
    [['track-1', '001', 10, false, undefined], ['track-2', '002', 11, false, undefined], ['track-3', '003', 12, false, undefined]]);
  assert.deepEqual(model.rows.map(row => row.meta), ['FLAC · 4:05', 'FLAC · 4:05', 'DSF ↗ · 1:01']);
  assert.equal(model.rows[1].artist, '歌手未提供');
  // The tab: PLAYLIST and the column's number, as NetEase's playlist columns have it.
  assert.deepEqual(model.tab, { label: 'PLAYLIST', number: 3, total: 7, digits: 2, name: '歌单 3 / 7' });
  assert.deepEqual([model.title, model.subtitle], ['Song 2', '歌手未提供']);
  assert.deepEqual([playlistModel(songs, { selected: 'track-1' }).title, playlistModel(songs, { selected: 'track-1' }).subtitle], ['Song 1', 'Singer 1 · Record 1']);
  assert.deepEqual([playlistModel(songs).title, playlistModel(songs).subtitle], ['Alpha', ''], 'no selection: the playlist\'s name');
  assert.deepEqual([model.label, model.listLabel, model.count, model.countNote], ['Alpha', 'Alpha', '共 3 首', '9:11']);
  assert.match(model.note, /兼容的播放内核/);
  assert.match(songRowsMarkup(model), /data-row="1" data-select="11" tabindex="-1"><span class="song-row-number">002</);
  assert.doesNotMatch(songRowsMarkup(model), /data-track=/, 'a row selects; it does not play');
  const offline = playlistModel([local(1, { offline: true })]);
  assert.match(offline.note, /离线/);
  assert.equal(offline.rows[0].disabled, false, 'an offline song can still be selected');
  const missing = playlistSongModel([local(1)], { name: 'x', indexOf: () => -1, time });
  assert.deepEqual([missing.rows[0].select, missing.rows[0].disabled], [undefined, true]);
  const demo = playlistModel([local(1, { format: '演示', browserPlayable: false, duration: 0 })], { demo: true });
  assert.deepEqual([demo.rows[0].meta, demo.countNote, demo.note], ['演示', undefined, undefined], 'demonstration songs: no lengths, nothing to explain');
  assert.equal(playlistModel([]).empty, '这个歌单是空的。');
  // The rows are rebuilt when what they show changes, not when the selection moves.
  assert.equal(playlistModel(songs, { selected: 'track-3' }).id, model.id);
  assert.notEqual(playlistModel(songs.slice(0, 2)).id, model.id);
  assert.notEqual(playlistModel([local(1), local(2, { title: 'Renamed' }), songs[2]]).id, playlistModel(songs).id);
  const hostile = playlistSongModel([local('<img onerror=x>', { title: '<img onerror=x>', artist: 'x" onmouseover="y' })], { name: '<img>', indexOf: () => 0, time });
  assert.ok(!songRowsMarkup(hostile).includes('<img') && !songRowsMarkup(hostile).includes('" onmouseover="'));
});

test('titles are text: markup in any field never reaches the page', () => {
  const evil = '<img onerror=x>', quote = 'x" onmouseover="y';
  const hostileAlbum = albumModel(album([
    track(quote, { title: evil, artist: evil, format: evil, discNumber: 1 }), track(`${evil}2`, { title: quote, artist: quote, discNumber: 2 }),
  ], { title: evil, artist: evil }));
  const hostileQueue = queueSongModel([song(1, { id: quote, title: evil, artist: evil, album: evil }), song(2, { title: quote })],
    { stamp: evil, truncated: true, keyOf: item => `${evil}${item.id}`, indexOf: () => 0, time: () => evil, note: evil });
  const custom = songRowsMarkup({ rows: [{ key: evil, number: evil, title: evil, artist: evil, meta: evil, track: quote, group: evil }, { key: 'k', number: '2', title: quote, artist: '', meta: '', select: 1 }], empty: evil });
  for (const markup of [songRowsMarkup(hostileAlbum), songRowsMarkup(hostileQueue), custom, songRowsMarkup({ rows: [], empty: evil }), songSceneMarkup()]) {
    assert.ok(!markup.includes('<img'), 'no element from a title');
    assert.ok(!markup.includes('" onmouseover="'), 'no attribute from a title');
  }
  assert.ok(songRowsMarkup(hostileAlbum).includes('&lt;img onerror=x&gt;'));
  assert.ok(custom.includes('data-track="x&quot; onmouseover=&quot;y"'));
  // The only elements are the module's own.
  assert.deepEqual([...new Set(custom.match(/<[a-z]+/g))].sort(), ['<button', '<div', '<small', '<span', '<strong']);
});

test('rows come in blocks of exactly known size', () => {
  const tracks = Array.from({ length: 3000 }, (_, i) => song(i));
  const markup = songRowsMarkup(queueModel(tracks));
  const blocks = [...markup.matchAll(/<div class="song-block" style="--rows:(\d+);--groups:(\d+)">/g)];
  assert.equal(blocks.length, Math.ceil(3000 / SONG_BLOCK_ROWS));
  assert.ok(blocks.every(block => Number(block[1]) === SONG_BLOCK_ROWS && block[2] === '0'));
  assert.equal(count(markup, /<button type="button" class="song-row"/g), 3000);
  assert.deepEqual([...markup.matchAll(/data-row="(\d+)"/g)].map(match => Number(match[1])), tracks.map((_, i) => i), 'rows are numbered in order');
  const discs = Array.from({ length: 90 }, (_, i) => track(`t${i}`, { discNumber: 1 + Math.floor(i / 30) }));
  const sized = [...songRowsMarkup(albumModel(album(discs))).matchAll(/--rows:(\d+);--groups:(\d+)/g)].map(block => [Number(block[1]), Number(block[2])]);
  assert.deepEqual(sized, [[40, 2], [40, 1], [10, 0]], 'headings are counted in the block they open');
});

test('the scene markup carries the hooks the app relies on', () => {
  const markup = songSceneMarkup();
  assert.match(markup, /<button class="music-back" data-action="back">.*<span id="song-back-label">返回专辑架<\/span>.*<kbd>ESC<\/kbd><\/button>/);
  assert.match(markup, /<button id="song-prev" data-action="prev" aria-label="[^"]+">/);
  assert.match(markup, /<button id="song-next" data-action="next" aria-label="[^"]+">/);
  assert.match(markup, /<div id="song-glass" class="song-glass">/);
  assert.match(markup, /<div id="song-list" class="song-list"/);
  const ids = [...markup.matchAll(/ id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  // The two fade targets are the section's only children, so nothing is left unfaded.
  const top = [];
  let depth = 0;
  for (const [, close, attributes] of markup.matchAll(/<(\/?)[a-z0-9]+([^>]*)>/g)) {
    if (close) depth--;
    else if (depth++ === 0) top.push(/class="([^"]+)"/.exec(attributes)?.[1]);
  }
  assert.equal(depth, 0, 'every element is closed');
  assert.deepEqual(top, ['song-chrome', 'song-glass']);
  // Everything about the selection is on the pane (the design's direction B): the tab with its
  // number reel, the count, the selected song with its steps, the list and the note.
  const glass = markup.slice(markup.indexOf('<div id="song-glass"'));
  for (const id of ['song-tab-number', 'song-tab-total', 'song-count', 'song-count-note', 'song-title', 'song-subtitle', 'song-prev', 'song-next', 'song-list', 'song-note'])
    assert.ok(glass.includes(` id="${id}"`), `${id} is on the pane`);
  assert.ok(!/song-float|song-plate|song-cross|song-overline/.test(markup), 'no plate, crosshair or strip in front of the pane');
  // The tab's reel is not readable text: the tab says what it is in words.
  assert.match(markup, /<span id="song-tab-text" class="song-tab-text"><\/span><span class="song-tab-label" aria-hidden="true">/);
  assert.match(markup, /<span class="song-tab-figure" aria-hidden="true">/);
  const classes = new Set([...`${markup}${songRowsMarkup(albumModel(album([track('a', { discNumber: 1 }), track('b', { discNumber: 2 })])))}${songRowsMarkup({ rows: [], empty: 'x' })}`
    .matchAll(/class="([^"]+)"/g)].flatMap(match => match[1].split(' ')));
  for (const name of classes) assert.ok(css.includes(`.${name}`), `${name} is styled`);
});

test('roving focus skips disabled rows and stops at the ends', () => {
  const all = () => true;
  assert.equal(rovingIndex('ArrowDown', 3, 10, 5, all), 4);
  assert.equal(rovingIndex('ArrowUp', 3, 10, 5, all), 2);
  assert.equal(rovingIndex('ArrowDown', 9, 10, 5, all), 9, 'the last row keeps the focus');
  assert.equal(rovingIndex('ArrowUp', 0, 10, 5, all), 0);
  assert.equal(rovingIndex('PageDown', 3, 10, 5, all), 8);
  assert.equal(rovingIndex('PageDown', 7, 10, 5, all), 9);
  assert.equal(rovingIndex('PageUp', 3, 10, 5, all), 0);
  assert.equal(rovingIndex('PageDown', 3, 10, 0, all), 4, 'a page is at least one row');
  assert.equal(rovingIndex('Home', 7, 10, 5, all), 0);
  assert.equal(rovingIndex('End', 2, 10, 5, all), 9);
  assert.equal(rovingIndex('ArrowDown', -1, 10, 5, all), 0, 'from the list itself');
  assert.equal(rovingIndex('ArrowUp', -1, 10, 5, all), 9);
  for (const key of ['Enter', ' ', 'ArrowLeft', 'ArrowRight', 'Tab', 'a', 'Escape']) assert.equal(rovingIndex(key, 3, 10, 5, all), undefined, key);
  const odd = index => index % 2 === 1;
  assert.equal(rovingIndex('ArrowDown', 3, 10, 5, odd), 5);
  assert.equal(rovingIndex('ArrowUp', 3, 10, 5, odd), 1);
  assert.equal(rovingIndex('ArrowUp', 1, 10, 5, odd), 1, 'nothing enabled above');
  assert.equal(rovingIndex('Home', 5, 10, 5, odd), 1);
  assert.equal(rovingIndex('End', 5, 10, 5, index => index < 4), 3);
  assert.equal(rovingIndex('PageDown', 1, 10, 6, index => index < 5), 4, 'the farthest enabled row short of the target');
  assert.equal(rovingIndex('ArrowDown', -1, 10, 5, () => false), -1);
  assert.equal(rovingIndex('End', -1, 0, 5, all), -1, 'an empty list');
  assert.equal(rovingIndex('ArrowDown', 2, 10, 5), 3, 'rows are enabled unless told otherwise');
});

test('reveal: comfortable rows stay, near rows move least, far rows land in the upper half', () => {
  const row = top => ({ top, height: 50 });
  const view = 500, content = 150000;
  assert.equal(revealScrollTop(row(1200), 1000, view, content), undefined, 'in the middle');
  assert.equal(revealScrollTop(row(1075), 1000, view, content), undefined, 'exactly at the upper margin');
  assert.equal(revealScrollTop(row(1060), 1000, view, content), 985, 'too close to the top: the least movement');
  assert.equal(revealScrollTop(row(1400), 1000, view, content), 1025, 'too close to the bottom');
  assert.equal(revealScrollTop(row(1520), 1000, view, content), 1145, 'just below the view');
  assert.equal(revealScrollTop(row(900), 1000, view, content), 825, 'just above the view');
  assert.equal(revealScrollTop(row(100000), 1000, view, content), 100000 - 180, 'far away: 40 % down the view');
  assert.equal(revealScrollTop(row(0), 0, view, content), undefined, 'the first row cannot have a margin above');
  assert.equal(revealScrollTop(row(20), 400, view, content), 0);
  assert.equal(revealScrollTop(row(content - 50), content - view, view, content), undefined, 'nor the last one below');
  assert.equal(revealScrollTop(row(content - 50), 0, view, content), content - view);
  assert.equal(revealScrollTop(row(100), 0, view, 300), undefined, 'a list that does not scroll');
  assert.equal(revealScrollTop(row(100), 0, 0, content), undefined, 'a hidden list has no view');
  assert.equal(revealScrollTop({ top: 2000, height: 800 }, 0, view, content), 2120, 'a row taller than the view is centred');
  for (const top of [0, 37, 4999, 77777, content - 50]) {
    const target = revealScrollTop(row(top), 60000, view, content);
    const settled = target ?? 60000;
    assert.ok(settled >= 0 && settled <= content - view);
    assert.ok(top >= settled && top + 50 <= settled + view, `row at ${top} is inside the view`);
    assert.equal(revealScrollTop(row(top), settled, view, content), undefined, 'revealing again changes nothing');
  }
});

test('the selected title: one size, at most three lines (two stacked), never cut without its tooltip', () => {
  // The design's type at 1440 x 900 (9 px units): a 22 px title, an 11 px second line and note.
  const type = songPaneType(9);
  assert.ok(Math.abs(type.title - 22) < 0.01 && Math.abs(type.subtitle - 11) < 0.01 && Math.abs(type.note - 11) < 0.01, JSON.stringify(type));
  const small = songPaneType(7.2);
  assert.ok(small.title >= 16 && small.subtitle >= 11 && small.note >= 10, 'small windows keep readable floors');
  // 8 px under the rule, three 26.4 px lines, the 11 px line, the steps 20 px under it.
  assert.ok(Math.abs(selectedBlockHeight(9) - (8 + 3 * 26.4 + 10 + 15.4 + 20 + 26)) < 0.05, String(selectedBlockHeight(9)));
  const rule = selector => {
    const start = css.indexOf(`\n${selector} {`);
    assert.ok(start >= 0, selector);
    return css.slice(start, css.indexOf('}', start));
  };
  assert.match(rule('.song-title-line'), /-webkit-line-clamp: 3;/);
  assert.match(rule('.song-title-line'), /overflow-wrap: anywhere;/);
  assert.match(rule('.music-song[data-panel="stacked"] .song-title-line'), /-webkit-line-clamp: 2;/);
  // The title swaps inside its mask: the block does not move.
  assert.match(rule('.song-title'), /overflow: hidden;/);
  assert.match(rule('.song-title'), /font-size: max\(16px, calc\(var\(--songs-u\) \* 2\.4444\)\);/);
  assert.match(rule('.song-subtitle'), /text-overflow: ellipsis;/);
  // The whole title is the tooltip (SongListView.setTitle).
  const source = readFileSync(new URL('../src/song-list.ts', import.meta.url), 'utf8');
  assert.match(source, /this\.title\.title = title;/);
});

const SIZES = [
  [1920, 1080], [1440, 900], [2560, 1080], [3440, 1440], [1280, 720], [1366, 768], [1600, 1000], [1500, 1000],
  [1400, 1050], [1100, 1000], [1060, 1000], [1000, 700], [1024, 600], [900, 1400], [1000, 1000], [700, 1000], [430, 900], [390, 844],
  // Short and small windows: half a 1080p screen, and down to the smallest window the client allows.
  [1920, 500], [1280, 540], [800, 600], [640, 480],
];
/** The layout's allowance for the note, in ems: the longest one the app writes is 53 full-width characters. */
const NOTE_EMS = 56;
function placed(width, height) {
  const card = songCardRect(width, height, 12, 4.45, 3.35);
  const portrait = isPortraitViewport(width, height);
  const layout = songSceneLayout(width, height, card, portrait);
  const { glass } = layout;
  const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, y]) => projectSheet(glass, (x * glass.width) / 2, (y * glass.height) / 2));
  return {
    card, portrait, layout, corners,
    // The drawn card reaches past the rectangle the app hands over.
    cardRight: card.x + card.width / 2 + CARD_REACH.right * card.width,
    cardTop: card.y - card.height / 2 - CARD_REACH.top * card.height,
    cardBottom: card.y + card.height / 2 + CARD_REACH.bottom * card.height,
    left: Math.min(...corners.map(corner => corner.x)), right: Math.max(...corners.map(corner => corner.x)),
    top: Math.min(...corners.map(corner => corner.y)), bottom: Math.max(...corners.map(corner => corner.y)),
    // The pane's rim is drawn inside it (song-scene.css: 7 px in at 1440 x 900): nothing reaches outside.
    rim: 0,
  };
}

test('the pane keeps clear of the card, the header and the bottom line at every size', () => {
  for (const [width, height] of SIZES) {
    const at = `${width}x${height}`;
    const { card, portrait, layout, cardRight, cardTop, cardBottom, left, right, top, bottom, rim } = placed(width, height);
    const { glass, unit } = layout;
    assert.ok(left - rim >= 0 && right + rim <= width, `${at}: inside the picture`);
    assert.ok(bottom <= height - Math.max(0.042 * height, 38) + 0.01, `${at}: above the bottom line`);
    assert.ok(glass.width >= 24 * unit && glass.height >= 20 * unit, `${at}: room for a list`);
    assert.ok(unit >= 7.2 && unit <= 13.5);
    // Rows are painted only while their box, grown by 1.5 viewport widths, stays short of the eye's plane.
    assert.ok((glass.width / 2 + 1.5 * width) * Math.sin(glass.tilt * Math.PI / 180) < glass.perspective, `${at}: rows stay paintable`);
    // The head (tab and count) and, wide, the tallest selected song fit in the pane above its bottom padding.
    const inside = glass.height - (PANE.start + PANE.head + PANE.end) * unit;
    assert.ok(inside > 0, `${at}: the head leaves room in the pane`);
    if (portrait) {
      assert.equal(layout.mode, 'stacked');
      assert.ok(top - rim >= cardBottom + 2.4 * unit - 0.5, `${at}: the pane is under the card`);
      assert.equal(layout.rail.shown, false);
    } else {
      assert.ok(top >= Math.max(0.091 * height, 82) - 0.01, `${at}: below the header`);
      assert.ok(left - rim >= cardRight + 2.6 * unit - 0.01, `${at}: the pane is right of the card`);
      if (layout.mode === 'wide') assert.ok(left >= cardRight + 8.9 * unit - 0.01, `${at}: wide, it leaves the card the design's room`);
      assert.ok(layout.rail.shown && layout.rail.x > card.x - card.width / 2 && layout.rail.x < card.x, `${at}: the line passes behind the card`);
      assert.deepEqual([layout.rail.top, layout.rail.bottom], [cardTop, cardBottom], `${at}: the line stops at the drawn card's edges`);
      assert.ok(cardTop < card.y - card.height / 2 && cardBottom > card.y + card.height / 2);
      // The 9 x 6 marker sits between the header's row and the card.
      if (layout.rail.markerShown) assert.ok(layout.rail.marker + 3 <= layout.rail.top && layout.rail.marker - 3 >= 82, `${at}: the marker sits between header and card`);
    }
    if (layout.mode === 'wide') {
      const listLeft = projectSheet(glass, glass.side - glass.width / 2, 0).x;
      const column = glass.side - (PANE.start + PANE.gap) * unit;
      assert.ok(left < listLeft && listLeft < right, `${at}: the selected song, then the list, from left to right`);
      assert.ok(column >= 20 * unit, `${at}: the selected song has a column of its own`);
      assert.ok(right - listLeft >= 40 * unit, `${at}: the list is wide enough to read`);
      assert.ok(selectedBlockHeight(unit) <= inside, `${at}: the tallest selected song fits beside the list`);
      assert.ok(['side', 'under'].includes(layout.note), `${at}: the note has a place`);
      if (height >= 700) assert.equal(layout.note, 'side', `${at}: a window of ordinary height keeps the note beside the list`);
      if (layout.note === 'side') {
        // Bottom-aligned in the left column (song-scene.css), under the tallest selected song: lines
        // of 1.7 at max(10px, 1.2222u) in the column left of the list.
        const font = songPaneType(unit).note;
        const lines = Math.ceil(NOTE_EMS / Math.floor(column / font));
        assert.ok(inside - 2 >= selectedBlockHeight(unit) + 2 * unit + lines * 1.7 * font, `${at}: the longest note starts under the selected song`);
        assert.ok(lines <= 6, `${at}: and stays a few lines`);
      }
    } else {
      assert.equal(layout.note, 'under', `${at}: stacked, the note goes under the list`);
    }
  }
});

test('the note leaves the side column when a wide window is too short for it', () => {
  for (const [width, height] of [[1920, 1080], [1440, 900], [1280, 720], [1366, 768], [2560, 1080], [3440, 1440], [1600, 1000], [1500, 1000], [1920, 500], [1280, 540]]) {
    const { layout } = placed(width, height);
    assert.deepEqual([layout.mode, layout.note], ['wide', 'side'], `${width}x${height}`);
  }
  // Without the old plate the side column is roomy: only the shortest windows at the compact
  // boundary leave the note too little height beside the list.
  for (const [width, height] of [[1100, 480], [1100, 488]]) {
    const { layout } = placed(width, height);
    assert.deepEqual([layout.mode, layout.note], ['wide', 'under'], `${width}x${height}`);
  }
  // Growing a window never sends the note back under the list.
  for (const width of [1100, 1280, 1920, 2560]) {
    let side = false;
    for (let height = 480; height <= 1200; height += 4) {
      const { layout } = placed(width, height);
      if (layout.mode !== 'wide') continue;
      if (side) assert.equal(layout.note, 'side', `${width}x${height}`);
      side ||= layout.note === 'side';
    }
    assert.ok(side, `${width}: tall enough windows use the side column`);
  }
});

test('1440 x 900 is the design\'s pane; other sizes follow it', () => {
  // The design (direction B, song scene): left 688, top 108, 712 x 728, perspective(1660px) rotateY(-18deg),
  // so its far edge is at x 726 (y 131 to 813) and its near edge at x 1407 (y 82 to 862).
  const { layout, left, right, top, bottom, corners } = placed(1440, 900);
  const { glass } = layout;
  assert.equal(layout.mode, 'wide');
  assert.equal(glass.tilt, 18);
  const near = (value, target, tolerance, what) => assert.ok(Math.abs(value - target) <= tolerance, `${what}: ${value} against ${target}`);
  near(glass.x - glass.width / 2, 688, 0.5, 'left');
  near(glass.y - glass.height / 2, 108, 0.5, 'top');
  near(glass.width, 712, 0.5, 'width');
  near(glass.height, 728, 0.5, 'height');
  near(glass.perspective, 1660, 1, 'perspective');
  near(glass.side, 290, 0.5, 'the list starts 290 px into the pane');
  near(left, 726.4, 0.5, 'far edge');
  near(right, 1406.6, 0.5, 'near edge');
  near(top, 82, 0.5, 'near top');
  near(bottom, 862, 0.5, 'near bottom');
  near(corners[0].y, 130.6, 0.5, 'far top');
  // The line at x 359 (whole pixels), cut behind the card (the design: 318 to 594), its marker centred at 254.
  assert.equal(songLayoutStyle(layout)['--songs-rail-x'], '359px');
  // (The design measured a placeholder picture; the line stops at the drawn card's edges, CARD_REACH.)
  near(layout.rail.top, 318, 4.5, 'the line ends above the card');
  near(layout.rail.bottom, 594, 4.5, 'the line starts under the card');
  near(layout.rail.marker, 254, 1, 'marker');
  // 16:9: the same proportions, against the right edge (100vw - 3.7vh) and under the header (9.1vh).
  const wide = placed(1920, 1080);
  assert.equal(wide.layout.mode, 'wide');
  assert.equal(wide.layout.glass.tilt, 18);
  near(wide.right, 1920 - 3.7 * 10.8, 0.5, '1920 x 1080 near edge');
  near(wide.top, 9.1 * 10.8, 0.5, '1920 x 1080 near top');
  near(wide.bottom, 1080 - 4.2 * 10.8, 0.5, '1920 x 1080 near bottom');
  assert.ok(placed(3840, 600).layout.glass.tilt < 18, 'a very wide, short window turns the pane less');
  for (const [width, height] of [[3440, 480], [3840, 600], [5120, 1440]]) {
    const { layout, left, right } = placed(width, height);
    assert.ok(right - left < 0.45 * width, `${width}x${height}: a very wide window keeps the pane at its right`);
    assert.equal(layout.mode, 'wide', `${width}x${height}`);
  }
  // The header's row, when it ends lower, keeps the pane under it.
  const card = songCardRect(1800, 900, 12, 4.45, 3.35);
  const under = songSceneLayout(1800, 900, card, false, 90);
  assert.ok(Math.abs(under.glass.y - (under.glass.height / 2) * (1 / (1 - Math.sin(18 * Math.PI / 180) / (2 * under.glass.perspective / under.glass.width))) - 102) < 0.5, 'near top 12 px under the row');
  for (const [width, height] of [[1440, 900], [1280, 720], [2560, 1080], [1500, 1000], [3440, 480]]) assert.equal(placed(width, height).layout.mode, 'wide', `${width}x${height}`);
  for (const [width, height] of [[1400, 1050], [1000, 700], [900, 1400]]) assert.equal(placed(width, height).layout.mode, 'stacked', `${width}x${height}`);
  assert.ok(placed(1000, 700).layout.glass.tilt < 18 && placed(900, 1400).layout.glass.tilt < placed(1000, 700).layout.glass.tilt, 'narrow panes turn less');
});

test('the stylesheet reads every variable the layout writes, and keeps the list cheap and clickable', () => {
  const style = songLayoutStyle(placed(1440, 900).layout);
  const root = css.slice(css.indexOf('.music-song {'), css.indexOf('}', css.indexOf('.music-song {')));
  for (const [name, value] of Object.entries(style)) {
    assert.match(value, /^-?\d+(\.\d+)?(px|deg)$/, name);
    assert.ok(css.includes(`var(${name})`), `${name} is read`);
    assert.ok(root.includes(`${name}:`), `${name} has a default`);
  }
  assert.equal(style['--songs-tilt'], '-18deg');
  const rule = selector => {
    const start = css.indexOf(`\n${selector} {`);
    assert.ok(start >= 0, selector);
    return css.slice(start, css.indexOf('}', start));
  };
  // The canvas under the section keeps its clicks; the section is never faded or flattened.
  assert.match(root, /pointer-events: none;/);
  assert.ok(!/opacity|filter|transform|mask|clip-path/.test(root), 'nothing on the section cuts the sheet off from the canvas');
  assert.match(rule('.song-glass'), /backdrop-filter: /);
  assert.match(rule('.song-glass'), /pointer-events: auto;/);
  assert.match(rule('.song-glass'), /transform: perspective\(var\(--songs-perspective\)\) rotateY\(var\(--songs-tilt\)\);/);
  assert.ok(!css.includes('preserve-3d'), 'scrolling content is never part of a 3D context');
  for (const selector of ['.song-block', '.song-row']) {
    assert.match(rule(selector), /content-visibility: auto;/, selector);
    assert.match(rule(selector), /contain-intrinsic-size: auto /, selector);
  }
  assert.match(rule('.song-row'), /height: var\(--songs-row\);/);
  assert.match(rule('.song-group'), /height: var\(--songs-group\);/);
  assert.match(rule('.song-list'), /overflow-y: auto;/);
});

test('the stylesheet cuts a crowded header, follows the note placement and stops a paused meter', () => {
  const rule = selector => {
    const start = css.indexOf(`\n${selector} {`);
    assert.ok(start >= 0, selector);
    return css.slice(start, css.indexOf('}', start));
  };
  // Stacked, the pane is narrow at small windows: the tally is capped and cut, never the tab.
  assert.match(rule('.music-song[data-panel="stacked"] .song-tally'), /max-width: 50%;/);
  assert.match(rule('.song-tally'), /min-width: 0;/);
  for (const selector of ['.song-count', '.song-count-note', '.song-subtitle']) {
    assert.match(rule(selector), /overflow: hidden;/, selector);
    assert.match(rule(selector), /text-overflow: ellipsis;/, selector);
  }
  assert.match(rule('.song-head'), /white-space: nowrap;/);
  // The note follows data-note (SongSceneLayout.note), not the panel mode; it has no bullet any more.
  assert.match(rule('.music-song[data-note="under"] .song-note'), /align-self: auto;/);
  // Under the list it starts with a 1 px rule, so a row cut by the list's bottom edge does not run into it.
  assert.match(rule('.music-song[data-note="under"] .song-note'), /border-top: 1px solid var\(--line\);/);
  assert.ok(!css.includes('.song-note::before'), 'a quiet note, without its square mark');
  const under = rule('.music-song[data-panel="wide"][data-note="under"] .song-glass');
  assert.match(under, /grid-template-rows: calc\(var\(--songs-u\) \* 12\) auto minmax\(0, 1fr\) auto;/);
  assert.match(under, /"head head"\s+"selected list"\s+"\. list"\s+"\. note";/);
  assert.match(rule('.music-song[data-panel="stacked"] .song-glass'), /"head"\s+"selected"\s+"list"\s+"note";/);
  assert.ok(!/\[data-panel="stacked"\] \.song-note/.test(css), 'no note rule is left on the panel mode');
  assert.match(rule('.song-glass'), /"head head"\s+"selected list"\s+"note list";/, 'the default is the side column, under the selected song');
  // A paused song keeps its meter and holds it still.
  assert.match(css, /\n\.music-song\[data-paused="true"\] \.song-row\.playing \.song-row-number,[^{]*\{\s*animation: none;/);
  // The design's meter: three 2 px bars of 6, 10 and 8 px in the playback colour, each on its own period.
  const meter = rule('.song-row.playing .song-row-number');
  assert.match(meter, /animation:\s+song-level 700ms ease-in-out infinite,\s+song-level-b 820ms ease-in-out 120ms infinite,\s+song-level-c 940ms ease-in-out 240ms infinite;/);
  assert.equal((meter.match(/linear-gradient\(var\(--state\), var\(--state\)\)/g) || []).length, 3);
  for (const [name, height] of [['a', 6], ['b', 10], ['c', 8]])
    assert.match(css, new RegExp(`@property --song-meter-${name} \\{\\s*syntax: "<length>";\\s*inherits: false;\\s*initial-value: ${height}px;`));
});

test('the stylesheet draws the design\'s pane: the selected band, the rule, the rail, the scrollbar', () => {
  const rule = selector => {
    const start = css.indexOf(`\n${selector} {`);
    assert.ok(start >= 0, selector);
    return css.slice(start, css.indexOf('}', start));
  };
  // The selected row: the light band and a 2 px ink bar; a pending one dashes the bar.
  assert.match(rule('.song-row.selected'), /background: var\(--hl\);/);
  assert.match(rule('.song-row::before'), /width: 2px;\s+background: var\(--ink\);/);
  assert.match(rule('.song-row.pending::before'), /repeating-linear-gradient\(180deg, var\(--ink\) 0 4px, transparent 4px 8px\)/);
  // The list has a rule over it and no sheet of its own, so the pane's dots show through.
  assert.match(rule('.song-list'), /border-top: 1px solid var\(--rule\);/);
  assert.ok(!/background|box-shadow/.test(rule('.song-list')), 'no sheet under the rows');
  assert.match(rule('.song-glass::after'), /radial-gradient\(circle, var\(--line\) 1px, transparent 1\.6px\)/);
  assert.match(rule('.song-glass::after'), /z-index: -1;/);
  assert.match(rule('.song-glass::before'), /border: 1px solid var\(--glass-rim\);/);
  assert.match(rule('.song-glass'), /border: 1px solid var\(--glass-edge\);/);
  // Chromium ignores ::-webkit-scrollbar while the standard properties are set.
  assert.ok(!/scrollbar-width|scrollbar-color/.test(css), 'the 2 px bar is drawn by ::-webkit-scrollbar');
  assert.match(rule('.song-list::-webkit-scrollbar-thumb'), /background: var\(--rule\);/);
  // The rail: 1 px in the rule colour; its marker 9 x 6 in ink.
  assert.match(rule('.song-rail'), /width: 1px;\s+background: var\(--rule\);/);
  assert.match(rule('.song-marker'), /width: 9px;\s+height: 6px;\s+background: var\(--ink\);/);
  // The column's name, bottom left, as in the details.
  assert.match(rule('.song-caption'), /bottom: 22px;/);
  assert.ok(!/text-transform/.test(rule('.song-caption')), 'the name as it is written');
});

test('a playlist column lists itself: its name, and that it is a playlist rather than the queue', () => {
  const tracks = [song(1), song(2), song(3)];
  const plain = queueModel(tracks, { selected: tracks[1] });
  assert.deepEqual(plain.tab, { label: 'QUEUE', digits: 2, name: '播放队列' });
  assert.equal(plain.label, '播放队列');
  // The queue's own column: still the queue, named after its playlist; the tab numbers the column.
  const live = queueModel(tracks, { selected: tracks[1], lane: { name: 'Road <Trip>', live: true }, column: { number: 3, total: 7 } });
  assert.deepEqual(live.tab, { label: 'PLAYLIST', number: 3, total: 7, digits: 2, name: '歌单 3 / 7' });
  assert.deepEqual([live.label, live.listLabel], ['Road <Trip>', 'Road <Trip>']);
  // Any other column: a playlist, for browsing.
  const other = queueModel(tracks, { lane: { name: 'Road <Trip>', live: false }, column: { number: 5, total: 7 } });
  assert.deepEqual([other.tab.label, other.tab.number], ['PLAYLIST', 5]);
  assert.equal(other.title, 'Road <Trip>', 'nothing selected: the column\'s name is the title');
  assert.equal(queueModel([], { lane: { name: 'Empty', live: false } }).empty, '这个歌单是空的。');
  assert.equal(queueModel([]).empty, '播放队列是空的。');
  // A playlist cut by the reader's limits does not claim the queue's 3000.
  assert.deepEqual([queueModel(tracks, { truncated: true, lane: { name: 'Long', live: false } }).count, queueModel(tracks, { truncated: true, lane: { name: 'Long', live: false } }).countNote], ['共 3 首', '未显示全部']);
  assert.equal(queueModel(tracks, { truncated: true, lane: { name: 'Long', live: true } }).countNote, '前 3000 首');
  // The rows do not depend on which column it is.
  assert.deepEqual(other.rows, queueModel(tracks).rows);
});
