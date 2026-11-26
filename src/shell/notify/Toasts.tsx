import { For } from "solid-js";
import { notifyStore } from "../services";
import { fromStore, useT } from "../solid";
import { NotificationCard } from "./NotificationCard";

/**
 * 画面の右下に出るトースト（同時に 3 件まで。多いときは古いものから消え、通知センターに残る）。
 * 通知センターを開いている間は、ストアがトーストを空にする（`setToastsEnabled`）。
 */
export function Toasts() {
  const t = useT();
  const list = fromStore(notifyStore.list, notifyStore.subscribe);
  return (
    <div class="toasts">
      <For each={list()}>
        {(item) => (
          <NotificationCard
            item={item}
            closeLabel={t("notify.dismiss")}
            onClose={() => notifyStore.dismiss(item.id)}
            onAction={() => notifyStore.remove(item.id)}
          />
        )}
      </For>
    </div>
  );
}
