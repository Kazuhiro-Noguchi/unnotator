import { type JSX, onCleanup, onMount } from "solid-js";
import { Icon } from "../Icon";
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
  let panel: HTMLDivElement | undefined;
  onMount(() => {
    previous = document.activeElement;
    // ダイアログの中にフォーカスが無ければ、ダイアログに移す（入力欄が先に取っていれば、そのまま）。
    if (panel && !panel.contains(document.activeElement)) panel.focus();
    // フォーカスがどこにあっても、Esc で閉じる（ボタンから開いた直後は、フォーカスが外にある）。
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
    };
    document.addEventListener("keydown", onEscape, true);
    onCleanup(() => document.removeEventListener("keydown", onEscape, true));
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
        ref={panel}
        tabIndex={-1}
        class="dialog"
        classList={{ wide: props.wide === true }}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
      >
        <div class="dialog-header">
          <span>{props.title}</span>
          <button
            type="button"
            class="button icon-button"
            aria-label={t("dialog.close")}
            title={t("dialog.close")}
            onClick={props.onClose}
          >
            <Icon name="$(close)" size={14} />
          </button>
        </div>
        <div class="dialog-body">{props.children}</div>
      </div>
    </div>
  );
}
