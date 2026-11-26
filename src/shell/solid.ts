// 論理のストア・コンテキストを、Solid のシグナルにつなぐ薄い橋。
import { type Accessor, createSignal, onCleanup } from "solid-js";
import {
  currentLanguage,
  type Language,
  type MessageKey,
  onLanguageChange,
  t,
} from "../i18n";
import type { Context } from "./types";

/** コンテキストの値から計算した結果を、反応するアクセサにする。 */
export function fromContext<T>(ctx: Context, compute: () => T): Accessor<T> {
  const watch = ctx.watch(compute, (value) => setValue(() => value));
  const [value, setValue] = createSignal<T>(watch.value);
  onCleanup(() => watch.dispose());
  return value;
}

/** `get` / `subscribe` を持つストアを、反応するアクセサにする。 */
export function fromStore<T>(
  get: () => T,
  subscribe: (listener: () => void) => () => void,
): Accessor<T> {
  const [value, setValue] = createSignal<T>(get());
  const off = subscribe(() => setValue(() => get()));
  onCleanup(off);
  return value;
}

/** 現在の言語（切り替えで再描画される）。 */
export function useLanguage(): Accessor<Language> {
  const [language, setLanguage] = createSignal<Language>(currentLanguage());
  const off = onLanguageChange(setLanguage);
  onCleanup(off);
  return language;
}

/** 言語が変わると再評価される `t`。 */
export function useT(): (key: MessageKey) => string {
  const language = useLanguage();
  return (key) => t(key, language());
}
