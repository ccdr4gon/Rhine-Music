import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MUSIC_MODEL, MUSIC_COVER, MUSIC_LABEL, configureMusicGlass, createAlbumPrintMaterial, isMusicShellSurface, musicCaseLevel } from "../src/music-model.ts";
import { CASE_DETAIL, createCaseDetailMaterial, mergeCaseDetail } from "../src/music-case-detail.ts";
import { MUSIC_CASE_ASSET } from "../src/music-case-asset.ts";
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
    if (meshes[i].surface === meshes[j].surface) continue;
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

const bytes = await fs.readFile(new URL("../public/assets/music-case.glb", import.meta.url));
const digest = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 12);
assert.ok(MUSIC_CASE_ASSET.endsWith(`?v=${digest}`), "the asset module busts the cache for this exact GLB");
const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
gltf.scene.updateMatrixWorld(true);
const sources = [], parts = [];
gltf.scene.traverse((object) => {
  if (!(object instanceof THREE.Mesh)) return;
  sources.push(object);
  const surface = object.material.name.replace(/\.\d+$/, "");
  const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld);
  geometry.computeBoundingBox();
  parts.push({ surface, level: musicCaseLevel(object), geometry, triangles: triangles(geometry),
    count: (geometry.index?.count ?? geometry.attributes.position.count) / 3 });
});

// Levels: the glass shell and the index inlay are shared; screws have a shelf stand-in and
// a machined lifted version; everything else exists on the lifted case only.
const levels = Object.fromEntries(["shared", "lod1", "lod0"].map(level =>
  [level, parts.filter(part => part.level === level).map(part => part.surface).sort()]));
assert.deepEqual(levels.shared, ["Frosted_Polymer", "Index_Inlay", "Ivory_Edges", "Optical_Diffuser"]);
assert.deepEqual(levels.lod1, ["Titanium_Fasteners"]);
assert.deepEqual(levels.lod0, ["Case_Engraving", "Case_Engraving_Highlight", "Champagne_Index", "Moulded_Lettering",
  "Optical_Edges", "Printed_Label", "Titanium_Fasteners"]);

// Authored at the runtime size: the shell alone spans the camera's dimensions.
const shell = new THREE.Box3();
for (const part of parts) if (isMusicShellSurface(part.surface)) shell.union(part.geometry.boundingBox);
const size = shell.getSize(new THREE.Vector3());
for (const [axis, dimension] of [["x", "width"], ["y", "height"], ["z", "depth"]])
  assert.ok(Math.abs(size[axis] - MUSIC_MODEL[dimension]) < 1e-5, `shell ${dimension} matches the camera dimensions`);
assert.ok(Math.abs(shell.getCenter(new THREE.Vector3()).y - MUSIC_MODEL.center.y) < 1e-5);

// Detail stays on the case and behind the album print, and never covers the print window.
const window = { x0: MUSIC_COVER.x - MUSIC_COVER.width / 2, x1: MUSIC_COVER.x + MUSIC_COVER.width / 2,
  y0: MUSIC_COVER.y - MUSIC_COVER.height / 2, y1: MUSIC_COVER.y + MUSIC_COVER.height / 2 };
for (const part of parts) {
  const box = part.geometry.boundingBox;
  assert.ok(box.min.x >= shell.min.x - 1e-4 && box.max.x <= shell.max.x + 1e-4, `${part.surface} stays within the case width`);
  assert.ok(box.min.y >= shell.min.y - 1e-4 && box.max.y <= shell.max.y + 0.002, `${part.surface} stays within the case height`);
  assert.ok(MUSIC_COVER.z > box.max.z + 0.005, `the album print stays in front of ${part.surface}`);
  if (isMusicShellSurface(part.surface)) continue;
  // Exact overlap in the face plane: chamfered routes pass the window's corners closely.
  const rectangle = [[window.x0, window.y0], [window.x1, window.y0], [window.x1, window.y1], [window.x0, window.y1]];
  for (const triangle of part.triangles) {
    const flat = triangle.vertices.map(vertex => [vertex.x, vertex.y]);
    // Side walls project to a line and cover nothing; the clipper needs a real triangle.
    if (Math.abs(cross2(...flat)) < 1e-12) continue;
    const area = intersectionArea(rectangle, flat);
    assert.ok(area < 1e-9, `${part.surface} detail never sits on the album print window`);
  }
}

// Every shelf instance and the lifted case: no two surfaces share a plane where they overlap.
const shelfParts = parts.filter(part => part.level !== "lod0"), liftedParts = parts.filter(part => part.level !== "lod1");
for (const [name, set] of [["shelf", shelfParts], ["lifted", liftedParts]])
  assert.deepEqual(coplanarOverlaps(set), [], `${name} case: no coplanar overlaps between surfaces`);

// Budgets: hundreds of shelf instances stay lean; the lifted case carries the detail.
const shelfTriangles = shelfParts.reduce((sum, part) => sum + part.count, 0);
const liftedTriangles = liftedParts.reduce((sum, part) => sum + part.count, 0);
assert.ok(shelfTriangles <= 900, `shelf instance ${shelfTriangles} triangles exceeds 900`);
assert.ok(liftedTriangles <= 10000, `lifted case ${liftedTriangles} triangles exceeds 10000`);

// The merged detail: one lifted mesh (stand-ins fade out, detail fades in, the inlay stays)
// and one shelf batch of inlays and screws; every vertex names a known surface.
const { lifted, shelf: hardware } = mergeCaseDetail(sources);
const fadeCounts = new Map();
const fade = lifted.getAttribute("caseFade"), surface = lifted.getAttribute("caseSurface");
for (let i = 0; i < fade.count; i++) fadeCounts.set(fade.getX(i), (fadeCounts.get(fade.getX(i)) ?? 0) + 1);
assert.deepEqual([...fadeCounts.keys()].sort(), [0, 1, 2], "stand-ins out (0), detail in (1), inlay always (2)");
for (let i = 0; i < surface.count; i++) assert.ok(Number.isInteger(surface.getX(i)) && surface.getX(i) >= 0 && surface.getX(i) < 8);
const detailTriangles = parts.filter(part => !isMusicShellSurface(part.surface)).reduce((sum, part) => sum + part.count, 0);
assert.equal(lifted.index.count / 3, detailTriangles, "the lifted mesh holds all opaque detail and stand-ins");
const hardwareTriangles = parts.filter(part => !isMusicShellSurface(part.surface) && part.level !== "lod0").reduce((sum, part) => sum + part.count, 0);
assert.equal(hardware.index.count / 3, hardwareTriangles, "the shelf batch holds exactly the inlay and the stand-in screws");
const inspected = mergeCaseDetail(sources, { standIns: false }).lifted;
assert.equal(inspected.index.count / 3, detailTriangles - parts.find(part => part.level === "lod1").count, "inspection drops the stand-ins");

// The printed label lies on its plate, just in front of it.
const plate = parts.find(part => part.surface === "Printed_Label").geometry.boundingBox;
assert.ok(MUSIC_LABEL.x - MUSIC_LABEL.width / 2 >= plate.min.x && MUSIC_LABEL.x + MUSIC_LABEL.width / 2 <= plate.max.x);
assert.ok(MUSIC_LABEL.y - MUSIC_LABEL.height / 2 >= plate.min.y && MUSIC_LABEL.y + MUSIC_LABEL.height / 2 <= plate.max.y);
assert.ok(MUSIC_LABEL.z > plate.max.z && MUSIC_LABEL.z - plate.max.z < 0.002, "label prints on the plate");

// Glass: the V0.1.1b frosted shell and an independent diffuse print across appearance states.
const appearance = new CardAppearance();
const appearanceModel = new THREE.Group();
for (const part of parts.filter(part => isMusicShellSurface(part.surface))) {
  const material = new THREE.MeshPhysicalMaterial();
  configureMusicGlass(part.surface, material);
  assert.ok(material.transmission >= 0.65, `${part.surface} remains glass`);
  const [minimum, maximum] = part.surface === "Ivory_Edges" ? [0.23, 0.28] : [0.38, 0.42];
  assert.ok(material.roughness >= minimum && material.roughness <= maximum, `${part.surface} retains the reference's soft frosted finish`);
  assert.ok(material.clearcoat <= 0.18, `${part.surface} avoids a polished plastic coat`);
  appearance.register(part.surface, material, material.clone());
  const mesh = new THREE.Mesh(part.geometry, material);
  mesh.userData.surface = part.surface;
  mesh.userData.musicShell = true;
  appearanceModel.add(mesh);
}
appearance.register(CASE_DETAIL, createCaseDetailMaterial());
const detailMesh = new THREE.Mesh(lifted, createCaseDetailMaterial());
detailMesh.userData.surface = CASE_DETAIL;
detailMesh.userData.musicShell = true;
detailMesh.userData.caseDetail = true;
appearanceModel.add(detailMesh);
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
// The detail shader: per-surface finish and the coverage dissolve, compiled from the prepared clone.
const shader = { uniforms: {}, vertexShader: "#include <common>\n#include <begin_vertex>",
  fragmentShader: "#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>\n#include <metalnessmap_fragment>" };
detailMesh.material.onBeforeCompile(shader, {});
assert.match(shader.fragmentShader, /caseColors\[caseIndex\]/);
assert.match(shader.fragmentShader, /archiveQuality <= coverage/, "lifted detail dissolves in with the lift");
assert.ok(shader.uniforms.archiveQuality, "the dissolve follows the case's appearance");
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
    assert.equal(detailMesh.userData.appearance.value, quality, "the detail dissolve tracks the lift");
    assert.equal(printedCover.material, print, "Appearance never replaces the separate artwork material");
    assert.equal(JSON.stringify(print.toJSON()), printBefore, "Frosting, selection quality and themes do not mutate the artwork material");
  }
}
console.log(`Music case passed: ${bytes.length} byte GLB authored at ${MUSIC_MODEL.width} × ${MUSIC_MODEL.height} × ${MUSIC_MODEL.depth}, shelf instance ${shelfTriangles} / lifted ${liftedTriangles} triangles, no coplanar overlaps at either level, print window clear and in front, merged detail (one lifted mesh, one shelf batch), label on its plate, V0.1.1b frosted glass and independent artwork across appearance states.`);
