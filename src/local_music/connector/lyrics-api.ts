import { decodeLyricBytes, parseLrc, type Lyrics } from "../../lyrics";

/** Songs whose lyrics are kept (in memory only). */
const KEEP = 32;
/** A song found without lyrics is asked again after this long (an .lrc may have been added). */
const NONE_MS = 30_000;

/**
 * A local song's lyrics for its details (the owner, 2026-10-17: ".lrc files and song tags"): read
 * from the music service (`/api/lyrics/<id>`: the song's .lrc beside it, else its tags, only read),
 * decoded and parsed here. Kept for the last songs in memory only.
 */
export class LocalLyrics {
  private readonly known = new Map<string, { lyrics: Lyrics | null; at: number }>();
  private readonly loading = new Set<string>();

  constructor(private readonly changed: () => void) {}

  /** The song's lyrics: null when it has none, undefined while they are not known. */
  get(trackId: string): Lyrics | null | undefined {
    return this.known.get(trackId)?.lyrics;
  }

  /** Read the song's lyrics unless they are known or being read (none is asked again now and then). */
  want(trackId: string) {
    const entry = this.known.get(trackId);
    if (!trackId || this.loading.has(trackId) || (entry && (entry.lyrics || performance.now() - entry.at < NONE_MS))) return;
    this.loading.add(trackId);
    void readLocalLyrics(trackId)
      .catch(() => null)
      .then((lyrics) => {
        this.known.delete(trackId);
        this.known.set(trackId, { lyrics, at: performance.now() });
        for (const key of this.known.keys()) {
          if (this.known.size <= KEEP) break;
          this.known.delete(key);
        }
      })
      .finally(() => {
        this.loading.delete(trackId);
        this.changed();
      });
  }
}

export async function readLocalLyrics(trackId: string): Promise<Lyrics | null> {
  const response = await fetch(`/api/lyrics/${encodeURIComponent(trackId)}`, { cache: "no-store" });
  if (response.status === 204 || response.status === 404) return null;
  if (!response.ok) throw new Error(`歌词读取失败（${response.status}）`);
  return parseLrc(decodeLyricBytes(await response.arrayBuffer()));
}
