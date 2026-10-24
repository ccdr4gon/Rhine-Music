import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

export type LightingLook = "baseline" | "refined";

function studioEnvironment(renderer: THREE.WebGLRenderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const texture = pmrem.fromScene(room, 0.04).texture;
  room.dispose();
  pmrem.dispose();
  return texture;
}

// The archive and its independent viewer use the same studio illumination.
// Each renderer needs its own PMREM render target / WebGL texture.
export function createArchiveLighting(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  look: LightingLook = "baseline",
  environment: (renderer: THREE.WebGLRenderer) => THREE.Texture = studioEnvironment,
) {
  const refined = look === "refined";
  renderer.toneMappingExposure = refined ? 1.0 : 1.05;
  scene.environment = environment(renderer);
  // The environment is a render target: it lives only on the GPU, and three cannot upload it
  // again into a restored context (it would bind empty: every surface without its studio
  // light, the shelf's prints blank). Render it again once three has set the context up (its
  // own listener, added with the renderer, runs first). The old texture went with the lost
  // context; disposing it would delete a texture the new context does not own.
  renderer.domElement.addEventListener("webglcontextrestored", () => {
    scene.environment = environment(renderer);
  });
  scene.environmentIntensity = refined ? 0.52 : 0.48;
  scene.add(
    new THREE.HemisphereLight(
      "#fffaf5",
      refined ? "#b49b80" : "#b4a18c",
      refined ? 0.5 : 0.65,
    ),
  );
  const key = new THREE.DirectionalLight(
    refined ? "#fff4e5" : "#fff7ed",
    refined ? 1.7 : 1.4,
  );
  key.position.set(
    ...((refined ? [-8, 14, 4] : [-6, 14, -5]) as [number, number, number]),
  );
  const fill = new THREE.DirectionalLight("#ffffff", refined ? 0.3 : 0.6);
  fill.position.set(7, 8, -10);
  scene.add(key, fill);
  return key;
}
