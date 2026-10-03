import test from 'node:test';
import assert from 'node:assert/strict';
import { HalfFloatType, Group, Mesh, MeshPhysicalMaterial, MeshLambertMaterial, PerspectiveCamera, PlaneGeometry, Scene, Texture } from 'three';
import { multisampleCount, qualityPresets } from '../src/render-quality.ts';
import { createAlbumPrintMaterial } from '../src/music-model.ts';
import {
  MultisampleRenderPass, createQualityComposer, updateSceneSamples, resizeQuality, viewerUsesComposer, applyAlbumPrintCoverage,
} from '../src/quality-renderer.ts';

const scenePass = () => new MultisampleRenderPass(new Scene(), new PerspectiveCamera());
function sceneComposer(renderer) {
  const composer = createQualityComposer(renderer);
  const pass = scenePass();
  composer.addPass(pass);
  return { composer, pass };
}

function rendererFixture({ color = [4, 2], depth = [4, 2], samples = 4, extension = true, queryFails = false } = {}) {
  const queries = [];
  let lost = false;
  const gl = {
    RENDERBUFFER: 0x8d41, RGBA16F: 0x881a, DEPTH_COMPONENT24: 0x81a6, SAMPLES: 0x80a9,
    isContextLost: () => lost,
    getInternalformatParameter(target, format, name) {
      queries.push([target, format, name]);
      assert.equal(target, gl.RENDERBUFFER);
      assert.equal(name, gl.SAMPLES);
      if (queryFails) throw new Error('unavailable query');
      assert.ok(format === gl.RGBA16F || format === gl.DEPTH_COMPONENT24);
      return new Int32Array(format === gl.RGBA16F ? color : depth);
    },
  };
  const renderer = {
    capabilities: { maxSamples: 8, samples, maxTextureSize: 16384, getMaxAnisotropy: () => 16 },
    extensions: { has: () => extension },
    domElement: new EventTarget(),
    getContext: () => gl,
    getPixelRatio: () => 1,
    getRenderTarget: () => null,
    setRenderTarget() {}, setPixelRatio() {}, setSize() {},
  };
  return { renderer, gl, queries, lose: () => { lost = true; }, restore: () => {
    lost = false;
    renderer.domElement.dispatchEvent(new Event('webglcontextrestored'));
  } };
}

test('sample selection requires matching color/depth support and honors the pixel budget', () => {
  assert.equal(multisampleCount([8, 4, 2], [8, 4, 2], 1920, 1080, 8), 8, 'thin moving edges get 8x where affordable');
  assert.equal(multisampleCount([8, 4, 2], [8, 4, 2], 2560, 1600, 8), 8);
  assert.equal(multisampleCount([8, 4, 2], [8, 4, 2], 2560, 1621, 8), 4, '8x stops at the former 2 x 4x storage');
  assert.equal(multisampleCount([8, 4, 2], [4, 2], 1920, 1080, 8), 4);
  assert.equal(multisampleCount([8, 4, 2], [8, 4, 2], 1920, 1080, 4), 4, 'the context maximum is respected');
  assert.equal(multisampleCount([4, 2], [4, 2], 3840, 2160, 8), 4);
  assert.equal(multisampleCount([4, 2], [4, 2], 3840, 2161, 8), 2);
  assert.equal(multisampleCount([8, 4], [8, 2], 3840, 2160, 8), 0, 'no combination both formats support fits');
  assert.equal(multisampleCount([4], [4], 3840, 4320, 8), 0, '2x support cannot be assumed');
  assert.equal(multisampleCount([4, 2], [4, 2], 1920, 1080, 2), 2);
  for (const [w, h] of [[0, 1080], [-1, -1], [NaN, 1080], [Infinity, 1]])
    assert.equal(multisampleCount([4, 2], [4, 2], w, h, 8), 0);
});

test('only the scene pass multisamples, independent of composer swap parity, without reallocating', () => {
  const { renderer, queries } = rendererFixture({ color: [8, 4, 2], depth: [8, 4, 2] });
  const { composer, pass } = sceneComposer(renderer);
  let disposals = 0;
  for (const target of [composer.renderTarget1, composer.renderTarget2, pass.target]) {
    assert.equal(target.texture.type, HalfFloatType);
    assert.equal(target.stencilBuffer, false);
  }
  assert.equal(pass.target.depthBuffer, true, 'geometry is depth tested in the scene target');
  assert.equal(pass.target.resolveDepthBuffer, false, 'nothing reads the resolved depth');
  assert.deepEqual([composer.renderTarget1.depthBuffer, composer.renderTarget2.depthBuffer], [false, false],
    'post-processing buffers hold full-screen images only');
  pass.target.addEventListener('dispose', () => disposals++);
  assert.equal(updateSceneSamples(renderer, pass, 1920, 1080), 8);
  assert.equal(pass.samples, 8);
  assert.equal(disposals, 1);
  assert.equal(queries.length, 2);
  // Odd and even numbers of swapping passes alternate the composer's read
  // buffer between frames. The scene still draws into one multisampled
  // target and its resolved copy lands in whichever buffer is current.
  const calls = [];
  Object.assign(renderer, {
    autoClear: true, autoClearColor: true, autoClearDepth: true, autoClearStencil: true,
    setRenderTarget(target) { calls.push(['target', target]); },
    clear() { calls.push(['clear']); },
    render(object) { calls.push(['render', object]); },
  });
  for (const switches of [[false, false], [true, false], [false, true], [true, true]]) {
    const observed = [];
    const next = (needsSwap, enabled = true) => ({ enabled, needsSwap, renderToScreen: false, render() {} });
    composer.passes = [pass, next(true, switches[0]), next(true, switches[1]), next(true)];
    for (let frame = 0; frame < 4; frame++) {
      calls.length = 0;
      const read = composer.readBuffer;
      updateSceneSamples(renderer, pass, 1920, 1080);
      composer.render();
      const targets = calls.filter(([kind]) => kind === 'target').map(([, target]) => target);
      assert.equal(targets[0], pass.target, 'geometry is drawn into the multisampled target');
      assert.equal(targets[1], read, 'its resolve is copied into the current read buffer');
      assert.equal(calls.filter(([kind]) => kind === 'render').length, 2, 'one scene draw and one copy');
      observed.push(composer.renderTarget1.samples + composer.renderTarget2.samples);
    }
    assert.deepEqual(observed, [0, 0, 0, 0], 'composer buffers never hold samples');
  }
  assert.equal(disposals, 1, 'unchanged sampling must not re-create resources each frame');
  assert.equal(queries.length, 2, 'format queries are cached per renderer');
  assert.equal(updateSceneSamples(renderer, pass, 3840, 2160), 4);
  assert.equal(disposals, 2);
  composer.dispose(); pass.dispose();
});

test('without samples the scene still draws into its own depth-tested target, then is copied', () => {
  const { renderer } = rendererFixture({ color: [] });
  const { composer, pass } = sceneComposer(renderer);
  assert.equal(updateSceneSamples(renderer, pass, 640, 900), 0);
  const targets = [];
  Object.assign(renderer, { autoClear: true, setRenderTarget(target) { targets.push(target); }, clear() {}, render() {} });
  const read = composer.readBuffer;
  pass.render(renderer, composer.writeBuffer, read, 0, false);
  assert.deepEqual(targets, [pass.target, read], 'the read buffer has no depth: the scene is never drawn into it');
  composer.dispose(); pass.dispose();
});

test('unsupported formats, failed queries and lost contexts fall back instead of claiming MSAA', () => {
  for (const options of [{ color: [] }, { depth: [] }, { extension: false }, { queryFails: true }]) {
    const { renderer } = rendererFixture(options);
    const pass = scenePass();
    assert.equal(updateSceneSamples(renderer, pass, 640, 900), 0);
    pass.dispose();
  }
  const fixture = rendererFixture();
  const pass = scenePass();
  assert.equal(updateSceneSamples(fixture.renderer, pass, 640, 900), 4);
  fixture.lose();
  assert.equal(updateSceneSamples(fixture.renderer, pass, 640, 900), 0);
  fixture.restore();
  assert.equal(updateSceneSamples(fixture.renderer, pass, 640, 900), 4);
  assert.equal(fixture.queries.length, 4, 'a restored context is queried again');
  pass.dispose();
});

test('SMAA is an explicit enhancement or the fallback, preserving the stored off value', () => {
  const oldDpr = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = 1;
  try {
    for (const supported of [true, false]) {
      const { renderer } = rendererFixture({ color: supported ? [4, 2] : [] });
      const { composer, pass } = sceneComposer(renderer);
      const host = { clientWidth: 640, clientHeight: 900, getBoundingClientRect: () => ({ width: 640 }), dataset: {} };
      const smaa = { enabled: false };
      const print = createAlbumPrintMaterial(new Texture());
      const root = new Mesh(new PlaneGeometry(), print);
      const saved = JSON.stringify(qualityPresets.original);
      resizeQuality(renderer, composer, host, qualityPresets.original, smaa, false, root);
      const result = JSON.parse(host.dataset.renderQuality);
      assert.equal(result.antialias, 'off');
      assert.equal(result.msaaSamples, supported ? 4 : 0);
      assert.equal(result.smaaEnabled, !supported);
      assert.equal(result.antialiasFallback, !supported);
      assert.equal(smaa.enabled, !supported);
      assert.equal(print.alphaToCoverage, supported, 'coverage must follow actual MSAA, not the stored AA preference');
      assert.equal(JSON.stringify(qualityPresets.original), saved);
      resizeQuality(renderer, composer, host, { ...qualityPresets.original, antialias: 'smaa' }, smaa, false, root);
      assert.equal(smaa.enabled, true);
      assert.equal(print.alphaToCoverage, supported, 'SMAA alone does not provide sample coverage');
      assert.equal(pass.samples, supported ? 4 : 0, 'the reported samples are the scene pass\'s');
      composer.dispose(); pass.dispose();
    }
  } finally { globalThis.devicePixelRatio = oldDpr; }
});

test('viewer retains direct native AA and uses the shared composer only when needed', () => {
  const native = rendererFixture({ color: [] }).renderer;
  const unavailable = rendererFixture({ samples: 0 }).renderer;
  assert.equal(viewerUsesComposer(native, qualityPresets.original), false);
  assert.equal(viewerUsesComposer(native, qualityPresets.high), true);
  assert.equal(viewerUsesComposer(unavailable, qualityPresets.original), true);
  const oldDpr = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = 1;
  const composer = createQualityComposer(native);
  try {
    const host = { clientWidth: 640, clientHeight: 900, getBoundingClientRect: () => ({ width: 640 }), dataset: {} };
    const smaa = { enabled: true };
    const print = createAlbumPrintMaterial(new Texture());
    const root = new Mesh(new PlaneGeometry(), print);
    resizeQuality(native, composer, host, qualityPresets.original, smaa, true, root);
    assert.equal(smaa.enabled, false);
    assert.equal(JSON.parse(host.dataset.renderQuality).renderPath, 'direct');
    assert.equal(JSON.parse(host.dataset.renderQuality).msaaSamples, 4);
    assert.equal(JSON.parse(host.dataset.renderQuality).composerSamples, 0);
    assert.equal(print.alphaToCoverage, true, 'the direct viewer uses its default framebuffer, not the unused composer');
  } finally { globalThis.devicePixelRatio = oldDpr; composer.dispose(); }
});

test('coverage switches only marked prints, preserves returning clones and recompiles only on change', () => {
  const root = new Group();
  const print = createAlbumPrintMaterial(new Texture());
  const glass = new MeshPhysicalMaterial({ transmission: 0.96, alphaToCoverage: true });
  const other = new MeshLambertMaterial({ alphaTest: 0.025 });
  root.add(new Mesh(new PlaneGeometry(), [print, glass, other]));
  assert.equal(print.userData.albumPrint, true);
  assert.equal(print.alphaToCoverage, false);
  const initial = print.version;
  const glassBefore = JSON.stringify(glass.toJSON());
  const otherBefore = JSON.stringify(other.toJSON());
  applyAlbumPrintCoverage(root, 4);
  assert.equal(print.alphaToCoverage, true);
  assert.equal(print.version, initial + 1);
  applyAlbumPrintCoverage(root, 2);
  assert.equal(print.version, initial + 1, 'switching 4x to 2x keeps the same coverage shader');
  const returning = print.clone();
  assert.equal(returning.userData.albumPrint, true);
  assert.equal(returning.alphaToCoverage, true, 'return snapshots inherit the active coverage mode');
  root.add(new Mesh(new PlaneGeometry(), returning));
  const returningVersion = returning.version;
  applyAlbumPrintCoverage(root, 0);
  assert.equal(print.alphaToCoverage, false);
  assert.equal(returning.alphaToCoverage, false);
  assert.equal(print.version, initial + 2);
  assert.equal(returning.version, returningVersion + 1);
  applyAlbumPrintCoverage(root, 0);
  assert.equal(print.version, initial + 2);
  assert.equal(returning.version, returningVersion + 1);
  assert.equal(JSON.stringify(glass.toJSON()), glassBefore, 'glass is never changed');
  assert.equal(JSON.stringify(other.toJSON()), otherBefore, 'untagged alpha-tested materials are never changed');
});

test('prints loaded after initial quality setup adopt the already configured buffer coverage', () => {
  for (const supported of [true, false]) {
    const { renderer } = rendererFixture({ color: supported ? [4, 2] : [] });
    const pass = scenePass();
    const root = new Group();
    updateSceneSamples(renderer, pass, 640, 900);
    applyAlbumPrintCoverage(root, pass.samples);
    const print = createAlbumPrintMaterial(new Texture());
    assert.equal(print.alphaToCoverage, false);
    root.add(new Mesh(new PlaneGeometry(), print));
    // The load-complete hook reuses the existing sample decision; it need not
    // change quality, resize buffers or rely on setQuality escaping its cache.
    applyAlbumPrintCoverage(root, pass.samples);
    assert.equal(print.alphaToCoverage, supported);
    pass.dispose();
  }
});
