const enterEase = "cubic-bezier(0.22, 1, 0.36, 1)";
const exitEase = "cubic-bezier(0.4, 0, 1, 1)";

/** How a surface's panel moves: where it comes from on entry and goes to on exit. */
export interface SurfaceMotion {
  from: string;
  to: string;
  /** The entry starts this long (ms) after it is asked for. */
  enterDelay?: number;
  /**
   * A closed surface stays in the page, invisible (visibility: hidden), instead of being
   * hidden: it keeps its layout while its content is replaced in place.
   */
  hold?: boolean;
  /**
   * Each fade target also moves by this `translate` (e.g. "0 6px") while it is away: it rises
   * into place as it fades in and sinks back as it fades out. The individual property leaves a
   * target's own `transform` (the song scene's tilted pane) alone.
   */
  rise?: string;
}
const directions: Record<"up" | "right", SurfaceMotion> = {
  up: { from: "translateY(12px)", to: "translateY(8px)" },
  right: { from: "translateX(36px)", to: "translateX(52px)" },
};
/**
 * The details (Claude Design, 2026-10-05). The page as a whole rises 6 px as it fades in
 * (420 ms) and sinks 6 px as it fades out (200 ms); previous / next inside it swaps only its
 * document: out 170 ms rising 6 px, back in 250 ms from there after 70 ms.
 */
export const DETAIL_SCENE: SurfaceMotion = { from: "translateY(6px)", to: "translateY(6px)" };
export const DETAIL_SWAP: SurfaceMotion = { from: "translateY(-6px)", to: "translateY(-6px)", enterDelay: 70, hold: true };
/**
 * The song scene: its chrome and its pane rise 6 px as they fade in (420 ms) and sink 6 px as
 * they fade out (200 ms). The section itself never moves or fades (song-scene.css).
 */
export const SONG_SCENE: SurfaceMotion = { from: "none", to: "none", rise: "0 6px" };

/** Owns the visible lifetime, including a close that interrupts an opening. */
export class SurfaceTransition {
  private animations: Animation[] = [];
  private revision = 0;

  constructor(
    private root: HTMLElement,
    private panel?: HTMLElement,
    private enterDuration = 300,
    private exitDuration = 200,
    private direction: "up" | "right" | SurfaceMotion = "up",
    private enterEasing = enterEase,
    // Separate overlays can fade together without changing their common
    // ancestor's stacking context or flattening them into a full-screen layer.
    private fadeTargets: readonly HTMLElement[] = [root],
  ) {}

  show(reduced: boolean) {
    this.run(true, reduced);
  }

  hide(reduced: boolean, finished: () => void = () => {}) {
    this.run(false, reduced, finished);
  }

  finish() {
    this.animations.forEach((animation) => animation.finish());
  }

  dispose() {
    this.revision++;
    this.animations.forEach((animation) => animation.cancel());
    this.animations = [];
  }

  private run(show: boolean, reduced: boolean, finished?: () => void) {
    const revision = ++this.revision;
    const motion = typeof this.direction === "string" ? directions[this.direction] : this.direction;
    // A held surface is closed while it is invisible; others while they are hidden.
    const hidden = motion.hold ? this.root.style.visibility === "hidden" : this.root.hidden;
    const opacities = this.fadeTargets.map((target) =>
      hidden ? "0" : getComputedStyle(target).opacity,
    );
    // Where an interrupted rise has got to (a target at rest has none: "none").
    const rises = motion.rise
      ? this.fadeTargets.map((target) => {
          const current = hidden ? motion.rise! : getComputedStyle(target).translate;
          return current && current !== "none" ? current : "0 0";
        })
      : undefined;
    const transform = this.panel
      ? hidden
        ? motion.from
        : getComputedStyle(this.panel).transform
      : undefined;
    this.animations.forEach((animation) => animation.cancel());
    this.animations = [];
    if (motion.hold) this.root.style.removeProperty("visibility");
    else this.root.hidden = false;
    this.root.dataset.transition = show ? "opening" : "closing";
    const complete = () => {
      if (revision !== this.revision) return;
      if (!motion.hold) this.root.hidden = !show;
      else if (!show) this.root.style.visibility = "hidden";
      this.root.dataset.transition = show ? "open" : "closed";
      this.animations.forEach((animation) => animation.cancel());
      this.animations = [];
      finished?.();
    };
    if (reduced || (!show && hidden)) {
      complete();
      return;
    }
    const options: KeyframeAnimationOptions = {
      duration: show ? this.enterDuration : this.exitDuration,
      easing: show ? this.enterEasing : exitEase,
      delay: show ? motion.enterDelay ?? 0 : 0,
      fill: "both",
    };
    const fades = this.fadeTargets.map((target, index) => target.animate(
      rises
        ? [{ opacity: opacities[index], translate: rises[index] }, { opacity: show ? 1 : 0, translate: show ? "0 0" : motion.rise }]
        : [{ opacity: opacities[index] }, { opacity: show ? 1 : 0 }],
      options,
    ));
    this.animations.push(...fades);
    if (this.panel) {
      this.animations.push(
        this.panel.animate(
          [
            { transform },
            { transform: show ? "none" : motion.to },
          ],
          options,
        ),
      );
    }
    void Promise.all(fades.map((fade) => fade.finished)).then(complete).catch(() => {});
  }
}

export class ContentTransition {
  private animation?: Animation;

  reveal(element: HTMLElement, reduced: boolean) {
    const opacity =
      this.animation?.playState === "running"
        ? getComputedStyle(element).opacity
        : "0.35";
    this.cancel();
    if (!reduced)
      this.animation = element.animate([{ opacity }, { opacity: 1 }], {
        duration: 150,
        easing: enterEase,
      });
  }

  cancel() {
    this.animation?.cancel();
    this.animation = undefined;
  }
}
