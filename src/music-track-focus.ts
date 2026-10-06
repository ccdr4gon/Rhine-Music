/** One cancellable search reveal, scoped to the detail pane rather than the page. */
export class MusicTrackFocus {
  private cleanup?: () => void;

  cancel() {
    this.cleanup?.();
  }

  reveal(container: HTMLElement, row: HTMLButtonElement, reduced: boolean) {
    this.cancel();
    let frame = 0;
    let hold: ReturnType<typeof setTimeout> | undefined;
    let tag: HTMLElement | undefined;
    let active = true;
    const cancel = () => {
      if (!active) return;
      active = false;
      cancelAnimationFrame(frame);
      clearTimeout(hold);
      row.classList.remove("search-track-hit");
      tag?.remove();
      container.removeEventListener("wheel", cancel);
      container.removeEventListener("pointerdown", cancel);
      container.removeEventListener("touchstart", cancel);
      container.removeEventListener("keydown", cancel);
      window.removeEventListener("resize", cancel);
      this.cleanup = undefined;
    };
    this.cleanup = cancel;
    // A user's own scroll or click always takes precedence over search motion.
    container.addEventListener("wheel", cancel, { passive: true });
    container.addEventListener("pointerdown", cancel, { passive: true });
    container.addEventListener("touchstart", cancel, { passive: true });
    container.addEventListener("keydown", cancel);
    window.addEventListener("resize", cancel);

    const tabsHeight = container.querySelector<HTMLElement>(".music-tabs")?.offsetHeight ?? 0;
    const start = container.scrollTop;
    const rowTop = row.getBoundingClientRect().top - container.getBoundingClientRect().top + start;
    const centerOffset = tabsHeight + Math.max(0, (container.clientHeight - tabsHeight - row.offsetHeight) / 2);
    const target = Math.max(0, Math.min(container.scrollHeight - container.clientHeight, rowTop - centerOffset));
    // The design's search hit (2026-10-05): a 1 px ink outline round the row and a 搜索结果 tag
    // on its top edge, for 1100 ms; the tag fades in its last 30 % (CSS), or not with reduced motion.
    const highlight = () => {
      if (!active || !row.isConnected) { cancel(); return; }
      row.focus({ preventScroll: true });
      row.classList.add("search-track-hit");
      tag = document.createElement("span");
      tag.className = "track-hit-tag";
      tag.setAttribute("aria-hidden", "true");
      tag.textContent = "搜索结果";
      tag.dataset.reduced = String(reduced);
      row.append(tag);
      hold = setTimeout(cancel, 1100);
    };
    if (reduced || Math.abs(target - start) < 1) {
      container.scrollTop = target;
      highlight();
      return;
    }
    const duration = Math.min(700, 320 + Math.abs(target - start) * 0.12);
    const started = performance.now();
    const scroll = (now: number) => {
      if (!active || !row.isConnected) { cancel(); return; }
      const progress = Math.min(1, (now - started) / duration);
      const eased = progress < 0.5
        ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
      container.scrollTop = start + (target - start) * eased;
      if (progress < 1) frame = requestAnimationFrame(scroll);
      else highlight();
    };
    frame = requestAnimationFrame(scroll);
  }
}
