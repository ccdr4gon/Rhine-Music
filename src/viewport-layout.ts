/** The scene and DOM must cross the portrait boundary together. */
export const PORTRAIT_ASPECT = 1.05;
/** Below this width the stage uses its compact header and controls. */
const COMPACT_WIDTH = 1100;

export function isPortraitViewport(width: number, height: number) {
  return Math.max(1, width) / Math.max(1, height) < PORTRAIT_ASPECT;
}

/** Reference coordinates remain exact during the film and at 1920 × 1080. */
export function viewportLayout(width: number, height: number, coarse: boolean, cinematic = false) {
  width = Math.max(1, width);
  height = Math.max(1, height);
  if (cinematic) return {
    width: 1920, height: 1080, scale: Math.min(width / 1920, height / 1080),
    kind: "cinematic" as const,
  };
  const portrait = isPortraitViewport(width, height);
  const compact = portrait || width < COMPACT_WIDTH || (coarse && height < 600);
  const scale = compact ? 1 : height / 1080;
  return { width: width / scale, height: height / scale, scale,
    kind: portrait ? "portrait" as const : compact ? "compact" as const : "desktop" as const };
}

/** Preserve the long-lens perspective. Reframe only the camera, never the card. */
export function archiveFraming(width: number, height: number, span: number, detail: number, compact: boolean) {
  width = Math.max(1, width);
  height = Math.max(1, height);
  const aspect = width / height;
  const portrait = isPortraitViewport(width, height);
  const baseSpan = span + (5.9 - span) * detail;
  const portraitDetailSpan = Math.max(6.3 / aspect, 3.7 * height / Math.max(100, 0.54 * height - 156));
  const viewSpan = portrait
    ? Math.max(baseSpan, 8.4 / aspect + (portraitDetailSpan - 8.4 / aspect) * detail)
    : Math.max(baseSpan, baseSpan * (16 / 9) / aspect);
  return {
    span: viewSpan,
    portrait,
    // Portrait selection is deliberately above its title and navigation.
    previewY: portrait ? 0.36 : 0.5,
    detailX: portrait ? 0.5 : compact ? 0.27 : 550 / 1920,
    detailY: portrait ? 0.27 + 34 / height : compact ? 0.49 : 560 / 1080,
  };
}

/**
 * The least distance of the song scene's card centre from the left edge, in CSS pixels:
 * the brand and the return control keep their size, and are smaller in the compact layout.
 */
const SONG_CARD_MIN_X = { desktop: 400, compact: 300 } as const;

/**
 * The song scene: the lifted case is a card left of centre, anchored to the left edge in
 * units of the picture's height so wide windows keep it beside the chain; the playlist
 * panel takes the right. `span` is the world height the picture shows there.
 */
export function songFraming(width: number, height: number, span: number) {
  width = Math.max(1, width);
  height = Math.max(1, height);
  const aspect = width / height;
  if (isPortraitViewport(width, height))
    // The card sits above the panel, below the return control, and fills a little over half the width.
    return { portrait: true, span: Math.max(span, 4.45 / (0.56 * aspect)), x: 0.5, y: 0.27 + 34 / height };
  // Narrower landscape windows shrink the card instead of pushing it under the panel.
  const fit = Math.max(1, 1.6 / aspect);
  // Short windows keep the card and its line clear of the brand and the return control,
  // which do not shrink with the window.
  // Eased over the last 133 px below the compact width: a step there would move the card up
  // to 96 px at once and flip the panel's arrangement back and forth while a window is resized.
  const least = Math.min(SONG_CARD_MIN_X.desktop,
    Math.max(SONG_CARD_MIN_X.compact, SONG_CARD_MIN_X.desktop - (COMPACT_WIDTH - width) * 0.75));
  const left = Math.max(0.505 * height, least);
  return { portrait: false, span: span * fit, x: Math.min(left / width, 0.36), y: 0.508 };
}

/** The lifted case's rectangle in the song scene, in CSS pixels (centre and size). */
export function songCardRect(width: number, height: number, span: number, caseWidth: number, caseHeight: number) {
  const framing = songFraming(width, height, span);
  const scale = Math.max(1, height) / framing.span;
  return { x: framing.x * width, y: framing.y * height, width: caseWidth * scale, height: caseHeight * scale };
}

export function swipeDirection(dx: number, dy: number, elapsed: number) {
  const major = Math.max(Math.abs(dx), Math.abs(dy));
  const minor = Math.min(Math.abs(dx), Math.abs(dy));
  if (major < 36 || major < minor * 1.3 || elapsed > 1400) return null;
  return { axis: Math.abs(dx) > Math.abs(dy) ? "lane" as const : "row" as const,
    direction: (Math.abs(dx) > Math.abs(dy) ? dx : dy) < 0 ? 1 : -1 };
}
