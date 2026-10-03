import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { isMusicShellSurface } from "../src/music-model.ts";
import { splitThinFaces } from "../src/thin-face-geometry.ts";

function triangleSignatures(geometry) {
  const { position, normal, uv } = geometry.attributes;
  const index = geometry.index;
  const signatures = [], count = index?.count ?? position.count;
  let area = 0;
  for (let i = 0; i < count; i += 3) {
    const ids = [0, 1, 2].map(offset => index ? index.getX(i + offset) : i + offset);
    const points = ids.map(id => new THREE.Vector3().fromBufferAttribute(position, id));
    area += points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0])).length() / 2;
    signatures.push(ids.map(id => [position, normal, uv].filter(Boolean).flatMap(attribute =>
      Array.from({ length: attribute.itemSize }, (_, component) => attribute.getComponent(id, component)),
    )).flat().join(","));
  }
  return { signatures: signatures.sort(), area };
}

function renderedBounds(geometry) {
  const bounds = new THREE.Box3(), position = geometry.attributes.position;
  for (let i = 0; i < (geometry.index?.count ?? position.count); i++) {
    bounds.expandByPoint(new THREE.Vector3().fromBufferAttribute(position, geometry.index ? geometry.index.getX(i) : i));
  }
  return bounds;
}

function verifyStripAttributes(strips) {
  const a = strips.attributes;
  const vec = (name, index) => new THREE.Vector3().fromBufferAttribute(a[name], index);
  for (let start = 0; start < a.position.count; start += 6) {
    assert.ok(vec("rhineEnd", start).distanceTo(vec("rhineStart", start)) > 1);
    assert.ok(vec("rhineHalfWidth", start).length() * 2 <= 0.040001);
    const corners = new Set();
    for (let i = start; i < start + 6; i++) {
      for (const name of ["rhineStart", "rhineEnd", "rhineHalfWidth"])
        assert.deepEqual(vec(name, i).toArray(), vec(name, start).toArray());
      const end = a.rhineCorner.getX(i), side = a.rhineCorner.getY(i);
      assert.ok(end === 0 || end === 1); assert.ok(side === -1 || side === 1);
      corners.add(`${end}/${side}`);
      const recovered = vec("rhineStart", i).lerp(vec("rhineEnd", i), end)
        .addScaledVector(vec("rhineHalfWidth", i), side);
      assert.ok(recovered.distanceTo(vec("position", i)) < 1e-5, "Proxy descriptors reproduce the original corner");
      assert.deepEqual(vec(side < 0 ? "rhineNormal0" : "rhineNormal1", i).toArray(),
        vec("normal", i).toArray(), "Both side normals preserve the original endpoint shading");
    }
    assert.equal(corners.size, 4, "Each strip retains a complete rectangular face");
  }
}

test("actual shell facets preserve all original triangles, attributes, area and source geometry", async () => {
  const bytes = await fs.readFile(new URL("../public/assets/music-case.glb", import.meta.url));
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
  gltf.scene.updateMatrixWorld(true);
  // The glass shell only: the case's opaque detail is merged elsewhere and never split.
  const expected = { Frosted_Polymer: 20, Ivory_Edges: 42, Optical_Diffuser: 20 };
  gltf.scene.traverse(object => {
    if (!(object instanceof THREE.Mesh) || !isMusicShellSurface(object.material.name)) return;
    const surface = object.material.name;
    const source = object.geometry.clone().applyMatrix4(object.matrixWorld);
    const before = JSON.stringify(source.toJSON());
    const original = triangleSignatures(source);
    const { body, strips, faceCount } = splitThinFaces(source);
    assert.equal(faceCount, expected[surface], surface);
    assert.equal(JSON.stringify(source.toJSON()), before, "Source geometry and metadata are read-only");
    assert.notEqual(body, source);
    const bodyTriangles = triangleSignatures(body), stripTriangles = triangleSignatures(strips);
    assert.deepEqual([...bodyTriangles.signatures, ...stripTriangles.signatures].sort(), original.signatures,
      `${surface}: every oriented triangle and its normals/UVs occurs exactly once`);
    assert.ok(Math.abs(bodyTriangles.area + stripTriangles.area - original.area) < 1e-9);
    for (const [name, attribute] of Object.entries(source.attributes))
      assert.deepEqual(body.attributes[name].array, attribute.array, "Body attributes remain intact");
    // Ignore unused body vertices: only triangles that are still drawn may
    // establish the combined bounds after extraction.
    assert.deepEqual(renderedBounds(body).union(renderedBounds(strips)), renderedBounds(source));
    verifyStripAttributes(strips);
    body.dispose(); strips.dispose(); source.dispose();
  });
});

function rectangle({ trapezoid = 0, length = 3, width = 0.02, normalDrift = 0 } = {}) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    0, 0, 0, length, 0, 0, 0, width, 0, length + trapezoid, width, 0,
  ], 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute([
    0, 0, 1, Math.sin(normalDrift), 0, Math.cos(normalDrift), 0, 0, 1, 0, 0, 1,
  ], 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
  geometry.setIndex([0, 1, 2, 2, 1, 3]);
  return geometry;
}

test("a rotated rectangular surface preserves winding and the transverse normal data", () => {
  const geometry = rectangle({ normalDrift: THREE.MathUtils.degToRad(0.2) });
  geometry.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.6, 0.3, -0.4)));
  const result = splitThinFaces(geometry);
  assert.equal(result.faceCount, 1);
  assert.equal(result.body.index.count, 0);
  assert.deepEqual(triangleSignatures(result.strips).signatures, triangleSignatures(geometry).signatures);
  verifyStripAttributes(result.strips);
});

test("short caps, broad faces, trapezoids and changing longitudinal normals are not replaced", () => {
  for (const options of [{ length: 0.3 }, { width: 0.08 }, { trapezoid: 0.03 }, { normalDrift: THREE.MathUtils.degToRad(0.8) }]) {
    const geometry = rectangle(options);
    const result = splitThinFaces(geometry);
    assert.equal(result.faceCount, 0, JSON.stringify(options));
    assert.equal(result.strips, null);
    assert.deepEqual(triangleSignatures(result.body), triangleSignatures(geometry));
  }
});

test("non-indexed and grouped geometries keep their original rendering contract", () => {
  const nonIndexed = rectangle().toNonIndexed(), grouped = rectangle();
  grouped.addGroup(0, 6, 1);
  for (const geometry of [nonIndexed, grouped]) {
    const before = JSON.stringify(geometry.toJSON());
    const result = splitThinFaces(geometry);
    assert.equal(result.faceCount, 0); assert.equal(result.strips, null);
    assert.notEqual(result.body, geometry);
    assert.deepEqual(triangleSignatures(result.body), triangleSignatures(geometry));
    assert.deepEqual(result.body.groups, geometry.groups);
    assert.equal(JSON.stringify(geometry.toJSON()), before);
  }
});
