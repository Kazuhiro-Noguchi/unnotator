import { For } from "solid-js";
import { notifyStore } from "../services";
import { fromStore, useT } from "../solid";

const MARK = { info: "ⓘ", warn: "⚠", error: "✕" } as const;

/** 通知。色だけでなく、記号と文言（情報・警告・エラー）でも段階を示す。 */
export function Toasts() {
  const t = useT();
  const list = fromStore(notifyStore.list, notifyStore.subscribe);
  return (
    <div class="toasts">
      <For each={list()}>
        {(item) => (
          <div
            class={`toast ${item.level}`}
            role={item.level === "error" ? "alert" : "status"}
          >
            <span class="toast-mark" aria-hidden="true">
              {MARK[item.level]}
            </span>
            <span class="toast-level">{t(`notify.${item.level}`)}</span>
            <span class="toast-text">{item.text}</span>
            <button
              type="button"
              class="button"
              aria-label={t("notify.dismiss")}
              onClick={() => notifyStore.dismiss(item.id)}
            >
              ✕
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
