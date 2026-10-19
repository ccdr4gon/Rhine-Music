/**
 * The keyboard shortcuts of the three scenes, and the keys a user gives them (设置 → 快捷键; the
 * owner, 2026-10-10: "a settings tab where users can customize the hotkeys", and 2026-10-11: "yes
 * keep every key changable").
 *
 * Every action has its main key (the defaults below) and may have one more, its 附加键 (none by
 * default); both can be changed or cleared. A key is a single key without Ctrl, Alt or Win (Shift is
 * ignored, as S, P and L always were), from ALLOWED: letters, digits, punctuation, the numpad, Space,
 * Enter, the arrows, Home, End, PageUp, PageDown, Insert, and Esc (which only a swap can move: while a
 * key is being set, Esc cancels and Backspace or Delete clear). Each key belongs to one action at most.
 */

export type ShortcutAction =
  | "pause" | "play" | "playing"
  | "songUp" | "songDown" | "listLeft" | "listRight"
  | "open" | "songs" | "back" | "search";

export interface ShortcutInfo {
  readonly id: ShortcutAction;
  readonly group: "播放" | "浏览" | "打开与返回";
  readonly name: string;
  readonly note?: string;
  /** The main key's default (KeyboardEvent.code). */
  readonly key: string;
  /** Whether holding the key repeats the action. */
  readonly repeat: boolean;
}

export const SHORTCUTS: readonly ShortcutInfo[] = [
  { id: "pause", group: "播放", name: "暂停 / 继续", key: "Space", repeat: false },
  { id: "play", group: "播放", name: "播放选中的歌", key: "KeyP", repeat: false },
  { id: "playing", group: "播放", name: "回到正在播放的歌", key: "KeyL", repeat: false },
  { id: "songUp", group: "浏览", name: "上一首", note: "只移动选中项，不播放", key: "ArrowUp", repeat: true },
  { id: "songDown", group: "浏览", name: "下一首", note: "只移动选中项，不播放", key: "ArrowDown", repeat: true },
  { id: "listLeft", group: "浏览", name: "上一个歌单", key: "ArrowLeft", repeat: true },
  { id: "listRight", group: "浏览", name: "下一个歌单", key: "ArrowRight", repeat: true },
  { id: "open", group: "打开与返回", name: "查看这首歌", note: "打开详情并播放这首歌", key: "Enter", repeat: false },
  { id: "songs", group: "打开与返回", name: "播放列表", note: "在专辑架和详情里打开播放列表；在播放列表里打开这首歌", key: "KeyS", repeat: false },
  { id: "back", group: "打开与返回", name: "返回专辑架", key: "Escape", repeat: false },
  { id: "search", group: "打开与返回", name: "搜索", note: "本地音乐：搜索歌曲；播放器：打开“播放器”面板", key: "Slash", repeat: false },
];

const BY_ID = new Map(SHORTCUTS.map((info) => [info.id, info]));
export const shortcutInfo = (id: ShortcutAction) => BY_ID.get(id)!;

/**
 * A key a user gives: one slot per action's main key (`songs`) and per 附加键 (`songs.extra`). The
 * stored overrides hold only what differs from the defaults: a code, or null for a cleared main key
 * (`{ "songs": "KeyJ", "songDown.extra": "KeyK", "search": null }`).
 */
export type ShortcutSlot = `${ShortcutAction}` | `${ShortcutAction}.extra`;
export type ShortcutOverrides = Record<string, string | null>;

export const SLOTS: readonly ShortcutSlot[] = SHORTCUTS.flatMap((info) => [info.id, `${info.id}.extra` as const]);
export const slotAction = (slot: ShortcutSlot) => slot.replace(/\.extra$/, "") as ShortcutAction;
export const isExtra = (slot: ShortcutSlot) => slot.endsWith(".extra");
const own = (object: object, slot: string) => Object.prototype.hasOwnProperty.call(object, slot);

/** The key in a slot now: its override, or its default (none for a 附加键). */
export function slotKey(overrides: ShortcutOverrides, slot: ShortcutSlot): string | null {
  if (own(overrides, slot)) return overrides[slot] ?? null;
  return isExtra(slot) ? null : shortcutInfo(slotAction(slot)).key;
}

/** The keys an action answers to, main first. */
export function actionKeys(overrides: ShortcutOverrides, id: ShortcutAction): string[] {
  return [slotKey(overrides, id), slotKey(overrides, `${id}.extra`)].filter((key): key is string => !!key);
}

const PUNCTUATION: Record<string, string> = {
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'",
  Comma: ",", Period: ".", Slash: "/", Backquote: "`", IntlBackslash: "\\", IntlRo: "\\", IntlYen: "¥",
};
const NUMPAD: Record<string, string> = {
  NumpadAdd: "+", NumpadSubtract: "-", NumpadMultiply: "*", NumpadDivide: "/", NumpadDecimal: ".", NumpadComma: ",", NumpadEqual: "=",
};
/** The keys that print nothing, by their names: shown as written here, read out in words. */
const SPECIAL: Record<string, string> = {
  Space: "SPACE", Enter: "ENTER", Escape: "ESC",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  Home: "HOME", End: "END", PageUp: "PGUP", PageDown: "PGDN", Insert: "INS",
};
const SPOKEN: Record<string, string> = {
  Space: "空格键", Enter: "回车键", Escape: "Esc 键",
  ArrowUp: "上方向键", ArrowDown: "下方向键", ArrowLeft: "左方向键", ArrowRight: "右方向键",
  Home: "Home 键", End: "End 键", PageUp: "Page Up 键", PageDown: "Page Down 键", Insert: "Insert 键",
};

/**
 * The keys an action can have: letters, digits, punctuation, the numpad's digits and operators, and
 * the named keys above (Space, Enter, Esc, the arrows, Home, End, PageUp, PageDown, Insert). Not Tab
 * (it moves the focus), Backspace or Delete (they clear a key while one is being set), function keys
 * (the WebView keeps some, untested), media keys (Rhine sends those to players itself) or modifiers.
 */
export function allowed(code: string) {
  return /^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code) || /^Numpad[0-9]$/.test(code) ||
    code in PUNCTUATION || code in NUMPAD || code in SPECIAL;
}

/** The slot that holds `code` now, if any. */
export function holder(overrides: ShortcutOverrides, code: string): ShortcutSlot | undefined {
  return SLOTS.find((slot) => slotKey(overrides, slot) === code);
}

/** Numpad keys that, with NumLock off, are the named keys (and are those keys here). */
const NUMPAD_NAMED = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Insert", "Delete"]);

/**
 * A key event's physical key, the way the bindings name it. The numpad's Enter is Enter, and its
 * keys with NumLock off are the arrows, Home, End… they then are (as the scenes always took them). An
 * event without a code (a key typed by a tool) is read from its key.
 */
export function eventCode(event: Pick<KeyboardEvent, "code" | "key">): string {
  const key = event.key ?? "";
  if (event.code === "NumpadEnter") return "Enter";
  if (event.code?.startsWith("Numpad") && NUMPAD_NAMED.has(key)) return key;
  if (event.code) return event.code;
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (key === "/") return "Slash";
  if (key === " ") return "Space";
  if (key in SPECIAL || key === "Backspace" || key === "Delete" || key === "Tab") return key;
  return "";
}

/** Whether a key event can be a shortcut at all: no Ctrl, Alt or Win held, not part of typing in an IME. */
export function shortcutEvent(event: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "metaKey" | "isComposing" | "keyCode">) {
  return !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing && event.keyCode !== 229;
}

/**
 * Which action each key runs. The numpad's / also opens 搜索 while 搜索 has the / key and no action
 * was given the numpad's own.
 */
export function shortcutTable(overrides: ShortcutOverrides): Map<string, ShortcutAction> {
  const table = new Map<string, ShortcutAction>();
  for (const slot of SLOTS) {
    const key = slotKey(overrides, slot);
    if (key && !table.has(key)) table.set(key, slotAction(slot));
  }
  if (slotKey(overrides, "search") === "Slash" && !table.has("NumpadDivide")) table.set("NumpadDivide", "search");
  return table;
}

/** Drops what equals a default (a 附加键's default is none). */
function tidy(overrides: ShortcutOverrides): ShortcutOverrides {
  const out: ShortcutOverrides = {};
  for (const [slot, value] of Object.entries(overrides)) {
    if (!SLOTS.includes(slot as ShortcutSlot)) {
      out[slot] = value;
      continue;
    }
    const s = slot as ShortcutSlot;
    const fallback = isExtra(s) ? null : shortcutInfo(slotAction(s)).key;
    if (value !== fallback) out[slot] = value;
  }
  return out;
}

export type AssignResult =
  | { ok: true; overrides: ShortcutOverrides; moved?: { slot: ShortcutSlot; key: string | null } }
  | { ok: false; reason: "not-allowed" };

/**
 * Gives `slot` the key `code`. A key another slot holds is swapped: that slot takes this slot's
 * previous key (none, for a 附加键 that had none). A key outside ALLOWED is refused.
 */
export function assign(overrides: ShortcutOverrides, slot: ShortcutSlot, code: string): AssignResult {
  if (!allowed(code)) return { ok: false, reason: "not-allowed" };
  const previous = slotKey(overrides, slot);
  const next: ShortcutOverrides = { ...overrides, [slot]: code };
  const other = SLOTS.find((s) => s !== slot && slotKey(overrides, s) === code);
  if (other) {
    next[other] = previous;
    return { ok: true, overrides: tidy(next), moved: { slot: other, key: previous } };
  }
  return { ok: true, overrides: tidy(next) };
}

/** Clears a slot: no key for that action there (the action keeps its other key, if any). */
export function clear(overrides: ShortcutOverrides, slot: ShortcutSlot): ShortcutOverrides {
  return tidy({ ...overrides, [slot]: null });
}

/**
 * Puts an action back to its default keys (its main key, no 附加键). A default another action holds
 * after a swap is swapped back the same way; a main key that would then have none takes its own
 * default back where that is free. Returns what moved, for the message.
 */
export function reset(overrides: ShortcutOverrides, id: ShortcutAction): { overrides: ShortcutOverrides; moved?: { slot: ShortcutSlot; key: string | null } } {
  let next = clear(overrides, `${id}.extra`);
  const info = shortcutInfo(id);
  if (slotKey(next, id) === info.key) return { overrides: next };
  const result = assign(next, id, info.key);
  if (!result.ok) return { overrides: next };
  next = result.overrides;
  let moved = result.moved;
  if (moved && moved.key === null && !isExtra(moved.slot)) {
    const ownDefault = shortcutInfo(slotAction(moved.slot)).key;
    if (!holder(next, ownDefault)) {
      next = tidy({ ...next, [moved.slot]: ownDefault });
      moved = { slot: moved.slot, key: ownDefault };
    }
  }
  return { overrides: next, moved };
}

/** Whether an action's keys differ from its defaults. */
export function changed(overrides: ShortcutOverrides, id: ShortcutAction) {
  return own(overrides, id) || own(overrides, `${id}.extra`);
}

/**
 * What a saved `shortcuts` preference becomes: a plain object; per slot, in the order of SLOTS (not
 * the object's, which data/preferences.json sorts), a code in ALLOWED or null for a cleared main key;
 * what equals a default is dropped; keys two slots would share revert to their defaults until none
 * do. Slots this version does not know are kept as they are. `reverted` says whether a saved key had
 * to go back to its default.
 */
export function sanitize(stored: unknown): { overrides: ShortcutOverrides; reverted: boolean } {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return { overrides: {}, reverted: false };
  const source = stored as Record<string, unknown>;
  let overrides: ShortcutOverrides = {};
  let reverted = false;
  for (const [slot, value] of Object.entries(source)) {
    if (!SLOTS.includes(slot as ShortcutSlot) && (typeof value === "string" || value === null) && slot.length <= 40) overrides[slot] = value;
  }
  for (const slot of SLOTS) {
    if (!own(source, slot)) continue;
    const value = source[slot];
    if (value === null && !isExtra(slot)) overrides[slot] = null;
    else if (typeof value === "string" && allowed(value)) overrides[slot] = value;
    else if (value !== null) reverted = true;
  }
  overrides = tidy(overrides);
  for (;;) {
    const seen = new Map<string, ShortcutSlot>();
    const clash = new Set<ShortcutSlot>();
    for (const slot of SLOTS) {
      const key = slotKey(overrides, slot);
      if (!key) continue;
      const first = seen.get(key);
      if (first) clash.add(first).add(slot);
      else seen.set(key, slot);
    }
    const changedSlots = [...clash].filter((slot) => own(overrides, slot));
    if (!changedSlots.length) break;
    for (const slot of changedSlots) delete overrides[slot];
    reverted = true;
  }
  return { overrides, reverted };
}

/** The keyboard layout's characters by code (navigator.keyboard.getLayoutMap), when the WebView has it. */
export type KeyLayout = ReadonlyMap<string, string>;

/** What a key is shown as: S, 1, /, NUM 1, ↑, SPACE...; letters and symbols as the keyboard layout prints them. */
export function keyLabel(code: string, layout?: KeyLayout): string {
  if (code in SPECIAL) return SPECIAL[code];
  if (code.startsWith("Numpad")) {
    const rest = code.slice(6);
    return `NUM ${/^[0-9]$/.test(rest) ? rest : NUMPAD[code] ?? rest}`;
  }
  const printed = layout?.get(code)?.trim();
  if (printed && [...printed].length === 1 && !/\p{M}/u.test(printed)) {
    const upper = printed.toUpperCase();
    return [...upper].length === 1 ? upper : printed;
  }
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return PUNCTUATION[code] ?? code;
}

/** What a screen reader is given for a key: the named keys in words. */
export function spokenKey(code: string, layout?: KeyLayout): string {
  return SPOKEN[code] ?? keyLabel(code, layout);
}

/** The layout's characters, where the WebView offers them (a secure page, top level); none otherwise. */
export async function keyboardLayout(): Promise<KeyLayout | undefined> {
  try {
    const keyboard = (navigator as Navigator & { keyboard?: { getLayoutMap?: () => Promise<KeyLayout> } }).keyboard;
    return await keyboard?.getLayoutMap?.();
  } catch {
    return undefined;
  }
}
