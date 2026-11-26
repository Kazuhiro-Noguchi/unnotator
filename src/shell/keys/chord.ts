// キーの組み合わせ（chord）の解釈・正規化・表示（specs/006-shell-layout/research.md R5）。
import type { Chord } from "../types";

export type Platform = "mac" | "other";

export interface ParseOptions {
  /** macOS でも、Ctrl を Cmd に読み替えない（利用者が明示した Ctrl）。 */
  literalCtrl?: boolean;
}

export interface KeyEventInit {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

const MODIFIER_ALIASES: Record<string, "ctrl" | "shift" | "alt" | "meta"> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
  opt: "alt",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  win: "meta",
  super: "meta",
};

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  return: "enter",
  del: "delete",
  ins: "insert",
  pgup: "pageup",
  pgdn: "pagedown",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  " ": "space",
  spacebar: "space",
  plus: "+",
};

const NAMED_KEYS = new Set([
  "enter",
  "tab",
  "escape",
  "space",
  "backspace",
  "delete",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
]);

function normalizeKeyName(raw: string): string {
  const lower = raw.toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

/** 文字そのものが Shift を含む記号（? や ! など）。 */
function isShiftedSymbol(key: string): boolean {
  return key.length === 1 && !/[\p{L}\p{N}]/u.test(key);
}

export function parseKey(
  text: string,
  platform: Platform,
  options: ParseOptions = {},
): Chord | null {
  const source = text.trim();
  if (source === "") return null;

  let rest = source;
  let keyToken: string | null = null;
  if (source === "+") {
    keyToken = "+";
    rest = "";
  } else if (source.endsWith("++")) {
    keyToken = "+";
    rest = source.slice(0, -2);
    if (rest.trim() === "") return null;
  }

  const tokens =
    rest === "" ? [] : rest.split("+").map((token) => token.trim());
  if (tokens.some((token) => token === "")) return null;

  const chord: Chord = {
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
    key: "",
  };
  const keys: string[] = keyToken === null ? [] : [keyToken];
  for (const token of tokens) {
    const modifier = MODIFIER_ALIASES[token.toLowerCase()];
    if (modifier) {
      if (modifier === "ctrl" && platform === "mac" && !options.literalCtrl) {
        chord.meta = true;
      } else {
        chord[modifier] = true;
      }
    } else {
      keys.push(token);
    }
  }
  if (keys.length !== 1) return null;
  const key = normalizeKeyName(keys[0] ?? "");
  if (key.length !== 1 && !NAMED_KEYS.has(key)) return null;
  chord.key = key;
  if (isShiftedSymbol(key)) chord.shift = false;
  return chord;
}

export function chordFromEvent(event: KeyEventInit): Chord {
  const key = normalizeKeyName(event.key);
  return {
    ctrl: event.ctrlKey,
    shift: isShiftedSymbol(key) ? false : event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
    key,
  };
}

/** 比較・索引用の正規形。 */
export function chordId(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push("ctrl");
  if (chord.alt) parts.push("alt");
  if (chord.shift) parts.push("shift");
  if (chord.meta) parts.push("meta");
  parts.push(chord.key);
  return parts.join("+");
}

const DISPLAY_NAMES: Record<string, string> = {
  escape: "Esc",
  pageup: "PgUp",
  pagedown: "PgDn",
  delete: "Del",
  insert: "Ins",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  enter: "Enter",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  home: "Home",
  end: "End",
};

function displayKey(key: string): string {
  return (
    DISPLAY_NAMES[key] ??
    (key.length === 1 ? key.toUpperCase() : key.toUpperCase())
  );
}

/** 表示用。macOS は記号（⌃⌥⇧⌘）、それ以外は Ctrl+Shift+P の形。 */
export function formatKey(chord: Chord, platform: Platform): string {
  if (platform === "mac") {
    return `${chord.ctrl ? "⌃" : ""}${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${chord.meta ? "⌘" : ""}${displayKey(chord.key)}`;
  }
  const parts: string[] = [];
  if (chord.ctrl) parts.push("Ctrl");
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  if (chord.meta) parts.push("Meta");
  parts.push(displayKey(chord.key));
  return parts.join("+");
}

/** 実行環境が macOS か。 */
export function detectPlatform(): Platform {
  const nav = typeof navigator === "undefined" ? null : navigator;
  const id = `${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`;
  return /Mac|iPhone|iPad/i.test(id) ? "mac" : "other";
}
