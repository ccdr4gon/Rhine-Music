import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MUSIC_MODEL, MUSIC_COVER, MUSIC_LABEL, configureMusicGlass, createAlbumPrintMaterial, isMusicShellSurface, musicCaseLevel } from "../src/music-model.ts";
import { CASE_DETAIL, caseDetailShader, caseDetailUniforms, createCaseDetailMaterial, mergeCaseDetail } from "../src/music-case-detail.ts";
import { MUSIC_CASE_ASSET } from "../src/music-case-asset.ts";
import { CardAppearance } from "../src/appearance.ts";
import { COVER_TINT_CHROMA_MAX, COVER_TINT_THEME, coverTintForTheme } from "../src/cover-tint.ts";
import { ThemeTransition } from "../src/theme-transition.ts";

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
const stubShader = () => ({ uniforms: {}, vertexShader: "#include <common>\n#include <begin_vertex>",
  fragmentShader: "#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>\n#include <metalnessmap_fragment>" });
const shader = stubShader();
detailMesh.material.onBeforeCompile(shader, {});
assert.match(shader.fragmentShader, /caseColors\[caseIndex\]/);
assert.match(shader.fragmentShader, /archiveQuality <= coverage/, "lifted detail dissolves in with the lift");
assert.ok(shader.uniforms.archiveQuality, "the dissolve follows the case's appearance");

// The index square takes the cover's colour: the lifted case reads it from a uniform of its
// own, the shelf batch from an instanced attribute. Both start from the table colour, and
// only a tint with weight, on the index inlay, replaces it: without cover art the amber stays.
const inlay = mergeCaseDetail(sources.filter(mesh => mesh.material.name.replace(/\.\d+$/, "") === "Index_Inlay"))
  .lifted.getAttribute("caseSurface").getX(0);
const liftedTint = detailMesh.userData.caseTint;
assert.equal(shader.uniforms.caseTint, liftedTint, "the lifted case's shader reads the uniform setTint writes");
assert.deepEqual(liftedTint.value.toArray(), [0, 0, 0, 0], "no cover colour until one is set: weight 0, the amber (weight 1 would be a black square)");
assert.match(shader.fragmentShader, /uniform vec4 caseTint;/);
assert.doesNotMatch(shader.fragmentShader, /vCaseTint/);
assert.doesNotMatch(shader.vertexShader, /caseTint/i, "a single case needs neither the attribute nor its varying");
const shelfShader = stubShader();
caseDetailShader(shelfShader, false);
assert.match(shelfShader.vertexShader, /attribute vec4 caseTint;/, "every shelf instance carries its own cover colour");
assert.match(shelfShader.vertexShader, /varying vec4 vCaseTint;/);
assert.match(shelfShader.vertexShader, /vCaseTint = caseTint;/);
assert.match(shelfShader.fragmentShader, /varying vec4 vCaseTint;/);
assert.equal(shelfShader.uniforms.caseTint, undefined, "the shelf batch has no single colour");
assert.doesNotMatch(shelfShader.fragmentShader, /uniform vec4 caseTint;/);
assert.doesNotMatch(shelfShader.fragmentShader, /archiveQuality/, "and no dissolve: its material declares no archiveQuality");
const tintedColour = new RegExp([
  String.raw`vec3 caseColor = caseColors\[caseIndex\];`,
  String.raw`vec4 caseInk = (caseTint|vCaseTint);`,
  String.raw`if \(caseIndex == (\d+) && caseInk\.a > 0\.0\)`,
  String.raw`caseColor = mix\(caseColor, caseTintThemed\(caseInk\.rgb, caseTintTheme\), caseInk\.a\);`,
  String.raw`diffuseColor\.rgb \*= caseColor;`,
].join(String.raw`\s*`));
for (const [name, compiled, ink] of [["lifted", shader, "caseTint"], ["shelf", shelfShader, "vCaseTint"]]) {
  assert.equal(compiled.uniforms.caseTintTheme, caseDetailUniforms.caseTintTheme, `${name}: every case follows the same theme numbers`);
  assert.match(compiled.fragmentShader, /uniform vec3 caseTintTheme;/);
  assert.ok(compiled.fragmentShader.includes("vec3 caseColor = caseColors[caseIndex];"), `${name}: every surface starts from the table colour`);
  const colour = compiled.fragmentShader.match(tintedColour);
  assert.ok(colour, `${name}: only a tint with weight stands between the table colour and the surface`);
  assert.equal(colour[1], ink, `${name}: the tint comes from ${ink}`);
  assert.equal(Number(colour[2]), inlay, `${name}: and only the index inlay takes it`);
  assert.equal(compiled.fragmentShader.split("caseTintThemed(").length - 1, 2, `${name}: the theme mapping is defined once and used once`);
}

// caseTintThemed evaluated here from the shader's own text, in 32-bit floats as the GPU runs it:
// every statement is matched and its matrices and limits are read out of it, nothing is retyped.
const glslNumber = String.raw`-?\d+(?:\.\d*)?(?:e-?\d+)?`;
const glslMat3 = String.raw`mat3\(((?:${glslNumber}, ){8}${glslNumber})\)`;
const themedGLSL = new RegExp([
  String.raw`vec3 caseTintThemed\(vec3 ink, vec3 theme\) \{`,
  String.raw`vec3 lms = pow\(max\(${glslMat3} \* ink, 0\.0\), vec3\(1\.0 \/ 3\.0\)\);`,
  String.raw`vec3 lab = ${glslMat3} \* lms;`,
  String.raw`lab\.x = theme\.x \+ theme\.y \* lab\.x;`,
  String.raw`lab\.yz \*= min\(theme\.z, max\(1\.0, (${glslNumber}) \/ max\(length\(lab\.yz\), (${glslNumber})\)\)\);`,
  String.raw`lms = ${glslMat3} \* lab;`,
  String.raw`return clamp\(${glslMat3} \* \(lms \* lms \* lms\), 0\.0, 1\.0\);`,
  String.raw`\}`,
].join(String.raw`\s*`));
function themedFromGLSL(fragment) {
  const parsed = fragment.match(themedGLSL);
  assert.ok(parsed, "caseTintThemed keeps the statements this check evaluates (change the two together)");
  const f = Math.fround;
  // mat3 lists its columns: entry 3 * column + row.
  const matrix = (text) => {
    const m = text.split(", ").map(Number);
    return (v) => [0, 1, 2].map(row => f(m[row] * v[0] + m[3 + row] * v[1] + m[6 + row] * v[2]));
  };
  const [toLms, toLab, fromLab, toRgb] = [parsed[1], parsed[2], parsed[5], parsed[6]].map(matrix);
  const chromaMax = Number(parsed[3]), shortest = Number(parsed[4]);
  const oklab = (rgb) => toLab(toLms(rgb.map(f)).map(v => f(Math.cbrt(Math.max(v, 0)))));
  const unclamped = (ink, theme) => {
    const lab = oklab(ink), [offset, slope, chroma] = theme.map(f);
    lab[0] = f(offset + slope * lab[0]);
    const scale = f(Math.min(chroma, Math.max(1, chromaMax / Math.max(Math.hypot(lab[1], lab[2]), shortest))));
    lab[1] = f(lab[1] * scale);
    lab[2] = f(lab[2] * scale);
    return toRgb(fromLab(lab).map(v => f(v * v * v)));
  };
  const shown = (ink, theme) => unclamped(ink, theme).map(v => Math.min(1, Math.max(0, v)));
  return { source: parsed[0], chromaMax, oklab, unclamped, shown };
}
const themed = themedFromGLSL(shader.fragmentShader);
assert.equal(themedFromGLSL(shelfShader.fragmentShader).source, themed.source, "shelf and lifted cases map a tint alike");
assert.ok(Math.abs(themed.chromaMax - COVER_TINT_CHROMA_MAX) < 1e-4, "the shader stops scaling chroma at the tint module's limit");

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

// Themes: the amber of a case without cover art keeps its hand-picked colours, and a cover's
// colour follows through three numbers. What the shader then shows is coverTintForTheme.
const themeNumbers = () => caseDetailUniforms.caseTintTheme.value.toArray();
const amber = { day: "dcb47f", night: "d2a066", dusk: "b99a76" };
const inks = ["#dcb47f", "#43668d", "#d98a9c", "#5f8fd0", "#b06a2c", "#9a4f7a", "#2e9e5b", "#8e55b2", "#3b5cb8", "#bd4a45", "#c0392b", "#e6d450", "#797979", "#c8c8c8"]
  .map(hex => [hex, new THREE.Color(hex).toArray()]);
for (const theme of ["night", "dusk", "day"]) {
  appearance.setTheme(theme);
  assert.deepEqual(themeNumbers(), [...COVER_TINT_THEME[theme]], `${theme}: the shader's theme numbers are the tint module's`);
  assert.equal(caseDetailUniforms.caseColors.value[inlay].getHexString(), amber[theme], `${theme}: a case without cover art keeps its hand-picked amber`);
  for (const [hex, ink] of inks) {
    // Day leaves a tint as it is. Night and dusk: these stay displayable, so the shader's
    // clamp and coverTintForTheme's chroma reduction both rest and the two must agree.
    const expected = theme === "day" ? ink : coverTintForTheme(ink, theme);
    if (theme !== "day") assert.ok(themed.unclamped(ink, themeNumbers()).every(value => value >= 0 && value <= 1), `${hex} can be shown under ${theme} as mapped`);
    themed.shown(ink, themeNumbers()).forEach((value, channel) => assert.ok(Math.abs(value - expected[channel]) < 1e-5,
      `${hex} under ${theme}: the shader shows ${value} in channel ${channel}, expected ${expected[channel]}`));
  }
}
// Past what the screen can show (a vivid tint, warmed at night) the shader clamps channels where
// coverTintForTheme reduces chroma: the two stay closer than a noticeable difference in OKLab.
appearance.setTheme("night");
for (const hex of ["#ae6700", "#11a7b5"]) {
  const ink = new THREE.Color(hex).toArray();
  assert.ok(themed.unclamped(ink, themeNumbers()).some(value => value < 0 || value > 1), `${hex} leaves the displayable range at night`);
  const shown = themed.oklab(themed.shown(ink, themeNumbers())), reduced = themed.oklab(coverTintForTheme(ink, "night"));
  assert.ok(Math.hypot(shown[0] - reduced[0], shown[1] - reduced[1], shown[2] - reduced[2]) < 0.02, `${hex} at night: the clamped colour stays close to the reduced one`);
}
// A theme change blends the three numbers on the scene's transition clock, like the table colours.
appearance.setTheme("day");
const transition = new ThemeTransition(1000); // seconds: the times passed below decide the progress
appearance.setTheme("night", transition);
assert.deepEqual(themeNumbers(), [...COVER_TINT_THEME.day], "nothing moves before the clock does");
transition.update(performance.now() / 1000 + 500);
themeNumbers().forEach((value, i) => {
  const [from, to] = [COVER_TINT_THEME.day[i], COVER_TINT_THEME.night[i]];
  assert.ok(Math.min(from, to) < value && value < Math.max(from, to), "halfway to night each number lies between the two themes");
});
assert.equal(transition.update(performance.now() / 1000 + 2000), true);
assert.deepEqual(themeNumbers(), [...COVER_TINT_THEME.night], "and arrives on night's numbers");

// Each case owns its colour: a returning copy (clone and prepare, as the scene makes it) gets a
// uniform of its own, so the lifted case takes the next album's colour without recolouring it.
appearance.setTint(appearanceModel, new THREE.Vector4(0.2, 0.4, 0.6, 1));
assert.deepEqual(shader.uniforms.caseTint.value.toArray(), [0.2, 0.4, 0.6, 1], "setTint reaches the compiled uniform");
const returning = appearanceModel.clone(true);
appearance.prepare(returning);
const returningDetail = returning.children.find(child => child.userData.caseDetail);
const returningTint = returningDetail.userData.caseTint;
assert.ok(returningTint.value.isVector4 && returningTint !== liftedTint && returningTint.value !== liftedTint.value, "a copy has a colour uniform of its own");
assert.deepEqual(returningTint.value.toArray(), [0, 0, 0, 0], "and starts on the amber until it is given its print's colour");
const returningShader = stubShader();
returningDetail.material.onBeforeCompile(returningShader, {});
assert.equal(returningShader.uniforms.caseTint, returningTint, "which is the one its shader reads");
appearance.setTint(returning, new THREE.Vector4(0.7, 0.1, 0.3, 1));
assert.deepEqual(returningShader.uniforms.caseTint.value.toArray(), [0.7, 0.1, 0.3, 1]);
assert.deepEqual(shader.uniforms.caseTint.value.toArray(), [0.2, 0.4, 0.6, 1], "colouring the copy leaves the lifted case alone");
appearance.setTint(appearanceModel, new THREE.Vector4(0, 0, 0, 0));
assert.deepEqual(shader.uniforms.caseTint.value.toArray(), [0, 0, 0, 0], "the lifted case is back on the amber");
assert.deepEqual(returningShader.uniforms.caseTint.value.toArray(), [0.7, 0.1, 0.3, 1], "while the copy keeps the colour it left with");
console.log(`Music case passed: ${bytes.length} byte GLB authored at ${MUSIC_MODEL.width} × ${MUSIC_MODEL.height} × ${MUSIC_MODEL.depth}, shelf instance ${shelfTriangles} / lifted ${liftedTriangles} triangles, no coplanar overlaps at either level, print window clear and in front, merged detail (one lifted mesh, one shelf batch), label on its plate, V0.1.1b frosted glass and independent artwork across appearance states, cover-coloured index square (a uniform per lifted case, an attribute on the shelf, amber without cover art, theme mapping equal to coverTintForTheme).`);
