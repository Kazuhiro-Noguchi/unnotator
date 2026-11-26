import {
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";

export interface MenuItem {
  label: string;
  icon?: JSX.Element;
  disabled?: boolean;
  checked?: boolean;
  onSelect: () => void;
}

/** ボタンの下に開く簡易のメニュー。外のクリックと Esc で閉じる。 */
export function Menu(props: {
  items: MenuItem[];
  label: string;
  onClose: () => void;
  /** 指定すると、この要素の下に、画面全体の上に重ねて出す（リボンの横スクロールで切れない）。 */
  anchor?: HTMLElement | undefined;
}) {
  let root: HTMLDivElement | undefined;
  const [focused, setFocused] = createSignal(0);
  const [place, setPlace] = createSignal<{ left: number; top: number } | null>(
    null,
  );

  onMount(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (root && !root.contains(event.target as Node)) props.onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    onCleanup(() =>
      document.removeEventListener("pointerdown", onPointerDown, true),
    );
    if (props.anchor && root) {
      // アンカーの下に置く。画面の右端・下端からはみ出すときは、内側へ寄せる。
      const box = props.anchor.getBoundingClientRect();
      const width = root.offsetWidth;
      const height = root.offsetHeight;
      setPlace({
        left: Math.max(4, Math.min(box.left, window.innerWidth - width - 4)),
        // 下に収まらないときは、アンカーの上に出す（左下の歯車など）。
        top:
          box.bottom + height + 4 <= window.innerHeight
            ? box.bottom
            : Math.max(4, box.top - height),
      });
    }
    root?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  });

  function onKeyDown(event: KeyboardEvent): void {
    const buttons = [
      ...(root?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? []),
    ];
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = buttons[(index + step + buttons.length) % buttons.length];
      next?.focus();
      setFocused(buttons.indexOf(next as HTMLElement));
    }
  }

  const body = (
    // biome-ignore lint/a11y/noStaticElementInteractions: メニューの矢印キーと Esc を受ける（項目は button）
    <div
      ref={root}
      class="menu"
      classList={{ floating: props.anchor !== undefined }}
      style={
        place()
          ? { left: `${place()?.left}px`, top: `${place()?.top}px` }
          : undefined
      }
      role="menu"
      aria-label={props.label}
      onKeyDown={onKeyDown}
    >
      <For each={props.items}>
        {(item) => (
          <button
            type="button"
            role="menuitem"
            data-checked={item.checked === true}
            class="menu-item"
            disabled={item.disabled === true}
            data-focused={focused()}
            onClick={() => {
              props.onClose();
              item.onSelect();
            }}
          >
            <span class="menu-check" aria-hidden="true">
              <Show when={item.checked}>✓</Show>
            </span>
            {item.icon}
            <span>{item.label}</span>
          </button>
        )}
      </For>
    </div>
  );
  return (
    <Show when={props.anchor} fallback={body}>
      <Portal>{body}</Portal>
    </Show>
  );
}
