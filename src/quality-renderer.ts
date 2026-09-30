import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { multisampleCount, renderDimensions, type RenderQuality } from "./render-quality";

type MultisampleSupport = { color: number[]; depth: number[] };
const sampleSupport = new WeakMap<THREE.WebGLRenderer, MultisampleSupport>();

function supportedSamples(renderer: THREE.WebGLRenderer): MultisampleSupport {
  const gl = renderer.getContext();
  if (gl.isContextLost()) return { color: [], depth: [] };
  const cached = sampleSupport.get(renderer);
  if (cached) return cached;
  let result: MultisampleSupport = { color: [], depth: [] };
  try {
    if ("getInternalformatParameter" in gl &&
      (renderer.extensions.has("EXT_color_buffer_float") || renderer.extensions.has("EXT_color_buffer_half_float"))) {
      // The composer uses RGBA/HalfFloat and an ordinary, stencil-free 24-bit
      // depth attachment. MAX_SAMPLES alone does not guarantee this combination.
      const color = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA16F, gl.SAMPLES);
      const depth = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, gl.SAMPLES);
      result = { color: Array.from(color ?? []), depth: Array.from(depth ?? []) };
    }
  } catch { /* Unsupported queries fall back to the existing SMAA pass. */ }
  sampleSupport.set(renderer, result);
  return result;
}

export function createQualityComposer(renderer: THREE.WebGLRenderer) {
  const target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    depthBuffer: true,
    stencilBuffer: false,
    samples: 0,
  });
  renderer.domElement.addEventListener("webglcontextrestored", () => sampleSupport.delete(renderer));
  return new EffectComposer(renderer, target);
}

/** Both buffers can receive next frame's geometry after the passes swap them. */
export function updateComposerSamples(
  renderer: THREE.WebGLRenderer,
  composer: EffectComposer,
  width: number,
  height: number,
) {
  const support = supportedSamples(renderer);
  const samples = multisampleCount(support.color, support.depth, width, height, renderer.capabilities.maxSamples);
  for (const target of [composer.renderTarget1, composer.renderTarget2]) {
    if (target.samples === samples) continue;
    // Changing the JS property alone leaves the existing GPU renderbuffers intact.
    target.dispose();
    target.samples = samples;
  }
  return samples;
}

/** The viewer's direct route already uses the antialiased default framebuffer. */
export function viewerUsesComposer(renderer: THREE.WebGLRenderer, quality: RenderQuality) {
  return quality.antialias === "smaa" || !(renderer.capabilities.samples > 1);
}

/** Alpha-tested print margins can use coverage only on a multisampled route. */
export function applyAlbumPrintCoverage(root: THREE.Object3D, samples: number) {
  const enabled = samples > 1;
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (material.userData.albumPrint !== true || material.alphaToCoverage === enabled) continue;
      material.alphaToCoverage = enabled;
      material.needsUpdate = true;
    }
  });
}

export function applyTextureQuality(
  root: THREE.Object3D,
  renderer: THREE.WebGLRenderer,
  quality: RenderQuality,
) {
  const maximum = Math.min(
    quality.anisotropy,
    renderer.capabilities.getMaxAnisotropy(),
  );
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material)
      ? object.material
      : [object.material]) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture && !value.isRenderTargetTexture)
          textures.add(value);
      }
    }
  });
  for (const texture of textures) {
    if (texture.anisotropy === maximum) continue;
    texture.anisotropy = maximum;
    texture.needsUpdate = true;
  }
}

export function resizeQuality(
  renderer: THREE.WebGLRenderer,
  composer: EffectComposer,
  host: HTMLElement,
  quality: RenderQuality,
  smaa?: SMAAPass,
  direct = false,
  root?: THREE.Object3D,
) {
  const width = Math.max(1, host.clientWidth),
    height = Math.max(1, host.clientHeight);
  const dimensions = renderDimensions(
    quality,
    width,
    height,
    host.getBoundingClientRect().width / width,
    devicePixelRatio,
    renderer.capabilities.maxTextureSize,
  );
  renderer.setPixelRatio(dimensions.ratio);
  renderer.setSize(width, height);
  const composerSamples = updateComposerSamples(renderer, composer, dimensions.width, dimensions.height);
  const actualSamples = direct ? renderer.capabilities.samples : composerSamples;
  if (root) applyAlbumPrintCoverage(root, actualSamples);
  const smaaEnabled = !direct && (quality.antialias === "smaa" || composerSamples === 0);
  if (smaa) smaa.enabled = smaaEnabled;
  composer.setPixelRatio(dimensions.ratio);
  composer.setSize(width, height);
  renderer.transmissionResolutionScale = quality.transmission;
  host.dataset.renderQuality = JSON.stringify({
    ...dimensions,
    antialias: quality.antialias,
    msaaSamples: actualSamples,
    composerSamples,
    smaaEnabled,
    antialiasFallback: !direct && composerSamples === 0,
    renderPath: direct ? "direct" : "composer",
    transmission: quality.transmission,
    anisotropy: Math.min(
      quality.anisotropy,
      renderer.capabilities.getMaxAnisotropy(),
    ),
  });
  return dimensions;
}

export function createViewerPipeline(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
) {
  const composer = createQualityComposer(renderer);
  const smaa = new SMAAPass();
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(smaa);
  composer.addPass(new OutputPass());
  return { composer, smaa };
}
