/** Small native bridge; the shared player keeps its browser development path. */
declare global {
  interface Window {
    __RHINE_DESKTOP__?: boolean;
    __TAURI__?: { core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> } };
  }
}
export const isDesktop = window.__RHINE_DESKTOP__ === true;
let preferenceWrites = Promise.resolve();
export function saveDesktopPreferences(preferences: unknown): void {
  if (!isDesktop || !window.__TAURI__) return;
  preferenceWrites = preferenceWrites.catch(() => {}).then(() =>
    window.__TAURI__!.core.invoke<void>("save_preferences", { preferences })
  );
  void preferenceWrites.catch((error) => console.error("无法保存播放器偏好", error));
}
export async function flushDesktopPreferences(): Promise<void> {
  await preferenceWrites;
}
export async function chooseMusicFolders(initialDirectory?: string): Promise<string[]> {
  if (!isDesktop || !window.__TAURI__) return [];
  return window.__TAURI__.core.invoke<string[]>("choose_music_folders", { initialDirectory });
}
