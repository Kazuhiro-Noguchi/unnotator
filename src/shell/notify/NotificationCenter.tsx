import { createEffect, For, onCleanup, Show } from "solid-js";
import { Icon } from "../Icon";
import { notifyStore } from "../services";
import { fromStore, useT } from "../solid";
import { centerOpen, setCenterOpen } from "./center";
import { NotificationCard } from "./NotificationCard";

/** 通知センター: ベルから開く、しまってある通知の一覧（新しいものが上）。 */
export function NotificationCenter() {
  const t = useT();
  const history = fromStore(notifyStore.history, notifyStore.subscribe);
  createEffect(() => {
    if (!centerOpen()) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) setCenterOpen(false);
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });
  return (
    <Show when={centerOpen()}>
      <section class="center" aria-label={t("notify.center")}>
        <header class="center-header">
          <h2 class="center-title">{t("notify.center")}</h2>
          <button
            type="button"
            class="button icon-button"
            aria-label={t("notify.removeAll")}
            title={t("notify.removeAll")}
            disabled={history().length === 0}
            onClick={() => notifyStore.removeAll()}
          >
            <Icon name="$(delete)" size={14} />
          </button>
          <button
            type="button"
            class="button icon-button"
            aria-label={t("notify.centerClose")}
            title={t("notify.centerClose")}
            onClick={() => setCenterOpen(false)}
          >
            <Icon name="$(close)" size={14} />
          </button>
        </header>
        <div class="center-list">
          <Show
            when={history().length > 0}
            fallback={<p class="center-empty">{t("notify.empty")}</p>}
          >
            <For each={[...history()].reverse()}>
              {(item) => (
                <NotificationCard
                  item={item}
                  closeLabel={t("notify.remove")}
                  onClose={() => notifyStore.remove(item.id)}
                />
              )}
            </For>
          </Show>
        </div>
      </section>
    </Show>
  );
}
