import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as THREE from 'three';
import { PROGRAM_STATE, SidePrograms, UNCOMPARED_RENDERER_INPUTS } from '../src/side-programs.ts';

// A stand-in for three's renderer, reduced to what three does around a program (WebGLRenderer
// setProgram, getProgram): a material's program is kept while its version and the conditions it
// compares hold, and otherwise worked out for the side the material has at that moment. As in three,
// the program also depends on what is not compared: the renderer's shadow map and the geometry
// (its uv1 here), so a program kept across a change of those is told apart by its name.
function rig() {
  const state = new Map();
  const now = { lightsStateVersion: 1, toneMapping: THREE.NoToneMapping, outputColorSpace: THREE.LinearSRGBColorSpace };
  let workedOut = 0;
  const renderer = {
    properties: { get: (material) => { if (!state.has(material)) state.set(material, {}); return state.get(material); } },
    shadowMap: { enabled: true, type: THREE.PCFShadowMap },
    render() { this.drawing?.(); },
  };
  const sideName = { [THREE.FrontSide]: 'front', [THREE.BackSide]: 'back', [THREE.DoubleSide]: 'double' };
  const choose = (mesh) =>
    `${sideName[mesh.material.side]}@${now.lightsStateVersion}/${now.toneMapping}` +
    (renderer.shadowMap.enabled ? '' : ' unshadowed') + (renderer.shadowMap.type === THREE.PCFShadowMap ? '' : ' vsm') +
    (mesh.geometry.attributes.uv1 ? '+uv1' : '');
  const draw = (mesh) => {
    const material = mesh.material;
    const p = renderer.properties.get(material);
    let change = p.__version !== material.version;
    if (change) p.__version = material.version;
    else change = p.lightsStateVersion !== now.lightsStateVersion || p.outputColorSpace !== now.outputColorSpace || p.toneMapping !== now.toneMapping;
    if (change) {
      workedOut++;
      p.currentProgram = choose(mesh);
      p.lightsStateVersion = now.lightsStateVersion;
      p.toneMapping = now.toneMapping;
      p.outputColorSpace = now.outputColorSpace;
      p.uniformsList = null;
    }
    p.uniformsList ??= `list of ${p.currentProgram}`;
    assert.equal(p.uniformsList, `list of ${p.currentProgram}`, 'the uniform list belongs to the program drawn');
    return p.currentProgram;
  };
  // renderObject tells the material which mesh is about to draw it.
  const before = (mesh) => mesh.material.onBeforeRender(renderer, null, null, mesh.geometry, mesh, null);
  return { renderer, draw, before, choose, now, workedOut: () => workedOut, state };
}

// What three does with a double-sided transmissive material in a frame: its back faces into the
// transmission capture (no tone mapping there), then the whole of it in the frame
// (renderTransmissionPass turns it before renderObject; then renderObject).
function transmissionFrame(mesh, { draw, before, now }) {
  const material = mesh.material;
  const drawn = [];
  now.toneMapping = THREE.NoToneMapping;
  material.side = THREE.BackSide;
  material.needsUpdate = true;
  before(mesh);
  drawn.push(draw(mesh));
  material.side = THREE.DoubleSide;
  material.needsUpdate = true;
  now.toneMapping = THREE.ACESFilmicToneMapping;
  before(mesh);
  drawn.push(draw(mesh));
  return drawn;
}
// And with a transparent double-sided one: back faces, then front faces, then back to double.
function transparentFrame(mesh, { draw, before }) {
  const material = mesh.material;
  const drawn = [];
  before(mesh);
  material.side = THREE.BackSide;
  material.needsUpdate = true;
  drawn.push(draw(mesh));
  material.side = THREE.FrontSide;
  material.needsUpdate = true;
  drawn.push(draw(mesh));
  material.side = THREE.DoubleSide;
  return drawn;
}
const meshOf = (material, uv1 = false) => {
  const geometry = new THREE.BufferGeometry();
  if (uv1) geometry.setAttribute('uv1', new THREE.BufferAttribute(new Float32Array(6), 2));
  return new THREE.Mesh(geometry, material);
};

test('three turning a watched material\'s side keeps each side\'s own program, without working it out again', () => {
  const r = rig();
  const programs = new SidePrograms(r.renderer);
  const glass = meshOf(new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide, transmission: 0.5 }));
  const strip = meshOf(new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide, transparent: true }));
  const plain = meshOf(new THREE.MeshPhysicalMaterial());
  programs.watch(new THREE.Group().add(glass, strip, plain));
  const frames = [];
  r.renderer.drawing = () => frames.push([...transmissionFrame(glass, r), ...transparentFrame(strip, r)]);
  r.renderer.render();
  assert.equal(r.workedOut(), 4, 'each side worked out once');
  const versions = [glass.material.version, strip.material.version];
  for (let i = 0; i < 20; i++) r.renderer.render();
  assert.equal(r.workedOut(), 4, 'and never again');
  assert.deepEqual([glass.material.version, strip.material.version], versions, 'nor counted');
  for (const frame of frames) {
    assert.deepEqual(frame, ['back@1/0', 'double@1/4', 'back@1/4', 'front@1/4'], 'every draw with its own side\'s program, chosen under its own conditions');
  }
  assert.equal(Object.getOwnPropertyDescriptor(plain.material, 'needsUpdate'), undefined, 'a one-sided material is left alone');
  assert.equal(Object.getOwnPropertyDescriptor(plain.material, 'onBeforeRender'), undefined);
});

test('a side three turns to without drawing it costs nothing: glass both transparent and transmissive', () => {
  const r = rig();
  const programs = new SidePrograms(r.renderer);
  const diffuser = meshOf(new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide, transparent: true, transmission: 0.5 }));
  programs.watch(diffuser);
  // The capture turns it to its back faces and back to double without drawing the whole of it; the
  // frame then draws back faces and front faces (renderTransmissionPass, then renderObject). scene.ts
  // draws the frame into a render target too, untoned like the capture; drawn on the canvas, the frame
  // would be tone-mapped (`toned`).
  let toned = false;
  const frames = [];
  r.renderer.drawing = () => {
    const drawn = [];
    const material = diffuser.material;
    r.now.toneMapping = THREE.NoToneMapping;
    material.side = THREE.BackSide;
    material.needsUpdate = true;
    r.before(diffuser);
    drawn.push(r.draw(diffuser));
    material.side = THREE.DoubleSide;
    material.needsUpdate = true;
    if (toned) r.now.toneMapping = THREE.ACESFilmicToneMapping;
    drawn.push(...transparentFrame(diffuser, r));
    frames.push(drawn);
  };
  r.renderer.render();
  const first = r.workedOut();
  const version = diffuser.material.version;
  for (let i = 0; i < 20; i++) r.renderer.render();
  assert.equal(r.workedOut(), first, 'nothing worked out after the first frame');
  assert.equal(diffuser.material.version, version, 'nor counted');
  for (const frame of frames) assert.deepEqual(frame, ['back@1/0', 'back@1/0', 'front@1/0']);
  // Its back faces under two conditions in a frame: one choice is kept for each side, so they are
  // worked out again each time, and every draw still has its own program.
  toned = true;
  frames.length = 0;
  for (let i = 0; i < 5; i++) r.renderer.render();
  for (const frame of frames) assert.deepEqual(frame, ['back@1/0', 'back@1/4', 'front@1/4']);
});

test('a change of the material, of the conditions or of three\'s state is worked out again, then kept again', () => {
  const r = rig();
  const programs = new SidePrograms(r.renderer);
  const glass = meshOf(new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide, transmission: 0.5 }));
  const material = glass.material;
  programs.watch(glass);
  let frames = [];
  r.renderer.drawing = () => frames.push(transmissionFrame(glass, r));
  const settle = (label) => {
    const before = r.workedOut();
    r.renderer.render();
    assert.equal(r.workedOut(), before + 2, `${label}: both sides worked out again`);
    r.renderer.render(); r.renderer.render();
    assert.equal(r.workedOut(), before + 2, `${label}: and kept again`);
  };
  r.renderer.render(); r.renderer.render();
  // Ours, between frames (a define, a map): counted as Material's own.
  const version = material.version;
  material.needsUpdate = true;
  assert.equal(material.version, version + 1);
  settle('needsUpdate');
  // three's own setters step the version without needsUpdate (crossing 0 changes the program).
  material.transmission = 0;
  material.transmission = 0.5;
  settle('a setter');
  // The lights changed: three works each side out under them; nothing chosen under the old ones returns.
  r.now.lightsStateVersion = 2;
  frames = [];
  settle('the lights');
  for (const frame of frames) assert.deepEqual(frame, ['back@2/0', 'double@2/4']);
  // three's state renewed (a disposed material, a lost context).
  r.state.delete(material);
  settle('three\'s state');
  // needsUpdate = false does nothing, as Material's own.
  const now2 = material.version;
  material.needsUpdate = false;
  assert.equal(material.version, now2);
});

test('the shadow map turned off or on, or of another type, reaches every side at the next frame', () => {
  const r = rig();
  const programs = new SidePrograms(r.renderer);
  const glass = meshOf(new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide, transmission: 0.5 }));
  const strip = meshOf(new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide, transparent: true }));
  programs.watch(new THREE.Group().add(glass, strip));
  let frames = [];
  r.renderer.drawing = () => frames.push([...transmissionFrame(glass, r), ...transparentFrame(strip, r)]);
  for (let i = 0; i < 3; i++) r.renderer.render();
  // Nothing else changes: three does not compare these before it keeps a program.
  for (const [change, suffix] of [[() => { r.renderer.shadowMap.enabled = false; }, ' unshadowed'], [() => { r.renderer.shadowMap.enabled = true; }, ''], [() => { r.renderer.shadowMap.type = THREE.VSMShadowMap; }, ' vsm']]) {
    change();
    frames = [];
    const before = r.workedOut();
    for (let i = 0; i < 4; i++) r.renderer.render();
    assert.equal(r.workedOut(), before + 4, 'each side chosen again once');
    for (const frame of frames) assert.deepEqual(frame, ['back@1/0', 'double@1/4', 'back@1/4', 'front@1/4'].map((name) => name + suffix));
  }
});

test('a material a second mesh draws is left to three as it was, every draw with its own program', () => {
  const r = rig();
  const programs = new SidePrograms(r.renderer);
  const strip = new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide, transparent: true });
  // Geometries that differ in what three chooses from but does not compare (uv1).
  const first = meshOf(strip, true), second = meshOf(strip, false);
  programs.watch(first);
  const frames = [];
  r.renderer.drawing = () => frames.push([...transparentFrame(first, r), ...(frames.length >= 2 ? transparentFrame(second, r) : [])]);
  for (let i = 0; i < 6; i++) r.renderer.render();
  assert.deepEqual(frames[1], ['back@1/0+uv1', 'front@1/0+uv1'], 'kept while one mesh draws it');
  for (const frame of frames.slice(2)) assert.deepEqual(frame, ['back@1/0+uv1', 'front@1/0+uv1', 'back@1/0', 'front@1/0']);
  // From the second mesh on, three's own needsUpdate and onBeforeRender again.
  assert.equal(Object.getOwnPropertyDescriptor(strip, 'needsUpdate'), undefined);
  assert.equal(Object.getOwnPropertyDescriptor(strip, 'onBeforeRender'), undefined);
  const version = strip.version;
  r.renderer.render();
  assert.equal(strip.version, version + 4, 'every turn counted');
});

test('turns outside the drawing step the version, and so does a first turn inside it', () => {
  const r = rig();
  const programs = new SidePrograms(r.renderer);
  const glass = meshOf(new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide }));
  programs.watch(glass);
  // Precompiling the back side (scene.ts precompile) turns it outside any drawing: counted.
  const material = glass.material;
  const version = material.version;
  material.side = THREE.BackSide;
  material.needsUpdate = true;
  material.side = THREE.DoubleSide;
  material.needsUpdate = true;
  assert.equal(material.version, version + 2);
  // Then three draws each side once for the moved version, and nothing more is counted.
  const drawn = [];
  const frame = (mesh) => () => {
    mesh.material.side = THREE.BackSide; mesh.material.needsUpdate = true; r.before(mesh); drawn.push(r.draw(mesh));
    mesh.material.side = THREE.DoubleSide; mesh.material.needsUpdate = true; r.before(mesh); drawn.push(r.draw(mesh));
  };
  r.renderer.drawing = frame(glass);
  r.renderer.render(); r.renderer.render();
  assert.equal(material.version, version + 2);
  assert.deepEqual(drawn, ['back@1/0', 'double@1/0', 'back@1/0', 'double@1/0']);
  // A material three is turned for the first time inside its drawing, with its side not known here
  // yet: that first turn is counted, the next ones are not.
  const fresh = meshOf(new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide }));
  programs.watch(fresh);
  drawn.length = 0;
  r.renderer.drawing = frame(fresh);
  const before = fresh.material.version;
  r.renderer.render(); r.renderer.render();
  assert.equal(fresh.material.version, before + 1);
  assert.deepEqual(drawn, ['back@1/0', 'double@1/0', 'back@1/0', 'double@1/0']);
});

test('what is kept, and watched, is what three chooses a program from and compares before keeping it', () => {
  // three's own source, so that a newer three that keeps or reads more is noticed here.
  const require = createRequire(import.meta.url);
  const three = path.join(path.dirname(require.resolve('three')), '../src/renderers');
  const read = (file) => readFileSync(path.join(three, file), 'utf8');
  const body = (source, name) => {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `three has ${name}`);
    let depth = 0;
    for (let i = source.indexOf('{', start); i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(name);
  };
  const names = (text, pattern) => new Set([...text.matchAll(pattern)].map((m) => m[1]));
  const renderer = read('WebGLRenderer.js');
  const written = names(body(renderer, 'getProgram') + body(renderer, 'updateCommonMaterialProperties'), /materialProperties\.(\w+)\s*=(?!=)/g);
  // The programs three has built for the material, and the uniforms they share, stay as they are; the
  // uniform list is cleared when a choice is put back, as three clears it.
  for (const shared of ['programs', 'uniforms', 'uniformsList']) written.delete(shared);
  assert.deepEqual([...written].sort(), [...PROGRAM_STATE].sort());
  const setProgram = body(renderer, 'setProgram');
  const compared = names(setProgram.slice(setProgram.indexOf('let needsProgramChange'), setProgram.indexOf('let program = materialProperties.currentProgram')), /materialProperties\.(\w+)/g);
  compared.delete('__version');
  for (const name of compared) assert.ok(PROGRAM_STATE.includes(name), `${name} is kept`);
  // What three reads from the renderer to choose a program: compared before keeping one (the target's
  // colour space and tone mapping), watched (the shadow map), or fixed when the renderer is made (a
  // reversed depth buffer).
  const inputs = names(body(read('webgl/WebGLPrograms.js'), 'getParameters'), /\brenderer\.([\w.]+)/g);
  const comparedInputs = ['getRenderTarget', 'toneMapping', 'outputColorSpace'];
  const fixed = ['state.buffers.depth.getReversed'];
  for (const input of inputs) {
    assert.ok(comparedInputs.includes(input) || UNCOMPARED_RENDERER_INPUTS.includes(input) || fixed.includes(input), `renderer.${input} is accounted for`);
  }
  for (const input of UNCOMPARED_RENDERER_INPUTS) assert.ok(inputs.has(input), `three still reads renderer.${input}`);
});
