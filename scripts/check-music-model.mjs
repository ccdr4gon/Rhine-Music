import assert from "node:assert/strict";
import fs from "node:fs/promises";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MUSIC_MODEL, MUSIC_COVER, MUSIC_PANEL_INSET, normalizeMusicGeometry, configureMusicGlass, createAlbumPrintMaterial } from "../src/music-model.ts";
import { CardAppearance } from "../src/appearance.ts";

// Compare actual triangles rather than bounding boxes: intersecting closed
// volumes are not necessarily coplanar, while a tiny shared end face can flicker.
const planeTolerance = 1e-7;
function triangles(geometry) {
  const positions = geometry.attributes.position, indices = geometry.index;
  const result = [];
  for (let i = 0; i < (indices?.count ?? positions.count); i += 3) {
    const vertices = [0, 1, 2].map(offset => new THREE.Vector3().fromBufferAttribute(
      positions, indices ? indices.getX(i + offset) : i + offset,
    ));
    const normal = new THREE.Vector3().subVectors(vertices[1], vertices[0])
      .cross(new THREE.Vector3().subVectors(vertices[2], vertices[0]));
    if (normal.length() < 1e-12) continue;
    normal.normalize();
    const axis = [0, 1, 2].sort((a, b) => Math.abs(normal.getComponent(b)) - Math.abs(normal.getComponent(a)))[0];
    result.push({ vertices, normal, plane: normal.dot(vertices[0]), axis,
      box: new THREE.Box3().setFromPoints(vertices).expandByScalar(planeTolerance) });
  }
  return result;
}
const cross2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function intersectionArea(polygon, triangle) {
  const orientation = Math.sign(cross2(...triangle));
  for (let edge = 0; edge < 3 && polygon.length; edge++) {
    const a = triangle[edge], b = triangle[(edge + 1) % 3], clipped = [];
    for (let i = 0; i < polygon.length; i++) {
      const p = polygon[i], q = polygon[(i + 1) % polygon.length];
      const dp = orientation * cross2(a, b, p), dq = orientation * cross2(a, b, q);
      const insideP = dp >= -1e-12, insideQ = dq >= -1e-12;
      if (insideP) clipped.push(p);
      if (insideP !== insideQ) {
        const t = dp / (dp - dq);
        clipped.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
    }
    polygon = clipped;
  }
  return Math.abs(polygon.reduce((sum, p, i) => {
    const q = polygon[(i + 1) % polygon.length];
    return sum + p[0] * q[1] - q[0] * p[1];
  }, 0) / 2);
}
function coplanarOverlaps(meshes) {
  const overlaps = [];
  for (let i = 0; i < meshes.length; i++) for (let j = i + 1; j < meshes.length; j++) {
    for (const a of meshes[i].triangles) for (const b of meshes[j].triangles) {
      if (!a.box.intersectsBox(b.box) ||
        !b.vertices.every(vertex => Math.abs(a.normal.dot(vertex) - a.plane) < planeTolerance)) continue;
      const axes = [0, 1, 2].filter(axis => axis !== a.axis);
      const project = vertex => axes.map(axis => vertex.getComponent(axis));
      const area = intersectionArea(a.vertices.map(project), b.vertices.map(project)) /
        Math.abs(a.normal.getComponent(a.axis));
      if (area > 1e-10) overlaps.push({ surfaces: [meshes[i].surface, meshes[j].surface], area });
    }
  }
  return overlaps;
}

const bytes = await fs.readFile(new URL("../public/assets/music-cd.glb", import.meta.url));
const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
gltf.scene.updateMatrixWorld(true);
const surfaces = [];
const appearance = new CardAppearance();
const appearanceModel = new THREE.Group();
const uncorrectedMeshes = [], correctedMeshes = [];
const uncorrectedBounds = new THREE.Box3(), bounds = new THREE.Box3();
gltf.scene.traverse((object) => {
  if (!(object instanceof THREE.Mesh)) return;
  const surface = object.material.name.replace(/\.\d+$/, "");
  surfaces.push(surface);
  const sourceDataBefore = structuredClone(object.geometry.userData);
  const original = object.geometry.clone().applyMatrix4(object.matrixWorld);
  const direct = normalizeMusicGeometry(original.clone(), surface);
  const geometry = normalizeMusicGeometry(original);
  const before = geometry.clone();
  uncorrectedMeshes.push({ surface, triangles: triangles(before) });
  uncorrectedBounds.union(before.boundingBox);
  // Delayed material discovery must still apply the seam correction exactly once.
  normalizeMusicGeometry(geometry, surface);
  assert.deepEqual(object.geometry.userData, sourceDataBefore,
    `${surface}: scene/viewer copies must not mark the raw GLB template as normalized`);
  for (const attribute of ["position", "normal"]) {
    assert.deepEqual(geometry.attributes[attribute].array, direct.attributes[attribute].array,
      `${surface}: material supplied later matches the direct load/viewer path`);
  }
  const once = geometry.clone();
  normalizeMusicGeometry(geometry);
  normalizeMusicGeometry(geometry, surface);
  for (const attribute of ["position", "normal"]) {
    assert.deepEqual(geometry.attributes[attribute].array, once.attributes[attribute].array,
      `${surface}: normalisation and seam correction must never compound`);
  }
  assert.deepEqual(geometry.index?.array, before.index?.array, `${surface}: triangle topology is unchanged`);
  assert.deepEqual(geometry.attributes.uv?.array, before.attributes.uv?.array, `${surface}: UVs are unchanged`);
  const position = geometry.attributes.position, oldPosition = before.attributes.position;
  const normal = geometry.attributes.normal, oldNormal = before.attributes.normal;
  let maximumNormalChange = 0;
  for (let i = 0; i < position.count; i++) {
    assert.equal(position.getZ(i), oldPosition.getZ(i), `${surface}: front/back depth and thickness are unchanged`);
    const n = new THREE.Vector3().fromBufferAttribute(normal, i);
    assert.ok(Math.abs(n.length() - 1) < 1e-5, `${surface}: transformed normals remain unit length`);
    maximumNormalChange = Math.max(maximumNormalChange, n.angleTo(new THREE.Vector3().fromBufferAttribute(oldNormal, i)));
  }
  assert.ok(maximumNormalChange < THREE.MathUtils.degToRad(0.1), `${surface}: preserve authored face shading`);
  if (surface === "Ivory_Edges") {
    assert.deepEqual(position.array, oldPosition.array, "The complete outer frame is unchanged");
    assert.deepEqual(normal.array, oldNormal.array, "The frame's authored normals are unchanged");
  } else {
    for (const axis of ["x", "y"]) {
      assert.ok(Math.abs(geometry.boundingBox.min[axis] - before.boundingBox.min[axis] - MUSIC_PANEL_INSET) < 1e-6);
      assert.ok(Math.abs(before.boundingBox.max[axis] - geometry.boundingBox.max[axis] - MUSIC_PANEL_INSET) < 1e-6);
    }
    // The independent print still lies entirely over the panel's planar face,
    // not over an edge bevel or the newly exposed seam clearance.
    const face = new THREE.Box3();
    for (let i = 0; i < position.count; i++) if (Math.abs(position.getZ(i) - before.boundingBox.max.z) < planeTolerance)
      face.expandByPoint(new THREE.Vector3().fromBufferAttribute(position, i));
    assert.ok(MUSIC_COVER.x - MUSIC_COVER.width / 2 > face.min.x);
    assert.ok(MUSIC_COVER.x + MUSIC_COVER.width / 2 < face.max.x);
    assert.ok(MUSIC_COVER.y - MUSIC_COVER.height / 2 > face.min.y);
    assert.ok(MUSIC_COVER.y + MUSIC_COVER.height / 2 < face.max.y);
  }
  correctedMeshes.push({ surface, triangles: triangles(geometry) });
  bounds.union(geometry.boundingBox);
  const material = new THREE.MeshPhysicalMaterial();
  configureMusicGlass(surface, material);
  assert.ok(material.transmission >= 0.65, `${surface} remains glass`);
  const [minimum, maximum] = surface === "Ivory_Edges" ? [0.23, 0.28] : [0.38, 0.42];
  assert.ok(material.roughness >= minimum && material.roughness <= maximum, `${surface} retains the reference's soft frosted finish`);
  assert.ok(material.clearcoat <= 0.18, `${surface} avoids a polished plastic coat`);
  appearance.register(surface, material, material.clone());
  const appearanceMesh = new THREE.Mesh(geometry, material);
  appearanceMesh.userData.surface = surface;
  appearanceMesh.userData.musicShell = true;
  appearanceModel.add(appearanceMesh);
});
assert.deepEqual(surfaces.sort(), ["Frosted_Polymer", "Ivory_Edges", "Optical_Diffuser"].sort(), "music model contains only shell, frame and backing; no rings or screws");
const beforeOverlaps = coplanarOverlaps(uncorrectedMeshes);
const afterOverlaps = coplanarOverlaps(correctedMeshes);
assert.equal(afterOverlaps.length, 0, `Music shell surfaces overlap in the same plane: ${JSON.stringify(afterOverlaps)}`);
assert.deepEqual(bounds.min.toArray(), uncorrectedBounds.min.toArray(), "The outer model bounds must not move");
assert.deepEqual(bounds.max.toArray(), uncorrectedBounds.max.toArray(), "The outer model bounds must not move");
const size = bounds.getSize(new THREE.Vector3());
for (const [axis, dimension] of [["x", "width"], ["y", "height"], ["z", "depth"]])
  assert.ok(Math.abs(size[axis] - MUSIC_MODEL[dimension]) < 1e-6, `actual GLB ${dimension} matches the camera dimensions`);
assert.ok(Math.abs(bounds.getCenter(new THREE.Vector3()).y - MUSIC_MODEL.center.y) < 1e-6);
assert.ok(MUSIC_COVER.z > bounds.max.z + 0.01, "cover is in front of every transmitting surface");
assert.ok(MUSIC_COVER.x - MUSIC_COVER.width / 2 > bounds.min.x);
assert.ok(MUSIC_COVER.x + MUSIC_COVER.width / 2 < bounds.max.x);
assert.ok(MUSIC_COVER.y - MUSIC_COVER.height / 2 > bounds.min.y);
assert.ok(MUSIC_COVER.y + MUSIC_COVER.height / 2 < bounds.max.y);
const print = createAlbumPrintMaterial(new THREE.Texture());
assert.equal(print.isMeshLambertMaterial, true);
assert.equal(print.toneMapped, false);
assert.equal(print.fog, true);
assert.equal(print.transparent, false);
assert.equal(print.emissive.getHex(), 0, "Artwork emits no light of its own");
appearance.prepare(appearanceModel);
const printedCover = new THREE.Mesh(new THREE.PlaneGeometry(MUSIC_COVER.width, MUSIC_COVER.height), print);
printedCover.userData.albumCover = true;
appearanceModel.add(printedCover);
const printBefore = JSON.stringify(print.toJSON());
// Exercise the actual main-scene/viewer appearance path. Its final clarity
// update must retain frosting after selection quality and theme changes.
for (const theme of ["day", "night", "dusk"]) {
  appearance.setTheme(theme);
  for (const quality of [0, 0.5, 1]) for (const clarity of [0, 0.5, 1]) {
    appearance.apply(appearanceModel, quality);
    appearance.setClarity(appearanceModel, clarity);
    const glass = appearanceModel.children.find(child => child.userData.surface === "Frosted_Polymer").material;
    assert.ok(glass.roughness >= 0.28 && glass.roughness <= 0.42, "Every rendered cover-glass state retains visible frosting");
    if (clarity === 1) assert.ok(glass.roughness >= 0.28 && glass.roughness <= 0.32, "Final inspection and viewer clear state never revert to polished 0.07 roughness");
    assert.equal(printedCover.material, print, "Appearance never replaces the separate artwork material");
    assert.equal(JSON.stringify(print.toJSON()), printBefore, "Frosting, selection quality and themes do not mutate the artwork material");
  }
}
console.log(`Music glass model passed: actual GLB 4.45 × 3.35 × 0.14, ${beforeOverlaps.length} → ${afterOverlaps.length} coplanar triangle overlaps, idempotent ${MUSIC_PANEL_INSET} XY panel clearance, unchanged frame/UVs/depth/topology, preserved print coverage, 0.012 clear-print gap, V0.1.1b frosted glass and independent diffuse artwork across appearance states.`);
