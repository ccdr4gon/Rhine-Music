import { isDesktop } from "./desktop";
import "./window-frame.css";

type FrameWindow = {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  isFullscreen(): Promise<boolean>;
  setFullscreen(fullscreen: boolean): Promise<void>;
  onResized(handler: () => void): Promise<() => void>;
};
let frameWindow: FrameWindow | undefined;
let refreshFrame: (() => Promise<void>) | undefined;
let fullscreenChanging = false;
/** The header and Settings use the same native fullscreen state; browsers retain their own API. */
export async function toggleWindowFullscreen() {
  if (!frameWindow) {
    return document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
  }
  if (fullscreenChanging) return;
  fullscreenChanging = true;
  try {
    await frameWindow.setFullscreen(!await frameWindow.isFullscreen());
    await refreshFrame?.();
  } finally { fullscreenChanging = false; }
}

// Uniform strokes, with the two diagonal arrows pointing out / in for fullscreen / exit.
const glyph = (body: string) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${body}</svg>`;
const ICONS = {
  fullscreen: glyph('<path d="M9 2h5v5M14 2 9 7M7 14H2V9M2 14l5-5"/>'),
  exitFullscreen: glyph('<path d="M14 7H9V2M9 7l5-5M2 9h5v5M7 9l-5 5"/>'),
  minimize: glyph('<path d="M3 8h10"/>'),
  maximize: glyph('<rect x="3" y="3" width="10" height="10"/>'),
  close: glyph('<path d="m3 3 10 10M13 3 3 13"/>'),
} as const;

/** The drag strip remains at the top; independent window controls align with a slot in the header. */
export function installWindowFrame(host: HTMLElement) {
  const tauri = window.__TAURI__ as { window?: { getCurrentWindow(): FrameWindow } } | undefined;
  const current = isDesktop ? tauri?.window?.getCurrentWindow() : undefined;
  if (!current) return;
  frameWindow = current;
  const slot = document.createElement("span");
  slot.className = "window-controls-slot";
  slot.setAttribute("aria-hidden", "true");
  host.querySelector(".music-topnav")?.append(slot);
  const bar = document.createElement("div");
  bar.className = "window-bar";
  bar.setAttribute("data-tauri-drag-region", "");
  bar.innerHTML = `<div class="window-controls" role="group" aria-label="窗口">
    <button type="button" data-window="fullscreen" aria-label="全屏" title="全屏" aria-pressed="false">${ICONS.fullscreen}</button>
    <button type="button" data-window="minimize" aria-label="最小化" title="最小化">${ICONS.minimize}</button>
    <button type="button" data-window="maximize" aria-label="最大化" title="最大化">${ICONS.maximize}</button>
    <button type="button" data-window="close" aria-label="关闭" title="关闭">${ICONS.close}</button>
  </div>`;
  host.append(bar);
  host.dataset.windowFrame = "custom";
  const maximize = bar.querySelector<HTMLButtonElement>('[data-window="maximize"]')!;
  const fullscreen = bar.querySelector<HTMLButtonElement>('[data-window="fullscreen"]')!;
  let revision = 0;
  const sync = refreshFrame = async () => {
    const version = ++revision;
    const [maximized, full] = await Promise.all([current.isMaximized(), current.isFullscreen()]);
    if (version !== revision) return;
    bar.dataset.maximized = String(maximized);
    maximize.title = maximized ? "还原" : "最大化";
    maximize.setAttribute("aria-label", maximize.title);
    if (host.dataset.windowFullscreen !== String(full)) {
      host.dataset.windowFullscreen = String(full);
      fullscreen.innerHTML = full ? ICONS.exitFullscreen : ICONS.fullscreen;
      fullscreen.title = full ? "退出全屏" : "全屏";
      fullscreen.setAttribute("aria-label", fullscreen.title);
      fullscreen.setAttribute("aria-pressed", String(full));
    }
  };
  const report = (error: unknown) => console.error("窗口操作失败", error);
  bar.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-window]");
    if (!button) return;
    event.stopPropagation();
    const action = button.dataset.window;
    const done = action === "fullscreen" ? toggleWindowFullscreen()
      : action === "minimize" ? current.minimize()
      : action === "maximize" ? current.toggleMaximize().then(sync) : current.close();
    void done.catch(report);
  });
  // Mouse presses do not leave Space bound to a window action; keyboard focus still works.
  bar.addEventListener("mousedown", (event) => {
    if ((event.target as Element).closest("[data-window]")) event.preventDefault();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || host.dataset.windowFullscreen !== "true" || event.ctrlKey || event.altKey || event.metaKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.repeat) void current.setFullscreen(false).then(sync).catch(report);
  }, true);
  void current.onResized(() => void sync().catch(report));
  void sync().catch(report);
}
