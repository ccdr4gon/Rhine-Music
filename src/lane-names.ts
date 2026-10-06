import { LANE_LABEL_TEXT, laneLabelIndex, type LaneName } from "./lane-labels.ts";

/**
 * The columns' names over the picture: flat text in a layer above the shelf's canvas and below
 * everything else of the overlay (the header, the right column, the panels), which the pointer
 * passes through. Text only: a column's number (in the playback colour for the playing queue's
 * column) and its name, with nothing behind them, no plate, frame, band or mark. A thin soft
 * rim in the page's ground colour along the strokes (music-shelf.css) keeps them readable on
 * lit and shaded cases. The layer is hidden from assistive technology: the playlist list in
 * the right column names the columns.
 *
 * Where each name stands and how large it is comes from the scene (lane-labels.ts
 * laneLabelPose); this module writes it, and measures a name the way it was measured as writing
 * in the scene, so its length on the shelf (which places a name along an edge) is the one the
 * owner approved.
 */

/** A column's name as written: its number, the name (ended with an ellipsis where too long), and its length in world units at its plain size. */
export interface LaneWriting { index: string; name: string; live: boolean; width: number }
/** Where a name is drawn (laneLabelPose): see LaneLabelSlot; `align` 0 anchors the writing's start, 1 its end. */
export interface LaneNamePose { x: number; y: number; angle: number; font: number; align: number }

/** Pixels per world unit the names are measured at (the scene's writing was laid out at 512). */
const TEXEL = 512;
const FAMILY = "MiSans, system-ui, sans-serif";
/**
 * The font size (CSS px) a name is laid out at; it is drawn at its slot's size by scaling. A
 * line's layout rounds the font's ascent and descent to whole pixels, so a name whose font size
 * changed as it moves (the selected one shrinking into the nearer one's) would shift by half a
 * pixel now and then; scaled, it is laid out once.
 */
const LAYOUT_SIZE = 40;

let measure: CanvasRenderingContext2D | undefined;
const context = () => measure ??= document.createElement("canvas").getContext("2d")!;

/** Shorten `text` with an ellipsis until it is at most `width` wide in the context's font. */
function fitted(c: CanvasRenderingContext2D, text: string, width: number) {
  if (c.measureText(text).width <= width) return text;
  const glyphs = Array.from(text);
  while (glyphs.length > 1 && c.measureText(`${glyphs.join("").trimEnd()}…`).width > width) glyphs.pop();
  return `${glyphs.join("").trimEnd()}…`;
}

/** Measure a column's name as the scene measured its writing (LANE_LABEL_TEXT). */
export function writeLaneName(column: number, label: LaneName): LaneWriting {
  const c = context(), unit = (value: number) => value * TEXEL;
  const index = laneLabelIndex(column);
  c.font = `400 ${unit(LANE_LABEL_TEXT.index)}px ${FAMILY}`;
  let x = unit(LANE_LABEL_TEXT.margin) + c.measureText(index).width + unit(LANE_LABEL_TEXT.gap);
  c.font = `600 ${unit(LANE_LABEL_TEXT.name)}px ${FAMILY}`;
  const widest = unit(LANE_LABEL_TEXT.maxWidth);
  const name = fitted(c, label.name, widest - x - unit(LANE_LABEL_TEXT.margin));
  x = Math.min(widest, Math.ceil(x + c.measureText(name).width + unit(LANE_LABEL_TEXT.margin)));
  return { index, name, live: label.live, width: Math.max(LANE_LABEL_TEXT.minWidth, x / TEXEL) };
}

/**
 * Where the baseline of a name's line is below the top of its box (CSS px at LAYOUT_SIZE), as
 * laid out in `layer`: a box without a size sits on the baseline. The names are set at
 * line-height 1, so the line's height comes from the first font alone (a glyph from a fallback
 * font does not move it), and this holds for every name. Undefined while the layer is not laid
 * out (hidden).
 */
function measureBaseline(layer: HTMLElement) {
  const line = document.createElement("div"), mark = document.createElement("i");
  line.className = "lane-name";
  line.style.cssText = `font-size: ${LAYOUT_SIZE}px; visibility: hidden; transform: none`;
  mark.style.cssText = "display: inline-block; width: 0; height: 0; vertical-align: baseline";
  line.append(mark, "Hg");
  layer.append(line);
  const baseline = mark.getBoundingClientRect().top - line.getBoundingClientRect().top;
  line.remove();
  return Number.isFinite(baseline) && baseline > 0 ? baseline : undefined;
}

class LaneNameView {
  readonly element = document.createElement("div");
  private readonly index = document.createElement("span");
  private readonly text = document.createElement("span");
  used = false;
  written = "";
  pose: LaneNamePose & { opacity: number } = { x: 0, y: 0, angle: 0, font: 0, align: 0, opacity: 0 };
  private shown = { transform: "", unscale: "", opacity: "" };

  constructor() {
    this.element.className = "lane-name";
    this.element.style.fontSize = `${LAYOUT_SIZE}px`;
    this.index.className = "lane-name-index";
    this.text.className = "lane-name-text";
    this.element.append(this.index, this.text);
    this.element.hidden = true;
  }

  write(writing: LaneWriting, key: string) {
    if (key === this.written) return;
    this.written = key;
    this.index.textContent = writing.index;
    this.text.textContent = writing.name;
    this.element.dataset.live = String(writing.live);
  }

  /**
   * Put the writing's baseline at the anchor, along the angle, at the font size: its start
   * there (align 0) or its end (align 1). The rim keeps its width on the screen whatever the
   * scale (--lane-unscale, music-shelf.css). Style only what changed: a name at rest writes nothing.
   */
  place(pose: LaneNamePose, opacity: number, baseline: number) {
    this.pose = { ...pose, opacity };
    const scale = pose.font / LAYOUT_SIZE;
    const transform = `translate(${pose.x.toFixed(2)}px, ${pose.y.toFixed(2)}px) rotate(${pose.angle.toFixed(5)}rad) ` +
      `scale(${scale.toFixed(5)}) translate(${-100 * pose.align}%, ${(-baseline).toFixed(3)}px)`;
    const unscale = (1 / Math.max(scale, 1e-3)).toFixed(3), shown = opacity.toFixed(3);
    const style = this.element.style;
    if (transform !== this.shown.transform) style.transform = this.shown.transform = transform;
    if (unscale !== this.shown.unscale) style.setProperty("--lane-unscale", this.shown.unscale = unscale);
    if (shown !== this.shown.opacity) style.opacity = this.shown.opacity = shown;
    if (this.element.hidden) this.element.hidden = false;
  }

  hide() {
    if (!this.element.hidden) this.element.hidden = true;
  }
}

export class LaneNameLayer {
  readonly element = document.createElement("div");
  /** Counts the times the fonts changed (the measures and the slots made with them are stale). */
  fonts = 0;
  private readonly views = new Map<string, LaneNameView>();
  private readonly writings = new Map<string, LaneWriting>();
  /** The baseline below the top of a name's box (measureBaseline); measured again until it could be. */
  private baseline = 0.8 * LAYOUT_SIZE;
  private measured = false;

  constructor(host: HTMLElement) {
    this.element.className = "lane-names";
    this.element.setAttribute("aria-hidden", "true");
    host.append(this.element);
  }

  /** The fonts changed (MiSans arrived): measure again. */
  refresh() {
    this.fonts++;
    this.writings.clear();
    this.measured = false;
    for (const view of this.views.values()) view.written = "";
  }

  /** A column's name as written, measured once. */
  writing(column: number, label: LaneName) {
    const key = `${column}\n${label.live ? 1 : 0}\n${label.name}`;
    let writing = this.writings.get(key);
    if (!writing) this.writings.set(key, writing = writeLaneName(column, label));
    return writing;
  }

  /** Start a frame: every name is free until it is shown again. */
  begin() {
    for (const view of this.views.values()) view.used = false;
    if (this.measured) return;
    const baseline = measureBaseline(this.element);
    if (baseline === undefined) return;
    this.baseline = baseline;
    this.measured = true;
  }

  /** Show the name `key` (a lane, and how it is written there) with `writing` at `pose`. */
  show(key: string, writing: LaneWriting, pose: LaneNamePose, opacity: number) {
    let view = this.views.get(key);
    if (!view) {
      view = new LaneNameView();
      this.views.set(key, view);
      this.element.append(view.element);
    }
    view.used = true;
    view.write(writing, `${writing.index}\n${writing.live}\n${writing.name}`);
    view.place(pose, opacity, this.baseline);
  }

  /** End a frame: names not shown are hidden; a few spare ones are kept for the next switch. */
  end() {
    let spare = 0;
    for (const [key, view] of this.views) {
      if (view.used) continue;
      view.hide();
      if (++spare > 4) {
        view.element.remove();
        this.views.delete(key);
      }
    }
  }

  /** The names shown, for diagnostics. */
  shown() {
    return [...this.views].filter(([, view]) => view.used).map(([key, view]) => ({
      key,
      written: view.written.split("\n"),
      ...view.pose,
    }));
  }
}
