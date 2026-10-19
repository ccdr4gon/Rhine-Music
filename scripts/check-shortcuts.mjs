import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SHORTCUTS, SLOTS, actionKeys, allowed, assign, changed, clear, eventCode, holder, keyLabel,
  reset, sanitize, shortcutEvent, shortcutTable, slotKey, spokenKey,
} from '../src/shortcuts.ts';

const key = (code, extra = {}) => ({ code, key: '', ctrlKey: false, altKey: false, metaKey: false, isComposing: false, keyCode: 0, ...extra });

test('the defaults are the keys the scenes have always had, and every one can be changed', () => {
  const defaults = Object.fromEntries(SHORTCUTS.map((info) => [info.id, [info.key, info.repeat]]));
  assert.deepEqual(defaults, {
    pause: ['Space', false], play: ['KeyP', false], playing: ['KeyL', false],
    songUp: ['ArrowUp', true], songDown: ['ArrowDown', true], listLeft: ['ArrowLeft', true], listRight: ['ArrowRight', true],
    open: ['Enter', false], songs: ['KeyS', false], back: ['Escape', false], search: ['Slash', false],
  });
  // Every action may have one 附加键; no action has one by default.
  for (const info of SHORTCUTS) {
    assert.equal(slotKey({}, `${info.id}.extra`), null);
    assert.deepEqual(actionKeys({}, info.id), [info.key]);
  }
  assert.equal(SLOTS.length, SHORTCUTS.length * 2);
  // One table for every key (the numpad's / also opens 搜索 while 搜索 keeps the / key).
  assert.deepEqual(Object.fromEntries(shortcutTable({})), {
    Space: 'pause', KeyP: 'play', KeyL: 'playing', ArrowUp: 'songUp', ArrowDown: 'songDown', ArrowLeft: 'listLeft',
    ArrowRight: 'listRight', Enter: 'open', KeyS: 'songs', Escape: 'back', Slash: 'search', NumpadDivide: 'search',
  });
  assert.equal(shortcutTable({ search: 'KeyF' }).get('NumpadDivide'), undefined);
  assert.equal(shortcutTable({ 'songs.extra': 'NumpadDivide' }).get('NumpadDivide'), 'songs');
});

test('a key a user gives: letters, digits, symbols, the numpad and the named keys; never Tab, Backspace, Delete, function or media keys', () => {
  for (const code of ['KeyA', 'KeyP', 'KeyZ', 'Digit0', 'Digit9', 'Slash', 'Minus', 'BracketLeft', 'Backquote', 'Quote', 'IntlBackslash',
    'Numpad5', 'NumpadAdd', 'NumpadDivide', 'Space', 'Enter', 'Escape', 'ArrowUp', 'ArrowLeft', 'Home', 'End', 'PageUp', 'PageDown', 'Insert']) {
    assert.ok(allowed(code), code);
  }
  for (const code of ['Tab', 'Backspace', 'Delete', 'F1', 'F5', 'F11', 'F12', 'MediaPlayPause', 'AudioVolumeUp', 'ShiftLeft', 'ControlLeft',
    'AltRight', 'MetaLeft', 'CapsLock', 'ContextMenu', 'PrintScreen', 'NumpadEnter', '']) {
    assert.ok(!allowed(code), code);
  }
});

test('events: the physical key, without Ctrl, Alt or Win, and not while an IME composes', () => {
  assert.equal(eventCode(key('KeyS', { key: 'ß' })), 'KeyS', 'the physical key, whatever the layout types');
  assert.equal(eventCode(key('NumpadDivide', { key: '/' })), 'NumpadDivide', 'the numpad / is its own key');
  assert.equal(eventCode(key('NumpadEnter', { key: 'Enter' })), 'Enter', 'the numpad Enter is Enter, as it always opened the details');
  assert.equal(eventCode(key('Numpad8', { key: 'ArrowUp' })), 'ArrowUp', 'the numpad with NumLock off: its arrows');
  assert.equal(eventCode(key('Numpad8', { key: '8' })), 'Numpad8', 'and with NumLock on, its digits');
  assert.equal(eventCode(key('Quote', { key: 'Dead' })), 'Quote', 'a dead key, by its code');
  assert.equal(eventCode(key('', { key: 's' })), 'KeyS', 'a typed key without a code');
  assert.equal(eventCode(key('', { key: '7' })), 'Digit7');
  assert.equal(eventCode(key('', { key: '/' })), 'Slash');
  assert.equal(eventCode(key('', { key: ' ' })), 'Space');
  assert.equal(eventCode(key('', { key: 'ArrowLeft' })), 'ArrowLeft');
  assert.equal(eventCode(key('', { key: 'Unidentified' })), '');
  assert.ok(shortcutEvent(key('KeyS')));
  assert.ok(shortcutEvent(key('KeyS', { shiftKey: true })), 'Shift is ignored, as for S, P and L before');
  for (const extra of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { keyCode: 229 }]) assert.ok(!shortcutEvent(key('KeyS', extra)));
});

test('giving a key: a free one is taken, a held one swaps, a refused one is refused', () => {
  let r = assign({}, 'songs', 'KeyJ');
  assert.ok(r.ok);
  assert.deepEqual(r.overrides, { songs: 'KeyJ' });
  assert.equal(r.moved, undefined);
  // L to 播放列表: 回到正在播放的歌 takes 播放列表's previous key.
  r = assign(r.overrides, 'songs', 'KeyL');
  assert.ok(r.ok);
  assert.deepEqual(r.moved, { slot: 'playing', key: 'KeyJ' });
  assert.deepEqual([actionKeys(r.overrides, 'songs'), actionKeys(r.overrides, 'playing')], [['KeyL'], ['KeyJ']]);
  // Pause / resume on K: Space is then nobody's.
  r = assign({}, 'pause', 'KeyK');
  assert.deepEqual(r.overrides, { pause: 'KeyK' });
  assert.equal(shortcutTable(r.overrides).get('Space'), undefined);
  // Space to 播放选中的歌: the two swap.
  r = assign({}, 'play', 'Space');
  assert.deepEqual(r.moved, { slot: 'pause', key: 'KeyP' });
  assert.deepEqual(Object.fromEntries(['Space', 'KeyP'].map((code) => [code, shortcutTable(r.overrides).get(code)])), { Space: 'play', KeyP: 'pause' });
  // A 附加键 that takes a key another holds leaves that other with none (a 附加键 had none).
  r = assign({}, 'songDown.extra', 'KeyS');
  assert.deepEqual(r.moved, { slot: 'songs', key: null });
  assert.deepEqual(actionKeys(r.overrides, 'songs'), []);
  assert.deepEqual(actionKeys(r.overrides, 'songDown'), ['ArrowDown', 'KeyS']);
  // Esc moves only by a swap (it cancels while a key is being set).
  r = assign({}, 'back', 'KeyB');
  assert.deepEqual(r.overrides, { back: 'KeyB' });
  assert.equal(holder(r.overrides, 'Escape'), undefined);
  // Refused keys, and its own key again.
  assert.deepEqual(assign({}, 'songs', 'F5'), { ok: false, reason: 'not-allowed' });
  assert.deepEqual(assign({}, 'songs', 'Tab'), { ok: false, reason: 'not-allowed' });
  r = assign({}, 'songs', 'KeyS');
  assert.ok(r.ok);
  assert.deepEqual(r.overrides, {});
  assert.equal(holder({}, 'Space'), 'pause');
});

test('clearing and resetting', () => {
  let o = clear({}, 'search');
  assert.deepEqual(o, { search: null });
  assert.deepEqual(actionKeys(o, 'search'), []);
  assert.ok(changed(o, 'search'));
  // Any action, the arrows' and Space's included.
  assert.deepEqual(actionKeys(clear({}, 'pause'), 'pause'), []);
  assert.deepEqual(actionKeys(clear({}, 'songUp'), 'songUp'), []);
  o = assign(o, 'search.extra', 'KeyF').overrides;
  assert.deepEqual(actionKeys(o, 'search'), ['KeyF']);
  assert.deepEqual(reset(o, 'search'), { overrides: {}, moved: undefined });
  // A default another action took in a swap comes back the same way.
  o = assign({}, 'playing', 'KeyS').overrides;
  assert.deepEqual([actionKeys(o, 'songs'), actionKeys(o, 'playing')], [['KeyL'], ['KeyS']]);
  const back = reset(o, 'songs');
  assert.deepEqual(back.moved, { slot: 'playing', key: 'KeyL' });
  assert.deepEqual(back.overrides, {});
  // 播放列表 cleared after the swap: its 恢复默认 does not leave 回到正在播放的歌 with no key, its own L being free...
  o = clear(assign({}, 'playing', 'KeyS').overrides, 'songs');
  assert.deepEqual(reset(o, 'songs'), { overrides: {}, moved: { slot: 'playing', key: 'KeyL' } });
  // ... and with L taken by another, it has none (said in the message).
  o = clear(assign(assign({}, 'playing', 'KeyS').overrides, 'search', 'KeyL').overrides, 'songs');
  const none = reset(o, 'songs');
  assert.deepEqual(none.moved, { slot: 'playing', key: null });
  assert.deepEqual(actionKeys(none.overrides, 'playing'), []);
  // Space back to pause / resume after a swap.
  o = assign({}, 'play', 'Space').overrides;
  assert.deepEqual(reset(o, 'pause'), { overrides: {}, moved: { slot: 'play', key: 'KeyP' } });
});

test('a saved preference is cleaned: its shape, unknown keys, defaults, clashes', () => {
  for (const bad of [null, 'KeyS', ['KeyS'], 3]) assert.deepEqual(sanitize(bad), { overrides: {}, reverted: false });
  // As data/preferences.json gives it back: keys sorted, defaults written out, a cleared key, a 附加键.
  assert.deepEqual(sanitize({ 'playing': 'KeyL', 'search': null, 'songDown.extra': 'KeyJ', 'songs': 'KeyS' }), {
    overrides: { search: null, 'songDown.extra': 'KeyJ' }, reverted: false,
  });
  // Every action's key, Space's included; a cleared 附加键 is none, its default.
  assert.deepEqual(sanitize({ pause: 'KeyK', play: 'Space', 'open.extra': null }), { overrides: { pause: 'KeyK', play: 'Space' }, reverted: false });
  // Refused keys and nonsense.
  assert.deepEqual(sanitize({ songs: 'F5', playing: 42, back: 'Tab' }), { overrides: {}, reverted: true });
  // Two slots on one key (an older version, a hand-edited file): both go back to their defaults.
  assert.deepEqual(sanitize({ songs: 'KeyJ', playing: 'KeyJ' }), { overrides: {}, reverted: true });
  assert.deepEqual(sanitize({ 'songUp.extra': 'KeyS' }), { overrides: {}, reverted: true }, 'S is still 播放列表\'s');
  // A slot a later version knows and this one does not is kept for it.
  assert.deepEqual(sanitize({ 'volumeUp': 'Equal', songs: 'KeyJ' }), { overrides: { volumeUp: 'Equal', songs: 'KeyJ' }, reverted: false });
});

test('labels: as printed on the keyboard, and in words for a screen reader', () => {
  assert.equal(keyLabel('KeyS'), 'S');
  assert.equal(keyLabel('Digit1'), '1');
  assert.equal(keyLabel('Slash'), '/');
  assert.equal(keyLabel('Space'), 'SPACE');
  assert.equal(keyLabel('Escape'), 'ESC');
  assert.equal(keyLabel('ArrowUp'), '↑');
  assert.equal(keyLabel('PageDown'), 'PGDN');
  assert.equal(keyLabel('Numpad1'), 'NUM 1');
  assert.equal(keyLabel('NumpadAdd'), 'NUM +');
  assert.equal(keyLabel('NumpadDivide'), 'NUM /');
  assert.equal(keyLabel('Equal', new Map([['Equal', '́']])), '=', 'a dead key\'s combining mark is not a label');
  // The layout's own characters: Dvorak's letter on the S key, QWERTZ's ß, a layout's - on the / key.
  const layout = new Map([['KeyS', 'o'], ['Minus', 'ß'], ['Slash', '-'], ['KeyQ', '  ']]);
  assert.equal(keyLabel('KeyS', layout), 'O');
  assert.equal(keyLabel('Minus', layout), 'ß', 'not SS: upper case only where it stays one character');
  assert.equal(keyLabel('Slash', layout), '-');
  assert.equal(keyLabel('KeyQ', layout), 'Q', 'blank: from the code');
  assert.equal(spokenKey('ArrowLeft'), '左方向键');
  assert.equal(spokenKey('Space'), '空格键');
  assert.equal(spokenKey('Home'), 'Home 键');
  assert.equal(spokenKey('KeyS'), 'S');
});
