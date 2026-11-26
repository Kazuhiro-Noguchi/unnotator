import { type JSX, onCleanup, onMount } from "solid-js";
import { useT } from "../solid";

/** 中央に重ねて出す枠。Esc で閉じ、閉じたら元のフォーカスに戻す。 */
export function Dialog(props: {
  title: string;
  onClose: () => void;
  children: JSX.Element;
  wide?: boolean;
}) {
  const t = useT();
  let previous: Element | null = null;
  onMount(() => {
    previous = document.activeElement;
  });
  onCleanup(() => {
    if (previous instanceof HTMLElement) previous.focus();
  });
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 背景のクリックと Esc で閉じる（ダイアログ本体が role=dialog）
    <div
      class="overlay"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          props.onClose();
        }
      }}
    >
      <div
        class="dialog"
        classList={{ wide: props.wide === true }}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
      >
        <div class="dialog-header">
          <span>{props.title}</span>
          <button type="button" class="button" onClick={props.onClose}>
            {t("dialog.close")}
          </button>
        </div>
        <div class="dialog-body">{props.children}</div>
      </div>
    </div>
  );
}
