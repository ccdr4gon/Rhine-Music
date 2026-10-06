import type { MusicLibrary } from "../../music-types";

/**
 * The local music service's API on 127.0.0.1: the Windows client's own (src-tauri
 * local_music/connector/server.rs), or `npm run music` in a browser. A failed call keeps the
 * service's own error text, or names the status it failed with.
 */
async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(
    url,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json().catch(() => null);
  if (!response.ok || !data)
    throw new Error(data?.error || `本地服务请求失败 (${response.status})`);
  return data as T;
}

/** The online lookups' settings, as the library panel shows them. */
export interface OnlineConfig {
  musicBrainzContact?: string;
  musicBrainzConfigured?: boolean;
  onlineEnabled?: boolean;
}

/** The library: songs, the main folder's playlists and the state of a scan or lookup under way. */
export const readLibrary = () => request<MusicLibrary>("/api/library");
/** Start a scan; with `roots`, the folders to save first (the main folder first). */
export const scanLibrary = (roots?: string[]) =>
  request<MusicLibrary>("/api/library/scan", roots ? { roots } : {});
/** Look up genres and producers online, for the albums given or for every album. */
export const enrichLibrary = (albumIds?: string[]) =>
  request("/api/library/enrich", albumIds ? { albumIds } : {});
/** Look up introductions again, for the albums given or for every album. */
export const startIntroductions = (albumIds?: string[]) =>
  request<MusicLibrary>("/api/library/introductions", {
    ...(albumIds ? { albumIds } : {}),
    force: true,
  });
export const readOnlineConfig = () => request<OnlineConfig>("/api/config");
export const saveOnlineConfig = (config: { musicBrainzContact: string; onlineEnabled: boolean }) =>
  request("/api/config", config);
// The genre rules (/api/genre-rules) stay in the service; the page no longer edits them: the
// columns are the main folder's playlists (2026-10-06).
