import { isDesktop } from "./desktop";
import "./window-frame.css";

/**
 * The desktop window has no native title bar (decorations are off in main.rs). This strip
 * takes its place: no title, three buttons at the top right (minimize, maximize / restore,
 * close), and the rest of the window's top edge drags the window (a double click maximizes
 * or restores it, as on a native title bar). It lies over the picture; the header below it
 * keeps its own controls. In a browser, and in fullscreen, there is no strip.
 */
type FrameWindow = {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  onResized(handler: () => void): Promise<() => void>;
};

// The overlay design's glyphs (2026-10-05): 1 px lines, filled marks, in the ink colour.
const glyph = (size: number, body: string) =>
  `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">${body}</svg>`;
const ICONS = {
  // A 10 x 2 bar.
  minimize: glyph(10, '<path class="fill" d="M0 4h10v2H0z"/>'),
  // A 10 x 10 box and a filled 3 x 3 square over its top-left corner.
  maximize: glyph(10, '<path d="M.5.5h9v9h-9z"/><path class="fill" d="M0 0h3v3H0z"/>'),
  // Two overlapping windows (not in the design; drawn at its 1 px weight).
  restore: glyph(10, '<path d="M.5 2.5h7v7h-7zM2.5 2.5V.5h7v7h-2"/>'),
  // Two 14 px lines crossing at the centre of a 12 x 12 box.
  close: glyph(12, '<path class="diagonal" d="M1.05 1.05l9.9 9.9M10.95 1.05l-9.9 9.9"/>'),
} as const;

export function installWindowFrame(host: HTMLElement) {
  const tauri = window.__TAURI__ as { window?: { getCurrentWindow(): FrameWindow } } | undefined;
  const current = isDesktop ? tauri?.window?.getCurrentWindow() : undefined;
  if (!current) return;
  const bar = document.createElement("div");
  bar.className = "window-bar";
  // Tauri's own script drags the window from an element with this attribute (not from its
  // children, so the buttons stay buttons) and maximizes it on a double click.
  bar.setAttribute("data-tauri-drag-region", "");
  bar.innerHTML = `<div class="window-controls" role="group" aria-label="窗口">
    <button type="button" data-window="minimize" aria-label="最小化">${ICONS.minimize}</button>
    <button type="button" data-window="maximize" aria-label="最大化">${ICONS.maximize}</button>
    <button type="button" data-window="close" aria-label="关闭">${ICONS.close}</button>
  </div>`;
  host.append(bar);
  host.dataset.windowFrame = "custom";
  const maximize = bar.querySelector<HTMLButtonElement>('[data-window="maximize"]')!;
  const sync = async () => {
    const maximized = await current.isMaximized().catch(() => false);
    if (bar.dataset.maximized === String(maximized)) return;
    bar.dataset.maximized = String(maximized);
    maximize.innerHTML = maximized ? ICONS.restore : ICONS.maximize;
    maximize.setAttribute("aria-label", maximized ? "还原" : "最大化");
  };
  bar.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-window]");
    if (!button) return;
    // The page's own click handling (sounds, actions) is not for these buttons.
    event.stopPropagation();
    const action = button.dataset.window;
    const done = action === "minimize" ? current.minimize() : action === "maximize" ? current.toggleMaximize() : current.close();
    void done.catch((error) => console.error("窗口操作失败", error));
  });
  // A click does not leave the keyboard focus on a window button: the page's keys (arrows,
  // Esc, S, Space) stay the page's, and Space does not repeat the window action. Keyboard
  // users can still reach the buttons with Tab.
  bar.addEventListener("mousedown", (event) => {
    if ((event.target as Element).closest("[data-window]")) event.preventDefault();
  });
  void current.onResized(() => void sync());
  void sync();
  const fullscreen = () => { bar.hidden = Boolean(document.fullscreenElement); };
  document.addEventListener("fullscreenchange", fullscreen);
  fullscreen();
}
