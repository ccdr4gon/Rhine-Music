import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  queueSongModel, playlistSongModel, songSceneMarkup, songRowsMarkup, rovingIndex, revealScrollTop,
  songSceneLayout, songLayoutStyle, projectSheet, SONG_BLOCK_ROWS, CARD_REACH, PANE,
  rowPressPlays, rowClickKind, ROW_DOUBLE, SongListView, SONG_METER, easeInOut, meterScale,
} from '../src/song-list.ts';
import { songCardRect, isPortraitViewport } from '../src/viewport-layout.ts';

const css = readFileSync(new URL('../src/song-scene.css', import.meta.url), 'utf8');
const time = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
// The album lists (albumSongModel) went on 2026-10-08: nothing in the app made one since the local
// shelf became folder playlists (2026-10-06). The rows' own fields they used (data-track, disc
// headings, disabled rows, hints) are still the markup's, and are checked with plain rows.
const plainRow = (key, extra = {}) => ({ key, number: '01', title: `Title ${key}`, artist: 'Artist', meta: 'FLAC · 4:05', ...extra });
// What song-scene.css sets the selected song in (moved here from song-list.ts on 2026-10-08, when
// nothing in the app read them any more; 'the selected title' ties them to the stylesheet): the
// title and its second line, and the tallest the block gets: 8 px under the list's rule, three
// title lines, the second line, the step buttons 20 px below.
const paneType = unit => ({ title: Math.max(16, 2.4444 * unit), subtitle: Math.max(11, 1.2222 * unit) });
const selectedBlockHeight = unit => {
  const type = paneType(unit), gap = 1.1111 * unit;
  return 0.8889 * unit + 3 * 1.2 * type.title + gap + 1.4 * type.subtitle + 2 * gap + Math.max(24, 2.8889 * unit);
};
const song =(id, extra = {}) => ({ id: String(id), title: `Song ${id}`, artist: `Singer ${id}`, album: `Record ${id}`, albumId: 'r', duration: 200 + id, ...extra });
const keyOf = item => `netease-track:${item.id}`;
function queueModel(tracks, options = {}) {
  // The shelf holds one box per song: a repeated song has one index.
  const index = new Map();
  for (const item of tracks) if (!index.has(keyOf(item))) index.set(keyOf(item), index.size);
  return queueSongModel(tracks, { stamp: 's1', truncated: false, keyOf, indexOf: key => index.get(key) ?? -1, time, ...options });
}
const count = (text, pattern) => (text.match(pattern) || []).length;

test('the album list model is gone: nothing in the app made one (2026-10-08)', async () => {
  const list = await import('../src/song-list.ts');
  for (const name of ['albumSongModel', 'songPaneType', 'selectedBlockHeight']) assert.equal(name in list, false, name);
  const source = readFileSync(new URL('../src/song-list.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /MusicAlbum|这是一张封面演示卡片|这个专辑还没有可播放曲目/);
});

test('plain rows: a track target, a disabled row with its hint, headings where the group changes, an empty text', () => {
  // The markup's own fields, which no list model sets at present (data-track, group).
  const offline = songRowsMarkup({ rows: [plainRow('a', { track: 'a', disabled: true, hint: '目录离线' })] });
  assert.match(offline, /data-track="a" title="目录离线" tabindex="-1" disabled>/);
  const grouped = songRowsMarkup({ rows: ['a', 'b', 'c', 'd'].map((key, i) => plainRow(key, { track: key, group: i < 2 ? 'DISC 01' : 'DISC 02' })) });
  assert.equal(count(grouped, /class="song-group"/g), 2, 'one heading per group');
  assert.ok(grouped.indexOf('DISC 02') > grouped.indexOf('data-track="b"') && grouped.indexOf('DISC 02') < grouped.indexOf('data-track="c"'));
  assert.equal(count(songRowsMarkup({ rows: [plainRow('a'), plainRow('b')] }), /song-group/g), 0, 'no group, no heading');
  assert.equal(songRowsMarkup({ rows: [], empty: '这个歌单是空的。' }), '<p class="song-empty">这个歌单是空的。</p>');
  assert.equal(songRowsMarkup({ rows: [] }), '');
});

test('queue rows: one per song in order, positions, durations, boxes', () => {
  const tracks = [song(1), song(2, { duration: undefined }), song(3, { artist: '' }), ...Array.from({ length: 1000 }, (_, i) => song(10 + i))];
  const model = queueModel(tracks, { selected: tracks[2] });
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
  assert.deepEqual([model.label, model.listLabel, model.count, model.countNote], ['播放队列', '播放队列', '共 1003 首', undefined]);
  assert.equal('note' in model, false, 'no note under the list');
  // Every song of NetEase's own queue with a box can be played from its row (▶).
  assert.ok(model.rows.every(row => row.playable === true));
  assert.deepEqual([queueModel(tracks, { truncated: true }).count, queueModel(tracks, { truncated: true }).countNote], ['共 1003 首', '前 3000 首']);
  assert.equal(queueModel([song(1)]).count, '共 1 首');
  const none = queueModel(tracks);
  assert.deepEqual([none.tab.label, none.title, none.subtitle], ['QUEUE', '播放队列', '']);
  assert.equal(queueModel(tracks, { column: { number: 3, total: 7 } }).tab.number, undefined, 'the lone queue has no column number');
  assert.match(queueModel([]).empty, /空/);
  // The number shares its cell with the row's ▶ (not a button of its own: the row is the button).
  assert.match(songRowsMarkup(model), /data-row="1" data-select="1" data-playable tabindex="-1"><span class="song-row-number">002<\/span><span class="song-row-play" data-action="play-row" aria-hidden="true"><\/span><span class="song-row-copy">/);
});

test('queue rows: a song without a box is disabled; a song queued twice keeps both rows', () => {
  const tracks = [song(1), song(2), song(1), song(3)];
  const twice = queueModel(tracks, { selected: tracks[2] });
  assert.deepEqual(twice.rows.map(row => row.key), ['netease-track:1', 'netease-track:2', 'netease-track:1', 'netease-track:3']);
  assert.deepEqual(twice.rows.map(row => row.select), [0, 1, 0, 2], 'both rows select the one box');
  assert.deepEqual([twice.title, twice.subtitle], ['Song 1', 'Singer 1 · Record 1'], 'a repeated song is selected as itself');
  assert.equal(count(songRowsMarkup(twice), /<button /g), 4);
  const missing = queueSongModel(tracks, { stamp: 's', truncated: false, keyOf, indexOf: key => (key === 'netease-track:2' ? -1 : 5), time });
  assert.deepEqual(missing.rows.map(row => [row.select, row.disabled, row.playable]), [[5, false, true], [undefined, true, false], [5, false, true], [5, false, true]]);
  const markup = songRowsMarkup(missing);
  assert.equal(count(markup, / disabled>/g), 1);
  assert.equal(count(markup, /data-select=/g), 3, 'a disabled row selects nothing');
  assert.equal(count(markup, /class="song-row-play"/g), 3, 'nor has it a ▶');
});

test('a queue id follows the stamp, the length and the boxes, not the selection', () => {
  const tracks = [song(1), song(2), song(3)];
  const id = queueModel(tracks).id;
  assert.ok(id.includes('s1') && id.includes(':3:'));
  assert.equal(queueModel(tracks, { selected: tracks[1] }).id, id, 'moving along the queue keeps the rows');
  assert.equal(queueModel(tracks, { selected: tracks[2] }).id, id);
  // A column only for browsing has the same songs without ▶: other rows.
  assert.notEqual(queueModel(tracks, { lane: { name: 'x', live: false } }).id, queueModel(tracks, { lane: { name: 'x', live: true } }).id);
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
  // No note under the list (the owner, 2026-10-07): the ↗ row says what its mark means in its tooltip.
  assert.equal('note' in model, false);
  // A song the browser cannot play (↗) only selects: no ▶ (the review of 2026-10-08; below).
  assert.deepEqual(model.rows.map(row => [row.playable, row.hint]), [[true, undefined], [true, undefined], [false, '需要兼容的播放内核']]);
  assert.match(songRowsMarkup(model), /data-row="1" data-select="11" data-playable tabindex="-1"><span class="song-row-number">002<\/span><span class="song-row-play" data-action="play-row" aria-hidden="true"><\/span>/);
  assert.match(songRowsMarkup(model), /data-row="2" data-select="12" title="需要兼容的播放内核" tabindex="-1"><span class="song-row-number">003<\/span><span class="song-row-copy">/);
  // A click on a row selects; only its ▶ plays (the app's play-row action), never the row itself.
  assert.doesNotMatch(songRowsMarkup(model), /data-track=/, 'a row selects; it does not play');
  const offline = playlistModel([local(1, { offline: true })]);
  assert.equal(offline.countNote, '目录离线', 'an offline folder says so under the count, no sentence');
  assert.deepEqual([offline.rows[0].disabled, offline.rows[0].playable, offline.rows[0].hint], [false, false, '目录离线'], 'an offline song can still be selected, not played');
  assert.doesNotMatch(songRowsMarkup(offline), /song-row-play/);
  const missing = playlistSongModel([local(1)], { name: 'x', indexOf: () => -1, time });
  assert.deepEqual([missing.rows[0].select, missing.rows[0].disabled, missing.rows[0].playable], [undefined, true, false]);
  const demo = playlistModel([local(1, { format: '演示', browserPlayable: false, duration: 0 })], { demo: true });
  assert.deepEqual([demo.rows[0].meta, demo.countNote, demo.rows[0].playable, demo.rows[0].hint], ['演示', undefined, false, undefined], 'demonstration songs: no lengths, nothing to play or explain');
  assert.equal(playlistModel([]).empty, '这个歌单是空的。');
  // The rows are rebuilt when what they show changes, not when the selection moves.
  assert.equal(playlistModel(songs, { selected: 'track-3' }).id, model.id);
  assert.notEqual(playlistModel(songs.slice(0, 2)).id, model.id);
  assert.notEqual(playlistModel([local(1), local(2, { title: 'Renamed' }), songs[2]]).id, playlistModel(songs).id);
  const hostile = playlistSongModel([local('<img onerror=x>', { title: '<img onerror=x>', artist: 'x" onmouseover="y' })], { name: '<img>', indexOf: () => 0, time });
  assert.ok(!songRowsMarkup(hostile).includes('<img') && !songRowsMarkup(hostile).includes('" onmouseover="'));
});

// The review of 2026-10-08: ▶ (and a double-click) on the row of a DSF song asked the player for it,
// which stopped the song that played and showed an error. A song the browser cannot play (↗: DSF /
// DFF, only indexed, or any other format it does not decode) is a row to select, not to play.
test('a song the browser cannot play (↗) only selects: no ▶ in its row, its tooltip says why', () => {
  const songs = [local(1), local(2, { format: 'DSF', browserPlayable: false }), local(3, { format: 'DFF', browserPlayable: false }), local(4, { format: 'APE', browserPlayable: false })];
  const model = playlistModel(songs, { selected: 'track-2' });
  assert.deepEqual(model.rows.map(row => [row.meta.split(' · ')[0], row.select, row.disabled, row.playable, row.hint]), [
    ['FLAC', 10, false, true, undefined],
    ['DSF ↗', 11, false, false, '需要兼容的播放内核'],
    ['DFF ↗', 12, false, false, '需要兼容的播放内核'],
    ['APE ↗', 13, false, false, '需要兼容的播放内核'],
  ]);
  const markup = songRowsMarkup(model);
  assert.equal(count(markup, /class="song-row-play"/g), 1, 'the one song the browser plays');
  assert.equal(count(markup, /data-playable/g), 1);
  for (const row of [1, 2, 3]) assert.match(markup, new RegExp(`data-row="${row}" data-select="${10 + row}" title="需要兼容的播放内核" tabindex="-1"><span class="song-row-number">00${row + 1}</span><span class="song-row-copy">`));
  // Still the selected song's title and its column; the rows change when a song becomes playable.
  assert.deepEqual([model.title, model.count], ['Song 2', '共 4 首']);
  assert.notEqual(playlistModel([local(1), local(2, { format: 'DSF', browserPlayable: true })]).id, playlistModel([local(1), local(2, { format: 'DSF', browserPlayable: false })]).id);
});

test('titles are text: markup in any field never reaches the page', () => {
  const evil = '<img onerror=x>', quote = 'x" onmouseover="y';
  const hostileAlbum = { rows: [
    plainRow(evil, { number: evil, title: evil, artist: evil, meta: evil, track: quote, group: evil }),
    plainRow(`${evil}2`, { title: quote, artist: quote, track: `${evil}2`, group: quote }),
  ] };
  const hostileQueue = queueSongModel([song(1, { id: quote, title: evil, artist: evil, album: evil }), song(2, { title: quote })],
    { stamp: evil, truncated: true, keyOf: item => `${evil}${item.id}`, indexOf: () => 0, time: () => evil, lane: { name: evil, live: true } });
  const custom = songRowsMarkup({ rows: [{ key: evil, number: evil, title: evil, artist: evil, meta: evil, track: quote, group: evil, hint: quote }, { key: 'k', number: '2', title: quote, artist: '', meta: '', select: 1, playable: true, hint: evil }], empty: evil });
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
  const discs = Array.from({ length: 90 }, (_, i) => plainRow(`t${i}`, { track: `t${i}`, group: `DISC 0${1 + Math.floor(i / 30)}` }));
  const sized = [...songRowsMarkup({ rows: discs }).matchAll(/--rows:(\d+);--groups:(\d+)/g)].map(block => [Number(block[1]), Number(block[2])]);
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
  // number reel, the count with the way back to the playing song, the selected song with its
  // steps and the list; no note any more (the owner, 2026-10-07: no descriptive text).
  const glass = markup.slice(markup.indexOf('<div id="song-glass"'));
  for (const id of ['song-tab-number', 'song-tab-total', 'song-go-playing', 'song-count', 'song-count-note', 'song-title', 'song-subtitle', 'song-prev', 'song-next', 'song-list'])
    assert.ok(glass.includes(` id="${id}"`), `${id} is on the pane`);
  assert.doesNotMatch(markup, /song-note/);
  assert.ok(glass.indexOf('id="song-go-playing"') < glass.indexOf('id="song-count"'), '● 012 before 共 N 首');
  assert.ok(!/song-float|song-plate|song-cross|song-overline/.test(markup), 'no plate, crosshair or strip in front of the pane');
  // The tab's reel is not readable text: the tab says what it is in words.
  assert.match(markup, /<span id="song-tab-text" class="song-tab-text"><\/span><span class="song-tab-label" aria-hidden="true">/);
  assert.match(markup, /<span class="song-tab-figure" aria-hidden="true">/);
  const classes = new Set([...`${markup}${songRowsMarkup({ rows: [plainRow('a', { group: 'DISC 01' }), plainRow('b', { group: 'DISC 02' })] })}${songRowsMarkup(queueModel([song(1)]))}${songRowsMarkup({ rows: [], empty: 'x' })}`
    .matchAll(/class="([^"]+)"/g)].flatMap(match => match[1].split(' ')));
  assert.ok(classes.has('song-row-play') && classes.has('song-go-playing') && classes.has('song-tally-row'));
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
  // The design's type at 1440 x 900 (9 px units): a 22 px title and an 11 px second line (no note any more).
  const type = paneType(9);
  assert.ok(Math.abs(type.title - 22) < 0.01 && Math.abs(type.subtitle - 11) < 0.01, JSON.stringify(type));
  const small = paneType(7.2);
  assert.ok(small.title >= 16 && small.subtitle >= 11, 'small windows keep readable floors');
  // 8 px under the rule, three 26.4 px lines, the 11 px line, the steps 20 px under it.
  assert.ok(Math.abs(selectedBlockHeight(9) - (8 + 3 * 26.4 + 10 + 15.4 + 20 + 26)) < 0.05, String(selectedBlockHeight(9)));
  const rule = selector => {
    const start = css.indexOf(`\n${selector} {`);
    assert.ok(start >= 0, selector);
    return css.slice(start, css.indexOf('}', start));
  };
  // The stylesheet is what these sizes mirror (the helpers at the top of this file).
  assert.match(rule('.song-title'), /line-height: 1\.2;/);
  assert.match(rule('.song-subtitle'), /font-size: max\(11px, calc\(var\(--songs-u\) \* 1\.2222\)\);\s*line-height: 1\.4;/);
  assert.match(rule('.song-selected'), /gap: calc\(var\(--songs-u\) \* 1\.1111\);/);
  assert.match(rule('.song-selected'), /padding: calc\(var\(--songs-u\) \* 0\.8889\) /);
  assert.match(rule('.song-steps'), /margin-top: calc\(var\(--songs-u\) \* 1\.1111\);/);
  assert.match(rule('.song-steps button'), /height: max\(24px, calc\(var\(--songs-u\) \* 2\.8889\)\);/);
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
    }
    assert.equal('note' in layout, false, `${at}: no note to place`);
  }
});

// The owner, 2026-10-07: "delete all the descriptive text, like … in scene 3". This replaces the
// 2026-10-05 note at the bottom of the side column (or under the list): there is none to place.
test('the song scene has no note: no element, no layout for it, no grid area', () => {
  const source = readFileSync(new URL('../src/song-list.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /song-note|NOTE_EMS|data-note|\.note\b/);
  assert.doesNotMatch(css, /song-note|data-note|"note/);
  for (const [width, height] of [[1440, 900], [1100, 480], [1000, 700], [820, 1180]]) {
    const { layout } = placed(width, height);
    // (`card`: the drawn card's right and top edges, for 这首歌 over its top right since 2026-10-10.)
    assert.deepEqual(Object.keys(layout).sort(), ['card', 'glass', 'mode', 'rail', 'unit'], `${width}x${height}`);
  }
});

// The owner, 2026-10-10: "move the song detail button here" (over the large card's top right),
// "parallel with this" (level with the selected song's title on the pane, which ends where the
// card's top edge is drawn). 返回专辑架 stays where it was, alone.
test('这首歌 stands over the large card\'s top right, level with the pane\'s title; 返回专辑架 alone at the top left', () => {
  const markup = songSceneMarkup();
  const exits = markup.slice(markup.indexOf('<div class="song-exits">'), markup.indexOf('</div>', markup.indexOf('<div class="song-exits">')));
  assert.match(exits, /data-action="back"/);
  assert.doesNotMatch(exits, /song-details/, 'no longer under 返回专辑架');
  assert.match(markup, /<\/div>\s*<button class="music-back song-details" data-action="details"><span>↗ <span id="song-details-label">专辑详情<\/span><\/span> <kbd>S<\/kbd><\/button>\s*<p class="song-caption">/);
  const rule = css.slice(css.indexOf('\n.song-chrome .song-details {'), css.indexOf('}', css.indexOf('\n.song-chrome .song-details {')));
  // Its middle on the title's second line as alignDetails measures it; before that (and in portrait)
  // just over the card's drawn top edge.
  assert.match(rule, /position: absolute;\s*right: calc\(100% - var\(--songs-card-right\)\);\s*top: var\(--songs-details-y, calc\(var\(--songs-card-top\) - 16px\)\);\s*transform: translateY\(-50%\);/);
  assert.doesNotMatch(css, /\.song-exits \.song-details/);
  // alignDetails: the title's second line in the pane's own layout (offsets, untouched by the pane's
  // turn and entrance), projected as the pane is turned, kept clear above the case; not in portrait.
  const source = readFileSync(new URL('../src/song-list.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const align = source.slice(source.indexOf('  alignDetails() {'), source.indexOf('  private setDetailsY('));
  assert.match(align, /if \(!placed \|\| placed\.portrait\) return this\.setDetailsY\(""\);/);
  assert.match(align, /for \(let at: HTMLElement \| null = this\.title; at && at !== this\.glass; at = at\.offsetParent as HTMLElement \| null\) \{\s*x \+= at\.offsetLeft;\s*y \+= at\.offsetTop;\s*\}/);
  assert.match(align, /const second = projectSheet\(glass, x - glass\.width \/ 2, y \+ 1\.5 \* line - glass\.height \/ 2\)\.y;/);
  assert.match(align, /const centre = Math\.min\(second, card\.y - card\.height \/ 2 - 4 - this\.details\.offsetHeight \/ 2\);/);
  assert.doesNotMatch(align, /getBoundingClientRect|getClientRects/, 'not the boxes on the screen, which the entrance moves');
  const app = readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8');
  assert.match(app, /songTransition\.show\(preferences\.reduced\);\s*\/\/[^\n]*\n\s*songView\.alignDetails\(\);/, 'measured once the pane has a box');
  for (const [width, height] of [[1440, 900], [1920, 1080], [1280, 720], [1000, 700], [820, 1180]]) {
    const { layout, card } = placed(width, height);
    const style = songLayoutStyle(layout);
    assert.equal(style['--songs-card-right'], `${Math.round(layout.card.right * 100) / 100}px`, `${width}x${height}`);
    // The case's right edge as it is seen: its face's, not the reach of its glow (the rail and the pane keep clear of that).
    assert.equal(layout.card.right, card.x + card.width / 2, `${width}x${height}: the face's right edge`);
    assert.equal(layout.card.top, layout.rail.top, `${width}x${height}: the card's drawn top, where the rail stops`);
    assert.ok(layout.card.right > layout.rail.x, `${width}x${height}: right of the rail`);
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

test('the stylesheet cuts a crowded header, places the list under the selected song and stops a paused meter', () => {
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
  // ● 012 beside the count never pushes it out: the button keeps its size, the count is cut. It
  // is styled under the section's class, so the page's `.music-app button { font: inherit; color:
  // inherit }` does not set it in the pane's 16 px ink: small, muted, tabular figures.
  const back = rule('.music-song .song-go-playing');
  assert.match(back, /flex: none;/);
  assert.match(back, /font-size: max\(10px, calc\(var\(--songs-u\) \* 1\.1111\)\);/);
  assert.match(back, /color: var\(--muted\);/);
  assert.match(back, /font-variant-numeric: tabular-nums;/);
  assert.doesNotMatch(css, /\n\.song-go-playing(:hover)? \{/, 'no rule the page\'s button rule would beat');
  const pageCss = readFileSync(new URL('../src/music.css', import.meta.url), 'utf8');
  assert.match(pageCss, /\.music-app button,\s*\.music-app a,[^{]*\{\s*font: inherit;\s*color: inherit;/, 'the rule it has to beat (0,1,1 against 0,2,0)');
  assert.match(rule('.song-count'), /min-width: 0;/);
  // Wide, the list takes the whole height right of the selected song; stacked, all under it (no note row).
  assert.match(rule('.song-glass'), /grid-template-rows: calc\(var\(--songs-u\) \* 12\) auto minmax\(0, 1fr\);\s*grid-template-areas:\s*"head head"\s+"selected list"\s+"\. list";/);
  const stacked = rule('.music-song[data-panel="stacked"] .song-glass');
  assert.match(stacked, /grid-template-rows: auto auto minmax\(0, 1fr\);/);
  assert.match(stacked, /"head"\s+"selected"\s+"list";/);
  // The design's meter: three 2 px bars of 6, 10 and 8 px in the playback colour, in the playing
  // row's number cell (its number hidden), each scaled from its foot.
  assert.match(rule('.song-row.playing .song-row-number'), /position: relative;\s*color: transparent;/);
  assert.match(rule('.song-meter'), /display: none;/);
  assert.match(rule('.song-row.playing .song-meter'), /display: block;\s*position: absolute;\s*left: 0;\s*bottom: 0;/);
  const bar = rule('.song-meter i');
  assert.match(bar, /bottom: 0;\s*width: 2px;\s*background: var\(--state\);\s*transform-origin: 50% 100%;/);
  for (const [n, left, height] of [[1, '0', 6], [2, '4px', 10], [3, '8px', 8]])
    assert.match(rule(`.song-meter i:nth-child(${n})`), new RegExp(`left: ${left};\\s*height: ${height}px;\\s*$`));
  // The page's frame loop moves it (tickMeter), not an animation: measured 2026-10-10, animated
  // heights restyled and repainted the list on every display frame, and an animation of the bars
  // had the pane composited at the display's rate.
  assert.doesNotMatch(css, /@property|--song-meter|song-level|\.song-meter[^{]*\{[^}]*animation/, 'no animation of the meter is left');
});

test('the meter\'s bars: 45% to whole and back on 700, 820 and 940 ms, ease-in-out, whole before they start', () => {
  assert.deepEqual(SONG_METER.map(({ period, delay }) => [period, delay]), [[700, 0], [820, 120], [940, 240]]);
  // CSS's ease-in-out: cubic-bezier(0.42, 0, 0.58, 1), against a slow, exact solution of the curve.
  const reference = (x) => {
    let low = 0, high = 1, t = 0.5;
    for (let i = 0; i < 60; i++) {
      t = (low + high) / 2;
      const at = 3 * 0.42 * t * (1 - t) ** 2 + 3 * 0.58 * t * t * (1 - t) + t ** 3;
      if (at < x) low = t; else high = t;
    }
    return 3 * t * t * (1 - t) + t ** 3;
  };
  for (let x = 0; x <= 1.0001; x += 0.0625) assert.ok(Math.abs(easeInOut(x) - reference(x)) < 1e-6, `x = ${x}`);
  assert.equal(easeInOut(0.5), 0.5);
  assert.equal(easeInOut(-1), 0);
  assert.equal(easeInOut(2), 1);
  for (const period of [700, 820, 940]) {
    assert.equal(meterScale(-1, period), 1, 'before its delay, whole');
    assert.equal(meterScale(0, period), 0.45);
    assert.ok(Math.abs(meterScale(period / 4, period) - 0.725) < 1e-9, 'halfway up');
    assert.equal(meterScale(period / 2, period), 1);
    assert.ok(Math.abs(meterScale((3 * period) / 4, period) - 0.725) < 1e-9, 'halfway down');
    assert.ok(Math.abs(meterScale(period, period) - 0.45) < 1e-9, 'the next period');
  }
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
  // The rows show the same in every column, and every row with a case can be played from (▶): the
  // queue's own songs as they are, any other playlist column's with its playlist, which then becomes
  // NetEase's queue (the owner, 2026-10-10; until then such a column was only for browsing).
  const shown = rows => rows.map(({ playable, ...row }) => row);
  assert.deepEqual(shown(other.rows), shown(queueModel(tracks).rows));
  assert.ok(other.rows.every(row => row.playable === true) && live.rows.every(row => row.playable === true));
  assert.match(songRowsMarkup(other), /data-playable/);
  assert.match(other.id, /:browse:/, 'the rows are rebuilt when the column becomes the queue');
});

test('▶ in a row: in its number\'s cell, shown on a playable row that is hovered, focused or selected', () => {
  const rule = selector => {
    const start = css.indexOf(`\n${selector} {`);
    assert.ok(start >= 0, selector);
    return css.slice(start, css.indexOf('}', start));
  };
  // The number and ▶ share the first column; the title and the meta keep theirs.
  assert.match(rule('.song-row-number'), /grid-area: 1 \/ 1;/);
  assert.match(rule('.song-row-play'), /grid-area: 1 \/ 1;\s*display: none;/);
  assert.match(rule('.song-row-copy'), /grid-area: 1 \/ 2;/);
  assert.match(rule('.song-row-meta'), /grid-area: 1 \/ 3;/);
  // Shown while the section says the rows can be played (data-play) — never on the row that plays
  // (its meter stays) nor on one NetEase was asked for — or, on the paused playing row, to resume it.
  const shows = /\.music-song\[data-play="true"\] \.song-row:not\(\.playing, \.pending\):is\(:hover, :focus-visible, \.selected\) \.song-row-play,\s*\.music-song\[data-resume="true"\] \.song-row\.playing:not\(\.pending\):is\(:hover, :focus-visible, \.selected\) \.song-row-play \{\s*display: block;\s*\}/;
  assert.match(css, shows);
  assert.match(css, /:has\(\.song-row-play\) \.song-row-number \{\s*visibility: hidden;\s*\}/, 'in the number\'s place');
  // The view mirrors what the app says (SongListView.sync): data-play and data-resume on the section.
  const source = readFileSync(new URL('../src/song-list.ts', import.meta.url), 'utf8');
  assert.match(source, /const flags = \{ paused: state\.paused, live: state\.live, play: state\.play, resume: state\.resume \};/);
  // Only a row with a box and a song that may be played has one (not offline, not ↗).
  const markup = songRowsMarkup(playlistModel([local(1), local(2, { offline: true }), local(3, { format: 'DSF', browserPlayable: false })]));
  assert.equal(count(markup, /class="song-row-play"/g), 1);
});

// The review of 2026-10-08: touch has no hover, yet Chromium hovers the tapped row as the tap
// lands, so a tap on the number of a row that was not selected found ▶ under the finger and
// played the song. The press decides: the mouse is unchanged.
test('▶ in a row on touch or pen: it plays only where it showed before the press', () => {
  const row = {}, other = {};
  // A mouse hovers the row before it presses: ▶ is what it clicked.
  assert.equal(rowPressPlays({ pointer: 'mouse', row, shown: false }, row), true);
  assert.equal(rowPressPlays({ pointer: 'mouse', row: null, shown: false }, row), true);
  assert.equal(rowPressPlays(undefined, row), true, 'no press recorded');
  assert.equal(rowPressPlays({ pointer: '', row, shown: false }, row), true, 'a pointer the browser does not name');
  for (const pointer of ['touch', 'pen']) {
    // The row showed its number: the tap only selects it.
    assert.equal(rowPressPlays({ pointer, row, shown: false }, row), false, pointer);
    // The selected or the focused row (or one a hovering pen was over) showed ▶: it plays.
    assert.equal(rowPressPlays({ pointer, row, shown: true }, row), true, pointer);
    // A tap the browser moved onto another row's ▶, or one that began outside the list.
    assert.equal(rowPressPlays({ pointer, row: other, shown: true }, row), false, pointer);
    assert.equal(rowPressPlays({ pointer, row: null, shown: false }, row), false, pointer);
  }
});

test('the view keeps the last primary press: its pointer, the list\'s row, and ▶ as it was then', () => {
  const saved = Object.fromEntries(['document', 'Element', 'getComputedStyle'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const listeners = [];
  // Just enough of a page for the view: elements by class, a parent chain, a computed display.
  class FakeElement {
    constructor(name, parent = null) { Object.assign(this, { name, parent, display: 'block', dataset: {}, style: {}, children: [] }); parent?.children.push(this); }
    closest(selector) { for (let node = this; node; node = node.parent) if (`.${node.name}` === selector) return node; return null; }
    contains(node) { for (let at = node; at; at = at.parent) if (at === this) return true; return false; }
    querySelector(selector) { for (const child of this.children) { const found = child.closest(selector) === child ? child : child.querySelector(selector); if (found) return found; } return null; }
    addEventListener() {}
    setAttribute() {}
  }
  const set = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  set('Element', FakeElement);
  set('getComputedStyle', element => ({ display: element.display }));
  set('document', { activeElement: null, addEventListener: (type, listener, capture) => listeners.push({ type, listener, capture }) });
  try {
    const list = new FakeElement('song-list');
    const page = new FakeElement('page');
    const root = { dataset: {}, querySelector: selector => selector === '.song-list' ? list : new FakeElement(selector) };
    const rowOf = shown => {
      const row = new FakeElement('song-row', list);
      const number = new FakeElement('song-row-number', row);
      new FakeElement('song-row-play', row).display = shown ? 'block' : 'none';
      return { row, number };
    };
    const view = new SongListView(root);
    const presses = listeners.filter(entry => entry.type === 'pointerdown');
    assert.equal(presses.length, 1);
    assert.equal(presses[0].capture, true, 'before the page answers the press');
    const press = (pointerType, target, isPrimary = true) => presses[0].listener({ pointerType, target, isPrimary });
    const plain = rowOf(false), selected = rowOf(true);
    // A tap on the number of a row that showed it: the click only selects.
    press('touch', plain.number);
    assert.equal(view.playAllowed(plain.row), false);
    // ▶ is under the finger by the time the click is hit-tested; what counts is the press.
    plain.row.querySelector('.song-row-play').display = 'block';
    assert.equal(view.playAllowed(plain.row), false, 'measured at the press, not at the click');
    plain.row.querySelector('.song-row-play').display = 'none';
    // The selected row's ▶ was there before the tap: it plays.
    press('touch', selected.number);
    assert.equal(view.playAllowed(selected.row), true);
    assert.equal(view.playAllowed(plain.row), false, 'the tap was on another row');
    press('pen', plain.number);
    assert.equal(view.playAllowed(plain.row), false);
    // A second finger does not replace the press that will click.
    press('touch', selected.number);
    press('touch', plain.number, false);
    assert.equal(view.playAllowed(selected.row), true);
    // A press outside the list, or on nothing the page knows, is no row's.
    press('touch', page);
    assert.equal(view.playAllowed(selected.row), false);
    press('touch', null);
    assert.equal(view.playAllowed(selected.row), false);
    // The mouse plays wherever it clicked ▶, as before.
    press('mouse', plain.number);
    assert.equal(view.playAllowed(plain.row), true);
    press('mouse', page);
    assert.equal(view.playAllowed(selected.row), true);
  } finally {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

// The owner, 2026-10-08: "scene3: double-click a song in the list to switch to it".
test('a double-click or a double tap on a row: the second click of the burst, wherever it landed', () => {
  const click = (serial, extra = {}) => ({ serial, at: serial * 100, x: 10, y: 10, pointer: 'mouse', count: 1, ...extra });
  const single = c => ({ ...c, kind: 'single' });
  // The mouse: the browser counts the double-click (detail 2 after 1, at the system's time and distance).
  assert.equal(rowClickKind(undefined, click(1)), 'single');
  assert.equal(rowClickKind(single(click(1)), click(2, { count: 2 })), 'double');
  assert.equal(rowClickKind({ ...click(2, { count: 2 }), kind: 'double' }, click(3, { count: 3 })), 'more', 'a triple click');
  assert.equal(rowClickKind({ ...click(3, { count: 3 }), kind: 'more' }, click(4, { count: 4 })), 'more');
  // Two mouse clicks the browser did not count together are two single ones, however quick.
  assert.equal(rowClickKind(single(click(1)), click(2, { at: 150 })), 'single', 'a mouse\'s double-click is the system\'s');
  // Another click on the page in between, or one not counted with the click before, starts afresh.
  assert.equal(rowClickKind(single(click(1)), click(3, { count: 2 })), 'single', 'not the click just before it');
  assert.equal(rowClickKind(single(click(1, { count: 2 })), click(2, { count: 2 })), 'single');
  assert.equal(rowClickKind(single(click(1)), click(2, { count: 2, at: 100 + ROW_DOUBLE.counted })), 'single');
  // Where it landed is not asked: the first click may have scrolled another row under the pointer.
  assert.equal(rowClickKind(single(click(1)), click(2, { count: 2, x: 12, y: 60 })), 'double');
  // From the keyboard (detail 0, Enter on a focused row): always single, and no double starts with it.
  assert.equal(rowClickKind(single(click(1)), click(2, { count: 0 })), 'single');
  assert.equal(rowClickKind(single(click(1, { count: 0, pointer: '' })), click(2, { pointer: 'touch' })), 'single');
  // A tap or a pen's press: counted by the browser (Chromium counts taps) or close after the click before.
  for (const pointer of ['touch', 'pen', '']) {
    const first = single(click(1, { pointer }));
    assert.equal(rowClickKind(first, click(2, { pointer, count: 2 })), 'double', pointer);
    assert.equal(rowClickKind(first, click(2, { pointer, at: 100 + ROW_DOUBLE.ms - 1, x: 10 + ROW_DOUBLE.px })), 'double', pointer);
    assert.equal(rowClickKind(first, click(2, { pointer, at: 100 + ROW_DOUBLE.ms })), 'single', `${pointer}: too late`);
    assert.equal(rowClickKind(first, click(2, { pointer, at: 150, x: 10 + ROW_DOUBLE.px + 1 })), 'single', `${pointer}: too far`);
    assert.equal(rowClickKind({ ...click(2, { pointer, at: 250 }), kind: 'double' }, click(3, { pointer, at: 400 })), 'more', pointer);
  }
  // Two taps make a double tap; a mouse's click and a tap do not.
  assert.equal(rowClickKind(single(click(1)), click(2, { pointer: 'touch', at: 150 })), 'single');
  assert.equal(rowClickKind(single(click(1, { pointer: 'pen' })), click(2, { pointer: 'touch', at: 150 })), 'single');
  // As the shelf's double press on ▶ (music-app.ts DOUBLE_PRESS); a mouse's up to Windows' longest double-click time.
  assert.deepEqual(ROW_DOUBLE, { ms: 500, px: 16, counted: 5000 });
  assert.match(readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8'), /const DOUBLE_PRESS = \{ ms: 500, px: 16 \} as const;/);
});

test('the view tells a row\'s clicks apart: one, the burst\'s second (on the row it began on), and what it played', () => {
  const saved = Object.fromEntries(['document', 'Element', 'getComputedStyle'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const listeners = [];
  class FakeElement {
    constructor(name, parent = null) { Object.assign(this, { name, parent, display: 'block', dataset: {}, style: {}, children: [] }); parent?.children.push(this); }
    closest(selector) { for (let node = this; node; node = node.parent) if (`.${node.name}` === selector) return node; return null; }
    contains(node) { for (let at = node; at; at = at.parent) if (at === this) return true; return false; }
    querySelector(selector) { for (const child of this.children) { const found = child.closest(selector) === child ? child : child.querySelector(selector); if (found) return found; } return null; }
    addEventListener() {}
    setAttribute() {}
  }
  const set = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  set('Element', FakeElement);
  set('getComputedStyle', element => ({ display: element.display }));
  set('document', { activeElement: null, addEventListener: (type, listener, capture) => listeners.push({ type, listener, capture }) });
  try {
    const list = new FakeElement('song-list');
    const root = { dataset: {}, querySelector: selector => selector === '.song-list' ? list : new FakeElement(selector) };
    const view = new SongListView(root);
    const counters = listeners.filter(entry => entry.type === 'click');
    assert.equal(counters.length, 1, 'one counter of the page\'s clicks');
    assert.equal(counters[0].capture, true, 'before the page answers the click');
    const a = new FakeElement('song-row', list), b = new FakeElement('song-row', list);
    let at = 0;
    // A click as the browser dispatches it: the view's counter (capture), then the page's answer.
    const clickOn = (row, extra = {}) => {
      const event = { timeStamp: at += 120, clientX: 10, clientY: 10, detail: 1, pointerType: 'mouse', ...extra };
      counters[0].listener(event);
      return row ? view.rowClick(row, event) : undefined;
    };
    // A mouse's double-click on A: the second click found B under the pointer (the list moved).
    assert.deepEqual(clickOn(a), { kind: 'single', row: a, played: false });
    assert.deepEqual(clickOn(b, { detail: 2 }), { kind: 'double', row: a, played: false });
    assert.deepEqual(clickOn(b, { detail: 3 }), { kind: 'more', row: a, played: false });
    // The first click played its row (its ▶): the burst plays nothing more.
    clickOn(b);
    view.rowPlayed();
    assert.deepEqual(clickOn(b, { detail: 2 }), { kind: 'double', row: b, played: true });
    // A click elsewhere on the page in between: two single clicks.
    clickOn(a);
    clickOn(null);
    assert.equal(clickOn(a, { detail: 2 }).kind, 'single');
    // Enter on a focused row (detail 0): a single click, and the next click starts afresh.
    assert.equal(clickOn(a, { detail: 0, pointerType: '' }).kind, 'single');
    assert.equal(clickOn(a, { detail: 2 }).kind, 'single');
    // A double tap the browser does not count: two taps close in time and place.
    assert.equal(clickOn(b, { pointerType: 'touch' }).kind, 'single', 'a tap just after a mouse click');
    assert.deepEqual(clickOn(b, { pointerType: 'touch', clientX: 14 }), { kind: 'double', row: b, played: false });
    // A third tap soon after: nothing more. Later, a new burst.
    assert.equal(clickOn(b, { pointerType: 'touch' }).kind, 'more');
    at += ROW_DOUBLE.ms;
    // A click that does not name its pointer takes the press's.
    listeners.find(entry => entry.type === 'pointerdown').listener({ pointerType: 'touch', target: a, isPrimary: true });
    assert.equal(clickOn(a, { pointerType: '' }).kind, 'single');
    assert.equal(clickOn(a, { pointerType: undefined }).kind, 'double');
    // Rows rebuilt between the two clicks (the first one's row has left the list): a single click.
    at += ROW_DOUBLE.ms;
    const gone = new FakeElement('song-row', list);
    clickOn(gone);
    gone.parent = null;
    assert.deepEqual(clickOn(b, { detail: 2 }), { kind: 'single', row: b, played: false });
  } finally {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
