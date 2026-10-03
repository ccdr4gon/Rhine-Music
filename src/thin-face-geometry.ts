import * as THREE from "three";

type Triangle = { offset: number; vertices: [number, number, number]; normal: THREE.Vector3 };
type Strip = {
  triangles: [Triangle, Triangle];
  start: THREE.Vector3;
  end: THREE.Vector3;
  halfWidth: THREE.Vector3;
  // Start-negative, end-negative, start-positive, end-positive.
  corners: [number, number, number, number];
};

const POSITION_TOLERANCE = 1e-5;
const NORMAL_COSINE = Math.cos(THREE.MathUtils.degToRad(0.5));

/**
 * Split actual, long rectangular shell facets, never inferred silhouette lines.
 * The expanded raster footprint is the material's responsibility; all positions,
 * normals, UVs and triangle winding here still describe the authored surface.
 */
export function splitThinFaces(geometry: THREE.BufferGeometry): {
  body: THREE.BufferGeometry;
  strips: THREE.BufferGeometry | null;
  faceCount: number;
} {
  const body = geometry.clone();
  const index = geometry.index;
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const unchanged = () => ({ body, strips: null, faceCount: 0 });
  // Music shells have indexed, single-material geometry. Preserve unsupported
  // inputs intact instead of guessing welded topology or rewriting draw groups.
  if (!index || !position || !normal || position.itemSize !== 3 || normal.itemSize !== 3 ||
      index.count % 3 !== 0 || geometry.groups.length ||
      Object.keys(geometry.morphAttributes).length ||
      geometry.drawRange.start !== 0 || geometry.drawRange.count !== Infinity) return unchanged();

  const point = (vertex: number) => new THREE.Vector3().fromBufferAttribute(position, vertex);
  const vertexNormal = (vertex: number) => new THREE.Vector3().fromBufferAttribute(normal, vertex);
  const adjacency = new Map<string, Triangle[]>();
  for (let offset = 0; offset < index.count; offset += 3) {
    const vertices = [index.getX(offset), index.getX(offset + 1), index.getX(offset + 2)] as [number, number, number];
    const [a, b, c] = vertices.map(point);
    const faceNormal = b.clone().sub(a).cross(c.clone().sub(a));
    if (faceNormal.lengthSq() < 1e-18) continue;
    const triangle = { offset, vertices, normal: faceNormal.normalize() };
    for (let edge = 0; edge < 3; edge++) {
      const a = vertices[edge], b = vertices[(edge + 1) % 3];
      const key = `${Math.min(a, b)},${Math.max(a, b)}`;
      const neighbors = adjacency.get(key);
      if (neighbors) neighbors.push(triangle);
      else adjacency.set(key, [triangle]);
    }
  }

  const removed = new Set<number>();
  const selected: Strip[] = [];
  for (const [edge, neighbors] of adjacency) {
    if (neighbors.length !== 2) continue;
    const [first, second] = neighbors;
    if (removed.has(first.offset) || removed.has(second.offset) ||
        first.normal.dot(second.normal) < 1 - 1e-7) continue;
    const [a, c] = edge.split(",").map(Number);
    const b = first.vertices.find(vertex => vertex !== a && vertex !== c)!;
    const d = second.vertices.find(vertex => vertex !== a && vertex !== c)!;
    if (b === d || b === undefined || d === undefined) continue;
    const origin = point(a), diagonal = point(c);
    const u = point(b).sub(origin), v = point(d).sub(origin);
    const uLength = u.length(), vLength = v.length();
    if (uLength < 1e-8 || vLength < 1e-8 ||
        Math.abs(u.dot(v)) > uLength * vLength * 1e-4 ||
        origin.clone().add(u).add(v).distanceTo(diagonal) > POSITION_TOLERANCE) continue;
    // Shared edge must be the diagonal of a rectangle, not a bevel cap or a
    // neighboring face that merely happens to have a similar normal.
    const along = uLength > vLength ? b : d;
    const across = uLength > vLength ? d : b;
    const width = Math.min(uLength, vLength);
    if (Math.max(uLength, vLength) <= 1 || width > 0.04) continue;
    const corners = [a, along, across, c] as Strip["corners"];
    const normals = corners.map(vertexNormal);
    if (normals.some(n => n.lengthSq() < 1e-12) ||
        normals[0].clone().normalize().dot(normals[1].clone().normalize()) < NORMAL_COSINE ||
        normals[2].clone().normalize().dot(normals[3].clone().normalize()) < NORMAL_COSINE) continue;
    selected.push({ triangles: [first, second], corners,
      start: origin.clone().add(point(across)).multiplyScalar(0.5),
      end: point(along).add(diagonal).multiplyScalar(0.5),
      halfWidth: point(across).sub(origin).multiplyScalar(0.5),
    });
    removed.add(first.offset); removed.add(second.offset);
  }
  if (!selected.length) return unchanged();

  const remaining: number[] = [];
  for (let offset = 0; offset < index.count; offset += 3) if (!removed.has(offset)) {
    remaining.push(index.getX(offset), index.getX(offset + 1), index.getX(offset + 2));
  }
  body.setIndex(remaining);

  const strips = new THREE.BufferGeometry();
  const vertexCount = selected.length * 6;
  const copied = Object.entries(geometry.attributes).map(([name, attribute]) => {
    // getComponent also handles interleaved and normalized source attributes.
    const values = new Float32Array(vertexCount * attribute.itemSize);
    strips.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize));
    return { attribute, values };
  });
  const attributes = {
    rhineStart: new Float32Array(vertexCount * 3),
    rhineEnd: new Float32Array(vertexCount * 3),
    rhineHalfWidth: new Float32Array(vertexCount * 3),
    rhineCorner: new Float32Array(vertexCount * 2),
    rhineNormal0: new Float32Array(vertexCount * 3),
    rhineNormal1: new Float32Array(vertexCount * 3),
  };
  let output = 0;
  for (const strip of selected) {
    const [startNegative, endNegative, startPositive, endPositive] = strip.corners;
    const normal0 = [vertexNormal(startNegative), vertexNormal(endNegative)];
    const normal1 = [vertexNormal(startPositive), vertexNormal(endPositive)];
    for (const triangle of strip.triangles) for (const vertex of triangle.vertices) {
      const end = vertex === endNegative || vertex === endPositive ? 1 : 0;
      const side = vertex === startPositive || vertex === endPositive ? 1 : -1;
      for (const { attribute, values } of copied) for (let component = 0; component < attribute.itemSize; component++) {
        values[output * attribute.itemSize + component] = attribute.getComponent(vertex, component);
      }
      strip.start.toArray(attributes.rhineStart, output * 3);
      strip.end.toArray(attributes.rhineEnd, output * 3);
      strip.halfWidth.toArray(attributes.rhineHalfWidth, output * 3);
      attributes.rhineCorner.set([end, side], output * 2);
      // Each endpoint retains both authored side normals. The fragment shader
      // can restore the true transverse gradient after expanding raster support.
      normal0[end].toArray(attributes.rhineNormal0, output * 3);
      normal1[end].toArray(attributes.rhineNormal1, output * 3);
      output++;
    }
  }
  for (const [name, values] of Object.entries(attributes)) {
    strips.setAttribute(name, new THREE.BufferAttribute(values, name === "rhineCorner" ? 2 : 3));
  }
  strips.computeBoundingBox();
  strips.computeBoundingSphere();
  return { body, strips, faceCount: selected.length };
}
