// Dependency-free so the cover worker can build mip chains without three.js.
export type CoverMip = { data: Uint8Array; width: number; height: number };

const linear = Float32Array.from({ length: 256 }, (_, byte) => {
  const value = byte / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
});
const encoded = Uint8Array.from({ length: 65536 }, (_, index) => {
  const value = index / 65535;
  return Math.round(255 * (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055));
});

/** Filter colour times coverage, in linear light. Transparent RGB contributes nothing. */
export function coverMipmaps(source: Uint8Array | Uint8ClampedArray, size: number): CoverMip[] {
  if (!Number.isInteger(size) || size < 1 || (size & (size - 1)) !== 0 || source.length !== size * size * 4)
    throw new Error("Cover mipmaps require a square power-of-two image");
  let pixels = new Float32Array(source.length);
  for (let p = 0; p < source.length; p += 4) {
    const alpha = source[p + 3] / 255;
    pixels[p] = linear[source[p]] * alpha;
    pixels[p + 1] = linear[source[p + 1]] * alpha;
    pixels[p + 2] = linear[source[p + 2]] * alpha;
    pixels[p + 3] = alpha;
  }
  const result: CoverMip[] = [];
  for (let width = size; ; width /= 2) {
    const data = new Uint8Array(pixels.length);
    for (let p = 0; p < pixels.length; p += 4) {
      for (let c = 0; c < 3; c++) data[p + c] = encoded[Math.round(pixels[p + c] * 65535)];
      data[p + 3] = Math.round(pixels[p + 3] * 255);
    }
    result.push({ data, width, height: width });
    if (width === 1) break;
    const nextWidth = width / 2, next = new Float32Array(nextWidth * nextWidth * 4);
    for (let y = 0; y < nextWidth; y++) for (let x = 0; x < nextWidth; x++) {
      const to = (y * nextWidth + x) * 4, from = (y * 2 * width + x * 2) * 4;
      for (let c = 0; c < 4; c++)
        next[to + c] = (pixels[from + c] + pixels[from + 4 + c] + pixels[from + width * 4 + c] + pixels[from + width * 4 + 4 + c]) / 4;
    }
    pixels = next;
  }
  return result;
}
