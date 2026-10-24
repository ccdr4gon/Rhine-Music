// The details' lyrics (the owner, 2026-10-17: "Redesign scene 2. It shouldn't show 曲目数 anymore, and
// see if you can add dynamic lyrics there instead"): the formats they come in, how NetEase's are read
// and asked for, how a local song's are read, and how the page follows them. Every lyric here is
// made up for the checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { closeWords, decodeLyricBytes, lineAt, lrcTime, nextChange, parseLrc } from '../src/lyrics.ts';
import { neteaseLyrics, parseYrc } from '../src/netease_music/data/lyrics.ts';
import { NeteaseLyrics } from '../src/netease_music/connector/lyrics.ts';
import { LocalLyrics, readLocalLyrics } from '../src/local_music/connector/lyrics-api.ts';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const app = read('../src/music-app.ts');
const view = read('../src/lyrics-view.ts');
const css = read('../src/music-detail.css');
const rust = read('../src-tauri/src/netease_music/connector/debug_port.rs');
const body = (text, start, end) => {
  const from = text.indexOf(start);
  assert.ok(from >= 0, start);
  return text.slice(from, text.indexOf(end, from + start.length));
};
const texts = (lyrics) => lyrics.lines.map((line) => line.text);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

test('LRC: times, repeated lines, the offset, metadata, pauses and bilingual lines', () => {
  assert.equal(lrcTime('01:02.5'), 62.5);
  assert.equal(lrcTime('00:03.25'), 3.25);
  assert.equal(lrcTime('00:03:250'), 3.25, 'a colon before the fraction');
  assert.equal(lrcTime('100:00'), 6000);
  assert.equal(lrcTime('ar:Someone'), undefined);
  const lyrics = parseLrc([
    '﻿[ti:A made-up song]', '[ar:Nobody]', '[offset:+500]',
    '[00:12.00][00:40.00]Chorus line, sung twice',
    '[00:05.00]First line',
    '[00:05.00]第一行的翻译',
    '[00:20.00]',
    '[00:21.00]',
    '[00:22.00][Bridge] spoken words',
    '[00:30.00]  spaced   out  ',
  ].join('\r\n'));
  assert.equal(lyrics.synced, true);
  assert.deepEqual(texts(lyrics), ['First line', 'Chorus line, sung twice', '', '[Bridge] spoken words', 'spaced out', 'Chorus line, sung twice']);
  // [offset:+500] shows every line half a second sooner.
  assert.deepEqual(lyrics.lines.map((line) => line.start), [4.5, 11.5, 19.5, 21.5, 29.5, 39.5]);
  assert.equal(lyrics.lines[0].translation, '第一行的翻译');
  assert.equal(lyrics.lines[1].translation, undefined);
  // One pause, never two in a row, none before the first words.
  assert.equal(parseLrc('[00:01.00]\n[00:02.00]Words\n[00:03.00]\n[00:04.00]\n')?.lines.length, 2);
  assert.equal(parseLrc('[ar:Only metadata]\n[ti:Nothing sung]'), null);
  assert.equal(parseLrc(''), null);
});

test('LRC: text without times is unsynchronised, a few stray times do not make it timed', () => {
  const plain = parseLrc('A first line\n\nA second line\n[ar:Someone]\n');
  assert.deepEqual(plain, { synced: false, lines: [{ start: 0, text: 'A first line' }, { start: 0, text: 'A second line' }] });
  const mostly = parseLrc('One\nTwo\nThree\n[00:04.00]Four');
  assert.equal(mostly.synced, false);
  assert.deepEqual(texts(mostly), ['One', 'Two', 'Three', 'Four']);
  // A title line without a time over timed lyrics is dropped.
  const timed = parseLrc('Made-up title\n[00:01.00]One\n[00:02.00]Two');
  assert.equal(timed.synced, true);
  assert.deepEqual(texts(timed), ['One', 'Two']);
});

test('LRC edge cases: stamps without words, a repeated line\'s lead-in, section headers, a large offset', () => {
  // Word stamps with no words between them are no text (a SYLT line of empty parts).
  assert.deepEqual(texts(parseLrc('[00:01.00]One\n[00:03.00]<00:03.00><00:03.40>\n[00:05.00]Two')), ['One', '', 'Two']);
  // A line sung twice keeps its lead-in each time: its stamps belong to the time nearest its first word.
  const twice = parseLrc('[00:10.00][00:50.00]<00:10.20>Made <00:10.60>up\n[01:20.00]End');
  assert.deepEqual(twice.lines.filter((line) => line.words).map((line) => [line.start, line.words[0].start]), [[10, 10.2], [50, 50.2]]);
  const reversed = parseLrc('[00:50.00][00:10.00]<00:10.20>Made <00:10.60>up\n[01:20.00]End');
  assert.deepEqual(reversed.lines.filter((line) => line.words).map((line) => [line.start, line.words[0].start]), [[10, 10.2], [50, 50.2]]);
  // Only the LRC metadata keys are metadata: "[Verse 1: Someone]" is a line of unsynchronised lyrics.
  assert.deepEqual(texts(parseLrc('[Verse 1: Someone]\nA made-up line\n[ar:Nobody]')), ['[Verse 1: Someone]', 'A made-up line']);
  // A large positive offset moves early lines before the song: they stay apart (not merged as translations).
  const early = parseLrc('[offset:+5000]\n[00:01.00]One\n[00:02.00]Two\n[00:03.00]Three\n[00:09.00]Four');
  assert.deepEqual(texts(early), ['One', 'Two', 'Three', 'Four']);
  assert.ok(early.lines.every((line) => !line.translation));
  assert.deepEqual(early.lines.map((line) => line.start), [-4, -3, -2, 4]);
  assert.equal(lineAt(early.lines, 0), 2, 'at the start the last line before it has been sung');
});

test('enhanced LRC: words timed one by one, a last stamp alone ending the last word', () => {
  const lyrics = parseLrc('[00:01.00]<00:01.00>Made <00:01.50>up <00:02.00>words<00:03.20>\n[00:10.00]<00:10.00>No <00:10.40>end\n[00:30.00]Next');
  const [first, second] = lyrics.lines;
  assert.equal(first.text, 'Made up words');
  assert.deepEqual(first.words.map((word) => [word.text, word.start, word.end]), [['Made ', 1, 1.5], ['up ', 1.5, 2], ['words', 2, 3.2]]);
  assert.equal(first.end, 3.2, 'the closing stamp ends the line');
  // Without a closing stamp the last word lasts about as long as the others (not up to the next line 20 s later).
  close(second.words[1].end, 10.4 + 0.6);
  assert.equal(second.end, undefined);
  // closeWords leaves an end it was given and keeps every word at least 50 ms long.
  const lines = [{ start: 0, text: 'x', words: [{ start: 0, end: 0, text: 'x' }] }, { start: 0.01, text: 'y' }];
  closeWords(lines);
  close(lines[0].words[0].end, 0.05);
});

test('NetEase\'s own credit lines in a lyrics file are lines', () => {
  const lyrics = parseLrc('{"t":0,"c":[{"tx":"作词: "},{"tx":"虚构"}]}\n{"t":1000,"c":[{"tx":"作曲: "},{"tx":"甲"},{"tx":"乙"}]}\n[00:05.00]Words');
  assert.deepEqual(texts(lyrics), ['作词: 虚构', '作曲: 甲 乙', 'Words']);
  assert.deepEqual(lyrics.lines.map((line) => line.start), [0, 1, 5]);
});

test('the line at a time: the last one started, none before the first words or in a pause after a line\'s end', () => {
  const lines = [{ start: 2, text: 'a' }, { start: 5, end: 7, text: 'b' }, { start: 10, text: 'c' }];
  assert.deepEqual([0, 2, 4.99, 5, 6.9, 7, 9.99, 10, 99].map((time) => lineAt(lines, time)), [-1, 0, 0, 1, 1, -1, -1, 2, 2]);
  assert.deepEqual([0, 3, 5, 6, 7, 10].map((time) => nextChange(lines, time)), [2, 5, 7, 7, 10, undefined]);
  assert.equal(lineAt([], 3), -1);
  assert.equal(nextChange([], 3), undefined);
});

test('a lyrics file\'s bytes: byte-order marks, UTF-8, UTF-16 without a mark and GBK', () => {
  const utf8 = new TextEncoder().encode('[00:01.00]虚构的词');
  assert.equal(decodeLyricBytes(utf8), '[00:01.00]虚构的词');
  assert.equal(decodeLyricBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8])), '[00:01.00]虚构的词');
  const utf16 = (text, big) => {
    const out = [];
    for (const unit of text) {
      const code = unit.charCodeAt(0);
      out.push(...(big ? [code >> 8, code & 255] : [code & 255, code >> 8]));
    }
    return out;
  };
  assert.equal(decodeLyricBytes(new Uint8Array([0xff, 0xfe, ...utf16('[00:01.00]虚构')])), '[00:01.00]虚构');
  assert.equal(decodeLyricBytes(new Uint8Array([0xfe, 0xff, ...utf16('[00:01.00]虚构', true)])), '[00:01.00]虚构');
  assert.equal(decodeLyricBytes(new Uint8Array(utf16('[00:01.00]虚构'))), '[00:01.00]虚构', 'UTF-16 saved without a mark');
  // 虚构 in GBK.
  assert.equal(decodeLyricBytes(new Uint8Array([...new TextEncoder().encode('[00:01.00]'), 0xd0, 0xe9, 0xb9, 0xb9])), '[00:01.00]虚构');
  assert.equal(decodeLyricBytes(new ArrayBuffer(0)), '');
  // UTF-8 with a damaged byte or two stays UTF-8 (the damage shows as U+FFFD); it is not read as GBK,
  // which turned every line into other characters.
  const lines = new TextEncoder().encode('[00:01.00]虚构的第一行\n[00:02.00]虚构的第二行\n');
  const stray = new Uint8Array([...lines.subarray(0, 29), 0xff, ...lines.subarray(29)]);
  assert.equal(decodeLyricBytes(stray), '[00:01.00]虚构的第一行\n�[00:02.00]虚构的第二行\n');
  assert.equal(decodeLyricBytes(lines.subarray(0, lines.length - 2)), '[00:01.00]虚构的第一行\n[00:02.00]虚构的第二�', 'its last character cut short');
  // GBK whose bytes are not UTF-8 is still GBK, a line or several: 虚构的歌 / 第二行.
  const gbk = (text) => [...new TextEncoder().encode(text)];
  const several = new Uint8Array([...gbk('[00:01.00]'), 0xd0, 0xe9, 0xb9, 0xb9, 0xb5, 0xc4, 0xb8, 0xe8, ...gbk('\n[00:02.00]'), 0xb5, 0xda, 0xb6, 0xfe, 0xd0, 0xd0]);
  assert.equal(decodeLyricBytes(several), '[00:01.00]虚构的歌\n[00:02.00]第二行');
});

test('NetEase\'s word-timed lyrics: lines and their words, parentheses in the words kept', () => {
  const lines = parseYrc([
    '[12000,3000](12000,500,0)虚(12500,500,0)构(13000,1500,0)的歌',
    '[16000,2000](16000,800,0)(Oh) (16800,700,0)yeah',
    '[1000,500]',
    'not a line',
  ].join('\n'));
  assert.deepEqual(texts({ lines }), ['虚构的歌', '(Oh) yeah']);
  assert.deepEqual(lines[0].words.map((word) => [word.text, word.start, word.end]), [['虚', 12, 12.5], ['构', 12.5, 13], ['的歌', 13, 14.5]]);
  assert.deepEqual([lines[0].start, lines[0].end, lines[1].end], [12, 15, 18]);
});

test('NetEase\'s lyrics in Rhine\'s shape: word timing with credits and translations, else its lines', () => {
  const reply = {
    status: 'ready',
    lines: [[0, '作词 : 虚构'], [1, '作曲 : 虚构'], [12.01, '虚构的歌'], [16, 'Oh yeah'], [60, '制作人 : 虚构']],
    translations: ['', '', 'A made-up song', '', ''],
    words: '[12000,3000](12000,500,0)虚(12500,500,0)构(13000,1500,0)的歌\n[16000,2000](16000,800,0)Oh (16800,700,0)yeah',
  };
  const timed = neteaseLyrics(reply);
  assert.equal(timed.synced, true);
  assert.deepEqual(texts(timed), ['作词 : 虚构', '作曲 : 虚构', '虚构的歌', 'Oh yeah', '制作人 : 虚构']);
  assert.equal(timed.lines[2].words.length, 3);
  assert.equal(timed.lines[2].translation, 'A made-up song', 'the lines\' translation, by the nearest time');
  // Its own translation for the word timing comes first.
  const own = neteaseLyrics({ ...reply, wordsTranslation: '[00:12.00]Its own translation\n[00:16.00]Second' });
  assert.deepEqual(own.lines.slice(2, 4).map((line) => line.translation), ['Its own translation', 'Second']);
  // NetEase's own offset (set in NetEase, positive sooner) is in its lines already; its word timing and
  // that one's translation take it here.
  const moved = neteaseLyrics({ ...reply, offset: 1, lines: reply.lines.map(([time, text]) => [time - 1, text]), wordsTranslation: '[00:12.00]Its own translation' });
  assert.deepEqual(moved.lines.slice(2, 4).map((line) => line.start), [11, 15]);
  assert.deepEqual([moved.lines[2].words[0].start, moved.lines[2].end], [11, 14]);
  assert.equal(moved.lines[2].translation, 'Its own translation');
  assert.deepEqual(texts(moved), texts(timed), 'the credits stay outside the word-timed lines');
  // Without word timing: the lines with their translations; unsynchronised when a line has no time.
  const plain = neteaseLyrics({ status: 'ready', lines: [[3, ' One '], [1, 'Credit'], [5, '']], translations: ['一', '', ''] });
  assert.deepEqual(plain, { synced: true, lines: [{ start: 1, text: 'Credit' }, { start: 3, text: 'One', translation: '一' }] });
  assert.equal(neteaseLyrics({ status: 'ready', lines: [[null, 'One'], [null, 'Two']] }).synced, false);
  for (const status of ['loading', 'asked', 'none', 'changed']) assert.equal(neteaseLyrics({ status }), null);
  assert.equal(neteaseLyrics({ status: 'ready', lines: [[1, ' ']] }), null);
});

test('NetEase\'s lyrics are read once per song: asked to load them, read again until they are there', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  const realNow = performance.now;
  performance.now = () => now;
  t.after(() => { performance.now = realNow; });
  const replies = [];
  const calls = [];
  const port = { async lyrics(trackId, load) { calls.push([trackId, load]); const reply = replies.shift(); if (reply instanceof Error) throw reply; return reply; } };
  let changes = 0;
  const lyrics = new NeteaseLyrics(() => port, () => { changes += 1; });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const wait = async (ms) => { now += ms; t.mock.timers.tick(ms); await flush(); await flush(); };

  replies.push({ status: 'asked' }, { status: 'loading' }, { status: 'ready', lines: [[1, 'Made-up words']] });
  lyrics.want('7');
  lyrics.want('7');
  await flush();
  assert.deepEqual(calls, [['7', true]], 'asked once, with NetEase asked to load them');
  assert.equal(lyrics.get('7'), undefined);
  await wait(400);
  await wait(400);
  assert.deepEqual(calls, [['7', true], ['7', false], ['7', false]], 'then only read');
  assert.deepEqual(lyrics.get('7'), { synced: true, lines: [{ start: 1, text: 'Made-up words' }] });
  assert.equal(changes, 1);
  lyrics.want('7');
  await flush();
  assert.equal(calls.length, 3, 'known: not read again');

  // None: at once when NetEase answers for the song itself; after asking, once it had time to start.
  calls.length = 0;
  replies.push({ status: 'none' });
  lyrics.want('8');
  await flush();
  assert.equal(lyrics.get('8'), null);
  replies.push({ status: 'asked' }, { status: 'none' }, { status: 'none' }, { status: 'none' });
  lyrics.want('9');
  await flush();
  await wait(400);
  assert.equal(lyrics.get('9'), undefined, 'not yet: NetEase may not have started');
  await wait(400);
  await wait(400);
  assert.equal(lyrics.get('9'), null);

  // NetEase busy with another song's: asked to load them once it is done.
  calls.length = 0;
  replies.push({ status: 'loading' }, { status: 'asked' }, { status: 'ready', lines: [[2, 'Other words']] });
  lyrics.want('10');
  await flush();
  await wait(400);
  await wait(400);
  assert.deepEqual(calls.map(([, load]) => load), [true, true, false]);
  assert.equal(lyrics.get('10').lines[0].text, 'Other words');

  // Another song plays: nothing is kept for it (none for a moment: it no longer plays), the page is
  // told once, and it is not asked again before NetEase's next reading (the page still names it until
  // then, and telling it must not loop); a failed read waits RETRY_MS.
  calls.length = 0;
  const shown = changes;
  replies.push({ status: 'changed' });
  lyrics.want('11');
  await flush();
  assert.equal(lyrics.get('11'), null);
  lyrics.want('11');
  await flush();
  assert.equal(calls.length, 1, 'not asked again at once');
  assert.equal(changes, shown + 1, 'told once');
  now += 2000;
  replies.push({ status: 'none' });
  lyrics.want('11');
  await flush();
  assert.equal(lyrics.get('11'), null, 'asked again after NetEase\'s next reading');
  const warn = console.warn;
  console.warn = () => {};
  replies.push(new Error('网易云调试端口返回了无法识别的内容'));
  lyrics.want('12');
  await flush();
  console.warn = warn;
  calls.length = 0;
  lyrics.want('12');
  await flush();
  assert.equal(calls.length, 0, 'not again at once');
  now += 30_000;
  replies.push({ status: 'none' });
  lyrics.want('12');
  await flush();
  assert.equal(lyrics.get('12'), null);

  // NetEase's own load failed: asked again after RETRY_MS, none meanwhile (not an empty box), never kept as none.
  calls.length = 0;
  const before = changes;
  replies.push({ status: 'asked' }, { status: 'failed' });
  lyrics.want('14');
  await flush();
  await wait(400);
  assert.equal(lyrics.get('14'), null, 'none while it waits to be asked again');
  assert.equal(changes, before + 1, 'shown');
  lyrics.want('14');
  await flush();
  assert.equal(calls.length, 2, 'not asked again at once');
  now += 30_000;
  replies.push({ status: 'ready', lines: [[1, 'Came later']] });
  lyrics.want('14');
  await flush();
  assert.equal(lyrics.get('14').lines[0].text, 'Came later');
  // stop() ends a read: a new read of the same song does not run beside the old one.
  calls.length = 0;
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const realLyrics = port.lyrics;
  port.lyrics = async (trackId, load) => { calls.push([trackId, load]); if (calls.length === 1) { await slow; return { status: 'asked' }; } return { status: 'ready', lines: [[1, 'Once']] }; };
  lyrics.want('15');
  await flush();
  lyrics.stop();
  lyrics.want('15');
  await flush();
  release();
  await flush();
  await wait(400);
  await wait(400);
  assert.deepEqual(calls.map(([, load]) => load), [true, true], 'the ended read asked nothing more');
  assert.equal(lyrics.get('15').lines[0].text, 'Once');
  port.lyrics = realLyrics;

  // A song NetEase never answers for is given up after ten seconds.
  calls.length = 0;
  for (let index = 0; index < 40; index += 1) replies.push({ status: 'loading' });
  lyrics.want('13');
  await flush();
  for (let index = 0; index < 30; index += 1) await wait(400);
  assert.equal(lyrics.get('13'), null, 'given up: none until it is asked again');
  assert.ok(calls.length >= 25 && calls.length <= 27, String(calls.length));
});

test('a local song\'s lyrics are read from the music service, kept, and a song without any is asked again now and then', async (t) => {
  let now = 0;
  const realNow = performance.now;
  performance.now = () => now;
  const realFetch = globalThis.fetch;
  const asked = [];
  const answers = new Map();
  globalThis.fetch = async (url) => {
    asked.push(url);
    const answer = answers.get(url) ?? { status: 204 };
    return new Response(answer.body ?? null, { status: answer.status });
  };
  t.after(() => { performance.now = realNow; globalThis.fetch = realFetch; });
  answers.set('/api/lyrics/track-1', { status: 200, body: new Uint8Array([...new TextEncoder().encode('[00:01.00]'), 0xd0, 0xe9, 0xb9, 0xb9]) });
  assert.deepEqual(await readLocalLyrics('track-1'), { synced: true, lines: [{ start: 1, text: '虚构' }] });
  assert.equal(await readLocalLyrics('track-2'), null, '204: none');
  answers.set('/api/lyrics/track-3', { status: 404 });
  assert.equal(await readLocalLyrics('track-3'), null, 'not in the index');
  answers.set('/api/lyrics/track-4', { status: 403 });
  await assert.rejects(readLocalLyrics('track-4'));

  let changes = 0;
  const local = new LocalLyrics(() => { changes += 1; });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  asked.length = 0;
  local.want('track-1');
  local.want('track-1');
  await settle();
  assert.equal(asked.length, 1);
  assert.equal(local.get('track-1').lines[0].text, '虚构');
  local.want('track-1');
  await settle();
  assert.equal(asked.length, 1, 'kept');
  local.want('track-2');
  await settle();
  assert.equal(local.get('track-2'), null);
  local.want('track-2');
  await settle();
  assert.equal(asked.length, 2, 'none is not asked again at once');
  now += 30_001;
  answers.set('/api/lyrics/track-2', { status: 200, body: new TextEncoder().encode('[00:02.00]Added later') });
  local.want('track-2');
  assert.equal(local.get('track-2'), null, 'still none while it is asked again');
  await settle();
  assert.equal(local.get('track-2').lines[0].text, 'Added later');
  local.want('track-4');
  await settle();
  assert.equal(local.get('track-4'), null, 'an error is none');
  assert.equal(changes, 4);
  assert.equal(asked[0], '/api/lyrics/track-1');
});

test('a scan read again: a local song\'s kept lyrics are read again, the old ones shown until the new ones land', async (t) => {
  const realFetch = globalThis.fetch;
  const asked = [];
  let text = '[00:01.00]Fictional line one OLD';
  let hold;
  globalThis.fetch = async (url) => {
    asked.push(url);
    if (hold) await new Promise((resolve) => { const go = hold; hold = undefined; go.push(resolve); });
    return new Response(new TextEncoder().encode(text), { status: 200 });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const local = new LocalLyrics(() => {});
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  local.want('track-1');
  await settle();
  const old = local.get('track-1');
  assert.equal(old.lines[0].text, 'Fictional line one OLD');
  // The same lyrics again: the same object (nothing drawn again).
  local.refresh();
  local.want('track-1');
  assert.equal(local.get('track-1'), old, 'shown while read again');
  await settle();
  assert.equal(asked.length, 2);
  assert.equal(local.get('track-1'), old, 'unchanged: the same lyrics');
  local.want('track-1');
  await settle();
  assert.equal(asked.length, 2, 'kept again until the next scan');
  // The .lrc edited, then a scan: the new lines.
  text = '[00:01.00]Fictional line one NEW';
  local.refresh();
  local.want('track-1');
  await settle();
  assert.equal(local.get('track-1').lines[0].text, 'Fictional line one NEW');
  // A read on its way when a scan ends is not taken as fresh: it is asked again.
  text = '[00:01.00]Fictional line one NEWER';
  local.refresh();
  const waiting = [];
  hold = waiting;
  local.want('track-1');
  await settle();
  local.refresh();
  waiting[0]();
  await settle();
  local.want('track-1');
  await settle();
  assert.equal(asked.length, 5);
  assert.equal(local.get('track-1').lines[0].text, 'Fictional line one NEWER');
  // Read again when a scan ends (this page's, or the service's own), while 本地音乐 is the source.
  const receive = body(app, 'async function receiveLibrary(', '\n}');
  assert.match(receive, /const scanEnded = !next\.scan\.running &&\s*\(asked \|\| \(libraryReceived && \(previousScan\.running \|\| next\.scan\.finishedAt !== previousScan\.finishedAt\)\)\);/);
  assert.match(receive, /if \(scanEnded && !playerCurrent\) \{\s*localLyrics\.refresh\(\);\s*syncLyrics\(\);\s*\}/);
});

test('the details\' lyrics are the song\'s that plays, asked for and followed only while the details show', () => {
  const sync = body(app, 'function syncLyrics() {', '\n}');
  assert.match(sync, /lyricsView\.attach\(document\.querySelector<HTMLElement>\("#detail-body \.detail-lyrics"\)\);/);
  assert.match(sync, /const source = timelineState\(\) === "shown" \? lyricsSource\(\) : undefined;\s*if \(!source\) return lyricsView\.hide\(\);/, 'the timeline\'s song');
  assert.match(sync, /const open = mode === "detail" && menu === "detail";\s*if \(open\) source\.want\(\);\s*lyricsView\.show\(source\.key, source\.lyrics, source\.clock, open\);/);
  const source = body(app, 'function lyricsSource()', '\nfunction ');
  // NetEase: only while its queue shows (its port is read then), the song its port reports; a lone live track has none.
  assert.match(source, /if \(!netease\.shownQueue\(\)\) return undefined;/);
  assert.match(source, /const id = netease\.debugState\.available \? netease\.debugState\.trackId : undefined;/);
  assert.match(source, /want: \(\) => netease\.lyrics\.want\(id\)/);
  assert.match(source, /const track = loadedTrack\(\);\s*if \(!track\) return undefined;/);
  // A reading that misses (NetEase busy) keeps the same case's lyrics for a few seconds, asking nothing.
  assert.match(source, /if \(!id && kept && kept\.record === record && now - kept\.at < LYRICS_PORT_GRACE_MS\)\s*return \{ key: `netease:\$\{kept\.id\}`, lyrics: netease\.lyrics\.get\(kept\.id\), clock: neteaseLyricsClock, want\(\) \{\} \};/);
  assert.match(app, /const LYRICS_PORT_GRACE_MS = 5000;/);
  // The local clock is the loaded song's own element, never the one still fading out before it.
  const player = read('../src/local_music/connector/music-player.ts');
  assert.match(player, /if \(audio && this\.songTrackId === this\.value\.currentTrack\?\.id && this\.pendingSeek === null && audio\.readyState >= 1\)\s*return seconds\(audio\.currentTime\);\s*return this\.value\.currentTime;/);
  assert.match(app, /const localLyricsClock: LyricsClock = \{\s*position: \(\) => \(loadedTrack\(\) \? player\?\.position : undefined\),\s*playing: \(\) => playerState\?\.transport === "playing",\s*\};/);
  assert.match(app, /const neteaseLyricsClock: LyricsClock = \{\s*position: \(\) => netease\.playbackClock\.position\(performance\.now\(\)\),\s*playing: \(\) => netease\.debugState\.playback === "playing",\s*\};/);
  // Kept with what plays, the menu and the scene; a seek in NetEase moves them at once.
  assert.match(body(app, 'function setMenu(', '\n}'), /syncLyrics\(\);/);
  assert.match(app, /netease\.seekTarget\(position\);\s*updateExternalTimeline\(\);\s*lyricsView\.sync\(\);/);
  assert.match(app, /lyricsChanged: \(\) => syncLyrics\(\),/);
  assert.match(app, /scene\?\.setReduced\(el\.checked\);\s*lyricsView\.setReduced\(el\.checked\);/);
  // Never logged or kept beyond memory.
  for (const file of ['../src/lyrics.ts', '../src/lyrics-view.ts', '../src/netease_music/data/lyrics.ts', '../src/netease_music/connector/lyrics.ts', '../src/local_music/connector/lyrics-api.ts']) {
    const text = read(file);
    assert.doesNotMatch(text, /localStorage|sessionStorage|indexedDB|console\.(log|info|debug)/, file);
  }
  assert.doesNotMatch(read('../src/netease_music/connector/lyrics.ts'), /console\.warn\([^)]*(lines|text|lyrics)\b/);
});

test('the lyrics\' box: a column that follows the song, lit line in ink, its words lit as sung, held by hand', () => {
  assert.match(view, /const FOCUS = 0\.38;/);
  assert.match(view, /const HOLD_MS = 3000;/);
  // Each word of the lit line turns to ink at its start (sung), set by the one timer; nothing runs between
  // (no animations or transitions: 2026-10-17, a fill or a fade kept the page busy every frame).
  assert.match(view, /const sung = word\.start <= position;\s*this\.words\[at\]\?\.classList\.toggle\("sung", sung\);\s*if \(!sung && next === undefined\) next = word\.start;/);
  assert.match(view, /const words = index >= 0 && !this\.reduced \? this\.lyrics\?\.lines\[index\]\?\.words : undefined;/, 'reduced motion lights a line whole');
  assert.doesNotMatch(view, /\.animate\(|getAnimations|requestAnimationFrame/);
  assert.doesNotMatch(css.slice(css.indexOf('.detail-lyrics[data-words="on"]')), /\.lyric-word \{[^}]*transition/);
  assert.match(view, /box\.scrollTo\(\{ top, behavior: smooth \? "smooth" : "instant" \}\);/);
  assert.match(view, /if \(performance\.now\(\) < this\.heldUntil\) return;/);
  // The way back after a hand scroll keeps reduced motion; before the first words the first line waits
  // at the line's place; a missing reading leaves what is lit.
  assert.match(view, /this\.holdTimer = window\.setTimeout\(\(\) => this\.follow\(!this\.reduced, this\.anchor\), HOLD_MS \+ 20\);/);
  assert.match(view, /if \(index < 0 && position < lyrics\.lines\[0\]\.start\) this\.follow\(this\.placed && !this\.reduced, 0\);/);
  assert.match(view, /const position = this\.clock\.position\(\);\s*if \(position === undefined\) return;/);
  assert.match(view, /for \(const event of \["wheel", "touchstart", "pointerdown"\] as const\) box\.addEventListener\(event, this\.hold, \{ passive: true \}\);/);
  // A timer for the next change of line or word, never faster than a frame; slower while the clock stands still.
  assert.match(view, /const next = Math\.min\(nextChange\(lyrics\.lines, position\) \?\? Infinity, word \?\? Infinity\);/);
  assert.match(view, /const wait = Math\.max\(16, \(next - position\) \* 1000 \+ 10\);\s*this\.timer = window\.setTimeout\(\(\) => this\.sync\(\), stalled \? Math\.max\(wait, 250\) : wait\);/);
  // The box: written folded away; the wheel there scrolls it (a scroller), never the songs.
  assert.match(app, /const lyricsBox = '<section class="detail-lyrics" data-lyrics="off" data-motion="off" aria-label="歌词" tabindex="-1"><div class="lyrics-list"><\/div><\/section>';/);
  assert.match(css, /\.music-app \.detail-lyrics \{[^}]*flex: 1 1 0;[^}]*overflow-y: auto;[^}]*scrollbar-width: none;[^}]*container-type: size;/);
  assert.match(css, /\.music-app \.detail-lyrics:is\(\[data-lyrics="off"\], \[data-lyrics="none"\]\) \{\s*display: none;\s*\}/);
  assert.match(css, /\.music-app \.lyrics-list \{\s*padding: calc\(38cqh - 16px\) 0 calc\(62cqh - 16px\);\s*\}/);
  assert.match(css, /\.music-app \.detail-lyrics\[data-motion="on"\]\[data-lyrics="shown"\] \.lyrics-list \{\s*animation: detail-lyrics-rise/);
  assert.match(css, /\.music-app \.detail-lyrics\[data-words="on"\] \.lyric-line\[aria-current="true"\] \.lyric-word \{\s*color: var\(--muted\);\s*\}\s*\.music-app \.detail-lyrics\[data-words="on"\] \.lyric-line\[aria-current="true"\] \.lyric-word\.sung \{\s*color: var\(--ink\);\s*\}/);
  assert.match(css, /\.music-app #album-detail-content > #detail-body \{\s*display: flex;\s*flex-direction: column;\s*flex: 1 0 auto;\s*\}/);
  assert.match(app, /function scrollsNatively\(target: EventTarget \| null\)/);
});

test('the debugging port\'s lyrics: read for the song that plays, NetEase\'s own action to load them, nothing else', () => {
  const script = body(rust, 'const LYRICS_BODY: &str = r#"', '"#;');
  assert.match(script, /if \(playing\.resourceTrackId == null \|\| String\(playing\.resourceTrackId\) !== id\) return \{ status: 'changed' \};/);
  assert.match(script, /store\.dispatch\(\{ type: 'async:lyric\/fetchLyric', payload: \{ force: true \} \}\);/);
  assert.match(script, /if \(!load\) return \{ status: lyric\.isLyricFetchFailed === true \? 'failed' : 'none' \};/);
  assert.match(script, /offset: typeof lyric\.offset === 'number' && Number\.isFinite\(lyric\.offset\) \? lyric\.offset : 0,/);
  assert.equal((script.match(/dispatch\(/g) || []).length, 1);
  assert.doesNotMatch(script, /cookie|localStorage|curPlayingList|localTrack|filename|fetch\(/i);
  assert.match(read('../src-tauri/permissions/music.toml'), /"netease_debug_lyrics"/);
  assert.match(read('../src-tauri/src/main.rs'), /netease_debug_seek,\s*netease_debug_lyrics,\s*netease_debug_restart/);
});
