import { nearestOccurrence, wrap, type ArchiveNavigation } from "./archive-loop";

type MusicRulerItem = { index: number; title: string; id?: string };
type Spring = { value: number; velocity: number };
type RulerSlot = {
  button: HTMLButtonElement;
  mark: HTMLSpanElement;
  ordinal: number;
  x: number;
  offset: Spring;
  presence: Spring;
  height: Spring;
  opacity: Spring;
  revealAt: number;
  rippleAt: number;
  pointer: boolean;
  focused: boolean;
  side: string;
  playing: boolean;
};

/**
 * The design's ruler (2026-10-05): 13 ticks, the selected song always the tall centre tick, every
 * fifth song a longer tick. A column of 13 or fewer shows its ticks only (none outside 1..N); a
 * longer one keeps the continuous wrap, so a step from the last song to the first keeps its
 * physical direction.
 */
const CAPACITY = 13;
const OVERSCAN = 2;
const POOL_SIZE = CAPACITY + OVERSCAN * 2;
const ANCHOR = 6;
const RIPPLE_DURATION = 560;
const REST_OPACITY = 0.7;

function spring(value: number): Spring {
  return { value, velocity: 0 };
}

/** Exact critically damped integration keeps reversals continuous. */
function approach(state: Spring, target: number, seconds: number, instant: boolean) {
  if (instant || (Math.abs(state.value - target) < 0.001 && Math.abs(state.velocity) < 0.01)) {
    state.value = target;
    state.velocity = 0;
    return false;
  }
  const frequency = 18;
  const delta = state.value - target;
  const decay = Math.exp(-frequency * seconds);
  const advance = (state.velocity + frequency * delta) * seconds;
  state.value = target + (delta + advance) * decay;
  state.velocity = (state.velocity - frequency * advance) * decay;
  return true;
}

/**
 * A bounded, reusable ruler; the selected tick itself grows, with no overlay. `noun` names what a
 * tick selects (专辑, or 歌曲 in the player skin).
 */
export function setupMusicRuler(host: HTMLElement, noun = "专辑") {
  const events = new AbortController();
  const reducedQuery = matchMedia("(prefers-reduced-motion: reduce)");
  let items: MusicRulerItem[] = [];
  let groupKey = "";
  let selectedIndex = -1;
  let selectedOrdinal = 0;
  let playingIndex: number | undefined;
  let populated = false;
  let reduced = false;
  let disposed = false;
  let frame = 0;
  let lastFrame = 0;
  let tickWidth = 3;
  let step = 8;
  let fullHeight = 28;
  let longHeight = 14;
  let shortHeight = 9;
  let hoverHeight = 18;
  let hostWidth = (CAPACITY - 1) * step + tickWidth;
  // A pitch of room on either side (CSS pulls it back with negative margins), where ticks that
  // scroll in or out fade under the mask; the 13 ticks themselves are never faded.
  let pad = step;
  const scroll = spring(0);
  let scrollTarget = 0;

  host.classList.add("music-ruler");
  host.setAttribute("role", "group");
  host.setAttribute("aria-label", `选择${noun}`);

  const slots: RulerSlot[] = Array.from({ length: POOL_SIZE }, (_, ordinal) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "music-ruler-slot";
    button.disabled = true;
    button.tabIndex = -1;
    button.dataset.visible = "false";
    button.setAttribute("aria-hidden", "true");
    const mark = document.createElement("span");
    mark.className = "music-ruler-mark";
    mark.setAttribute("aria-hidden", "true");
    // The playing song's tick carries a dot in the playback colour (not the selected tick).
    const dot = document.createElement("i");
    dot.className = "music-ruler-dot";
    dot.setAttribute("aria-hidden", "true");
    button.append(mark, dot);
    const slot: RulerSlot = {
      button, mark, ordinal, x: ordinal * step,
      offset: spring(0), presence: spring(0), height: spring(shortHeight),
      opacity: spring(REST_OPACITY), revealAt: 0, rippleAt: -Infinity,
      pointer: false, focused: false, side: "", playing: false,
    };
    for (const [name, field, value] of [
      ["pointerenter", "pointer", true], ["pointerleave", "pointer", false],
      ["focus", "focused", true], ["blur", "focused", false],
    ] as const) {
      button.addEventListener(name, () => {
        slot[field] = value;
        schedule();
      }, { signal: events.signal });
    }
    return slot;
  });
  host.replaceChildren(...slots.map((slot) => slot.button));

  const overflowing = () => items.length > CAPACITY;
  const instantMotion = () => reduced || reducedQuery.matches;
  const validOrdinal = (ordinal: number) => items.length > 0 &&
    (overflowing() || (ordinal >= 0 && ordinal < items.length));
  const itemAt = (ordinal: number) => validOrdinal(ordinal) ? items[wrap(ordinal, items.length)] : undefined;
  // Every fifth song of the column has a longer tick.
  const restHeight = (ordinal: number) => (wrap(ordinal, Math.max(1, items.length)) + 1) % 5 === 0 ? longHeight : shortHeight;

  function measure() {
    const css = getComputedStyle(host);
    const read = (name: string, fallback: number) => Number.parseFloat(css.getPropertyValue(name)) || fallback;
    const oldStep = step;
    tickWidth = read("--tick-width", 3);
    step = read("--tick-pitch", 8);
    fullHeight = read("--tick-full", 28);
    longHeight = read("--tick-long", 14);
    shortHeight = read("--tick-short", 9);
    hoverHeight = read("--tick-hover", 18);
    hostWidth = (CAPACITY - 1) * step + tickWidth;
    pad = step;
    host.style.width = `${hostWidth + 2 * pad}px`;
    if (step !== oldStep) {
      const ratio = step / oldStep;
      slots.forEach((slot) => {
        slot.x *= ratio;
        slot.offset.value *= ratio;
        slot.offset.velocity *= ratio;
      });
    }
  }

  function labelSlot(slot: RulerSlot) {
    const item = itemAt(slot.ordinal);
    const active = Boolean(item) && slot.ordinal === selectedOrdinal;
    slot.button.classList.toggle("active", active);
    slot.button.setAttribute("aria-current", String(active));
    slot.button.setAttribute("aria-pressed", String(active));
    if (item) {
      slot.button.dataset.select = String(item.index);
      // Preserve the particular visible occurrence when a loop edge is clicked.
      slot.button.dataset.rulerStep = String(slot.ordinal - selectedOrdinal);
      slot.button.setAttribute("aria-label", `选择${noun} ${item.title}`);
      slot.button.title = item.title;
    } else {
      delete slot.button.dataset.select;
      delete slot.button.dataset.rulerStep;
      slot.button.removeAttribute("aria-label");
      slot.button.removeAttribute("title");
    }
  }

  // Only offscreen slots are recycled. Crossing an album/category boundary
  // never replaces the visible window or resets its fractional scroll position.
  function recycle() {
    const start = Math.floor(scroll.value) - OVERSCAN;
    const end = start + POOL_SIZE;
    const free = slots.filter((slot) => {
      if (slot.ordinal >= start && slot.ordinal < end) return false;
      const x = (slot.ordinal - scroll.value) * step + slot.offset.value;
      // A category transition may still carry a displayed position offset.
      // Retain that physical tick until it has really left the viewport.
      return slot.presence.value <= 0.025 || x + tickWidth <= 0.5 || x >= hostWidth - 0.5;
    });
    const present = new Set(slots.filter((slot) => slot.ordinal >= start && slot.ordinal < end).map((slot) => slot.ordinal));
    for (let ordinal = start; ordinal < end; ordinal++) {
      if (present.has(ordinal)) continue;
      const slot = free.shift();
      if (!slot) break;
      const valid = validOrdinal(ordinal);
      slot.ordinal = ordinal;
      slot.offset.value = slot.offset.velocity = 0;
      // Outside a short column there is no tick: the slot arrives already hidden.
      slot.presence.value = valid ? 1 : 0;
      slot.presence.velocity = 0;
      slot.height.value = ordinal === selectedOrdinal ? fullHeight : restHeight(ordinal);
      slot.height.velocity = 0;
      slot.opacity.value = ordinal === selectedOrdinal ? 1 : REST_OPACITY;
      slot.opacity.velocity = 0;
      slot.revealAt = 0;
      slot.rippleAt = -Infinity;
      slot.pointer = false;
      labelSlot(slot);
    }
  }

  function markPlaying(slot: RulerSlot) {
    const playing = playingIndex !== undefined && slot.ordinal !== selectedOrdinal &&
      itemAt(slot.ordinal)?.index === playingIndex;
    if (playing === slot.playing) return;
    slot.playing = playing;
    slot.button.dataset.playing = String(playing);
  }

  function render(now: number, seconds: number, forceInstant = false) {
    const instant = forceInstant || instantMotion();
    let moving = approach(scroll, scrollTarget, seconds, instant);
    recycle();
    host.dataset.overflow = String(overflowing());
    host.dataset.reduced = String(instantMotion());
    const focused = document.activeElement;
    let lostFocus = false;
    for (const slot of slots) {
      const valid = validOrdinal(slot.ordinal);
      const active = valid && slot.ordinal === selectedOrdinal;
      if (instant) {
        slot.revealAt = now;
        slot.rippleAt = -Infinity;
      }
      const revealed = now >= slot.revealAt;
      const presenceTarget = valid ? Number(revealed) : Number(!revealed);
      moving = approach(slot.presence, presenceTarget, seconds, instant) || moving;
      moving = approach(slot.offset, 0, seconds, instant) || moving;
      slot.x = (slot.ordinal - scroll.value) * step + slot.offset.value;
      // Hidden overscan and departing ticks are never focusable or clickable.
      const visible = valid && (instant || revealed) && slot.presence.value > 0.025 &&
        slot.x + tickWidth > 0.5 && slot.x < hostWidth - 0.5;
      slot.button.disabled = !visible;
      slot.button.tabIndex = visible ? 0 : -1;
      slot.button.dataset.visible = String(visible);
      slot.button.setAttribute("aria-hidden", String(!visible));
      if (!visible && slot.button === focused) lostFocus = true;
      // A tick before the selected one sits a pixel left in its slot, one after it a pixel
      // right: the gaps on either side of the wider selected tick stay even.
      const side = active ? "" : slot.ordinal < selectedOrdinal ? "before" : "after";
      if (side !== slot.side) {
        slot.side = side;
        slot.button.dataset.side = side;
      }
      markPlaying(slot);
      const hovering = visible && (slot.pointer || slot.focused);
      const rippleProgress = (now - slot.rippleAt) / RIPPLE_DURATION;
      const rippling = !instant && valid && rippleProgress >= 0 && rippleProgress < 1;
      // Unselected category ripples only contract the resting tick.
      const contraction = rippling ? 0.4 * Math.sin(Math.PI * rippleProgress) : 0;
      const rest = restHeight(slot.ordinal);
      const heightTarget = active ? fullHeight : hovering ? Math.max(hoverHeight, rest) : rest * (1 - contraction);
      const opacityTarget = active || hovering ? 1 : REST_OPACITY - contraction * 0.2;
      moving = approach(slot.height, heightTarget, seconds, instant) || moving;
      moving = approach(slot.opacity, opacityTarget, seconds, instant) || moving;
      moving = moving || (!instant && (!revealed || (valid && now < slot.rippleAt + RIPPLE_DURATION)));
      slot.button.style.transform = `translate3d(${(slot.x + pad).toFixed(3)}px, 0, 0)`;
      slot.button.style.opacity = String(Math.max(0, Math.min(1, slot.presence.value)));
      slot.button.style.setProperty("--ruler-height", `${Math.max(0, slot.height.value).toFixed(3)}px`);
      slot.mark.style.setProperty("--ruler-opacity", String(Math.max(0, Math.min(1, slot.opacity.value))));
    }
    if (lostFocus) {
      const active = slots.find((slot) => slot.ordinal === selectedOrdinal && !slot.button.disabled);
      (active || slots.find((slot) => !slot.button.disabled))?.button.focus({ preventScroll: true });
    }
    return moving;
  }

  function animate(now: number) {
    frame = 0;
    if (disposed) return;
    const seconds = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
    lastFrame = now;
    if (render(now, seconds) && !frame) frame = requestAnimationFrame(animate);
  }

  function schedule() {
    if (disposed || frame) return;
    lastFrame = performance.now();
    frame = requestAnimationFrame(animate);
  }

  function regroup(now: number, instant: boolean) {
    // The selected song is always the centre tick.
    scrollTarget = selectedOrdinal - ANCHOR;
    scroll.value = scrollTarget;
    scroll.velocity = 0;
    const start = Math.floor(scroll.value) - OVERSCAN;
    const ordinals = Array.from({ length: POOL_SIZE }, (_, i) => start + i);
    // Assign visible destinations first, matching their currently displayed x.
    // This preserves existing bars while extra bars unfold or collapse.
    ordinals.sort((a, b) => {
      const aVisible = validOrdinal(a) && a - scroll.value >= 0 && a - scroll.value < CAPACITY;
      const bVisible = validOrdinal(b) && b - scroll.value >= 0 && b - scroll.value < CAPACITY;
      return Number(bVisible) - Number(aVisible) || a - b;
    });
    const available = new Set(slots);
    for (const ordinal of ordinals) {
      const x = (ordinal - scroll.value) * step;
      const slot = [...available].sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x))[0];
      available.delete(slot);
      const valid = validOrdinal(ordinal);
      const wasVisible = slot.presence.value > 0.025 && slot.x + tickWidth > 0.5 && slot.x < hostWidth - 0.5;
      slot.ordinal = ordinal;
      slot.offset.value = instant || !wasVisible ? 0 : slot.x - x;
      if (instant || !wasVisible) slot.offset.velocity = 0;
      if (!wasVisible) {
        // An invisible pool node has no displayed position to preserve. Place
        // it directly at its new destination before fading it into the ruler.
        slot.presence.value = slot.presence.velocity = 0;
        slot.height.value = restHeight(ordinal);
        slot.height.velocity = 0;
        slot.opacity.value = REST_OPACITY;
        slot.opacity.velocity = 0;
      }
      const order = Math.max(0, Math.min(CAPACITY - 1, ordinal - scroll.value));
      const delay = instant ? 0 : order * 24;
      const changesPresence = valid ? slot.presence.value < 0.025 : slot.presence.value > 0.025;
      slot.revealAt = changesPresence ? now + delay : now;
      slot.rippleAt = instant ? -Infinity : now + delay;
      slot.pointer = false;
      labelSlot(slot);
    }
  }

  const onResize = () => { measure(); schedule(); };
  const onReduced = () => {
    render(performance.now(), 0, instantMotion());
    schedule();
  };
  // The host keeps the width of 13 ticks. CSS breakpoint sizes only need window resize.
  window.addEventListener("resize", onResize, { signal: events.signal });
  reducedQuery.addEventListener("change", onReduced);
  measure();

  return {
    update(nextItems: MusicRulerItem[], selected: number, reduceMotion: boolean, navigation?: ArchiveNavigation) {
      if (disposed) return;
      reduced = reduceMotion;
      const now = performance.now();
      const nextKey = JSON.stringify(nextItems.map((item) => [item.id ?? item.index, item.index]));
      const changedGroup = nextKey !== groupKey;
      const changedSelection = selected !== selectedIndex;
      const first = !populated;
      const row = Math.max(0, nextItems.findIndex((item) => item.index === selected));
      const rowDirection = navigation && "axis" in navigation && navigation.axis === "row"
        ? navigation.direction : 0;
      items = nextItems;
      groupKey = nextKey;
      selectedIndex = selected;
      if (changedGroup || first) {
        selectedOrdinal = row;
        regroup(now, first || instantMotion());
      } else if (changedSelection || rowDirection) {
        if (overflowing()) {
          if (rowDirection) {
            const candidate = selectedOrdinal + rowDirection;
            if (wrap(candidate, items.length) === row) selectedOrdinal = candidate;
            else {
              const delta = rowDirection > 0
                ? wrap(row - selectedOrdinal, items.length)
                : -wrap(selectedOrdinal - row, items.length);
              selectedOrdinal += delta;
            }
          } else selectedOrdinal = nearestOccurrence(row, scroll.value + ANCHOR, items.length);
        } else selectedOrdinal = row;
        scrollTarget = selectedOrdinal - ANCHOR;
      }
      // Metadata refreshes and repeated selection updates do not restart motion.
      slots.forEach(labelSlot);
      populated = populated || items.length > 0;
      render(now, 0, first || instantMotion());
      schedule();
    },
    /** The record index of the song (or album) that plays, for the dot over its tick. */
    setPlaying(index: number | undefined) {
      if (disposed || index === playingIndex) return;
      playingIndex = index;
      slots.forEach(markPlaying);
    },
    /**
     * Play / pause: a ring in the playback colour spreads from the ruler's centre (not with
     * reduced motion). Its colour is the one at the press; it never anticipates the player.
     */
    ripple() {
      const box = host.parentElement;
      if (disposed || instantMotion() || !box) return;
      const ring = document.createElement("i");
      ring.className = "music-ruler-ripple";
      ring.setAttribute("aria-hidden", "true");
      ring.style.borderColor = getComputedStyle(host).getPropertyValue("--state").trim() || "currentColor";
      box.append(ring);
      const animation = ring.animate([
        { transform: "translate(-50%, -50%) scale(0.2)", opacity: 0.9 },
        { transform: "translate(-50%, -50%) scale(1)", opacity: 0 },
      ], { duration: RIPPLE_DURATION, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" });
      animation.onfinish = animation.oncancel = () => ring.remove();
    },
    destroy() {
      disposed = true;
      cancelAnimationFrame(frame);
      events.abort();
      reducedQuery.removeEventListener("change", onReduced);
    },
  };
}
