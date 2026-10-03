import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { multisampleCount, renderDimensions, type RenderQuality } from "./render-quality";
import { CoverMipTexture } from "./cover-filtering.ts";

type MultisampleSupport = { color: number[]; depth: number[] };
const sampleSupport = new WeakMap<THREE.WebGLRenderer, MultisampleSupport>();
const watchedContexts = new WeakSet<THREE.WebGLRenderer>();

function supportedSamples(renderer: THREE.WebGLRenderer): MultisampleSupport {
  const gl = renderer.getContext();
  if (gl.isContextLost()) return { color: [], depth: [] };
  const cached = sampleSupport.get(renderer);
  if (cached) return cached;
  if (!watchedContexts.has(renderer)) {
    // A restored context may come back on another adapter: query it again.
    watchedContexts.add(renderer);
    renderer.domElement.addEventListener("webglcontextrestored", () => sampleSupport.delete(renderer));
  }
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
  // Postprocessing reads resolved images only; the composer's ping-pong buffers
  // never need samples or depth. Geometry is drawn once, with depth and
  // multisampling, into MultisampleRenderPass's own target.
  const target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
    samples: 0,
  });
  return new EffectComposer(renderer, target);
}

const resolveCopy = {
  vertexShader: "varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
  fragmentShader: "uniform sampler2D tDiffuse;\nvarying vec2 vUv;\nvoid main() { gl_FragColor = texture2D(tDiffuse, vUv); }",
};

/**
 * Renders the scene into one dedicated multisampled target. Three resolves it
 * after render(); a plain copy then hands the linear HDR image to the unchanged
 * SSAO / depth-of-field / SMAA / output chain. Keeping samples here, instead of
 * on both alternating composer buffers, allows 8x at the old 2 x 4x memory.
 * Without samples the target is an ordinary one: the only buffer with depth.
 */
export class MultisampleRenderPass extends RenderPass {
  readonly target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    depthBuffer: true,
    stencilBuffer: false,
    samples: 0,
    // SSAO and depth of field draw their own depth; resolving this one each
    // frame would only copy eight samples of depth that nothing reads.
    resolveDepthBuffer: false,
  });
  private readonly resolve = new FullScreenQuad(new THREE.ShaderMaterial({
    name: "MultisampleResolveCopy",
    uniforms: { tDiffuse: { value: null } },
    ...resolveCopy,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  }));

  get samples() {
    return this.target.samples;
  }

  setSize(width: number, height: number) {
    this.target.setSize(width, height);
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    deltaTime: number,
    maskActive: boolean,
  ) {
    if (this.renderToScreen) {
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
      return;
    }
    super.render(renderer, writeBuffer, this.target, deltaTime, maskActive);
    (this.resolve.material as THREE.ShaderMaterial).uniforms.tDiffuse.value = this.target.texture;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(readBuffer);
    this.resolve.render(renderer);
    renderer.autoClear = autoClear;
  }

  dispose() {
    this.target.dispose();
    this.resolve.material.dispose();
    this.resolve.dispose();
  }
}

/** Choose the scene pass's samples from actual format support and the memory budget. */
export function updateSceneSamples(
  renderer: THREE.WebGLRenderer,
  pass: MultisampleRenderPass,
  width: number,
  height: number,
) {
  const support = supportedSamples(renderer);
  const samples = multisampleCount(support.color, support.depth, width, height, renderer.capabilities.maxSamples);
  if (pass.target.samples !== samples) {
    // Changing the JS property alone leaves the existing GPU renderbuffers intact.
    pass.target.dispose();
    pass.target.samples = samples;
  }
  return samples;
}

function scenePass(composer: EffectComposer) {
  return composer.passes.find((pass): pass is MultisampleRenderPass => pass instanceof MultisampleRenderPass);
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
    if (texture instanceof CoverMipTexture) {
      texture.setFilteringAnisotropy(maximum);
      continue;
    }
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
  const pass = scenePass(composer);
  const composerSamples = pass ? updateSceneSamples(renderer, pass, dimensions.width, dimensions.height) : 0;
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
  composer.addPass(new MultisampleRenderPass(scene, camera));
  composer.addPass(smaa);
  composer.addPass(new OutputPass());
  return { composer, smaa };
}
