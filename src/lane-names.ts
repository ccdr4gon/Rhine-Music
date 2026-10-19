import { cssMatrix, laneLabelIndex, type LaneBox, type LaneLabelSlot, type LaneLabelType, type LaneName, type LaneRole } from "./lane-labels.ts";

/**
 * The columns' names over the picture (lane-labels.ts) in a layer over the shelf's canvas: the
 * selected column's flat and upright, facing the viewer; the two beside it printed in
 * perspective on a plane of the shelf that faces right (a CSS matrix3d per name). The layer
 * stands above the picture's vignette and the reading veil, which would wash out a name right
 * of the picture's middle (z-index 2 in music-shelf.css; the scene's container makes no
 * stacking context of its own), and below the selection bracket, the right column, the
 * counter, the key hints, the header and the panels. The pointer passes through it. Text only:
 * a column's number (in the playback colour for the playing queue's column) and its name, with
 * nothing behind or around them: no plate, frame, band, mark, rim or shadow. The selected one
 * (2026-10-18: the owner chose "A · Display name" from five designs) is a heading: a kicker as
 * the playlist list's head (PLAYLIST, its number, / and the count of columns) over its name, in
 * one line or two (twoLines). The layer is hidden from assistive technology: the playlist list
 * in the right column names the columns.
 *
 * Where each name stands comes from the scene (lane-labels.ts laneLabelSlots, laneLabelShares).
 * This module writes it in its role's type (music-shelf.css), by a translation for the flat
 * name and by its slot's homography for the others, and measures what the slots need from the
 * page (measure): how each role's type sits on its baseline and how wide its number is, the
 * header's band, and the boxes of the overlay a name keeps clear of. They are measured again
 * when the fonts change or one of those boxes changes its size (`version`).
 *
 * Those boxes change with the window and its layout only, never with what the overlay shows
 * (the 2026-10-08 review: the nearer name jumped about 54 px whenever the key hints showed or hid
 * P and L): the header as one band across the picture (the now-playing title changes its width),
 * the right column's box, the counter and ruler as wide as four-digit numbers make them (the
 * selected song's and the column's count change), the key hints' row across the picture (whichever
 * keys it shows), the window's own buttons. Each is its layout box: the overlay's entrance and the
 * opening's reveal move the overlay for a moment, which would move a slot worked out meanwhile.
 */

/** The header's two halves: one band across the picture, which the selected name keeps well under. */
const HEADER = [".music-identity", ".music-topnav"];
/** The right column (the selected name never reaches over it, at any height: lane-labels.ts `column`). */
const COLUMN = ".album-callout";
/** The counter and the ruler, bottom left; the two numbers that change its width. */
const NAVIGATION = ".music-navigation", COUNTS = ["#selection-number", "#selection-total"];
/** The key hints: their row across the picture, as high as its type. */
const HINTS = ".music-keyhint";
/** The window's own buttons. */
const WINDOW = ".window-controls";
/** How many digits the counter's numbers are given room for. */
const DIGITS = "0000";
/** The selected name's kicker begins as the playlist list's head does (music-app.ts: PLAYLIST 04 / 11). */
const KICKER = "PLAYLIST";
const ROLES: readonly LaneRole[] = ["nearer", "selected", "further"];

/** What the slots need from the page (lane-labels.ts LaneLabelView and LaneLabelType), in CSS px from the picture's top left. */
export interface LaneNamePage { type: Record<LaneRole, LaneLabelType>; header: { top: number; bottom: number }; avoid: LaneBox[]; column?: LaneBox }
/** Where a name is drawn: its role, where its baseline starts in the picture (the selected one's block, its first baseline), and how much of it shows. */
export interface LaneNamePose { role: LaneRole; x: number; y: number; opacity: number }

let measuring: CanvasRenderingContext2D | undefined;
const context = () => measuring ??= document.createElement("canvas").getContext("2d")!;

/** Shorten `text` with an ellipsis until it is at most `width` wide in the context's font. */
function fitted(c: CanvasRenderingContext2D, text: string, width: number) {
  if (c.measureText(text).width <= width) return text;
  const glyphs = Array.from(text);
  while (glyphs.length > 1 && c.measureText(`${glyphs.join("").trimEnd()}…`).width > width) glyphs.pop();
  return `${glyphs.join("").trimEnd()}…`;
}

/** Marks a line does not start with (closing ones) and marks it does not end with (opening ones). */
const NO_START = new Set(Array.from("，。、；：？！）」』〕》〉】”’…·,.;:?!)]}-–—~～"));
const NO_END = new Set(Array.from("（「『〔《〈【“‘([{"));
let words: Intl.Segmenter | undefined, graphemes: Intl.Segmenter | undefined;

/**
 * Where a line may break in `text` (the indices a second line may start at): between its words
 * (a run of letters or digits stays whole, and so does a Chinese word), or between any two
 * characters (`anywhere`), never before a closing mark or after an opening one.
 */
function breaks(text: string, anywhere: boolean) {
  const segmenter = anywhere ? graphemes ??= new Intl.Segmenter("zh", { granularity: "grapheme" }) : words ??= new Intl.Segmenter("zh", { granularity: "word" });
  const at: number[] = [];
  for (const { index } of segmenter.segment(text)) {
    if (index > 0 && !NO_START.has(text[index]) && !NO_END.has(text[index - 1])) at.push(index);
  }
  return at;
}

/**
 * `text` in at most two lines (`most`), each at most `width` wide in the context's font: one
 * where it fits; else two as nearly the same width as its words allow (a heading's balance; on a
 * tie, the fuller first line); where two are not enough, the first as full as it can be and the
 * second ending in an ellipsis. Words are broken only where a word alone is too wide for a line.
 * With room for one line only, that line ends in an ellipsis where it must.
 */
export function twoLines(c: CanvasRenderingContext2D, text: string, width: number, most = 2): string[] {
  const name = text.replace(/\s+/g, " ").trim(), wide = (line: string) => c.measureText(line).width;
  if (wide(name) <= width || most < 2) return [fitted(c, name, width)];
  for (const anywhere of [false, true]) {
    let best: { first: string; second: string; widest: number; full: number } | undefined, fullest: number | undefined;
    for (const at of breaks(name, anywhere)) {
      const first = name.slice(0, at).trimEnd(), second = name.slice(at).trimStart();
      if (!first || !second) continue;
      const full = wide(first);
      // A later break only makes the first line longer.
      if (full > width) break;
      fullest = at;
      const widest = Math.max(full, wide(second));
      if (widest <= width && (!best || widest < best.widest - 0.5 || (widest <= best.widest + 0.5 && full > best.full))) best = { first, second, widest, full };
    }
    if (best) return [best.first, best.second];
    if (fullest !== undefined) return [name.slice(0, fullest).trimEnd(), fitted(c, name.slice(fullest).trimStart(), width)];
  }
  return [fitted(c, name, width)];
}

/**
 * How a role's name is set in `layer` (music-shelf.css): a name "Hg" numbered "00" (with "00"
 * columns: the selected one's kicker), a box without a size on its baseline. The names are set
 * at a line height of their own, so a line's height comes from its first font alone (a glyph
 * from a fallback font does not move it), and the numbers have tabular figures, so this holds
 * for every name in that role. The selected one is a block: from its top over the kicker to its
 * name's baseline, from there to that line's bottom, the line's height, as much again for a
 * second line, and its kicker's width (the least room it is shown in; "00" is as wide as any
 * number). Undefined while the layer is not laid out.
 */
function measureType(layer: HTMLElement, role: LaneRole) {
  const view = new LaneNameView(role), mark = document.createElement("i");
  view.write("00", "Hg", false, 0);
  mark.style.cssText = "display: inline-block; width: 0; height: 0; vertical-align: baseline";
  view.text.append(mark);
  const line = view.element;
  line.hidden = false;
  line.style.cssText = "visibility: hidden; transform: none";
  layer.append(line);
  const box = line.getBoundingClientRect(), baseline = mark.getBoundingClientRect().top, own = view.text.getBoundingClientRect();
  const lead = own.left - box.left, kicker = view.kicker?.getBoundingClientRect().width ?? 0;
  // Read while the line is in the page: the computed style of a removed element is empty.
  const style = getComputedStyle(view.text);
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`, spacing = style.letterSpacing;
  line.remove();
  if (!(box.height > 0) || !Number.isFinite(baseline)) return undefined;
  const type: LaneLabelType = role === "selected"
    ? { ascent: baseline - box.top, descent: own.bottom - baseline, lead: 0, line: own.height, more: own.height, least: kicker }
    : { ascent: baseline - box.top, descent: box.bottom - baseline, lead };
  return { type, font, spacing };
}

/**
 * Where `element` is laid out, in CSS px from `layer`'s top left: its layout box (the offsets up
 * to `stage` and its offset size), which no transform, translate or animation moves. Undefined
 * while it is not laid out (display: none, here or above it). One outside the stage's offset
 * parents (fixed) by its box on the screen.
 */
function layoutBox(element: Element, stage: Element, layer: HTMLElement): LaneBox | undefined {
  if (element.getClientRects().length === 0) return undefined;
  const offset = (node: HTMLElement) => {
    let x = 0, y = 0;
    for (let at: HTMLElement | null = node; at !== stage; ) {
      if (!at) return undefined;
      x += at.offsetLeft;
      y += at.offsetTop;
      const parent = at.offsetParent as HTMLElement | null;
      if (parent && parent !== stage) {
        x += parent.clientLeft;
        y += parent.clientTop;
      }
      at = parent;
    }
    return { x, y };
  };
  if (element instanceof HTMLElement) {
    const own = offset(element), origin = offset(layer);
    if (own && origin) {
      const left = own.x - origin.x, top = own.y - origin.y;
      return { left, top, right: left + element.offsetWidth, bottom: top + element.offsetHeight };
    }
  }
  const r = element.getBoundingClientRect(), o = layer.getBoundingClientRect();
  return { left: r.left - o.left, top: r.top - o.top, right: r.right - o.left, bottom: r.bottom - o.top };
}

/**
 * How much wider the counter is with four-digit numbers than it is now: room for its two numbers
 * (the selected song's and the column's count), so that a name beside it stays where it is as
 * they change. Each is measured as DIGITS in its own type.
 */
function roomForCounts(navigation: Element) {
  let more = 0;
  for (const selector of COUNTS) {
    const number = navigation.querySelector<HTMLElement>(selector);
    if (!number?.parentElement || !number.offsetWidth) continue;
    const style = getComputedStyle(number), probe = document.createElement("span");
    probe.style.cssText = "position: absolute; left: 0; top: 0; visibility: hidden; white-space: nowrap";
    // Longhand by longhand: the computed `font` shorthand is empty for tabular figures.
    for (const property of ["font-style", "font-weight", "font-stretch", "font-size", "font-family", "font-variant-numeric", "font-feature-settings", "letter-spacing"])
      probe.style.setProperty(property, style.getPropertyValue(property));
    probe.textContent = DIGITS;
    number.parentElement.append(probe);
    more += Math.max(0, probe.getBoundingClientRect().width - number.getBoundingClientRect().width);
    probe.remove();
  }
  return more;
}

class LaneNameView {
  readonly element = document.createElement("div");
  /** The name: the selected one's in one line or two (a line break between them). */
  readonly text = document.createElement("span");
  private readonly index = document.createElement("span");
  /** The selected one's kicker, which ends with the count of columns. */
  readonly kicker?: HTMLSpanElement;
  private readonly of?: HTMLSpanElement;
  used = false;
  written = "";
  pose: LaneNamePose = { role: "selected", x: 0, y: 0, opacity: 0 };
  private shown = { transform: "", opacity: "", width: "", align: "" };

  constructor(readonly role: LaneRole) {
    this.element.className = "lane-name";
    this.element.dataset.role = role;
    this.index.className = "lane-name-index";
    this.text.className = "lane-name-text";
    if (role === "selected") {
      // Its kicker, as the playlist list's head: PLAYLIST, the column's number, / and the count.
      const kicker = this.kicker = document.createElement("span"), of = this.of = document.createElement("span");
      kicker.className = "lane-name-kicker";
      of.className = "lane-name-of";
      kicker.append(`${KICKER} `, this.index, of);
      this.element.append(kicker, this.text);
    } else this.element.append(this.index, this.text);
    this.element.hidden = true;
  }

  write(index: string, name: string, live: boolean, count: number) {
    const of = ` / ${String(count).padStart(2, "0")}`;
    const key = [this.role, index, live, name, of].join("\u001f");
    if (key === this.written) return;
    this.written = key;
    this.element.dataset.live = String(live);
    this.index.textContent = index;
    if (this.of) this.of.textContent = of;
    this.text.textContent = name;
  }

  /** The selected one's block: as wide as its slot; its lines end where the slot ends left of the bracket (`end`). */
  size(width: number, end: boolean) {
    const wide = `${width}px`, align = end ? "end" : "start";
    if (wide !== this.shown.width) this.element.style.width = this.shown.width = wide;
    if (align !== this.shown.align) this.element.dataset.align = this.shown.align = align;
  }

  /** Put the name where `transform` takes its line's box (its top left at the layer's). Style only what changed: a name at rest writes nothing. */
  place(pose: LaneNamePose, transform: string) {
    this.pose = pose;
    const shown = pose.opacity.toFixed(3);
    const style = this.element.style;
    if (transform !== this.shown.transform) style.transform = this.shown.transform = transform;
    if (shown !== this.shown.opacity) style.opacity = this.shown.opacity = shown;
    if (this.element.hidden) this.element.hidden = false;
  }

  hide() {
    if (!this.element.hidden) this.element.hidden = true;
  }
}

export class LaneNameLayer {
  readonly element = document.createElement("div");
  /**
   * Counts the times what the slots are measured from may have changed: the fonts, or the size of
   * an element of the overlay a name keeps clear of. The slots made before are worked out again;
   * they come out the same where only what the element shows changed (the now-playing title, the
   * counter's numbers, the key hints shown).
   */
  version = 0;
  /** Called when `version` moves on its own (the scene draws again). */
  onChange?: () => void;
  private readonly views = new Map<string, LaneNameView>();
  /** Each name as written in a role's slot (shortened to fit, the selected one in one line or two) and how wide it is, by role, width and name. */
  private readonly writings = new Map<string, { name: string; width: number }>();
  private page?: { view: string; page: LaneNamePage; fonts: Record<LaneRole, { font: string; spacing: string }> };
  private readonly watch = typeof ResizeObserver === "function" ? new ResizeObserver((entries) => this.resized(entries)) : undefined;
  private readonly sizes = new WeakMap<Element, string>();
  private readonly watched = new Set<Element>();
  private settle = 0;

  constructor(host: HTMLElement) {
    this.element.className = "lane-names";
    this.element.setAttribute("aria-hidden", "true");
    host.append(this.element);
  }

  /** The fonts changed (MiSans arrived): measure again. */
  refresh() {
    this.version++;
  }

  /** A box a name keeps clear of changed its size: measure again once it has settled (a title rolling in). */
  private resized(entries: ResizeObserverEntry[]) {
    let changed = false;
    for (const entry of entries) {
      const size = `${entry.contentRect.width}x${entry.contentRect.height}`, before = this.sizes.get(entry.target);
      if (before !== undefined && before !== size) changed = true;
      this.sizes.set(entry.target, size);
    }
    if (!changed) return;
    clearTimeout(this.settle);
    this.settle = window.setTimeout(() => {
      this.version++;
      this.onChange?.();
    }, 150);
  }

  /**
   * What the slots need from the page (lane-labels.ts laneLabelSlots), measured once for each
   * `view` (the scene's: the window's size and its layout, with this layer's `version`): each
   * role's type, the header's band, the boxes of the overlay a name keeps clear of (boxes that do
   * not change with what the overlay shows) and the right column's box, in CSS px from the
   * layer's (the picture's) top left. Those elements are watched for a change of size (their
   * layout's: a new size measured again gives the same boxes when only their content changed);
   * one no longer in the page is let go. Undefined while the layer is not laid out.
   */
  measure(view: string): LaneNamePage | undefined {
    if (this.page?.view === view) return this.page.page;
    const origin = this.element.getBoundingClientRect();
    if (!(origin.width > 0 && origin.height > 0)) return undefined;
    const type = {} as Record<LaneRole, LaneLabelType>, fonts = {} as Record<LaneRole, { font: string; spacing: string }>;
    for (const role of ROLES) {
      const set = measureType(this.element, role);
      if (!set) return undefined;
      type[role] = set.type;
      fonts[role] = { font: set.font, spacing: set.spacing };
    }
    const stage = this.element.closest(".music-app") ?? document.body;
    const found = new Set<Element>();
    const find = (selector: string) => {
      const element = stage.querySelector(selector);
      if (element) found.add(element);
      return element;
    };
    const box = (element: Element | null) => element ? layoutBox(element, stage, this.element) : undefined;
    const sized = (b: LaneBox | undefined): b is LaneBox => !!b && b.right > b.left && b.bottom > b.top;
    const avoid: LaneBox[] = [];
    // The header: one band across the picture, whatever the now-playing title's width, as low as
    // the controls in its row reach (the 30 px play ring overhangs the 24 px row), not a menu
    // dropped under it.
    const halves = HEADER.map((selector) => box(find(selector))).filter(sized);
    const line = halves.length ? Math.max(...halves.map((b) => b.bottom)) : 0;
    for (const control of stage.querySelectorAll(`${HEADER.join(", ")} button`)) {
      const b = box(control);
      if (sized(b) && b.top < line) halves.push(b);
    }
    const header = halves.length ? { top: Math.min(...halves.map((b) => b.top)), bottom: Math.max(...halves.map((b) => b.bottom)) } : { top: 0, bottom: 0 };
    if (halves.length) avoid.push({ left: 0, top: header.top, right: origin.width, bottom: header.bottom });
    const column = box(find(COLUMN));
    if (sized(column)) avoid.push(column);
    // The counter and ruler, with room for four-digit numbers.
    const navigation = find(NAVIGATION), counted = box(navigation);
    if (navigation && sized(counted)) avoid.push({ ...counted, right: counted.left + navigation.getBoundingClientRect().width + roomForCounts(navigation) });
    // The key hints: their row across the picture, as high as its type, whichever keys it shows.
    const hints = find(HINTS), row = box(hints);
    if (hints && row && row.right > row.left) {
      const tall = Math.max(row.bottom - row.top, Number.parseFloat(getComputedStyle(hints).fontSize) || 0);
      avoid.push({ left: 0, top: row.bottom - tall, right: origin.width, bottom: row.bottom });
    }
    const buttons = box(find(WINDOW));
    if (sized(buttons)) avoid.push(buttons);
    for (const element of found) {
      if (!this.watch || this.watched.has(element)) continue;
      this.watched.add(element);
      this.watch.observe(element);
    }
    for (const element of this.watched) {
      if (found.has(element)) continue;
      this.watch?.unobserve(element);
      this.watched.delete(element);
    }
    const page: LaneNamePage = { type, header, avoid, column: sized(column) ? column : undefined };
    // New slots, perhaps a new type: the names are fitted again.
    this.writings.clear();
    this.page = { view, page, fonts };
    return page;
  }

  /** How many elements the layer watches for a change of size (for diagnostics). */
  get watching() {
    return this.watched.size;
  }

  /** What it last measured from the page (for diagnostics). */
  get measured() {
    return this.page?.page;
  }

  /**
   * A column's name as written in a role's slot `width` wide (its number included): shortened
   * with an ellipsis where it does not fit; with its width. The selected one's in as many lines as
   * its slot has room for (`lines`: two, or one), a line break between them (twoLines).
   */
  private fit(role: LaneRole, label: LaneName, width: number, lines: number) {
    const key = `${role}\n${width}\n${lines}\n${label.name}`;
    let written = this.writings.get(key);
    if (written || !this.page) return written ?? { name: label.name, width };
    const c = context(), set = this.page.fonts[role], lead = this.page.page.type[role].lead;
    c.font = set.font;
    if ("letterSpacing" in c) c.letterSpacing = set.spacing === "normal" ? "0px" : set.spacing;
    if (role === "selected") {
      const broken = twoLines(c, label.name, width, lines);
      written = { name: broken.join("\n"), width: Math.max(...broken.map((line) => c.measureText(line).width)) };
    } else {
      const name = fitted(c, label.name, width - lead);
      written = { name, width: Math.min(width, lead + c.measureText(name).width) };
    }
    this.writings.set(key, written);
    return written;
  }

  /** Start a frame: every name is free until it is shown again. */
  begin() {
    for (const view of this.views.values()) view.used = false;
  }

  /**
   * Show the name of `column` (`label`, one of `count` columns) in `role` as `key` (a lane and the
   * role): at its slot, moved by (dx, dy) in the picture (lane-labels.ts laneLabelShares),
   * `opacity` of it. A flat name by a translation, one on a plane by its slot's homography. Needs
   * measure().
   */
  show(key: string, role: LaneRole, column: number, count: number, label: LaneName, slot: LaneLabelSlot, dx: number, dy: number, opacity: number) {
    const page = this.page?.page;
    if (!page) return;
    let view = this.views.get(key);
    if (!view) {
      view = new LaneNameView(role);
      this.views.set(key, view);
      this.element.append(view.element);
    }
    view.used = true;
    const written = this.fit(role, label, slot.width, slot.lines ?? 1);
    view.write(laneLabelIndex(column), written.name, label.live, count);
    if (slot.matrix) {
      view.place({ role, x: slot.x + dx, y: slot.y + dy, opacity }, cssMatrix(slot.matrix, dx, dy));
      return;
    }
    // The flat one, a block as wide as its slot: a right-aligned slot (left of the bracket) has
    // its lines end where the slot ends.
    view.size(slot.width, slot.align === "end");
    const x = slot.x + dx, y = slot.y + dy;
    view.place({ role, x, y, opacity }, `translate(${x.toFixed(2)}px, ${(y - page.type[role].ascent).toFixed(2)}px)`);
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
      written: view.written.split("\u001f"),
      ...view.pose,
    }));
  }
}
