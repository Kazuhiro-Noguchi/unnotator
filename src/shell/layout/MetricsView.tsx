import { For, Show } from "solid-js";
import type { Metrics } from "../../host/metrics";
import { fromStore, useT } from "../solid";
import { EmptyState } from "./EmptyState";

/** 開発者モードで見る、拡張機能ごとの計測（FR-023）。問題ビューの隣に出す。 */
export function MetricsView(props: { metrics: Metrics }) {
  const t = useT();
  const table = fromStore(
    () => props.metrics.snapshot(),
    (listener) => props.metrics.subscribe(listener).dispose,
  );
  const rows = () => Object.entries(table());
  const round = (n: number) => String(Math.round(n));
  return (
    <Show
      when={rows().length > 0}
      fallback={<EmptyState message={t("metrics.empty")} />}
    >
      <table class="metrics">
        <thead>
          <tr>
            <th>{t("metrics.col.extension")}</th>
            <th>{t("metrics.col.activation")}</th>
            <th>{t("metrics.col.calls")}</th>
            <th>{t("metrics.col.average")}</th>
            <th>{t("metrics.col.max")}</th>
            <th>{t("metrics.col.slow")}</th>
            <th>{t("metrics.col.failures")}</th>
          </tr>
        </thead>
        <tbody>
          <For each={rows()}>
            {([id, m]) => (
              <tr>
                <td>{id}</td>
                <td>
                  {m.activationMs === undefined ? "–" : round(m.activationMs)}
                </td>
                <td>{m.calls}</td>
                <td>{m.calls === 0 ? "–" : round(m.totalCallMs / m.calls)}</td>
                <td>{round(m.maxCallMs)}</td>
                <td>{m.slowCalls}</td>
                <td>{m.failures}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </Show>
  );
}
