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

/**
 * The guard (focalShader's `focalGuard`), in world units along the lens. A sample is left
 * out of a pixel's blur when it lies in one of `focalBoxes` (the large card's box on screen,
 * in UV, and those of its copies on their way out of the card's place or back), `nearer` in
 * front of that pixel (from the first number, fully from the second) and is sharp: within
 * the in-focus slab, or within `sharp` beyond its face (fully up to the first number, not
 * past the second; the song scene's lens blurs there by a third and by half a pixel at 2560
 * wide). The large card is sharp from corner to corner, the depth's rounding included, and
 * stands more than `nearer` in front of every place of the chain that meets it on screen
 * (check-song-pose.mjs). The boxes keep the chain's nearest places, at the bottom of the
 * picture, out of it: parts of them reach into the slab too, and they keep blurring into the
 * background as the rest of the chain does. `boxes` is how many boxes the shader takes, and
 * `reach` how many texels beyond a box a sample can still read the card (focalFootprint).
 */
export const FOCAL_GUARD = { nearer: [0.25, 0.75], sharp: [0.25, 0.35], boxes: 4, reach: 3 } as const;
/** A box in `focalBoxes` that holds nothing. */
export const FOCAL_NO_BOX = [2, 2, -1, -1] as const;
/**
 * A case that is (partly) the large card: how much it is (0..1, its song-card share) and its
 * box on screen, in CSS pixels from the picture's top left.
 */
export type FocalCard = { share: number; left: number; top: number; right: number; bottom: number };
/**
 * The guard's boxes (focalBoxes: UV, y up, as [left, bottom, right, top]) and their weights
 * (focalBoxWeights) for `cards` in a picture `width` x `height`: a box for each card, the
 * largest share first, weighted by its share. The last box takes in every card left over,
 * weighted by the largest share among them (a burst of steps leaves more copies than there
 * are boxes), so no card loses its box at once. A card with no share has no box.
 */
export function focalBoxes(cards: readonly FocalCard[], width: number, height: number) {
  const ordered = cards.filter((card) => card.share > 0).sort((a, b) => b.share - a.share);
  const last = FOCAL_GUARD.boxes - 1;
  return Array.from({ length: FOCAL_GUARD.boxes }, (_, i) => {
    const box: number[] = [...FOCAL_NO_BOX];
    const held = i < last ? ordered.slice(i, i + 1) : ordered.slice(last);
    for (const card of held) {
      box[0] = Math.min(box[0], card.left / width);
      box[1] = Math.min(box[1], 1 - card.bottom / height);
      box[2] = Math.max(box[2], card.right / width);
      box[3] = Math.max(box[3], 1 - card.top / height);
    }
    return { box, weight: held[0]?.share ?? 0 };
  });
}
const FOCUS_UNIFORM = "uniform float focus;";
const FOCUS_FACTOR = "float factor = ( focus + viewZ );";
const FOCUS_UNIFORMS = `
uniform float focalRange;
uniform float focalLean;
uniform vec2 focalSlope;
uniform vec3 focalPoint;
uniform vec3 focalRow;
uniform vec3 focalLane;
uniform float focalGuard;
uniform vec4 focalBoxes[ ${FOCAL_GUARD.boxes} ];
uniform float focalBoxWeights[ ${FOCAL_GUARD.boxes} ];`;
/**
 * The depth texels the guard reads for a sample at `u`, along one axis in texels (texel k
 * covers k..k+1): the first and the last of four. The sample's colour is a bilinear read
 * of the two texels whose centres are nearest; and a texel on the card's outline holds the
 * card's colour where it covers the texel's multisamples, while its depth, taken once at its
 * centre, is what lies behind. Either way a texel next to it holds the card's depth (the
 * card's outline is straight there), so one more texel on each side finds the card.
 */
export function focalFootprint(u: number) {
  const first = Math.floor(u - 0.5) - 1;
  return [first, first + 3] as const;
}
const smoothstep = (from: number, to: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
};
/**
 * How much a sample `tap` units from the lens, in a box of weight 1, counts in the blur of a
 * pixel `centre` units away, with the lens focused at `focus` and an in-focus slab of
 * `range` either side: the shader's focalTap, for the checks, where the footprint reads
 * that depth. `guard` is the uniform (0 leaves every sample in); a sample beyond reach of
 * every box always counts.
 */
export function focalGuardWeight(centre: number, tap: number, focus: number, range: number, guard = 1) {
  const nearer = smoothstep(FOCAL_GUARD.nearer[0], FOCAL_GUARD.nearer[1], centre - tap);
  const sharp = 1 - smoothstep(range + FOCAL_GUARD.sharp[0], range + FOCAL_GUARD.sharp[1], Math.abs(focus - tap));
  return 1 - guard * nearer * sharp;
}
const f = (value: number) => value.toFixed(3);
const GUARD_FUNCTIONS = `
// The depth of texel t (clamped to the picture), as getDepth reads it.
float focalDepth( const in ivec2 t ) {
	ivec2 texel = clamp( t, ivec2( 0 ), textureSize( tDepth, 0 ) - 1 );
	#if DEPTH_PACKING == 1
	return unpackRGBAToDepth( texelFetch( tDepth, texel, 0 ) );
	#else
	return texelFetch( tDepth, texel, 0 ).x;
	#endif
}
// How much depth texel t is the large card, in focus in front of a pixel centre units away.
float focalCard( const in ivec2 t, const in float centre ) {
	float distance = -getViewZ( focalDepth( t ) );
	float nearer = smoothstep( ${f(FOCAL_GUARD.nearer[0])}, ${f(FOCAL_GUARD.nearer[1])}, centre - distance );
	float sharp = 1.0 - smoothstep( focalRange + ${f(FOCAL_GUARD.sharp[0])}, focalRange + ${f(FOCAL_GUARD.sharp[1])}, abs( focus - distance ) );
	return nearer * sharp;
}
// How much the guard holds within spread of uv (in UV, either way): the weight of the
// heaviest box within reach.
float focalBoxed( const in vec2 uv, const in vec2 spread ) {
	vec2 reach = spread + ${f(FOCAL_GUARD.reach)} / vec2( textureSize( tDepth, 0 ) );
	float weight = 0.0;
	for ( int i = 0; i < ${FOCAL_GUARD.boxes}; i++ ) {
		vec4 box = focalBoxes[ i ];
		if ( all( greaterThanEqual( uv, box.xy - reach ) ) && all( lessThanEqual( uv, box.zw + reach ) ) ) weight = max( weight, focalBoxWeights[ i ] );
	}
	return weight;
}
// How much of the colour read at uv may be the large card, for a pixel centre units away:
// the most any depth texel of its footprint (focalFootprint) is. All sixteen are read: the
// loop runs faster without a way out than with one.
float focalHides( const in vec2 uv, const in float centre ) {
	float boxed = focalBoxed( uv, vec2( 0.0 ) );
	if ( boxed <= 0.0 ) return 0.0;
	ivec2 first = ivec2( floor( uv * vec2( textureSize( tDepth, 0 ) ) - 0.5 ) ) - 1;
	float hides = 0.0;
	for ( int y = 0; y < 4; y++ )
		for ( int x = 0; x < 4; x++ )
			hides = max( hides, focalCard( first + ivec2( x, y ), centre ) );
	return boxed * hides;
}
// One sample of the guarded gather. It reads the colour at level 0, as texture2D does here
// (tColor has no mipmaps), so that the gather can loop over its samples: the shader stays small.
void focalTap( const in vec2 uv, const in float centre, inout vec4 col, inout float total ) {
	float weight = 1.0 - focalGuard * focalHides( uv, centre );
	col += weight * textureLod( tColor, uv, 0.0 );
	total += weight;
}
`;
const GATHER_START = "vec4 col = vec4( 0.0 );";
const GATHER_END = "gl_FragColor = col / 41.0;";
const GATHER_TAP = /^(\s*)col \+= texture2D\( tColor, ([^\n;]+) \);$/gm;
const CENTRE_TAP = "vUv.xy";
const MAIN = "void main() {";
const FOCUS_TERMS = `
if ( focalLean > 0.0 ) {
	vec3 fromFocus = vec3( ( vUv * 2.0 - 1.0 ) * focalSlope * -viewZ, viewZ ) - focalPoint;
	factor = mix( abs( factor ), length( vec2( dot( fromFocus, focalRow ), dot( fromFocus, focalLane ) ) ), focalLean );
}
factor = sign( factor ) * max( abs( factor ) - focalRange, 0.0 );`;
/**
 * The bokeh fragment shader with three additions to its focus term (the difference in
 * depth from `focus`) and its gather:
 * - `focalLean` (0..1) measures the defocus on the shelf instead of along the lens: the
 *   distance from `focalPoint` along the rows (`focalRow`, a unit vector) and across the
 *   lanes (`focalLane`, a vector as long as a lane counts), all in view space;
 *   `focalSlope` is the tangent of half the field of view, across and up.
 * - `focalRange` keeps a slab either side of the focus sharp; the blur grows from its faces.
 * - `focalGuard` (0..1) keeps the sharp large card out of the blur of what lies behind it
 *   (FOCAL_GUARD). The stock gather averages its 41 samples whatever their depth, so the
 *   card spread a veil of its own colours over the blurred things beside its edges, as far
 *   as their blur reaches (11 px on the far background at 2560 wide): in the song scene a
 *   grey band under the card that ended in straight edges at the chain's cases. Guarded,
 *   a sample is left out of that blur wherever its colour may hold the card: where any depth
 *   texel of its footprint is the card (focalFootprint). With the depth at the sample alone,
 *   the colour of the card's outline (its antialiased texels, and the bilinear reads beside
 *   them) still came in, and drew thin lines of it around the card, one for each ring of the
 *   gather. A pixel on the card's edge (its colour holds part of the card, its depth what
 *   lies behind) keeps its own colour, as it has without depth of field, and so does a sharp
 *   pixel, which the blur leaves as it is anyway; a pixel's own sample always counts.
 * With all three at zero the shader computes what it did before.
 */
export function focalShader(fragmentShader: string) {
  if (!fragmentShader.includes(FOCUS_UNIFORM) || !fragmentShader.includes(FOCUS_FACTOR))
    throw new Error("Depth of field: the bokeh shader no longer has the expected focus term");
  const start = fragmentShader.indexOf(GATHER_START), end = fragmentShader.indexOf(GATHER_END);
  const main = fragmentShader.indexOf(MAIN);
  const gather = start >= 0 && end > start ? fragmentShader.slice(start + GATHER_START.length, end) : "";
  const taps = [...gather.matchAll(GATHER_TAP)];
  if (main < 0 || main > start || taps.length !== 41 || taps.filter((tap) => tap[2].trim() === CENTRE_TAP).length !== 1)
    throw new Error("Depth of field: the bokeh shader no longer has the expected 41-sample gather");
  // The pixel's own sample counts as it is; the others, in the stock order, go through focalTap.
  const ring = taps.map((tap) => tap[2].trim()).filter((uv) => uv !== CENTRE_TAP);
  const guarded = `		col += texture2D( tColor, ${CENTRE_TAP} );
		total = 1.0;
		vec2 focalTaps[ ${ring.length} ] = vec2[ ${ring.length} ](
			${ring.join(",\n\t\t\t")} );
		for ( int i = 0; i < ${ring.length}; i++ ) focalTap( focalTaps[ i ], centre, col, total );`;
  return (fragmentShader.slice(0, main) + GUARD_FUNCTIONS + fragmentShader.slice(main, start) + `${GATHER_START}
	float total = 41.0;
	float edge = 0.0;
	// The guarded gather runs where the blur reaches a box (its samples lie within 0.4 of the
	// blur either way); everywhere else, and where nothing blurs, the stock one.
	if ( focalGuard > 0.0 && dofblur.x != 0.0 && focalBoxed( vUv, 0.4 * abs( dofblur ) * aspectcorrect ) > 0.0 ) {
		float centre = -viewZ;
		ivec2 here = ivec2( floor( vUv * vec2( textureSize( tDepth, 0 ) ) ) );
		edge = focalGuard * focalBoxed( vUv, vec2( 0.0 ) ) * max(
			max( focalCard( here + ivec2( 1, 0 ), centre ), focalCard( here - ivec2( 1, 0 ), centre ) ),
			max( focalCard( here + ivec2( 0, 1 ), centre ), focalCard( here - ivec2( 0, 1 ), centre ) ) );
${guarded}
	} else {
${gather}
	}
	gl_FragColor = mix( col / total, texture2D( tColor, vUv ), edge );` + fragmentShader.slice(end + GATHER_END.length))
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
    uniforms.focalGuard = { value: 0 };
    uniforms.focalBoxes = { value: Array.from({ length: FOCAL_GUARD.boxes }, () => new THREE.Vector4(...FOCAL_NO_BOX)) };
    uniforms.focalBoxWeights = { value: Array.from({ length: FOCAL_GUARD.boxes }, () => 0) };
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
      // BokehPass renders the scene's depth into renderTargetDepth and reads it back. three
      // fills a colour background into every target it renders the scene into, so the sky
      // would read as the background colour's packing, a depth just beyond the near plane;
      // without it the sky keeps the clear (as far as can be), as on the SSAO path. At the
      // lens's full strength the stock blur is at its limit at either depth; the guard needs
      // the sky to lie behind the large card.
      const own = this.exactDepth ? this.exactOwnDepth : this.ownDepth;
      (this as unknown as OwnDepthTarget)._renderTargetDepth = own;
      uniforms.tDepth.value = own.texture;
      const scene = this.scene as THREE.Scene, background = scene.background;
      scene.background = null;
      try {
        super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
      } finally {
        scene.background = background;
      }
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
