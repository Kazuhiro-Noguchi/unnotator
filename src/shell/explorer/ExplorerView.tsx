import { type JSX, Show } from "solid-js";
import { ctx } from "../services";
import { fromContext } from "../solid";
import { Explorer } from "./Explorer";
import { explorer } from "./instance";

/** サイドバーの「エクスプローラー」。プロジェクトが開いていないあいだは、空の状態の案内を出す。 */
export function ExplorerView(props: { fallback: JSX.Element }) {
  const open = fromContext(ctx, () => ctx.get("projectOpen") === true);
  return (
    <Show when={open()} fallback={props.fallback}>
      <Explorer
        controller={explorer.controller}
        rows={explorer.rows}
        current={explorer.current}
      />
    </Show>
  );
}
