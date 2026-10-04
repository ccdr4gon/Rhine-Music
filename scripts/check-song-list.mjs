import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  albumSongModel, queueSongModel, songSceneMarkup, songRowsMarkup, rovingIndex, revealScrollTop,
  titleWidth, plateTitleSize, songSceneLayout, songLayoutStyle, projectSheet, SONG_BLOCK_ROWS, CARD_REACH,
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
  assert.equal(model.caption, 'ALBUM 012 / 2019');
  assert.equal(albumModel(album([track('a')])).caption, 'ALBUM 012', 'no year, no slash');
  assert.deepEqual([model.title, model.subtitle, model.label, model.overline], ['Album', 'Album Artist', 'Album Artist', 'TRACKS / 歌单']);
  assert.equal(model.count, '3 TRACKS · 9:11');
  assert.equal(albumModel(album([track('a')])).count, '1 TRACK · 4:05');
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
  assert.equal(demo.count, '0 TRACKS');
  assert.equal(songRowsMarkup(demo), `<p class="song-empty">${demo.empty}</p>`);
  assert.equal(songRowsMarkup({ rows: [] }), '');
});

test('an album id follows everything its rows show', () => {
  const base = () => album([track('a'), track('b')]);
  const id = albumModel(base()).id;
  assert.equal(albumModel(base()).id, id, 'the same album keeps its rows');
  assert.equal(albumModel(base(), { number: 40 }).id, id, 'the plate is not part of the rows');
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
  assert.equal(model.caption, 'NETEASE QUEUE / 003 · 1003');
  assert.deepEqual([model.title, model.subtitle], ['Song 3', '歌手未提供 — Record 3']);
  assert.deepEqual([model.overline, model.label, model.count, model.note], ['PLAYLIST / 播放队列', '网易云音乐 / 播放队列', '1003 SONGS', 'note']);
  assert.equal(queueModel(tracks, { truncated: true }).count, '1003 SONGS（前 3000 首）');
  assert.equal(queueModel([song(1)]).count, '1 SONG');
  const none = queueModel(tracks);
  assert.deepEqual([none.caption, none.title, none.subtitle], ['NETEASE QUEUE / 1003', '播放队列', '']);
  assert.match(queueModel([]).empty, /空/);
  assert.match(songRowsMarkup(model), /data-row="1" data-select="1" tabindex="-1"><span class="song-row-number">002</);
});

test('queue rows: a song without a box is disabled; a song queued twice keeps both rows', () => {
  const tracks = [song(1), song(2), song(1), song(3)];
  const twice = queueModel(tracks, { selected: tracks[2] });
  assert.deepEqual(twice.rows.map(row => row.key), ['netease-track:1', 'netease-track:2', 'netease-track:1', 'netease-track:3']);
  assert.deepEqual(twice.rows.map(row => row.select), [0, 1, 0, 2], 'both rows select the one box');
  assert.equal(twice.caption, 'NETEASE QUEUE / 001 · 004', 'the first position answers for a repeated song');
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
  // The three fade targets are the section's only children, so nothing is left unfaded.
  const top = [];
  let depth = 0;
  for (const [, close, attributes] of markup.matchAll(/<(\/?)[a-z0-9]+([^>]*)>/g)) {
    if (close) depth--;
    else if (depth++ === 0) top.push(/class="([^"]+)"/.exec(attributes)?.[1]);
  }
  assert.equal(depth, 0, 'every element is closed');
  assert.deepEqual(top, ['song-chrome', 'song-glass', 'song-float']);
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

test('plate titles: the largest size that fits, by estimated width', () => {
  assert.equal(titleWidth('长夜将尽'), 4);
  assert.equal(titleWidth('かな한글：'), 5, 'kana, hangul and full-width punctuation count as full width');
  assert.ok(Math.abs(titleWidth('GEOMETRY') - 6.32) < 0.01 && titleWidth('GEOMETRY') >= 5.88, 'no narrower than MiSans Bold sets it');
  assert.ok(titleWidth('Demo Cover 02') >= 7.87 && titleWidth('Tide 长夜 7') >= 5.4 && titleWidth('Tidewater Sessions (Deluxe Edition)') >= 18.41);
  assert.ok(titleWidth('illi') < titleWidth('mmmm') / 2);
  assert.equal(titleWidth(''), 0);
  assert.equal(plateTitleSize('长夜将尽', 26), 'l');
  assert.equal(plateTitleSize('GEOMETRY', 23.5), 'm');
  assert.equal(plateTitleSize('第七号练习曲（现场版）', 26), 's');
  assert.equal(plateTitleSize('An Unreasonably Long Song Title', 26), 's');
  assert.equal(plateTitleSize('', 26), 'l');
  assert.equal(plateTitleSize('长夜将尽', 12), 's');
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
    rim: 0.9 * layout.unit * 1.12,
  };
}

test('the sheet keeps clear of the card, the header and the bottom line at every size', () => {
  for (const [width, height] of SIZES) {
    const at = `${width}x${height}`;
    const { card, portrait, layout, cardRight, cardTop, cardBottom, left, right, top, bottom, rim } = placed(width, height);
    const { glass, plate, unit } = layout;
    assert.ok(left - rim >= 0 && right + rim <= width, `${at}: inside the picture`);
    assert.ok(bottom <= height - Math.max(0.046 * height, 40) + 0.01, `${at}: above the bottom line`);
    assert.ok(plate.x >= 0 && plate.x + plate.width <= width && plate.y + plate.height <= bottom, `${at}: the plate is inside`);
    assert.ok(glass.width >= 24 * unit && glass.height >= 20 * unit, `${at}: room for a list`);
    assert.ok(unit >= 7.2 && unit <= 13.5);
    // Rows are painted only while their box, grown by 1.5 viewport widths, stays short of the eye's plane.
    assert.ok((glass.width / 2 + 1.5 * width) * Math.sin(glass.tilt * Math.PI / 180) < glass.perspective, `${at}: rows stay paintable`);
    if (portrait) {
      assert.equal(layout.mode, 'stacked');
      assert.ok(top - rim >= cardBottom - 0.5, `${at}: the sheet is under the card`);
      assert.ok(plate.y >= cardBottom + unit - 0.01, `${at}: the plate is under the card`);
      assert.equal(layout.rail.shown, false);
    } else {
      assert.ok(top >= Math.max(0.1 * height, 96) - 0.01, `${at}: below the header`);
      assert.ok(left - rim >= cardRight + 1.4 * unit, `${at}: the sheet is right of the card`);
      assert.ok(plate.x >= cardRight + unit, `${at}: the plate is right of the card`);
      assert.ok(plate.y >= Math.max(0.1 * height, 96) - 0.01, `${at}: the plate is below the header`);
      assert.ok(layout.rail.shown && layout.rail.x > card.x - card.width / 2 && layout.rail.x < card.x, `${at}: the line passes behind the card`);
      assert.deepEqual([layout.rail.top, layout.rail.bottom], [cardTop, cardBottom], `${at}: the line stops at the drawn card's edges`);
      assert.ok(cardTop < card.y - card.height / 2 && cardBottom > card.y + card.height / 2);
      if (layout.rail.markerShown) assert.ok(layout.rail.marker + 1.11 * unit <= layout.rail.top && layout.rail.marker - 1.11 * unit >= 96, `${at}: the marker sits between header and card`);
    }
    if (layout.mode === 'wide') {
      const listLeft = projectSheet(glass, glass.side - glass.width / 2, 0).x;
      assert.ok(plate.x < left && plate.x + plate.width < layout.cross.x && layout.cross.x < listLeft, `${at}: plate, line, list from left to right`);
      assert.ok(plate.width >= 22 * unit, `${at}: the plate holds a title`);
      assert.ok(right - listLeft >= 44 * unit, `${at}: the list is wide enough to read`);
      assert.deepEqual(layout.head, { inset: 0, height: 0 });
      assert.ok(['side', 'under'].includes(layout.note), `${at}: the note has a place`);
      if (height >= 700) assert.equal(layout.note, 'side', `${at}: a window of ordinary height keeps the note beside the list`);
      if (layout.note === 'side') {
        // Bottom-aligned in the left column (song-scene.css): a square mark, then lines of
        // 1.75 at max(11px, 1.3u) in a column of side - 5.6u. The stepper ends 5.4u under the plate.
        const font = Math.max(11, 1.3 * unit);
        const lines = Math.ceil(NOTE_EMS / Math.floor((glass.side - 5.6 * unit) / font));
        const noteTop = glass.height / 2 - 1 - 3 * unit - (1.6 * unit + lines * 1.75 * font);
        const top = projectSheet(glass, -glass.width / 2 + 1 + 3 * unit, noteTop).y;
        assert.ok(top >= plate.y + plate.height + 5.4 * unit, `${at}: the longest note starts under the stepper`);
        assert.ok(lines <= 6, `${at}: and stays a few lines`);
      }
    } else {
      assert.ok(layout.head.inset > plate.width && layout.head.height > 0, `${at}: the header makes room for the plate`);
      // About 9.8 units after the sheet's padding: the count's digits fit, longer header text is cut with an ellipsis.
      assert.ok(layout.head.inset < glass.width - 12 * unit, `${at}: and leaves the header at least 12 units of the sheet (its text is cut to fit, never the plate)`);
      assert.equal(layout.note, 'under', `${at}: stacked, the note goes under the list`);
    }
  }
});

test('the note leaves the side column when a wide window is too short for it', () => {
  for (const [width, height] of [[1920, 1080], [1440, 900], [1280, 720], [1366, 768], [2560, 1080], [3440, 1440], [1600, 1000], [1500, 1000]]) {
    const { layout } = placed(width, height);
    assert.deepEqual([layout.mode, layout.note], ['wide', 'side'], `${width}x${height}`);
  }
  for (const [width, height] of [[1920, 500], [1280, 540], [1920, 480], [900, 500]]) {
    const { layout } = placed(width, height);
    assert.deepEqual([layout.mode, layout.note], ['wide', 'under'], `${width}x${height}`);
  }
  // Growing a window never sends the note back under the list.
  for (const width of [1280, 1920, 2560]) {
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

test('16:9 follows the reference placement, turned a little less', () => {
  const { layout, left, right, top, bottom } = placed(1920, 1080);
  assert.equal(layout.mode, 'wide');
  assert.equal(layout.glass.tilt, 18);
  assert.ok(placed(1920, 500).layout.glass.tilt < 18, 'a very wide, short window turns the sheet less');
  assert.ok(Math.abs(left - (1920 - 1027 * 1.08)) < 1 && Math.abs(right - (1920 - 45 * 1.08)) < 1, 'left edge at 100vw - 102.7vh, right edge at 100vw - 4.5vh');
  assert.ok(Math.abs(top - 108) < 0.01 && Math.abs(bottom - (1080 - 49.68)) < 0.01);
  assert.ok(Math.abs(layout.rail.x - 0.224 * 1920) < 1 && Math.abs(layout.rail.marker - 0.29 * 1080) < 1);
  for (const [width, height] of [[1440, 900], [1280, 720], [2560, 1080], [1500, 1000]]) assert.equal(placed(width, height).layout.mode, 'wide', `${width}x${height}`);
  for (const [width, height] of [[1400, 1050], [1000, 700], [900, 1400]]) assert.equal(placed(width, height).layout.mode, 'stacked', `${width}x${height}`);
  assert.ok(placed(1000, 700).layout.glass.tilt < 18 && placed(900, 1400).layout.glass.tilt < placed(1000, 700).layout.glass.tilt, 'narrow sheets turn less');
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
  // Stacked, the plate leaves the header little width: its items are capped and cut, not pushed under the plate.
  assert.match(rule('.music-song[data-panel="stacked"] .song-head > *'), /max-width: 100%;/);
  assert.match(rule('.song-overline > span'), /min-width: 0;/);
  assert.match(rule('.song-overline > span'), /overflow: hidden;/);
  assert.match(rule('.song-overline > span'), /text-overflow: ellipsis;/);
  // The clip stands a pixel outside the text; margin and padding cancel, so the text does not move.
  assert.match(rule('.song-overline > span'), /margin: 0 -1px;\s+padding: 0 1px;/);
  assert.match(rule('.song-count'), /overflow: hidden;/);
  assert.match(rule('.song-count'), /text-overflow: ellipsis;/);
  assert.match(rule('.song-head'), /white-space: nowrap;/);
  // The note follows data-note (SongSceneLayout.note), not the panel mode.
  assert.match(rule('.music-song[data-note="under"] .song-note'), /align-self: auto;/);
  assert.match(css, /\n\.music-song\[data-note="under"\] \.song-note::before,[^{]*\{\s*display: none;/);
  const under = rule('.music-song[data-panel="wide"][data-note="under"] .song-glass');
  assert.match(under, /grid-template-rows: auto minmax\(0, 1fr\) auto;/);
  assert.match(under, /"head head"\s+"\. list"\s+"\. note";/);
  assert.match(rule('.music-song[data-panel="stacked"] .song-glass'), /"head"\s+"list"\s+"note";/);
  assert.ok(!/\[data-panel="stacked"\] \.song-note/.test(css), 'no note rule is left on the panel mode');
  assert.match(rule('.song-glass'), /"head head"\s+"note list";/, 'the default is the side column');
  // A paused song keeps its meter and holds it still.
  assert.match(css, /\n\.music-song\[data-paused="true"\] \.song-row\.playing \.song-row-number,[^{]*\{\s*animation: none;/);
  assert.match(rule('.song-row.playing .song-row-number'), /animation: song-level /);
});

test('a playlist column lists itself: its name, and that it is a playlist rather than the queue', () => {
  const tracks = [song(1), song(2), song(3)];
  const plain = queueModel(tracks, { selected: tracks[1] });
  assert.equal(plain.caption, 'NETEASE QUEUE / 002 · 003');
  assert.equal(plain.overline, 'PLAYLIST / 播放队列');
  assert.equal(plain.label, '网易云音乐 / 播放队列');
  // The queue's own column: still the queue, named after its playlist.
  const live = queueModel(tracks, { selected: tracks[1], lane: { name: 'Road <Trip>', live: true } });
  assert.equal(live.caption, 'NETEASE QUEUE / 002 · 003');
  assert.equal(live.overline, 'PLAYLIST / Road <Trip>');
  assert.equal(live.label, '网易云音乐 / Road <Trip>');
  // Any other column: a playlist, for browsing.
  const other = queueModel(tracks, { lane: { name: 'Road <Trip>', live: false } });
  assert.equal(other.caption, 'NETEASE PLAYLIST / 003');
  assert.equal(other.title, 'Road <Trip>', 'nothing selected: the column\'s name is the title');
  assert.equal(queueModel([], { lane: { name: 'Empty', live: false } }).empty, '这个歌单是空的。');
  assert.equal(queueModel([]).empty, '播放队列是空的。');
  // A playlist cut by the reader's limits does not claim the queue's 3000.
  assert.equal(queueModel(tracks, { truncated: true, lane: { name: 'Long', live: false } }).count, '3 SONGS（未显示全部）');
  assert.equal(queueModel(tracks, { truncated: true, lane: { name: 'Long', live: true } }).count, '3 SONGS（前 3000 首）');
  // The rows do not depend on which column it is.
  assert.deepEqual(other.rows, queueModel(tracks).rows);
});
