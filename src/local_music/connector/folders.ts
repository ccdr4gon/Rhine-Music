import { isDesktop } from "../../desktop";

/**
 * The system folder picker (the Windows client) for the main music folder: none or one folder;
 * nothing to choose in a browser. The native command keeps its earlier name.
 */
export async function chooseMusicFolders(initialDirectory?: string): Promise<string[]> {
  if (!isDesktop || !window.__TAURI__) return [];
  return window.__TAURI__.core.invoke<string[]>("choose_music_folders", { initialDirectory });
}
