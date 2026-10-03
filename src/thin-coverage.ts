/**
 * Coverage of an infinite strip convolved with a normalized tent kernel.
 * All dimensions are in render-target pixels, not CSS pixels. The strip keeps
 * its actual width; radius is the filter support, not a minimum visible width.
 *
 * K(x) = max(1 - abs(x) / radius, 0) / radius
 * coverage(d, w) = CDF(d + w / 2) - CDF(d - w / 2)
 *
 * The difference is factored below to avoid subtracting two CDF values near 1.
 * Do not multiply the result by width again: width is already integrated.
 * This is only the cross-section of an infinite strip, not a finite line cap
 * or a complete two-dimensional pixel-area integral.
 */
export function thinCoverage(distancePx: number, widthPx: number, radiusPx = 1): number {
  if (!Number.isFinite(distancePx) || !Number.isFinite(widthPx) || !Number.isFinite(radiusPx)
    || widthPx <= 0 || radiusPx <= 0) return 0;

  const distance = Math.abs(distancePx);
  const halfWidth = widthPx * 0.5;
  const low = Math.max(-1, (distance - halfWidth) / radiusPx);
  const high = Math.min(1, (distance + halfWidth) / radiusPx);
  if (low >= 1) return 0;

  let coverage: number;
  if (low >= 0) {
    // In the unclipped positive half, use the original width for the CDF
    // interval length so very small strips do not lose precision to b - a.
    const span = distance + halfWidth <= radiusPx ? widthPx / radiusPx : high - low;
    coverage = span * (1 - (low + high) * 0.5);
  } else {
    // distance is nonnegative, so a crossing interval always ends at >= 0.
    coverage = -low * (1 + low * 0.5) + high * (1 - high * 0.5);
  }
  return Math.min(1, Math.max(0, coverage));
}

/** WebGL 2 / GLSL ES 3.00 equivalent of thinCoverage. */
export const THIN_COVERAGE_GLSL = /* glsl */ `
float rhineThinCoverage(float d, float w, float r) {
  if (isnan(d) || isinf(d) || isnan(w) || isinf(w) || isnan(r) || isinf(r)
      || w <= 0.0 || r <= 0.0) return 0.0;
  float distance = abs(d);
  float halfWidth = w * 0.5;
  float low = max(-1.0, (distance - halfWidth) / r);
  float high = min(1.0, (distance + halfWidth) / r);
  if (low >= 1.0) return 0.0;
  float coverage;
  if (low >= 0.0) {
    float span = distance + halfWidth <= r ? w / r : high - low;
    coverage = span * (1.0 - (low + high) * 0.5);
  } else {
    coverage = -low * (1.0 + low * 0.5) + high * (1.0 - high * 0.5);
  }
  return clamp(coverage, 0.0, 1.0);
}
`;
