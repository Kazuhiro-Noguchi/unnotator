import { createSignal, For, Show } from "solid-js";
import { Icon } from "../Icon";
import { Menu } from "../ribbon/Menu";
import { commands, layout, views } from "../services";
import { fromStore, useLanguage, useT } from "../solid";
import { resolveTitle } from "../title";

export function ActivityBar() {
  const t = useT();
  const language = useLanguage();
  const state = fromStore(layout.get, layout.subscribe);
  const [menuOpen, setMenuOpen] = createSignal(false);
  let gear: HTMLButtonElement | undefined;
  const titleOf = (id: string) => {
    const spec = commands.get(id);
    return spec ? resolveTitle(spec.title, language()) : "";
  };
  // 歯車のメニュー: 設定とバージョン情報。
  const gearItems = () =>
    ["core.app.settings", "core.app.about"].map((id) => ({
      label: titleOf(id),
      onSelect: () => void commands.execute(id),
    }));
  const list = fromStore(() => views.list("primarySidebar"), views.subscribe);
  return (
    <nav
      class="activity-bar"
      data-region="activityBar"
      aria-label={t("region.activityBar")}
    >
      <For each={list()}>
        {(view) => {
          const pressed = () =>
            state().primarySidebar.visible &&
            state().primarySidebar.view === view.id;
          const title = () => resolveTitle(view.title, language());
          return (
            <button
              type="button"
              class="activity-button"
              aria-pressed={pressed()}
              aria-label={title()}
              title={title()}
              onClick={() => layout.selectPrimarySidebarView(view.id)}
            >
              <Icon name={view.icon} size={22} />
            </button>
          );
        }}
      </For>
      <button
        ref={gear}
        type="button"
        class="activity-button settings"
        aria-haspopup="menu"
        aria-expanded={menuOpen()}
        aria-label={titleOf("core.app.settings")}
        title={titleOf("core.app.settings")}
        onClick={() => setMenuOpen(!menuOpen())}
      >
        <Icon name="$(settings)" size={22} />
      </button>
      <Show when={menuOpen()}>
        <Menu
          label={titleOf("core.app.settings")}
          items={gearItems()}
          anchor={gear}
          onClose={() => setMenuOpen(false)}
        />
      </Show>
    </nav>
  );
}
