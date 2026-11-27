// ファイル分類モード: ラベルの選択を、表示中のファイルに付いている分類のラベルに合わせる。
// モードが入っているあいだ、ファイルを移ると、未分類なら何も選択されず、分類済みならそのラベルが選択される。
// 分類を変える操作（ラベルのクリック）は、分類を書き、その結果が、ここで選択に反映される。
// モードが切れているあいだは、選択に触らない（選択は、分類とは別）。
import { createEffect } from "solid-js";
import type { ProjectData } from "../project-data/store";
import { fromStore } from "../solid";
import type { LabelsUi } from "./ui";

/** 反応するスコープ（`createRoot`）の中で作る。 */
export function createClassificationMirror(deps: {
  mode(): boolean;
  labels: ProjectData["labels"];
  details: ProjectData["details"];
  ui: Pick<LabelsUi, "setSelection">;
}): void {
  createEffect(() => {
    if (!deps.mode()) return;
    const visible = new Set(
      deps
        .labels()
        .filter((l) => !l.hidden)
        .map((l) => l.id),
    );
    const ids = (deps.details()?.classification ?? []).flatMap((c) =>
      c.label_id !== null && visible.has(c.label_id) ? [c.label_id] : [],
    );
    deps.ui.setSelection({ ids, anchor: ids.at(-1) ?? null });
  });
}

/** `ProjectData` から、反応する形で読む版（アプリで使う）。 */
export function createClassificationMirrorFor(
  data: Pick<ProjectData, "labels" | "details" | "subscribe">,
  mode: () => boolean,
  ui: Pick<LabelsUi, "setSelection">,
): void {
  const labels = fromStore(
    () => data.labels(),
    (listener) => data.subscribe(listener),
  );
  const details = fromStore(
    () => data.details(),
    (listener) => data.subscribe(listener),
  );
  createClassificationMirror({ mode, labels, details, ui });
}
