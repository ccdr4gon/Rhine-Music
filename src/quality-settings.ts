import {
  matchingPreset,
  presetLabels,
  type QualityPreset,
  type RenderQuality,
} from "./render-quality";

/** The fine controls: a slider (`range`) or a list of choices, each with its note. */
type QualityControl = {
  key: keyof RenderQuality;
  label: string;
  hint: string;
  range?: [number, number];
  choices?: (readonly [string | number, string])[];
};
const QUALITY_CONTROLS: QualityControl[] = [
  { key: "scale", label: "渲染比例", hint: "相对屏幕像素，受密度上限限制；高比例改善细线", range: [50, 200] },
  { key: "pixelRatio", label: "像素密度上限", hint: "控制高密度屏幕的原生像素倍率", choices: [1, 1.5, 2, 3].map((v) => [v, `${v}×`]) },
  {
    key: "antialias",
    label: "抗锯齿",
    hint: "基础按显卡支持使用最高 8× 多重采样，不可用时以 SMAA 补偿；增强叠加 SMAA",
    choices: [
      ["off", "基础"],
      ["smaa", "增强（SMAA）"],
    ],
  },
  { key: "anisotropy", label: "纹理过滤", hint: "改善倾斜视角下的标签细节", choices: [1, 2, 4, 8, 16].map((v) => [v, `${v}×`]) },
  { key: "transmission", label: "透明材质分辨率", hint: "控制盖板折射画面的清晰度", choices: [0.25, 0.5, 0.75, 1].map((v) => [v, `${v * 100}%`]) },
  {
    key: "shadows",
    label: "阴影分辨率 · 阵列",
    hint: "更高分辨率保留更细的投影边缘",
    choices: [
      [0, "关闭"],
      [1024, "1024"],
      [2048, "2048"],
      [4096, "4096"],
    ],
  },
  {
    key: "aoSamples",
    label: "环境遮蔽 · 阵列",
    hint: "采样越多，接缝暗部越细腻",
    choices: [
      [0, "关闭"],
      [16, "16 采样"],
      [32, "32 采样"],
      [64, "64 采样"],
    ],
  },
  { key: "aoResolution", label: "遮蔽分辨率 · 阵列", hint: "降低可减轻环境遮蔽的渲染负担", choices: [0.5, 0.75, 1].map((v) => [v, `${v * 100}%`]) },
  { key: "depthOfField", label: "景深强度 · 阵列", hint: "0% 关闭；100% 保留原始镜头虚化", range: [0, 150] },
];
const options = (quality: RenderQuality, control: QualityControl) =>
  control.choices!.map(([value, text]) => `<option value="${value}" ${quality[control.key] === value ? "selected" : ""}>${text}</option>`).join("");

function select(quality: RenderQuality, control: QualityControl) {
  return `<label class="quality-control"><span>${control.label}<small>${control.hint}</small></span><select data-quality="${control.key}" aria-label="${control.label}">${options(quality, control)}</select></label>`;
}
function range(quality: RenderQuality, control: QualityControl) {
  const [min, max] = control.range!;
  return `<label class="quality-control quality-range"><span>${control.label}<small>${control.hint}</small></span><div><input type="range" data-quality="${control.key}" aria-label="${control.label}" min="${min}" max="${max}" step="5" value="${quality[control.key]}"/><output data-quality-output="${control.key}">${quality[control.key]}%</output></div></label>`;
}
/** The original archive's 画质 (?original=1). */
export function qualityMarkup(quality: RenderQuality) {
  const preset = matchingPreset(quality);
  return `<section class="quality-settings" aria-label="画质设置">
    <div class="quality-heading"><h3>RENDER QUALITY <span>渲染画质</span></h3><select id="quality-preset" aria-label="画质预设">${(Object.keys(presetLabels) as QualityPreset[]).map((key) => `<option value="${key}" ${preset === key ? "selected" : ""}>${presetLabels[key]}</option>`).join("")}<option value="custom" disabled ${preset === "custom" ? "selected" : ""}>自定义</option></select></div>
    <p class="quality-summary" id="quality-summary" aria-live="polite"></p>
    <details class="quality-advanced"><summary>精细设置 <span>清晰度 / 材质 / 阴影</span></summary><div class="quality-grid">
    ${QUALITY_CONTROLS.map((control) => (control.range ? range : select)(quality, control)).join("\n    ")}
    </div></details><p class="quality-note">即时生效并自动保存。清晰度与材质设置同步至 360° 查看器。高渲染比例更适合静态观察；缓冲上限为 829 万像素，硬件限制时自动收敛。</p>
  </section>`;
}
/**
 * The music page's 画质 (设置 → 画质; design A, the owner, 2026-10-24): the presets as one row of
 * words (none chosen while the settings are the user's own), then the summary that opens 精细设置,
 * one control a line, each note in its tooltip.
 */
export function qualityRows(quality: RenderQuality) {
  const preset = matchingPreset(quality);
  const presets = (Object.keys(presetLabels) as QualityPreset[])
    .map((key) => `<label class="settings-choice"><input type="radio" name="quality-preset" value="${key}"${preset === key ? " checked" : ""}><span>${presetLabels[key]}</span></label>`)
    .join("");
  const fine = QUALITY_CONTROLS.map((control) => {
    if (!control.range)
      return `<label class="settings-row" title="${control.hint}"><span>${control.label}</span><select data-quality="${control.key}" aria-label="${control.label}" aria-description="${control.hint}">${options(quality, control)}</select></label>`;
    const [min, max] = control.range, value = Number(quality[control.key]);
    return `<label class="settings-row wide" title="${control.hint}"><span>${control.label}</span><span class="settings-range"><input type="range" data-quality="${control.key}" aria-label="${control.label}" aria-description="${control.hint}" aria-valuetext="${value}%" min="${min}" max="${max}" step="5" value="${value}" style="--fill: ${((value - min) / (max - min)) * 100}%"><output data-quality-output="${control.key}" aria-hidden="true">${value}%</output></span></label>`;
  }).join("");
  return `<div class="settings-row"><span id="quality-preset-label">预设</span><div class="settings-choices" role="radiogroup" aria-labelledby="quality-preset-label">${presets}</div></div><details class="settings-more"><summary><span id="quality-summary" aria-live="polite"></span><b>精细设置</b></summary><div class="settings-fine">${fine}</div></details>`;
}

export function syncQualityUI(quality: RenderQuality) {
  const preset = document.querySelector<HTMLSelectElement>("#quality-preset");
  const presets = document.querySelectorAll<HTMLInputElement>('input[name="quality-preset"]');
  if (!preset && !presets.length) return;
  const matching = matchingPreset(quality);
  if (preset) preset.value = matching;
  presets.forEach((choice) => {
    choice.checked = choice.value === matching;
  });
  document
    .querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-quality]")
    .forEach((control) => {
      const key = control.dataset.quality as keyof RenderQuality;
      control.value = String(quality[key]);
      control.disabled = key === "aoResolution" && quality.aoSamples === 0;
    });
  document
    .querySelectorAll<HTMLOutputElement>("[data-quality-output]")
    .forEach((output) => {
      output.value = `${quality[output.dataset.qualityOutput as keyof RenderQuality]}%`;
    });
}
