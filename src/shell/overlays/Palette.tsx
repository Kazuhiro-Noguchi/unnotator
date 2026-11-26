import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { Icon } from "../Icon";
import { formatKey } from "../keys/chord";
import { searchCommands } from "../palette/fuzzy";
import { commands, keymap, platform } from "../services";
import { fromStore, useLanguage, useT } from "../solid";
import { Dialog } from "./Dialog";

/** コマンドパレット。キーボードだけで、開閉・選択・実行ができる。 */
export default function Palette(props: { onClose: () => void }) {
  const t = useT();
  const language = useLanguage();
  const [query, setQuery] = createSignal("");
  const [index, setIndex] = createSignal(0);
  let input: HTMLInputElement | undefined;
  onMount(() => input?.focus());

  const keyVersion = fromStore(
    () => 0,
    (listener) => keymap.subscribe(listener),
  );
  void keyVersion;
  const entries = createMemo(() =>
    searchCommands(commands, query(), language()),
  );

  function run(position: number): void {
    const entry = entries()[position];
    if (!entry?.enabled) return;
    props.onClose();
    void commands.execute(entry.id);
  }

  function onKeyDown(event: KeyboardEvent): void {
    const count = entries().length;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((i) => (count === 0 ? 0 : (i + 1) % count));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((i) => (count === 0 ? 0 : (i - 1 + count) % count));
    } else if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      run(index());
    }
  }

  return (
    <Dialog title={t("palette.title")} onClose={props.onClose}>
      <input
        ref={input}
        class="palette-input"
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-label={t("palette.placeholder")}
        placeholder={t("palette.placeholder")}
        value={query()}
        onInput={(event) => {
          setQuery(event.currentTarget.value);
          setIndex(0);
        }}
        onKeyDown={onKeyDown}
      />
      <div class="palette-list" id="palette-list" role="listbox">
        <For
          each={entries()}
          fallback={<div class="palette-empty">{t("palette.empty")}</div>}
        >
          {(entry, position) => {
            const binding = () => keymap.bindingsFor(entry.id)[0];
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: キーボードの操作は検索欄が受ける（矢印と Enter）
              <div
                role="option"
                tabIndex={-1}
                aria-selected={position() === index()}
                aria-disabled={!entry.enabled}
                class="palette-item"
                classList={{
                  selected: position() === index(),
                  disabled: !entry.enabled,
                }}
                onPointerMove={() => setIndex(position())}
                onClick={() => run(position())}
              >
                <Icon name={entry.icon} size={16} />
                <span class="palette-title">{entry.title}</span>
                <Show when={!entry.enabled}>
                  <span class="palette-note">
                    {entry.reason === "unprovided"
                      ? t("palette.unprovided")
                      : t("palette.unavailable")}
                  </span>
                </Show>
                <Show when={binding()}>
                  {(b) => (
                    <kbd class="palette-key">
                      {formatKey(b().chord, platform)}
                    </kbd>
                  )}
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    </Dialog>
  );
}
