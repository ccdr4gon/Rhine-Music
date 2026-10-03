import * as THREE from 'three';
import { configureThinFaceMaterial } from '/src/thin-face-material.ts';
import { splitThinFaces } from '/src/thin-face-geometry.ts';

const SIZE = 256, WORLD_PER_PIXEL = 0.02, LENGTH = 100, FRAMES = 24;
const WIDTHS = [0.8, 0.4, 0.2, 0.1], ANGLES = [0, 15, 45, 80];
const MODES = ['baseline', 'candidate'];
const $ = id => document.getElementById(id);
const shaderErrors = [];
let report = null, running = false;
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, preserveDrawingBuffer: false });
renderer.setPixelRatio(1);
renderer.setSize(SIZE, SIZE, false);
renderer.setClearColor(0, 1);
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
  shaderErrors.push({ program: gl.getProgramInfoLog(program), vertex: gl.getShaderInfoLog(vertex), fragment: gl.getShaderInfoLog(fragment) });
};
$('renderer-host').append(renderer.domElement);
const gl = renderer.getContext();
const colorSamples = Array.from(gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA8, gl.SAMPLES));
const depthSamples = Array.from(gl.getInternalformatParameter(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, gl.SAMPLES));
const halfFloatExtension = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
const halfFloatSamples = halfFloatExtension ? Array.from(gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA16F, gl.SAMPLES)) : [];
const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
const environment = {
  threeRevision: THREE.REVISION, dimensions: [SIZE, SIZE], effectiveDpr: 1,
  rgba8Samples: colorSamples, rgba16fSamples: halfFloatSamples, halfFloatExtension, depth24Samples: depthSamples, requestedSamples: 4,
  renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
  vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
  userAgent: navigator.userAgent,
};
$('environment').textContent = JSON.stringify(environment, null, 2);
let target = null, readback = null, selectedFormat = 'half';
const linearPixels = new Float32Array(SIZE * SIZE * 4);
const halfLookup = Float32Array.from({ length: 65536 }, (_, bits) => THREE.DataUtils.fromHalfFloat(bits));
const camera = new THREE.OrthographicCamera(-SIZE * WORLD_PER_PIXEL / 2, SIZE * WORLD_PER_PIXEL / 2,
  SIZE * WORLD_PER_PIXEL / 2, -SIZE * WORLD_PER_PIXEL / 2, 0.1, 20);
camera.position.set(0, 0, 5);
camera.lookAt(0, 0, 0);
camera.updateProjectionMatrix();
const channel = new MessageChannel(), tasks = [];
channel.port1.onmessage = () => tasks.shift()?.();
const yieldTask = () => new Promise(resolve => { tasks.push(resolve); channel.port2.postMessage(0); });

function error(reason) {
  $('status').textContent = `失败：${reason?.message || reason}`;
  $('results').textContent = JSON.stringify({ error: String(reason), shaderErrors }, null, 2);
  console.error(reason);
}
window.addEventListener('error', event => error(event.error || event.message));
window.addEventListener('unhandledrejection', event => error(event.reason));

function readLinearPixels() {
  // Sentinel values and a known-color preflight catch silent readback refusal
  // as well as GL errors. HalfFloat never silently falls back to RGBA8.
  readback.fill(selectedFormat === 'half' ? 0x7e00 : 173);
  renderer.readRenderTargetPixels(target, 0, 0, SIZE, SIZE, readback);
  const glError = gl.getError();
  if (glError !== gl.NO_ERROR) throw new Error(`${selectedFormat} GPU readback error ${glError}; no format fallback was used`);
  for (let index = 0; index < readback.length; index++) {
    const value = selectedFormat === 'half' ? halfLookup[readback[index]] : readback[index] / 255;
    if (!Number.isFinite(value)) throw new Error(`Non-finite ${selectedFormat} readback at channel ${index}`);
    linearPixels[index] = value;
  }
  return linearPixels;
}

function prepareTarget(format) {
  selectedFormat = format;
  const samples = format === 'half' ? halfFloatSamples : colorSamples;
  if (!samples.includes(4) || !depthSamples.includes(4)) throw new Error(`此 GPU 不支持所选 ${format === 'half' ? 'RGBA16F' : 'RGBA8'} + DEPTH24 4× MSAA；不静默降级。`);
  target?.dispose();
  target = new THREE.WebGLRenderTarget(SIZE, SIZE, {
    type: format === 'half' ? THREE.HalfFloatType : THREE.UnsignedByteType,
    format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false, samples: 4,
  });
  target.texture.colorSpace = THREE.LinearSRGBColorSpace;
  readback = format === 'half' ? new Uint16Array(SIZE * SIZE * 4) : new Uint8Array(SIZE * SIZE * 4);
  renderer.setRenderTarget(target);
  renderer.setClearColor(new THREE.Color().setRGB(0.25, 0.5, 0.75, THREE.LinearSRGBColorSpace), 1);
  renderer.clear();
  const framebufferStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  renderer.setRenderTarget(null);
  if (framebufferStatus !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Framebuffer incomplete: ${framebufferStatus}`);
  const probe = readLinearPixels();
  const expected = [0.25, 0.5, 0.75, 1];
  const tolerance = format === 'half' ? 0.001 : 1 / 255;
  for (let channel = 0; channel < 4; channel++) {
    if (Math.abs(probe[channel] - expected[channel]) > tolerance) throw new Error(`${format} readback preflight mismatch: ${Array.from(probe.slice(0, 4))}`);
  }
  renderer.setClearColor(0, 1);
  return { format: format === 'half' ? 'RGBA16F' : 'RGBA8', readbackArray: readback.constructor.name,
    decodedBy: format === 'half' ? 'THREE.DataUtils.fromHalfFloat lookup' : 'byte / 255',
    samples: 4, framebufferComplete: true, knownColorPreflight: Array.from(probe.slice(0, 4)) };
}

function makeFixture(widthPx, degrees, mode, occluded) {
  const geometry = new THREE.PlaneGeometry(widthPx * WORLD_PER_PIXEL, LENGTH * WORLD_PER_PIXEL);
  const material = new THREE.MeshPhysicalMaterial({
    color: 0x000000, emissive: 0xffffff, emissiveIntensity: 1,
    roughness: 1, metalness: 0, transmission: 0, opacity: 1, toneMapped: false,
  });
  const scene = new THREE.Scene();
  let renderedGeometry = geometry;
  let body = null;
  let faceCount = 0;
  if (mode === 'candidate') {
    const split = splitThinFaces(geometry);
    if (!split.strips || split.faceCount !== 1) throw new Error(`Expected one extracted thin rectangle; got ${split.faceCount}`);
    renderedGeometry = split.strips;
    body = split.body;
    faceCount = split.faceCount;
    configureThinFaceMaterial(material);
  }
  const strip = new THREE.Mesh(renderedGeometry, material);
  strip.rotation.z = THREE.MathUtils.degToRad(degrees);
  strip.frustumCulled = false;
  scene.add(strip);
  let blocker = null;
  if (occluded) {
    blocker = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.8), new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false }));
    blocker.position.z = 0.2;
    scene.add(blocker);
  }
  return {
    scene, strip, faceCount,
    dispose() {
      geometry.dispose();
      if (renderedGeometry !== geometry) renderedGeometry.dispose();
      body?.dispose();
      material.dispose();
      if (blocker) { blocker.geometry.dispose(); blocker.material.dispose(); }
    },
  };
}

function measure(pixels, widthPx, degrees, offset, occluded) {
  const angle = THREE.MathUtils.degToRad(degrees);
  const axis = [-Math.sin(angle), Math.cos(angle)];
  const side = [Math.cos(angle), Math.sin(angle)];
  const bins = new Array(20).fill(0);
  let sum = 0, outside = 0, occlusionLeak = 0, maxChannelDifference = 0, maxOcclusionPixel = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const index = (y * SIZE + x) * 4;
      const value = (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
      sum += value;
      maxChannelDifference = Math.max(maxChannelDifference, Math.abs(pixels[index] - pixels[index + 1]), Math.abs(pixels[index] - pixels[index + 2]));
      const dx = x + 0.5 - SIZE / 2 - offset;
      const dy = y + 0.5 - SIZE / 2;
      const along = dx * axis[0] + dy * axis[1];
      const across = dx * side[0] + dy * side[1];
      if (along >= -40 && along < 40) bins[Math.floor((along + 40) / 4)] += value / 4;
      const outsideDistance = Math.hypot(Math.max(Math.abs(along) - LENGTH / 2, 0), Math.max(Math.abs(across) - widthPx / 2, 0));
      if (outsideDistance > 2.5) outside += value;
      if (occluded && Math.abs(x + 0.5 - SIZE / 2) <= 17 && Math.abs(y + 0.5 - SIZE / 2) <= 17) {
        occlusionLeak += value;
        maxOcclusionPixel = Math.max(maxOcclusionPixel, value);
      }
    }
  }
  return {
    offsetPx: offset, sumLinearRgbMean: sum,
    theoreticalUnoccludedMass: widthPx * LENGTH,
    unoccludedMassRatio: occluded ? null : sum / (widthPx * LENGTH),
    centralBinCoverage: bins, centralBinMin: Math.min(...bins), centralBinMax: Math.max(...bins),
    centralZeroBinCount: bins.filter(value => value === 0).length,
    energyOutside2_5px: outside, safeOcclusionLeak: occluded ? occlusionLeak : null,
    safeOcclusionMaxPixel: occluded ? maxOcclusionPixel : null,
    maxRgbChannelDifferenceLinear: maxChannelDifference,
  };
}

function preview(pixels) {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE; canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(SIZE, SIZE);
  const encode = value => Math.round(255 * (value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055));
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const source = (y * SIZE + x) * 4, dest = ((SIZE - 1 - y) * SIZE + x) * 4;
      image.data[dest] = encode(pixels[source]);
      image.data[dest + 1] = encode(pixels[source + 1]);
      image.data[dest + 2] = encode(pixels[source + 2]);
      image.data[dest + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function comparisonCanvas(width, angle, occluded, frames, title = null) {
  const canvas = document.createElement('canvas');
  canvas.width = 528; canvas.height = 290;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 528, 290);
  ctx.fillStyle = '#20242a'; ctx.font = '13px system-ui';
  ctx.fillText(title || `${occluded ? '遮挡 · ' : ''}${width}px · ${angle}° · offset 12/23px`, 8, 15);
  ctx.fillText('baseline', 8, 31); ctx.fillText('candidate', 272, 31);
  ctx.drawImage(frames.baseline, 0, 34); ctx.drawImage(frames.candidate, 272, 34);
  canvas.setAttribute('aria-label', `${occluded ? '遮挡' : '无遮挡'} ${width}px ${angle}度 baseline / candidate`);
  $('comparisons').append(canvas);
}

function summarize(rows) {
  return rows.map(row => {
    const sums = row.frames.map(frame => frame.sumLinearRgbMean);
    return {
      widthPx: row.widthPx, angleFromVertical: row.angleFromVertical, occluded: row.occluded, mode: row.mode,
      minMass: Math.min(...sums), maxMass: Math.max(...sums), meanMass: sums.reduce((a, b) => a + b, 0) / sums.length,
      minMassRatio: row.occluded ? null : Math.min(...sums) / (row.widthPx * LENGTH),
      maxMassRatio: row.occluded ? null : Math.max(...sums) / (row.widthPx * LENGTH),
      massVariationFractionOfTrueMass: (Math.max(...sums) - Math.min(...sums)) / (row.widthPx * LENGTH),
      minimumCentralBinCoverage: Math.min(...row.frames.map(frame => frame.centralBinMin)),
      maximumZeroBinsInFrame: Math.max(...row.frames.map(frame => frame.centralZeroBinCount)),
      maxEnergyOutside2_5px: Math.max(...row.frames.map(frame => frame.energyOutside2_5px)),
      maxSafeOcclusionLeak: row.occluded ? Math.max(...row.frames.map(frame => frame.safeOcclusionLeak)) : null,
    };
  });
}

function summaryTable(rows) {
  const table = document.createElement('table');
  const headings = ['条件', '方法', '总覆盖 / 理论范围', '平移波动 / 理论', '中段最低分箱', '零分箱', '外侧漏光', '遮挡漏光'];
  const header = table.insertRow();
  for (const heading of headings) { const cell = document.createElement('th'); cell.textContent = heading; header.append(cell); }
  for (const item of rows) {
    const row = table.insertRow();
    const cells = [`${item.widthPx}px ${item.angleFromVertical}°${item.occluded ? ' 遮挡' : ''}`, item.mode,
      item.occluded ? '—' : `${item.minMassRatio.toFixed(3)} .. ${item.maxMassRatio.toFixed(3)}`,
      item.massVariationFractionOfTrueMass.toFixed(4), item.minimumCentralBinCoverage.toFixed(5),
      item.maximumZeroBinsInFrame, item.maxEnergyOutside2_5px.toFixed(5), item.maxSafeOcclusionLeak?.toFixed(5) ?? '—'];
    for (const value of cells) row.insertCell().textContent = String(value);
  }
  $('summary').replaceChildren(table);
}

async function run() {
  if (running) return;
  running = true; report = null; shaderErrors.length = 0;
  $('run').disabled = true; $('download').disabled = true;
  $('comparisons').replaceChildren(); $('summary').replaceChildren();
  $('results').textContent = 'GPU 验证进行中…';
  const rows = [], cases = WIDTHS.flatMap(width => ANGLES.map(angle => ({ width, angle, occluded: false })));
  cases.push(...ANGLES.map(angle => ({ width: 0.2, angle, occluded: true })));
  try {
    for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
      const { width, angle, occluded } = cases[caseIndex];
      const snapshots = {};
      for (const mode of MODES) {
        const fixture = makeFixture(width, angle, mode, occluded);
        const frames = [];
        try {
          for (let frame = 0; frame < FRAMES; frame++) {
            const offset = frame / (FRAMES - 1);
            fixture.strip.position.x = offset * WORLD_PER_PIXEL;
            renderer.setRenderTarget(target);
            renderer.clear();
            renderer.render(fixture.scene, camera);
            renderer.setRenderTarget(null);
            if (shaderErrors.length) throw new Error('GPU shader 编译失败，见完整结果');
            renderer.readRenderTargetPixels(target, 0, 0, SIZE, SIZE, readback);
            const glError = gl.getError();
            if (glError !== gl.NO_ERROR) throw new Error(`GPU readback error ${glError}`);
            frames.push(measure(readback, width, angle, offset, occluded));
            if (frame === 12) snapshots[mode] = preview(readback);
            if (frame % 6 === 0) {
              $('status').textContent = `${caseIndex + 1}/${cases.length} · ${width}px · ${angle}° · ${mode} · frame ${frame + 1}/${FRAMES}`;
              await yieldTask();
            }
          }
          rows.push({ widthPx: width, worldWidth: width * WORLD_PER_PIXEL, angleFromVertical: angle, occluded, mode, extractedRectangles: fixture.faceCount, frames });
        } finally { fixture.dispose(); }
      }
      comparisonCanvas(width, angle, occluded, snapshots);
    }
    const summary = summarize(rows);
    report = {
      environment, methodology: {
        target: 'RGBA8 linear RGB, DEPTH24, 4 samples; RGB mean per pixel',
        lengthPx: LENGTH, worldPerPixel: WORLD_PER_PIXEL, framesPerCase: FRAMES,
        anglesFrom: 'vertical; positive rotation about Z', translation: 'screen +X, inclusive 0..1px',
        material: 'MeshPhysicalMaterial: black color, white emissive/intensity 1, no lights/transmission/metalness/tone mapping',
        centralBins: '20 bins each 4px long within central 80px; sum pixel-center-assigned energy / bin length',
        outsideEnergy: 'pixel centers farther than 2.5px from the true rectangle',
        occlusion: '40x40px black opaque plate at z=.2; safe interior excludes 3px border',
        quantization: '8-bit linear target; individual channel steps are 1/255, not infinite precision',
        limits: 'Finite rectangular plane test, not a whole-scene visual/performance certification. Discrete diagonal bins are not exact area integrals.',
      }, shaderErrors, summary, rows,
    };
    $('results').textContent = JSON.stringify(report, null, 2);
    summaryTable(summary);
    $('status').textContent = `完成：${rows.length * FRAMES} 帧，${cases.length} 组条件 × 2 种绘制；GPU 错误 ${shaderErrors.length}。`;
    $('download').disabled = false;
  } catch (reason) { error(reason); }
  finally { running = false; $('run').disabled = false; }
}

$('run').addEventListener('click', run);
$('download').addEventListener('click', () => {
  if (!report) return;
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = 'thin-coverage-gpu-review.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('status').textContent = '就绪，点击 Run 开始。';
$('run').disabled = false;
