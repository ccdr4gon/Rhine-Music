import * as THREE from "three";

/**
 * What three keeps beside a material's program when it works one out (WebGLRenderer getProgram and
 * updateCommonMaterialProperties, three r183), and compares before it keeps it (setProgram): the
 * program and the conditions it was chosen under. The uniforms all of a material's programs share and
 * the programs three has built for it stay as three has them. check-side-programs.mjs compares this
 * list with three's source.
 */
export const PROGRAM_STATE = [
  "currentProgram", "environment", "fog", "envMap", "envMapRotation", "needsLights", "lightsStateVersion",
  "outputColorSpace", "batching", "batchingColor", "instancing", "instancingColor", "instancingMorph",
  "skinning", "morphTargets", "morphNormals", "morphColors", "morphTargetsCount", "numClippingPlanes",
  "numIntersection", "vertexAlphas", "vertexTangents", "toneMapping",
] as const;
type MaterialState = Record<string, unknown> & { currentProgram?: unknown; __version?: number };
type Properties = { get(material: THREE.Material): MaterialState };

/**
 * What three reads from the renderer to choose a program (WebGLPrograms getParameters) but does not
 * compare before it keeps one (setProgram), three r183: whether the shadow map is on, and its type. A
 * change of either forgets what was remembered, so three chooses every side again, as before.
 * check-side-programs.mjs compares this list with three's source.
 */
export const UNCOMPARED_RENDERER_INPUTS = ["shadowMap.enabled", "shadowMap.type"] as const;

/** Put where three keeps the colour space it chose a program for: no colour space is called this, so three chooses again. */
const UNCHOSEN = "rhine-music:unchosen";

/**
 * three draws a double-sided material one side at a time where it has to: the back faces of
 * transmissive glass into its transmission capture, and transparent ones back faces first in the
 * frame (WebGLRenderer renderTransmissionPass, renderObject). Each time it turns `material.side`
 * and sets needsUpdate, then turns it back, and every such step makes it work the material's program
 * out again from scratch (its parameters, their key, the uniform list), 57 to 74 times a frame while
 * browsing the shelf (measured 2026-10-10), although each side's program is the same every time.
 *
 * Here a watched material remembers, for each side, what three last chose for it: the program and the
 * conditions three chose it under. When three turns the material, inside its own drawing, to a side it
 * has chosen for since the material last changed, that choice is put back; to a side it has not, the
 * colour space it is compared by is replaced with a name no colour space has, so three chooses at its
 * next draw of that side, as a stepped version would make it, without making it choose again for every
 * other side. Neither steps the version. three then checks a choice put back as it checks any material that has not changed
 * (setProgram): kept while the conditions still hold (the lights, the target's colour space and tone
 * mapping, the object's kind...), otherwise worked out again. Anything else (a change of the material
 * from outside the drawing, or by one of three's own setters, three's state renewed) is counted as
 * before and forgets what was remembered. The programs are three's own, so nothing draws differently.
 *
 * Two things three also chooses from without comparing them are watched here. The renderer's shadow
 * map (UNCOMPARED_RENDERER_INPUTS): a change forgets what was remembered. The geometry (its uv1 to
 * uv3, for one): a choice is only put back for the one mesh, and geometry, that draws the material;
 * a material a second mesh or geometry draws is left to three as it was, every turn counted again.
 * In the app each watched material has its own mesh (the shelf's instanced glass, the lifted case's,
 * each returning copy's; measured 2026-10-11).
 */
export class SidePrograms {
  private depth = 0;
  private readonly watched = new WeakSet<THREE.Material>();

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    const render = renderer.render.bind(renderer);
    renderer.render = (scene, camera) => {
      this.depth++;
      try {
        render(scene, camera);
      } finally {
        this.depth--;
      }
    };
  }

  /** three's per-material state (`properties`; a new one after a lost context); without it nothing is remembered. */
  private get properties(): Properties | undefined {
    const properties = (this.renderer as unknown as { properties?: Partial<Properties> }).properties;
    return typeof properties?.get === "function" ? properties as Properties : undefined;
  }

  /** Watches the double-sided materials under `root` (new copies are watched as they are made). */
  watch(root: THREE.Object3D) {
    if (!this.properties) return;
    root.traverse((object) => {
      const material = (object as THREE.Mesh).material;
      for (const m of Array.isArray(material) ? material : material ? [material] : []) this.watchMaterial(m);
    });
  }

  private watchMaterial(material: THREE.Material) {
    if (material.side !== THREE.DoubleSide || this.watched.has(material)) return;
    this.watched.add(material);
    // What three chose for each side, good while nothing but these turns has changed the material.
    const sides = new Map<THREE.Side, unknown[]>();
    // three's state the remembered choices were taken from.
    let owner: MaterialState | undefined;
    // The side three's current program is for; not known until three has been turned here.
    let programSide: THREE.Side | null = null;
    // The material's version as the last update here left it.
    let known = material.version;
    // The renderer's shadow map as the remembered choices were made under it.
    const shadowMap = this.renderer.shadowMap;
    let shadows = shadowMap.enabled;
    let shadowType = shadowMap.type;
    // The mesh and geometry that draw the material (renderObject tells it before every draw).
    let drawnBy: THREE.Object3D | undefined;
    let drawnWith: THREE.BufferGeometry | undefined;
    const ownBeforeRender = Object.prototype.hasOwnProperty.call(material, "onBeforeRender");
    const beforeRender = material.onBeforeRender;
    material.onBeforeRender = function (renderer, scene, camera, geometry, object, group) {
      if (!drawnBy) {
        drawnBy = object;
        drawnWith = geometry;
      } else if (object !== drawnBy || geometry !== drawnWith) {
        // A second mesh or geometry: left to three as it was, from this draw on.
        sides.clear();
        delete (material as unknown as Record<string, unknown>).needsUpdate;
        if (ownBeforeRender) material.onBeforeRender = beforeRender;
        else delete (material as unknown as Record<string, unknown>).onBeforeRender;
        material.needsUpdate = true;
      }
      beforeRender.call(this, renderer, scene, camera, geometry, object, group);
    };
    Object.defineProperty(material, "needsUpdate", {
      configurable: true,
      set: (value: boolean) => {
        if (value !== true) return;
        const state = this.properties?.get(material);
        if (material.version !== known || state !== owner || shadowMap.enabled !== shadows || shadowMap.type !== shadowType) {
          // Changed by something else since (three's setters step the version themselves), three's
          // state renewed (a disposed material, a lost context), or the shadow map changed: nothing
          // remembered holds any more, nor which side the current program is for.
          sides.clear();
          owner = state;
          programSide = null;
          shadows = shadowMap.enabled;
          shadowType = shadowMap.type;
        }
        if (state && this.depth > 0 && programSide !== null && material.side !== programSide) {
          // three turns the material to draw another side: what it chose for the side it leaves is
          // kept, if it chose it for the material as it is...
          if (state.currentProgram !== undefined && state.__version === material.version && state.outputColorSpace !== UNCHOSEN) {
            sides.set(programSide, PROGRAM_STATE.map((name) => state[name]));
          }
          programSide = material.side;
          // ... and what it chose for this side is put back, or, not chosen yet, chosen at its next
          // draw; the uniform list is cleared as three clears it whenever it changes the program.
          const kept = sides.get(material.side);
          if (kept) {
            PROGRAM_STATE.forEach((name, i) => {
              state[name] = kept[i];
            });
          } else {
            state.outputColorSpace = UNCHOSEN;
          }
          state.uniformsList = null;
          return;
        }
        // Anything else: worked out again, and every side after it. What Material's own needsUpdate
        // does (three types the field read-only).
        sides.clear();
        programSide = material.side;
        (material as { version: number }).version++;
        known = material.version;
      },
    });
  }
}
