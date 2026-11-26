import { For, Show } from "solid-js";
import { format } from "../../i18n";
import { commands, statusStore } from "../services";
import { fromStore, useT } from "../solid";
import type { StatusItem } from "../types";

function ItemView(props: { item: StatusItem }) {
  return (
    <Show
      when={props.item.command}
      fallback={
        <span class="status-item" title={props.item.tooltip}>
          {props.item.text}
        </span>
      }
    >
      {(command) => (
        <button
          type="button"
          class="status-item clickable"
          title={props.item.tooltip}
          onClick={() => void commands.execute(command())}
        >
          {props.item.text}
        </button>
      )}
    </Show>
  );
}

/** ステータスバー: メッセージ・送り元ごとの項目・進捗（完了数 / 総数）・実行中のジョブ。 */
export function StatusBar() {
  const t = useT();
  const state = fromStore(statusStore.state, statusStore.subscribe);
  const left = fromStore(
    () => statusStore.items("left"),
    statusStore.subscribe,
  );
  const right = fromStore(
    () => statusStore.items("right"),
    statusStore.subscribe,
  );
  const percent = fromStore(() => statusStore.percent(), statusStore.subscribe);
  return (
    <div class="status-bar">
      <span class="status-message">{state().message ?? t("status.ready")}</span>
      <For each={left()}>{(item) => <ItemView item={item} />}</For>
      <span class="status-spacer" />
      <For each={right()}>{(item) => <ItemView item={item} />}</For>
      <Show when={state().progress}>
        {(progress) => (
          <span class="status-item">
            <progress
              max={progress().total}
              value={progress().done}
              aria-hidden="true"
            />
            {format(t("status.progress"), {
              done: progress().done,
              total: progress().total,
              percent: percent() ?? 0,
            })}
          </span>
        )}
      </Show>
      <Show when={state().jobs > 0}>
        <span class="status-item">
          {format(t("status.jobs"), { count: state().jobs })}
        </span>
      </Show>
    </div>
  );
}
