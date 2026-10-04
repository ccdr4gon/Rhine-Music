import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { isMusicShellSurface, musicCaseLevel } from "./music-model";
import { COVER_TINT_CHROMA_MAX, COVER_TINT_THEME } from "./cover-tint.ts";

/**
 * The music case's opaque detail (art/build_music_case.py) comes as one glTF node per
 * surface and level. Drawn like that, the lifted case alone would add nine meshes to every
 * pass. Merged here instead: each vertex carries its surface (colour and finish come from
 * one shared table) and its level, so the lifted case draws all of its detail in one call
 * and the shelf draws its inlays and screws in one instanced batch.
 */
export const CASE_DETAIL = "Music_Case_Detail";
export const CASE_HARDWARE = "Music_Case_Hardware";

type Finish = { color: string; roughness: number; metalness: number; night?: [night: string, dusk: string] };
// Night and dusk keep the amber index warm while pressed lines and lettering follow the
// cool shell. Fasteners and the label keep their finish in every theme. The index inlay
// is the square at the case's top-left corner: amber here, and the cover's own colour on
// a case that shows cover art (see caseDetailShader).
const SURFACES: Record<string, Finish> = {
  Index_Inlay: { color: "#dcb47f", roughness: 0.46, metalness: 0.06, night: ["#d2a066", "#b99a76"] },
  Titanium_Fasteners: { color: "#a3a7a8", roughness: 0.24, metalness: 0.82 },
  Case_Engraving: { color: "#958c80", roughness: 0.5, metalness: 0.04, night: ["#7f8b98", "#7b868d"] },
  Case_Engraving_Highlight: { color: "#fffaf2", roughness: 0.3, metalness: 0.04, night: ["#f4f9ff", "#e6eef0"] },
  Moulded_Lettering: { color: "#c9bda9", roughness: 0.34, metalness: 0.04, night: ["#9eaebf", "#97a6ad"] },
  Printed_Label: { color: "#f2eee6", roughness: 0.62, metalness: 0 },
  Champagne_Index: { color: "#c99d63", roughness: 0.32, metalness: 0.5 },
  Optical_Edges: { color: "#f1ebe1", roughness: 0.3, metalness: 0.04, night: ["#e6eef7", "#d8e2e6"] },
};
const NAMES = Object.keys(SURFACES);
const INLAY = NAMES.indexOf("Index_Inlay");

// One table for every detail material, so a theme change recolours them all at once.
const day = NAMES.map((name) => new THREE.Color(SURFACES[name].color));
export const caseDetailUniforms = {
  caseColors: { value: day.map((color) => color.clone()) },
  // How a cover's colour on the index inlay follows the theme (COVER_TINT_THEME), as the amber follows its table.
  caseTintTheme: { value: new THREE.Vector3(...COVER_TINT_THEME.day) },
  caseFinish: { value: NAMES.map((name) => new THREE.Vector2(SURFACES[name].roughness, SURFACES[name].metalness)) },
};

/** Target of caseTintTheme under a theme. */
export const caseTintTheme = (theme: "day" | "night" | "dusk") => COVER_TINT_THEME[theme];

// coverTintForTheme in GLSL (linear sRGB through OKLab and back); channels clamp where it reduces chroma.
const TINT_THEME_GLSL = `
vec3 caseTintThemed(vec3 ink, vec3 theme) {
  vec3 lms = pow(max(mat3(0.4122214708, 0.2119034982, 0.0883024619, 0.5363325363, 0.6806995451, 0.2817188376, 0.0514459929, 0.1073969566, 0.6299787005) * ink, 0.0), vec3(1.0 / 3.0));
  vec3 lab = mat3(0.2104542553, 1.9779984951, 0.0259040371, 0.793617785, -2.428592205, 0.7827717662, -0.0040720468, 0.4505937099, -0.808675766) * lms;
  lab.x = theme.x + theme.y * lab.x;
  lab.yz *= min(theme.z, max(1.0, ${COVER_TINT_CHROMA_MAX.toFixed(4)} / max(length(lab.yz), 1e-5)));
  lms = mat3(1.0, 1.0, 1.0, 0.3963377774, -0.1055613458, -0.0894841775, 0.2158037573, -0.0638541728, -1.291485548) * lab;
  return clamp(mat3(4.0767416621, -1.2684380046, -0.0041960863, -3.3077115913, 2.6097574011, -0.7034186147, 0.2309699292, -0.3413193965, 1.707614701) * (lms * lms * lms), 0.0, 1.0);
}`;

/** Target colour of every detail surface under a theme, in table order. */
export function caseDetailTheme(theme: "day" | "night" | "dusk") {
  return NAMES.map((name, i) => {
    const night = SURFACES[name].night;
    return theme === "day" || !night ? day[i] : new THREE.Color(night[theme === "night" ? 0 : 1]);
  });
}

// Per vertex: 1 fades in as the case lifts (lod0), 0 fades out (lod1 stand-ins), 2 stays.
const FADE = { lod0: 1, lod1: 0, shared: 2 } as const;

function surfaceGeometry(mesh: THREE.Mesh, fade: number) {
  const name = (mesh.material as THREE.Material).name.replace(/\.\d+$/, "");
  const index = NAMES.indexOf(name);
  if (index < 0) throw new Error(`Music case: no finish for ${name}`);
  const source = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(source.index);
  geometry.setAttribute("position", source.getAttribute("position"));
  geometry.setAttribute("normal", source.getAttribute("normal"));
  const count = source.getAttribute("position").count;
  geometry.setAttribute("caseSurface", new THREE.Float32BufferAttribute(new Float32Array(count).fill(index), 1));
  geometry.setAttribute("caseFade", new THREE.Float32BufferAttribute(new Float32Array(count).fill(fade), 1));
  return geometry;
}

/**
 * Split the loaded case into its glass shell (left to the caller) and the merged detail:
 * `lifted` holds everything the lifted case shows, including the shelf stand-ins it
 * dissolves out; `shelf` holds the parts every shelf instance draws.
 */
export function mergeCaseDetail(meshes: THREE.Mesh[], { standIns = true } = {}) {
  const lifted: THREE.BufferGeometry[] = [];
  const shelf: THREE.BufferGeometry[] = [];
  for (const mesh of meshes) {
    const name = (mesh.material as THREE.Material).name.replace(/\.\d+$/, "");
    if (isMusicShellSurface(name)) continue;
    const level = musicCaseLevel(mesh);
    if (level !== "lod1" || standIns) lifted.push(surfaceGeometry(mesh, FADE[level]));
    if (level !== "lod0") shelf.push(surfaceGeometry(mesh, FADE.shared));
  }
  const merge = (parts: THREE.BufferGeometry[]) => {
    if (!parts.length) return null;
    const merged = mergeGeometries(parts);
    for (const part of parts) part.dispose();
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  };
  return { lifted: merge(lifted), shelf: merge(shelf) };
}

/** Flush detail sits 0.3–1.6 mm in front of the cover face; keep it ahead at any distance. */
export function createCaseDetailMaterial() {
  const material = new THREE.MeshPhysicalMaterial({ name: CASE_DETAIL, color: "#ffffff", envMapIntensity: 0.65 });
  material.polygonOffset = true;
  material.polygonOffsetFactor = -1;
  material.polygonOffsetUnits = -2;
  material.userData.musicShell = true;
  material.userData.caseDetail = true;
  return material;
}

/**
 * Shader for merged detail: colour and finish per surface; with `fade`, the coverage
 * dissolve used by the archive's inner parts swaps stand-ins and detail as the case lifts
 * (the shader must already declare archiveQuality).
 *
 * The index inlay takes the case's cover colour (cover-tint.ts): linear RGB and a weight,
 * from `tint` on a single case or from the instanced attribute `caseTint` on the shelf batch
 * (its geometry must carry it: a missing attribute reads as weight 1 and black). Weight 0
 * is the amber of the table, untouched.
 */
export function caseDetailShader(shader: THREE.WebGLProgramParametersWithUniforms, fade: boolean, tint?: THREE.IUniform<THREE.Vector4>) {
  shader.uniforms.caseColors = caseDetailUniforms.caseColors;
  shader.uniforms.caseFinish = caseDetailUniforms.caseFinish;
  shader.uniforms.caseTintTheme = caseDetailUniforms.caseTintTheme;
  if (tint) shader.uniforms.caseTint = tint;
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `#include <common>\nattribute float caseSurface;\nattribute float caseFade;\nvarying float vCaseSurface;\nvarying float vCaseFade;${tint ? "" : "\nattribute vec4 caseTint;\nvarying vec4 vCaseTint;"}`)
    .replace("#include <begin_vertex>", `#include <begin_vertex>\nvCaseSurface = caseSurface;\nvCaseFade = caseFade;${tint ? "" : "\nvCaseTint = caseTint;"}`);
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", `#include <common>\nuniform vec3 caseColors[${NAMES.length}];\nuniform vec2 caseFinish[${NAMES.length}];\nvarying float vCaseSurface;\nvarying float vCaseFade;\nuniform vec3 caseTintTheme;\n${tint ? "uniform vec4 caseTint;" : "varying vec4 vCaseTint;"}${TINT_THEME_GLSL}`)
    .replace("#include <color_fragment>", `#include <color_fragment>
      int caseIndex = int(vCaseSurface + 0.5);
      vec3 caseColor = caseColors[caseIndex];
      vec4 caseInk = ${tint ? "caseTint" : "vCaseTint"};
      if (caseIndex == ${INLAY} && caseInk.a > 0.0)
        caseColor = mix(caseColor, caseTintThemed(caseInk.rgb, caseTintTheme), caseInk.a);
      diffuseColor.rgb *= caseColor;
      ${fade ? `if (vCaseFade < 1.5) {
        float coverage = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        if (vCaseFade > 0.5 ? archiveQuality <= coverage : archiveQuality > coverage) discard;
      }` : ""}`)
    .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = caseFinish[caseIndex].x;")
    .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\nmetalnessFactor = caseFinish[caseIndex].y;");
}
