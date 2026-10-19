import { escapeHtml as esc } from "./html";
import { lineAt, nextChange, type Lyrics } from "./lyrics";

/** Where the song whose lyrics show is now. */
export interface LyricsClock {
  /** Seconds into the song now; undefined while unknown. */
  position(): number | undefined;
  playing(): boolean;
}

/**
 * What the box shows: "off" (the details do not show the song that plays), "wait" (its lyrics are
 * being read; the box keeps its room, empty), "none" (it has none) or "shown".
 */
export type LyricsState = "off" | "wait" | "none" | "shown";

/** Lyrics the user scrolled stay where they were put this long before they follow the song again. */
const HOLD_MS = 3000;
/** The current line's middle stands at this share of the box's height. */
const FOCUS = 0.38;

/**
 * The details' lyrics (scene 2; the owner, 2026-10-17: "Redesign scene 2 … add dynamic lyrics there
 * instead"), in the box under the timeline (.detail-lyrics): the song's lines in a column that
 * scrolls by itself, keeping the line sung now at 38 % of its height, lit in ink while the others
 * stay muted; in a line timed word by word each word lights up as it is sung. The box is the
 * document's own: written with each document (attach), filled for the song that plays (show), and
 * moved on by one timer, set for the next change of line or word (sync), with the song's clock read
 * again whenever the page learns more (each reading of NetEase, each of the player's updates).
 * Nothing runs between those changes: a word turns to ink at once when it is sung (a fill swept
 * across each word, faded in, or even a short colour change kept the page busy frame after frame:
 * the 2026-10-17 measurements in DESIGN). A wheel or a touch on the box scrolls it by hand; it follows
 * the song again after HOLD_MS. Reduced motion: no smooth scrolling, and a line is lit whole.
 */
export class LyricsView {
  private box: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private rows: HTMLElement[] = [];
  /** The song whose lyrics the box holds, and the lyrics written into it. */
  private key = "";
  private lyrics: Lyrics | null | undefined;
  private clock: LyricsClock | undefined;
  private current = -1;
  /** The row kept at the line's place: the lit one, or the first before the song reaches it. */
  private anchor = -1;
  /** The box was just written: its first state is set without motion, its first line placed at once. */
  private fresh = true;
  private placed = false;
  /** The lit line's words, while they light up one by one. */
  private words: HTMLElement[] = [];
  private wordsLine = -1;
  private timer = 0;
  private holdTimer = 0;
  private heldUntil = 0;
  private lastPosition: number | undefined;
  private reduced = false;
  private readonly resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => this.follow(false, this.anchor));
  private readonly hold = () => {
    this.heldUntil = performance.now() + HOLD_MS;
    window.clearTimeout(this.holdTimer);
    this.holdTimer = window.setTimeout(() => this.follow(!this.reduced, this.anchor), HOLD_MS + 20);
  };

  setReduced(reduced: boolean) {
    if (this.reduced === reduced) return;
    this.reduced = reduced;
    this.clearWords();
    this.sync();
  }

  /** The box of the document just written (or still shown); none when the details have no box. */
  attach(box: HTMLElement | null) {
    if (box === this.box) return;
    this.release();
    this.box = box;
    this.list = box?.querySelector<HTMLElement>(".lyrics-list") ?? null;
    this.key = "";
    this.lyrics = undefined;
    this.fresh = true;
    if (!box) return;
    for (const event of ["wheel", "touchstart", "pointerdown"] as const) box.addEventListener(event, this.hold, { passive: true });
    this.resize?.observe(box);
  }

  /**
   * The lyrics of the song that plays, on its details: `key` names the song, `lyrics` is undefined
   * while they are being read and null when it has none; `clock` says where it is. They follow it
   * only while `running` (the details show).
   */
  show(key: string, lyrics: Lyrics | null | undefined, clock: LyricsClock, running = true) {
    if (!this.box) return;
    this.clock = clock;
    if (key !== this.key || lyrics !== this.lyrics) {
      this.key = key;
      this.lyrics = lyrics;
      this.render();
    }
    this.setState(lyrics === undefined ? "wait" : lyrics?.lines.length ? "shown" : "none");
    if (running) this.sync();
    else this.stop();
  }

  /** The details do not show the song that plays (or are not open): nothing runs. */
  hide() {
    if (!this.box) return;
    this.setState("off");
    this.stop();
  }

  /** Where the song is now: light its line and its words sung so far, and wait for the next change. */
  sync() {
    window.clearTimeout(this.timer);
    this.timer = 0;
    const lyrics = this.lyrics, box = this.box;
    if (!box || box.dataset.lyrics !== "shown" || !lyrics?.synced || !this.clock) return this.stop();
    // No reading this moment (NetEase silent for a poll): what is lit stays until the clock is back.
    const position = this.clock.position();
    if (position === undefined) return;
    const index = lineAt(lyrics.lines, position);
    this.light(index);
    // Before the first words (a new song, its intro) the first line waits at the line's place.
    if (index < 0 && position < lyrics.lines[0].start) this.follow(this.placed && !this.reduced, 0);
    const word = this.syncWords(index, position);
    if (!this.clock.playing()) {
      this.lastPosition = undefined;
      return;
    }
    const next = Math.min(nextChange(lyrics.lines, position) ?? Infinity, word ?? Infinity);
    if (next === Infinity) return;
    // A clock that stands still (NetEase silent for a moment) is not asked again at once.
    const stalled = this.lastPosition !== undefined && position <= this.lastPosition;
    this.lastPosition = position;
    const wait = Math.max(16, (next - position) * 1000 + 10);
    this.timer = window.setTimeout(() => this.sync(), stalled ? Math.max(wait, 250) : wait);
  }

  private setState(state: LyricsState) {
    const box = this.box!;
    const motion = this.fresh || this.reduced ? "off" : "on";
    this.fresh = false;
    if (box.dataset.lyrics === state) return;
    box.dataset.motion = motion;
    box.dataset.lyrics = state;
    if (state === "shown") {
      // Placed at once where the song is, then followed.
      this.placed = false;
      this.light(-1);
    }
  }

  private render() {
    this.stop();
    this.current = this.anchor = -1;
    this.placed = false;
    const lyrics = this.lyrics, list = this.list, box = this.box!;
    box.dataset.synced = String(!!lyrics?.synced);
    if (!list) return;
    list.innerHTML = (lyrics?.lines ?? [])
      .map((line) => {
        if (!line.text) return '<p class="lyric-line lyric-gap" aria-hidden="true"></p>';
        const text = line.words?.length ? line.words.map((word) => `<span class="lyric-word">${esc(word.text)}</span>`).join("") : esc(line.text);
        return `<p class="lyric-line"><span class="lyric-text">${text}</span>${line.translation ? `<span class="lyric-translation">${esc(line.translation)}</span>` : ""}</p>`;
      })
      .join("");
    this.rows = [...list.children] as HTMLElement[];
    box.scrollTop = 0;
  }

  /** Light line `index` (none for -1: before the first words, or a pause after a line's end). */
  private light(index: number) {
    if (index === this.current) {
      if (!this.placed && index >= 0) this.follow(false);
      return;
    }
    this.rows[this.current]?.removeAttribute("aria-current");
    this.current = index;
    if (index < 0) return;
    this.rows[index]?.setAttribute("aria-current", "true");
    this.follow(this.placed && !this.reduced);
  }

  /** Scroll row `at` (the lit line) to the line's place, unless the user has the lyrics in hand. */
  private follow(smooth: boolean, at = this.current) {
    const box = this.box, row = this.rows[at];
    if (!box || !row || box.dataset.lyrics !== "shown") return;
    this.anchor = at;
    if (performance.now() < this.heldUntil) return;
    const top = Math.max(0, row.offsetTop + row.offsetHeight / 2 - box.clientHeight * FOCUS);
    this.placed = true;
    if (Math.abs(box.scrollTop - top) < 1) return;
    box.scrollTo({ top, behavior: smooth ? "smooth" : "instant" });
  }

  /**
   * The lit line's words: those begun by `position` in ink (`sung`), the others muted. Returns when
   * the next of them starts (none without word timing, or with reduced motion: the line is lit whole).
   */
  private syncWords(index: number, position: number): number | undefined {
    const words = index >= 0 && !this.reduced ? this.lyrics?.lines[index]?.words : undefined;
    if (!words?.length) {
      this.clearWords();
      return undefined;
    }
    if (this.wordsLine !== index) {
      this.clearWords();
      this.wordsLine = index;
      this.words = [...(this.rows[index]?.querySelectorAll<HTMLElement>(".lyric-word") ?? [])];
      this.box!.dataset.words = "on";
    }
    let next: number | undefined;
    words.forEach((word, at) => {
      const sung = word.start <= position;
      this.words[at]?.classList.toggle("sung", sung);
      if (!sung && next === undefined) next = word.start;
    });
    return next;
  }

  private clearWords() {
    for (const word of this.words) word.classList.remove("sung");
    this.words = [];
    this.wordsLine = -1;
    if (this.box) delete this.box.dataset.words;
  }

  private stop() {
    window.clearTimeout(this.timer);
    this.timer = 0;
    this.lastPosition = undefined;
    this.clearWords();
  }

  private release() {
    this.stop();
    window.clearTimeout(this.holdTimer);
    this.heldUntil = 0;
    if (this.box) {
      for (const event of ["wheel", "touchstart", "pointerdown"] as const) this.box.removeEventListener(event, this.hold);
      this.resize?.unobserve(this.box);
    }
    this.box = this.list = null;
    this.rows = [];
    this.current = this.anchor = -1;
  }
}
