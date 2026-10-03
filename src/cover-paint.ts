// Dependency-free cover painting shared by the main thread and the cover worker.
export const COVER_PAINT_SIZE = 1024;
// The printed art keeps this margin inside the cover square at every texture
// resolution, so atlas, lifted and returning copies print at the same size.
export const COVER_INSET = 1 / 128;
const COVER_ART = 1 - 2 * COVER_INSET;

export function containCover(
  width: number,
  height: number,
  boxWidth: number,
  boxHeight: number,
) {
  const scale = Math.min(
    boxWidth / Math.max(1, width),
    boxHeight / Math.max(1, height),
  );
  const drawnWidth = width * scale,
    drawnHeight = height * scale;
  return {
    x: (boxWidth - drawnWidth) / 2,
    y: (boxHeight - drawnHeight) / 2,
    width: drawnWidth,
    height: drawnHeight,
  };
}

/**
 * Contain-fit size of the printed art relative to the full cover square. The
 * art fills its whole texture; the print quad takes this size, so the cover's
 * visible border is geometry (multisampled), never an alpha-tested edge whose
 * transparent black margin filtered into flickering dark hairlines.
 */
export function coverArtScale(image?: { width: number; height: number }): [number, number] {
  if (!image) return [COVER_ART, COVER_ART];
  const box = containCover(image.width, image.height, COVER_ART, COVER_ART);
  return [box.width, box.height];
}

export type CoverArt = {
  image?: { source: CanvasImageSource; width: number; height: number };
  title?: string;
  external?: boolean;
};
type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Paints the art across a size × size canvas; returns the print quad's coverArtScale. */
export function paintCoverArt(context: Context2D, size: number, art: CoverArt): [number, number] {
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  // Paint in one logical coordinate space, including fallback art and labels.
  // Ownership can move between atlas/selection/snapshot without rescaling art.
  const width = COVER_PAINT_SIZE,
    height = COVER_PAINT_SIZE;
  context.setTransform(size / width, 0, 0, size / height, 0, 0);
  context.clearRect(0, 0, width, height);
  if (art.image) {
    // Non-square art is stretched to the square texture and un-stretched by
    // its quad: the texture keeps every source texel, and no edge is empty.
    context.drawImage(art.image.source, 0, 0, width, height);
    return coverArtScale(art.image);
  }
  // A missing cover is explicit and never substituted with another album's art.
  context.fillStyle = "#c9c9c4";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "#f8f7f1";
  context.lineWidth = Math.max(1, height / 180);
  context.beginPath();
  context.arc(width / 2, height * 0.43, height * 0.2, 0, Math.PI * 2);
  context.stroke();
  context.beginPath();
  context.arc(width / 2, height * 0.43, height * 0.04, 0, Math.PI * 2);
  context.stroke();
  context.fillStyle = "#3f4849";
  context.textAlign = "center";
  context.font = `500 ${Math.max(12, height * 0.045)}px sans-serif`;
  context.fillText(art.title ?? "暂无专辑封面", width / 2, height * 0.8, height * 0.83);
  context.font = `${Math.max(9, height * 0.025)}px sans-serif`;
  context.fillText(
    art.external ? "EXTERNAL PLAYER / NO COVER" : "LOCAL COLLECTION / NO COVER",
    width / 2,
    height * 0.87,
    height * 0.83,
  );
  return coverArtScale();
}
