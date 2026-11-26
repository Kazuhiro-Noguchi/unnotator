import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Icon } from "../Icon";
import { LayoutToggles } from "../layout/LayoutToggles";
import { commands, ctx, quickAccess, ribbon } from "../services";
import { fromContext, fromStore, useLanguage, useT } from "../solid";
import { resolveTitle } from "../title";
import type { Form, RibbonGroup } from "../types";
import {
  ribbonSelected,
  setBackstageOpen,
  setRibbonSelected,
} from "../ui-state";
import { Control, menuItemsOf } from "./controls/Controls";
import { FORMS, fitGroups, type GroupMeasure } from "./fit";
import { Menu } from "./Menu";

function GroupView(props: {
  group: RibbonGroup;
  form: Form;
  tab: string;
  measuring?: boolean;
}) {
  const language = useLanguage();
  const t = useT();
  const [open, setOpen] = createSignal(false);
  let trigger: HTMLButtonElement | undefined;
  const title = () => resolveTitle(props.group.title, language());
  // キーチップの対象（開いているタブの最上位のコントロールを、順に数える）。
  const targetOf = (index: number) =>
    `control:${props.tab}/${props.group.controls.slice(0, index).filter((c) => c.kind !== "separator").length}`;
  return (
    <fieldset
      class="ribbon-group"
      aria-label={title()}
      data-group={props.group.id}
    >
      <Show
        when={props.form !== "dropdown"}
        fallback={
          <span class="menu-host">
            <button
              ref={trigger}
              type="button"
              class="ribbon-button"
              aria-haspopup="menu"
              aria-expanded={open()}
              title={title()}
              aria-label={t("ribbon.group.more").replace("{group}", title())}
              onClick={() => setOpen(!open())}
            >
              <span class="ribbon-label">{title()}</span>
              <Icon name="$(chevron-down)" size={12} />
            </button>
            <Show when={open() && !props.measuring}>
              <Menu
                anchor={trigger}
                label={title()}
                items={menuItemsOf(
                  props.group.controls.flatMap((c) =>
                    c.kind === "gallery" ||
                    c.kind === "splitButton" ||
                    c.kind === "dropdown"
                      ? (c.items ?? [])
                      : [c],
                  ),
                  language(),
                  true,
                )}
                onClose={() => setOpen(false)}
              />
            </Show>
          </span>
        }
      >
        <div class="ribbon-controls">
          <For each={props.group.controls}>
            {(control, index) => (
              <span
                class="keytip-target"
                data-keytip={
                  control.kind === "separator" ? undefined : targetOf(index())
                }
              >
                <Control control={control} form={props.form} />
              </span>
            )}
          </For>
        </div>
        <div class="ribbon-group-title">{title()}</div>
      </Show>
    </fieldset>
  );
}

function QuickAccessBar() {
  const t = useT();
  const language = useLanguage();
  const ids = fromStore(() => quickAccess.visible(), quickAccess.subscribe);
  return (
    <div
      class="quick-access"
      role="toolbar"
      aria-label={t("ribbon.quickAccess")}
    >
      <For each={ids()}>
        {(id) => {
          const state = fromContext(ctx, () => commands.availability(id)());
          const spec = () => commands.get(id);
          const label = () =>
            spec() ? resolveTitle(spec()?.title ?? {}, language()) : id;
          return (
            <span class="keytip-target" data-keytip={`qa:${id}`}>
              <button
                type="button"
                class="ribbon-button quick"
                disabled={!state().enabled}
                title={label()}
                aria-label={label()}
                onClick={() => void commands.execute(id)}
              >
                <Icon name={spec()?.icon} size={18} />
              </button>
            </span>
          );
        }}
      </For>
    </div>
  );
}

const PADDING = 14; // ribbon-body の左右の余白

/** リボン本体。幅に応じて、グループ単位で 大 → 小 → アイコンのみ → ドロップダウン に縮退する。 */
export function Ribbon() {
  const t = useT();
  const language = useLanguage();
  const tabs = fromContext(ctx, () => ribbon.tabs());
  const selected = ribbonSelected;
  const current = () =>
    tabs().find((tab) => tab.id === selected()) ??
    tabs().find((tab) => tab.id !== "file");

  // 選んでいるタブが消えたら、先頭の通常のタブに戻る。
  createEffect(() => {
    const list = tabs();
    if (!list.some((tab) => tab.id === selected())) {
      const fallback =
        list.find((tab) => tab.id !== "file" && !tab.contextual) ?? list[0];
      if (fallback) setRibbonSelected(fallback.id);
    }
  });

  // ---- 縮退: 幅の測定（鍵・言語・コントロールが変わったときだけ）と、利用できる幅の監視 ----
  const [measures, setMeasures] = createSignal<GroupMeasure[]>([]);
  const [available, setAvailable] = createSignal(Number.POSITIVE_INFINITY);
  let body: HTMLDivElement | undefined;
  let measureRoot: HTMLDivElement | undefined;
  let frame = 0;

  function measure(): void {
    const tab = current();
    if (!tab || !measureRoot) return;
    const result: GroupMeasure[] = tab.groups.map((group) => {
      const widths = Object.fromEntries(
        FORMS.map((form) => {
          const el = measureRoot?.querySelector<HTMLElement>(
            `[data-measure="${group.id}:${form}"]`,
          );
          return [form, Math.ceil(el?.getBoundingClientRect().width ?? 0)];
        }),
      ) as Record<Form, number>;
      return { id: group.id, priority: group.priority, widths };
    });
    setMeasures(result);
  }

  createEffect(
    on([current, language], () => {
      // 描画が済んでから測る。
      queueMicrotask(() => requestAnimationFrame(measure));
    }),
  );

  onMount(() => {
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (body) setAvailable(body.clientWidth - PADDING);
      });
    };
    update();
    const observer = new ResizeObserver(update);
    if (body) observer.observe(body);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    });
  });

  const forms = createMemo(() => fitGroups(measures(), available()));

  return (
    <div class="ribbon">
      <div class="ribbon-top">
        <QuickAccessBar />
        <div class="ribbon-tabs" role="tablist" aria-label={t("ribbon.tabs")}>
          <For each={tabs()}>
            {(tab) => (
              <button
                type="button"
                role="tab"
                class="ribbon-tab"
                classList={{
                  contextual: tab.contextual,
                  "file-tab": tab.id === "file",
                }}
                data-keytip={`tab:${tab.id}`}
                aria-selected={selected() === tab.id}
                onClick={() =>
                  tab.id === "file"
                    ? setBackstageOpen(true)
                    : setRibbonSelected(tab.id)
                }
              >
                {resolveTitle(tab.title, language())}
              </button>
            )}
          </For>
        </div>
        <LayoutToggles />
      </div>
      <div class="ribbon-body" role="tabpanel" ref={body}>
        <Show when={current()}>
          {(tab) => (
            <For each={tab().groups}>
              {(group) => (
                <GroupView
                  group={group}
                  tab={tab().id}
                  form={forms()[group.id] ?? "large"}
                />
              )}
            </For>
          )}
        </Show>
      </div>
      {/* 幅の測定用。見えず、操作もできない。 */}
      <div class="ribbon-measure" aria-hidden="true" ref={measureRoot} inert>
        <Show when={current()}>
          {(tab) => (
            <For each={tab().groups}>
              {(group) => (
                <For each={FORMS}>
                  {(form) => (
                    <div
                      class="ribbon-measure-cell"
                      data-measure={`${group.id}:${form}`}
                    >
                      <GroupView
                        group={group}
                        tab={tab().id}
                        form={form}
                        measuring
                      />
                    </div>
                  )}
                </For>
              )}
            </For>
          )}
        </Show>
      </div>
    </div>
  );
}
