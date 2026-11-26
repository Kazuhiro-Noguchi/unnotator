import { For } from "solid-js";
import { Icon } from "../Icon";
import { commands, layout, views } from "../services";
import { fromStore, useLanguage, useT } from "../solid";
import { resolveTitle } from "../title";

export function ActivityBar() {
  const t = useT();
  const language = useLanguage();
  const state = fromStore(layout.get, layout.subscribe);
  const settingsTitle = () => {
    const spec = commands.get("core.app.settings");
    return spec ? resolveTitle(spec.title, language()) : "";
  };
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
        type="button"
        class="activity-button settings"
        aria-label={settingsTitle()}
        title={settingsTitle()}
        onClick={() => void commands.execute("core.app.settings")}
      >
        <Icon name="$(settings)" size={22} />
      </button>
    </nav>
  );
}
