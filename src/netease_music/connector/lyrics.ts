import type { Lyrics } from "../../lyrics";
import { neteaseLyrics } from "../data/lyrics";
import type { DebugPort } from "./ports";

/** While NetEase loads lyrics Rhine asked for, it is read again this often, for at most this long. */
const POLL_MS = 400;
const LOAD_TIMEOUT_MS = 10_000;
/** "None" this soon after asking may be NetEase not yet loading: it is read again first. */
const SETTLE_MS = 1200;
/** A song whose lyrics could not be read is not asked about again for this long. */
const RETRY_MS = 30_000;
/** Asked for a song NetEase no longer plays: not asked again before the next reading of its state. */
const CHANGED_MS = 2000;
/** Songs whose lyrics are kept (in memory only). */
const KEEP = 24;

/**
 * The lyrics of the song NetEase plays, for its details (the owner, 2026-10-17: "NetEase's loaded
 * lyrics" and "Rhine asks NetEase to load them"): once per song Rhine reads, through the debugging
 * port, what NetEase holds for it; when NetEase holds another song's, the read first dispatches the
 * action NetEase's own playing page dispatches when it opens, so NetEase loads them (its cache, else
 * its server), and Rhine reads again every POLL_MS until they are there. Kept for the last songs in
 * Rhine's memory only: never saved, sent or logged.
 */
export class NeteaseLyrics {
  private readonly known = new Map<string, Lyrics | null>();
  private readonly failed = new Map<string, number>();
  private loading: string | undefined;
  /** Each read's own number: a read that stop() ended does not go on beside a new one for the same song. */
  private token = 0;
  private warned = "";

  constructor(private readonly port: () => DebugPort, private readonly changed: () => void) {}

  /**
   * The song's lyrics: null when NetEase has none for it, or could not give them lately (the song is
   * asked again after RETRY_MS, and shows none meanwhile, not an empty box); undefined while unknown.
   */
  get(trackId: string): Lyrics | null | undefined {
    if (this.known.has(trackId)) return this.known.get(trackId);
    return this.failed.has(trackId) ? null : undefined;
  }

  /** Read the lyrics of NetEase's song `trackId` (the one it plays) unless they are known or being read. */
  want(trackId: string) {
    if (!trackId || this.known.has(trackId) || this.loading === trackId) return;
    const failed = this.failed.get(trackId);
    if (failed !== undefined && performance.now() - failed < RETRY_MS) return;
    void this.load(trackId);
  }

  /** Stop reading (the port closed, another source): what is known stays. */
  stop() {
    this.loading = undefined;
    this.token += 1;
  }

  private async load(trackId: string) {
    const token = ++this.token;
    this.loading = trackId;
    const started = performance.now();
    let load = true, askedAt = 0;
    try {
      for (;;) {
        const reply = await this.port().lyrics(trackId, load);
        if (this.token !== token) return;
        // NetEase plays another song: that one is asked for when its details show. This one waits for
        // NetEase's next reading (the page's own still names it until then), else it would be asked
        // again at once, and again.
        if (reply.status === "changed") {
          this.failed.set(trackId, performance.now() - RETRY_MS + CHANGED_MS);
          return;
        }
        // NetEase's own load failed (its server, say): asked again after RETRY_MS, not taken as none.
        if (reply.status === "failed") {
          this.failed.set(trackId, performance.now());
          return;
        }
        // With `load` "none" is NetEase's own answer for the song (no lyrics, instrumental); after
        // asking it is NetEase done loading without any, once it had time to start.
        if (reply.status === "ready" || (reply.status === "none" && (load || performance.now() - askedAt >= SETTLE_MS)))
          return this.keep(trackId, reply.status === "ready" ? neteaseLyrics(reply) : null);
        if (reply.status === "asked") {
          load = false;
          askedAt = performance.now();
        }
        if (performance.now() - started >= LOAD_TIMEOUT_MS) {
          this.failed.set(trackId, performance.now());
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (this.token !== token) return;
      }
    } catch (error) {
      if (this.token !== token) return;
      this.failed.set(trackId, performance.now());
      // The port's own messages (never the lyrics), each once.
      const message = String(error instanceof Error ? error.message : error);
      if (message !== this.warned) console.warn(message);
      this.warned = message;
    } finally {
      // A read that was ended or replaced says nothing; any other end (lyrics, none, a back-off) is shown.
      // A song in its back-off is not asked again at once (want), so this never loops.
      if (this.token === token) {
        this.loading = undefined;
        this.changed();
      }
    }
  }

  private keep(trackId: string, lyrics: Lyrics | null) {
    this.known.delete(trackId);
    this.known.set(trackId, lyrics);
    this.failed.delete(trackId);
    for (const key of this.known.keys()) {
      if (this.known.size <= KEEP) break;
      this.known.delete(key);
    }
  }
}
