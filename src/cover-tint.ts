// Dependency-free so the cover worker can colour the case's index square without three.js.
// The square (the inlay at the case's top-left corner) takes the cover's most prominent
// hue, held inside the band of lightness and chroma in which a small matte square stays
// readable on the ivory and the night shell. A case without cover art keeps its amber.
import type { CoverMip } from "./cover-mipmaps.ts";

/** Linear-sRGB, 0..1: what THREE.Color holds and what the case detail shader multiplies by. */
export type CoverTint = [r: number, g: number, b: number];

/** Mip level the tint is read from: a 7% accent survives at 16 px, at 8 px it is washed out. */
export const COVER_TINT_SIZE = 16;

const HUE_BINS = 24;
const HUE_WINDOW = Math.PI / 6; // the chosen hue gathers pixels within +-30 degrees
const VIVID = 1.25; // exponent on chroma: of two rival hues the more vivid one wins
// In the hue choice a pixel darker than SHADOW_FROM counts SHADOW_WEIGHT, rising to full at SHADOW_TO.
const SHADOW_WEIGHT = 0.15, SHADOW_FROM = 0.15, SHADOW_TO = 0.5;
// Colour evidence (the chosen hue's chroma, spread over the whole art) from "none" to "has one":
// a white sleeve's faint cast stays grey; an all-over cream or a 4% vivid accent is a colour.
const EVIDENCE_NONE = 0.003, EVIDENCE_FULL = 0.012;
const LIGHT_MIN = 0.5; // darker reads as a hole in the shell at night
const LIGHT_MAX = 0.8, LIGHT_MAX_VIVID = 0.86; // lighter melts into ivory unless chroma separates it (yellow)
const CHROMA_MIN = 0.075; // the fixed amber is 0.083
/** The most chroma (OKLCH) a square takes: neon is held back. */
export const COVER_TINT_CHROMA_MAX = 0.15;
const CHROMA_MAX = COVER_TINT_CHROMA_MAX;

const linear = Float32Array.from({ length: 256 }, (_, byte) => {
  const value = byte / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
});
const smooth = (from: number, to: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

function toOklab(r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab(L: number, a: number, b: number): CoverTint {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const displayable = (c: CoverTint) => Math.min(c[0], c[1], c[2]) >= -1e-4 && Math.max(c[0], c[1], c[2]) <= 1.0001;

/** OKLCH to linear sRGB; chroma gives way (hue and lightness hold) until the colour is displayable. */
function fromOklch(L: number, C: number, hue: number): CoverTint {
  const x = Math.cos(hue), y = Math.sin(hue);
  let color = fromOklab(L, C * x, C * y);
  if (!displayable(color)) {
    let inside = 0, outside = C;
    for (let i = 0; i < 12; i++) {
      const middle = (inside + outside) / 2;
      if (displayable(fromOklab(L, middle * x, middle * y))) inside = middle;
      else outside = middle;
    }
    color = fromOklab(L, inside * x, inside * y);
  }
  return [Math.min(1, Math.max(0, color[0])), Math.min(1, Math.max(0, color[1])), Math.min(1, Math.max(0, color[2]))];
}

/**
 * Day colour of a case's index square, from the mip chain of its painted cover. Undefined
 * when nothing is painted; the caller keeps the fixed amber then, and also for the
 * missing-cover card, which it must not pass in (its grey would come back as a grey square).
 */
export function coverTint(levels: CoverMip[]): CoverTint | undefined {
  // Largest level first: the first one no wider than COVER_TINT_SIZE.
  const level = levels.find((entry) => entry.width <= COVER_TINT_SIZE);
  return level && coverTintFromPixels(level.data, level.width);
}

/**
 * The same from one small square image: RGBA bytes as coverMipmaps stores them (colour
 * times coverage, sRGB-encoded). A cover without colour gives a neutral grey of its own
 * lightness, not the amber.
 */
export function coverTintFromPixels(data: Uint8Array | Uint8ClampedArray, size: number): CoverTint | undefined {
  const count = size * size;
  if (data.length < count * 4) return undefined;
  const lab = new Float32Array(count * 3), hue = new Float32Array(count);
  // Per pixel: coverage, coverage x chroma^VIVID, and the same with shadows held back.
  const weight = new Float32Array(count), strength = new Float32Array(count), vivid = new Float32Array(count);
  const bins = new Float64Array(HUE_BINS);
  let covered = 0, meanLight = 0;
  for (let i = 0; i < count; i++) {
    const alpha = data[i * 4 + 3] / 255;
    if (alpha < 0.1) continue; // transparent margin: the stored colour is not the art's
    const pixel = toOklab(
      Math.min(1, linear[data[i * 4]] / alpha),
      Math.min(1, linear[data[i * 4 + 1]] / alpha),
      Math.min(1, linear[data[i * 4 + 2]] / alpha),
    );
    lab.set(pixel, i * 3);
    weight[i] = alpha;
    hue[i] = Math.atan2(pixel[2], pixel[1]);
    strength[i] = alpha * Math.hypot(pixel[1], pixel[2]) ** VIVID;
    // A shadow's faint cast must not outvote the lit part of a photo.
    vivid[i] = strength[i] * (SHADOW_WEIGHT + (1 - SHADOW_WEIGHT) * smooth(SHADOW_FROM, SHADOW_TO, pixel[0]));
    bins[Math.floor(((hue[i] + Math.PI) / (2 * Math.PI)) * HUE_BINS) % HUE_BINS] += vivid[i];
    covered += alpha;
    meanLight += pixel[0] * alpha;
  }
  if (covered < count * 0.02) return undefined;
  meanLight /= covered;

  // The most prominent hue: the heaviest stretch of the circular hue histogram.
  let peak = 0, peakWeight = -1;
  for (let k = 0; k < HUE_BINS; k++) {
    const value = bins[(k + HUE_BINS - 1) % HUE_BINS] + 2 * bins[k] + bins[(k + 1) % HUE_BINS];
    if (value > peakWeight) { peakWeight = value; peak = k; }
  }
  // Its colour: the weighted mean of the pixels around that hue.
  const centre = ((peak + 0.5) / HUE_BINS) * 2 * Math.PI - Math.PI;
  let light = 0, a = 0, b = 0, sum = 0, evidence = 0;
  for (let i = 0; i < count; i++) {
    if (weight[i] === 0) continue;
    let distance = Math.abs(hue[i] - centre);
    if (distance > Math.PI) distance = 2 * Math.PI - distance;
    if (distance > HUE_WINDOW) continue;
    light += lab[i * 3] * vivid[i]; a += lab[i * 3 + 1] * vivid[i]; b += lab[i * 3 + 2] * vivid[i];
    sum += vivid[i];
    evidence += strength[i];
  }
  if (sum < 1e-12) sum = 1; // no chroma anywhere: the sums are zero and the result is grey
  light /= sum; a /= sum; b /= sum;
  evidence = (evidence / covered) ** (1 / VIVID);

  // A usable accent: fade to the cover's own grey when it has no colour to speak of.
  const has = smooth(EVIDENCE_NONE, EVIDENCE_FULL, evidence);
  const C = has * Math.min(CHROMA_MAX, Math.max(CHROMA_MIN, Math.hypot(a, b)));
  const lightMax = LIGHT_MAX + (LIGHT_MAX_VIVID - LIGHT_MAX) * smooth(CHROMA_MIN, CHROMA_MAX, C);
  const L = Math.min(lightMax, Math.max(LIGHT_MIN, meanLight + (light - meanLight) * has));
  return fromOklch(L, C, Math.atan2(b, a));
}

/**
 * Night and dusk versions of a day tint, as OKLCH [lightness offset, lightness slope, chroma
 * scale]: fitted so that the fixed amber #dcb47f lands on its hand-picked #d2a066 (night) and
 * #b99a76 (dusk) within 0.01 OKLab. Lightness is compressed and lowered, chroma scaled, hue
 * kept. The case detail shader applies the same mapping (caseDetailShader), so a theme
 * change can blend these three numbers.
 */
export const COVER_TINT_THEME = {
  day: [0, 1, 1],
  night: [0.105, 0.8, 1.15],
  dusk: [0.071, 0.8, 0.74],
} as const;

/** What the shader shows for a day tint under a theme (the shader clamps instead of reducing chroma). */
export function coverTintForTheme(day: CoverTint, theme: keyof typeof COVER_TINT_THEME): CoverTint {
  if (theme === "day") return day;
  const [L, a, b] = toOklab(day[0], day[1], day[2]);
  const [offset, slope, chroma] = COVER_TINT_THEME[theme];
  const C = Math.hypot(a, b);
  // Night warms a muted square; one that is already vivid is not pushed further.
  return fromOklch(offset + slope * L, Math.min(C * chroma, Math.max(C, CHROMA_MAX)), Math.atan2(b, a));
}
