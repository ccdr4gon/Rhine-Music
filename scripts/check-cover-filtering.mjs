import test from 'node:test';
import assert from 'node:assert/strict';
import { SRGBColorSpace, LinearMipmapNearestFilter, Group, Mesh, MeshLambertMaterial, PlaneGeometry, Texture } from 'three';
import { coverMipmaps, CoverMipTexture, filterCoverShader } from '../src/cover-filtering.ts';
import { CoverAtlas, coverArtScale } from '../src/cover-atlas.ts';
import { CoverTiles } from '../src/cover-tiles.ts';
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
    finish(id, scale = [0.5, 0.75]) {
      const { request, resolve } = jobs.get(id);
      jobs.delete(id);
      const levels = coverMipmaps(solid(request.size, [255, 0, 0, 255]), request.size);
      resolve({ levels, scale });
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
