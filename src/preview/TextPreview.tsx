import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import { useT } from "../shell/solid";
import type { LineIndex } from "./text";

/** 1 行の高さ（CSS の px）。 */
const LINE_HEIGHT = 20;
const OVERSCAN = 20;
const FALLBACK_VISIBLE = 40;

/** スクロールできる読み取り専用の領域。キーボードで動かせるよう、フォーカスを受ける。 */
function ScrollArea(props: {
  label: string;
  onBox: (element: HTMLDivElement) => void;
  onScroll: (top: number) => void;
  children: JSX.Element;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: 仮想表示の領域は、<textarea> では作れない
    <div
      class="preview-text"
      role="textbox"
      aria-readonly="true"
      aria-multiline="true"
      aria-label={props.label}
      tabIndex={0}
      ref={props.onBox}
      onScroll={(event) => props.onScroll(event.currentTarget.scrollTop)}
    >
      {props.children}
    </div>
  );
}

/** テキストを、見える行だけ描く。内容は文字として描く（タグ・スクリプトは解釈しない）。 */
export function TextPreview(props: { lines: LineIndex; truncated: boolean }) {
  const t = useT();
  const [scrollTop, setScrollTop] = createSignal(0);
  const [height, setHeight] = createSignal(0);
  let box: HTMLDivElement | undefined;
  onMount(() => {
    if (box) setHeight(box.clientHeight);
  });
  const range = () => {
    const visible = Math.ceil(
      (height() || LINE_HEIGHT * FALLBACK_VISIBLE) / LINE_HEIGHT,
    );
    const first = Math.floor(scrollTop() / LINE_HEIGHT);
    return {
      start: Math.max(0, first - OVERSCAN),
      end: Math.min(props.lines.count, first + visible + OVERSCAN),
    };
  };
  const indexes = () => {
    const { start, end } = range();
    return Array.from(
      { length: Math.max(0, end - start) },
      (_, i) => start + i,
    );
  };
  return (
    <div class="preview-text-wrap">
      <Show when={props.truncated}>
        <p class="preview-note" role="status">
          {t("preview.truncated")}
        </p>
      </Show>
      <ScrollArea
        label={t("preview.text.label")}
        onBox={(element) => {
          box = element;
        }}
        onScroll={setScrollTop}
      >
        <div
          class="preview-text-body"
          style={{ height: `${props.lines.count * LINE_HEIGHT}px` }}
        >
          <For each={indexes()}>
            {(index) => (
              <div
                class="preview-line"
                style={{
                  top: `${index * LINE_HEIGHT}px`,
                  height: `${LINE_HEIGHT}px`,
                }}
              >
                {props.lines.line(index)}
              </div>
            )}
          </For>
        </div>
      </ScrollArea>
    </div>
  );
}
