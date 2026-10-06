import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createArchiveLighting, type LightingLook } from "./archive-lighting";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { SSAOPass } from "three/addons/postprocessing/SSAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { normalizeQuality, type RenderQuality } from "./render-quality";
import { MultisampleRenderPass, applyAlbumPrintCoverage, applyTextureQuality, createQualityComposer, resizeQuality } from "./quality-renderer";
import { CardAppearance } from "./appearance";
import { configureInternalOptics } from "./internal-optics";
import { DecryptionController } from "./decryption";
import { FramePacing } from "./frame-pacing";
import { SharedDepthBokehPass } from "./depth-of-field";
import { archiveColumns, columnFiles, fileAtSlot, fileLocation, musicLibrary, records, slotStride } from "./data";
import { CoverAtlas } from "./cover-atlas";
import { MusicSelectionLighting } from "./music-lighting";
import { LANE_LABEL, laneLabelPose, laneLabelRange, laneLabelRest, laneLabelShare, laneLabelSlot, type LaneLabelSlots, type LaneName } from "./lane-labels";
import { LaneNameLayer } from "./lane-names";
import { MUSIC_LENS, MusicCameraMotion, MusicPlacementMotion, MusicPresentation, musicLens, musicArchiveTracksSettled, musicCinematicPose, musicExtractionAnchor } from "./music-camera";
import { MUSIC_CASE_ASSET } from "./music-case-asset";
import { MUSIC_LABEL, MUSIC_MODEL, configureMusicGlass, isMusicShellSurface, musicAssemblyPart } from "./music-model";
import { CASE_DETAIL, CASE_HARDWARE, caseDetailShader, createCaseDetailMaterial, mergeCaseDetail } from "./music-case-detail";
import { splitThinFaces } from "./thin-face-geometry";
import { configureThinFaceMaterial } from "./thin-face-material";
import {
  sameCell,
  selectionCell,
  fileAtCell,
  placeCell,
  poolCell,
  wrap,
  LOOP_COLUMNS,
  LOOP_ROWS,
  MUSIC_LOOP_ROWS,
  COLUMN_SPACING,
  ROW_SPACING,
  type ArchiveCell,
  type ArchiveNavigation,
} from "./archive-loop";
import { labelMarkSvg } from "./brand";
import { archiveFraming, isPortraitViewport, songFraming, swipeDirection } from "./viewport-layout";
import { SONG_CARD_TOP, SONG_CHAIN_CARDS, SONG_CHAIN_CENTRE, SONG_CHAIN_FIRST, SONG_SHELF_DROP, SONG_VIEW, songChainCards, songChainFirst, songChainIndex, songChainPose, songSlotRise, songChainWeight, songLaneOffset, songLaneWeight, songLiftHold, songShelfDrop } from "./song-pose";
import { assetUrl as publicAsset } from "./asset-url";
import { ThemeTransition } from "./theme-transition";
import {
  archiveWave,
  extraction,
  baselineSelectionWave,
  musicSelectionWave,
  rippleEnvelope,
  settlingWave,
  damp,
  columnStrength,
  idleWave,
  cinematicField,
  INSPECTION_LIFT,
  PLAY_GESTURE,
  playHop,
  returnStep,
} from "./motion";

const ease = (t: number) => {
  t = THREE.MathUtils.clamp(t, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
// Case detail with at most 6 mm of relief (merged detail, shelf hardware, printed label)
// adds nothing to ambient occlusion. It lives on this layer, which the AO normal/depth pass
// switches off instead of drawing the detail a second time.
const FLUSH_DETAIL_LAYER = 1;
class ShellAOPass extends SSAOPass {
  render(...args: Parameters<SSAOPass["render"]>) {
    this.camera.layers.disable(FLUSH_DETAIL_LAYER);
    try {
      super.render(...args);
    } finally {
      this.camera.layers.enable(FLUSH_DETAIL_LAYER);
    }
  }
}
// Shelf culling sphere around a case centre: the larger (archive) case's circumradius,
// 3.1, plus 2.5 for shadows cast into view by cases just outside it (the key light
// sits about 58° up, so a 3.7-tall case throws about 2.3 units).
const CULL_RADIUS = 5.6;
// Music browsing exposes a little more artwork; original archives and the
// reference animation keep their 0.4 preview height and existing camera path.
// 2026-10-05: 15% higher than the 0.9 it had been, at the owner's request.
export const MUSIC_PREVIEW_LIFT = 1.035;
// On the shelf the selected playlist's column comes this far toward the lens (-x), and so do
// the columns in front of it (nearer the lens), so none of them meet: the selected column
// stands out of the shelf, closer to the viewer, with a wider gap behind it (the owner,
// 2026-10-05: "move the entire selected playlist closer to the viewer"). In the picture it
// moves down and to the left. It glides with the column the selection is in, and is undone
// in the opened details and the song scene, whose cameras frame the column where it stands.
export const MUSIC_COLUMN_FORWARD = 1.8;
// Equal-height boxes clear the shelf after one box height plus a small gap.
// Keep the original archive/reference film's inspection height independent.
export const MUSIC_INSPECTION_LIFT = MUSIC_MODEL.height + 0.12;
// A case that has barely left the shelf leaves no returning copy, and only a few copies
// return at once: scrolling fast past many cases would otherwise add one to every render
// pass for each case passed (measured: 66 -> 438 draw calls during a wheel spin).
const MUSIC_RETURN_MIN_LIFT = 0.12;
const MUSIC_RETURN_COPIES = 6;
const MUSIC_DETAIL_ELEVATION = THREE.MathUtils.degToRad(20);
const MUSIC_ALBUM_SWITCH_RATE = 9;
// Where update() takes the music camera on the shelf once the opening has settled (its orbit
// and settle at 1, no album opened): the view's yaw and elevation in degrees, the world height
// it shows before the window's framing, its distance and its aim. The columns' names are placed
// with this camera (shelfRestCamera), so they hold still while the live camera moves.
const SHELF_REST = {
  yaw: 89 - 22 - 8,
  elevation: 3 + 40 - 8 - 16 + 6,
  span: 7.33,
  distance: 140,
  aim: [-1.091, -0.045, 0.481],
} as const;
export class ArchiveScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  // The reference uses a long lens 72–140 units from the cassette. A 0.1 near
  // plane quantizes adjacent optical layers to the same depth (visible shimmer).
  // All visible foreground geometry is beyond 5; retain the framing and lens.
  readonly camera = new THREE.PerspectiveCamera(34, 16 / 9, 5, 300);
  private composer: EffectComposer;
  private scenePass: MultisampleRenderPass;
  private readonly pacing = new FramePacing();
  private ao: SSAOPass;
  private bokeh: SharedDepthBokehPass;
  private instances: THREE.InstancedMesh[] = [];
  private instanceMatrices!: THREE.InstancedBufferAttribute;
  // Per pool slot: its transform and whether another object owns the cell this frame.
  // Only slots whose case meets the view are packed into instanceMatrices; instanceSlots
  // maps each drawn instance back to its slot.
  private slotMatrices = new Float32Array(0);
  private slotHidden = new Uint8Array(0);
  private instanceSlots = new Int32Array(0);
  private visibleInstances = 0;
  private readonly cullFrustum = new THREE.Frustum();
  private readonly cullMatrix = new THREE.Matrix4();
  private readonly cullSphere = new THREE.Sphere(new THREE.Vector3(), CULL_RADIUS);
  private model = new THREE.Group();
  private appearance = new CardAppearance();
  private decryption = new DecryptionController();
  private cursor = new THREE.Vector2();
  private raycaster = new THREE.Raycaster();
  private dummy = new THREE.Object3D();
  private positions: THREE.Vector3[] = [];
  private poolRows = LOOP_ROWS;
  private cells: ArchiveCell[] = [];
  private selectedCell: ArchiveCell = { lane: 2, row: 12 };
  private looping = false;
  private coordinateOrigin: ArchiveCell = { lane: 0, row: 0 };
  private lift = { value: 0, velocity: 0 };
  private rail = { value: 0, velocity: 0 };
  private shoulder = { value: 12, velocity: 0 };
  private laneFocus = { value: 2, velocity: 0 };
  private columnCamera = { value: 0, velocity: 0 };
  private returnY: number | null = null;
  private canInspect = false;
  private clearance = 0;
  private pulseGain = 1;
  private idleGain = 0;
  private lastInteraction = 0;
  private scanTime = 29.1;
  private scanBlend = 0;
  private cameraAim = new THREE.Vector3();
  private musicCamera = new MusicCameraMotion();
  private musicPresentation = new MusicPresentation();
  private musicPlacement = new MusicPlacementMotion();
  // A detail-to-detail selection owns its lift independently of placement.
  // Keep that ownership through an interrupted return to avoid a height jump.
  private musicNavigationLift = false;
  // The song scene (song-pose.ts): 0 on the shelf and in the album detail, 1 once the
  // lifted case is the large card and its row has formed the chain of covers.
  private song = new MusicPlacementMotion();
  private songTarget = 0;
  private songProgress = 0;
  private songDrop = SONG_SHELF_DROP;
  private songCards = SONG_CHAIN_CARDS;
  private songFirst = SONG_CHAIN_FIRST;
  private songBasis?: { origin: THREE.Vector3; right: THREE.Vector3; up: THREE.Vector3; forward: THREE.Vector3; quaternion: THREE.Quaternion };
  private readonly songCard = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), local: new THREE.Quaternion(), euler: new THREE.Euler() };
  // The lifted case's own turn, before the song scene poses it.
  private modelYaw = 0;
  private outgoing: {
    group: THREE.Group;
    slot: number;
    cell: ArchiveCell;
    lift: { value: number; velocity: number };
    returnY: number | null;
    // The copy's own turn; its group may also carry the song scene's pose.
    yaw: number;
    clarity: number;
  }[] = [];
  // Waves spreading over the shelf from a cell; `play` marks the play gesture's (playGesture).
  private pulses: { row: number; lane: number; time: number; play?: boolean }[] = [];
  // When the last play gesture's hop started, and how far it lifts the large card on screen.
  private playStarted = -Infinity;
  private songHopPixels = 0;
  // The lifted case's box on screen as last drawn on the shelf (liftedCaseRect), and a corner to project.
  private liftedBox: { left: number; top: number; right: number; bottom: number } | null = null;
  private readonly liftedCorner = new THREE.Vector3();
  private pendingPulse: ArchiveCell | null = null;
  private selectedSlot = 76;
  private detail = 0;
  private targetDetail = 0;
  private reveal = 0;
  private targetReveal = 0;
  private last = 0;
  private pointer = new THREE.Vector2();
  private dragging = false;
  private rotation = 0;
  private targetRotation = 0;
  private light: THREE.DirectionalLight;
  private floor: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  private stars?: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private covers?: CoverAtlas;
  private selectionLighting?: MusicSelectionLighting;
  // Names beside the shelf's columns (one per library column), flat text over the picture.
  private laneNames: readonly LaneName[] | null = null;
  private laneNameLayer?: LaneNameLayer;
  /** The shelf's camera at rest (shelfRestCamera), which the names' slots are seen with. */
  private readonly restCamera = new THREE.PerspectiveCamera();
  private readonly restProbe = new THREE.Vector3();
  /** The names' slots for each length of name, and the view at rest they were worked out for. */
  private readonly laneSlots = new Map<number, LaneLabelSlots>();
  private laneSlotView = "";
  private theme: "day" | "night" | "dusk" = "day";
  private themeWarmth = { value: 1 };
  private themeTransition?: ThemeTransition;
  private clock = 0;
  private loaded = false;
  private labelCanvas = document.createElement("canvas");
  private labelTexture?: THREE.CanvasTexture;
  private labelMesh?: THREE.Mesh;
  private labelMark = new Image();
  private reduced = false;
  private quality = normalizeQuality(undefined);
  private appliedQuality = "";
  private smaa = new SMAAPass();
  private aoKernelSize = 32;
  private displayHeight = 0;
  private releaseTimer = 0;
  private buffersReleased = false;
  private restoringBuffers = false;
  private readonly aoProjection = { projection: new THREE.Matrix4(), inverse: new THREE.Matrix4() };
  private layoutKind = "";
  onSelect?: (index: number, cell?: ArchiveCell, lifted?: boolean) => void;
  onHover?: (index: number | null) => void;
  onNavigate?: (axis: "row" | "lane", direction: number) => void;
  constructor(
    private container: HTMLElement,
    private readonly selectionPulse = baselineSelectionWave,
    private readonly deferSelectionPulse = false,
    private readonly lightingLook: LightingLook = "baseline",
  ) {
    this.renderer = new THREE.WebGLRenderer({
      // Every pass draws into the composer's targets (geometry is multisampled
      // there); the canvas receives only the final full-screen copy. Canvas
      // samples and depth would add ~90 MB and a resolve to every frame.
      antialias: false,
      depth: false,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(
      Math.min(devicePixelRatio, 1.5) *
        Math.min(innerWidth / 1920, innerHeight / 1080),
    );
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.enabled = true;
    // three r183 swaps the deprecated PCFSoftShadowMap for this at the first shadow render;
    // naming it directly lets precompile() build the shader variants the frames use.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.setAttribute(
      "aria-label",
      "三维研究档案阵列，可点击选择档案",
    );
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color("#eae5e1");
    this.scene.fog = new THREE.Fog("#eae5e1", 22, 47);
    this.light = createArchiveLighting(this.renderer, this.scene, lightingLook);
    this.light.castShadow = true;
    Object.assign(this.light.shadow.camera, {
      left: -16,
      right: 16,
      top: 15,
      bottom: -15,
      near: 0.1,
      far: 45,
    });
    this.light.shadow.mapSize.set(2048, 2048);
    this.light.shadow.normalBias = lightingLook === "refined" ? 0.018 : 0.035;
    this.light.shadow.bias = lightingLook === "refined" ? -0.00012 : -0.0003;
    this.light.shadow.radius = 4;
    const floor = this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: "#d8c9b9", roughness: 0.95 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -4.63;
    floor.receiveShadow = true;
    this.scene.add(floor);
    const starPositions: number[] = [];
    let seed = 417;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 140; i++) starPositions.push(random() * 2 - 1, random() * 2 - 1, 0);
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute("position", new THREE.Float32BufferAttribute(starPositions, 3));
    this.stars = new THREE.Points(starGeometry, new THREE.PointsMaterial({ color: "#dbeaff", size: 1.5, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false }));
    this.stars.visible = false;
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);
    this.camera.layers.enable(FLUSH_DETAIL_LAYER);
    this.camera.position.set(-62.26, 35.98, 43.28);
    this.cameraAim.set(-0.5, 1.1, 0.4);
    this.camera.fov = 6.15;
    this.camera.lookAt(this.cameraAim);
    this.composer = createQualityComposer(this.renderer);
    this.scenePass = new MultisampleRenderPass(this.scene, this.camera);
    this.composer.addPass(this.scenePass);
    this.ao = new ShellAOPass(
      this.scene,
      this.camera,
      container.clientWidth,
      container.clientHeight,
    );
    this.ao.kernelRadius = lightingLook === "refined" ? 0.44 : 0.38;
    this.ao.minDistance = 0.001;
    this.ao.maxDistance = 0.09;
    this.composer.addPass(this.ao);
    this.bokeh = new SharedDepthBokehPass(this.scene, this.camera, {
      focus: 25,
      aperture: 0.0018,
      maxblur: 0.011,
    }, () => this.ao);
    this.composer.addPass(this.bokeh);
    this.smaa.enabled = false;
    this.composer.addPass(this.smaa);
    this.composer.addPass(new OutputPass());
    this.bindPointer();
    document.addEventListener("visibilitychange", () => {
      window.clearTimeout(this.releaseTimer);
      if (document.hidden) this.releaseTimer = window.setTimeout(() => this.releaseFrameBuffers(), 10_000);
      else if (this.buffersReleased) this.restoreFrameBuffers();
    });
  }

  /**
   * A hidden or minimized window draws nothing, yet the buffers that follow
   * its size stay allocated: about 0.8 GB of video memory at 2160×1350. After
   * ten hidden seconds, shrink them all to one pixel, including three's own
   * glass (transmission) capture, and drop the shadow map. The canvas keeps
   * its last picture; returning resizes and draws before it is shown again.
   */
  private releaseFrameBuffers() {
    if (!document.hidden || this.buffersReleased || !this.loaded) return;
    this.buffersReleased = true;
    this.composer.setPixelRatio(1);
    this.composer.setSize(1, 1);
    // three sizes its transmission capture to the target being drawn: one
    // draw into the 1×1 scene target shrinks it too. Shadows are not redrawn.
    const { autoUpdate, needsUpdate } = this.renderer.shadowMap;
    this.renderer.shadowMap.autoUpdate = this.renderer.shadowMap.needsUpdate = false;
    this.renderer.setRenderTarget(this.scenePass.target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    Object.assign(this.renderer.shadowMap, { autoUpdate, needsUpdate });
    this.light.shadow.map?.dispose();
    this.light.shadow.map = null;
    // A hidden page presents no frames; send the deletions to the GPU now.
    this.renderer.getContext().flush();
  }

  private restoreFrameBuffers() {
    this.buffersReleased = false;
    // Restores every size from the current window and requests a draw.
    this.restoringBuffers = true;
    try {
      this.resize();
    } finally {
      this.restoringBuffers = false;
    }
  }
  async load(assetUrl = publicAsset(musicLibrary ? MUSIC_CASE_ASSET : "assets/archive-cassette.glb")) {
    // Both label layouts draw the brand mark.
    this.labelMark.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(labelMarkSvg)}`;
    await this.labelMark.decode();
    const gltf = await new GLTFLoader().loadAsync(
      assetUrl,
    );
    gltf.scene.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    gltf.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) meshes.push(o);
    });
    this.poolRows = musicLibrary ? MUSIC_LOOP_ROWS : LOOP_ROWS;
    const count = LOOP_COLUMNS * this.poolRows;
    this.slotMatrices = new Float32Array(count * 16);
    this.slotHidden = new Uint8Array(count).fill(1);
    this.instanceSlots = new Int32Array(count);
    for (let index = 0; index < count; index++) {
      const cell = poolCell(index, this.poolRows);
      this.cells.push(cell);
      this.positions.push(this.cellPosition(cell));
    }
    for (const mesh of meshes) {
      const source = mesh.material as THREE.MeshStandardMaterial;
      const name = source.name.replace(/\.\d+$/, "");
      // The music case's opaque detail is merged below; this loop builds its glass shell,
      // which is authored at its runtime size (art/build_music_case.py).
      if (musicLibrary && !isMusicShellSurface(name)) continue;
      const geom = mesh.geometry
        .clone()
        .applyMatrix4(mesh.matrixWorld)
        .scale(1, 1, 1);
      const mat = musicLibrary
        ? new THREE.MeshPhysicalMaterial({ name: source.name, side: source.side })
        : source.clone() as THREE.MeshPhysicalMaterial;
      mat.envMapIntensity = 0.6;
      if (name === "Frosted_Polymer") {
        mat.color.set("#fffdfa");
        mat.transmission = 0.9;
        mat.thickness = 0.12;
        mat.roughness = 0.21;
        mat.ior = 1.46;
        mat.attenuationColor = new THREE.Color("#eee6df");
        mat.attenuationDistance = 2;
      }
      if (name === "Internal_Ceramic") {
        mat.color.set(this.lightingLook === "refined" ? "#c4baae" : "#c7beb6");
        mat.roughness = 0.6;
      }
      if (name === "Printed_Label") mat.color.set("#eae5dc");
      if (name === "Ivory_Edges") {
        mat.color.set("#f0e7df");
        mat.roughness = 0.31;
        mat.transmission = 0.65;
        mat.thickness = 0.04;
      }
      if (name === "Optical_Diffuser") {
        mat.color.set("#e2dad4");
        mat.transmission = 0;
        mat.roughness = 0.7;
      }
      if (name === "Subsurface_Optics") {
        mat.color.set(this.lightingLook === "refined" ? "#b9a796" : "#b9aba1");
        mat.roughness = 0.48;
        mat.metalness = 0.05;
      }
      if (name === "Optical_Edges") {
        // Internal refractive shoulders must be in the opaque capture: WebGL's
        // screen-space transmission cannot recursively sample another glass mesh.
        mat.transmission = 0;
        mat.color.set(this.lightingLook === "refined" ? "#d8c7b5" : "#d4c7be");
        mat.roughness = 0.26;
        mat.metalness = 0.08;
      }
      if (musicLibrary) configureMusicGlass(name, mat);
      configureInternalOptics(name, mat);
      if (name === "Carbon_Ink") continue;
      const split = musicLibrary ? splitThinFaces(geom) : { body: geom, strips: null };
      const parts = [split.body, ...(split.strips ? [split.strips] : [])];
      if (musicLibrary) geom.dispose();
      for (const part of parts) {
        const selectedMesh = new THREE.Mesh(part, mat);
        selectedMesh.userData.surface = name;
        selectedMesh.userData.musicShell = musicLibrary;
        selectedMesh.userData.thinFaceCoverage = part === split.strips;
        // Coverage strips blend without writing depth: draw them after every body.
        if (part === split.strips) selectedMesh.renderOrder = 1;
        selectedMesh.castShadow = name === "Optical_Diffuser";
        selectedMesh.receiveShadow = true;
        this.model.add(selectedMesh);
      }
      // Only the shell, edge and fasteners remain visible within tightly packed rows.
      // Keep sub-millimetre optical/typographic geometry on the extracted cassette.
      if (
        ![
          "Frosted_Polymer",
          "Ivory_Edges",
          "Titanium_Fasteners",
          "Index_Inlay",
          "Optical_Diffuser",
        ].includes(name)
      ) {
        this.appearance.register(name, mat);
        continue;
      }
      const arrayMat = mat.clone();
      if (name === "Frosted_Polymer") {
        arrayMat.transmission = 0.78;
        if (this.lightingLook === "refined") {
          // Longer oblique paths pick up the warm body tint, while the thin
          // edges and the extracted clear cover retain a brighter response.
          arrayMat.thickness = 0.28;
          arrayMat.attenuationColor.set("#d4c7b4");
          arrayMat.attenuationDistance = 1.2;
        }
        arrayMat.transparent = false;
        arrayMat.color.set("#fff7ed");
        arrayMat.onBeforeCompile = (shader) => {
          shader.uniforms.archiveWarmth = this.themeWarmth;
          shader.vertexShader =
            "varying float vPanelHeight;\n" + shader.vertexShader;
          shader.vertexShader = shader.vertexShader.replace(
            "#include <begin_vertex>",
            "#include <begin_vertex>\nvPanelHeight = position.y / 3.7;",
          );
          shader.fragmentShader =
            "varying float vPanelHeight;\nuniform float archiveWarmth;\n" + shader.fragmentShader;
          if (!musicLibrary) shader.fragmentShader = shader.fragmentShader.replace(
            "#include <color_fragment>",
            "#include <color_fragment>\ndiffuseColor.rgb *= mix(mix(vec3(0.68, 0.76, 0.86), vec3(1.0), smoothstep(0.1, 1.0, vPanelHeight)), mix(vec3(0.40, 0.30, 0.20), vec3(1.0, 0.98, 0.94), smoothstep(0.1, 1.0, vPanelHeight)), archiveWarmth);",
          );
        };
        arrayMat.roughness = 0.28;
        arrayMat.clearcoat = 0.3;
        arrayMat.clearcoatRoughness = 0.25;
      }
      if (name === "Optical_Diffuser") arrayMat.color.set(musicLibrary ? "#cbb69c" : "#806447");
      if (name === "Ivory_Edges") {
        arrayMat.transmission = 0;
        arrayMat.color.set(
          this.lightingLook === "refined" ? "#dcc9b0" : "#fff5e9",
        );
        arrayMat.roughness = 0.38;
      }
      if (name === "Index_Inlay") {
        arrayMat.color.set("#e4d6c5");
        arrayMat.metalness = 0.05;
      }
      if (musicLibrary) {
        configureMusicGlass(name, arrayMat);
        const baseCompile = arrayMat.onBeforeCompile;
        arrayMat.onBeforeCompile = (shader, renderer) => {
          baseCompile.call(arrayMat, shader, renderer);
          this.selectionLighting?.shade(shader, name);
        };
        arrayMat.customProgramCacheKey = () => `music-guided-glass-${name}`;
      }
      this.appearance.register(name, mat, arrayMat);
      for (const part of parts) {
        const material = part === split.strips ? arrayMat.clone() : arrayMat;
        if (part === split.strips) {
          material.onBeforeCompile = arrayMat.onBeforeCompile;
          material.customProgramCacheKey = arrayMat.customProgramCacheKey;
          // Theme transitions animate the registered array material's colours;
          // share those objects so the strips do not keep the day palette.
          material.color = arrayMat.color;
          material.attenuationColor = arrayMat.attenuationColor;
          configureThinFaceMaterial(material);
        }
        const inst = new THREE.InstancedMesh(part, material, count);
        inst.userData.surface = name;
        inst.userData.thinFaceCoverage = part === split.strips;
        if (part === split.strips) inst.renderOrder = 1;
        inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        inst.castShadow = name === "Optical_Diffuser";
        inst.receiveShadow = true;
        inst.frustumCulled = false;
        this.instances.push(inst);
        this.scene.add(inst);
      }
    }
    if (musicLibrary) this.addCaseDetail(meshes, count);
    this.covers = new CoverAtlas(count, this.renderer.capabilities.maxTextureSize, this.renderer.capabilities.getMaxAnisotropy(), this.selectionLighting);
    // The shelf's index squares take their covers' colours, packed in draw order with the prints.
    this.instances.find((inst) => inst.userData.surface === CASE_HARDWARE)?.geometry.setAttribute("caseTint", this.covers.caseTint);
    this.scene.add(this.covers.array);
    // Every instanced part and its print share the per-slot transform: one
    // matrix buffer, written and uploaded once per frame instead of per mesh.
    this.instanceMatrices = this.instances[0].instanceMatrix;
    for (const mesh of [...this.instances, this.covers.array]) mesh.instanceMatrix = this.instanceMatrices;
    this.model.add(this.covers.selected);
    // Only the lifted case carries a printed label. The music label is about 100 px wide
    // in the detail view, so a 512 px canvas keeps each album change's upload small.
    this.labelCanvas.width = musicLibrary ? 512 : 1024;
    this.labelCanvas.height = musicLibrary ? 400 : 440;
    this.labelTexture = this.createLabelTexture();
    const label = new THREE.Mesh(
      musicLibrary
        ? new THREE.PlaneGeometry(MUSIC_LABEL.width, MUSIC_LABEL.height)
        : new THREE.PlaneGeometry(0.99, 0.46),
      new THREE.MeshBasicMaterial({
        map: this.labelTexture,
        toneMapped: false,
        transparent: true,
        depthWrite: false,
        // The music plate below is itself offset towards the camera; stay ahead of it
        // at oblique angles, where the slope term of that offset dominates.
        polygonOffset: musicLibrary,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
      }),
    );
    if (musicLibrary) {
      label.position.set(MUSIC_LABEL.x, MUSIC_LABEL.y, MUSIC_LABEL.z);
      // Its plate belongs to the merged detail, also drawn as transparent: print after it.
      label.renderOrder = 2;
      label.layers.set(FLUSH_DETAIL_LAYER);
    } else label.position.set(-1.36, 3.04, 0.255);
    label.userData.printedLabel = true;
    this.labelMesh = label;
    this.model.add(label);
    this.appearance.prepare(this.model);
    this.appearance.apply(this.model, 0);
    this.drawLabel(0);
    this.scene.add(this.model);
    // Logical slots retain their own stride; they are not display-pool indices.
    this.model.position.copy(this.cellPosition(this.selectedCell));
    this.loaded = true;
    this.pacing.invalidate();
    if (musicLibrary) await this.refreshLibrary();
    this.setTheme(this.theme);
    // Quality/resize may precede this asynchronous load. New prints must use
    // the current framebuffer's coverage even when the quality key is unchanged.
    applyAlbumPrintCoverage(this.scene, this.scenePass.samples);
  }

  /**
   * The music case's opaque detail in two draws: one mesh on the lifted case (its
   * machined detail dissolves in as it rises, while the shelf stand-ins dissolve out),
   * and one instanced batch of inlays and screws for the shelf.
   */
  private addCaseDetail(meshes: THREE.Mesh[], count: number) {
    const { lifted, shelf } = mergeCaseDetail(meshes);
    // The lifted detail sits in front of the glass and is never seen through it: drawn
    // with the transparent objects (at full opacity), it stays out of the transmission
    // capture that the glass samples.
    const high = createCaseDetailMaterial();
    high.transparent = true;
    this.appearance.register(CASE_DETAIL, high);
    if (lifted) {
      const mesh = new THREE.Mesh(lifted, high);
      mesh.userData.surface = CASE_DETAIL;
      mesh.userData.musicShell = true;
      mesh.userData.caseDetail = true;
      mesh.receiveShadow = true;
      mesh.layers.set(FLUSH_DETAIL_LAYER);
      this.model.add(mesh);
    }
    if (!shelf) return;
    const material = createCaseDetailMaterial();
    material.name = CASE_HARDWARE;
    material.onBeforeCompile = (shader) => {
      caseDetailShader(shader, false);
      this.selectionLighting?.shade(shader, CASE_HARDWARE);
    };
    material.customProgramCacheKey = () => "music-case-hardware-tinted";
    const inst = new THREE.InstancedMesh(shelf, material, count);
    inst.layers.set(FLUSH_DETAIL_LAYER);
    inst.userData.surface = CASE_HARDWARE;
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    inst.receiveShadow = true;
    inst.frustumCulled = false;
    this.instances.push(inst);
    this.scene.add(inst);
  }

  /**
   * Compile the scene's programs while the loading screen is still up, so the first
   * frame of the entrance does not stall while the driver builds every glass and detail
   * shader. With parallel shader compilation the builds run off the main thread, hidden
   * objects included.
   */
  async precompile() {
    if (!this.loaded) return;
    const renderer = this.renderer;
    const backFaces = new Set<THREE.Material>();
    const hiddenLights: THREE.Object3D[] = [];
    this.scene.traverse((object) => {
      if ((object as THREE.Light).isLight && !object.visible) hiddenLights.push(object);
      const material = (object as THREE.Mesh).material;
      for (const m of Array.isArray(material) ? material : material ? [material] : [])
        if (m.side === THREE.DoubleSide && (m as THREE.MeshPhysicalMaterial).transmission > 0) backFaces.add(m);
    });
    // Every lit shader is built for the lights that are on. The selected album's key is
    // on in every frame once the shelf has albums, so build with the hidden lights on.
    const withLights = (draw: () => void) => {
      for (const light of hiddenLights) light.visible = true;
      try {
        draw();
      } finally {
        for (const light of hiddenLights) light.visible = false;
      }
    };
    // The scene is only ever drawn into render targets (untoned, linear): compiling for the
    // canvas would build tone-mapped variants that no frame uses.
    const previous = renderer.getRenderTarget();
    let ready: Promise<unknown> = Promise.resolve();
    renderer.setRenderTarget(this.scenePass.target);
    try {
      withLights(() => {
        // Double-sided glass is also drawn from behind into three's transmission capture.
        for (const m of backFaces) m.side = THREE.BackSide;
        if (backFaces.size) renderer.compile(this.scene, this.camera);
        for (const m of backFaces) {
          m.side = THREE.DoubleSide;
          m.needsUpdate = true;
        }
        ready = renderer.compileAsync(this.scene, this.camera);
      });
    } catch (error) {
      // A lost context compiles again on restore; the first frame just pays for it.
      console.warn(error);
    } finally {
      renderer.setRenderTarget(previous);
    }
    await ready.catch((error) => console.warn(error));
    // Shadow depth, AO normals and the post-processing passes only get their (small)
    // programs from a real frame: draw one behind the loading screen.
    renderer.shadowMap.needsUpdate = true;
    withLights(() => this.composer.render());
    this.pacing.invalidate();
  }

  /** Call after setMusicAlbums; reuse the allocated display pool and cover atlas. */
  async refreshLibrary(selectedIndex = 0) {
    if (!this.loaded || !this.covers) return;
    this.pacing.invalidate();
    this.musicPresentation.request("hidden");
    this.musicCamera = new MusicCameraMotion();
    this.musicPlacement = new MusicPlacementMotion();
    this.song = new MusicPlacementMotion();
    this.songTarget = this.songProgress = 0;
    this.musicNavigationLift = false;
    this.targetDetail = this.detail = 0;
    for (const old of this.outgoing) { this.scene.remove(old.group); this.appearance.dispose(old.group); }
    this.outgoing = [];
    this.covers.reset(records.length);
    this.covers.array.visible = musicLibrary && records.length > 0;
    this.covers.selected.visible = musicLibrary && records.length > 0;
    this.model.visible = records.length > 0;
    for (const inst of this.instances) inst.visible = records.length > 0;
    // The music case carries its own label plate and printed album label.
    for (const child of this.model.children) if (child.userData.surface || child.userData.printedLabel) child.visible = true;
    const index = Math.max(0, Math.min(records.length - 1, selectedIndex));
    const location = fileLocation(index);
    this.selectedSlot = location.slot;
    this.selectedCell = { lane: location.lane, row: location.row };
    this.coordinateOrigin = { lane: 0, row: 0 };
    this.lift = { value: 0, velocity: 0 };
    this.rotation = this.targetRotation = 0;
    this.returnY = null;
    this.pulses = [];
    this.pendingPulse = null;
    this.shoulder = { value: location.row, velocity: 0 };
    this.laneFocus = { value: location.lane, velocity: 0 };
    this.columnCamera = { value: (location.lane - 2) * COLUMN_SPACING, velocity: 0 };
    await this.covers.select(records[index]);
  }

  /**
   * Name the shelf's columns: `names[column]` for every library column, written over the
   * picture (placeLaneLabels). `null` removes the names.
   */
  setLaneLabels(names: readonly LaneName[] | null) {
    this.pacing.invalidate();
    this.laneNames = names?.length ? names : null;
  }

  enableSelectionLighting() {
    this.pacing.invalidate();
    this.selectionLighting ??= new MusicSelectionLighting(this.scene);
    this.appearance.musicLighting = this.selectionLighting;
    this.softenMusicContactShadows();
    this.setTheme(this.theme);
  }

  private softenMusicContactShadows() {
    this.light.shadow.intensity = 0.32;
    this.ao.kernelRadius = 0.18;
    this.ao.maxDistance = 0.035;
    // SSAO assumes opaque solids. Thin transmitting cases need only a soft
    // contact cue: bound the darkest AO multiplier to 0.78, not solid black.
    this.ao.copyMaterial.fragmentShader = this.ao.copyMaterial.fragmentShader.replace(
      "gl_FragColor = opacity * texel;",
      "gl_FragColor = vec4(mix(vec3(1.0), texel.rgb, 0.22), texel.a);",
    );
    this.ao.copyMaterial.needsUpdate = true;
  }

  setTheme(theme: "day" | "night" | "dusk", animate = false) {
    this.pacing.invalidate();
    this.theme = theme;
    // A new request samples the currently rendered colors/intensities. It
    // replaces the previous targets without finishing the previous transition.
    const targets = new ThemeTransition();
    targets.number(this.themeWarmth, "value", theme === "day" ? 1 : 0);
    const background = theme === "night" ? "#07111f" : theme === "dusk" ? "#b9c7cc" : "#eae5e1";
    targets.color(this.scene.background as THREE.Color, background);
    targets.color((this.scene.fog as THREE.Fog).color, background);
    targets.color(this.floor.material.color, theme === "night" ? "#0b1828" : theme === "dusk" ? "#a6b8c0" : "#d8c9b9");
    targets.number(this.renderer, "toneMappingExposure", theme === "night" ? 1.08 : 1.05);
    targets.number(this.scene, "environmentIntensity", theme === "night" ? .68 : .48);
    targets.color(this.light.color, theme === "night" ? "#e5f0ff" : theme === "dusk" ? "#eff8ff" : "#fff7ed");
    targets.number(this.light, "intensity", theme === "night" ? 1.7 : 1.4);
    for (const child of this.scene.children) if (child instanceof THREE.HemisphereLight) {
      targets.color(child.color, theme === "night" ? "#e2eeff" : "#fffaf5");
      targets.color(child.groundColor, theme === "night" ? "#56708c" : theme === "dusk" ? "#718898" : "#b4a18c");
      targets.number(child, "intensity", theme === "night" ? .9 : .65);
    }
    if (this.stars) targets.number(this.stars.material, "opacity", theme === "night" ? .6 : 0);
    this.appearance.setTheme(theme, targets);
    this.selectionLighting?.setTheme(theme, this.light, targets);
    this.themeTransition = animate && !this.reduced && musicLibrary ? targets : undefined;
    if (!this.themeTransition) targets.finish();
    this.syncThemeStars();
  }

  private syncThemeStars() {
    if (this.stars) this.stars.visible = this.stars.material.opacity > 0;
  }

  private assemblyTemplate?: Promise<THREE.Group>;
  private musicAssemblyTemplate?: Promise<THREE.Group>;
  private async createMusicAssemblyModel() {
    this.musicAssemblyTemplate ??= new GLTFLoader()
      .loadAsync(publicAsset(MUSIC_CASE_ASSET))
      .then((gltf) => {
        gltf.scene.updateMatrixWorld(true);
        return gltf.scene;
      })
      .catch((error) => {
        this.musicAssemblyTemplate = undefined;
        throw error;
      });
    const template = await this.musicAssemblyTemplate;
    const model = new THREE.Group();
    const meshes: THREE.Mesh[] = [];
    const sources: THREE.Mesh[] = [];
    template.traverse((object) => {
      if (object instanceof THREE.Mesh) sources.push(object);
    });
    // The inspected case shows its full detail as one mesh; shelf stand-ins stay out.
    const { lifted } = mergeCaseDetail(sources, { standIns: false });
    if (lifted) {
      const mesh = new THREE.Mesh(lifted, createCaseDetailMaterial());
      mesh.userData.surface = CASE_DETAIL;
      mesh.userData.musicShell = true;
      mesh.userData.caseDetail = true;
      mesh.userData.assemblyPart = musicAssemblyPart(CASE_DETAIL);
      model.add(mesh);
      meshes.push(mesh);
    }
    for (const object of sources) {
      const surface = (object.material as THREE.Material).name.replace(/\.\d+$/, "");
      if (!isMusicShellSurface(surface)) continue;
      const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld);
      const split = splitThinFaces(geometry);
      geometry.dispose();
      for (const part of [split.body, ...(split.strips ? [split.strips] : [])]) {
        const mesh = new THREE.Mesh(part, object.material);
        mesh.userData.surface = surface;
        mesh.userData.musicShell = true;
        mesh.userData.thinFaceCoverage = part === split.strips;
        if (part === split.strips) mesh.renderOrder = 1;
        mesh.userData.assemblyPart = musicAssemblyPart(surface);
        model.add(mesh);
        meshes.push(mesh);
      }
    }
    this.appearance.prepare(model);
    this.appearance.apply(model, 1);
    this.appearance.setClarity(model, 1);
    model.userData.musicShell = true;
    return {
      model,
      setClarity: (value: number) => this.appearance.setClarity(model, value),
      dispose: () => {
        for (const mesh of meshes) {
          mesh.geometry.dispose();
          (mesh.material as THREE.Material).dispose();
        }
      },
    };
  }

  async createAssemblyModel() {
    if (musicLibrary) return this.createMusicAssemblyModel();
    this.assemblyTemplate ??= new GLTFLoader()
      .loadAsync(publicAsset("assets/archive-assembly.glb"))
      .then((gltf) => {
        gltf.scene.updateMatrixWorld(true);
        return gltf.scene;
      })
      .catch((error) => {
        this.assemblyTemplate = undefined;
        throw error;
      });
    const template = await this.assemblyTemplate;
    const model = new THREE.Group();
    const meshes: THREE.Mesh[] = [];
    template.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const name = (object.material as THREE.Material).name.replace(
        /\.\d+$/,
        "",
      );
      const mesh = new THREE.Mesh(
        object.geometry.clone().applyMatrix4(object.matrixWorld),
        object.material,
      );
      mesh.userData.surface = name;
      mesh.userData.assemblyPart = object.userData.assemblyPart;
      model.add(mesh);
      meshes.push(mesh);
    });
    this.appearance.prepare(model);
    this.appearance.apply(model, 1);
    this.appearance.setClarity(model, this.decryption.clarity);
    const canvas = document.createElement("canvas");
    canvas.width = this.labelCanvas.width;
    canvas.height = this.labelCanvas.height;
    canvas.getContext("2d")!.drawImage(this.labelCanvas, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(0.99, 0.46),
      new THREE.MeshBasicMaterial({
        map: texture,
        toneMapped: false,
        transparent: true,
        depthWrite: false,
      }),
    );
    label.position.set(-1.36, 3.04, 0.255);
    label.userData.assemblyPart = "cover";
    label.userData.printedLabel = true;
    model.add(label);
    meshes.push(label);
    return {
      model,
      setClarity: (value: number) => this.appearance.setClarity(model, value),
      dispose: () => {
        for (const mesh of meshes) {
          mesh.geometry.dispose();
          (mesh.material as THREE.Material).dispose();
        }
        texture.dispose();
      },
    };
  }
  setMode(mode: "hidden" | "archive" | "detail") {
    this.pacing.invalidate();
    if (musicLibrary) this.musicPresentation.request(mode);
    if (musicLibrary && mode === "hidden") {
      this.musicCamera = new MusicCameraMotion();
      this.musicPlacement = new MusicPlacementMotion();
      this.song = new MusicPlacementMotion();
      this.songProgress = 0;
      this.musicNavigationLift = false;
    }
    // The song scene exists only around an opened album.
    if (mode !== "detail") this.songTarget = 0;
    if (mode === "detail") this.decryption.enter(this.scanBlend > .9 && this.decryption.clarity > .999);
    else this.decryption.leave();
    if (mode === "hidden") this.decryption.select();
    if (mode !== "archive") this.pendingPulse = null;
    this.looping = mode !== "hidden";
    if (!this.looping) {
      const canonical = fileLocation(fileAtSlot(this.selectedSlot));
      this.selectedCell = { lane: canonical.lane, row: canonical.row };
      this.coordinateOrigin = { lane: 0, row: 0 };
      for (const old of this.outgoing) {
        this.scene.remove(old.group);
        this.appearance.dispose(old.group);
      }
      this.outgoing = [];
    }
    this.lastInteraction = this.clock;
    this.targetReveal = mode === "hidden" ? 0 : 1;
    this.targetDetail = musicLibrary
      ? Number(this.musicPresentation.holdsDetail)
      : mode === "detail" ? 1 : 0;
    this.dragging = false;
    if (mode !== "detail") {
      this.targetRotation = 0;
      if (this.rotation !== 0) this.returnY = this.model.position.y;
    } else this.returnY = null;
  }
  /** Turn the opened album into the song scene, or back into the album detail. */
  setSongStage(active: boolean) {
    const target = musicLibrary && active && this.musicPresentation.holdsDetail ? 1 : 0;
    if (target === this.songTarget) return;
    this.pacing.invalidate();
    this.songTarget = target;
    // Readiness waits for the new framing without replaying the placement.
    if (this.musicPresentation.placed) this.musicPresentation.selectionChanged();
    this.dragging = this.canInspect = false;
    this.targetRotation = 0;
  }
  setReduced(value: boolean) {
    this.pacing.invalidate();
    this.reduced = value;
    if (value) {
      // A play gesture in progress stops with the rest of the motion.
      this.playStarted = -Infinity;
      this.pulses = this.pulses.filter((pulse) => !pulse.play);
    }
    if (value && this.themeTransition) {
      this.themeTransition.finish();
      this.themeTransition = undefined;
      this.syncThemeStars();
    }
  }
  /** The intro has already rendered the archive pose; hand over its same state. */
  finishMusicIntro(nowSeconds: number) {
    if (!musicLibrary || !this.loaded) return;
    this.pacing.invalidate();
    this.musicNavigationLift = false;
    this.clock = this.last = this.lastInteraction = nowSeconds;
    this.setMode("archive");
    this.reveal = this.targetReveal = 1;
    this.detail = this.targetDetail = 0;
    this.rotation = this.targetRotation = 0;
    this.returnY = null;
    this.dragging = this.canInspect = false;
    this.scanTime = 29.1;
    this.scanBlend = this.idleGain = 0;
    this.pulses = [];
    this.pendingPulse = null;
    this.pointer.set(0, 0);
    // The final preview hold is at rest. Discard finite-difference velocity
    // from the film and seed browsing with the rendered position/FOV intact.
    this.musicCamera = new MusicCameraMotion();
    this.musicCamera.observe(this.camera, this.cameraAim, 0);
    this.musicPresentation.update(0, true, true, true);
  }
  showMusicArchiveImmediately(nowSeconds: number) {
    if (!musicLibrary || !this.loaded) return;
    this.pacing.invalidate();
    this.musicPresentation = new MusicPresentation();
    this.musicCamera = new MusicCameraMotion();
    this.musicPlacement = new MusicPlacementMotion();
    this.song = new MusicPlacementMotion();
    this.songProgress = 0;
    this.musicNavigationLift = false;
    this.clock = this.last = this.lastInteraction = nowSeconds;
    this.setMode("archive");
    this.reveal = this.targetReveal = 1;
    this.detail = this.targetDetail = 0;
    this.rotation = this.targetRotation = 0;
    this.returnY = null;
    this.dragging = this.canInspect = false;
    this.pointer.set(0, 0);
    this.lift = { value: MUSIC_PREVIEW_LIFT, velocity: 0 };
    const chosen = this.cellPosition(this.selectedCell);
    this.rail = { value: -2.17 - chosen.z, velocity: 0 };
    this.columnCamera = { value: chosen.x, velocity: 0 };
    this.shoulder = { value: this.selectedCell.row, velocity: 0 };
    this.laneFocus = { value: this.selectedCell.lane, velocity: 0 };
    this.scanTime = 29.1;
    this.scanBlend = this.idleGain = 0;
    this.pulseGain = 1;
    this.pulses = [];
    this.pendingPulse = null;
    for (const old of this.outgoing) {
      this.scene.remove(old.group);
      this.appearance.dispose(old.group);
    }
    this.outgoing = [];
    this.decryption.select();
    const reduced = this.reduced;
    try {
      // Snap and render the existing archive targets before the first visible
      // frame; subsequent updates resume the user's normal motion preference.
      this.reduced = true;
      this.update(nowSeconds);
    } finally {
      this.reduced = reduced;
    }
  }
  setQuality(value: RenderQuality | boolean) {
    this.pacing.invalidate();
    const quality =
      typeof value === "boolean"
        ? normalizeQuality(undefined, value)
        : normalizeQuality(value);
    const key = JSON.stringify(quality);
    if (this.appliedQuality === key) return;
    this.appliedQuality = key;
    this.quality = quality;
    if (quality.aoSamples && quality.aoSamples !== this.aoKernelSize) {
      const old = this.ao;
      this.ao = new ShellAOPass(this.scene, this.camera, 1, 1, quality.aoSamples);
      this.ao.kernelRadius = old.kernelRadius;
      this.ao.minDistance = old.minDistance;
      this.ao.maxDistance = old.maxDistance;
      const index = this.composer.passes.indexOf(old);
      this.composer.removePass(old);
      this.composer.insertPass(this.ao, index);
      old.dispose();
      this.aoKernelSize = quality.aoSamples;
      if (this.selectionLighting) this.softenMusicContactShadows();
    }
    this.ao.enabled = quality.aoSamples > 0;
    this.bokeh.enabled = quality.depthOfField > 0;
    this.renderer.shadowMap.enabled = quality.shadows > 0;
    const size = Math.min(
      quality.shadows || 1024,
      this.renderer.capabilities.maxTextureSize,
    );
    if (this.light.shadow.mapSize.x !== size) {
      this.light.shadow.map?.dispose();
      this.light.shadow.map = null;
      this.light.shadow.mapSize.set(size, size);
    }
    this.light.shadow.needsUpdate = true;
    applyTextureQuality(this.scene, this.renderer, quality);
    this.resize();
  }
  private cellPosition(cell: ArchiveCell) {
    return new THREE.Vector3(
      (cell.lane - 2) * COLUMN_SPACING,
      -4.6,
      (cell.row - 15.5) * ROW_SPACING,
    );
  }
  private rebaseCoordinates() {
    // Periodically reduce the logical coordinates while preserving every
    // relative position, spring velocity, ripple and idle phase.
    const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
    const rowPeriod = archiveColumns.reduce((period, _, lane) => {
      const count = columnFiles(lane).length || 1;
      const next = period / gcd(period, count) * count;
      return next > 1e6 ? Infinity : next;
    }, 1);
    const lanePeriod = Math.max(1, archiveColumns.length);
    const shift = {
      lane:
        Math.abs(this.selectedCell.lane) > 2048
          ? Math.round((this.selectedCell.lane - 2) / lanePeriod) * lanePeriod
          : 0,
      row:
        Math.abs(this.selectedCell.row) > Math.max(2048, rowPeriod * 2)
          ? Math.floor((this.selectedCell.row - 12) / rowPeriod) * rowPeriod
          : 0,
    };
    if (!shift.lane && !shift.row) return;
    this.selectedCell.lane -= shift.lane;
    this.selectedCell.row -= shift.row;
    this.coordinateOrigin.lane += shift.lane;
    this.coordinateOrigin.row += shift.row;
    this.laneFocus.value -= shift.lane;
    this.shoulder.value -= shift.row;
    this.columnCamera.value -= shift.lane * COLUMN_SPACING;
    this.rail.value += shift.row * ROW_SPACING;
    for (const old of this.outgoing) {
      old.cell.lane -= shift.lane;
      old.cell.row -= shift.row;
    }
    for (const pulse of this.pulses) {
      pulse.lane -= shift.lane;
      pulse.row -= shift.row;
    }
    if (this.pendingPulse) {
      this.pendingPulse.lane -= shift.lane;
      this.pendingPulse.row -= shift.row;
    }
  }
  /**
   * The play / stop gesture (PLAY_GESTURE): the selected case hops and the selection wave
   * spreads from its place, over the shelf (also under an opened case) and along the song
   * scene's chain. Reduced motion has neither.
   */
  playGesture() {
    if (!musicLibrary || !this.loaded || this.reduced || !records.length) return;
    const now = performance.now() / 1000;
    this.pacing.invalidate();
    this.playStarted = now;
    this.pulses.push({ ...this.selectedCell, time: now + PLAY_GESTURE.wave, play: true });
    this.pulses = this.pulses.slice(-6);
  }
  /** CSS pixels the play gesture lifts the song scene's large card this frame. */
  get songCardHop() {
    return this.songHopPixels;
  }
  /** Retarget the detail rail without replaying the archive/inspection move. */
  switchMusicAlbum(index: number, navigation?: ArchiveNavigation) {
    if (!musicLibrary || !this.loaded || !records[index] || !this.musicPresentation.placed) return;
    this.musicNavigationLift = true;
    this.dragging = this.canInspect = false;
    this.select(index, navigation);
    this.decryption.enter(this.decryption.clarity > .999);
    this.pendingPulse = null;
  }
  select(index: number, navigation?: ArchiveNavigation) {
    if (!records[index]) return;
    this.pacing.invalidate();
    // Browsing can resume before the return camera is fully settled. A new
    // browsing selection must not inherit the previous detail box's lift mode.
    if (musicLibrary && !this.musicPresentation.placed) this.musicNavigationLift = false;
    this.lastInteraction = this.clock;
    const next = fileLocation(index).slot;
    const canonical = fileLocation(index);
    const cell = this.looping
      ? selectionCell(index, this.selectedCell, navigation)
      : { lane: canonical.lane, row: canonical.row };
    const changed = !sameCell(cell, this.selectedCell);
    if (musicLibrary && changed) this.musicPresentation.selectionChanged();
    // A play gesture's hop still running belongs to the case it started on: the case that
    // leaves keeps its height and lowers from there, the new selection does not hop.
    const hop = musicLibrary && changed ? playHop(performance.now() / 1000 - this.playStarted) : 0;
    if (musicLibrary && changed) this.playStarted = -Infinity;
    if (musicLibrary && this.looping && changed && this.loaded && this.lift.value + hop < MUSIC_RETURN_MIN_LIFT) {
      this.lift.value = 0;
      this.lift.velocity = 0;
    } else if (this.looping && changed && this.loaded && this.lift.value + hop > 0.0001) {
      const group = this.model.clone(true);
      this.appearance.prepare(group);
      const cover = group.children.find((child) => child.userData.albumCover) as THREE.Mesh | undefined;
      // The copy keeps the print and the index-square colour of the album it leaves with.
      const tint = (group.children.find((child) => child.userData.caseTint)?.userData.caseTint as THREE.IUniform<THREE.Vector4> | undefined)?.value;
      if (cover) this.covers?.snapshot(cover, tint);
      const label = group.children.find((child) => child.userData.printedLabel) as THREE.Mesh | undefined;
      if (label && musicLibrary && this.labelMesh) {
        // The returning copy keeps the label texture already on the GPU, and the lifted
        // case gets a fresh one for its next label: one upload per change, no canvas copy.
        label.material = (label.material as THREE.MeshBasicMaterial).clone();
        this.labelTexture = this.createLabelTexture();
        (this.labelMesh.material as THREE.MeshBasicMaterial).map = this.labelTexture;
        this.musicLabelKey = "";
      } else if (label) {
        const canvas = document.createElement("canvas");
        canvas.width = this.labelCanvas.width;
        canvas.height = this.labelCanvas.height;
        canvas.getContext("2d")!.drawImage(this.labelCanvas, 0, 0);
        const map = new THREE.CanvasTexture(canvas);
        map.colorSpace = THREE.SRGBColorSpace;
        const source = label.material as THREE.MeshBasicMaterial;
        label.material = new THREE.MeshBasicMaterial({
          map,
          toneMapped: false,
          transparent: true,
          depthWrite: false,
          polygonOffset: source.polygonOffset,
          polygonOffsetFactor: source.polygonOffsetFactor,
          polygonOffsetUnits: source.polygonOffsetUnits,
        });
      }
      this.appearance.apply(group, ease(this.lift.value / 0.4));
      this.appearance.setClarity(group, this.decryption.clarity);
      this.scene.add(group);
      this.outgoing.push({
        group,
        slot: this.selectedSlot,
        cell: { ...this.selectedCell },
        lift: { value: this.lift.value + hop, velocity: this.lift.velocity },
        returnY: this.modelYaw !== 0 ? group.position.y : null,
        yaw: this.modelYaw,
        clarity: this.decryption.clarity,
      });
      while (musicLibrary && this.outgoing.length > MUSIC_RETURN_COPIES) {
        // The oldest copy is the one closest to the shelf already.
        const old = this.outgoing.shift()!;
        this.scene.remove(old.group);
        this.appearance.dispose(old.group);
      }
      this.lift.value = 0;
      this.lift.velocity = 0;
    }
    this.selectedSlot = next;
    this.selectedCell = cell;
    if (changed) {
      this.decryption.select();
      this.rotation = 0;
      this.returnY = null;
    }
    const returning = this.outgoing.findIndex((o) => sameCell(o.cell, cell));
    if (returning >= 0) {
      const o = this.outgoing[returning];
      this.lift = { ...o.lift };
      this.rotation = o.yaw;
      this.returnY = o.returnY;
      this.decryption.select(o.clarity);
      this.scene.remove(o.group);
      this.appearance.dispose(o.group);
      this.outgoing.splice(returning, 1);
    }
    if (musicLibrary && this.musicNavigationLift && this.musicPresentation.placed) {
      // Detail navigation moves the shelf itself; a browsing ripple would
      // reintroduce vertical motion underneath the fixed inspection camera.
      this.pendingPulse = null;
    } else if (this.deferSelectionPulse) {
      this.pendingPulse = this.looping ? { ...cell } : null;
    } else this.emitPulse(cell);
    this.targetRotation = 0;
    this.drawLabel(index);
    if (musicLibrary) void this.covers?.select(records[index]);
  }
  /**
   * The case under the cursor: a shelf case, the lifted one, or a copy on its way back to
   * its place. A copy is its own case; until it is retired its shelf instance is hidden,
   * and a ray that passed through it would pick whatever stands behind.
   */
  private pickCase(): { file: number; cell: ArchiveCell; lifted: boolean } | null {
    this.raycaster.setFromCamera(this.cursor, this.camera);
    this.instances[0].boundingSphere = null;
    const hit = this.raycaster.intersectObjects(
      [this.instances[0], this.model, ...this.outgoing.map((o) => o.group)],
      true,
    )[0];
    if (!hit) return null;
    if (hit.instanceId !== undefined) {
      const cell = this.cells[this.slotOfInstance(hit.instanceId)];
      return { file: fileAtCell(cell), cell: { ...cell }, lifted: false };
    }
    for (let object: THREE.Object3D | null = hit.object; object; object = object.parent) {
      const copy = this.outgoing.find((o) => o.group === object);
      if (copy) return { file: fileAtCell(copy.cell), cell: { ...copy.cell }, lifted: false };
    }
    return { file: fileAtSlot(this.selectedSlot), cell: { ...this.selectedCell }, lifted: true };
  }
  private emitPulse(cell: ArchiveCell) {
    this.pulses.push({ ...cell, time: this.clock });
    this.pulses = this.pulses.slice(-6);
  }
  private drawLabel(index: number) {
    if (!this.labelTexture) return;
    if (musicLibrary) {
      this.drawMusicLabel(index);
      return;
    }
    const c = this.labelCanvas.getContext("2d")!;
    c.fillStyle = "#e6e2d9";
    c.fillRect(0, 0, 1024, 440);
    c.fillStyle = "#171713";
    c.fillRect(12, 12, 1000, 6);
    c.fillRect(12, 419, 1000, 3);
    c.font = "bold 81px MiSans";
    c.fillText("RHINE LAB, LLC.", 22, 116);
    c.font = "32px MiSans";
    c.fillStyle = "#878476";
    c.fillText("INTERNAL DATABASE", 25, 174);
    c.fillStyle = "#171713";
    c.font = "bold 130px MiSans";
    c.fillText("NO." + String(index + 1).padStart(3, "0"), 22, 360);
    c.fillRect(782, 32, 221, 39);
    c.fillStyle = "#eee9de";
    c.font = "24px MiSans";
    c.fillText("R L / I S", 809, 61);
    c.fillStyle = "#171713";
    c.font = "bold 64px MiSans";
    c.fillText("INFO", 830, 143);
    c.drawImage(this.labelMark, 790, 242, 210, 98);
    this.labelTexture.needsUpdate = true;
  }
  private createLabelTexture() {
    const texture = new THREE.CanvasTexture(this.labelCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    return texture;
  }
  private musicLabelKey = "";
  /** The lifted case's label: album number, file format and track count, from the library. */
  private drawMusicLabel(index: number) {
    const album = records[index]?.album;
    const formats = [...new Set(album?.tracks.map((track) => track.format.toUpperCase()) ?? [])];
    const format = formats.length > 1 ? "MIXED" : formats[0] ?? "DEMO";
    const tracks = album?.tracks.length ?? 0;
    const key = `${index}|${album?.id ?? ""}|${format}|${tracks}`;
    // Selection and library refreshes repeat the same album; skip the redraw and upload.
    if (key === this.musicLabelKey) return;
    this.musicLabelKey = key;
    // A CPU-backed canvas: the upload copies plain pixels instead of flushing a GPU canvas.
    const c = this.labelCanvas.getContext("2d", { willReadFrequently: true })!;
    const ink = "#171713";
    c.fillStyle = "#ece8df";
    c.fillRect(0, 0, 512, 400);
    c.fillStyle = ink;
    c.fillRect(10, 10, 492, 6);
    c.fillRect(10, 386, 492, 3);
    c.font = "bold 58px MiSans";
    c.fillText("RHINE LAB", 14, 78);
    c.font = "22px MiSans";
    c.fillStyle = "#86837a";
    c.fillText("MUSIC ARCHIVE", 17, 112);
    c.fillStyle = ink;
    c.font = "bold 96px MiSans";
    c.fillText("NO." + String(index + 1).padStart(3, "0"), 10, 238);
    c.fillRect(354, 30, 146, 36);
    c.fillStyle = "#eee9de";
    c.font = "bold 22px MiSans";
    c.textAlign = "center";
    c.fillText(format.slice(0, 8), 427, 56);
    c.textAlign = "left";
    c.fillStyle = ink;
    c.font = "24px MiSans";
    c.fillText(tracks ? `${tracks} ${tracks === 1 ? "TRACK" : "TRACKS"}` : "COVER ONLY", 16, 360);
    c.drawImage(this.labelMark, 356, 290, 140, 65);
    this.labelTexture!.needsUpdate = true;
  }
  resize() {
    this.pacing.invalidate();
    const w = this.container.clientWidth,
      h = this.container.clientHeight;
    const kind = this.container.closest<HTMLElement>("[data-layout]")?.dataset.layout ?? "";
    const displayHeight = this.container.getBoundingClientRect().height;
    if (this.layoutKind === "cinematic" && kind !== "cinematic" && this.displayHeight > 0) {
      // Removing letterboxing starts from the same apparent model size. The
      // existing camera interpolation then carries it to the responsive anchor.
      this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(
        Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * displayHeight / this.displayHeight,
      ));
    }
    this.displayHeight = displayHeight;
    this.layoutKind = kind;
    const dimensions = resizeQuality(
      this.renderer,
      this.composer,
      this.container,
      this.quality,
      this.smaa,
      false,
      this.scene,
    );
    this.ao.setSize(
      Math.max(1, Math.floor(dimensions.width * this.quality.aoResolution)),
      Math.max(1, Math.floor(dimensions.height * this.quality.aoResolution)),
    );
    // three's SSAOPass copies the camera projection only when it is sized, so
    // its shading follows the last real resize. Restoring a hidden window
    // keeps that copy instead of taking a new one.
    const ssao = this.ao.ssaoMaterial.uniforms;
    if (this.restoringBuffers) {
      ssao.cameraProjectionMatrix.value.copy(this.aoProjection.projection);
      ssao.cameraInverseProjectionMatrix.value.copy(this.aoProjection.inverse);
    } else {
      this.aoProjection.projection.copy(ssao.cameraProjectionMatrix.value);
      this.aoProjection.inverse.copy(ssao.cameraInverseProjectionMatrix.value);
    }
    this.container.dataset.renderQuality = JSON.stringify({
      ...JSON.parse(this.container.dataset.renderQuality!),
      aoSamples: this.ao.enabled ? this.aoKernelSize : 0,
      aoWidth: this.ao.width,
      aoHeight: this.ao.height,
      shadows: this.renderer.shadowMap.enabled
        ? this.light.shadow.mapSize.x
        : 0,
      depthOfField: this.bokeh.enabled ? this.quality.depthOfField : 0,
    });
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  private bindPointer() {
    const canvas = this.renderer.domElement;
    // Pointer input moves the camera (parallax) or turns the model: update at once.
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "pointerleave"] as const)
      canvas.addEventListener(type, () => this.pacing.wake());
    canvas.addEventListener("webglcontextrestored", () => this.pacing.invalidate());
    let startX = 0,
      startY = 0;
    let activePointer: number | null = null, previousX = 0, started = 0, cancelled = false;
    const pointers = new Set<number>();
    canvas.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      pointers.add(e.pointerId);
      if (pointers.size > 1) { cancelled = true; this.dragging = false; return; }
      activePointer = e.pointerId;
      cancelled = false;
      previousX = e.clientX;
      started = performance.now();
      startX = e.clientX;
      startY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      if (this.canInspect) {
        this.dragging = true;
        canvas.setPointerCapture(e.pointerId);
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      if (activePointer !== null && e.pointerId !== activePointer) return;
      if (cancelled) return;
      const r = canvas.getBoundingClientRect();
      if (e.pointerType === "mouse") this.pointer.set(
        (e.clientX - r.left) / r.width - 0.5,
        (e.clientY - r.top) / r.height - 0.5,
      );
      if (this.dragging) {
        if (!this.canInspect) {
          this.dragging = false;
          return;
        }
        this.targetRotation = THREE.MathUtils.clamp(
          this.targetRotation + (e.clientX - previousX) * 0.004,
          -0.8,
          0.8,
        );
        previousX = e.clientX;
        return;
      }
      if (e.pointerType !== "mouse") return;
      if (this.reveal < 0.8 || !this.canPick || !this.loaded || !records.length) return;
      this.cursor.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        (-(e.clientY - r.top) / r.height) * 2 + 1,
      );
      const hit = this.pickCase();
      canvas.style.cursor = hit ? "pointer" : "default";
      this.onHover?.(hit ? hit.file : null);
    });
    canvas.addEventListener("pointerup", (e) => {
      pointers.delete(e.pointerId);
      if (e.pointerId !== activePointer) return;
      activePointer = null;
      this.dragging = false;
      if (cancelled) return;
      if (e.pointerType !== "mouse" && this.detail < 0.2 && this.reveal >= 0.8 && this.loaded) {
        const swipe = swipeDirection(e.clientX - startX, e.clientY - startY, performance.now() - started);
        if (swipe) { this.onNavigate?.(swipe.axis, swipe.direction); return; }
      }
      if (
        Math.hypot(e.clientX - startX, e.clientY - startY) > 6 ||
        !this.canPick ||
        this.reveal < 0.8 ||
        !this.loaded
        || !records.length
      )
        return;
      const r = canvas.getBoundingClientRect();
      this.cursor.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        (-(e.clientY - r.top) / r.height) * 2 + 1,
      );
      const hit = this.pickCase();
      if (hit) this.onSelect?.(hit.file, hit.cell, hit.lifted);
    });
    canvas.addEventListener("pointercancel", (e) => {
      pointers.delete(e.pointerId);
      if (e.pointerId === activePointer) { activePointer = null; cancelled = true; this.dragging = false; }
    });
    canvas.addEventListener("lostpointercapture", (e) => {
      pointers.delete(e.pointerId);
      if (e.pointerId === activePointer) { activePointer = null; this.dragging = false; }
    });
    canvas.addEventListener("pointerleave", () => {
      this.pointer.set(0, 0);
      this.onHover?.(null);
    });
  }
  update(
    time: number,
    cinematic?: { reveal: number; lift: number; zoom: number; time: number; musicIntro?: boolean },
  ) {
    this.clock = time;
    // A resting scene waits for its ~60 Hz slot; dt then spans the skipped frames.
    if (!this.pacing.due(time, Boolean(cinematic))) return;
    const dt = Math.min(time - this.last || 0.016, 0.05);
    this.last = time;
    if (!this.loaded) return;
    // Transitions change material colors, which the frame description omits.
    const themeChanging = Boolean(this.themeTransition);
    if (this.themeTransition) {
      if (this.themeTransition.update(time)) this.themeTransition = undefined;
      this.syncThemeStars();
    }
    const previewLift = musicLibrary ? MUSIC_PREVIEW_LIFT : 0.4;
    const blend = 1 - Math.exp(-dt * (this.reduced ? 35 : 2.8));
    this.reveal = cinematic
      ? cinematic.reveal
      : THREE.MathUtils.lerp(this.reveal, this.targetReveal, blend);
    const inspecting = this.targetDetail && (!musicLibrary || this.musicPresentation.placed);
    const aligningSelection = musicLibrary && this.musicNavigationLift && this.returnY !== null;
    this.rotation = this.reduced
      ? inspecting ? this.targetRotation : 0
      // The song scene has no turned card: a turn left from the detail returns at once.
      : inspecting && !aligningSelection && !this.songTarget
        ? THREE.MathUtils.lerp(this.rotation, this.targetRotation, blend)
        : returnStep(this.rotation, dt, this.reduced);
    if (musicLibrary && !cinematic) {
      this.musicPresentation.returnWhenAligned(this.rotation === 0);
      this.targetDetail = Number(this.musicPresentation.holdsDetail);
    }
    const presentationProgress = musicLibrary && !cinematic
      ? THREE.MathUtils.clamp(this.musicPlacement.update(this.targetDetail, dt, this.reduced), 0, 1)
      : 0;
    const songProgress = this.songProgress = musicLibrary && !cinematic
      ? THREE.MathUtils.clamp(this.song.update(this.songTarget, dt, this.reduced), 0, 1)
      : 0;
    const songView = songProgress > 0
      ? songFraming(this.container.clientWidth, this.container.clientHeight, SONG_VIEW.span)
      : undefined;
    // The sunken shelf lies below the picture: tall windows show more of the world below the card.
    this.songDrop = songView ? songShelfDrop((1 - songView.y) * songView.span) : SONG_SHELF_DROP;
    // ... and the chain runs on until it has left the picture on the left.
    const songWidth = songView ? this.container.clientWidth / this.container.clientHeight * songView.span : 0;
    this.songCards = songView
      ? songChainCards(songView.x * songWidth, (0.5 - songView.x) * songWidth, SONG_VIEW.distance)
      : SONG_CHAIN_CARDS;
    // ... and on the other side until it has left the picture at the bottom.
    this.songFirst = songView ? songChainFirst((1 - songView.y) * songView.span) : SONG_CHAIN_FIRST;
    const musicIntro = Boolean(musicLibrary && cinematic?.musicIntro);
    // Music stops before the film's second extraction/inspection shot. The
    // last 400 ms hold the exact interactive pose instead of cutting to it.
    const shot = musicIntro ? Math.min(cinematic!.time, 27.12) : cinematic?.time ?? 29.1;
    const introSettle = musicIntro ? ease((shot - 25.3) / 1.42) : 0;
    if (cinematic) {
      this.scanTime = shot;
      this.scanBlend = 1;
    } else {
      this.scanTime += dt;
      this.scanBlend *= Math.exp(-dt * 3);
    }
    if (this.looping && !cinematic) this.rebaseCoordinates();
    const chosen = this.cellPosition(this.selectedCell);
    const selectedRow = this.selectedCell.row;
    const selectedLane = this.selectedCell.lane;
    const navigationLift = musicLibrary && !cinematic && this.musicNavigationLift;
    // Independent lift ownership survives an interrupted return; fast motion
    // belongs only to detail navigation, never to the returning/archive phases.
    const detailNavigation = navigationLift && this.musicPresentation.placed;
    damp(this.shoulder, selectedRow, this.reduced ? 35 : detailNavigation ? MUSIC_ALBUM_SWITCH_RATE : 5, dt);
    damp(this.laneFocus, selectedLane, this.reduced ? 35 : detailNavigation ? MUSIC_ALBUM_SWITCH_RATE : 4, dt);
    damp(this.columnCamera, chosen.x, this.reduced ? 35 : detailNavigation ? MUSIC_ALBUM_SWITCH_RATE : 3.7, dt);
    damp(
      this.rail,
      cinematic ? 0 : -2.17 - chosen.z,
      this.reduced ? 35 : detailNavigation ? MUSIC_ALBUM_SWITCH_RATE : 3.7,
      dt,
    );
    if (detailNavigation && this.reduced) {
      this.shoulder = { value: selectedRow, velocity: 0 };
      this.laneFocus = { value: selectedLane, velocity: 0 };
      this.columnCamera = { value: chosen.x, velocity: 0 };
      this.rail = { value: -2.17 - chosen.z, velocity: 0 };
    }
    if (cinematic) {
      this.rail.value = musicIntro ? -2.17 - chosen.z : 0;
      this.rail.velocity = 0;
      this.lift.value = musicIntro
        ? THREE.MathUtils.lerp(extraction(shot), previewLift, introSettle)
        : extraction(shot);
      this.lift.velocity = 0;
      this.shoulder.value = selectedRow;
      if (musicIntro) this.shoulder.velocity = 0;
      this.laneFocus.value = selectedLane;
      this.laneFocus.velocity = 0;
      this.columnCamera.value = chosen.x;
      this.columnCamera.velocity = 0;
    }
    // Keep the illuminated set near the origin. Lateral navigation is a track
    // movement of the whole array, just like the existing front/back rail.
    const trackX = cinematic && !musicIntro ? 0 : this.columnCamera.value;
    const center = {
      lane: this.columnCamera.value / COLUMN_SPACING + 2,
      row: (-this.rail.value - 2.17) / ROW_SPACING + 15.5,
    };
    const fixedPool = !musicIntro && (cinematic || !this.looping);
    for (let i = 0; i < this.positions.length; i++) {
      placeCell(this.cells[i], i, this.poolRows, fixedPool ? undefined : center);
      this.positions[i].set(
        (this.cells[i].lane - 2) * COLUMN_SPACING,
        -4.6,
        (this.cells[i].row - 15.5) * ROW_SPACING,
      );
    }
    this.pulses = this.pulses.filter((p) => time - p.time < 3.2);
    const aligningCopy = this.outgoing.some((o) => o.returnY !== null);
    const idle =
      !cinematic &&
      !this.reduced &&
      this.targetReveal > 0 &&
      !this.targetDetail &&
      this.detail < 0.01 &&
      this.returnY === null &&
      !aligningCopy &&
      time - this.lastInteraction > 2.5;
    this.idleGain = cinematic
      ? 0
      : THREE.MathUtils.lerp(
          this.idleGain,
          idle ? 1 : 0,
          1 - Math.exp(-dt * (idle ? 0.8 : 4)),
        );
    this.pulseGain = THREE.MathUtils.lerp(
      this.pulseGain,
      this.targetDetail || this.returnY !== null || aligningCopy ? 0 : 1,
      1 - Math.exp(-dt * 8),
    );
    // Lanes are integers and the focus is fixed within a frame: one bell per lane.
    const strengths = new Map<number, number>();
    const strength = (lane: number) => {
      let value = strengths.get(lane);
      if (value === undefined) strengths.set(lane, (value = columnStrength(lane, this.laneFocus.value)));
      return value;
    };
    // `played`: with the play gesture's waves. The selected case has its hop instead.
    const field = (row: number, lane: number, played = true) => {
      if (musicIntro) {
        // Recenter the authored wave on whichever album the library selected.
        // The same looping cells, resting shoulders and lane weights are used
        // on both sides of the handoff, so no rows pop or change altitude.
        const opening = cinematicField(row - selectedRow + 12, lane - selectedLane + 2, shot);
        const resting = settlingWave(row - selectedRow, 26.56) * columnStrength(lane, selectedLane);
        return THREE.MathUtils.lerp(opening, resting, introSettle);
      }
      if (cinematic)
        return cinematicField(
          row,
          lane,
          shot,
          this.shoulder.value,
          this.laneFocus.value,
        );
      let height =
        archiveWave(
          row + this.coordinateOrigin.row,
          lane + this.coordinateOrigin.lane,
          this.scanTime,
        ) *
          this.scanBlend;
      // Below 1e-5 the drift moves a card < 1e-6 units (~1e-4 px): skip its sines.
      if (this.idleGain > 1e-5)
        height +=
          idleWave(
            row + this.coordinateOrigin.row,
            lane + this.coordinateOrigin.lane,
            time,
          ) * this.idleGain;
      // No pulses means a zero ripple: identical without the loop.
      if (!cinematic && !this.reduced && this.pulses.length) {
        let ripple = 0, playRipple = 0;
        for (const p of this.pulses) {
          if (p.play && !played) continue;
          const distance = Math.hypot(row - p.row, (lane - p.lane) * 2.2);
          const age = time - p.time;
          const wave =
            (musicLibrary ? musicSelectionWave(distance, age) : this.selectionPulse(distance, age)) *
            (this.deferSelectionPulse ? rippleEnvelope(distance, age) : 1);
          if (p.play) playRipple += wave;
          else ripple += wave;
        }
        const limit = musicLibrary ? 0.24 : 0.6;
        // A selection's wave leaves an opened case's shelf alone; the play gesture's is meant
        // to be seen under it too.
        height += THREE.MathUtils.clamp(ripple, -limit, limit) * this.pulseGain + THREE.MathUtils.clamp(playRipple, -limit, limit);
      }
      const distance = row - this.shoulder.value;
      return height + settlingWave(distance, 26.56) * strength(lane);
    };
    const selectedBase = chosen.y + field(selectedRow, selectedLane, false);
    if (!cinematic) {
      if (this.returnY !== null && this.rotation !== 0) {
        this.lift.value = this.returnY - selectedBase;
        this.lift.velocity = 0;
      } else {
        this.returnY = null;
        if (navigationLift) {
          // Placement stays at one throughout a detail switch. Giving the new
          // box its own spring lets it rise from its slot while its predecessor
          // returns, and preserves its actual height if Escape interrupts it.
          const aligningNeighbor = this.outgoing.some((o) => o.returnY !== null &&
            o.cell.lane === selectedLane && Math.abs(o.cell.row - selectedRow) < 5);
          const liftTarget = this.musicPresentation.placed
            ? !this.reduced && aligningNeighbor ? 0 : MUSIC_INSPECTION_LIFT
            : previewLift * this.targetReveal;
          if (this.reduced) this.lift = { value: liftTarget, velocity: 0 };
          else damp(this.lift, liftTarget, detailNavigation ? MUSIC_ALBUM_SWITCH_RATE : 4.2, dt);
        } else if (musicLibrary && (presentationProgress > 0 || !this.musicPlacement.settled || this.targetDetail)) {
          // The same progress also controls yaw, elevation, zoom and pan below.
          // Browsing keeps its own lift spring for selection ripples and copies.
          const restingLift = previewLift * this.targetReveal;
          this.lift.value = THREE.MathUtils.lerp(restingLift, MUSIC_INSPECTION_LIFT, presentationProgress);
          this.lift.velocity = this.musicPlacement.value === presentationProgress
            ? (MUSIC_INSPECTION_LIFT - restingLift) * this.musicPlacement.velocity : 0;
        } else damp(
          this.lift,
          this.targetDetail
            ? INSPECTION_LIFT
            : this.outgoing.some(
                  (o) =>
                    o.returnY !== null &&
                    o.cell.lane === selectedLane &&
                    Math.abs(o.cell.row - selectedRow) < 5,
                )
              ? 0
              : previewLift * this.targetReveal,
          this.reduced
            ? 35
            : this.deferSelectionPulse &&
                !this.targetDetail &&
                this.lift.value < 0.4
              ? 7.6
              : 4.2,
          dt,
        );
      }
    }
    const cameraTarget = this.targetDetail
      ? ease((this.lift.value - 0.8) / 2.4)
      : this.returnY !== null
        ? this.detail
        : ease((this.lift.value - previewLift) / (INSPECTION_LIFT - previewLift));
    this.detail = cinematic
      ? musicIntro ? 0 : musicLibrary ? musicCinematicPose(shot).detail : cinematic.zoom
      : musicLibrary ? presentationProgress : THREE.MathUtils.lerp(this.detail, cameraTarget, blend);
    const detail = this.detail;
    // How far a column has come toward the lens (MUSIC_COLUMN_FORWARD): the selected one and
    // every one in front of it, gliding with the selected column's focus; on the shelf only.
    const forward = musicLibrary
      ? (cinematic ? (musicIntro ? introSettle : 0) : 1) * (1 - detail) * (1 - songProgress) * MUSIC_COLUMN_FORWARD
      : 0;
    const columnForward = (lane: number) => forward * THREE.MathUtils.smoothstep(this.laneFocus.value - lane + 1, 0, 1);
    this.decryption.update(dt, detail > .78 && this.lift.value > 3.3, this.reduced,
      cinematic ? shot + 5 : undefined);
    this.appearance.apply(this.model, ease(this.lift.value / 0.4));
    if (this.covers) this.appearance.setTint(this.model, this.covers.selectedTint);
    this.appearance.setClarity(this.model, this.decryption.clarity);
    // Reference 26.92–27.76: the array travels horizontally into a white field.
    const entry = cinematic ? ease((shot - 21.9) / 0.86) : this.reveal;
    const entranceTime = THREE.MathUtils.clamp((shot - 21.92) / 0.75, 0, 1);
    const entryZ = cinematic
      ? -23 * (1 - entranceTime) ** 2
      : -28 * (1 - entry);
    for (let i = this.outgoing.length - 1; i >= 0; i--) {
      const o = this.outgoing[i];
      const p = this.cellPosition(o.cell);
      const baseY = p.y + field(o.cell.row, o.cell.lane);
      o.yaw = detailNavigation && this.reduced ? 0 : returnStep(o.yaw, dt, this.reduced);
      if (detailNavigation && this.reduced) {
        o.returnY = null;
        o.lift = { value: 0, velocity: 0 };
      } else if (o.returnY !== null) {
        o.lift.value = o.returnY - baseY;
        o.lift.velocity = 0;
        if (o.yaw === 0) o.returnY = null;
      } else damp(o.lift, 0, this.reduced ? 35 : detailNavigation ? MUSIC_ALBUM_SWITCH_RATE : 4.5, dt);
      o.group.position.set(
        p.x - trackX,
        baseY + o.lift.value,
        p.z + entryZ + this.rail.value,
      );
      const quality = ease(o.lift.value / 0.4);
      this.appearance.apply(o.group, quality);
      o.clarity = this.reduced ? 0 : o.clarity * Math.exp(-dt * 9);
      this.appearance.setClarity(o.group, o.clarity);
      const { row, lane } = o.cell;
      o.group.rotation.set(
        (field(row + 0.5, lane) - field(row - 0.5, lane)) *
          0.024 *
          (1 - detail) *
          (1 - quality),
        o.yaw,
        0,
      );
      o.group.scale.setScalar(1);
      const copyHold = songLiftHold(o.lift.value, MUSIC_INSPECTION_LIFT);
      if (songProgress > 0) this.poseSongCase(o.group, baseY, songProgress, copyHold);
      // With its column toward the lens, after the song pose (which reads the case's own place).
      o.group.position.x -= columnForward(o.cell.lane);
      // The song scene's light: a copy stops being the large card as it sinks into the chain.
      this.appearance.setSongCard(o.group, 1 - copyHold);
      if (o.lift.value < 0.0001 && Math.abs(o.yaw) < 0.0001) {
        this.scene.remove(o.group);
        this.appearance.dispose(o.group);
        this.outgoing.splice(i, 1);
      }
    }
    if (
      this.pendingPulse &&
      !cinematic &&
      !this.targetDetail &&
      this.targetReveal
    ) {
      const selectedY = selectedBase + this.lift.value;
      const oldCardsLower = this.outgoing.every(
        (old) =>
          old.cell.lane !== selectedLane ||
          Math.abs(old.cell.row - selectedRow) > 4 ||
          old.group.position.y + 0.015 < selectedY,
      );
      // The new file causes the wave: finish most of its rise and let nearby
      // outgoing files get below it before starting the outward pulse.
      if (this.lift.value >= 0.35 && this.returnY === null && oldCardsLower) {
        if (!this.reduced) this.emitPulse(this.pendingPulse);
        this.pendingPulse = null;
      }
    }
    // Resolve returning copies before restoring their array instances, avoiding
    // a missing file for one frame at the ownership handoff.
    // The selected file and returning copies own their cells (a few at most).
    const owned = [this.selectedCell, ...this.outgoing.map((o) => o.cell)];
    const isOwned = (lane: number, row: number) => {
      for (const cell of owned) if (cell.lane === lane && cell.row === row) return true;
      return false;
    };
    const unused = musicLibrary ? 5 * this.poolRows : 160;
    let halfLane = NaN, halfRow = NaN, halfValue = 0;
    for (let i = 0; i < this.positions.length; i++) {
      const p = this.positions[i];
      const cell = this.cells[i], { row, lane } = cell;
      // Slots of a lane are consecutive rows: this row's -0.5 sample is the
      // previous row's +0.5 sample, so each slot evaluates the field twice.
      const below = lane === halfLane && row - 0.5 === halfRow ? halfValue : field(row - 0.5, lane);
      const above = field(row + 0.5, lane);
      halfLane = lane;
      halfRow = row + 0.5;
      halfValue = above;
      const slope = above - below;
      this.dummy.position.set(
        p.x - trackX,
        p.y + field(row, lane),
        p.z + entryZ + this.rail.value,
      );
      this.dummy.rotation.set(slope * 0.024 * (1 - detail), 0, 0);
      this.dummy.scale.setScalar(1);
      // In the song scene only the chain is left to draw; the sunken shelf is out of sight.
      const chained = songProgress > 0 ? this.poseSongCase(this.dummy, this.dummy.position.y, songProgress) : true;
      if (forward) this.dummy.position.x -= columnForward(lane);
      const hidden = isOwned(lane, row) || (fixedPool && i >= unused) || (songProgress === 1 && !chained);
      this.slotHidden[i] = hidden ? 1 : 0;
      if (!hidden) {
        this.dummy.updateMatrix();
        this.dummy.matrix.toArray(this.slotMatrices, i * 16);
      }
      if (musicLibrary && this.covers) this.covers.setSlot(i, records[fileAtCell(cell)]);
    }
    // The visible ones are packed into the instance buffer once the camera has settled.
    this.model.position.set(
      chosen.x - trackX,
      chosen.y + field(selectedRow, selectedLane, false) + this.lift.value,
      chosen.z + entryZ + this.rail.value,
    );
    // Extraction only changes elevation. Reframing belongs to the camera.
    this.model.rotation.set(
      (field(selectedRow + 0.5, selectedLane, false) -
        field(selectedRow - 0.5, selectedLane, false)) *
        0.024 *
        (1 - detail) *
        (1 - ease(this.lift.value / 0.4)),
      cinematic ? 0 : this.rotation,
      0,
    );
    this.modelYaw = this.model.rotation.y;
    this.model.scale.setScalar(1);
    const liftHold = songLiftHold(this.lift.value, MUSIC_INSPECTION_LIFT);
    if (songProgress > 0) this.poseSongCase(this.model, selectedBase, songProgress, liftHold);
    // With its column toward the lens, after the song pose (which reads the case's own place).
    this.model.position.x -= columnForward(selectedLane);
    // The play gesture's hop, in every view: the shelf's selection, the opened case, the large card.
    const hop = musicLibrary && !cinematic && !this.reduced ? playHop(time - this.playStarted) : 0;
    this.model.position.y += hop;
    this.songHopPixels = songView ? hop * this.container.clientHeight / songView.span * songProgress : 0;
    // ... and the lifted case becomes it as it leaves the chain. On the way out of the song
    // scene it lowers to the shelf as the selection it is: it never takes the chain's shade.
    this.appearance.setSongCard(this.model, this.songTarget ? 1 - liftHold : 1);
    this.floor.position.y = -4.63 - this.songDrop * songProgress;
    // Measured from frame 787: X edge (382,-204), adjacent row (78,38).
    // The label vertical edge constrains height; the file base is occluded.
    // Do not calibrate field of view from the visible fragment of a file.
    const orbit = ease((shot - 22.6) / 1.6);
    const settle = ease((shot - 24.25) / 2.25);
    const navigationOrbit = musicLibrary && !cinematic
      ? this.musicCamera.navigation(this.columnCamera.velocity / COLUMN_SPACING,
          this.rail.velocity / ROW_SPACING, detail, dt, this.reduced)
      : { yaw: 0, elevation: 0 };
    const yaw = THREE.MathUtils.degToRad(89 - 22 * orbit - 8 * settle) + navigationOrbit.yaw;
    const elevation = THREE.MathUtils.degToRad(
      3 + 40 * ease((shot - 21.96) / 0.22) - 8 * orbit - 16 * settle +
        (musicIntro ? 6 * introSettle : musicLibrary && !cinematic ? 6 : 0),
    ) + navigationOrbit.elevation;
    const span = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(10.8, 10.3, orbit),
      7.33,
      settle,
    );
    const distance = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(28 + 7 * orbit, 140, settle),
      72,
      detail,
    );
    const arrayAim = new THREE.Vector3(
      -1.091,
      THREE.MathUtils.lerp(-2.55 + 0.4 * orbit, -0.045, settle),
      THREE.MathUtils.lerp(2.48, 0.481, settle),
    );
    const cameraAim = arrayAim.clone();
    const viewDirection = new THREE.Vector3(
      -Math.sin(yaw) * Math.cos(elevation),
      Math.sin(elevation),
      Math.cos(yaw) * Math.cos(elevation),
    );
    if (cinematic) {
      const earlyTurn = ease((shot - 27.3) / 1.3);
      const finalTurn = ease((shot - 28.6) / 5.4);
      const musicPose = musicCinematicPose(shot, THREE.MathUtils.radToDeg(yaw), THREE.MathUtils.radToDeg(elevation));
      const shotYaw = musicLibrary ? THREE.MathUtils.degToRad(musicPose.yaw)
        : yaw - THREE.MathUtils.degToRad(9 * earlyTurn + 32 * finalTurn);
      const shotElevation = musicLibrary ? THREE.MathUtils.degToRad(musicPose.elevation)
        : elevation - THREE.MathUtils.degToRad(1.5 * earlyTurn + 3.7 * finalTurn);
      viewDirection.set(
        -Math.sin(shotYaw) * Math.cos(shotElevation),
        Math.sin(shotElevation),
        Math.cos(shotYaw) * Math.cos(shotElevation),
      );
    } else if (musicLibrary) {
      // The archive rests at 25° above the cover; inspection stays at 20°.
      // Both angles use the extraction progress, with no separate pan phase.
      const detailYaw = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(8, SONG_VIEW.yaw, songProgress));
      const inspectionYaw = THREE.MathUtils.lerp(yaw, detailYaw, detail);
      const inspectionElevation = THREE.MathUtils.lerp(elevation,
        THREE.MathUtils.lerp(MUSIC_DETAIL_ELEVATION, THREE.MathUtils.degToRad(SONG_VIEW.elevation), songProgress), detail);
      viewDirection.set(
        -Math.sin(inspectionYaw) * Math.cos(inspectionElevation),
        Math.sin(inspectionElevation),
        Math.cos(inspectionYaw) * Math.cos(inspectionElevation),
      );
    } else {
      viewDirection
        .lerp(new THREE.Vector3(-0.277, 0.238, 0.931), detail)
        .normalize();
    }
    if (cinematic) {
      const pan = ease((shot - 25.4) / 0.95);
      const right = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection)
        .normalize();
      cameraAim.addScaledVector(
        right,
        -2.05 * (1 - pan) * ease((shot - 24.2) / 0.8),
      );
    }
    if (cinematic && shot >= 25.05 && shot <= 27.3) {
      // Frames 760–785: the camera carries the same physical column from the
      // right into the selected position while the neighboring crests subside.
      const pan = ease((shot - 25.4) / 1.05);
      const right = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection)
        .normalize();
      const up = new THREE.Vector3()
        .crossVectors(viewDirection, right)
        .normalize();
      const pixelScale = 1080 / span;
      const anchorAim = this.model.position
        .clone()
        .add(musicLibrary
          ? new THREE.Vector3(-MUSIC_MODEL.width / 2, MUSIC_MODEL.center.y + MUSIC_MODEL.height / 2, 0)
          : new THREE.Vector3(-2.5, 3.7, 0));
      anchorAim.addScaledVector(
        right,
        -(THREE.MathUtils.lerp(840, 518, pan) - 960) / pixelScale,
      );
      anchorAim.addScaledVector(
        up,
        -(540 - THREE.MathUtils.lerp(340, 288, pan)) / pixelScale,
      );
      cameraAim.lerp(anchorAim, ease((shot - 25.05) / 0.35));
    }
    if (cinematic && shot > 27.3) {
      const close = ease((shot - 27.3) / 6.7);
      const extractionCamera = ease((shot - 27.3) / 1.25);
      const musicAnchor = musicLibrary ? musicExtractionAnchor(shot) : null;
      const screenX = musicAnchor?.x ?? THREE.MathUtils.lerp(
        518 - 98 * extractionCamera,
        618,
        close,
      );
      const screenY = musicAnchor?.y ?? THREE.MathUtils.lerp(
        296 + 34 * extractionCamera,
        287,
        close,
      );
      const pixelScale = 1080 / THREE.MathUtils.lerp(span, 5.9, detail);
      const right = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection)
        .normalize();
      const up = new THREE.Vector3()
        .crossVectors(viewDirection, right)
        .normalize();
      const anchorAim = this.model.position
        .clone()
        .add(musicLibrary
          ? new THREE.Vector3(-MUSIC_MODEL.width / 2, MUSIC_MODEL.center.y + MUSIC_MODEL.height / 2, 0)
          : new THREE.Vector3(-2.5, 3.7, 0));
      anchorAim.addScaledVector(right, -(screenX - 960) / pixelScale);
      anchorAim.addScaledVector(up, -(540 - screenY) / pixelScale);
      // The preceding shot already holds this corner. Starting again from the
      // array aim caused a visible camera jump at the extraction boundary.
      if (musicLibrary) cameraAim.copy(anchorAim);
      else cameraAim.lerp(anchorAim, ease((shot - 27.3) / 0.5));
      if (musicLibrary) {
        // The film ends face-on at the center. The menu placement is a later,
        // separately gated camera move, after this shot has actually settled.
        const centerAim = this.model.position.clone().add(new THREE.Vector3().copy(MUSIC_MODEL.center));
        cameraAim.lerp(centerAim, musicCinematicPose(shot).centered);
      }
    }
    const framing = archiveFraming(this.container.clientWidth, this.container.clientHeight, span, detail,
      this.container.closest<HTMLElement>("[data-layout]")?.dataset.layout === "compact");
    let viewSpan = framing.span;
    if (musicIntro) {
      // Keep the film's corner tracking early, then release it smoothly to
      // the existing browsing composition, including the portrait endpoint.
      const previewAim = arrayAim.clone();
      if (framing.portrait) {
        const right = new THREE.Vector3()
          .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection).normalize();
        const up = new THREE.Vector3().crossVectors(viewDirection, right).normalize();
        previewAim.set(0, -4.6 + settlingWave(0, 26.56) + 0.4 + 1.85, -2.17);
        previewAim.addScaledVector(up, (framing.previewY - 0.5) * framing.span);
      }
      cameraAim.lerp(previewAim, introSettle);
    }
    if (!cinematic) {
      const right = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection)
        .normalize();
      const up = new THREE.Vector3()
        .crossVectors(viewDirection, right)
        .normalize();
      const width = this.container.clientWidth, height = this.container.clientHeight;
      const pixelScale = height / framing.span;
      if (framing.portrait) {
        // Keep the preview camera independent of the live lift, wave and rail.
        // Following model.position here would visually cancel those motions.
        const previewAim = new THREE.Vector3(0, -4.6 + settlingWave(0, 26.56) + 0.4 + 1.85, -2.17);
        previewAim.addScaledVector(up, (framing.previewY - 0.5) * height / pixelScale);
        cameraAim.copy(previewAim);
      }
      // The array rail moves around a fixed inspection slot. Following the new
      // model position here would first chase its adjacent slot, then reverse
      // when that slot reaches the camera; following its lift cancels extraction.
      const detailAim = musicLibrary
        ? new THREE.Vector3(0, -4.6 + settlingWave(0, 26.56) + MUSIC_INSPECTION_LIFT + MUSIC_MODEL.center.y, -2.17)
        : this.model.position.clone().add(new THREE.Vector3(0, 1.85, 0));
      let detailX = musicLibrary ? framing.portrait ? 0.5 : 0.25 : framing.detailX;
      let detailY = framing.detailY, detailScale = pixelScale;
      if (songView) {
        // The song scene shows more of the world and moves the case to its card position.
        const song = songView;
        viewSpan = THREE.MathUtils.lerp(framing.span, song.span, songProgress);
        detailX = THREE.MathUtils.lerp(detailX, song.x, songProgress);
        detailY = THREE.MathUtils.lerp(detailY, song.y, songProgress);
        detailScale = height / viewSpan;
      }
      detailAim.addScaledVector(right, (0.5 - detailX) * width / detailScale);
      detailAim.addScaledVector(up, (detailY - 0.5) * height / detailScale);
      cameraAim.lerp(detailAim, detail);
    }
    const cameraPosition = cameraAim
      .clone()
      .addScaledVector(viewDirection, distance);
    if (!cinematic && !this.reduced && (!musicLibrary || !this.musicPresentation.holdsDetail)) {
      cameraPosition.x += this.pointer.x * 0.12;
      cameraPosition.y -= this.pointer.y * 0.12;
    }
    if (musicLibrary && !cinematic) {
      this.musicCamera.update(this.camera, this.cameraAim, cameraPosition, cameraAim,
        viewSpan, dt, this.reduced);
      const detailTarget = this.musicPresentation.holdsDetail ? 1 : 0;
      const liftTarget = this.musicPresentation.holdsDetail ? MUSIC_INSPECTION_LIFT : previewLift * this.targetReveal;
      const tracksSettled = musicArchiveTracksSettled(
        { rail: this.rail, column: this.columnCamera, shoulder: this.shoulder, lane: this.laneFocus },
        { rail: -2.17 - chosen.z, column: chosen.x, shoulder: selectedRow, lane: selectedLane });
      this.musicPresentation.update(dt,
        this.musicCamera.isSettled(this.camera, this.cameraAim, cameraPosition, cameraAim, viewSpan),
        this.musicPlacement.settled && this.song.settled && tracksSettled && Math.abs(this.detail - detailTarget) < 0.001 && Math.abs(this.lift.value - liftTarget) < 0.008 &&
          Math.abs(this.rotation) < 0.001 && Math.abs(this.lift.velocity) < 0.025,
        this.reduced);
      this.targetDetail = Number(this.musicPresentation.holdsDetail);
      if (this.musicPresentation.phase === "archive") this.musicNavigationLift = false;
    } else {
      const cameraBlend = cinematic ? 1 : 1 - Math.exp(-dt * 5);
      this.camera.position.lerp(cameraPosition, cameraBlend);
      this.cameraAim.lerp(cameraAim, cameraBlend);
      this.camera.lookAt(this.cameraAim);
      this.camera.fov = THREE.MathUtils.lerp(
        this.camera.fov,
        THREE.MathUtils.radToDeg(
          2 * Math.atan((cinematic && !musicIntro ? THREE.MathUtils.lerp(span, 5.9, detail) : framing.span) / (2 * distance)),
        ),
        cameraBlend,
      );
      if (musicLibrary) this.musicCamera.observe(this.camera, this.cameraAim, dt);
    }
    const fog = this.scene.fog as THREE.Fog;
    // The camera position is damped after its target distance changes. Anchor
    // fog to the rendered camera, or entry puts the array behind the far plane
    // until the camera catches up (a brief white wash that exit never showed).
    const renderedDistance = this.camera.position.distanceTo(this.cameraAim);
    fog.near = renderedDistance + THREE.MathUtils.lerp(5, -1, detail);
    fog.far = renderedDistance + THREE.MathUtils.lerp(25, 12, detail);
    if (this.stars?.visible) {
      const depth = renderedDistance + 38;
      this.stars.position.copy(this.camera.position).addScaledVector(this.camera.getWorldDirection(new THREE.Vector3()), depth);
      this.stars.quaternion.copy(this.camera.quaternion);
      const halfHeight = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * depth;
      this.stars.scale.set(halfHeight * this.camera.aspect, halfHeight, 1);
    }

    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.compactInstances();
    let neighborTop = -Infinity;
    const boxTop = musicLibrary ? MUSIC_MODEL.center.y + MUSIC_MODEL.height / 2 : 3.76;
    const boxBottom = musicLibrary ? MUSIC_MODEL.center.y - MUSIC_MODEL.height / 2 : 0;
    const lane = selectedLane,
      row = selectedRow;
    for (let r = row - 5; r <= row + 5; r++) {
      if (r !== row)
        neighborTop = Math.max(neighborTop, -4.6 + field(r, lane) + boxTop);
    }
    for (const o of this.outgoing) {
      if (o.cell.lane === lane && Math.abs(o.cell.row - row) <= 5) {
        neighborTop = Math.max(neighborTop, o.group.position.y + boxTop);
      }
    }
    this.clearance = this.model.position.y + boxBottom - neighborTop;
    this.canInspect =
      !cinematic &&
      (!musicLibrary || this.musicPresentation.phase === "presented") &&
      Boolean(this.targetDetail) &&
      !this.songTarget && songProgress === 0 &&
      detail > 0.9 &&
      this.pulseGain < 0.01 &&
      this.clearance > (musicLibrary ? 0.05 : 0.3);
    this.container.dataset.inspection =
      this.returnY !== null
        ? "aligning"
        : this.canInspect
          ? "ready"
          : this.targetDetail
            ? "lifting"
            : "preview";
    // The lens emphasises the selection in the music views (see MUSIC_LENS). On the settled
    // shelf the defocus is measured on the shelf from the selected case, so the rows around
    // it soften one by one; in the song scene the chain of covers stands behind the large
    // card and is out of focus, more with every place. The selected case stays sharp from
    // edge to edge in both. The opening film, the opened album and the original archive
    // keep the lens they had.
    const lens = musicLibrary
      ? musicLens((musicIntro ? introSettle : 1) * (1 - detail), detail, songProgress)
      : { aperture: THREE.MathUtils.lerp(MUSIC_LENS.archive.shelf, MUSIC_LENS.archive.detail, detail), range: 0, lean: 0 };
    // The shelf focus follows the light column (the selection on a spring), so a new
    // selection pulls the focus over instead of cutting to it; the song scene focuses on the
    // large card's fixed place, where a newly selected case arrives only after its rise.
    const focalPoint = this.model.position.clone();
    if (lens.lean > 0 && this.selectionLighting) focalPoint.lerp(this.selectionLighting.columnPosition, lens.lean);
    focalPoint.y += 2;
    if (songProgress > 0) focalPoint.lerp((this.songBasis ??= this.createSongBasis()).origin, songProgress);
    focalPoint.applyMatrix4(this.camera.matrixWorldInverse);
    const bokehUniforms = this.bokeh.uniforms as Record<string, THREE.IUniform>;
    bokehUniforms.focus.value = -focalPoint.z;
    bokehUniforms.aperture.value = (lens.aperture * this.quality.depthOfField) / 100;
    bokehUniforms.focalRange.value = lens.range;
    bokehUniforms.focalLean.value = lens.lean;
    this.bokeh.exactDepth = lens.lean > 0;
    if (lens.lean > 0) {
      const slope = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
      (bokehUniforms.focalSlope.value as THREE.Vector2).set(slope * this.camera.aspect, slope);
      (bokehUniforms.focalPoint.value as THREE.Vector3).copy(focalPoint);
      // Rows run along world Z, lanes along world X.
      (bokehUniforms.focalRow.value as THREE.Vector3).set(0, 0, 1).transformDirection(this.camera.matrixWorldInverse);
      (bokehUniforms.focalLane.value as THREE.Vector3).set(1, 0, 0).transformDirection(this.camera.matrixWorldInverse)
        .multiplyScalar(MUSIC_LENS.shelf.lane);
    }
    // The shelf emphasis belongs to the browsing view: it forms as the opening
    // settles on its album and leaves as a case is opened.
    this.selectionLighting?.update(this.model, this.camera, dt, musicLibrary && records.length > 0 && this.model.visible, this.reduced, Boolean(cinematic),
      (musicIntro ? introSettle : 1) * (1 - detail),
      // The shelf slides under the light: the emphasis thins with the speed rows pass it.
      -this.columnCamera.velocity, this.rail.velocity,
      // The song scene has its own: the large card keeps the rim, the chain lies in shade.
      songProgress);
    const cameraStill = this.describeFrame();
    // Only the slow idle drift moves: about 0.2 px per 60 Hz frame.
    const phase = this.decryption.frame.phase;
    const resting = idle && cameraStill && !this.pulses.length && !this.outgoing.length &&
      !this.pendingPulse && !themeChanging && (phase === "waiting" || phase === "clear") &&
      time - this.playStarted >= PLAY_GESTURE.time;
    const draw = Boolean(cinematic) || themeChanging || this.pacing.needsDraw();
    if (draw) {
      this.renderer.info.reset();
      // AO normals and bokeh depth render this scene again without moving it.
      // Music frames share the first pass's shadows; the archive reference keeps
      // Three's original automatic updates. Animated casters still update each frame.
      this.renderer.shadowMap.autoUpdate = !musicLibrary;
      if (musicLibrary && this.renderer.shadowMap.enabled)
        this.renderer.shadowMap.needsUpdate = true;
      this.composer.render();
      // Where the lifted case was drawn, for the overlay's marks on the shelf (read only).
      this.liftedBox = musicLibrary && !cinematic && this.model.visible && records.length > 0 &&
        detail < 0.001 && songProgress < 0.001 ? this.measureLiftedCase() : null;
    }
    // The columns' names belong to the browsing view, like the shelf emphasis: they fade where
    // they stand as an album or the song scene opens, and in with the opening film's end. They
    // are written last, after everything in this frame that reads the page's layout (the size of
    // the picture, the lifted case's box), so none of those reads waits for their new styles.
    this.placeLaneLabels(center.lane,
      musicLibrary && !cinematic || musicIntro ? (musicIntro ? introSettle : 1) * (1 - detail) * (1 - songProgress) : 0);
    this.pacing.finish(time, draw, resting);
  }

  /**
   * Describe everything an update can change that decides the picture; equal
   * descriptions draw identical frames (FramePacing). Mutators and theme
   * transitions, which change materials directly, request their own draw.
   * Returns whether the camera is where it was last drawn.
   */
  /**
   * Pack the shelf instances whose case (with a margin for the shadows it casts) meets
   * the camera's view to the front of the instance buffer, and draw only those. Every
   * pass that draws the shelf (main, transmission, AO normals, shadows) shares this
   * buffer, so off-screen cases cost no vertex work at all. Cover prints follow the
   * same order; picking maps instance ids back through instanceSlots.
   */
  /**
   * Write the columns' names over the picture (lane-labels.ts, lane-names.ts): each at its
   * slot, the place its role has on the screen when the shelf rests (the selected column's
   * across the case in front of the lifted one, the nearer column's across its own, the further
   * column's along its edge). A name's place depends on nothing but how far its column is from
   * the shelf's sideways track (`centre`, a fractional lane): the waves, the lifted cases, the
   * play gesture, the idle drift and a step along a column move none of them. `shown` is how
   * much of the browsing view is on screen; the names fade where they stand.
   */
  private placeLaneLabels(centre: number, shown: number) {
    const names = this.laneNames;
    const visible = names && shown > 0.001 && archiveColumns.length > 0;
    const layer = visible ? this.laneNameLayer ??= this.createLaneNameLayer() : this.laneNameLayer;
    if (!layer) return;
    layer.begin();
    if (visible && names) {
      // The track's spring never quite stops: within a hundred-thousandth of a column of its
      // column (well under a hundredth of a pixel) the names stand exactly at their slots.
      const nearest = Math.round(centre);
      if (Math.abs(centre - nearest) < 1e-5) centre = nearest;
      const width = this.container.clientWidth, height = this.container.clientHeight;
      this.syncLaneSlotView(width, height);
      // Portrait: the title and navigation lie over the columns nearer the lens, and the
      // navigation over the top right, where names leave past the further column.
      const textBelow = isPortraitViewport(width, height);
      const { first, last } = laneLabelRange(centre);
      for (let lane = first; lane <= last; lane++) {
        const column = wrap(lane, archiveColumns.length), name = names[column];
        if (!name) continue;
        const offset = lane - centre;
        // A single column repeats in every lane: its name is given once, where the selection
        // is, and fades from one lane to the next while the shelf slides sideways.
        const lone = archiveColumns.length === 1 ? Math.max(0, 1 - 2 * Math.abs(offset)) : 1;
        // The column the shelf is centred on is written in full; its neighbours lighter.
        const weight = 0.92 + 0.08 * (1 - Math.min(1, Math.abs(offset)));
        const share = laneLabelShare(offset, textBelow) * shown * lone * weight;
        if (share <= 0.001) continue;
        const writing = layer.writing(column, name);
        const pose = laneLabelPose(offset, this.laneLabelSlots(writing.width), textBelow);
        // The same lane keeps its names when the shelf's coordinates are rebased.
        const key = lane + this.coordinateOrigin.lane;
        if (pose.across.share * share > 0.001) layer.show(`${key}:across`, writing, pose.across, pose.across.share * share);
        if (pose.along.share * share > 0.001) layer.show(`${key}:along`, writing, pose.along, pose.along.share * share);
      }
    }
    layer.end();
  }
  private createLaneNameLayer() {
    const layer = new LaneNameLayer(this.container);
    // MiSans arriving changes how long a name is and where its baseline sits.
    document.fonts?.addEventListener("loadingdone", () => {
      layer.refresh();
      this.pacing.invalidate();
    });
    return layer;
  }
  /**
   * The view the names' slots are worked out for: the window's size, its layout and the fonts.
   * Only a change of these places the shelf's camera at rest again and drops the slots.
   */
  private syncLaneSlotView(width: number, height: number) {
    const compact = this.container.closest<HTMLElement>("[data-layout]")?.dataset.layout === "compact";
    const view = `${width}x${height}:${compact}:${this.laneNameLayer?.fonts ?? 0}`;
    if (view === this.laneSlotView) return;
    this.laneSlotView = view;
    this.laneSlots.clear();
    this.shelfRestCamera(this.restCamera, compact);
  }
  /**
   * The names' slots for a name `width` world units long (lane-labels.ts LaneLabelSlots): the
   * places the names stood on the shelf at rest, seen with the shelf's camera at rest. Worked
   * out once per length for the view (syncLaneSlotView).
   */
  private laneLabelSlots(width: number) {
    let slots = this.laneSlots.get(width);
    if (slots) return slots;
    const camera = this.restCamera, probe = this.restProbe;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    // The shelf at rest around the selected column (lane 0): every column where it stands, the
    // selected one and those in front come toward the lens, the selected row's shoulder, the
    // lifted case at the resting lift.
    const ahead = (lane: number) => MUSIC_COLUMN_FORWARD * THREE.MathUtils.smoothstep(1 - lane, 0, 1);
    const caseTop = MUSIC_MODEL.center.y + MUSIC_MODEL.height / 2;
    const depth = (row: number) => -2.17 + row * ROW_SPACING;
    const graze = 1 - LANE_LABEL.liftGraze / MUSIC_PREVIEW_LIFT;
    const rest = laneLabelRest({
      eye: camera.position, depth, width: MUSIC_MODEL.width, rowSpacing: ROW_SPACING,
      top: (lane, row) => -4.6 + settlingWave(row, 26.56) * columnStrength(lane, 0) + caseTop + LANE_LABEL.rise,
      gap: (lane) => COLUMN_SPACING - ahead(lane) + ahead(lane - 1) - MUSIC_MODEL.width - LANE_LABEL.stand,
      lifted: (lane) => lane === 0 ? MUSIC_PREVIEW_LIFT * graze : 0,
      edge: (lane) => lane * COLUMN_SPACING - ahead(lane) - MUSIC_MODEL.width / 2,
      face: (row) => depth(row) + MUSIC_MODEL.depth / 2 + LANE_LABEL.faceGap,
      ceiling: (x, z) => this.ceiling(x, z, LANE_LABEL.margin, camera),
    }, width);
    const project = (x: number, y: number, z: number) => {
      const p = probe.set(x, y, z).project(camera);
      return { x: (p.x + 1) * w / 2, y: (1 - p.y) * h / 2 };
    };
    slots = {
      selected: laneLabelSlot(rest.selected, 0, project), nearer: laneLabelSlot(rest.nearer, 0, project),
      turning: laneLabelSlot(rest.turning, 1, project), further: laneLabelSlot(rest.further, 1, project),
    };
    this.laneSlots.set(width, slots);
    return slots;
  }
  /**
   * The shelf's camera at rest, for this window: where the music camera settles on the shelf
   * (update: the opening's orbit and settle complete, no album or song scene open, no pointer
   * parallax and no orbit from a sliding shelf). The camera stands still while the shelf
   * slides under it, so this is the camera of every resting shelf, whichever case is selected.
   */
  private shelfRestCamera(camera: THREE.PerspectiveCamera, compact: boolean) {
    const width = this.container.clientWidth, height = this.container.clientHeight;
    const framing = archiveFraming(width, height, SHELF_REST.span, 0, compact);
    const yaw = THREE.MathUtils.degToRad(SHELF_REST.yaw), elevation = THREE.MathUtils.degToRad(SHELF_REST.elevation);
    const direction = new THREE.Vector3(-Math.sin(yaw) * Math.cos(elevation), Math.sin(elevation), Math.cos(yaw) * Math.cos(elevation));
    const aim = new THREE.Vector3(...SHELF_REST.aim);
    if (framing.portrait) {
      const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), direction).normalize();
      const up = new THREE.Vector3().crossVectors(direction, right).normalize();
      aim.set(0, -4.6 + settlingWave(0, 26.56) + 0.4 + 1.85, -2.17).addScaledVector(up, (framing.previewY - 0.5) * framing.span);
    }
    camera.position.copy(aim).addScaledVector(direction, SHELF_REST.distance);
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(framing.span / (2 * SHELF_REST.distance)));
    camera.aspect = width / Math.max(1, height);
    camera.near = this.camera.near;
    camera.far = this.camera.far;
    camera.lookAt(aim);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }
  /** The highest a point at (x, z) can stand and still be `margin` CSS px below the top of the picture (seen with `camera`). */
  private ceiling(x: number, z: number, margin: number, camera: THREE.Camera) {
    const height = this.container.clientHeight;
    const at = (y: number) => (1 - this.restProbe.set(x, y, z).project(camera).y) / 2 * height;
    const ground = at(0), perUnit = at(1) - ground;
    return perUnit < 0 ? (margin - ground) / perUnit : Infinity;
  }
  /** Cases of the shelf and of the chain can be picked; an opened album's shelf cannot. */
  private get canPick() {
    return this.detail <= 0.2 || (this.songTarget === 1 && this.songProgress === 1);
  }
  /**
   * Song scene: carry a case from its shelf pose, already set on `object`, towards its place
   * in the chain of covers, or down with the rest of the shelf. `baseY` is its slot's height;
   * `hold` is how much of that displacement a lifted case still carries (it sheds it as it
   * rises). Returns whether the case is part of the chain that reaches into the picture.
   */
  private poseSongCase(object: THREE.Object3D, baseY: number, progress: number, hold = 1) {
    const { x, z } = object.position;
    const u = songChainIndex(z + 2.17);
    const weight = songChainWeight(u, this.songFirst) * songLaneWeight(songLaneOffset(x));
    const chain = weight * progress;
    if (chain <= 0) {
      object.position.y += songSlotRise(baseY, baseY, this.songDrop, 0, progress) * hold;
      return false;
    }
    const basis = this.songBasis ??= this.createSongBasis();
    const pose = songChainPose(u), card = this.songCard;
    card.quaternion.copy(basis.quaternion).multiply(card.local.setFromEuler(card.euler.set(
      THREE.MathUtils.degToRad(pose.pitch), THREE.MathUtils.degToRad(pose.yaw), THREE.MathUtils.degToRad(pose.roll), "ZYX")));
    // The pose places the middle of the top edge; a case's origin is the middle of its base.
    card.position.set(0, -SONG_CARD_TOP * pose.scale, 0).applyQuaternion(card.quaternion)
      .add(basis.origin).addScaledVector(basis.right, pose.x).addScaledVector(basis.up, pose.y)
      .addScaledVector(basis.forward, pose.z);
    const share = chain * hold;
    object.position.set(
      x + (card.position.x - x) * share,
      object.position.y + songSlotRise(baseY, card.position.y, this.songDrop, weight, progress) * hold,
      z + (card.position.z - z) * share,
    );
    // The chain takes its place from the song camera, not from the shelf's height: the play
    // gesture's wave runs along it, from the lifted case's own slot out, by rows.
    const ripple = this.chainRipple(Math.abs(u - SONG_CHAIN_CENTRE));
    if (ripple) object.position.addScaledVector(basis.up, ripple * share);
    object.quaternion.slerp(card.quaternion, share);
    object.scale.setScalar(1 + (pose.scale - 1) * share);
    return u <= this.songCards + 0.5;
  }
  /** The play gesture's wave on the chain, `rows` from the lifted case's own slot. */
  private chainRipple(rows: number) {
    if (this.reduced) return 0;
    let played = 0;
    for (const p of this.pulses) if (p.play) played += musicSelectionWave(rows, this.clock - p.time);
    return THREE.MathUtils.clamp(played, -0.24, 0.24);
  }
  /** The song camera's axes and the large card's centre: where the chain is laid out. */
  private createSongBasis() {
    const yaw = THREE.MathUtils.degToRad(SONG_VIEW.yaw), elevation = THREE.MathUtils.degToRad(SONG_VIEW.elevation);
    const forward = new THREE.Vector3(-Math.sin(yaw) * Math.cos(elevation), Math.sin(elevation), Math.cos(yaw) * Math.cos(elevation));
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), forward).normalize();
    const up = new THREE.Vector3().crossVectors(forward, right).normalize();
    return {
      origin: new THREE.Vector3(0, -4.6 + settlingWave(0, 26.56) + MUSIC_INSPECTION_LIFT + MUSIC_MODEL.center.y, -2.17),
      right, up, forward,
      quaternion: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, forward)),
    };
  }
  private compactInstances() {
    if (!this.instanceMatrices) return;
    this.cullMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.cullFrustum.setFromProjectionMatrix(this.cullMatrix);
    const source = this.slotMatrices, target = this.instanceMatrices.array as Float32Array;
    const centreY = musicLibrary ? MUSIC_MODEL.center.y : 1.85;
    const centre = this.cullSphere.center;
    let count = 0;
    for (let slot = 0; slot < this.positions.length; slot++) {
      if (this.slotHidden[slot]) continue;
      const o = slot * 16;
      // The case centre: the slot origin plus its (barely tilted) up axis.
      centre.set(
        source[o + 12] + source[o + 4] * centreY,
        source[o + 13] + source[o + 5] * centreY,
        source[o + 14] + source[o + 6] * centreY,
      );
      if (!this.cullFrustum.intersectsSphere(this.cullSphere)) continue;
      // Element copy: a subarray view per instance would allocate every frame.
      const t = count * 16;
      for (let k = 0; k < 16; k++) target[t + k] = source[o + k];
      this.instanceSlots[count++] = slot;
    }
    this.visibleInstances = count;
    for (const inst of this.instances) inst.count = count;
    if (this.covers) {
      this.covers.array.count = count;
      this.covers.order(this.instanceSlots, count);
    }
    this.instanceMatrices.clearUpdateRanges();
    this.instanceMatrices.addUpdateRange(0, count * 16);
    this.instanceMatrices.needsUpdate = true;
  }
  /** The pool slot an instance id of the shelf meshes was drawn for. */
  private slotOfInstance(instanceId: number) {
    return this.instanceSlots[instanceId];
  }
  private describeFrame() {
    const p = this.pacing;
    p.begin();
    p.values(this.camera.matrixWorld.elements);
    p.values(this.camera.projectionMatrix.elements);
    const cameraStill = p.unchanged();
    this.scene.traverseVisible((object) => p.transform(object as THREE.Object3D & { intensity?: number; color?: THREE.Color }));
    if (this.instanceMatrices) p.values(this.instanceMatrices.array);
    p.value(this.visibleInstances);
    // Appearance and glass clarity follow these values.
    p.value(this.lift.value);
    p.value(this.decryption.clarity);
    for (const o of this.outgoing) p.value(o.clarity);
    const fog = this.scene.fog as THREE.Fog;
    p.value(fog.near);
    p.value(fog.far);
    const bokeh = this.bokeh.uniforms as Record<string, { value: number }>;
    p.value(bokeh.focus.value);
    p.value(bokeh.aperture.value);
    p.value(bokeh.focalRange.value);
    p.value(bokeh.focalLean.value);
    if (this.selectionLighting) p.values(this.selectionLighting.columnPosition.toArray());
    p.value(this.selectionLighting?.focus ?? 0);
    p.value(this.selectionLighting?.songFocus ?? 0);
    if (this.covers) {
      p.value(this.covers.revision);
      p.values(this.covers.selectedTint.toArray());
    }
    return cameraStill;
  }
  /**
   * The lifted case's axis-aligned box on screen, in CSS pixels from the canvas' top left: the
   * extent of its eight corners (MUSIC_MODEL's box, with the lift, the column's move toward the
   * lens and the play gesture's hop) as last drawn. Null off the shelf: in the intro, while a
   * case is opened (details, song scene) and before the scene has drawn the shelf.
   */
  get liftedCaseRect() {
    return this.liftedBox;
  }
  private measureLiftedCase() {
    const width = this.container.clientWidth, height = this.container.clientHeight;
    const { center } = MUSIC_MODEL;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    this.model.updateMatrixWorld();
    for (let corner = 0; corner < 8; corner++) {
      const p = this.liftedCorner.set(
        center.x + (corner & 1 ? 0.5 : -0.5) * MUSIC_MODEL.width,
        center.y + (corner & 2 ? 0.5 : -0.5) * MUSIC_MODEL.height,
        center.z + (corner & 4 ? 0.5 : -0.5) * MUSIC_MODEL.depth,
      ).applyMatrix4(this.model.matrixWorld).project(this.camera);
      const x = (p.x + 1) * width / 2, y = (1 - p.y) * height / 2;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    return { left, top, right, bottom };
  }
  projectCard(x: number, y: number) {
    this.model.updateMatrixWorld(true);
    const p = this.model
      .localToWorld(new THREE.Vector3(x, y, 0.255))
      .project(this.camera);
    return [(p.x + 1) * this.container.clientWidth / 2, (1 - p.y) * this.container.clientHeight / 2];
  }
  /** For a host loop that waits while the scene rests (FramePacing.nextFrameAt). */
  nextFrameAt() {
    return this.pacing.nextFrameAt();
  }
  /** Ends such a wait: input or a mutator needs display frames again. */
  set onWake(callback: (() => void) | undefined) {
    this.pacing.onWake = callback;
  }
  get decryptionFrame() { return this.decryption.frame; }
  finishDecryption() {
    this.pacing.invalidate();
    this.decryption.finish();
  }
  get detailVisibility() {
    return ease((this.detail - 0.25) / 0.55);
  }
  get musicPresentationReady() { return this.loaded && this.musicPresentation.phase === "presented"; }
  get musicArchiveReady() { return this.loaded && this.musicPresentation.phase === "archive"; }
  get musicArchiveInteractive() {
    // A new selection gets a fresh browsing lift. Do not transfer the outgoing
    // album's remaining extraction progress to that newly selected box.
    return this.loaded && (this.musicPresentation.phase === "archive" ||
      (this.musicPresentation.phase === "returning-array" && this.musicPlacement.settled &&
        this.detail === 0 && Math.abs(this.rotation) < 0.02));
  }
  get musicPresentationPhase() { return this.musicPresentation.phase; }
  getStats() {
    this.model.updateMatrixWorld(true);
    const project = (x: number, y: number, z: number) => {
      const p = this.model
        .localToWorld(new THREE.Vector3(x, y, z))
        .project(this.camera);
      return [Math.round((p.x + 1) * this.container.clientWidth / 2), Math.round((1 - p.y) * this.container.clientHeight / 2)];
    };
    return {
      decryption: { ...this.decryption.frame, clarity: this.decryption.clarity },
      topLeft: project(-2.5, 3.7, 0),
      topRight: project(2.5, 3.7, 0),
      projectedCenter: project(0, MUSIC_MODEL.center.y, 0),
      labelTopLeft: project(-1.855, 3.27, 0.255),
      labelBottomLeft: project(-1.855, 2.81, 0.255),
      modelPosition: this.model.position
        .toArray()
        .map((v) => Math.round(v * 10000) / 10000),
      cameraPosition: this.camera.position
        .toArray()
        .map((v) => Math.round(v * 10000) / 10000),
      cameraAim: this.cameraAim.toArray().map((v) => Math.round(v * 10000) / 10000),
      fieldOfView: this.camera.fov,
      loaded: this.loaded,
      drawCalls: this.renderer.info.render.calls,
      programs: this.renderer.info.programs?.length ?? 0,
      triangles: this.renderer.info.render.triangles,
      drawnFrames: this.pacing.drawn,
      resting: this.pacing.isResting,
      buffersReleased: this.buffersReleased,
      archiveCount: this.positions.length,
      drawnInstances: this.visibleInstances,
      returningFiles: this.outgoing.length,
      selectionPhase: this.pendingPulse
        ? "lifting"
        : this.pulses.length
          ? "wave"
          : "settled",
      pendingPulse: this.pendingPulse ? { ...this.pendingPulse } : null,
      pulses: this.pulses.map((pulse) => ({ ...pulse })),
      referenceTime: Math.round((this.scanTime + 5) * 100) / 100,
      selectedSlot: this.selectedSlot,
      selectedLane: Math.floor(this.selectedSlot / slotStride),
      selectedAlbumId: records[fileAtSlot(this.selectedSlot)]?.album?.id ?? null,
      albumCovers: this.covers?.array.visible ?? false,
      theme: this.theme,
      selectionLight: this.selectionLighting ? {
        visible: this.selectionLighting.spot.visible,
        position: this.selectionLighting.spot.position.toArray(),
        target: this.selectionLighting.spot.target.position.toArray(),
      } : null,
      selectedCell: { ...this.selectedCell },
      coordinateOrigin: { ...this.coordinateOrigin },
      poolBounds: {
        minLane: Math.min(...this.cells.map((c) => c.lane)),
        maxLane: Math.max(...this.cells.map((c) => c.lane)),
        minRow: Math.min(...this.cells.map((c) => c.row)),
        maxRow: Math.max(...this.cells.map((c) => c.row)),
      },
      laneFocus: this.laneFocus.value,
      columnCamera: this.columnCamera.value,
      rotation: this.rotation,
      clearance: this.clearance,
      canInspect: this.canInspect,
      returnPhase: this.returnY !== null ? "aligning" : "lowering",
      extraction: Math.round(this.lift.value * 1000) / 1000,
      previewLift: musicLibrary ? MUSIC_PREVIEW_LIFT : 0.4,
      appearance: Math.round(ease(this.lift.value / 0.4) * 1000) / 1000,
      cameraDetail: Math.round(this.detail * 1000) / 1000,
      musicPresentationPhase: this.musicPresentationPhase,
      musicPlacement: { progress: this.musicPlacement.value, velocity: this.musicPlacement.velocity,
        settled: this.musicPlacement.settled },
      musicNavigationLift: this.musicNavigationLift,
      song: { progress: this.songProgress, target: this.songTarget, settled: this.song.settled },
      playGesture: {
        started: this.playStarted,
        hop: playHop(this.clock - this.playStarted),
        waves: this.pulses.filter((pulse) => pulse.play).length,
        songCardHop: this.songHopPixels,
      },
      laneLabels: {
        named: this.laneNames?.length ?? 0,
        names: this.laneNameLayer?.shown() ?? [],
        // The camera the names' slots are seen with (shelfRestCamera), to compare with the live one at rest.
        restCamera: this.laneSlotView ? { position: this.restCamera.position.toArray(), fieldOfView: this.restCamera.fov, view: this.laneSlotView } : null,
      },
      musicPresentationReady: this.musicPresentationReady,
      musicArchiveReady: this.musicArchiveReady,
      idleGain: this.idleGain,
      cameraDistance: this.camera.position.distanceTo(this.cameraAim),
      cameraNear: this.camera.near,
      cameraFar: this.camera.far,
      fogNear: (this.scene.fog as THREE.Fog).near,
      fogFar: (this.scene.fog as THREE.Fog).far,
      returningAppearance: this.outgoing.map((o) => ({
        slot: o.slot,
        cell: { ...o.cell },
        lift: o.lift.value,
        quality: ease(o.lift.value / 0.4),
        rotation: o.yaw,
        worldY: o.group.position.y,
        phase: o.returnY !== null ? "aligning" : "lowering",
      })),
      rail: Math.round(this.rail.value * 1000) / 1000,
    };
  }
}
