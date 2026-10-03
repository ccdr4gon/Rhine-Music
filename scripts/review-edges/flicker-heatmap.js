import * as THREE from 'three';
import { MUSIC_CASE_ASSET } from '/src/music-case-asset.ts';

// Deliberately not part of the product. Locates which pixels flicker under a
// fixed subpixel motion, so a fix can be judged by area and by 1:1 frames, not
// only by one mean. TS private fields compile to ordinary properties.
const q = new URLSearchParams(location.search);
const W = 1280, H = 720, COUNT = 60, DT = 1 / 60, SEED = 0x5248494e;
const code = q.get('code') === 'checkpoint' ? 'checkpoint' : 'current';
const theme = q.get('theme') || 'day', pose = q.get('pose') || 'archive', motion = q.get('motion') || 'camera';
const step = Number(q.get('step') || 0.1), ss = Math.max(1, Math.round(Number(q.get('ss') || 1)));
const off = new Set((q.get('off') || '').split(',').filter(Boolean));
const [cx, cy, cw, ch] = (q.get('crop') || '160,170,200,120').split(',').map(Number);
const gain = Number(q.get('gain') || 20);
const $ = id => document.getElementById(id);
const status = text => { $('status').textContent = text; };
window.addEventListener('error', event => { window.__error = String(event.error?.stack || event.message); status(`失败：${window.__error}`); });
window.addEventListener('unhandledrejection', event => { window.__error = String(event.reason?.stack || event.reason); status(`失败：${window.__error}`); });

// Prepare the checkpoint snapshot as described in README.md before using code=checkpoint.
const prefix = code === 'checkpoint' ? '/.tools/subpixel-baseline/src/' : '/src/';
const [sceneModule, dataModule, demoModule, qualityModule] = await Promise.all([
  import(/* @vite-ignore */ `${prefix}scene.ts`), import(/* @vite-ignore */ `${prefix}data.ts`),
  import(/* @vite-ignore */ `${prefix}demo-library.ts`), import(/* @vite-ignore */ `${prefix}render-quality.ts`),
]);
dataModule.setMusicAlbums(demoModule.demoAlbums, demoModule.demoGenres);
function seeded(perform) {
  const random = Math.random; let seed = SEED;
  Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  try { return perform(); } finally { Math.random = random; }
}
const archive = seeded(() => new sceneModule.ArchiveScene($('host')));
archive.enableSelectionLighting();
archive.setQuality({ ...qualityModule.qualityPresets.original });
function fixedDimensions() {
  archive.renderer.setPixelRatio(ss); archive.renderer.setSize(W, H, false);
  archive.composer.setPixelRatio(ss); archive.composer.setSize(W, H); archive.ao.setSize(W * ss, H * ss);
  archive.camera.aspect = W / H; archive.camera.updateProjectionMatrix();
}
fixedDimensions();
await archive.load(`/${MUSIC_CASE_ASSET}`);
archive.setReduced(true);
archive.showMusicArchiveImmediately(0);
archive.setTheme(theme, false);
archive.setMode(pose);
archive.finishDecryption();
for (let i = 1; i <= 120; i++) archive.update(i * DT);
archive.finishDecryption(); archive.update(121 * DT);
// Covers decode asynchronously after their slots are assigned; measure real art.
// Checkpoints decode on the main thread (covers.images); current code paints
// tiles in a worker (covers.tiles / selectedRequest).
for (let round = 0; round < 400; round++) {
  const covers = archive.covers;
  if (covers.images) { await Promise.all([...covers.images.values()]); if (round >= 2) break; }
  else if (covers.tiles.every(tile => !tile || tile.ready) && covers.selectedRequest === undefined) break;
  await new Promise(resolve => setTimeout(resolve, 25));
}
archive.update(122 * DT);
fixedDimensions();
// Checkpoints multisampled both composer buffers; current code only its scene pass.
const sampleTargets = archive.scenePass ? [archive.scenePass.target] : [archive.composer.renderTarget1, archive.composer.renderTarget2];
if (q.get('samples') !== null) for (const target of sampleTargets) { target.dispose(); target.samples = Number(q.get('samples')); }
if (off.has('ao')) archive.ao.enabled = false;
if (off.has('bokeh')) archive.bokeh.enabled = false;
if (off.has('shadow')) {
  archive.renderer.shadowMap.enabled = false; archive.light.castShadow = false;
  archive.scene.traverse(object => { if (object.material) for (const material of [].concat(object.material)) material.needsUpdate = true; });
}
if (off.has('covers')) { archive.covers.array.visible = false; archive.covers.selected.visible = false; }
if (off.has('model')) archive.model.visible = false;
if (off.has('array')) for (const instance of archive.instances) instance.visible = false;

const camera = archive.camera;
const base = { position: camera.position.clone(), quaternion: camera.quaternion.clone(), model: archive.model.position.clone(),
  right: new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion), up: new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion),
  unitsPerPixel: 2 * camera.position.distanceTo(archive.cameraAim) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / H };
function moveFrame(index) {
  const world = (index - (COUNT - 1) / 2) * step * base.unitsPerPixel;
  camera.position.copy(base.position); camera.quaternion.copy(base.quaternion); archive.model.position.copy(base.model);
  if (motion === 'camera') camera.position.addScaledVector(base.right, world).addScaledVector(base.up, world * 0.37);
  if (motion === 'object') archive.model.position.addScaledVector(base.right, world);
  camera.updateMatrixWorld(); archive.scene.updateMatrixWorld(true);
}
const gl = archive.renderer.getContext();
const draw = () => {
  archive.renderer.info.reset(); archive.renderer.setRenderTarget(null);
  if (archive.renderer.shadowMap.enabled) archive.renderer.shadowMap.needsUpdate = true;
  archive.composer.render(DT);
};
const show = (title, canvas) => {
  const figure = document.createElement('figure'), image = new Image();
  image.src = canvas.toDataURL('image/png');
  figure.append(Object.assign(document.createElement('figcaption'), { textContent: title }), image);
  $('images').append(figure);
  return image.src;
};
const finish = (result, images = {}) => {
  window.__result = result; window.__out = images;
  $('result').textContent = JSON.stringify(result, null, 2);
  status('完成。');
};

if (q.get('mode') === 'gpu') {
  // Complete frames (shadow, transmission, SSAO, depth of field, output), no readback.
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) throw new Error('此浏览器不提供 GPU 计时查询');
  const queries = [];
  for (let i = 0; i < 40; i++) {
    moveFrame(i % COUNT);
    const query = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    draw(); gl.endQuery(ext.TIME_ELAPSED_EXT); queries.push(query);
    if (i % 4 === 3) await new Promise(resolve => setTimeout(resolve, 0));
  }
  const times = [];
  for (const query of queries) {
    for (let tries = 0; tries < 200 && !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE); tries++) await new Promise(resolve => setTimeout(resolve, 5));
    if (!gl.getParameter(ext.GPU_DISJOINT_EXT) && gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) times.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
    gl.deleteQuery(query);
  }
  times.sort((a, b) => a - b);
  finish({ code, mode: 'gpu', theme, pose, pixelRatio: ss, samples: sampleTargets[0].samples, measured: times.length,
    gpuMsMedian: +times[times.length >> 1]?.toFixed(3), gpuMsP90: +times[Math.floor(times.length * 0.9)]?.toFixed(3) });
} else {
  const FW = W * ss, FH = H * ss, raw = new Uint8Array(FW * FH * 4);
  const linear = Float32Array.from({ length: 256 }, (_, i) => { const v = i / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  const encode = v => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.min(1, v), 1 / 2.4) - 0.055));
  // Linear RGB, top row first; supersampled frames are box-filtered back to W×H.
  function frame() {
    draw();
    gl.readPixels(0, 0, FW, FH, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const rgb = new Float32Array(W * H * 3), n = ss * ss;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const p = ((FH - 1 - y * ss - sy) * FW + x * ss + sx) * 4;
        r += linear[raw[p]]; g += linear[raw[p + 1]]; b += linear[raw[p + 2]];
      }
      const o = (y * W + x) * 3; rgb[o] = r / n; rgb[o + 1] = g / n; rgb[o + 2] = b / n;
    }
    return rgb;
  }
  const luminance = rgb => Float32Array.from({ length: W * H }, (_, i) => 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2]);
  function canvasOf(rgb, x0 = 0, y0 = 0, w = W, h = H, zoom = 1) {
    const canvas = Object.assign(document.createElement('canvas'), { width: w * zoom, height: h * zoom });
    const context = canvas.getContext('2d'), image = context.createImageData(canvas.width, canvas.height);
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const s = ((y0 + Math.floor(y / zoom)) * W + x0 + Math.floor(x / zoom)) * 3, d = (y * canvas.width + x) * 4;
      image.data[d] = encode(rgb[s]); image.data[d + 1] = encode(rgb[s + 1]); image.data[d + 2] = encode(rgb[s + 2]); image.data[d + 3] = 255;
    }
    context.putImageData(image, 0, 0); return canvas;
  }
  for (let i = 0; i < 6; i++) { moveFrame(0); frame(); }
  const d2 = new Float32Array(W * H), ZOOM = 3;
  const strip = Object.assign(document.createElement('canvas'), { width: cw * ZOOM * 4, height: ch * ZOOM * 2 });
  let a, b, first, triples = 0;
  for (let i = 0; i < COUNT; i++) {
    status(`帧 ${i + 1}/${COUNT}`);
    moveFrame(i);
    const rgb = frame(), l = luminance(rgb);
    if (i === 0) first = rgb;
    if (i >= 20 && i < 28) strip.getContext('2d').drawImage(canvasOf(rgb, cx, cy, cw, ch, ZOOM), ((i - 20) % 4) * cw * ZOOM, Math.floor((i - 20) / 4) * ch * ZOOM);
    if (a && b) { for (let p = 0; p < d2.length; p++) d2[p] += Math.abs(l[p] - 2 * b[p] + a[p]); triples++; }
    a = b; b = l;
    if (i % 10 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  // Dim grayscale frame underneath, flicker in red/yellow on top.
  const heat = new Float32Array(W * H * 3), firstLuminance = luminance(first);
  let total = 0, hot = 0;
  for (let p = 0; p < d2.length; p++) {
    d2[p] /= triples; total += d2[p]; if (d2[p] > 0.01) hot++;
    const v = Math.min(1, d2[p] * gain), g = firstLuminance[p] * 0.25;
    heat[p * 3] = Math.max(g, v); heat[p * 3 + 1] = Math.max(g, v * v); heat[p * 3 + 2] = g * (1 - v);
  }
  const info = archive.renderer.info.render;
  finish({ code, theme, pose, motion, step, pixelRatio: ss, off: [...off], samples: sampleTargets[0].samples, smaa: archive.smaa.enabled,
    meanD2x1e4: +(total / d2.length * 1e4).toFixed(3), hotFraction: +(hot / d2.length).toFixed(5), calls: info.calls }, {
    frame: show('首帧（线性→sRGB）', canvasOf(first)),
    heat: show(`平均二阶差 × ${gain}`, canvasOf(heat)),
    strip: show(`第 21–28 帧，裁切 ${cx},${cy} ${cw}×${ch}，放大 ${ZOOM}×`, strip),
  });
}
