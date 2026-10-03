import * as THREE from "three";

// The album case (art/build_music_case.py) is authored at exactly this size and centre,
// which the camera, lighting and extraction share.
export const MUSIC_MODEL = {
  width: 4.45,
  height: 3.35,
  depth: 0.28,
  center: { x: 0, y: 1.85, z: 0 },
} as const;

// The artwork is a surface print in front of every glass vertex (max z = depth / 2).
// Keep its native proportions and a visible glass border on all four sides.
export const MUSIC_COVER = {
  width: 2.98,
  height: 2.98,
  x: 0.14,
  y: MUSIC_MODEL.center.y,
  z: MUSIC_MODEL.depth / 2 + 0.012,
} as const;

/** All three music contexts share soft frosted glass beneath a sharp surface print. */
export function configureMusicGlass(surface: string, material: THREE.MeshPhysicalMaterial) {
  material.color.set("#fffdfa");
  material.metalness = 0;
  material.envMapIntensity = 0.65;
  material.ior = 1.46;
  material.attenuationColor.set("#f3e9db");
  material.attenuationDistance = 4.5;
  material.clearcoat = 0.16;
  material.clearcoatRoughness = 0.2;
  material.transparent = false;
  material.opacity = 1;
  if (surface === "Frosted_Polymer") {
    material.transmission = 0.96;
    material.thickness = 0.026;
    material.roughness = 0.4;
  } else if (surface === "Ivory_Edges") {
    material.transmission = 0.84;
    material.thickness = 0.06;
    material.roughness = 0.25;
  } else if (surface === "Optical_Diffuser") {
    material.transmission = 0.66;
    material.thickness = 0.035;
    material.roughness = 0.4;
  }
  material.userData.musicShell = true;
}

/** Glass shell surfaces: thin-face coverage strips and the shell lighting apply to these. */
export const MUSIC_SHELL_SURFACES = ["Frosted_Polymer", "Ivory_Edges", "Optical_Diffuser"] as const;
export const isMusicShellSurface = (surface: string) =>
  (MUSIC_SHELL_SURFACES as readonly string[]).includes(surface);

/**
 * art/build_music_case.py tags every node: "shared" parts form each shelf instance and the
 * lifted case, "lod1" stand-ins exist only on the shelf, "lod0" detail only on the lifted case.
 */
export type MusicCaseLevel = "shared" | "lod0" | "lod1";
export function musicCaseLevel(object: THREE.Object3D): MusicCaseLevel {
  const level = object.userData.rhineLod;
  return level === "lod0" || level === "lod1" ? level : "shared";
}

export function musicAssemblyPart(surface: string) {
  if (surface === "Optical_Diffuser") return "substrate";
  if (surface === "Ivory_Edges") return "carrier";
  // The glass cover and the merged detail pressed into its face.
  return "cover";
}

// The printed label plate (art/build_music_case.py) and the canvas laid over it.
export const MUSIC_LABEL = { x: -1.685, y: 3.05, z: MUSIC_MODEL.depth / 2 + 0.0022, width: 0.46, height: 0.36 } as const;

/** Clarity applies to the glass substrate only; the cover never enters this path. */
export function setMusicGlassClarity(material: THREE.MeshPhysicalMaterial, clarity: number) {
  // Inspection softens the frosting slightly; it never becomes polished plastic.
  // The image sits ahead of this material and remains completely independent.
  material.roughness = THREE.MathUtils.lerp(0.4, 0.3, THREE.MathUtils.clamp(clarity, 0, 1));
}

export function createAlbumPrintMaterial(map: THREE.Texture) {
  // Matte ink receives the same diffuse lights and shadows as the archive.
  // It has no specular lobe, glow or glass layer to bleach the printed colours.
  const material = new THREE.MeshLambertMaterial({
    map,
    alphaTest: 0.025,
    alphaToCoverage: false,
    toneMapped: false,
    fog: true,
  });
  material.userData.albumPrint = true;
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <opaque_fragment>",
      // Keep strong key lighting within the print's original colour range.
      // A zero/weak diffuse light still produces a zero/dim print, unlike Basic.
      "outgoingLight = min(outgoingLight, diffuseColor.rgb);\n#include <opaque_fragment>",
    );
  };
  material.customProgramCacheKey = () => "album-diffuse-print-v1";
  return material;
}
