import * as THREE from 'three';
import { MUSIC_CASE_ASSET } from '/src/music-case-asset.ts';

// Deliberately not part of the product. TS private fields compile to ordinary
// properties; this page inspects them without modifying production interfaces.
const W = 1280, H = 720, COUNT = 60, DT = 1 / 60, SEED = 0x5248494e;
const MODES = [
  { id: 'baseline', samples: 0, smaa: false },
  { id: 'msaa', samples: 4, smaa: false },
  { id: 'smaa', samples: 0, smaa: true },
  { id: 'combined', samples: 4, smaa: true },
];
const SELECTED_FRAMES = [0, 20, 40, 59];
const $ = id => document.getElementById(id);
// Rendering timestamps are synthetic; yielding must not depend on the browser's
// display refresh scheduling. This does not alter visibility or throttling flags.
const taskChannel = new MessageChannel(), tasks = [];
taskChannel.port1.onmessage = () => tasks.shift()?.();
const yieldTask = () => new Promise(resolve => { tasks.push(resolve); taskChannel.port2.postMessage(0); });
const visibility = () => ({ visibilityState: document.visibilityState, hidden: document.hidden });
const host = $('host');
const query = new URLSearchParams(location.search);
if (['checkpoint-aa4', 'current-product', 'all', 'subpixel'].includes(query.get('comparison'))) $('comparison').value = query.get('comparison');
const asset = new URL(query.get('asset') || `/${MUSIC_CASE_ASSET}`, location.origin);
if (asset.origin !== location.origin || !asset.pathname.endsWith('.glb')) throw new Error('Only a same-origin GLB asset is allowed.');
$('asset').value = asset.pathname + asset.search;
let archive, report, running = false, cancelled = false, thumbnails = [], crops = [];
let fullSheet, cropSheet;
const contexts = new Map();
const error = reason => { $('status').textContent = `失败：${reason?.message || reason}`; console.error(reason); };
window.addEventListener('error', event => error(event.error || event.message));
window.addEventListener('unhandledrejection', event => error(event.reason));

function seeded(perform) {
  const random = Math.random; let seed = SEED;
  Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  try { return perform(); } finally { Math.random = random; }
}
function fixedDimensions() {
  const { renderer, composer, ao } = archive;
  // Quality original is unchanged; only its device-dependent ratio is pinned
  // so OS display scaling cannot silently alter one run's sampling density.
  renderer.setPixelRatio(1); renderer.setSize(W, H, false);
  composer.setPixelRatio(1); composer.setSize(W, H); ao.setSize(W, H);
  archive.camera.aspect = W / H; archive.camera.updateProjectionMatrix();
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  if (size.x !== W || size.y !== H) throw new Error(`Unexpected buffer ${size.x}×${size.y}`);
}
function configureAA(mode) {
  const { renderer, composer, smaa } = archive;
  if (mode.keepProduction) { fixedDimensions(); return; }
  if (mode.samples > renderer.capabilities.maxSamples) throw new Error(`GPU only supports ${renderer.capabilities.maxSamples} samples`);
  // The GPU storage must be reallocated after changing samples. Keep all sizes,
  // shadow maps, SSAO, bokeh, materials and transmission settings identical.
  for (const target of [composer.renderTarget1, composer.renderTarget2]) {
    target.dispose(); target.samples = mode.samples;
  }
  smaa.enabled = mode.smaa;
  fixedDimensions();
}
async function preparePose(theme, pose) {
  archive.setReduced(true);
  archive.showMusicArchiveImmediately(0);
  archive.setTheme(theme, false);
  archive.setMode(pose);
  archive.finishDecryption();
  for (let i = 1; i <= 120; i++) {
    archive.update(i * DT);
    if (i % 30 === 0) await yieldTask();
  }
  archive.finishDecryption(); archive.update(121 * DT);
  fixedDimensions();
  // Do not call ArchiveScene.update in the measured sequence: it would add
  // idle waves and camera damping. Reuse its settled geometry/light/shader state.
  const camera = archive.camera;
  return {
    position: camera.position.clone(), quaternion: camera.quaternion.clone(),
    model: archive.model.position.clone(),
    right: new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion),
    up: new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion),
    unitsPerPixel: 2 * camera.position.distanceTo(archive.cameraAim) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / H,
    stats: archive.getStats(),
  };
}
function moveFrame(base, index, motion, step) {
  const pixels = (index - (COUNT - 1) / 2) * step;
  const world = pixels * base.unitsPerPixel;
  archive.camera.position.copy(base.position); archive.camera.quaternion.copy(base.quaternion);
  archive.model.position.copy(base.model);
  if (motion === 'camera' || motion === 'both') archive.camera.position.addScaledVector(base.right, world).addScaledVector(base.up, world * 0.37);
  if (motion === 'object' || motion === 'both') archive.model.position.addScaledVector(base.right, motion === 'both' ? -world : world);
  archive.camera.updateMatrixWorld(); archive.scene.updateMatrixWorld(true);
}
function draw() {
  const { renderer, composer } = archive;
  renderer.info.reset(); renderer.setRenderTarget(null);
  if (renderer.shadowMap.enabled) renderer.shadowMap.needsUpdate = true;
  composer.render(DT);
}
function readPixels() {
  const gl = archive.renderer.getContext();
  if (gl.getParameter(gl.FRAMEBUFFER_BINDING) !== null) throw new Error('Readback is not the final screen framebuffer.');
  const pixels = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const status = gl.getError();
  if (status !== gl.NO_ERROR) throw new Error(`GPU readPixels error: 0x${status.toString(16)}`);
  return pixels;
}
const linear = Float32Array.from({ length: 256 }, (_, i) => { const v = i / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
function luminance(pixels) {
  const result = new Float32Array(W * H);
  for (let i = 0, p = 0; i < result.length; i++, p += 4) result[i] = 0.2126 * linear[pixels[p]] + 0.7152 * linear[pixels[p + 1]] + 0.0722 * linear[pixels[p + 2]];
  return result;
}
function baselineMask(values) {
  const mask = new Uint8Array(W * H), radius = 5, threshold = 0.05;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (Math.abs(values[i + 1] - values[i - 1]) + Math.abs(values[i + W] - values[i - W]) < threshold) continue;
    for (let dy = -radius; dy <= radius; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= H) continue;
      mask.fill(1, yy * W + Math.max(0, x - radius), yy * W + Math.min(W, x + radius + 1));
    }
  }
  return mask;
}
function secondDifference(a, b, c, mask) {
  let all = 0, edge = 0, count = 0, over = 0;
  const hist = new Uint32Array(2049);
  for (let i = 0; i < a.length; i++) {
    const value = Math.abs(c[i] - 2 * b[i] + a[i]); all += value;
    if (mask[i]) { edge += value; count++; if (value > 0.01) over++; hist[Math.min(2048, Math.floor(value * 1024))]++; }
  }
  let cumulative = 0, p95 = 0;
  for (let i = 0; i < hist.length; i++) { cumulative += hist[i]; if (cumulative >= count * 0.95) { p95 = i / 1024; break; } }
  return { meanAbs: all / a.length, edgeMeanAbs: edge / Math.max(1, count), edgeP95Approx: p95, edgeFractionAbove001: over / Math.max(1, count), edgePixels: count };
}
function gradient(values, mask) {
  let sum = 0, count = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x; if (!mask[i]) continue;
    sum += (Math.abs(values[i + 1] - values[i - 1]) + Math.abs(values[i + W] - values[i - W])) / 2; count++;
  }
  return sum / Math.max(1, count);
}
function frameCanvas(pixels) {
  // WebGL's origin is bottom-left. This vertical flip only prepares screenshots;
  // all numerical comparisons use the unmodified same-orientation GPU buffers.
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const flipped = new Uint8ClampedArray(pixels.length);
  for (let y = 0; y < H; y++) flipped.set(pixels.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  canvas.getContext('2d').putImageData(new ImageData(flipped, W, H), 0, 0);
  return canvas;
}
const mean = values => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
function stats(values) { const sorted = [...values].sort((a, b) => a - b); return { mean: mean(values), p95: sorted[Math.floor((sorted.length - 1) * 0.95)] ?? null, max: sorted.at(-1) ?? null }; }
function timingQueries() {
  const gl = archive.renderer.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2'), pending = [];
  let observedDisjoint = false, timedOut = 0;
  return {
    supported: !!ext,
    get disjoint() { return observedDisjoint; },
    get timedOut() { return timedOut; },
    start(record) { if (!ext) return null; const query = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, query); pending.push({ query, record }); return query; },
    end(query) { if (query) gl.endQuery(ext.TIME_ELAPSED_EXT); },
    harvest() {
      if (!ext) return;
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      observedDisjoint ||= !!disjoint;
      for (let i = pending.length - 1; i >= 0; i--) {
        const item = pending[i];
        if (disjoint || gl.getQueryParameter(item.query, gl.QUERY_RESULT_AVAILABLE)) {
          item.record.gpuRenderMs = disjoint ? null : gl.getQueryParameter(item.query, gl.QUERY_RESULT) / 1e6;
          if (disjoint) item.record.gpuDisjoint = true;
          gl.deleteQuery(item.query); pending.splice(i, 1);
        }
      }
    },
    async finish() {
      const deadline = performance.now() + 3000;
      while (pending.length && performance.now() < deadline && !cancelled) { await yieldTask(); this.harvest(); }
      for (const item of pending) { item.record.gpuQueryTimedOut = true; timedOut++; gl.deleteQuery(item.query); }
      pending.length = 0;
    },
  };
}
async function runCase(theme, mode, base, options, mask) {
  configureAA(mode);
  for (let i = 0; i < 12; i++) { moveFrame(base, 0, options.motion, options.step); draw(); readPixels(); if (i % 3 === 0) await yieldTask(); }
  const records = [], images = [], cropImages = [], timer = timingQueries();
  const caseStarted = performance.now(), visibilityAtStart = visibility();
  let previousFrameStarted;
  let previous2, previous, firstGradient;
  for (let index = 0; index < COUNT; index++) {
    if (cancelled) throw new Error('用户停止，当前未完成组不计入比较');
    const yieldStarted = performance.now();
    await yieldTask();
    const frameStarted = performance.now(), yieldWaitMs = frameStarted - yieldStarted;
    timer.harvest();
    moveFrame(base, index, options.motion, options.step);
    const record = { index, simulationTime: index * DT, gpuRenderMs: null, yieldWaitMs,
      wallStepMs: previousFrameStarted === undefined ? null : frameStarted - previousFrameStarted, ...visibility() };
    previousFrameStarted = frameStarted;
    const query = timer.start(record), start = performance.now();
    draw(); record.cpuSubmitMs = performance.now() - start; timer.end(query);
    const readStart = performance.now(), pixels = readPixels();
    record.readbackMs = performance.now() - readStart;
    record.submitAndReadbackMs = performance.now() - start;
    record.renderer = { ...archive.renderer.info.render, geometries: archive.renderer.info.memory.geometries, textures: archive.renderer.info.memory.textures };
    const analysisStart = performance.now(), values = luminance(pixels);
    if (!mask) mask = baselineMask(values);
    if (index === 0) {
      const min = values.reduce((a, b) => Math.min(a, b), 1), max = values.reduce((a, b) => Math.max(a, b), 0);
      if (max - min < 0.02) throw new Error('GPU readback has insufficient image variation; refusing to measure a blank frame.');
      firstGradient = gradient(values, mask);
    }
    if (previous2) record.flicker = secondDifference(previous2, previous, values, mask);
    record.analysisMs = performance.now() - analysisStart;
    if (SELECTED_FRAMES.includes(index)) {
      const canvas = frameCanvas(pixels);
      images.push(canvas);
      const crop = document.createElement('canvas'); crop.width = 320; crop.height = 240;
      crop.getContext('2d').drawImage(canvas, options.cropX, options.cropY, 320, 240, 0, 0, 320, 240); cropImages.push(crop);
    }
    previous2 = previous; previous = values; records.push(record);
    $('progress').textContent = `${theme} / ${mode.id}: ${index + 1}/${COUNT}`;
  }
  await timer.finish();
  const flicker = records.filter(frame => frame.flicker).map(frame => frame.flicker);
  const summary = {
    caseWallMs: performance.now() - caseStarted, visibilityAtStart, visibilityAtEnd: visibility(),
    yieldWaitMs: stats(records.map(f => f.yieldWaitMs)), wallStepMs: stats(records.filter(f => f.wallStepMs !== null).map(f => f.wallStepMs)),
    timerQuery: { supported: timer.supported, disjointObserved: timer.disjoint, unfinishedQueries: timer.timedOut, finishDeadlineMs: 3000 },
    flickerMeanAbs: mean(flicker.map(f => f.meanAbs)), edgeFlickerMeanAbs: mean(flicker.map(f => f.edgeMeanAbs)),
    edgeP95Approx: mean(flicker.map(f => f.edgeP95Approx)), edgeFractionAbove001: mean(flicker.map(f => f.edgeFractionAbove001)),
    edgePixels: flicker[0]?.edgePixels, firstFrameGradient: firstGradient,
    cpuSubmitMs: stats(records.map(f => f.cpuSubmitMs)), readbackMs: stats(records.map(f => f.readbackMs)),
    submitAndReadbackMs: stats(records.map(f => f.submitAndReadbackMs)), analysisMs: stats(records.map(f => f.analysisMs)),
    gpuRenderMs: !timer.disjoint && records.some(f => f.gpuRenderMs !== null) ? stats(records.filter(f => f.gpuRenderMs !== null).map(f => f.gpuRenderMs)) : null,
    drawCalls: stats(records.map(f => f.renderer.calls)), triangles: stats(records.map(f => f.renderer.triangles)),
  };
  thumbnails.push({ label: `${theme} / ${mode.id}`, images }); crops.push({ label: `${theme} / ${mode.id}`, images: cropImages });
  return { result: { theme, code: mode.code ?? (mode.keepProduction ? 'current' : 'checkpoint'), mode,
    // Current code multisamples only its dedicated scene pass; checkpoints used both composer buffers.
    actualPipeline: { samples: archive.scenePass ? [archive.scenePass.samples] : [archive.composer.renderTarget1.samples, archive.composer.renderTarget2.samples], smaa: archive.smaa.enabled,
      shadows: archive.light.shadow.mapSize.x, aoSamples: archive.aoKernelSize, aoResolution: [archive.ao.width, archive.ao.height],
      bokeh: archive.bokeh.enabled, transmission: archive.renderer.transmissionResolutionScale },
    dimensions: { width: W, height: H, pixelRatio: 1 }, summary, frames: records }, mask };
}
function makeSheet(rows, width, height) {
  const canvas = document.createElement('canvas'); canvas.width = width * SELECTED_FRAMES.length; canvas.height = rows.length * (height + 30);
  const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.font = '14px sans-serif';
  rows.forEach((row, y) => row.images.forEach((image, x) => {
    context.fillStyle = '#111'; context.fillText(`${row.label} · frame ${SELECTED_FRAMES[x]}`, x * width + 8, y * (height + 30) + 20);
    context.drawImage(image, x * width, y * (height + 30) + 30, width, height);
  })); return canvas;
}
function showResults() {
  $('results').innerHTML = '<table><thead><tr><th>模式</th><th>全帧 D2</th><th>边缘 D2</th><th>相对 baseline</th><th>边缘梯度</th><th>GPU ms</th><th>提交＋读回 ms</th><th>calls</th></tr></thead><tbody>' + report.cases.map(item => {
    const s = item.summary, baseline = report.cases.find(c => c.theme === item.theme && ['baseline','portable-checkpoint'].includes(c.mode.id))?.summary;
    return `<tr><td>${item.theme} / ${item.mode.id}</td><td>${s.flickerMeanAbs.toExponential(3)}</td><td>${s.edgeFlickerMeanAbs.toExponential(3)}</td><td>${baseline?.edgeFlickerMeanAbs ? (s.edgeFlickerMeanAbs / baseline.edgeFlickerMeanAbs).toFixed(3) : '—'}</td><td>${s.firstFrameGradient.toFixed(5)}</td><td>${s.gpuRenderMs?.mean.toFixed(2) ?? '不可用'}</td><td>${s.submitAndReadbackMs.mean.toFixed(2)}</td><td>${s.drawCalls.mean}</td></tr>`;
  }).join('') + '</tbody></table>';
  fullSheet = makeSheet(thumbnails, 320, 180); cropSheet = makeSheet(crops, 320, 240);
  $('frames').replaceChildren(fullSheet); $('crops').replaceChildren(cropSheet);
  $('json').disabled = $('sheet').disabled = $('crop-sheet').disabled = report.cases.length === 0;
}
function download(blob, name) { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
$('json').onclick = () => download(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), `rhine-edge-${report.options.pose}-${report.options.motion}.json`);
$('sheet').onclick = () => fullSheet.toBlob(blob => download(blob, 'rhine-edge-contact-sheet.png'));
$('crop-sheet').onclick = () => cropSheet.toBlob(blob => download(blob, 'rhine-edge-crops-1to1.png'));
$('reload').onclick = () => { const url = new URL(location.href); url.searchParams.set('asset', $('asset').value); location.assign(url); };
$('cancel').onclick = () => { cancelled = true; };
$('run').onclick = async () => {
  if (running) return; running = true; cancelled = false; thumbnails = []; crops = [];
  const options = { comparison: $('comparison').value, pose: $('pose').value, motion: $('motion').value, step: Math.min(0.5, Math.max(0, Number($('step').value))),
    cropX: Math.min(960, Math.max(0, Number($('crop-x').value))), cropY: Math.min(480, Math.max(0, Number($('crop-y').value))) };
  $('run').disabled = true; $('cancel').disabled = false; $('reload').disabled = true;
  $('json').disabled = $('sheet').disabled = $('crop-sheet').disabled = true;
  report = { version: 1, createdAt: new Date().toISOString(), asset: asset.pathname + asset.search, options, environment,
    methodology: { gpuReadback: 'WebGL2 gl.readPixels(default framebuffer, RGBA/UNSIGNED_BYTE) immediately after composer.render',
      luminance: 'sRGB bytes decoded to linear RGB; Rec.709 coefficients', statistic: 'mean(abs(L[t]-2*L[t-1]+L[t-2])), 58 frame triples',
      mask: 'baseline first frame gradient >0.05, dilated 5px; identical mask reused for all four modes of each theme',
      measurementNote: 'Controlled subpixel translation of a settled real scene, not full application animation or perceptual certification.',
      timingNote: 'Readback stalls GPU. CPU submit and GPU timer (when supported) are separate; do not interpret readback benchmark as app FPS.',
      yieldStrategy: 'MessageChannel posted task between measured frames; no requestAnimationFrame and no browser visibility override',
      gpuQueryFinishDeadlineMs: 3000, frames: COUNT, dt: DT, warmupFrames: 12 }, cases: [] };
  try {
    const themes = $('themes').value === 'both' ? ['day', 'night'] : [$('themes').value];
    for (const theme of themes) {
      $('status').textContent = `准备 ${theme} 姿态…`;
      let mask;
      const selectedModes = options.comparison === 'subpixel' ? [
        { id: 'portable-checkpoint', keepProduction: true, code: 'checkpoint' },
        { id: 'current-product', keepProduction: true, code: 'current' },
      ] : options.comparison === 'current-product' ? [{ id: 'current-product', keepProduction: true }]
        : options.comparison === 'all' ? [...MODES, { id: 'current-product', keepProduction: true }] : MODES;
      let base;
      let previousCode;
      for (const mode of selectedModes) {
        const code = mode.code ?? (mode.keepProduction ? 'current' : 'checkpoint');
        if (code !== previousCode) {
          await useContext(code);
          base = await preparePose(theme, options.pose);
          report.casesPose ??= {}; report.casesPose[`${theme}/${code}`] = base.stats;
          previousCode = code;
        }
        $('status').textContent = `测量 ${theme} / ${mode.id}`;
        const measured = await runCase(theme, mode, base, options, mask); mask = measured.mask; report.cases.push(measured.result); showResults();
      }
      moveFrame(base, (COUNT - 1) / 2, 'static', 0);
    }
    $('status').textContent = `完成 ${report.cases.length} 组；请下载 JSON 和两张对照图。`;
  } catch (reason) { report.error = String(reason); error(reason); showResults(); }
  finally { running = false; $('run').disabled = false; $('cancel').disabled = true; $('reload').disabled = false; }
};

let environment;
async function useContext(code) {
  if (contexts.has(code)) {
    archive = contexts.get(code).archive;
    host.replaceChildren(archive.renderer.domElement);
    return;
  }
  const prefix = code === 'checkpoint' ? (query.get('comparison') === 'subpixel' ? '/.tools/subpixel-baseline/src/' : '/.tools/edge-baseline/src/') : '/src/';
  const [sceneModule, dataModule, demoModule, qualityModule] = await Promise.all([
    import(/* @vite-ignore */ `${prefix}scene.ts`), import(/* @vite-ignore */ `${prefix}data.ts`),
    import(/* @vite-ignore */ `${prefix}${code === 'checkpoint' ? '' : 'local_music/data/'}demo-library.ts`), import(/* @vite-ignore */ `${prefix}render-quality.ts`),
  ]);
  dataModule.setMusicAlbums(demoModule.demoAlbums, demoModule.demoGenres);
  host.replaceChildren();
  archive = seeded(() => new sceneModule.ArchiveScene(host)); archive.enableSelectionLighting();
  archive.setQuality({ ...qualityModule.qualityPresets.original }); fixedDimensions();
  await archive.load(asset.href);
  // SMAA lookup images are asynchronous even when they are data URLs.
  await Promise.all([archive.smaa._areaTexture.image, archive.smaa._searchTexture.image].map(image => image.decode()));
  const gl = archive.renderer.getContext();
  const contextEnvironment = { code, prefix, userAgent: navigator.userAgent, browserDevicePixelRatio: devicePixelRatio, effectivePixelRatio: 1,
    visibilityAtLoad: visibility(), yieldStrategy: 'MessageChannel',
    width: W, height: H, quality: { ...qualityModule.qualityPresets.original }, randomSeed: SEED, renderer: gl.getParameter(gl.RENDERER),
    vendor: gl.getParameter(gl.VENDOR), version: gl.getParameter(gl.VERSION), maxSamples: archive.renderer.capabilities.maxSamples,
    rgba16fSamples: Array.from(gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA16F, gl.SAMPLES)),
    timerQuery: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'), readback: 'actual final default framebuffer' };
  if (contextEnvironment.maxSamples < 4 || !contextEnvironment.rgba16fSamples.includes(4)) throw new Error('This GPU cannot run the requested 4x MSAA floating-point target comparison.');
  contexts.set(code, { archive, environment: contextEnvironment });
  environment = [...contexts.values()].map(context => context.environment);
  if (report) report.environment = environment;
  $('environment').textContent = JSON.stringify(environment, null, 2);
}
try {
  await useContext($('comparison').value === 'current-product' ? 'current' : 'checkpoint');
  const base = await preparePose('day', 'detail'); moveFrame(base, 0, 'camera', 0.1);
  configureAA(['current-product','subpixel'].includes($('comparison').value) ? { keepProduction: true } : MODES[0]); draw(); readPixels();
  $('status').textContent = '已加载。点击 Run 开始确定性比较。'; $('run').disabled = false;
} catch (reason) { error(reason); }
