import * as THREE from "three";
import { THIN_COVERAGE_GLSL } from "./thin-coverage";

// Only geometrically verified, long rectangular faces use this shader. The
// model's remaining faces and its original shadow/depth geometry stay intact.
const declarations = `
uniform vec2 rhineViewport;
varying vec2 vRhineStart;
varying vec2 vRhineEnd;
varying vec2 vRhineWidths;
varying vec2 vRhineSide;
varying vec3 vRhineNormal0;
varying vec3 vRhineNormal1;
varying float vRhineValid;
`;
const vertex = `
attribute vec3 rhineStart;
attribute vec3 rhineEnd;
attribute vec3 rhineHalfWidth;
attribute vec2 rhineCorner;
attribute vec3 rhineNormal0;
attribute vec3 rhineNormal1;
vec4 rhineView(vec3 p) {
  vec4 v = vec4(p, 1.0);
  #ifdef USE_INSTANCING
    v = instanceMatrix * v;
  #endif
  return modelViewMatrix * v;
}
vec3 rhineNormal(vec3 n) {
  #ifdef USE_INSTANCING
    mat3 m = mat3(instanceMatrix);
    n /= max(vec3(dot(m[0],m[0]),dot(m[1],m[1]),dot(m[2],m[2])),vec3(1e-12));
    n = m * n;
  #endif
  return normalize(normalMatrix * n);
}
vec2 rhinePixel(vec4 p) { return (p.xy / p.w * 0.5 + 0.5) * rhineViewport; }
`;
const project = `
#include <project_vertex>
vRhineValid = 0.0;
vRhineWidths = vec2(0.0);
vRhineStart = vec2(0.0); vRhineEnd = vec2(1.0,0.0);
vRhineSide = vec2(0.0,1.0);
vRhineNormal0 = rhineNormal(rhineNormal0);
vRhineNormal1 = rhineNormal(rhineNormal1);
vec4 rs = projectionMatrix * rhineView(rhineStart);
vec4 re = projectionMatrix * rhineView(rhineEnd);
vec4 rsp = projectionMatrix * rhineView(rhineStart + rhineHalfWidth);
vec4 rsm = projectionMatrix * rhineView(rhineStart - rhineHalfWidth);
vec4 rep = projectionMatrix * rhineView(rhineEnd + rhineHalfWidth);
vec4 rem = projectionMatrix * rhineView(rhineEnd - rhineHalfWidth);
// A face touching the near plane retains ordinary hardware clipping. Never
// divide a behind-camera point by w or produce an enormous support triangle.
if (min(min(rsp.z+rsp.w,rsm.z+rsm.w),min(rep.z+rep.w,rem.z+rem.w)) > 0.001 &&
    min(min(rsp.w,rsm.w),min(rep.w,rem.w)) > 0.001) {
  vec2 a = rhinePixel(rs), b = rhinePixel(re);
  vec2 direction = b-a;
  float lengthPx = length(direction);
  if (lengthPx > 0.001 && lengthPx < 1000000.0) {
    direction /= lengthPx;
    vec2 side = vec2(-direction.y,direction.x);
    vec2 wa = rhinePixel(rsp)-rhinePixel(rsm);
    vec2 wb = rhinePixel(rep)-rhinePixel(rem);
    // Preserve winding, hence the original front/back-face culling.
    side *= dot(wa+wb,side) >= 0.0 ? 1.0 : -1.0;
    vRhineWidths = vec2(abs(dot(wa,side)),abs(dot(wb,side)));
    vRhineSide = side;
    vRhineStart = a; vRhineEnd = b;
    vRhineValid = 1.0;
    float t = rhineCorner.x;
    // A diagonal pixel footprint is wider along the line normal. Accounting
    // for both screen axes avoids brightness beating on 45-degree strips.
    float radius = abs(direction.x)+abs(direction.y);
    vec2 p = mix(a,b,t) + side * rhineCorner.y * (mix(vRhineWidths.x,vRhineWidths.y,t)*0.5 + radius)
      + direction * (t*2.0-1.0)*radius;
    vec4 centerClip = mix(rs,re,t);
    gl_Position.xy = (p / rhineViewport * 2.0 - 1.0) * centerClip.w;
    gl_Position.z = centerClip.z;
    gl_Position.w = centerClip.w;
  }
}
`;
const fragment = `
${THIN_COVERAGE_GLSL}
float rhineFaceCoverage() {
  if (vRhineValid < 0.5) return 1.0;
  vec2 segment = vRhineEnd-vRhineStart;
  float len = length(segment);
  vec2 axis = segment/len;
  vec2 relative = gl_FragCoord.xy-vRhineStart;
  float along = dot(relative,axis);
  float distance = dot(relative,vec2(-axis.y,axis.x));
  float width = mix(vRhineWidths.x,vRhineWidths.y,clamp(along/len,0.0,1.0));
  float radius = abs(axis.x)+abs(axis.y);
  return rhineThinCoverage(distance,width,radius) * rhineThinCoverage(along-len*0.5,len,radius);
}
vec3 rhineFaceNormal() {
  vec2 segment = vRhineEnd-vRhineStart;
  float len = length(segment);
  vec2 relative = gl_FragCoord.xy-vRhineStart;
  float t = clamp(dot(relative,segment)/(len*len),0.0,1.0);
  float width = mix(vRhineWidths.x,vRhineWidths.y,t);
  float across = clamp(0.5+dot(relative,vRhineSide)/max(width,1e-6),0.0,1.0);
  // Preserve the authored normal gradient in its true footprint, never stretch
  // it over the support quad. A subpixel bevel uses its mean normal smoothly.
  across = mix(0.5,across,smoothstep(0.25,1.5,width));
  return normalize(mix(vRhineNormal0,vRhineNormal1,across));
}
`;

/** Apply after the scene's lighting/appearance callbacks have been installed. */
const configured = new WeakSet<THREE.Material>();
export function configureThinFaceMaterial(material: THREE.MeshPhysicalMaterial) {
  if (configured.has(material)) return;
  configured.add(material);
  material.userData.thinFaceCoverage = true;
  material.transparent = true;
  material.depthWrite = false;
  material.alphaToCoverage = false;
  material.premultipliedAlpha = false;
  material.blending = THREE.NormalBlending;
  const viewport = { value: new THREE.Vector2(1, 1) };
  const current = new THREE.Vector4();
  const beforeRender = material.onBeforeRender;
  material.onBeforeRender = function(renderer, scene, camera, geometry, object, group) {
    beforeRender.call(this, renderer, scene, camera, geometry, object, group);
    renderer.getCurrentViewport(current);
    viewport.value.set(Math.max(1, current.z), Math.max(1, current.w));
  };
  const compile = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  material.onBeforeCompile = function(shader, renderer) {
    compile.call(this, shader, renderer);
    shader.uniforms.rhineViewport = viewport;
    shader.vertexShader = declarations + vertex + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace("#include <project_vertex>", project);
    shader.fragmentShader = declarations + fragment + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace("#include <normal_fragment_begin>", `
      #include <normal_fragment_begin>
      if (vRhineValid > 0.5) {
        normal = rhineFaceNormal();
        #ifdef DOUBLE_SIDED
          normal *= faceDirection;
        #endif
        nonPerturbedNormal = normal;
      }
    `);
    // The original RGB already contains physical transmission. Alpha is only
    // pixel coverage here; multiplying by transmissionAlpha again fades twice.
    shader.fragmentShader = shader.fragmentShader.replace("#include <opaque_fragment>", `
      #include <opaque_fragment>
      gl_FragColor.a = opacity * rhineFaceCoverage();
    `);
  };
  material.customProgramCacheKey = () => `${key}-thin-face-coverage-v1`;
  material.needsUpdate = true;
}
