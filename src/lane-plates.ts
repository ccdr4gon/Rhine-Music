import * as THREE from "three";
import { Pass } from "three/addons/postprocessing/Pass.js";
import { laneLabelIndex, type LaneName } from "./lane-labels.ts";
import type { ThemeTransition } from "./theme-transition.ts";

/**
 * The names of the shelf's columns written in the scene: a column's number and name stand
 * on the edge of the column, as text only. There is no plate, frame or mark around the
 * writing: each name is a rectangle that is transparent except for its glyphs. It stands in
 * the scene's space: it has the shelf's perspective, and the cases in front of it cover it.
 * (It takes no fog: the fog that fades the further columns would fade their names too.)
 *
 * A name has to stay readable, and it must not count as a solid rectangle. The shelf's
 * lens blurs everything a few rows from the selection, and the passes that draw the scene
 * with one material for every mesh (the lens's depth, ambient occlusion) know nothing of
 * the writing's transparency. So while either of those passes is on, the names are left out
 * of the scene and drawn after them instead (LanePlateOverlayPass), sharp: only where the
 * scene's depth says nothing is in front of them, so cases still cover them. With both
 * passes off they are ordinary transparent meshes of the scene.
 *
 * The writing is a mask: red is ink, green is ink of the accent colour (the number of the
 * playing queue's column), blue a thin rim along the strokes in the opposite tone, which
 * keeps light writing readable on lit cases and dark writing on shaded ones. It reaches two
 * or three screen pixels from a stroke at most. In the narrowest gaps (between the facing
 * strokes of two ideographs, inside a dense one) the rims of both sides meet faintly;
 * nothing spreads above, below or beyond the writing, and there is no band or backing
 * behind a name. Ink, accent and rim are uniforms, so a theme change fades them with the
 * scene.
 */
export const LANE_PLATE = {
  /** World units: the height of a name's rectangle, and the widest and narrowest it gets. */
  height: 0.5,
  maxWidth: 2.5,
  minWidth: 0.3,
  /** Canvas pixels per world unit. */
  texel: 256,
} as const;

const CANVAS_WIDTH = LANE_PLATE.maxWidth * LANE_PLATE.texel;
const CANVAS_HEIGHT = LANE_PLATE.height * LANE_PLATE.texel;
const INDEX_FONT = "400 34px MiSans, system-ui, sans-serif";
const NAME_FONT = "600 54px MiSans, system-ui, sans-serif";
/** Canvas pixels: the room around the writing (for the rim), and where its baseline is. */
const MARGIN = 20;
const BASELINE = CANVAS_HEIGHT - 34;
/** Canvas pixels: how far the rim reaches from a stroke (about a pixel and a half on screen). */
const GROUND_BLUR = 4;
const THEME = {
  day: { ground: "#f3efe8", ink: "#232722", accent: "#a85a28" },
  night: { ground: "#0d1826", ink: "#eef2f5", accent: "#e0b182" },
} as const;
// How far (world units along the lens) the scene may be in front of a name before it
// counts as covering it: less than the name stands in front of its column's edge.
const OVERLAY_DEPTH_SLACK = 0.05;
// How much of the rim shows beside a stroke.
const GROUND_STRENGTH = 0.7;

const vertexShader = `
uniform float extent;
varying vec2 vUv;
#ifdef LANE_PLATE_OVERLAY
varying float vViewZ;
#endif
void main() {
	vUv = vec2( uv.x * extent, uv.y );
	vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
	gl_Position = projectionMatrix * mvPosition;
	#ifdef LANE_PLATE_OVERLAY
	vViewZ = mvPosition.z;
	#endif
}`;
const fragmentShader = `
#include <common>
#include <packing>
uniform sampler2D mask;
uniform vec3 ground;
uniform vec3 ink;
uniform vec3 accent;
uniform float opacity;
uniform float weight;
varying vec2 vUv;
#ifdef LANE_PLATE_OVERLAY
uniform sampler2D sceneDepth;
uniform float sceneDepthPacked;
uniform vec2 sceneDepthStep;
uniform vec2 resolution;
uniform float cameraNear;
uniform float cameraFar;
varying float vViewZ;
// Whether the name is the nearest thing at a pixel corner (view z grows towards the lens).
float seen( vec2 corner ) {
	vec4 stored = texture2D( sceneDepth, ( gl_FragCoord.xy + corner * sceneDepthStep ) / resolution );
	float depth = sceneDepthPacked > 0.5 ? unpackRGBAToDepth( stored ) : stored.x;
	return step( perspectiveDepthToViewZ( depth, cameraNear, cameraFar ) - ${OVERLAY_DEPTH_SLACK.toFixed(3)}, vViewZ );
}
#endif
void main() {
	// A name is drawn at about half the size it is written at: lean towards the finer mip.
	vec4 written = texture2D( mask, vUv, -0.5 );
	float glyph = min( written.r + written.g, 1.0 ) * weight;
	float cover = max( glyph, written.b * ${GROUND_STRENGTH.toFixed(2)} );
	float alpha = opacity * cover;
	#ifdef LANE_PLATE_OVERLAY
	// This pass is not multisampled: the edges of whatever covers the name are softened
	// over four corners, a pixel apart or a texel of the depth where that is coarser.
	// (The glyphs' own edges are in the mask.)
	alpha *= 0.25 * ( seen( vec2( -0.5, -0.5 ) ) + seen( vec2( 0.5, -0.5 ) ) + seen( vec2( -0.5, 0.5 ) ) + seen( vec2( 0.5, 0.5 ) ) );
	#endif
	if ( alpha <= 0.002 ) discard;
	// Ink is laid on in display space, as on a page: mixed in linear light, the thin
	// strokes of a name wash out against their ground.
	vec3 pen = mix( pow( ink, vec3( 1.0 / 2.2 ) ), pow( accent, vec3( 1.0 / 2.2 ) ), written.g / max( written.r + written.g, 1e-4 ) );
	vec3 color = pow( mix( pow( ground, vec3( 1.0 / 2.2 ) ), pen, glyph / max( cover, 1e-4 ) ), vec3( 2.2 ) );
	gl_FragColor = vec4( color, alpha );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`;

type PlateColors = { ground: THREE.Color; ink: THREE.Color; accent: THREE.Color };
type OverlayUniforms = {
  sceneDepth: THREE.IUniform<THREE.Texture | null>;
  sceneDepthPacked: THREE.IUniform<number>;
  sceneDepthStep: THREE.IUniform<THREE.Vector2>;
  resolution: THREE.IUniform<THREE.Vector2>;
  cameraNear: THREE.IUniform<number>;
  cameraFar: THREE.IUniform<number>;
};
/** The scene's depth for the names drawn after the scene: RGBA-packed or a depth texture, and its size in pixels. */
export type LaneSceneDepth = { texture: THREE.Texture; packed: boolean; width: number; height: number; near: number; far: number };

/** Shorten `text` with an ellipsis until it is at most `width` wide in the context's font. */
function fitted(context: CanvasRenderingContext2D, text: string, width: number) {
  if (context.measureText(text).width <= width) return text;
  const glyphs = Array.from(text);
  while (glyphs.length > 1 && context.measureText(`${glyphs.join("").trimEnd()}…`).width > width) glyphs.pop();
  return `${glyphs.join("").trimEnd()}…`;
}

// Colour glyphs (emoji) ignore fillStyle. Text is drawn here first and flattened to one
// colour, so every glyph gives the mask coverage only, never a colour of its own. With
// `blur`, the text's soft shadow is written as well (the rim along the strokes).
let scratch: CanvasRenderingContext2D | undefined;
function writeText(mask: CanvasRenderingContext2D, text: string, x: number, font: string, colour: string, blur = 0) {
  if (!scratch) {
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    scratch = canvas.getContext("2d")!;
  }
  scratch.globalCompositeOperation = "source-over";
  scratch.shadowBlur = 0;
  scratch.shadowColor = "transparent";
  scratch.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  scratch.font = font;
  scratch.textBaseline = "alphabetic";
  scratch.fillStyle = "#fff";
  if (blur) {
    // Twice: one soft shadow is too faint right at the strokes.
    scratch.shadowColor = "#fff";
    scratch.shadowBlur = blur;
    scratch.fillText(text, x, BASELINE);
  }
  scratch.fillText(text, x, BASELINE);
  scratch.shadowBlur = 0;
  scratch.shadowColor = "transparent";
  scratch.globalCompositeOperation = "source-in";
  scratch.fillStyle = colour;
  scratch.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  mask.drawImage(scratch.canvas, 0, 0);
}

/** What a name is written with: rewriting happens only when this changes. */
const plateText = (column: number, label: LaneName) => `${column}\n${label.live ? 1 : 0}\n${label.name}`;

export class LanePlate {
  /** The name as a mesh of the scene, and as the copy drawn after the scene: one of the two is shown. */
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  readonly overlay: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  /** The lane it names this frame, and what is written on it. */
  lane = NaN;
  written = "";
  used = false;
  /** World units. */
  width: number = LANE_PLATE.minWidth;
  private readonly canvas = document.createElement("canvas");
  private readonly texture: THREE.CanvasTexture;
  private readonly up = new THREE.Vector3();
  private readonly shared: { extent: THREE.IUniform<number>; opacity: THREE.IUniform<number>; weight: THREE.IUniform<number> };

  constructor(geometry: THREE.PlaneGeometry, colors: PlateColors, overlay: OverlayUniforms, anisotropy: number) {
    this.canvas.width = CANVAS_WIDTH;
    this.canvas.height = CANVAS_HEIGHT;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.anisotropy = anisotropy;
    this.shared = { extent: { value: 1 }, opacity: { value: 1 }, weight: { value: 1 } };
    const uniforms = () => ({
      mask: { value: this.texture },
      ground: { value: colors.ground },
      ink: { value: colors.ink },
      accent: { value: colors.accent },
      ...this.shared,
    });
    // Only the glyphs are drawn: neither mesh writes depth for its rectangle.
    this.mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
      name: "LanePlate", uniforms: uniforms(), vertexShader, fragmentShader,
      transparent: true, depthWrite: false,
    }));
    this.overlay = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
      name: "LanePlateOverlay", uniforms: { ...uniforms(), ...overlay }, vertexShader, fragmentShader,
      defines: { LANE_PLATE_OVERLAY: "" }, transparent: true, depthTest: false, depthWrite: false,
    }));
    for (const mesh of [this.mesh, this.overlay]) {
      mesh.name = mesh.material.name;
      mesh.visible = false;
      mesh.castShadow = mesh.receiveShadow = false;
      // Its place is set every frame; nothing else moves it.
      mesh.frustumCulled = false;
    }
  }

  get opacity() { return this.shared.opacity.value; }
  get weight() { return this.shared.weight.value; }

  /** Write the column's number and name; returns whether the writing changed. */
  write(column: number, label: LaneName) {
    const written = plateText(column, label);
    if (written === this.written) return false;
    this.written = written;
    const context = this.canvas.getContext("2d")!;
    context.globalCompositeOperation = "source-over";
    context.fillStyle = "#000";
    context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    // Each layer adds to its own channel.
    context.globalCompositeOperation = "lighter";
    context.textBaseline = "alphabetic";
    let x = MARGIN;
    // The number: lighter than the name, and in the accent colour for the playing queue's column.
    // Each piece of writing is followed by its rim.
    context.font = INDEX_FONT;
    const index = laneLabelIndex(column);
    writeText(context, index, x, INDEX_FONT, "#00f", GROUND_BLUR);
    writeText(context, index, x, INDEX_FONT, label.live ? "#0f0" : "#b30000");
    x += context.measureText(index).width + 20;
    context.font = NAME_FONT;
    const name = fitted(context, label.name, CANVAS_WIDTH - x - MARGIN);
    writeText(context, name, x, NAME_FONT, "#00f", GROUND_BLUR);
    writeText(context, name, x, NAME_FONT, "#f00");
    const width = Math.min(CANVAS_WIDTH, Math.ceil(x + context.measureText(name).width + MARGIN));
    this.width = Math.max(LANE_PLATE.minWidth, width / LANE_PLATE.texel);
    this.shared.extent.value = this.width * LANE_PLATE.texel / CANVAS_WIDTH;
    this.texture.needsUpdate = true;
    return true;
  }

  /**
   * Stand the name on the line from `start` to `end` (the top of the cases along the
   * column's edge, both in world space with the same x), facing the lens side of the shelf.
   * `late`: it is drawn after the scene's passes instead of in the scene.
   */
  pose(start: THREE.Vector3, end: THREE.Vector3, opacity: number, weight: number, late: boolean) {
    const { mesh, overlay } = this;
    const pitch = Math.atan2(end.y - start.y, end.z - start.z);
    // The writing runs along +z and faces -x; the pitch follows the tops of the cases.
    mesh.rotation.set(-pitch, -Math.PI / 2, 0, "XYZ");
    mesh.scale.set(this.width, LANE_PLATE.height, 1);
    this.up.set(0, Math.cos(pitch), -Math.sin(pitch));
    mesh.position.copy(start).add(end).multiplyScalar(0.5).addScaledVector(this.up, LANE_PLATE.height / 2);
    overlay.position.copy(mesh.position);
    overlay.quaternion.copy(mesh.quaternion);
    overlay.scale.copy(mesh.scale);
    this.shared.opacity.value = opacity;
    this.shared.weight.value = weight;
    mesh.visible = !late;
    overlay.visible = late;
  }

  /** What decides the name's picture, for the frame description. */
  describe(value: (value: number) => void) {
    const { position, rotation } = this.mesh;
    value(position.x);
    value(position.y);
    value(position.z);
    value(rotation.x);
    value(this.width);
    value(this.opacity);
    value(this.weight);
    value(Number(this.overlay.visible));
  }

  hide() {
    this.mesh.visible = this.overlay.visible = false;
  }

  dispose() {
    this.texture.dispose();
    this.mesh.material.dispose();
    this.overlay.material.dispose();
  }
}

export class LanePlates {
  /** The names in the scene. */
  readonly group = new THREE.Group();
  /** The same names as they are drawn after the scene's passes. */
  readonly overlays = new THREE.Scene();
  readonly overlayUniforms: OverlayUniforms = {
    sceneDepth: { value: null },
    sceneDepthPacked: { value: 1 },
    sceneDepthStep: { value: new THREE.Vector2(1, 1) },
    resolution: { value: new THREE.Vector2(1, 1) },
    cameraNear: { value: 1 },
    cameraFar: { value: 2 },
  };
  /** Counts every rewrite, for the frame description. */
  revision = 0;
  private readonly plates: LanePlate[] = [];
  private readonly geometry = new THREE.PlaneGeometry(1, 1);
  private readonly colors: PlateColors = { ground: new THREE.Color(), ink: new THREE.Color(), accent: new THREE.Color() };

  constructor(private readonly anisotropy: number, theme: string) {
    this.group.name = "LanePlates";
    const colors = theme === "night" ? THEME.night : THEME.day;
    this.colors.ground.set(colors.ground);
    this.colors.ink.set(colors.ink);
    this.colors.accent.set(colors.accent);
  }

  setTheme(theme: string, targets: ThemeTransition) {
    const colors = theme === "night" ? THEME.night : THEME.day;
    targets.color(this.colors.ground, colors.ground);
    targets.color(this.colors.ink, colors.ink);
    targets.color(this.colors.accent, colors.accent);
  }

  /** Start a frame: every name is free until a lane claims it. */
  begin() {
    for (const plate of this.plates) plate.used = false;
  }

  /** The name of `lane` this frame, written with its column's number and name. */
  claim(lane: number, column: number, label: LaneName) {
    const text = plateText(column, label);
    const free = this.plates.filter((plate) => !plate.used);
    // The one that named this lane last frame; else one already written with this name; else
    // one that was not shown last frame (one that was is left for its own lane to claim).
    let plate = free.find((candidate) => candidate.lane === lane) ?? free.find((candidate) => candidate.written === text)
      ?? free.find((candidate) => !candidate.mesh.visible && !candidate.overlay.visible);
    if (!plate) {
      plate = new LanePlate(this.geometry, this.colors, this.overlayUniforms, this.anisotropy);
      this.plates.push(plate);
      this.group.add(plate.mesh);
      this.overlays.add(plate.overlay);
    }
    plate.used = true;
    plate.lane = lane;
    if (plate.write(column, label)) this.revision++;
    return plate;
  }

  /** End a frame: names no lane claimed are not drawn. */
  end() {
    for (const plate of this.plates) if (!plate.used) plate.hide();
  }

  /** Whether any name is drawn after the scene's passes this frame. */
  get late() {
    return this.plates.some((plate) => plate.overlay.visible);
  }

  /** What decides the names' picture (the ones drawn after the scene are not in it). */
  describe(value: (value: number) => void) {
    value(this.revision);
    for (const plate of this.plates) if (plate.used) plate.describe(value);
  }

  /** The names that are drawn, for diagnostics. */
  shown() {
    return this.plates.filter((plate) => plate.used).map((plate) => ({
      lane: plate.lane,
      written: plate.written.split("\n"),
      width: plate.width,
      opacity: plate.opacity,
      sharp: plate.overlay.visible,
      position: plate.mesh.position.toArray(),
    }));
  }

  dispose() {
    for (const plate of this.plates) plate.dispose();
    this.plates.length = 0;
    this.group.clear();
    this.overlays.clear();
    this.geometry.dispose();
  }
}

/**
 * Draws the names over the picture the scene's passes produced. `depth` gives the scene's
 * depth of this frame (what the lens read, or else what ambient occlusion rendered), or
 * nothing when neither pass ran: the names are meshes of the scene then, and nothing is
 * drawn here.
 */
export class LanePlateOverlayPass extends Pass {
  /** Whether the last frame drew the names here, for diagnostics. */
  drawn = false;

  constructor(
    private readonly plates: () => LanePlates | undefined,
    private readonly camera: THREE.Camera,
    private readonly depth: () => LaneSceneDepth | undefined,
  ) {
    super();
    this.needsSwap = false;
  }

  render(renderer: THREE.WebGLRenderer, _writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    const plates = this.plates(), depth = plates?.late ? this.depth() : undefined;
    this.drawn = Boolean(plates && depth);
    if (!plates || !depth) return;
    const uniforms = plates.overlayUniforms;
    uniforms.sceneDepth.value = depth.texture;
    uniforms.sceneDepthPacked.value = depth.packed ? 1 : 0;
    // Ambient occlusion can render at a lower resolution than the picture.
    uniforms.sceneDepthStep.value.set(Math.max(1, readBuffer.width / Math.max(1, depth.width)), Math.max(1, readBuffer.height / Math.max(1, depth.height)));
    uniforms.cameraNear.value = depth.near;
    uniforms.cameraFar.value = depth.far;
    uniforms.resolution.value.set(readBuffer.width, readBuffer.height);
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.render(plates.overlays, this.camera);
    renderer.autoClear = autoClear;
    uniforms.sceneDepth.value = null;
  }
}
