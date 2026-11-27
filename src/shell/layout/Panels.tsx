import { For, Show } from "solid-js";
import { layout, views } from "../services";
import { fromStore, useLanguage, useT } from "../solid";
import { resolveTitle } from "../title";
import { EmptyState } from "./EmptyState";
import type { ViewLocation } from "./views";

/** 配置か登録簿のどちらかが変わったら知らせる購読。 */
function subscribeLayoutAndViews(listener: () => void): () => void {
  const offViews = views.subscribe(listener);
  const offLayout = layout.subscribe(listener);
  return () => {
    offViews();
    offLayout();
  };
}

/** サイドバー。選択中の入口のビューを出す。 */
export function PrimarySidebar(props: { width: number }) {
  const t = useT();
  const language = useLanguage();
  const view = fromStore(
    () => views.get(layout.get().primarySidebar.view),
    subscribeLayoutAndViews,
  );
  return (
    <aside
      class="panel"
      data-region="primarySidebar"
      aria-label={t("region.primarySidebar")}
      style={{ width: `${props.width}px`, flex: "none" }}
    >
      <Show when={view()}>
        {(v) => (
          <>
            <div class="panel-header">
              {resolveTitle(v().title, language())}
            </div>
            <div class="panel-body">{v().render()}</div>
          </>
        )}
      </Show>
    </aside>
  );
}

/** タブつきのパネルの共通部分（プロパティ・ボトムパネル）。 */
function TabbedPanel(props: {
  region: "secondarySidebar" | "bottom";
  location: ViewLocation;
  label: string;
  selected: () => string;
  onSelect: (id: string) => void;
  style: Record<string, string>;
}) {
  const language = useLanguage();
  const list = fromStore(() => views.list(props.location), views.subscribe);
  const current = fromStore(
    () => views.get(props.selected()),
    subscribeLayoutAndViews,
  );
  return (
    <section
      class="panel"
      data-region={props.region}
      aria-label={props.label}
      style={props.style}
    >
      <div class="tab-strip" role="tablist">
        <For each={list()}>
          {(view) => (
            <button
              type="button"
              role="tab"
              aria-selected={props.selected() === view.id}
              onClick={() => props.onSelect(view.id)}
            >
              {resolveTitle(view.title, language())}
            </button>
          )}
        </For>
      </div>
      <div class="panel-body" role="tabpanel">
        {current()?.render()}
      </div>
    </section>
  );
}

export function SecondarySidebar(props: { width: number }) {
  const t = useT();
  const state = fromStore(layout.get, layout.subscribe);
  return (
    <TabbedPanel
      region="secondarySidebar"
      location="secondarySidebar"
      label={t("region.secondarySidebar")}
      selected={() => state().secondarySidebar.tab}
      onSelect={(id) => layout.selectSecondarySidebarTab(id)}
      style={{ width: `${props.width}px`, flex: "none" }}
    />
  );
}

export function BottomPanel(props: { height: number }) {
  const t = useT();
  const state = fromStore(layout.get, layout.subscribe);
  return (
    <TabbedPanel
      region="bottom"
      location="panel"
      label={t("region.bottom")}
      selected={() => state().bottom.tab}
      onSelect={(id) => layout.selectBottomTab(id)}
      style={{ height: `${props.height}px`, flex: "none" }}
    />
  );
}
