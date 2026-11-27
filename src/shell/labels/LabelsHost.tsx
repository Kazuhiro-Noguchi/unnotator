import { type JSX, Show } from "solid-js";
import { projectData } from "../project-data/instance";
import { ctx, notify } from "../services";
import { fromContext } from "../solid";
import { LabelsHeaderActions } from "./HeaderActions";
import { LabelsView } from "./LabelsView";
import { labelsUi } from "./ui";

/** サイドバーの「ラベル」。プロジェクトが開いていないあいだは、空の状態の案内を出す。 */
export function LabelsHost(props: { fallback: JSX.Element }) {
  const open = fromContext(ctx, () => ctx.get("projectOpen") === true);
  return (
    <Show when={open()} fallback={props.fallback}>
      <LabelsView
        data={projectData}
        notify={(level, text) => notify(level, text)}
        ui={labelsUi}
      />
    </Show>
  );
}

/** 「ラベル」の見出しの右端の操作。プロジェクトが開いているあいだだけ出す。 */
export function LabelsHeader() {
  const open = fromContext(ctx, () => ctx.get("projectOpen") === true);
  return (
    <Show when={open()}>
      <LabelsHeaderActions ui={labelsUi} />
    </Show>
  );
}
