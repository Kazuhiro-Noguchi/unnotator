import { type JSX, Show } from "solid-js";
import { ctx, notify } from "../services";
import { fromContext } from "../solid";
import {
  current,
  drafts,
  projectData,
  selection,
  supportedTypes,
} from "./instance";
import { Properties } from "./Properties";

/** 右サイドバーの「情報」。プロジェクトが開いていないあいだは、空の状態の案内を出す。 */
export function PropertiesHost(props: { fallback: JSX.Element }) {
  const open = fromContext(ctx, () => ctx.get("projectOpen") === true);
  return (
    <Show when={open()} fallback={props.fallback}>
      <Properties
        data={projectData}
        current={current}
        drafts={drafts}
        selection={selection}
        supported={supportedTypes}
        notify={(level, text) => notify(level, text)}
      />
    </Show>
  );
}
