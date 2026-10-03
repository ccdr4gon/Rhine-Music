/// <reference lib="webworker" />
// Paints covers and builds their mip chains off the main thread. One job at a
// time; prints (priority) jump the queue, and queued jobs can be cancelled
// when the shelf has already moved on.
import { coverMipmaps } from "./cover-mipmaps.ts";
import { paintCoverArt } from "./cover-paint.ts";
import type { CoverJob, CoverReply } from "./cover-tiles.ts";

type Decoded = { bitmap: ImageBitmap; width: number; height: number };
const scope = self as unknown as DedicatedWorkerGlobalScope;
const queue: CoverJob[] = [];
const decoded = new Map<string, Promise<Decoded | undefined>>();
let busy = false;

function decode(url: string) {
  let pending = decoded.get(url);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(url);
      if (!response.ok) return undefined;
      const full = await createImageBitmap(await response.blob());
      const { width, height } = full;
      // Retain bounded thumbnails, not decoded multi-megapixel source art.
      const scale = Math.min(1, 1024 / Math.max(width, height));
      if (scale === 1) return { bitmap: full, width, height };
      const bitmap = await createImageBitmap(full, {
        resizeWidth: Math.max(1, Math.round(width * scale)),
        resizeHeight: Math.max(1, Math.round(height * scale)),
        resizeQuality: "high",
      });
      full.close();
      return { bitmap, width, height };
    })().catch(() => undefined);
    decoded.set(url, pending);
    // Jobs run one at a time, so an evicted bitmap is never in use.
    if (decoded.size > 24) {
      const [oldest, value] = decoded.entries().next().value!;
      decoded.delete(oldest);
      void value.then((image) => image?.bitmap.close());
    }
  }
  return pending;
}

async function paint(job: CoverJob): Promise<CoverReply> {
  const canvas = new OffscreenCanvas(job.size, job.size);
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  const image = job.url ? await decode(job.url) : undefined;
  const scale = paintCoverArt(context, job.size, {
    image: image && { source: image.bitmap, width: image.width, height: image.height },
    title: job.title,
    external: job.external,
  });
  const levels = coverMipmaps(context.getImageData(0, 0, job.size, job.size).data, job.size);
  return { id: job.id, levels, scale };
}

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const job = queue.shift()!;
    try {
      const reply = await paint(job);
      if ("levels" in reply) scope.postMessage(reply, reply.levels.map((level) => level.data.buffer));
    } catch (error) {
      scope.postMessage({ id: job.id, error: String(error) } satisfies CoverReply);
    }
  }
  busy = false;
}

scope.onmessage = (event: MessageEvent<CoverJob | { cancel: number }>) => {
  const message = event.data;
  if ("cancel" in message) {
    const index = queue.findIndex((job) => job.id === message.cancel);
    if (index >= 0) queue.splice(index, 1);
    return;
  }
  if (message.priority) queue.unshift(message);
  else queue.push(message);
  void pump();
};
