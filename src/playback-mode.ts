/** The four ordinary modes shared by the local transport and NetEase's own mode action. */
export const PLAYBACK_MODES = ["playOrder", "playCycle", "playRandom", "playOneCycle"] as const;
export type PlaybackMode = typeof PLAYBACK_MODES[number];
export const playbackModeNames: Record<PlaybackMode, string> = {
  playOrder: "顺序播放", playCycle: "列表循环", playRandom: "随机播放", playOneCycle: "单曲循环",
};
export function playbackMode(value: unknown): PlaybackMode | undefined {
  return PLAYBACK_MODES.find((mode) => mode === value);
}
export function nextPlaybackMode(mode: PlaybackMode): PlaybackMode {
  return PLAYBACK_MODES[(PLAYBACK_MODES.indexOf(mode) + 1) % PLAYBACK_MODES.length];
}
export function playbackModeGlyph(mode?: PlaybackMode): string {
  const arrows = mode === "playOrder"
    ? '<path d="M3 7h17m-4-3 4 3-4 3M3 17h17m-4-3 4 3-4 3"/>'
    : mode === "playRandom"
      ? '<path d="M3 6h2c5 0 9 12 14 12h2m-3-3 3 3-3 3M3 18h2c2 0 4-3 5-5m4-4c2-2 3-3 5-3h2m-3-3 3 3-3 3"/>'
      : '<path d="M16 3l4 3-4 3M20 6H10a7 7 0 1 0 0 14h4a7 7 0 0 0 7-7"/>' +
        (mode === "playOneCycle" ? '<path d="m10 11 2-1v7"/>' : "");
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${arrows}</svg>`;
}
