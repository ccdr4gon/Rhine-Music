import "./music-boot.css";
import { MUSIC_INTRO } from "./motion";

// Begin at the first live 3D frame; keep the authored camera/wave timebase.
const START_TIME = MUSIC_INTRO.start;
// End in the preview hold, before the reference begins its second extraction (about 4.2 s
// after the start: one wave, and the pull back MUSIC_INTRO.lead earlier than the film's).
const END_TIME = MUSIC_INTRO.end;
const REVEAL_DURATION = 720;
const REVEAL_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
// Keys that only change another key: pressed alone, they do not end the opening.
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock", "NumLock", "ScrollLock", "Fn"]);
const ease = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};
export interface MusicBootFrame {
  cinema: { reveal: number; lift: number; zoom: number; time: number; musicIntro: true };
  renderScene: boolean;
  phase: "array" | "select";
  appTime: number;
}
export interface MusicBootOptions {
  onStart?: () => void;
  onComplete?: (reason: "complete" | "skip") => void;
  /** A press ended the fade-in before its time: the page's own fades (the shelf's) end with it. */
  onRevealCut?: () => void;
  reduced?: boolean | (() => boolean);
  /**
   * Whether the opening plays (the 「开场动画」 setting; on unless false). Off, start() goes
   * straight to the shelf the way the skip button and reduced motion do.
   */
  intro?: boolean | (() => boolean);
  album?: () => { title: string; artist?: string } | null | undefined;
}
type SavedSibling = {
  node: HTMLElement;
  inert: boolean;
  visibility: string;
  priority: string;
};

/** The opening is the live scene; this transparent layer only owns skip/focus. */
export class MusicBoot {
  readonly root: HTMLElement;
  private readonly skipButton: HTMLButtonElement;
  private startedAt = 0;
  private running = false;
  private revealing = false;
  private revealRevision = 0;
  private revealAnimations: Animation[] = [];
  private revealFocus: HTMLElement | null = null;
  private endpointRendered = false;
  private disposed = false;
  private siblings: SavedSibling[] = [];
  private opener: HTMLElement | null = null;

  constructor(private parent: HTMLElement, private options: MusicBootOptions = {}) {
    this.root = document.createElement("section");
    this.root.className = "music-boot-overlay";
    this.root.hidden = true;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", "专辑阵列进场");
    this.root.tabIndex = -1;
    this.skipButton = document.createElement("button");
    this.skipButton.type = "button";
    this.skipButton.className = "music-boot-skip";
    this.skipButton.textContent = "跳过进场 ↗";
    this.root.appendChild(this.skipButton);
    this.parent.appendChild(this.root);
    this.skipButton.addEventListener("click", () => this.skip());
    // Any press ends the opening (the owner, 2026-10-06), as 跳过进场 does: the pointer pressed
    // anywhere on it (the window's own title bar lies above this layer and keeps working), or a
    // key. During the fade-in that follows, the same press shows the whole page at once. The
    // press does nothing else: the page beneath stays inert until then, and the key is kept from it.
    this.root.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || event.button !== 0 || !this.active) return;
      this.swallowClick();
      this.end();
    });
    document.addEventListener("keydown", this.onKey, true);
    document.addEventListener("keyup", this.onKeyUp, true);
  }
  get active() { return this.running || this.revealing; }
  // The key that ended the opening (or was kept from the page during it), while it is held down:
  // by its code, or by its name when it comes without one (keys sent by some tools).
  private heldKey = "";
  private readonly onKey = (event: KeyboardEvent) => {
    if (!this.active || this.disposed) {
      // Held past the end, its repeats do not reach the page either; a fresh press of it does.
      if (this.heldKey && (event.code || event.key) === this.heldKey) {
        if (event.repeat) {
          event.stopPropagation();
          event.preventDefault();
          return;
        }
        this.heldKey = "";
      }
      return;
    }
    // The window's own title bar keeps its keys (window-frame.ts).
    if ((event.target as Element | null)?.closest?.(".window-bar")) return;
    event.stopPropagation();
    // A modifier alone, or a shortcut with Ctrl, Alt or the Windows key, ends nothing.
    if (MODIFIER_KEYS.has(event.key) || event.ctrlKey || event.altKey || event.metaKey) return;
    event.preventDefault();
    this.heldKey = event.code || event.key;
    if (!event.repeat) this.end();
  };
  private readonly onKeyUp = (event: KeyboardEvent) => {
    if (!this.heldKey || (event.code || event.key) !== this.heldKey) return;
    this.heldKey = "";
    event.stopPropagation();
    event.preventDefault();
  };
  /**
   * The click of the press that ended the opening: kept from the page. A tap's click is aimed
   * after the finger lifts, when the page may already be shown (the fade-in cut short, or
   * reduced motion), and it would act on the control there.
   */
  private swallowClick() {
    const done = () => {
      clearTimeout(timer);
      document.removeEventListener("click", swallow, true);
      document.removeEventListener("pointercancel", done, true);
    };
    const swallow = (event: Event) => {
      event.stopPropagation();
      event.preventDefault();
      done();
    };
    const timer = setTimeout(done, 1000);
    document.addEventListener("click", swallow, true);
    document.addEventListener("pointercancel", done, true);
  }
  /** A press: the opening is skipped while it runs, and its fade-in completed while that runs. */
  private end() {
    if (this.running) this.skip();
    else if (this.revealing) {
      this.completeReveal();
      this.options.onRevealCut?.();
    }
  }

  start(nowSeconds = performance.now() / 1000, forceMotion = false) {
    if (this.disposed) return;
    if (!Number.isFinite(nowSeconds)) nowSeconds = performance.now() / 1000;
    if (this.revealing) this.completeReveal(false);
    if (!this.running) {
      this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // The window's own title bar (window-frame.ts) stays usable during the intro.
      this.siblings = [...this.parent.children]
        .filter((node): node is HTMLElement => node instanceof HTMLElement && node !== this.root &&
          !node.classList.contains("window-bar"))
        .map((node) => ({ node, inert: node.inert,
          visibility: node.style.getPropertyValue("visibility"),
          priority: node.style.getPropertyPriority("visibility") }));
      for (const { node } of this.siblings) {
        node.inert = true;
        if (!node.classList.contains("three-scene")) node.style.setProperty("visibility", "hidden");
      }
    }
    this.running = true;
    this.endpointRendered = false;
    this.parent.dataset.musicBoot = "running";
    this.startedAt = nowSeconds - START_TIME;
    this.root.hidden = false;
    this.root.setAttribute("aria-label", "专辑阵列进场");
    this.skipButton.hidden = false;
    this.options.onStart?.();
    const reduced = typeof this.options.reduced === "function" ? this.options.reduced() : this.options.reduced;
    const intro = typeof this.options.intro === "function" ? this.options.intro() : this.options.intro ?? true;
    // Skipped before any frame of the opening is drawn: the shelf is the first picture.
    if ((reduced || !intro) && !forceMotion) { this.skip(); return; }
    this.skipButton.focus({ preventScroll: true });
  }
  replay(nowSeconds = performance.now() / 1000) { this.start(nowSeconds, true); }
  skip() { if (this.running && !this.disposed) this.finish("skip"); }

  update(nowSeconds: number): MusicBootFrame | undefined {
    if (this.revealing && this.isReduced()) this.completeReveal();
    if (!this.running || this.disposed || !Number.isFinite(nowSeconds)) return;
    if (this.endpointRendered) { this.finish("complete"); return; }
    const appTime = Math.min(END_TIME, Math.max(START_TIME, nowSeconds - this.startedAt));
    this.endpointRendered = appTime === END_TIME;
    const phase = appTime + MUSIC_INTRO.lead >= 25.68 ? "select" : "array";
    this.root.dataset.phase = phase;
    this.root.dataset.appTime = String(appTime);
    return {
      appTime, phase, renderScene: true,
      cinema: {
        reveal: ease((appTime - 21.9) / 0.13),
        lift: 0,
        zoom: 0,
        time: appTime,
        musicIntro: true,
      },
    };
  }
  private finish(reason: "complete" | "skip", notify = true) {
    this.running = false;
    this.root.hidden = true;
    for (const { node, inert, visibility, priority } of this.siblings) {
      node.inert = inert;
      if (visibility) node.style.setProperty("visibility", visibility, priority);
      else node.style.removeProperty("visibility");
    }
    // The completion hook owns the camera endpoint and browse surface fade. It
    // must run while active is false so showBrowseSurface can start normally.
    if (notify) this.options.onComplete?.(reason);
    this.revealFocus = document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body && !this.root.contains(document.activeElement)
      ? document.activeElement : this.opener;
    if (!notify || this.isReduced()) {
      this.siblings = [];
      this.parent.dataset.musicBoot = "done";
      if (notify) this.restoreFocus();
      return;
    }

    // Snapshot the hook's final interaction state, then keep the whole stage
    // locked until the controls are visible. All of this happens before paint.
    for (const sibling of this.siblings) {
      sibling.inert = sibling.node.inert;
      sibling.node.inert = true;
    }
    this.revealing = true;
    this.parent.dataset.musicBoot = "revealing";
    this.root.hidden = false;
    this.skipButton.hidden = true;
    this.root.setAttribute("aria-label", "正在显示音乐库");
    this.root.focus({ preventScroll: true });
    const revision = ++this.revealRevision;
    const fade = (selector: string, delay = 0) => {
      const node = this.parent.querySelector<HTMLElement>(selector);
      if (!node || node.hidden) return;
      this.revealAnimations.push(node.animate(
        [{ opacity: 0 }, { opacity: getComputedStyle(node).opacity }],
        { duration: REVEAL_DURATION - delay, delay, easing: REVEAL_EASE, fill: "both" },
      ));
    };
    fade(".music-vignette");
    fade(".music-header");
    fade(".library-status", 45);
    fade(".music-empty", 60);
    // SurfaceTransition owns the navigation container's opacity. Stagger its
    // inner groups so the intro never reads/overrides that in-flight fade.
    for (const selector of [".music-counter", ".album-stepper"])
      fade(selector, 110);
    // Keep navigation geometry stable for the title's bottom clearance. Move
    // callout/keyhint with independent translate, preserving existing transforms.
    for (const [selector, delay] of [
      [".album-callout", 60], [".music-keyhint", 140],
    ] as const) {
      const node = this.parent.querySelector<HTMLElement>(selector);
      if (!node) continue;
      this.revealAnimations.push(node.animate(
        [{ translate: "0 8px" }, { translate: getComputedStyle(node).translate }],
        { duration: REVEAL_DURATION - delay, delay, easing: REVEAL_EASE, fill: "both" },
      ));
    }
    void Promise.all(this.revealAnimations.map((animation) => animation.finished))
      .then(() => {
        if (revision === this.revealRevision && !this.disposed) this.completeReveal();
      }).catch(() => {});
  }
  private isReduced() {
    return typeof this.options.reduced === "function" ? this.options.reduced() : this.options.reduced;
  }
  private restoreFocus() {
    if (this.revealFocus?.isConnected && !this.revealFocus.closest("[inert], [hidden]"))
      this.revealFocus.focus({ preventScroll: true });
    this.revealFocus = null;
  }
  private completeReveal(restoreFocus = true) {
    this.revealRevision++;
    this.revealAnimations.forEach((animation) => animation.cancel());
    this.revealAnimations = [];
    this.revealing = false;
    this.root.hidden = true;
    this.parent.dataset.musicBoot = "done";
    for (const { node, inert } of this.siblings) node.inert = inert;
    this.siblings = [];
    if (restoreFocus) this.restoreFocus();
    else this.revealFocus = null;
  }
  dispose() {
    if (this.disposed) return;
    if (this.running) this.finish("skip", false);
    if (this.revealing) this.completeReveal(false);
    this.disposed = true;
    document.removeEventListener("keydown", this.onKey, true);
    document.removeEventListener("keyup", this.onKeyUp, true);
    this.root.remove();
  }
}
