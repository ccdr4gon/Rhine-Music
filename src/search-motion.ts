export interface ScreenBox { left: number; top: number; right: number; bottom: number }

/** A sliver at the edge is not a readable entrance. Keep the case low until it can be seen. */
export function searchCaseVisible(box: ScreenBox | undefined, reference: ScreenBox | undefined, width: number, height: number) {
  if (!box || !reference || !Object.values(box).every(Number.isFinite)) return false;
  const w = box.right - box.left, h = box.bottom - box.top;
  const referenceWidth = reference.right - reference.left, referenceHeight = reference.bottom - reference.top;
  const seenWidth = Math.max(0, Math.min(width, box.right) - Math.max(0, box.left));
  const seenHeight = Math.max(0, Math.min(height, box.bottom) - Math.max(0, box.top));
  return w > 0 && h > 0 && w >= referenceWidth * .35 && w <= referenceWidth * 1.8 &&
    seenWidth >= w * .55 && seenHeight >= Math.max(12, Math.min(48, referenceHeight * .12));
}

/** The existing lift spring follows screen travel speed, bounded so close jumps stay readable. */
export function searchCaseRate(previous: ScreenBox | undefined, next: ScreenBox | undefined, dt: number, span: number) {
  if (!previous || !next || !(dt > 0)) return 9;
  const x = (next.left + next.right - previous.left - previous.right) / 2;
  const y = (next.top + next.bottom - previous.top - previous.bottom) / 2;
  const w = (next.right - next.left - previous.right + previous.left) / 2;
  const h = (next.bottom - next.top - previous.bottom + previous.top) / 2;
  const speed = Math.hypot(x, y, w, h) / dt;
  return Number.isFinite(speed) ? Math.max(8, Math.min(12, 8 + 2 * speed / Math.max(100, span))) : 9;
}
