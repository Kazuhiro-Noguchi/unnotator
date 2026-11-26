import { For } from "solid-js";
import { notifyStore } from "../services";
import { fromStore, useT } from "../solid";
import { NotificationCard } from "./NotificationCard";

/**
 * 画面の右下に出るトースト（同時に 3 件まで。多いときと、info の時間切れは、トーストだけ消えて通知センターに残る。
 * 閉じるボタンで閉じたものは、通知センターからも消える）。
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
            clamp
            closeLabel={t("notify.dismiss")}
            // 自分で閉じた通知は、通知センターにも残さない。
            onClose={() => notifyStore.remove(item.id)}
            onAction={() => notifyStore.remove(item.id)}
          />
        )}
      </For>
    </div>
  );
}
