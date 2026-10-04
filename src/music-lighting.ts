import * as THREE from "three";
import { MUSIC_MODEL } from "./music-model.ts";
import { ThemeTransition } from "./theme-transition.ts";

/**
 * Shelf-space shape of the selection emphasis, in world units from the light
 * column (the selected case's origin, on its own spring). The shader text is
 * generated from these numbers and the checks evaluate the same functions.
 */
export const SELECTION_FIELD = {
  // Height from the light column at which the lifted case or a returning copy
  // counts as raised. Shelf instances are not measured: they always rest.
  raised: [-0.75, -0.15],
  // Shadow pool: the rows between the selection (+Z) and the camera. The first
  // row in front is three quarters in; the full depth holds to row +8.
  poolNear: [0.1, 0.85],
  poolFar: [5.0, 10.5],
  poolLane: 6.5,
  // Lit row: tight behind the selection, one soft row towards the camera.
  rowFront: 0.55,
  rowBehind: 0.38,
  // The ribbon runs along the selected row: 1.5 lanes towards -X, short towards +X.
  reachLeft: [8.0, 13.5],
  reachRight: [3.0, 8.0],
  // The strip below the top edge that the stepped rows leave exposed.
  topBand: [0.16, 0.02],
  // The raised case's spine-side rim: 1 / e-folding width, and its lane footprint.
  rimFalloff: 8.7,
  rimLane: 2.6,
  // Column speed across the shelf (units/s) at which the emphasis has thinned to half.
  focusSpeed: 14,
  // The emphasis belongs to the selection, so it also waits for the light column to arrive
  // there: a distance beyond `focusSlack` halves it at `focusReach` more. Distances across
  // lanes count a quarter (the shapes are a lane wide). The selection is tracked by a fast
  // follower (rate `focusLead`), so a new selection fades the old place out over a few frames.
  focusSlack: 0.35,
  focusReach: 1.2,
  focusLane: 4,
  focusLead: 40,
  // The emphasis leaves at once and returns at this rate (1/s): a column that sweeps across
  // the selection on its way past it does not flash the emphasis on and off again.
  focusReturn: 4,
} as const;
/**
 * Linear multipliers inside the pool: a warm shade by day, a cool one at night.
 * The double-sided glass is shaded on both of its faces, so it ends up near the
 * square of these; the opaque prints and spines take them once.
 */
export const SELECTION_POOL_TINT = {
  day: [0.78, 0.71, 0.6],
  dusk: [0.75, 0.74, 0.72],
  night: [0.72, 0.76, 0.84],
} as const;
/** Scene-linear gains: the lit row's own light multiplied, its added scatter, and the raised rim. */
export const SELECTION_GAIN = [0.42, 0.02, 1] as const;
/**
 * The song scene's emphasis. The large card keeps the rim, and every other case (the chain
 * of covers) lies in this share of the pool's shade. How much of the large card a case is
 * comes from its own lift (`card`, 0 for every shelf instance), not from its height against
 * the light column: far chain places stand as high as the large card, and the column lags
 * behind a newly selected case.
 */
export const SELECTION_SONG_SHADE = 0.7;
// Shelf instances are never the large card.
const NO_CARD = { value: 0 };

const F = SELECTION_FIELD;
const smooth = (from: number, to: number, value: number) => THREE.MathUtils.smoothstep(value, from, to);
/**
 * 1 for the lifted case or a returning copy (plain meshes) as high as the light
 * column, `dy` being its height from the column. Shelf instances are never
 * measured this way: the column drops to shelf level whenever the selection
 * changes, and the rows resting on the shelf must not count as raised then.
 */
export function selectionRaised(dy: number) {
  return smooth(F.raised[0], F.raised[1], dy);
}
/**
 * Shadow weight of a case offset (dx, dz) from the light column. `raised` is 0
 * for a shelf instance, whatever its height; the lifted case and returning
 * copies pass `selectionRaised(dy)`.
 */
/** Shade of a case in the song scene (`song` is that scene's share of the view): all but the large card. */
export function selectionSongShade(card: number, song: number) {
  return (1 - card) * song * SELECTION_SONG_SHADE;
}
export function selectionPool(dx: number, dz: number, raised = 0) {
  const side = (dx / F.poolLane) ** 2;
  return smooth(F.poolNear[0], F.poolNear[1], dz) * (1 - smooth(F.poolFar[0], F.poolFar[1], dz))
    * Math.exp(-side * side) * (1 - raised);
}
/** Ribbon weight of the row dz from the selected one. */
export function selectionRow(dz: number) {
  const scale = dz / (dz > 0 ? F.rowFront : F.rowBehind);
  return Math.exp(-scale * scale);
}
/** How far the ribbon reaches along its row, `along` world units in X from the selection. */
export function selectionReach(along: number) {
  return along < 0
    ? 1 - smooth(F.reachLeft[0], F.reachLeft[1], -along)
    : 1 - smooth(F.reachRight[0], F.reachRight[1], along);
}

const f = (value: number) => value.toFixed(3);
// x: shadow pool, y: selected-row weight, z: raised. One value per case, so it
// is evaluated per vertex from the instance origin.
const selectionFieldGLSL = `
  vec3 musicSelectionField(vec3 delta) {
    // Shelf instances rest by definition: only the lifted case and returning
    // copies (plain meshes) are measured against the column's height, which
    // drops to shelf level whenever the selection changes.
    #ifdef USE_INSTANCING
      float raised = 0.0;
    #else
      float raised = smoothstep(${f(F.raised[0])}, ${f(F.raised[1])}, delta.y);
    #endif
    float side = delta.x / ${f(F.poolLane)};
    side *= side;
    float row = delta.z / (delta.z > 0.0 ? ${f(F.rowFront)} : ${f(F.rowBehind)});
    return vec3(
      smoothstep(${f(F.poolNear[0])}, ${f(F.poolNear[1])}, delta.z)
        * (1.0 - smoothstep(${f(F.poolFar[0])}, ${f(F.poolFar[1])}, delta.z))
        * exp(-side * side) * (1.0 - raised),
      exp(-row * row),
      raised);
  }
`;

/** Side key plus a bounded approximation of light scattered inside the CD shell. */
export class MusicSelectionLighting {
  readonly spot = new THREE.SpotLight("#ffe3b2", 180 * 64, 0, 0.32, 0.95, 2);
  private readonly aim = new THREE.Vector3();
  private readonly anchor = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly anchorVelocity = new THREE.Vector3();
  private readonly columnVelocity = new THREE.Vector3();
  // A fast follower of the selection: what the column's distance is measured against.
  private readonly lead = new THREE.Vector3();
  private readonly leadVelocity = new THREE.Vector3();
  // How much of the shelf share the moving light lets through (see update()).
  private presence = 1;
  private initialized = false;
  private readonly column = { value: new THREE.Vector3() };
  private readonly scatterColor = { value: new THREE.Color("#ffdba3") };
  private readonly scatterStrength = { value: 1 };
  private readonly printAmbient = { value: 0.5 };
  private readonly shellBounds = { value: new THREE.Vector4(
    MUSIC_MODEL.center.x - MUSIC_MODEL.width / 2,
    MUSIC_MODEL.center.y - MUSIC_MODEL.height / 2,
    MUSIC_MODEL.center.y + MUSIC_MODEL.height / 2,
    1 / MUSIC_MODEL.height,
  ) };
  private readonly edgeFalloff = { value: new THREE.Vector2(1.7, 24) };
  private readonly poolTint = { value: new THREE.Color().fromArray(SELECTION_POOL_TINT.day) };
  private readonly ribbonGain = { value: new THREE.Vector3(...SELECTION_GAIN) };
  private readonly emphasis = { value: 0 };
  private readonly song = { value: 0 };

  /** The light column's position, a shader uniform on its own spring. */
  get columnPosition(): THREE.Vector3 {
    return this.column.value;
  }

  /** How much of the shelf emphasis (pool, ribbon, rim) is shown, 0..1. */
  get focus(): number {
    return this.emphasis.value;
  }

  /** How much of the song scene's emphasis (the large card's rim, the chain's shade) is shown, 0..1. */
  get songFocus(): number {
    return this.song.value;
  }

  constructor(private readonly scene: THREE.Scene) {
    this.spot.name = "Selected album soft key";
    // Existing soft contact shadows are sufficient; the local key adds no
    // second shadow-map render across the entire glass array.
    this.spot.castShadow = false;
    this.spot.visible = false;
    scene.add(this.spot, this.spot.target);
  }

  setTheme(theme: "day" | "night" | "dusk", key: THREE.DirectionalLight, transition?: ThemeTransition) {
    const night = theme === "night";
    const targets = transition ?? new ThemeTransition();
    targets.number(this.scene, "environmentIntensity", night ? 0.16 : 0.25);
    targets.number(key, "intensity", night ? 0.30 : 0.45);
    for (const child of this.scene.children) {
      if (child instanceof THREE.HemisphereLight) targets.number(child, "intensity", night ? 0.21 : 0.32);
      if (child instanceof THREE.DirectionalLight && child !== key) targets.number(child, "intensity", 0.045);
    }
    targets.color(this.spot.color, night ? "#dbe9ff" : "#ffe3b2");
    targets.number(this.spot, "intensity", (night ? 130 : 180) * 64);
    targets.color(this.scatterColor.value, night ? "#cee5ff" : "#ffdba3");
    targets.number(this.scatterStrength, "value", night ? 0.72 : 1);
    targets.number(this.printAmbient, "value", night ? 0.12 : theme === "dusk" ? 0.38 : 0.5);
    targets.color(this.poolTint.value, new THREE.Color().fromArray(SELECTION_POOL_TINT[theme]));
    if (!transition) targets.finish();
  }

  /** Diffuse printed art shares the moving light field, never the shell's glow.
   * All ownership states use world transforms, so changing instance/mesh cannot
   * change the exposure; extraction and return pass continuously through it.
   * `card` is the lifted print's share of the song scene's large card (see shade()).
   */
  shadePrint(shader: THREE.WebGLProgramParametersWithUniforms, card?: THREE.IUniform<number>) {
    shader.uniforms.musicCard = card ?? NO_CARD;
    shader.uniforms.musicPrintLightColumn = this.column;
    shader.uniforms.musicPrintAmbient = this.printAmbient;
    shader.uniforms.musicPoolTint = this.poolTint;
    shader.uniforms.musicFocus = this.emphasis;
    shader.uniforms.musicSong = this.song;
    shader.vertexShader = `
      varying vec3 vMusicPrintOrigin;
      varying float vMusicPrintPool;
      uniform vec3 musicPrintLightColumn;
    ` + selectionFieldGLSL + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", `
      #include <begin_vertex>
      vec4 musicPrintOrigin = vec4(0.0, 0.0, 0.0, 1.0);
      #ifdef USE_INSTANCING
        musicPrintOrigin = instanceMatrix * musicPrintOrigin;
      #endif
      vMusicPrintOrigin = (modelMatrix * musicPrintOrigin).xyz;
      vMusicPrintPool = musicSelectionField(vMusicPrintOrigin - musicPrintLightColumn).x;
    `);
    shader.fragmentShader = `
      varying vec3 vMusicPrintOrigin;
      varying float vMusicPrintPool;
      uniform vec3 musicPrintLightColumn;
      uniform float musicPrintAmbient;
      uniform vec3 musicPoolTint;
      uniform float musicFocus;
      uniform float musicSong;
      uniform float musicCard;
    ` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace("#include <opaque_fragment>", `
      // The low local key reaches nearby rows/lanes; the stacked shelf shelters
      // the rest. The lifted cover stays in the light while its neighbors fall
      // below it. This attenuation only removes diffuse light, never adds white.
      vec3 printDistance = (vMusicPrintOrigin - musicPrintLightColumn) / vec3(6.0, 3.35, 5.5);
      float printLight = exp(-dot(printDistance, printDistance));
      outgoingLight *= mix(musicPrintAmbient, 1.0, printLight);
      // The rows in front of the selection share the shell's shadow pool; in the song
      // scene every cover but the large card's shares the chain's shade.
      outgoingLight *= mix(vec3(1.0), musicPoolTint, max(vMusicPrintPool * musicFocus, (1.0 - musicCard) * musicSong * ${f(SELECTION_SONG_SHADE)}));
      #include <opaque_fragment>
    `);
  }

  /** Shared by instances, the lifted CD and returning copies; no extra render pass.
   * WebGL transmission cannot propagate light between glass layers. This bounded
   * scattering term approximates that transport from the spine into the panel.
   * `card` is how much of the song scene's large card this case is (its own uniform on the
   * lifted case and on each returning copy); shelf instances pass none.
   */
  shade(shader: THREE.WebGLProgramParametersWithUniforms, surface: string, card?: THREE.IUniform<number>) {
    // Covers are independent surface prints. Keep this guard even when a
    // caller accidentally registers them with the shell lighting controller.
    if (surface === "Album_Print") return;
    shader.uniforms.musicLightColumn = this.column;
    shader.uniforms.musicScatterColor = this.scatterColor;
    shader.uniforms.musicScatterStrength = this.scatterStrength;
    shader.uniforms.musicShellBounds = this.shellBounds;
    shader.uniforms.musicEdgeFalloff = this.edgeFalloff;
    shader.uniforms.musicPoolTint = this.poolTint;
    shader.uniforms.musicRibbonGain = this.ribbonGain;
    shader.uniforms.musicFocus = this.emphasis;
    shader.uniforms.musicSong = this.song;
    shader.uniforms.musicCard = card ?? NO_CARD;
    const declarations = `
      varying vec3 vMusicLocal;
      varying vec3 vMusicOrigin;
      varying vec3 vMusicField;
      uniform vec3 musicLightColumn;
    `;
    shader.vertexShader = declarations + selectionFieldGLSL + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", `
      #include <begin_vertex>
      vMusicLocal = position;
      vec4 musicOrigin = vec4(0.0, 0.0, 0.0, 1.0);
      #ifdef USE_INSTANCING
        musicOrigin = instanceMatrix * musicOrigin;
      #endif
      vMusicOrigin = (modelMatrix * musicOrigin).xyz;
      vMusicField = musicSelectionField(vMusicOrigin - musicLightColumn);
    `);
    shader.fragmentShader = declarations + `
      uniform vec3 musicScatterColor;
      uniform float musicScatterStrength;
      // left X, bottom Y, top Y, inverse height — shared with the real shell.
      uniform vec4 musicShellBounds;
      uniform vec2 musicEdgeFalloff;
      uniform vec3 musicPoolTint;
      // lit row: multiplied, added scatter; raised rim.
      uniform vec3 musicRibbonGain;
      uniform float musicFocus;
      // The song scene's share, and how much of its large card this case is: the large card
      // keeps the rim, the others take the shade.
      uniform float musicSong;
      uniform float musicCard;
    ` + shader.fragmentShader;
    const glass = surface === "Frosted_Polymer";
    const spine = surface === "Ivory_Edges";
    shader.fragmentShader = shader.fragmentShader.replace("#include <opaque_fragment>", `
      float laneDistance = abs(vMusicOrigin.x - musicLightColumn.x);
      float laneRadius = laneDistance / 3.2;
      float coreLight = exp(-laneRadius * laneRadius * laneRadius * laneRadius);
      float spillRadius = laneDistance / 7.2;
      float spillLight = exp(-spillRadius * spillRadius * spillRadius * spillRadius);
      // Both neighboring genre columns receive a broad, weaker wash. Two lanes
      // away it has almost vanished; only nearby rows carry the cross-shelf band.
      float laneLight = 0.58 * coreLight + 0.42 * spillLight;
      float rowDistance = (vMusicOrigin.z - musicLightColumn.z) / 5.5;
      float rowLight = exp(-rowDistance * rowDistance);
      float hotDistance = (vMusicOrigin.z - musicLightColumn.z) / 1.1;
      float hotLight = exp(-hotDistance * hotDistance);
      // The reference has a warm local ribbon, not uniformly glowing spines.
      float neighborDistance = (vMusicOrigin.z - musicLightColumn.z) / 2.4;
      float neighborLight = exp(-neighborDistance * neighborDistance);
      float guidedLight = 0.58 * coreLight * mix(0.12, 1.0, rowLight)
                        + 0.42 * spillLight * neighborLight;
      outgoingLight *= mix(0.96, 1.04, guidedLight);
      ${glass || spine ? `
        float fromSpine = max(0.0, vMusicLocal.x - musicShellBounds.x);
        float edgeTransport = exp(-fromSpine * musicEdgeFalloff.x);
        float panelHeight = clamp((vMusicLocal.y - musicShellBounds.y) * musicShellBounds.w, 0.0, 1.0);
        float lowerLight = mix(1.0, 0.62, panelHeight);
        float topRim = exp(-max(0.0, musicShellBounds.z - vMusicLocal.y) * musicEdgeFalloff.y);
        float grazing = 1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0);
        float edgeScatter = ${spine ? '0.30' : '0.14'} * edgeTransport + ${spine ? '0.016' : '0.003'};
        outgoingLight += musicScatterColor * musicScatterStrength * guidedLight * edgeScatter * lowerLight;
        // A narrow glint at the top and the lit spine changes with viewing angle.
        // Warm light stays on the glass; the independent cover has no such term.
        float ribbon = topRim * (0.22 + 0.78 * edgeTransport) + ${spine ? '0.18' : '0.035'} * edgeTransport * grazing;
        outgoingLight += musicScatterColor * musicScatterStrength * laneLight * hotLight * ribbon * 0.8;
      ` : ''}
      // Selection emphasis on the shelf. A bright band runs along the selected
      // row, across the neighboring lanes, on the strip each stepped row exposes.
      float musicAlong = vMusicOrigin.x + vMusicLocal.x - musicLightColumn.x;
      float musicReach = musicAlong < 0.0
        ? 1.0 - smoothstep(${f(F.reachLeft[0])}, ${f(F.reachLeft[1])}, -musicAlong)
        : 1.0 - smoothstep(${f(F.reachRight[0])}, ${f(F.reachRight[1])}, musicAlong);
      float musicTopBand = smoothstep(musicShellBounds.z - ${f(F.topBand[0])}, musicShellBounds.z - ${f(F.topBand[1])}, vMusicLocal.y);
      float musicRow = vMusicField.y * musicReach * musicTopBand * (1.0 - vMusicField.z) * musicFocus;
      outgoingLight = outgoingLight * (1.0 + musicRibbonGain.x * musicRow)
                    + musicScatterColor * (musicScatterStrength * musicRibbonGain.y * musicRow);
      ${glass || spine ? `
        // The raised case carries a rim along its spine-side edge.
        float musicNear = (vMusicOrigin.x - musicLightColumn.x) / ${f(F.rimLane)};
        float musicRim = exp(-fromSpine * ${f(F.rimFalloff)})
                       * max(vMusicField.z * vMusicField.y * exp(-musicNear * musicNear) * musicFocus, musicCard * musicSong);
        outgoingLight += musicScatterColor * (musicScatterStrength * musicRibbonGain.z * musicRim);
      ` : ''}
      // The rows between the selection and the camera lie in a tinted shadow; in the song
      // scene the chain of covers does, around the large card.
      outgoingLight *= mix(vec3(1.0), musicPoolTint, max(vMusicField.x * musicFocus, (1.0 - musicCard) * musicSong * ${f(SELECTION_SONG_SHADE)}));
      #include <opaque_fragment>
    `);
  }

  private follow(value: THREE.Vector3, velocity: THREE.Vector3, target: THREE.Vector3, dt: number, rate = 5.0) {
    const decay = Math.exp(-rate * dt);
    for (const axis of ["x", "y", "z"] as const) {
      const delta = value[axis] - target[axis];
      const impulse = velocity[axis] + rate * delta;
      value[axis] = target[axis] + (delta + impulse * dt) * decay;
      velocity[axis] = (velocity[axis] - rate * impulse * dt) * decay;
    }
  }

  /**
   * `shelf` is how much of the picture is the shelf view: 0 once a case is opened.
   * `shelfVelocityX` / `shelfVelocityZ` is the world velocity of the shelf rows:
   * navigation slides the shelf under the light, so the emphasis is thinned by
   * the speed at which rows pass the column, not by the column's own speed.
   * `song` is how much of the picture is the song scene.
   */
  update(model: THREE.Object3D, camera: THREE.Camera, dt: number, visible: boolean, reduced: boolean, cinematic = false, shelf = 1,
    shelfVelocityX = 0, shelfVelocityZ = 0, song = 0) {
    this.spot.visible = visible;
    this.song.value = visible ? THREE.MathUtils.clamp(song, 0, 1) : 0;
    if (!visible) {
      this.initialized = false;
      this.emphasis.value = 0;
      this.presence = 1;
      return;
    }
    // Use the rendered world position, never a library row/index: the array
    // scrolls and periodically rebases its coordinates during infinite browsing.
    model.updateWorldMatrix(true, false);
    this.aim.set(
      MUSIC_MODEL.center.x - MUSIC_MODEL.width / 2 + 0.14,
      MUSIC_MODEL.center.y + MUSIC_MODEL.height * 0.12,
      MUSIC_MODEL.center.z,
    ).applyMatrix4(model.matrixWorld);
    let speed = 0, away = 0;
    if (!this.initialized || reduced || cinematic) {
      // Opening choreography already eases its track/camera: another spring
      // would leave the light behind during the large initial array translation.
      this.anchor.copy(this.aim);
      this.column.value.copy(model.position);
      this.lead.copy(model.position);
      this.anchorVelocity.set(0, 0, 0);
      this.columnVelocity.set(0, 0, 0);
      this.leadVelocity.set(0, 0, 0);
      // A snapped column is on the selection: the whole shelf share shows at once.
      this.presence = 1;
    } else {
      // Preserve velocity on repeated input. A critically damped start follows
      // the soft lift; the wider lane footprint crossfades neighboring columns
      // while travelling between them instead of extinguishing both midway.
      this.follow(this.anchor, this.anchorVelocity, this.aim, dt);
      this.follow(this.column.value, this.columnVelocity, model.position, dt);
      // Fast travel thins the emphasis instead of strobing it over every row
      // passed; it re-forms as the column settles on the final album. The
      // column is measured against the sliding shelf: a snapped column (above)
      // shows the whole shelf share at once.
      speed = Math.hypot(this.columnVelocity.x - shelfVelocityX, this.columnVelocity.z - shelfVelocityZ) / F.focusSpeed;
      // After a long jump or a wheel burst the column runs past the selection and glides
      // back slowly: the emphasis stays thin until the column is on the selection, instead
      // of re-forming a few rows away and sliding onto it.
      this.follow(this.lead, this.leadVelocity, model.position, dt, F.focusLead);
      away = Math.max(0, Math.hypot((this.column.value.x - this.lead.x) / F.focusLane, this.column.value.z - this.lead.z) - F.focusSlack) / F.focusReach;
    }
    this.initialized = true;
    const present = 1 / ((1 + speed * speed) * (1 + away * away));
    this.presence = present <= this.presence || present - this.presence < 1e-4
      ? present
      : this.presence + (present - this.presence) * (1 - Math.exp(-F.focusReturn * dt));
    this.emphasis.value = THREE.MathUtils.clamp(shelf, 0, 1) * this.presence;
    this.spot.target.position.copy(this.anchor);
    // Camera-local -X/-Y: light enters from the lower-left of the picture and
    // grazes the spine, rather than illuminating the album face from above.
    // The old near-field source sat inside a neighboring lane and burned a
    // white spot into its nearest corner. Move it eight times farther away,
    // outside the pool, and compensate intensity by distance squared above.
    this.offset.set(-6, -2.2, 4.5).multiplyScalar(8).applyQuaternion(camera.quaternion);
    this.spot.position.copy(this.anchor).add(this.offset);
  }
}
