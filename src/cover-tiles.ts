import { coverMipmaps, type CoverMip } from "./cover-mipmaps.ts";
import { paintCoverArt } from "./cover-paint.ts";

export type CoverRequest = { size: number; url?: string; title?: string; external?: boolean; priority?: boolean };
export type CoverJob = CoverRequest & { id: number };
export type CoverTile = { levels: CoverMip[]; scale: [number, number] };
export type CoverReply = ({ id: number } & CoverTile) | { id: number; error: string };

/** Resolve against the page so the worker fetches exactly what an <img> would. */
function absolute(url?: string) {
  if (!url) return undefined;
  return typeof location === "undefined" ? url : new URL(url, location.href).href;
}

async function loadImage(url: string) {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.src = url;
  try {
    await image.decode();
    return { source: image, width: image.naturalWidth, height: image.naturalHeight };
  } catch {
    return undefined;
  }
}

function blankLevels(size: number) {
  const levels = [];
  for (let width = size; width >= 1; width /= 2) levels.push({ data: new Uint8Array(width * width * 4), width, height: width });
  return levels;
}

/** Same result as the worker, for environments without workers/OffscreenCanvas. */
export async function paintCoverTile(request: CoverRequest): Promise<CoverTile> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = request.size;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  const image = request.url ? await loadImage(request.url) : undefined;
  const scale = paintCoverArt(context, request.size, { image, title: request.title, external: request.external });
  return { levels: coverMipmaps(context.getImageData(0, 0, request.size, request.size).data, request.size), scale };
}

/**
 * Cover painting and mip building leave the main thread: navigating the shelf
 * previously recomputed every newly visible cover synchronously (up to ~250 ms
 * per frame). Requests never reject; a failed image paints the explicit
 * missing-cover print, exactly as before. A cancelled request settles with
 * null, so nothing awaiting a superseded cover waits forever.
 */
export class CoverTiles {
  private worker?: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, { job: CoverJob; resolve: (tile: CoverTile | null) => void }>();

  constructor() {
    try {
      if (typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined") {
        this.worker = new Worker(new URL("./cover-worker.ts", import.meta.url), { type: "module" });
        this.worker.onmessage = (event: MessageEvent<CoverReply>) => this.receive(event.data);
        this.worker.onerror = () => this.fallBack();
      }
    } catch {
      this.worker = undefined;
    }
  }

  render(request: CoverRequest): { id: number; tile: Promise<CoverTile | null> } {
    const job: CoverJob = { ...request, url: absolute(request.url), id: this.nextId++ };
    const tile = new Promise<CoverTile | null>((resolve) => {
      this.pending.set(job.id, { job, resolve });
      if (this.worker) this.worker.postMessage(job);
      else this.paintHere(job);
    });
    return { id: job.id, tile };
  }

  /** The result is no longer needed; a queued job is dropped before it runs. */
  cancel(id: number) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    this.worker?.postMessage({ cancel: id });
    entry.resolve(null);
  }

  dispose() {
    this.worker?.terminate();
    this.worker = undefined;
    for (const { resolve } of this.pending.values()) resolve(null);
    this.pending.clear();
  }

  private receive(reply: CoverReply) {
    const entry = this.pending.get(reply.id);
    if (!entry) return;
    if ("error" in reply) {
      this.paintHere(entry.job);
      return;
    }
    this.pending.delete(reply.id);
    entry.resolve(reply);
  }

  private paintHere(job: CoverJob) {
    void paintCoverTile(job)
      // A print that cannot be painted at all stays hidden rather than stale.
      .catch((): CoverTile => ({ levels: blankLevels(job.size), scale: [0, 0] }))
      .then((tile) => {
        const entry = this.pending.get(job.id);
        if (!entry) return;
        this.pending.delete(job.id);
        entry.resolve(tile);
      });
  }

  private fallBack() {
    this.worker?.terminate();
    this.worker = undefined;
    for (const { job } of this.pending.values()) this.paintHere(job);
  }
}
