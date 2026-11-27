import { type JSX, Show } from "solid-js";
import { projectData } from "../project-data/instance";
import { commands, ctx, notify } from "../services";
import { fromContext } from "../solid";
import type { NotifyLevel } from "../types";
import { LabelsHeaderActions } from "./HeaderActions";
import { activeLabel, clickLabelCard } from "./instance";
import { LabelsView } from "./LabelsView";
import { labelsUi } from "./ui";

/** サイドバーの「ラベル」。プロジェクトが開いていないあいだは、空の状態の案内を出す。 */
const notifyLabel = (level: NotifyLevel, text: string) => notify(level, text);

export function LabelsHost(props: { fallback: JSX.Element }) {
  const open = fromContext(ctx, () => ctx.get("projectOpen") === true);
  return (
    <Show when={open()} fallback={props.fallback}>
      <LabelsView
        data={projectData}
        notify={(level, text) => notify(level, text)}
        ui={labelsUi}
        selectedIds={() => new Set(activeLabel.selected().map((l) => l.id))}
        onPick={(label, mode, order) =>
          clickLabelCard(notifyLabel, label, mode, order)
        }
      />
    </Show>
  );
}

/** 「ラベル」の見出しの右端の操作。プロジェクトが開いているあいだだけ出す。 */
export function LabelsHeader() {
  const open = fromContext(ctx, () => ctx.get("projectOpen") === true);
  return (
    <Show when={open()}>
      <LabelsHeaderActions
        ui={labelsUi}
        onDeselect={() => void commands.execute("core.edit.deselect")}
      />
    </Show>
  );
}
