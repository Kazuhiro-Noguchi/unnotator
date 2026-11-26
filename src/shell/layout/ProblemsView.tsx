import { For, Show } from "solid-js";
import { format } from "../../i18n";
import { problemStore } from "../problems";
import { fromStore, useT } from "../solid";
import { EmptyState } from "./EmptyState";

/** 「問題」ビューの最小の表示。シェルが集めた問題（when 式の誤りなど）を一覧する。011 が置き換える。 */
export function ProblemsView() {
  const t = useT();
  const list = fromStore(problemStore.list, problemStore.subscribe);
  return (
    <Show
      when={list().length > 0}
      fallback={<EmptyState message={t("empty.problems")} />}
    >
      <div class="problems">
        <div class="problems-count">
          {format(t("problems.count"), { count: list().length })}
        </div>
        <ul>
          <For each={list()}>
            {(problem) => (
              <li>
                <code>{problem.code}</code> <span>{problem.message}</span>
                <Show when={problem.count > 1}>
                  <span class="problems-times">
                    {format(t("problems.times"), { count: problem.count })}
                  </span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
}
