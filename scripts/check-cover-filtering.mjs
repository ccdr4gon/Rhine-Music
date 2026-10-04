import test from 'node:test';
import assert from 'node:assert/strict';
import { SRGBColorSpace, LinearMipmapNearestFilter, Group, Mesh, MeshLambertMaterial, PlaneGeometry, Texture, Vector4 } from 'three';
import { coverMipmaps, CoverMipTexture, filterCoverShader } from '../src/cover-filtering.ts';
import { CoverAtlas, coverArtScale } from '../src/cover-atlas.ts';
import { readFileSync } from 'node:fs';
import { CoverTiles, sizedCoverUrl } from '../src/cover-tiles.ts';
import { applyTextureQuality } from '../src/quality-renderer.ts';

const solid = (size, rgba) => Uint8Array.from({ length: size * size * 4 }, (_, i) => rgba[i % 4]);
const decode = (byte) => {
  const x = byte / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};

test('opaque near artwork is unchanged; smaller levels average linear brightness', () => {
  const input = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
  const mips = coverMipmaps(input, 2);
  assert.deepEqual(mips[0].data, input);
  assert.deepEqual([...mips[1].data], [188, 188, 188, 255]);
  assert.ok(Math.abs(decode(mips[1].data[0]) - 0.5) < 0.003);
});

test('transparent RGB cannot darken or tint the surviving print; coverage has no floor', () => {
  const mips = coverMipmaps(new Uint8Array([
    255, 0, 0, 255, 0, 255, 0, 0,
    0, 0, 255, 0, 255, 255, 255, 0,
  ]), 2);
  assert.deepEqual([...mips[1].data], [137, 0, 0, 64]);
  assert.ok(Math.abs(decode(137) / (64 / 255) - 1) < 0.005, '8-bit encoding stays within half a percent here');
  const tiny = solid(32, [0, 0, 255, 0]);
  tiny.set([255, 0, 0, 255]);
  const tinyMips = coverMipmaps(tiny, 32);
  assert.equal(tinyMips.at(-1).data[3], 0, 'sub-byte coverage may naturally fade out');
  assert.ok(tinyMips.every((mip) => mip.data.every((value, i) => i % 4 !== 2 || value === 0)), 'hidden blue never leaks');
});

test('each deep mip keeps independent covers, including a non-power-of-two atlas height', () => {
  const texture = new CoverMipTexture(16, 27, 8);
  texture.setTile(0, coverMipmaps(solid(8, [255, 0, 0, 255]), 8));
  texture.setTile(1, coverMipmaps(solid(8, [0, 255, 0, 255]), 8));
  texture.setTile(431, coverMipmaps(solid(8, [0, 0, 255, 255]), 8));
  assert.equal(texture.colorSpace, SRGBColorSpace);
  assert.equal(texture.minFilter, LinearMipmapNearestFilter);
  assert.equal(texture.generateMipmaps, false);
  assert.equal(texture.anisotropy, 1, 'hardware sampling must not reach adjacent tiles');
  assert.deepEqual(texture.mipmaps.map(({ width, height }) => [width, height]), [[128, 216], [64, 108], [32, 54], [16, 27]]);
  for (let level = 0; level < texture.mipmaps.length; level++) {
    const { data, width, height } = texture.mipmaps[level], size = 8 / 2 ** level;
    assert.deepEqual([...data.slice(((height - size) * width) * 4, ((height - size) * width) * 4 + 4)], [255, 0, 0, 255]);
    assert.deepEqual([...data.slice(((height - size) * width + size) * 4, ((height - size) * width + size) * 4 + 4)], [0, 255, 0, 255]);
    assert.deepEqual([...data.slice((15 * size) * 4, (15 * size) * 4 + 4)], [0, 0, 255, 255]);
  }
  texture.dispose();
});

test('slot refresh updates only its own rows at every level and preserves top/bottom orientation', () => {
  const texture = new CoverMipTexture(2, 2, 2);
  const red = coverMipmaps(solid(2, [255, 0, 0, 255]), 2);
  for (let slot = 0; slot < 4; slot++) texture.setTile(slot, red);
  const version = texture.version;
  const uploads = [];
  const handle = {};
  const uploaded = { __webglTexture: handle };
  const store = {};
  const bound = [];
  const gl = {
    TEXTURE_2D: 'TEXTURE_2D', RGBA: 'RGBA', UNSIGNED_BYTE: 'UNSIGNED_BYTE',
    UNPACK_FLIP_Y_WEBGL: 'flip', UNPACK_PREMULTIPLY_ALPHA_WEBGL: 'premultiply', UNPACK_ALIGNMENT: 'alignment',
    UNPACK_ROW_LENGTH: 'row', UNPACK_SKIP_PIXELS: 'skipPixels', UNPACK_SKIP_ROWS: 'skipRows',
    pixelStorei(name, value) { store[name] = value; },
    getParameter() { throw new Error('reading GL state back waits for the GPU process'); },
    texSubImage2D(target, level, x, y, width, height, format, type, data) {
      assert.deepEqual([target, format, type], ['TEXTURE_2D', 'RGBA', 'UNSIGNED_BYTE']);
      assert.equal(bound.at(-1), handle, 'uploads into the atlas texture');
      assert.equal(data, texture.mipmaps[level].data, 'reads the CPU level in place');
      assert.equal(store.row, texture.mipmaps[level].width, 'rows step through the whole level');
      assert.deepEqual([store.skipPixels, store.skipRows], [x, y], 'reads the tile at its own place');
      assert.deepEqual([store.flip, store.premultiply], [false, false]);
      uploads.push([level, [x, y], [x + width, y + height]]);
    },
  };
  const renderer = {
    properties: { get: (object) => { assert.equal(object, texture); return uploaded; } },
    getContext: () => gl,
    state: { bindTexture: (target, value) => bound.push(value), unbindTexture: () => bound.push(null) },
    copyTextureToTexture() { throw new Error('three reads GL state back per copy'); },
  };
  texture.flush(renderer);
  assert.deepEqual(uploads, [], 'before the first upload three sends every level itself');
  uploaded.__version = texture.version;
  texture.setTile(2, coverMipmaps(new Uint8Array([
    0, 255, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 0, 0, 255, 255,
  ]), 2));
  assert.equal(texture.version, version, 'one cover never re-uploads the whole atlas');
  texture.flush(renderer);
  assert.deepEqual(uploads, [[0, [0, 0], [2, 2]], [1, [0, 0], [1, 1]]],
    'slot 2 is the lower-left tile at every level');
  assert.deepEqual([store.row, store.skipPixels, store.skipRows], [0, 0, 0], 'three keeps its default unpack state');
  assert.deepEqual(bound, [handle, null], 'the texture binding is restored through three');
  texture.flush(renderer);
  assert.equal(uploads.length, 2, 'flushed tiles are not sent again');
  const data = texture.mipmaps[0].data;
  assert.deepEqual([...data.slice(0, 4)], [0, 0, 255, 255], 'first stored row is image bottom');
  assert.deepEqual([...data.slice(16, 20)], [0, 255, 0, 255], 'upper stored row is image top');
  for (const mip of texture.mipmaps) {
    const size = mip.width / 2;
    for (let y = 0; y < mip.height; y++) for (let x = 0; x < mip.width; x++) {
      if (x < size && y < size) continue;
      const offset = (y * mip.width + x) * 4;
      assert.deepEqual([...mip.data.slice(offset, offset + 4)], [255, 0, 0, 255]);
    }
  }
  texture.dispose();
});

test('cover art fills its texture and its quad keeps the art aspect inside the margin', () => {
  const art = 1 - 2 / 128;
  assert.deepEqual(coverArtScale(), [art, art], 'missing covers use the full printed square');
  assert.deepEqual(coverArtScale({ width: 600, height: 600 }), [art, art]);
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≈ ${expected}`);
  const [portraitX, portraitY] = coverArtScale({ width: 600, height: 900 });
  near(portraitX, art * 2 / 3); near(portraitY, art);
  const [landscapeX, landscapeY] = coverArtScale({ width: 1200, height: 600 });
  near(landscapeX, art); near(landscapeY, art / 2);
  const scaled = /transformed\.xy = coverCenter \+ \(transformed\.xy - coverCenter\) \* coverScale;/;
  const instanced = { uniforms: {}, vertexShader: '#include <begin_vertex>\n#include <uv_vertex>', fragmentShader: '#include <map_fragment>' };
  filterCoverShader(instanced, new CoverMipTexture(2, 1, 4), true);
  assert.match(instanced.vertexShader, /attribute vec2 coverScale;/, 'atlas slots carry their own art size');
  assert.match(instanced.vertexShader, scaled);
  assert.equal(instanced.uniforms.coverScale, undefined);
  const texture = new CoverMipTexture(1, 1, 4);
  const single = { uniforms: {}, vertexShader: '#include <begin_vertex>\n#include <uv_vertex>', fragmentShader: '#include <map_fragment>' };
  filterCoverShader(single, texture, false);
  assert.equal(single.uniforms.coverScale, texture.coverScale, 'a single print reads its texture\'s live art size');
  assert.match(single.vertexShader, scaled);
  assert.deepEqual(single.uniforms.coverCenter.value.toArray(), [0.14, 1.85], 'scaling is about the printed square\'s centre');
  texture.dispose();
});

test('large and small standalone prints end at their own average, without rescaling alpha', () => {
  for (const size of [1, 2, 16, 256]) {
    const mips = coverMipmaps(solid(size, [128, 200, 60, 128]), size);
    assert.equal(mips.length, Math.log2(size) + 1);
    const last = mips.at(-1);
    assert.deepEqual([last.width, last.height], [1, 1]);
    assert.equal(last.data[3], 128);
    assert.deepEqual([...last.data], [...mips[0].data.slice(0, 4)]);
  }
});

test('quality changes drive the live cover uniform while hardware sampling stays inside each tile', () => {
  const texture = new CoverMipTexture(2, 1, 4, 8), ordinary = new Texture();
  const shader = { uniforms: {}, vertexShader: '#include <uv_vertex>', fragmentShader: '#include <map_fragment>' };
  filterCoverShader(shader, texture, true);
  const scene = new Group();
  scene.add(new Mesh(new PlaneGeometry(), new MeshLambertMaterial({ map: texture })));
  scene.add(new Mesh(new PlaneGeometry(), new MeshLambertMaterial({ map: ordinary })));
  const renderer = { capabilities: { getMaxAnisotropy: () => 8 } };
  const version = texture.version;
  for (const quality of [1, 2, 8, 1]) {
    applyTextureQuality(scene, renderer, { anisotropy: quality });
    assert.equal(shader.uniforms.coverAnisotropy.value, Math.min(4, quality));
    assert.equal(texture.anisotropy, 1);
    assert.equal(texture.version, version, 'uniform-only changes do not upload every mip again');
    assert.equal(ordinary.anisotropy, quality, 'ordinary textures retain hardware anisotropy');
  }
  texture.anisotropy = 8;
  applyTextureQuality(scene, renderer, { anisotropy: 4 });
  assert.equal(texture.anisotropy, 1, 'also repairs a stale hardware value');
  assert.equal(texture.version, version + 1);
  texture.dispose(); ordinary.dispose();
});

test('a returning snapshot compiles against its own texture and its own quality uniform', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({
    width: 0, height: 0,
    getContext: () => ({ drawImage() {}, getImageData: (_x, _y, width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }) }),
  }) };
  let atlas, snapshot;
  try {
    atlas = new CoverAtlas(1, 512, 8);
    assert.deepEqual([...atlas.array.geometry.getAttribute('coverScale').array], [0, 0],
      'a slot stays hidden until its own art is painted');
    snapshot = new Mesh(new PlaneGeometry());
    atlas.selected.material.map.coverScale.value.set(0.5, 0.75);
    atlas.snapshot(snapshot);
    const scene = new Group(); scene.add(snapshot);
    applyTextureQuality(scene, { capabilities: { getMaxAnisotropy: () => 8 } }, { anisotropy: 2 });
    const shader = { uniforms: {}, vertexShader: '#include <begin_vertex>\n#include <uv_vertex>', fragmentShader: '#include <map_fragment>' };
    snapshot.material.onBeforeCompile(shader, {});
    assert.equal(shader.uniforms.coverAnisotropy, snapshot.material.map.coverAnisotropy);
    assert.equal(shader.uniforms.coverAnisotropy.value, 2);
    assert.equal(atlas.selected.material.map.coverAnisotropy.value, 4, 'the selected texture remains independent');
    assert.equal(shader.uniforms.coverScale, snapshot.material.map.coverScale, 'its quad follows its own art');
    assert.notEqual(snapshot.material.map.coverScale, atlas.selected.material.map.coverScale);
    assert.deepEqual(snapshot.material.map.coverScale.value.toArray(), [0.5, 0.75]);
    assert.equal(snapshot.material.onBeforeRender, atlas.selected.material.onBeforeRender, 'returning copies upload their own art');
  } finally {
    atlas?.dispose(); snapshot?.material.map.dispose(); snapshot?.material.dispose(); snapshot?.geometry.dispose();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

// A painter double: records requests and resolves them on demand.
function fakePainter() {
  let next = 1;
  const jobs = new Map(), cancelled = [];
  return {
    jobs, cancelled,
    render(request) {
      const id = next++;
      let resolve;
      const tile = new Promise(r => { resolve = r; });
      jobs.set(id, { request, resolve });
      return { id, tile };
    },
    // Like CoverTiles: a cancelled request settles with null, never stays pending.
    cancel(id) { cancelled.push(id); jobs.get(id)?.resolve(null); jobs.delete(id); },
    dispose() {},
    // `tint` is the colour the painter read from real art; a print without art has none.
    finish(id, scale = [0.5, 0.75], tint) {
      const { request, resolve } = jobs.get(id);
      jobs.delete(id);
      const levels = coverMipmaps(solid(request.size, [255, 0, 0, 255]), request.size);
      resolve({ levels, scale, tint });
      return new Promise(r => setTimeout(r, 0));
    },
  };
}
const record = (id, coverUrl = `/covers/${id}.jpg`) => ({ id, title: id, album: { coverUrl } });
// The shelf draws slots in its own order (off-screen slots culled); here every slot, in slot order.
const showSlots = (atlas, count) => atlas.order(Int32Array.from({ length: count }, (_, i) => i), count);

test('slots showing the same album share one tile and appear only once it is painted', async () => {
  const painter = fakePainter();
  const atlas = new CoverAtlas(32, 4096, 4, undefined, painter);
  const a = record('a');
  for (let slot = 0; slot < 20; slot++) atlas.setSlot(slot, a);
  assert.equal(painter.jobs.size, 1, 'one painting for twenty slots');
  showSlots(atlas, 21);
  const rect = atlas.array.geometry.getAttribute('coverTile'), scale = atlas.array.geometry.getAttribute('coverScale');
  assert.deepEqual([scale.getX(7), scale.getY(7)], [0, 0], 'hidden while painting, never stale');
  await painter.finish([...painter.jobs.keys()][0]);
  showSlots(atlas, 21);
  for (let slot = 0; slot < 20; slot++) {
    assert.deepEqual([rect.getX(slot), rect.getY(slot)], [rect.getX(0), rect.getY(0)]);
    assert.deepEqual([scale.getX(slot), scale.getY(slot)], [0.5, 0.75]);
  }
  atlas.setSlot(20, a);
  assert.equal(painter.jobs.size, 0, 'a known album is shown again without repainting');
  showSlots(atlas, 21);
  assert.deepEqual([scale.getX(20), scale.getY(20)], [0.5, 0.75]);
  atlas.dispose();
});

test('prints follow the shelf\'s draw order and upload only when the order or a print changes', async () => {
  const painter = fakePainter();
  const atlas = new CoverAtlas(8, 4096, 4, undefined, painter);
  atlas.setSlot(2, record('a'));
  atlas.setSlot(5, record('b'));
  for (const id of [...painter.jobs.keys()]) await painter.finish(id);
  const rect = atlas.array.geometry.getAttribute('coverTile'), scale = atlas.array.geometry.getAttribute('coverScale');
  // A culled shelf draws slot 5, then slot 2: the instances carry those slots' prints.
  atlas.order(Int32Array.of(5, 2), 2);
  assert.deepEqual([rect.getX(0), rect.getX(1)], [1 / 16, 0], 'tile b first, then tile a');
  assert.deepEqual([scale.getX(0), scale.getY(0), scale.getX(1), scale.getY(1)], [0.5, 0.75, 0.5, 0.75]);
  assert.deepEqual(rect.updateRanges.at(-1), { start: 0, count: 8 }, 'only the drawn instances upload');
  const revision = atlas.revision;
  atlas.order(Int32Array.of(5, 2), 2);
  assert.equal(atlas.revision, revision, 'a still shelf uploads nothing, so frames may rest');
  atlas.order(Int32Array.of(2, 5), 2);
  assert.notEqual(atlas.revision, revision, 'a new order is uploaded');
  assert.deepEqual([rect.getX(0), rect.getX(1)], [0, 1 / 16]);
  const reordered = atlas.revision;
  atlas.setSlot(2, record('c'));
  atlas.order(Int32Array.of(2, 5), 2);
  assert.notEqual(atlas.revision, reordered, 'a slot showing another album is uploaded');
  assert.deepEqual([scale.getX(0), scale.getY(0)], [0, 0], 'hidden until its art is painted');
  atlas.dispose();
});

test('work for an album nobody shows any more is cancelled, and its tile is reused', async () => {
  const painter = fakePainter();
  const atlas = new CoverAtlas(16, 4096, 4, undefined, painter);
  atlas.setSlot(0, record('gone'));
  const [pending] = painter.jobs.keys();
  atlas.setSlot(0, record('next'));
  assert.deepEqual(painter.cancelled, [pending]);
  assert.equal(painter.jobs.size, 1);
  // Fill every tile, release one, and a new album takes the least recently used free tile.
  for (let slot = 0; slot < 16; slot++) atlas.setSlot(slot, record(`r${slot}`));
  for (const id of [...painter.jobs.keys()]) await painter.finish(id);
  const rect = atlas.array.geometry.getAttribute('coverTile');
  showSlots(atlas, 16);
  const freed = [rect.getX(3), rect.getY(3)];
  atlas.setSlot(3, record('fresh'));
  showSlots(atlas, 16);
  assert.deepEqual([rect.getX(3), rect.getY(3)], freed, 'the released tile is the one reused');
  await painter.finish([...painter.jobs.keys()][0]);
  atlas.setSlot(5, record('r3'));
  assert.equal(painter.jobs.size, 1, 'an evicted album is painted again');
  atlas.dispose();
});

test('a lifted print shows the shelf tile at once, then its sharp chain; copies keep both', async () => {
  const painter = fakePainter();
  const atlas = new CoverAtlas(16, 4096, 4, undefined, painter);
  const a = record('a');
  atlas.setSlot(0, a);
  await painter.finish([...painter.jobs.keys()][0], [0.9, 0.6]);
  const selection = atlas.select(a);
  const texture = atlas.selected.material.map;
  assert.equal(texture.coverMinLod.value, 2, 'coarser levels only while the 1024 px chain is painted');
  assert.deepEqual(texture.coverScale.value.toArray(), [0.9, 0.6]);
  const copy = new Mesh(new PlaneGeometry());
  atlas.snapshot(copy);
  assert.equal(copy.material.map.coverMinLod.value, 2, 'a copy taken meanwhile keeps the interim print');
  const sharp = [...painter.jobs.entries()].filter(([, job]) => job.request.size === 1024).map(([id]) => id);
  assert.equal(sharp.length, 2, 'the selection and its unfinished copy each get the sharp chain');
  for (const id of sharp) await painter.finish(id, [0.9, 0.6]);
  await selection;
  assert.equal(texture.coverMinLod.value, 0);
  assert.equal(copy.material.map.coverMinLod.value, 0);
  const unknown = record('b');
  void atlas.select(unknown);
  assert.deepEqual(texture.coverScale.value.toArray(), [0, 0], 'no tile yet: hidden, never the previous album');
  copy.material.map.dispose(); copy.material.dispose(); copy.geometry.dispose();
  atlas.dispose();
});

test('the atlas holds the rows the library needs, and grows keeping painted tiles in place', async () => {
  const painter = fakePainter();
  const atlas = new CoverAtlas(64, 4096, 4, undefined, painter);
  const texture = () => atlas.array.material.map;
  assert.equal(texture().rows, 1, 'starts with one row of sixteen tiles');
  atlas.reset(3);
  assert.equal(texture().rows, 1, 'three albums: one row');
  atlas.reset(40);
  assert.equal(texture().rows, 3, 'forty albums: three rows');
  atlas.reset(1000);
  assert.equal(texture().rows, 4, 'never more rows than the pool can show');
  atlas.reset(3);
  const first = texture();
  for (let slot = 0; slot < 16; slot++) atlas.setSlot(slot, record(`a${slot}`));
  for (const id of [...painter.jobs.keys()]) await painter.finish(id);
  const sample = (tex, tile) => { // first texel of a tile at level 0
    const size = tex.tileSize, level = tex.mipmaps[0], x = (tile % 16) * size, y = (tex.rows - 1 - Math.floor(tile / 16)) * size;
    return [...level.data.slice((y * level.width + x) * 4, (y * level.width + x) * 4 + 4)];
  };
  assert.deepEqual(sample(first, 15), [255, 0, 0, 255]);
  atlas.setSlot(16, record('a16'));
  assert.equal(texture().rows, 2, 'a seventeenth cover grows the atlas');
  assert.notEqual(texture(), first, 'a new texture replaces the old one');
  assert.equal(texture().coverAnisotropy, first.coverAnisotropy, 'compiled prints keep their uniforms');
  assert.deepEqual(sample(texture(), 15), [255, 0, 0, 255], 'painted tiles keep their place');
  const rect = atlas.array.geometry.getAttribute('coverTile');
  showSlots(atlas, 17);
  assert.deepEqual([rect.getY(0), rect.getW(0)], [0.5, 0.5], 'slot rectangles follow the new row count');
  atlas.dispose();
});

test('the painter settles cancelled and disposed requests with null', async () => {
  const tiles = new CoverTiles();
  const cancelled = tiles.render({ size: 4, title: 'gone' });
  tiles.cancel(cancelled.id);
  assert.equal(await cancelled.tile, null);
  const disposed = tiles.render({ size: 4, title: 'closing' });
  tiles.dispose();
  assert.equal(await disposed.tile, null);
});

test('a superseded selection settles, so a library refresh awaiting it continues', async () => {
  const painter = fakePainter();
  const atlas = new CoverAtlas(16, 4096, 4, undefined, painter);
  const first = atlas.select(record('first'));
  const second = atlas.select(record('second'));
  const settled = await Promise.race([first.then(() => 'settled'), new Promise(r => setTimeout(() => r('pending'), 50))]);
  assert.equal(settled, 'settled', 'the replaced request no longer blocks its caller');
  const texture = atlas.selected.material.map;
  await painter.finish([...painter.jobs.keys()].at(-1), [0.8, 0.8]);
  await second;
  assert.deepEqual(texture.coverScale.value.toArray().map(v => +v.toFixed(3)), [0.8, 0.8], 'only the current album is printed');
  atlas.reset();
  const afterReset = atlas.select(record('third'));
  atlas.reset();
  assert.equal(await Promise.race([afterReset.then(() => 'settled'), new Promise(r => setTimeout(() => r('pending'), 50))]), 'settled');
  atlas.dispose();
});

// Index-square colours. Each case's square takes its cover's colour: linear RGB and a weight,
// and a weight of zero leaves the square its own amber. The values below are exact in 32 bits.
const AMBER = [0, 0, 0, 0];
const tintAt = (atlas, instance) => [...atlas.caseTint.array.slice(instance * 4, instance * 4 + 4)];
// Requests still waiting for an album: its shelf tile, or (sharp) a lifted print's 1024 px chain.
const waiting = (painter, title, sharp = false) => [...painter.jobs]
  .filter(([, job]) => job.request.title === title && (job.request.size === 1024) === sharp).map(([id]) => id);

test('before any cover is lifted, no index square has a colour', () => {
  const atlas = new CoverAtlas(16, 4096, 4, undefined, fakePainter());
  assert.deepEqual([atlas.caseTint.itemSize, atlas.caseTint.count], [4, 16], 'linear RGB and a weight for each shelf case');
  assert.ok(atlas.caseTint.array.every(value => value === 0), 'the shelf keeps its amber');
  assert.deepEqual(atlas.selectedTint.toArray(), AMBER, 'so does the lifted case (a weight of one with no colour is a black square)');
  atlas.dispose();
});

test('an index square takes its cover\'s colour once the tile is painted, on every slot sharing it; a print without art keeps the amber', async () => {
  const painter = fakePainter();
  const atlas = new CoverAtlas(32, 4096, 4, undefined, painter);
  const a = record('a');
  for (let slot = 0; slot < 20; slot++) atlas.setSlot(slot, a);
  atlas.setSlot(20, record('bare'));
  showSlots(atlas, 22);
  for (let slot = 0; slot < 22; slot++) assert.deepEqual(tintAt(atlas, slot), AMBER, 'amber while painting');
  await painter.finish(waiting(painter, 'a')[0], undefined, [0.25, 0.5, 0.75]);
  showSlots(atlas, 22);
  for (let slot = 0; slot < 20; slot++) assert.deepEqual(tintAt(atlas, slot), [0.25, 0.5, 0.75, 1]);
  assert.deepEqual(tintAt(atlas, 20), AMBER, 'another album\'s paint does not colour this one');
  // The art could not be loaded: the painter printed the missing-cover card and read no colour.
  await painter.finish(waiting(painter, 'bare')[0]);
  showSlots(atlas, 22);
  const scale = atlas.array.geometry.getAttribute('coverScale');
  assert.deepEqual([scale.getX(20), scale.getY(20)], [0.5, 0.75], 'its print is shown');
  assert.deepEqual(tintAt(atlas, 20), AMBER, 'and its square stays amber');
  atlas.setSlot(21, a);
  showSlots(atlas, 22);
  assert.deepEqual(tintAt(atlas, 21), [0.25, 0.5, 0.75, 1], 'a known album is coloured at once');
  atlas.dispose();
});

test('index square colours follow the shelf\'s draw order with the prints and upload only when something changes', async () => {
  const painter = fakePainter();
  const atlas = new CoverAtlas(8, 4096, 4, undefined, painter);
  atlas.setSlot(2, record('a'));
  atlas.setSlot(5, record('b'));
  atlas.setSlot(6, record('c'));
  await painter.finish(waiting(painter, 'a')[0], undefined, [0.25, 0.5, 0.75]);
  await painter.finish(waiting(painter, 'b')[0], undefined, [0.5, 0.125, 0.0625]);
  const tint = atlas.caseTint, rect = atlas.array.geometry.getAttribute('coverTile');
  // A culled shelf draws slot 5, slot 6, then slot 2: the instances carry those slots' colours.
  atlas.order(Int32Array.of(5, 6, 2), 3);
  assert.deepEqual([tintAt(atlas, 0), tintAt(atlas, 1), tintAt(atlas, 2)], [[0.5, 0.125, 0.0625, 1], AMBER, [0.25, 0.5, 0.75, 1]],
    'b, then c (still being painted), then a');
  assert.deepEqual([rect.getX(0), rect.getX(1), rect.getX(2)], [1 / 16, 2 / 16, 0], 'the same instances as the prints');
  assert.deepEqual(tint.updateRanges, [{ start: 0, count: 12 }], 'only the drawn instances upload, four values each');
  const revision = atlas.revision, version = tint.version;
  atlas.order(Int32Array.of(5, 6, 2), 3);
  assert.deepEqual([atlas.revision, tint.version], [revision, version], 'a still shelf uploads nothing, so frames may rest');
  atlas.order(Int32Array.of(2, 5, 6), 3);
  assert.deepEqual([tintAt(atlas, 0), tintAt(atlas, 1), tintAt(atlas, 2)], [[0.25, 0.5, 0.75, 1], [0.5, 0.125, 0.0625, 1], AMBER]);
  assert.equal(tint.version, version + 1, 'a new order is uploaded once');
  const reordered = atlas.revision;
  await painter.finish(waiting(painter, 'c')[0], undefined, [0.125, 0.25, 0.375]);
  atlas.order(Int32Array.of(2, 5, 6), 3);
  assert.deepEqual(tintAt(atlas, 2), [0.125, 0.25, 0.375, 1]);
  assert.notEqual(atlas.revision, reordered, 'a colour arriving is a change to draw');
  assert.equal(tint.version, version + 2);
  const settled = atlas.revision;
  tint.needsUpdate = true;
  assert.equal(atlas.revision, settled + 1, 'the colours\' own upload counts, like the prints\'');
  atlas.dispose();
});

test('a reused tile never shows the previous album\'s colour', async () => {
  const painter = fakePainter();
  const atlas = new CoverAtlas(16, 4096, 4, undefined, painter);
  // Sixteen albums fill the one row this pool may hold, each with its own colour.
  for (let slot = 0; slot < 16; slot++) atlas.setSlot(slot, record(`r${slot}`));
  for (let slot = 0; slot < 16; slot++) await painter.finish(waiting(painter, `r${slot}`)[0], undefined, [slot / 16, 0.5, 0.75]);
  const rect = atlas.array.geometry.getAttribute('coverTile');
  showSlots(atlas, 16);
  for (let slot = 0; slot < 16; slot++) assert.deepEqual(tintAt(atlas, slot), [slot / 16, 0.5, 0.75, 1]);
  const freed = [rect.getX(3), rect.getY(3)];
  atlas.setSlot(3, record('fresh'));
  showSlots(atlas, 16);
  assert.deepEqual([rect.getX(3), rect.getY(3)], freed, 'the released tile is the one reused');
  assert.deepEqual(tintAt(atlas, 3), AMBER, 'amber until its own cover is painted');
  await painter.finish(waiting(painter, 'fresh')[0]);
  showSlots(atlas, 16);
  assert.deepEqual(tintAt(atlas, 3), AMBER, 'painted without art: still not the evicted album\'s colour');
  // The evicted album returns on another slot: painted again, coloured by that paint alone.
  atlas.setSlot(5, record('r3'));
  showSlots(atlas, 16);
  assert.deepEqual(tintAt(atlas, 5), AMBER, 'neither its earlier colour nor the one this slot showed');
  await painter.finish(waiting(painter, 'r3')[0], undefined, [0.5, 0.125, 0.0625]);
  showSlots(atlas, 16);
  assert.deepEqual(tintAt(atlas, 5), [0.5, 0.125, 0.0625, 1]);
  assert.deepEqual([tintAt(atlas, 3), tintAt(atlas, 4)], [AMBER, [4 / 16, 0.5, 0.75, 1]], 'the other slots keep theirs');
  atlas.dispose();
});

test('growing the atlas keeps each painted square\'s colour', async () => {
  const painter = fakePainter();
  const atlas = new CoverAtlas(64, 4096, 4, undefined, painter);
  atlas.reset(3);
  for (let slot = 0; slot < 16; slot++) atlas.setSlot(slot, record(`a${slot}`));
  for (let slot = 0; slot < 16; slot++) await painter.finish(waiting(painter, `a${slot}`)[0], undefined, [slot / 16, 0.5, 0.25]);
  atlas.setSlot(16, record('a16'));
  assert.equal(atlas.array.material.map.rows, 2, 'a seventeenth cover grows the atlas');
  showSlots(atlas, 17);
  for (let slot = 0; slot < 16; slot++) assert.deepEqual(tintAt(atlas, slot), [slot / 16, 0.5, 0.25, 1]);
  assert.deepEqual(tintAt(atlas, 16), AMBER, 'the new cover is still being painted');
  atlas.dispose();
});

test('the lifted case takes its shelf tile\'s colour at once and keeps it; with no painted tile it stays amber until a print arrives', async () => {
  const painter = fakePainter();
  const atlas = new CoverAtlas(16, 4096, 4, undefined, painter);
  const lifted = () => atlas.selectedTint.toArray();
  const a = record('a'), b = record('b'), c = record('c');
  atlas.setSlot(0, a);
  await painter.finish(waiting(painter, 'a')[0], undefined, [0.25, 0.5, 0.75]);
  const first = atlas.select(a);
  assert.deepEqual(lifted(), [0.25, 0.5, 0.75, 1], 'a painted tile lends its colour at once');
  // The 1024 px paint of the same art reads slightly differently: the shelf tile's colour stays.
  await painter.finish(waiting(painter, 'a', true)[0], undefined, [0.25 + 1 / 128, 0.5, 0.75]);
  await first;
  assert.deepEqual(lifted(), [0.25, 0.5, 0.75, 1], 'one colour on the shelf and lifted');
  // b is on no slot yet.
  const second = atlas.select(b);
  assert.deepEqual(lifted(), AMBER, 'no tile: amber, never the previous album\'s colour');
  await painter.finish(waiting(painter, 'b', true)[0], undefined, [0.5, 0.125, 0.0625]);
  await second;
  assert.deepEqual(lifted(), [0.5, 0.125, 0.0625, 1], 'then the sharp print\'s colour');
  // c's tile is still being painted when c is lifted, and arrives before the sharp print.
  atlas.setSlot(1, c);
  const third = atlas.select(c);
  assert.deepEqual(lifted(), AMBER, 'a tile still being painted lends nothing');
  await painter.finish(waiting(painter, 'c')[0], undefined, [0.75, 0.5, 0.25]);
  assert.deepEqual(lifted(), [0.75, 0.5, 0.25, 1], 'the tile, painted first, colours the waiting case');
  await painter.finish(waiting(painter, 'c', true)[0], undefined, [0.75, 0.5, 0.25 + 1 / 128]);
  await third;
  assert.deepEqual(lifted(), [0.75, 0.5, 0.25, 1], 'and the sharp print does not change it');
  atlas.dispose();
});

test('a sharp print that arrives before its tile gives the tile its colour; a tile without art leaves the lifted case the sharp print\'s', async () => {
  const painter = fakePainter();
  const atlas = new CoverAtlas(16, 4096, 4, undefined, painter);
  const lifted = () => atlas.selectedTint.toArray();
  const a = record('a'), bare = record('bare');
  atlas.setSlot(0, a);
  atlas.setSlot(2, bare);
  const first = atlas.select(a);
  await painter.finish(waiting(painter, 'a', true)[0], undefined, [0.125, 0.25, 0.375]);
  await first;
  assert.deepEqual(lifted(), [0.125, 0.25, 0.375, 1], 'the sharp print colours the lifted case');
  // A second case showing the album comes into the pool while the tile is still being painted.
  atlas.setSlot(1, a);
  showSlots(atlas, 3);
  assert.deepEqual([tintAt(atlas, 0), tintAt(atlas, 1)], [AMBER, AMBER], 'shelf cases stay amber while their own print is hidden');
  // The 256 px paint of the same art reads slightly differently.
  await painter.finish(waiting(painter, 'a')[0], undefined, [0.125 + 1 / 128, 0.25, 0.375]);
  showSlots(atlas, 3);
  for (const slot of [0, 1]) assert.deepEqual(tintAt(atlas, slot), lifted(), 'the shelf takes the colour the lifted case already shows');
  assert.deepEqual(lifted(), [0.125, 0.25, 0.375, 1], 'which stays as it was');
  // The tile's load failed (it shows the missing-cover card); the sharp print's did not.
  await painter.finish(waiting(painter, 'bare')[0]);
  const second = atlas.select(bare);
  assert.deepEqual(lifted(), AMBER, 'a tile without art has no colour to lend');
  await painter.finish(waiting(painter, 'bare', true)[0], undefined, [0.375, 0.625, 0.875]);
  await second;
  assert.deepEqual(lifted(), [0.375, 0.625, 0.875, 1], 'the sharp print found the art: its colour');
  showSlots(atlas, 3);
  assert.deepEqual(tintAt(atlas, 2), AMBER, 'the shelf case still shows the missing-cover card');
  atlas.dispose();
});

test('a print painted without art carries no colour, whatever the other size found', async () => {
  const painter = fakePainter();
  const atlas = new CoverAtlas(16, 4096, 4, undefined, painter);
  const lifted = () => atlas.selectedTint.toArray();
  const a = record('a'), b = record('b');
  // a: the sharp print finds the art first, then the tile's own load fails.
  atlas.setSlot(0, a);
  const first = atlas.select(a);
  await painter.finish(waiting(painter, 'a', true)[0], undefined, [0.125, 0.25, 0.375]);
  await first;
  await painter.finish(waiting(painter, 'a')[0]);
  showSlots(atlas, 2);
  assert.deepEqual(tintAt(atlas, 0), AMBER, 'the shelf case shows the missing-cover card: amber');
  assert.deepEqual(lifted(), [0.125, 0.25, 0.375, 1], 'the lifted print shows the art: its colour');
  // b: the tile has the art, then the sharp print's load fails.
  atlas.setSlot(1, b);
  await painter.finish(waiting(painter, 'b')[0], undefined, [0.75, 0.5, 0.25]);
  const second = atlas.select(b);
  assert.deepEqual(lifted(), [0.75, 0.5, 0.25, 1], 'the interim print is the tile\'s art');
  await painter.finish(waiting(painter, 'b', true)[0]);
  await second;
  assert.deepEqual(lifted(), AMBER, 'the lifted print is now the missing-cover card: amber');
  showSlots(atlas, 2);
  assert.deepEqual(tintAt(atlas, 1), [0.75, 0.5, 0.25, 1], 'the shelf case keeps its art and its colour');
  atlas.dispose();
});

test('a sharp print that arrives before any slot shows its album still leaves the shelf and the lifted case one colour', async () => {
  const painter = fakePainter();
  const atlas = new CoverAtlas(16, 4096, 4, undefined, painter);
  const lifted = () => atlas.selectedTint.toArray();
  const a = record('a');
  // Start-up order: the library is reset and its selection awaited before the first frame sets a slot.
  atlas.reset(3);
  const selection = atlas.select(a);
  await painter.finish(waiting(painter, 'a', true)[0], undefined, [0.125, 0.25, 0.375]);
  await selection;
  assert.deepEqual(lifted(), [0.125, 0.25, 0.375, 1]);
  atlas.setSlot(0, a);
  showSlots(atlas, 1);
  assert.deepEqual(tintAt(atlas, 0), AMBER, 'amber while its own print is painted');
  // The 256 px paint of the same art reads slightly differently.
  await painter.finish(waiting(painter, 'a')[0], undefined, [0.125 + 1 / 128, 0.25, 0.375]);
  showSlots(atlas, 1);
  assert.equal(tintAt(atlas, 0)[3], 1, 'the painted case has its colour');
  assert.deepEqual(tintAt(atlas, 0), lifted(), 'the same album has one colour on the shelf and lifted');
  atlas.dispose();
});

test('a returning copy keeps the colour of the album it left with', async () => {
  const painter = fakePainter();
  const atlas = new CoverAtlas(16, 4096, 4, undefined, painter);
  const a = record('a'), b = record('b'), c = record('c');
  atlas.setSlot(0, a);
  atlas.setSlot(2, c);
  await painter.finish(waiting(painter, 'a')[0], undefined, [0.25, 0.5, 0.75]);
  await painter.finish(waiting(painter, 'c')[0], undefined, [0.75, 0.5, 0.25]);
  // As the selection moves on, the scene hands the copy's own colour uniform to the snapshot.
  const copies = [];
  const leave = () => {
    const copy = new Mesh(new PlaneGeometry()), tint = new Vector4(9, 9, 9, 9);
    atlas.snapshot(copy, tint);
    copies.push(copy);
    return tint;
  };
  const first = atlas.select(a);
  const leftA = leave();
  assert.deepEqual(leftA.toArray(), [0.25, 0.5, 0.75, 1], 'the copy takes the lifted colour at once');
  for (const id of waiting(painter, 'a', true)) await painter.finish(id, undefined, [0.25 + 1 / 128, 0.5, 0.75]);
  await first;
  assert.deepEqual(leftA.toArray(), [0.25, 0.5, 0.75, 1], 'its sharp print keeps the shelf tile\'s colour');
  // b has no tile: its copy leaves amber, and c is lifted before b's sharp print arrives.
  const second = atlas.select(b);
  const leftB = leave();
  assert.deepEqual(leftB.toArray(), AMBER, 'amber while its print is still hidden');
  const third = atlas.select(c);
  await second;
  assert.deepEqual(atlas.selectedTint.toArray(), [0.75, 0.5, 0.25, 1]);
  assert.deepEqual(leftB.toArray(), AMBER, 'the next album\'s colour is not the copy\'s');
  const late = waiting(painter, 'b', true);
  assert.equal(late.length, 1, 'the copy still waits for its own sharp print');
  await painter.finish(late[0], undefined, [0.5, 0.125, 0.0625]);
  assert.deepEqual(leftB.toArray(), [0.5, 0.125, 0.0625, 1], 'filled when that print arrives, with its own album\'s colour');
  assert.deepEqual(atlas.selectedTint.toArray(), [0.75, 0.5, 0.25, 1], 'the lifted case is not touched');
  await painter.finish(waiting(painter, 'c', true)[0], undefined, [0.75, 0.5, 0.25]);
  await third;
  assert.deepEqual([leftA.toArray(), leftB.toArray()], [[0.25, 0.5, 0.75, 1], [0.5, 0.125, 0.0625, 1]], 'copies keep theirs as the selection moves on');
  for (const copy of copies) { copy.material.map.dispose(); copy.material.dispose(); copy.geometry.dispose(); }
  atlas.dispose();
});

test('a reset returns every index square, drawn or lifted, to amber', async () => {
  const painter = fakePainter();
  const atlas = new CoverAtlas(16, 4096, 4, undefined, painter);
  const a = record('a');
  atlas.setSlot(0, a);
  atlas.setSlot(1, record('b'));
  atlas.setSlot(2, a);
  for (const id of [...painter.jobs.keys()]) await painter.finish(id, undefined, [0.25, 0.5, 0.75]);
  showSlots(atlas, 3);
  const pending = atlas.select(a);
  const tint = atlas.caseTint;
  assert.deepEqual([tintAt(atlas, 0), tintAt(atlas, 1), tintAt(atlas, 2), atlas.selectedTint.toArray()], Array(4).fill([0.25, 0.5, 0.75, 1]));
  const version = tint.version;
  atlas.reset(3);
  await pending;
  assert.ok(tint.array.every(value => value === 0), 'no drawn case keeps a colour');
  assert.ok(tint.version > version, 'and the cleared colours are uploaded');
  assert.deepEqual(atlas.selectedTint.toArray(), AMBER, 'nor does the lifted case');
  // The slots forgot their colours too: laying the same order out again brings none back.
  showSlots(atlas, 3);
  assert.ok(tint.array.every(value => value === 0), 'the slots forgot them as well');
  // The next library may show the same album: painted again, coloured by that paint.
  atlas.setSlot(0, a);
  showSlots(atlas, 3);
  assert.deepEqual(tintAt(atlas, 0), AMBER);
  await painter.finish(waiting(painter, 'a')[0], undefined, [0.5, 0.125, 0.0625]);
  showSlots(atlas, 3);
  assert.deepEqual(tintAt(atlas, 0), [0.5, 0.125, 0.0625, 1]);
  atlas.dispose();
});

test('shelf tiles ask NetEase\'s image server for a tile-sized cover and fall back to the full one', async () => {
  const full = 'https://p1.music.126.net/abc/123.jpg?param=1024y1024';
  assert.equal(sizedCoverUrl(full, 256), 'https://p1.music.126.net/abc/123.jpg?param=256y256');
  assert.equal(sizedCoverUrl(full, 128), 'https://p1.music.126.net/abc/123.jpg?param=256y256');
  assert.equal(sizedCoverUrl(full, 1024), full, 'the lifted print keeps the large cover');
  // Anything that is not exactly that server's sized address is left alone.
  for (const other of ['/covers/a.jpg', 'https://p1.music.126.net/abc/123.jpg', 'https://example.com/a.jpg?param=1024y1024',
    'http://p1.music.126.net/abc/123.jpg?param=1024y1024', 'https://p1.music.126.net.evil.example/a.jpg?param=1024y1024',
    'https://p1.music.126.net/abc/123.jpg?param=1024y1024&x=1', 'https://p1.music.126.net/abc/123.jpg?param=1024y1024#x'])
    assert.equal(sizedCoverUrl(other, 256), other);
  assert.equal(sizedCoverUrl(undefined, 256), undefined);
  // The atlas asks for the tile-sized cover and names the full one as the fallback; the lifted print asks for the full one.
  const painter = fakePainter();
  const atlas = new CoverAtlas(16, 4096, 4, undefined, painter);
  atlas.setSlot(0, record('n', full));
  atlas.setSlot(1, record('local'));
  const requests = [...painter.jobs.values()].map(job => job.request);
  const tile = requests.find(request => request.url?.includes('126.net'));
  assert.equal(tile.url, 'https://p1.music.126.net/abc/123.jpg?param=256y256');
  assert.equal(tile.fallbackUrl, full);
  assert.ok(tile.size <= 256);
  const local = requests.find(request => request.url === '/covers/local.jpg');
  assert.equal(local.fallbackUrl, undefined, 'a cover that is not resized has no second address');
  const pending = atlas.select(record('n', full));
  const lifted = [...painter.jobs.values()].map(job => job.request).find(request => request.size > 256);
  assert.equal(lifted.url, full);
  assert.equal(lifted.fallbackUrl, undefined);
  for (const id of [...painter.jobs.keys()]) await painter.finish(id);
  await pending;
  atlas.dispose();
  // The painter tries the fallback only when the first address gives no image.
  const tiles = readFileSync(new URL('../src/cover-tiles.ts', import.meta.url), 'utf8');
  assert.match(tiles, /\(request\.url \? await loadImage\(request\.url\) : undefined\)\s*\?\? \(request\.fallbackUrl \? await loadImage\(request\.fallbackUrl\) : undefined\)/);
  const worker = readFileSync(new URL('../src/cover-worker.ts', import.meta.url), 'utf8');
  assert.match(worker, /\(job\.url \? await decode\(job\.url\) : undefined\) \?\? \(job\.fallbackUrl \? await decode\(job\.fallbackUrl\) : undefined\)/);
});
