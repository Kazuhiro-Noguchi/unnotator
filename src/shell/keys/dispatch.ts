// keydown の入口（research.md R6）。ウィンドウに 1 つだけ付け、規則をここに集める。

import type { CommandRegistry } from "../commands/registry";
import type { Chord, Disposable } from "../types";
import { chordFromEvent } from "./chord";
import type { Keymap } from "./keymap";

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  target: unknown;
  preventDefault(): void;
}

export interface DispatchDeps {
  keymap: Keymap;
  commands: CommandRegistry;
  isEditable: (target: unknown) => boolean;
}

/** 入力欄の中では、ブラウザの標準の編集に任せるキー。 */
const NATIVE_EDIT_KEYS = new Set(["z", "y", "x", "c", "v", "a"]);

function isNativeEdit(chord: Chord): boolean {
  return (
    (chord.ctrl || chord.meta) && !chord.alt && NATIVE_EDIT_KEYS.has(chord.key)
  );
}

/** 入力欄にフォーカスがあるとき、アノテーションのキーとして処理してよいか。 */
function handledInEditable(chord: Chord): boolean {
  if (chord.key === "escape") return true;
  const modified = chord.ctrl || chord.meta || chord.alt;
  return modified && !isNativeEdit(chord);
}

export function handleKeyEvent(event: KeyEventLike, deps: DispatchDeps): void {
  if (event.isComposing === true || event.keyCode === 229) return;
  const chord = chordFromEvent(event);
  if (deps.isEditable(event.target) && !handledInEditable(chord)) return;
  const bound = deps.keymap.resolve(chord);
  if (!bound) return;
  // 実行できないコマンドのキーは横取りしない（ブラウザの標準の動作を残す）。
  if (!deps.commands.availability(bound.command)().enabled) return;
  event.preventDefault();
  void deps.commands.execute(bound.command, bound.args);
}

export interface KeyEventTarget {
  addEventListener(
    type: "keydown",
    listener: (event: never) => void,
    capture: boolean,
  ): void;
  removeEventListener(
    type: "keydown",
    listener: (event: never) => void,
    capture: boolean,
  ): void;
}

export function installKeyDispatcher(
  target: {
    addEventListener: (type: string, listener: never, capture: boolean) => void;
    removeEventListener: (
      type: string,
      listener: never,
      capture: boolean,
    ) => void;
  },
  deps: DispatchDeps,
): Disposable {
  const listener = ((event: KeyEventLike) =>
    handleKeyEvent(event, deps)) as never;
  target.addEventListener("keydown", listener, true);
  return {
    dispose() {
      target.removeEventListener("keydown", listener, true);
    },
  };
}
