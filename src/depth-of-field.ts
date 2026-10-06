import * as THREE from "three";
import { BokehPass, type BokehPassParameters } from "three/addons/postprocessing/BokehPass.js";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import type { SSAOPass } from "three/addons/postprocessing/SSAOPass.js";

type Uniforms = Record<string, THREE.IUniform>;
// three r183 keeps BokehPass's depth target in this field (its typings still name the old one).
type OwnDepthTarget = { _renderTargetDepth: THREE.WebGLRenderTarget };

// The same RGBA packing BokehPass's depth material writes. Storing it in the
// same half-float target keeps the GPU's own rounding of the packed depth,
// which sets the blur radius of in-focus edges. That rounding shifts the depth
// the shader reads (measured here: 0.3 units at 72, 1.7 at 142), which is too
// coarse to place a point in the shelf: the shelf focus below reads the same
// packing from 8-bit targets, where it is exact.
const repackDepth = {
  vertexShader: "varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
  fragmentShader: `#include <packing>
uniform sampler2D tDepth;
varying vec2 vUv;
void main() { gl_FragColor = packDepthToRGBA(texture2D(tDepth, vUv).x); }`,
};

const FOCUS_UNIFORM = "uniform float focus;";
const FOCUS_FACTOR = "float factor = ( focus + viewZ );";
const FOCUS_UNIFORMS = `
uniform float focalRange;
uniform float focalLean;
uniform vec2 focalSlope;
uniform vec3 focalPoint;
uniform vec3 focalRow;
uniform vec3 focalLane;`;
const FOCUS_TERMS = `
if ( focalLean > 0.0 ) {
	vec3 fromFocus = vec3( ( vUv * 2.0 - 1.0 ) * focalSlope * -viewZ, viewZ ) - focalPoint;
	factor = mix( abs( factor ), length( vec2( dot( fromFocus, focalRow ), dot( fromFocus, focalLane ) ) ), focalLean );
}
factor = sign( factor ) * max( abs( factor ) - focalRange, 0.0 );`;
/**
 * The bokeh fragment shader with two additions to its one focus term (the difference in
 * depth from `focus`):
 * - `focalLean` (0..1) measures the defocus on the shelf instead of along the lens: the
 *   distance from `focalPoint` along the rows (`focalRow`, a unit vector) and across the
 *   lanes (`focalLane`, a vector as long as a lane counts), all in view space;
 *   `focalSlope` is the tangent of half the field of view, across and up.
 * - `focalRange` keeps a slab either side of the focus sharp; the blur grows from its faces.
 * With both at zero the shader computes what it did before.
 */
export function focalShader(fragmentShader: string) {
  if (!fragmentShader.includes(FOCUS_UNIFORM) || !fragmentShader.includes(FOCUS_FACTOR))
    throw new Error("Depth of field: the bokeh shader no longer has the expected focus term");
  return fragmentShader
    .replace(FOCUS_UNIFORM, FOCUS_UNIFORM + FOCUS_UNIFORMS)
    .replace(FOCUS_FACTOR, FOCUS_FACTOR + FOCUS_TERMS);
}

/**
 * Depth of field that takes its depth from the SSAO pass. Both passes draw the
 * same scene from the same camera with an override material, so BokehPass's
 * own depth render repeated every mesh draw; one full-screen pass now repacks
 * SSAO's depth into the texture the unchanged bokeh shader reads. SSAO leaves
 * out points and lines (the night stars): while any is visible, SSAO is off or
 * renders at another size, the original depth render runs instead.
 *
 * The lens has two additions (focalShader): an in-focus slab, and a focus measured on
 * the shelf. The shelf camera looks along the rows at a shallow angle, so neighbouring
 * rows are almost equally far from the lens and no aperture sets the selected case apart
 * from them; measured along the shelf, the rows soften one by one and the selected case
 * stays sharp from edge to edge. `exactDepth` makes both depth paths write to 8-bit
 * targets for that; the lens-axis focus keeps the half-float targets it always had.
 */
export class SharedDepthBokehPass extends BokehPass {
  // BokehPass's own depth render: its half-float target, and an exact 8-bit one.
  private readonly ownDepth: THREE.WebGLRenderTarget;
  private readonly exactOwnDepth = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  private readonly packedDepth = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
  });
  private readonly exactPackedDepth = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
  });
  /** Read the depth without the half-float rounding (the shelf focus needs it). */
  exactDepth = false;
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
    const uniforms = this.uniforms as Uniforms;
    uniforms.focalRange = { value: 0 };
    uniforms.focalLean = { value: 0 };
    uniforms.focalSlope = { value: new THREE.Vector2(1, 1) };
    uniforms.focalPoint = { value: new THREE.Vector3() };
    uniforms.focalRow = { value: new THREE.Vector3(0, 0, 1) };
    uniforms.focalLane = { value: new THREE.Vector3() };
    this.materialBokeh.fragmentShader = focalShader(this.materialBokeh.fragmentShader);
    this.ownDepth = (this as unknown as OwnDepthTarget)._renderTargetDepth;
    if (!this.ownDepth?.isWebGLRenderTarget) throw new Error("Depth of field: BokehPass no longer exposes its depth target");
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
      // BokehPass renders the scene's depth into renderTargetDepth and reads it back.
      const own = this.exactDepth ? this.exactOwnDepth : this.ownDepth;
      (this as unknown as OwnDepthTarget)._renderTargetDepth = own;
      uniforms.tDepth.value = own.texture;
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
      return;
    }
    const packed = this.exactDepth ? this.exactPackedDepth : this.packedDepth;
    const camera = this.camera as THREE.PerspectiveCamera;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    (this.repack.material as THREE.ShaderMaterial).uniforms.tDepth.value = depth;
    renderer.setRenderTarget(packed);
    this.repack.render(renderer);
    // The composite as BokehPass draws it after its own depth render.
    uniforms.tDepth.value = packed.texture;
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
    for (const target of [this.ownDepth, this.exactOwnDepth, this.packedDepth, this.exactPackedDepth]) target.setSize(width, height);
    this.width = width;
    this.height = height;
  }

  dispose() {
    super.dispose();
    for (const target of [this.ownDepth, this.exactOwnDepth, this.packedDepth, this.exactPackedDepth]) target.dispose();
    this.repack.material.dispose();
    this.repack.dispose();
    this.composite.dispose();
  }
}
