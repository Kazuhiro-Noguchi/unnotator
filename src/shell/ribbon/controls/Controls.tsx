import { createSignal, For, Show } from "solid-js";
import { type MessageKey, t } from "../../../i18n";
import ja from "../../../i18n/ja.json";
import { Icon } from "../../Icon";
import { commands, ctx, quickAccess, ribbon } from "../../services";
import { fromContext, fromStore, useLanguage, useT } from "../../solid";
import { resolveTitle } from "../../title";
import type { Form, RibbonControl } from "../../types";
import { Menu, type MenuItem } from "../Menu";
import { commitNumber, galleryInvocation, primaryInvocation } from "./logic";

/** リボンの小ボタンのアイコンの大きさ（px）。 */
const SMALL_ICON = 14;

function commandTitle(control: RibbonControl, language: "ja" | "en"): string {
  const spec = control.command ? commands.get(control.command) : undefined;
  if (!spec) return control.command ?? "";
  // 引数つきの項目（テーマ・言語の選択など）は、引数も表示名に含める。
  const base = resolveTitle(spec.title, language);
  if (typeof control.args !== "string") return base;
  const choice = `choice.${control.args}`;
  return choice in ja
    ? t(choice as MessageKey, language)
    : `${base}: ${control.args}`;
}

function iconOf(control: RibbonControl): string | undefined {
  return control.command ? commands.get(control.command)?.icon : undefined;
}

/** 項目の一覧を、メニュー項目にする。`withIcons` なら、コマンドのアイコンを付ける。 */
export function menuItemsOf(
  items: RibbonControl[],
  language: "ja" | "en",
  withIcons = false,
): MenuItem[] {
  return items
    .filter((item) => item.kind !== "separator")
    .map((item) => ({
      label: commandTitle(item, language),
      ...(withIcons ? { icon: <Icon name={iconOf(item)} size={14} /> } : {}),
      disabled: !ribbon.controlState(item).enabled,
      checked: ribbon.controlState(item).checked,
      onSelect: () => void ribbon.run(item),
    }));
}

/** ボタン（大・小・トグル）。 */
function ButtonControl(props: { control: RibbonControl; form: Form }) {
  const language = useLanguage();
  const t = useT();
  const state = fromContext(ctx, () => ribbon.controlState(props.control));
  const [menu, setMenu] = createSignal<{ x: number; y: number } | null>(null);
  const large = () =>
    props.control.kind === "largeButton" && props.form === "large";
  const iconOnly = () =>
    props.form === "icon" || props.control.iconOnly === true;
  const label = () => commandTitle(props.control, language());
  const id = () => props.control.command ?? "";
  const inQuickAccess = fromStore(
    () => quickAccess.has(id()),
    quickAccess.subscribe,
  );

  return (
    <>
      <button
        type="button"
        class="ribbon-button"
        classList={{ large: large(), checked: state().checked }}
        disabled={!state().enabled}
        aria-label={label()}
        title={label()}
        aria-pressed={
          props.control.kind === "toggle" ? state().checked : undefined
        }
        onClick={() => void ribbon.run(props.control)}
        onContextMenu={(event) => {
          event.preventDefault();
          if (props.control.command)
            setMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <Icon name={iconOf(props.control)} size={large() ? 28 : SMALL_ICON} />
        <Show when={!iconOnly()}>
          <span class="ribbon-label">{label()}</span>
        </Show>
        {/* 色だけに頼らず、オンのトグルは下線でも示す（CSS）。 */}
      </button>
      <Show when={menu()}>
        <div
          class="context-menu-anchor"
          style={{ left: `${menu()?.x ?? 0}px`, top: `${menu()?.y ?? 0}px` }}
        >
          <Menu
            label={label()}
            onClose={() => setMenu(null)}
            items={[
              inQuickAccess()
                ? {
                    label: t("qa.remove"),
                    onSelect: () => quickAccess.remove(id()),
                  }
                : { label: t("qa.add"), onSelect: () => quickAccess.add(id()) },
            ]}
          />
        </div>
      </Show>
    </>
  );
}

/** メニューを開くボタン（分割ボタンの矢印・ドロップダウン）。 */
function MenuButton(props: {
  label: string;
  icon: string | undefined;
  items: () => MenuItem[];
  showLabel: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = createSignal(false);
  let trigger: HTMLButtonElement | undefined;
  return (
    <span class="menu-host">
      <button
        ref={trigger}
        type="button"
        class="ribbon-button"
        disabled={props.disabled === true}
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-label={props.label}
        title={props.label}
        onClick={() => setOpen(!open())}
      >
        <Icon name={props.icon} size={SMALL_ICON} />
        <Show when={props.showLabel}>
          <span class="ribbon-label">{props.label}</span>
        </Show>
        <Icon name="$(chevron-down)" size={12} />
      </button>
      <Show when={open()}>
        <Menu
          label={props.label}
          items={props.items()}
          anchor={trigger}
          onClose={() => setOpen(false)}
        />
      </Show>
    </span>
  );
}

function SplitControl(props: { control: RibbonControl; form: Form }) {
  const language = useLanguage();
  const state = fromContext(ctx, () => ribbon.controlState(props.control));
  const primary = () => primaryInvocation(props.control);
  const label = () => commandTitle(props.control, language());
  return (
    <span class="split">
      <button
        type="button"
        class="ribbon-button"
        disabled={!state().enabled}
        aria-label={label()}
        title={label()}
        onClick={() => {
          const call = primary();
          if (call) void commands.execute(call.command, call.args);
        }}
      >
        <Icon name={iconOf(props.control)} size={SMALL_ICON} />
        <Show when={props.form !== "icon"}>
          <span class="ribbon-label">{label()}</span>
        </Show>
      </button>
      <MenuButton
        label={label()}
        icon={undefined}
        showLabel={false}
        items={() => menuItemsOf(props.control.items ?? [], language())}
      />
    </span>
  );
}

function NumberControl(props: { control: RibbonControl; form: Form }) {
  const range = () =>
    props.control.numberRange ?? { min: 0, max: 100, step: 1 };
  const [value, setValue] = createSignal(range().min);
  const [text, setText] = createSignal(String(range().min));
  const language = useLanguage();
  const label = () => commandTitle(props.control, language());
  function commit(): void {
    const result = commitNumber(text(), range(), value());
    setText(String(result.value));
    if (!result.commit) return;
    setValue(result.value);
    if (props.control.command) {
      void commands.execute(props.control.command, result.value);
    }
  }
  return (
    <label class="ribbon-number">
      <Show when={props.form !== "icon"}>
        <span class="ribbon-label">{label()}</span>
      </Show>
      <input
        type="text"
        inputMode="decimal"
        aria-label={label()}
        value={text()}
        onInput={(event) => setText(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.isComposing) commit();
        }}
      />
    </label>
  );
}

function GalleryControl(props: { control: RibbonControl; form: Form }) {
  const language = useLanguage();
  const items = () => props.control.items ?? [];
  return (
    <Show
      when={props.form === "large" || props.form === "small"}
      fallback={
        <MenuButton
          label={commandTitle(props.control, language()) || "…"}
          icon="$(tag)"
          showLabel={false}
          items={() => menuItemsOf(items(), language())}
        />
      }
    >
      <fieldset class="gallery">
        <For each={items()}>
          {(item, index) => {
            const state = fromContext(ctx, () => ribbon.controlState(item));
            const call = () => galleryInvocation(props.control, index());
            return (
              <button
                type="button"
                class="ribbon-button"
                disabled={!state().enabled}
                title={commandTitle(item, language())}
                aria-label={commandTitle(item, language())}
                onClick={() => {
                  const c = call();
                  if (c) void commands.execute(c.command, c.args);
                }}
              >
                <Icon name={iconOf(item)} size={SMALL_ICON} />
                <span class="gallery-index">{index() + 1}</span>
              </button>
            );
          }}
        </For>
      </fieldset>
    </Show>
  );
}

function DropdownControl(props: { control: RibbonControl; form: Form }) {
  const language = useLanguage();
  const label = () => commandTitle(props.control, language());
  return (
    <MenuButton
      label={label()}
      icon={iconOf(props.control)}
      showLabel={props.form !== "icon"}
      items={() => menuItemsOf(props.control.items ?? [], language())}
    />
  );
}

/** 7 種類のコントロールを描き分ける。 */
export function Control(props: { control: RibbonControl; form: Form }) {
  return (
    <>
      {props.control.kind === "separator" && <hr class="ribbon-separator" />}
      {(props.control.kind === "largeButton" ||
        props.control.kind === "smallButton" ||
        props.control.kind === "toggle") && (
        <ButtonControl control={props.control} form={props.form} />
      )}
      {props.control.kind === "splitButton" && (
        <SplitControl control={props.control} form={props.form} />
      )}
      {props.control.kind === "dropdown" && (
        <DropdownControl control={props.control} form={props.form} />
      )}
      {props.control.kind === "numberInput" && (
        <NumberControl control={props.control} form={props.form} />
      )}
      {props.control.kind === "gallery" && (
        <GalleryControl control={props.control} form={props.form} />
      )}
    </>
  );
}
