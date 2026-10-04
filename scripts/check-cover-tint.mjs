// The colour a case's index square takes from its cover (src/cover-tint.ts). Inputs are built
// by hand in the format coverMipmaps stores: colour times coverage, sRGB-encoded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { coverTint, coverTintFromPixels, coverTintForTheme, COVER_TINT_SIZE, COVER_TINT_THEME, COVER_TINT_CHROMA_MAX } from '../src/cover-tint.ts';
import { coverMipmaps } from '../src/cover-mipmaps.ts';
import { paintCoverTile } from '../src/cover-tiles.ts';

const SIZE = COVER_TINT_SIZE;
const lin = (byte) => { const v = byte / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const enc = (v) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const linearOf = (hex) => rgb(hex).map(lin);
const hexOf = (tint) => '#' + tint.map((v) => enc(v).toString(16).padStart(2, '0')).join('');
function oklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
const lch = (tint) => { const [L, a, b] = oklab(tint); return { L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 }; };
const distance = (x, y) => { const a = oklab(x), b = oklab(y); return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); };
const hueGap = (x, y) => Math.abs(((x - y + 540) % 360) - 180);

/** paint(x, y) -> [hex, alpha 0..1] or hex; stored premultiplied like the mip levels. */
function level(paint, size = SIZE) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const value = paint(x, y, size);
    const [hex, alpha] = Array.isArray(value) ? value : [value, 1];
    const p = (y * size + x) * 4;
    rgb(hex).forEach((byte, c) => { data[p + c] = enc(lin(byte) * alpha); });
    data[p + 3] = Math.round(alpha * 255);
  }
  return data;
}
const flat = (hex) => level(() => hex);
const tintOf = (paint, size = SIZE) => coverTintFromPixels(typeof paint === 'string' ? flat(paint) : level(paint, size), size);

const IVORY = linearOf('#fff7ed'), AMBER = { day: '#dcb47f', night: '#d2a066', dusk: '#b99a76' };

test('nothing painted gives no tint, so the caller keeps the fixed amber', () => {
  assert.equal(coverTintFromPixels(new Uint8Array(SIZE * SIZE * 4), SIZE), undefined);
  assert.equal(coverTintFromPixels(new Uint8Array(8), SIZE), undefined);
  assert.equal(tintOf((x, y) => ['#ff0000', x === 0 && y === 0 ? 1 : 0]), undefined, 'under 2% coverage');
  assert.equal(coverTint([]), undefined);
  // The blank chain a failed print resolves with (cover-tiles blankLevels).
  const blank = [];
  for (let width = 256; width >= 1; width /= 2) blank.push({ data: new Uint8Array(width * width * 4), width, height: width });
  assert.equal(coverTint(blank), undefined);
});

test('a mip chain is read at its 16 px level', () => {
  const size = 256;
  const chain = (red) => {
    const source = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) source.set(red(x) ? [212, 35, 43, 255] : [240, 240, 240, 255], (y * size + x) * 4);
    return coverMipmaps(source, size);
  };
  const at = (levels, width) => { const entry = levels.find((item) => item.width === width); return coverTintFromPixels(entry.data, width); };
  // Hairlines: vivid red at 256 px, an all-over pale pink from 16 px down.
  const hairlines = chain((x) => x % 16 === 0);
  assert.deepEqual(coverTint(hairlines), at(hairlines, 16));
  assert.ok(distance(coverTint(hairlines), at(hairlines, size)) > 0.05, 'the full tile would give another colour');
  // One stripe as wide as a 16 px texel: still red at 16 px, washed out below.
  const stripe = chain((x) => x >= 16 && x < 32);
  assert.deepEqual(coverTint(stripe), at(stripe, 16));
  assert.ok(lch(coverTint(stripe)).C > 0.14);
  assert.ok(distance(coverTint(stripe), at(stripe, 8)) > 0.05 && distance(coverTint(stripe), at(stripe, 1)) > 0.05, 'coarser levels would give another colour');
  // A chain that starts below 16 px is read at its largest level.
  const small = coverMipmaps(new Uint8ClampedArray(8 * 8 * 4).fill(255).map((value, i) => (i % 4 === 1 ? 60 : value)), 8);
  assert.deepEqual(coverTint(small), coverTintFromPixels(small[0].data, 8));
});

test('a cover of the fixed amber gives the fixed amber', () => {
  assert.ok(distance(tintOf(AMBER.day), linearOf(AMBER.day)) < 0.004, hexOf(tintOf(AMBER.day)));
});

test('a flat cover keeps its hue, inside the accent band', () => {
  for (const hex of ['#e60012', '#f08a1c', '#ffe600', '#2e9e5b', '#11a7b5', '#2447b8', '#8e4fc9', '#ff0a9c', '#14213d', '#0f3322', '#bfe6ff', '#f6ead9', '#3a0a12']) {
    const input = lch(linearOf(hex)), output = lch(tintOf(hex));
    assert.ok(hueGap(input.h, output.h) < 3, `${hex}: hue ${input.h.toFixed(0)} -> ${output.h.toFixed(0)}`);
    assert.ok(output.L >= 0.499 && output.L <= 0.861, `${hex}: L ${output.L}`);
    assert.ok(output.C >= 0.07 && output.C <= 0.151, `${hex}: C ${output.C}`);
    if (input.L >= 0.5 && input.L <= 0.8 && input.C >= 0.075 && input.C <= 0.15) assert.ok(distance(tintOf(hex), linearOf(hex)) < 0.004, `${hex} is already usable and stays`);
  }
  assert.ok(lch(tintOf('#ffe600')).L > 0.84, 'vivid yellow stays light enough to be yellow');
  assert.ok(lch(tintOf('#bfe6ff')).L <= 0.801, 'a pale cover is not allowed to melt into the ivory');
});

test('covers without colour give their own grey, never a hue', () => {
  for (const [hex, light] of [['#ffffff', 0.8], ['#fafaf8', 0.8], ['#000000', 0.5], ['#0b0b0c', 0.5], ['#777777', null]]) {
    const output = lch(tintOf(hex));
    assert.ok(output.C < 0.004, `${hex}: C ${output.C}`);
    if (light) assert.ok(Math.abs(output.L - light) < 0.002, `${hex}: L ${output.L}`);
  }
  const mid = lch(tintOf('#777777'));
  assert.ok(Math.abs(mid.L - lch(linearOf('#777777')).L) < 0.002, 'mid grey keeps its lightness');
  const noisy = lch(tintOf((x, y) => ['#808080', '#828080', '#808280', '#808082'][(x * 7 + y * 3) % 4]));
  assert.ok(noisy.C < 0.004, `grey with chroma noise: C ${noisy.C}`);
});

test('one vivid accent on a neutral field wins; a speck does not', () => {
  const stripe = lch(tintOf((x) => (x === 1 ? '#d4232b' : '#e8eaeb'))); // 6% red stripe
  assert.ok(hueGap(stripe.h, lch(linearOf('#d4232b')).h) < 6 && stripe.C > 0.14, `stripe: h ${stripe.h} C ${stripe.C}`);
  const cab = lch(tintOf((x, y) => (y === 10 && x >= 4 && x < 14 ? '#f6c700' : '#2a2c30'))); // 4% yellow on dark grey
  assert.ok(hueGap(cab.h, lch(linearOf('#f6c700')).h) < 6 && cab.C > 0.12 && cab.L > 0.7, `cab: h ${cab.h} C ${cab.C} L ${cab.L}`);
  const speck = lch(tintOf((x, y) => (x === 8 && y === 8 ? '#ea4335' : '#ffffff'))); // 0.4%
  assert.ok(speck.C < 0.01 && speck.L > 0.79, `a speck leaves the white sleeve's light grey: C ${speck.C} L ${speck.L}`);
});

test('two rival hues give one of them, not their muddy mean', () => {
  const teal = lch(linearOf('#1f8a8a')).h, orange = lch(linearOf('#e8862e')).h;
  const split = lch(tintOf((x, y) => (x + y < SIZE ? '#1f8a8a' : '#e8862e')));
  assert.ok(Math.min(hueGap(split.h, teal), hueGap(split.h, orange)) < 4 && split.C > 0.08, `split: h ${split.h} C ${split.C}`);
  const stripes = ['#e63946', '#f4a023', '#f9e04c', '#3bb273', '#2f7fd8', '#8e4fc9'];
  const rainbow = lch(tintOf((x) => stripes[Math.min(5, Math.floor((x * 6) / SIZE))]));
  assert.ok(stripes.some((hex) => hueGap(rainbow.h, lch(linearOf(hex)).h) < 8) && rainbow.C > 0.12, `rainbow: h ${rainbow.h} C ${rainbow.C}`);
  const field = lch(tintOf((x, y) => (Math.hypot(x - 9.5, y - 7) < 4 ? '#f2c230' : '#2447b8'))); // 20% yellow disc on blue
  assert.ok(hueGap(field.h, lch(linearOf('#2447b8')).h) < 4, `the larger field wins: h ${field.h}`);
});

test('a hue on the seam of the hue circle is gathered from both of its sides', () => {
  // OKLab hue ±180° (a blue-green) is where the hue histogram wraps: 170° and 190° fall
  // into its last and its first bin, and together they are one colour, not two rivals.
  const [below, above, rival] = [170, 190, 97].map((hue) => hexOf(fromOklab([0.7, 0.09 * Math.cos((hue * Math.PI) / 180), 0.09 * Math.sin((hue * Math.PI) / 180)])));
  const output = lch(tintOf((x, y) => ((x + y) % 2 ? below : above)));
  assert.ok(hueGap(output.h, 180) < 3 && output.C > 0.08, `${below} with ${above}: h ${output.h} C ${output.C}`);
  // Against a rival hue that covers more than either side alone (41%) but less than both (59%).
  const shared = lch(tintOf((x, y) => (y * SIZE + x < 106 ? rival : (x + y) % 2 ? below : above)));
  assert.ok(hueGap(shared.h, 180) < 3, `the two sides count together against ${rival}: h ${shared.h}`);
});

test('a shadow\'s cast does not outvote the lit part', () => {
  // 56% dark forest green under 44% hazy lavender of the same chroma: by area and chroma
  // alone the forest would win.
  const output = lch(tintOf((x, y) => (y < 7 ? '#a898b0' : '#2a3a28')));
  assert.ok(hueGap(output.h, lch(linearOf('#a898b0')).h) < 8, `h ${output.h}`);
  // A cover that is dark all over still gets its own hue, at full strength.
  const midnight = lch(tintOf('#111a26'));
  assert.ok(hueGap(midnight.h, lch(linearOf('#111a26')).h) < 3 && midnight.C > 0.07 && Math.abs(midnight.L - 0.5) < 0.002, `midnight: h ${midnight.h} C ${midnight.C} L ${midnight.L}`);
});

test('margins do not count: transparent, or stored premultiplied', () => {
  const full = tintOf('#2e9e5b');
  const margin = tintOf((x, y) => ['#2e9e5b', x >= 4 && x < 12 && y >= 4 && y < 12 ? 1 : 0]);
  const half = tintOf(() => ['#2e9e5b', 0.5]);
  assert.ok(distance(full, margin) < 0.002 && distance(full, half) < 0.01, `${hexOf(full)} ${hexOf(margin)} ${hexOf(half)}`);
  // A grey's lightness is weighed by coverage too.
  const veil = tintOf(() => ['#a0a0a0', 0.5]);
  assert.ok(distance(veil, tintOf('#a0a0a0')) < 0.01, `${hexOf(veil)} ${hexOf(tintOf('#a0a0a0'))}`);
  const bars = (bar) => tintOf((x, y) => (y >= 5 && y < 11 ? '#2f9fb4' : bar));
  const black = lch(bars('#000000')), white = lch(bars('#ffffff')), teal = lch(linearOf('#2f9fb4'));
  assert.ok(hueGap(black.h, teal.h) < 3 && hueGap(white.h, teal.h) < 3 && distance(bars('#000000'), bars('#ffffff')) < 0.01,
    'baked letterbox bars, black or white, give the same index square');
});

test('every index square stays apart from the ivory shell and is the same at 16 and 32 px', () => {
  const covers = ['#ffffff', '#fff7ed', '#f6ead9', '#ffe600', '#bfe6ff', '#f9d5e5', '#000000', '#14213d', '#e60012', '#777777'];
  for (const hex of covers) {
    const tint = tintOf(hex);
    assert.ok(distance(tint, IVORY) > 0.12, `${hex} -> ${hexOf(tint)} is ${distance(tint, IVORY).toFixed(3)} from the ivory`);
    assert.ok(distance(tint, coverTintFromPixels(level(() => hex, 32), 32)) < 0.002);
    for (const theme of ['night', 'dusk']) {
      const themed = lch(coverTintForTheme(tint, theme));
      assert.ok(themed.L >= 0.47 && themed.L <= 0.8, `${hex} ${theme}: L ${themed.L}`);
    }
  }
});

test('night and dusk: the fixed amber lands on its hand-picked values; hue is kept', () => {
  const day = linearOf(AMBER.day);
  assert.deepEqual(coverTintForTheme(day, 'day'), day);
  assert.ok(distance(coverTintForTheme(day, 'night'), linearOf(AMBER.night)) < 0.01, hexOf(coverTintForTheme(day, 'night')));
  assert.ok(distance(coverTintForTheme(day, 'dusk'), linearOf(AMBER.dusk)) < 0.01, hexOf(coverTintForTheme(day, 'dusk')));
  for (const hex of ['#bd4a45', '#3b5cb8', '#2b9455', '#e6d450', '#8e55b2', '#43668d']) {
    const base = lch(linearOf(hex)), night = lch(coverTintForTheme(linearOf(hex), 'night')), dusk = lch(coverTintForTheme(linearOf(hex), 'dusk'));
    assert.ok(hueGap(base.h, night.h) < 2 && hueGap(base.h, dusk.h) < 2, `${hex}: hue kept`);
    assert.ok(Math.abs(night.L - (0.105 + 0.8 * base.L)) < 0.003 && Math.abs(dusk.L - (0.071 + 0.8 * base.L)) < 0.003, `${hex}: lightness`);
    assert.ok(night.C <= Math.max(base.C, 0.15) + 0.002 && dusk.C < base.C, `${hex}: chroma`);
  }
  const grey = lch(coverTintForTheme(linearOf('#797979'), 'night'));
  assert.ok(grey.C < 0.003, 'grey stays grey');
});

test('day changes nothing, and each theme\'s three numbers are the ones coverTintForTheme applies', () => {
  // The case detail shader blends these numbers during a theme change, so day must be the
  // mapping that leaves a tint alone: no lightness offset, full slope, chroma unscaled.
  assert.deepEqual(COVER_TINT_THEME.day, [0, 1, 1]);
  assert.deepEqual(Object.keys(COVER_TINT_THEME), ['day', 'night', 'dusk']);
  // Muted, close to the chroma limit, and beyond it (night scales, stops at the limit, leaves alone).
  const tints = ['#dcb47f', '#43668d', '#d98a9c', '#5f8fd0', '#b06a2c', '#9a4f7a', '#2e9e5b', '#8e55b2', '#3b5cb8', '#bd4a45', '#c0392b', '#797979'];
  const reached = { scaled: 0, limited: 0, kept: 0 };
  for (const hex of tints) {
    const tint = linearOf(hex), base = lch(tint), hue = (base.h * Math.PI) / 180;
    assert.deepEqual(coverTintForTheme(tint, 'day'), tint, `${hex}: day is the tint itself`);
    for (const theme of ['day', 'night', 'dusk']) {
      const [offset, slope, chroma] = COVER_TINT_THEME[theme];
      const C = Math.min(base.C * chroma, Math.max(base.C, COVER_TINT_CHROMA_MAX));
      const expected = fromOklab([offset + slope * base.L, C * Math.cos(hue), C * Math.sin(hue)]);
      assert.ok(Math.min(...expected) >= 0 && Math.max(...expected) <= 1, `${hex} ${theme}: displayable, so chroma is not reduced`);
      const actual = coverTintForTheme(tint, theme);
      // Day's numbers through the mapping return the tint, up to the OKLab constants' round trip.
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(actual[c] - expected[c]) < (theme === 'day' ? 1e-6 : 1e-9),
        `${hex} ${theme}: channel ${c} is ${actual[c]}, the theme's numbers give ${expected[c]}`);
      if (theme === 'night') reached[base.C * chroma <= COVER_TINT_CHROMA_MAX ? 'scaled' : base.C <= COVER_TINT_CHROMA_MAX ? 'limited' : 'kept']++;
    }
  }
  assert.ok(reached.scaled && reached.limited && reached.kept, `night reaches all three chroma cases: ${JSON.stringify(reached)}`);
});

test('both painters compute a tint only on the branch that painted real art (source)', () => {
  for (const file of ['cover-worker.ts', 'cover-tiles.ts']) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.equal(source.match(/\bcoverTint\(/g)?.length, 1, `${file} computes the tint in one place`);
    const guarded = source.match(/\btint: (\w+) \? coverTint\(levels\) : undefined\b/);
    assert.ok(guarded, `${file}: the tint is conditional and absent otherwise, so the case keeps its amber`);
    const art = guarded[1];
    // The image is what loading the cover gave: its address, or the fallback rendition of the same cover.
    assert.match(source, new RegExp(String.raw`const ${art} = \(\w+\.url \? await \w+\(\w+\.url\) : undefined\)\s*\?\? \(\w+\.fallbackUrl \? await \w+\(\w+\.fallbackUrl\) : undefined\);`), `${file}: the condition is the loaded image`);
    assert.match(source, new RegExp(String.raw`paintCoverArt\([^;]*\b${art}\b`), `${file}: and that image is what was painted`);
  }
});

// A 2D context double: real art paints its own colour, a missing cover the grey card that
// paintCoverArt fills. Everything else the painter calls is ignored.
function fakeContext() {
  let colour = [0, 0, 0, 0];
  const context = {
    drawImage(source) { colour = [...source.colour, 255]; },
    fillRect() { colour = [...rgb(context.fillStyle), 255]; },
    getImageData: (_x, _y, width, height) => ({ data: Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) => colour[i % 4]) }),
  };
  return new Proxy(context, { get: (target, key) => (key in target ? target[key] : () => {}) });
}
async function withGlobals(doubles, run) {
  const saved = Object.keys(doubles).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  for (const [name, value] of Object.entries(doubles)) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  try {
    return await run();
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}
const RED = [212, 35, 43];
// What a painter must reply for: real art, no cover at all, and a cover that fails to load.
const requests = [['art', { url: 'art.jpg' }], ['no cover', {}], ['a cover that fails to load', { url: 'broken.jpg' }]];
function assertPainted(name, tile) {
  const read = coverTint(tile.levels);
  if (name === 'art') {
    assert.ok(tile.tint, 'real art gives a tint');
    assert.deepEqual(tile.tint, read, 'real art: the tint of the painted levels');
    assert.ok(hueGap(lch(tile.tint).h, lch(RED.map(lin)).h) < 3, `real art: its own hue, ${hexOf(tile.tint)}`);
    return;
  }
  // The card is paintable: read like art, its grey would come back as a dull square of its own.
  assert.ok(read && distance(read, linearOf(AMBER.day)) > 0.05, `${name}: the missing-cover card was painted`);
  assert.equal(tile.tint, undefined, `${name}: the card gives no tint, so the square stays amber`);
}

test('the main-thread painter leaves the missing-cover card without a tint', async () => {
  class Image {
    naturalWidth = 600; naturalHeight = 400; colour = RED;
    decode() { return this.src.startsWith('art') ? Promise.resolve() : Promise.reject(new Error('no image')); }
  }
  const document = { createElement: () => ({ width: 0, height: 0, getContext: fakeContext }) };
  await withGlobals({ document, Image }, async () => {
    for (const [name, request] of requests) assertPainted(name, await paintCoverTile({ size: SIZE, title: 'Album', ...request }));
  });
});

test('the cover worker leaves the missing-cover card without a tint', async () => {
  const replies = new Map();
  const self = { postMessage: (reply) => replies.get(reply.id)?.(reply) };
  class OffscreenCanvas { getContext() { return fakeContext(); } }
  const fetch = async (url) => ({ ok: url.startsWith('art'), blob: async () => ({ colour: RED }) });
  const createImageBitmap = async (blob) => ({ width: 600, height: 400, colour: blob.colour, close() {} });
  await withGlobals({ self, OffscreenCanvas, fetch, createImageBitmap }, async () => {
    await import('../src/cover-worker.ts');
    let id = 1;
    for (const [name, request] of requests) {
      const reply = new Promise((resolve) => replies.set(id, resolve));
      self.onmessage({ data: { id: id++, size: SIZE, title: 'Album', ...request } });
      const tile = await reply;
      assert.equal(tile.error, undefined, `${name}: painted in the worker`);
      assertPainted(name, tile);
    }
  });
});
