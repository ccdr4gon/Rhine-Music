import * as THREE from "three";
import { BokehPass, type BokehPassParameters } from "three/addons/postprocessing/BokehPass.js";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import type { SSAOPass } from "three/addons/postprocessing/SSAOPass.js";

type Uniforms = Record<string, THREE.IUniform>;

// The same RGBA packing BokehPass's depth material writes. Storing it in the
// same half-float target keeps the GPU's own rounding of the packed depth,
// which sets the blur radius of in-focus edges.
const repackDepth = {
  vertexShader: "varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
  fragmentShader: `#include <packing>
uniform sampler2D tDepth;
varying vec2 vUv;
void main() { gl_FragColor = packDepthToRGBA(texture2D(tDepth, vUv).x); }`,
};

/**
 * Depth of field that takes its depth from the SSAO pass. Both passes draw the
 * same scene from the same camera with an override material, so BokehPass's
 * own depth render repeated every mesh draw; one full-screen pass now repacks
 * SSAO's depth into the texture the unchanged bokeh shader reads. SSAO leaves
 * out points and lines (the night stars): while any is visible, SSAO is off or
 * renders at another size, the original depth render runs instead.
 */
export class SharedDepthBokehPass extends BokehPass {
  private readonly ownDepth: THREE.Texture;
  private readonly packedDepth = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
  });
  private readonly repack = new FullScreenQuad(new THREE.ShaderMaterial({
    name: "BokehDepthRepack",
    uniforms: { tDepth: { value: null } },
    ...repackDepth,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  }));
  private readonly composite: FullScreenQuad;
  private width = 1;
  private height = 1;
  /** Whether the last render reused the SSAO depth, for diagnostics. */
  sharedDepth = false;

  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    params: BokehPassParameters,
    private readonly ambientOcclusion: () => SSAOPass,
  ) {
    super(scene, camera, params);
    this.ownDepth = (this.uniforms as Uniforms).tDepth.value;
    this.composite = new FullScreenQuad(this.materialBokeh);
  }

  private ssaoDepth() {
    const ao = this.ambientOcclusion();
    const target = ao.normalRenderTarget;
    if (!ao.enabled || target.width !== this.width || target.height !== this.height) return null;
    let excluded = false;
    this.scene.traverseVisible((object) => {
      const kind = object as THREE.Object3D & { isPoints?: boolean; isLine?: boolean; isLine2?: boolean };
      if (kind.isPoints || kind.isLine || kind.isLine2) excluded = true;
    });
    return excluded ? null : target.depthTexture;
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    deltaTime: number,
    maskActive: boolean,
  ) {
    const uniforms = this.uniforms as Uniforms;
    const depth = this.ssaoDepth();
    this.sharedDepth = Boolean(depth);
    if (!depth) {
      uniforms.tDepth.value = this.ownDepth;
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
      return;
    }
    const camera = this.camera as THREE.PerspectiveCamera;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    (this.repack.material as THREE.ShaderMaterial).uniforms.tDepth.value = depth;
    renderer.setRenderTarget(this.packedDepth);
    this.repack.render(renderer);
    // The composite as BokehPass draws it after its own depth render.
    uniforms.tDepth.value = this.packedDepth.texture;
    uniforms.tColor.value = readBuffer.texture;
    uniforms.nearClip.value = camera.near;
    uniforms.farClip.value = camera.far;
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      renderer.clear();
    }
    this.composite.render(renderer);
    renderer.autoClear = autoClear;
  }

  setSize(width: number, height: number) {
    super.setSize(width, height);
    this.packedDepth.setSize(width, height);
    this.width = width;
    this.height = height;
  }

  dispose() {
    super.dispose();
    this.packedDepth.dispose();
    this.repack.material.dispose();
    this.repack.dispose();
    this.composite.dispose();
  }
}
