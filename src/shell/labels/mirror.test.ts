import { createRoot, createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import type {
  AnnotationRow,
  LabelRow,
  TargetDetails,
} from "../project-data/types";
import { createClassificationMirror } from "./mirror";
import { createLabelsUi } from "./ui";

const row = (id: string, hidden = false): LabelRow => ({
  id,
  name: id,
  name_i18n_json: "{}",
  color: "#112233",
  hotkey: null,
  sort_order: 0,
  hidden,
  applies_to_json: "{}",
});

const cls = (labelId: string | null): AnnotationRow => ({
  id: `c-${labelId}`,
  type: "core/classification",
  type_version: 1,
  label_id: labelId,
  attributes_json: "{}",
  summary: "",
  z_order: 0,
  source: "manual",
});

const detailsOf = (labelIds: Array<string | null>): TargetDetails => ({
  asset: {
    id: "a1",
    root_key: "",
    rel_path: "a.bin",
    media_type: null,
    missing: false,
    status: "todo",
    note: null,
    attributes_json: "{}",
  },
  item: null,
  classification: labelIds.map(cls),
  annotation_count: labelIds.length,
  relations: [],
  groups: [],
});

function setup(labels: LabelRow[], details: TargetDetails | null) {
  const ui = createLabelsUi();
  const [mode, setMode] = createSignal(false);
  const [state, setState] = createSignal({ labels, details });
  createRoot(() =>
    createClassificationMirror({
      mode,
      labels: () => state().labels,
      details: () => state().details,
      ui,
    }),
  );
  return {
    ui,
    setMode,
    update: (
      next: Partial<{ labels: LabelRow[]; details: TargetDetails | null }>,
    ) => setState((s) => ({ ...s, ...next })),
  };
}

describe("ファイル分類モード: 選択は、表示中のファイルの分類に従う", () => {
  it("モードが切れているあいだは、選択に触らない", () => {
    const t = setup([row("a")], detailsOf(["a"]));
    expect(t.ui.selection().ids).toEqual([]);
    t.ui.click("a", "toggle", ["a"]);
    t.update({ details: detailsOf([]) });
    expect(t.ui.selection().ids).toEqual(["a"]);
  });

  it("モードを入れると、そのファイルに付いているラベルが選択される", () => {
    const t = setup([row("a"), row("b")], detailsOf(["b", "a"]));
    t.setMode(true);
    expect(t.ui.selection().ids).toEqual(["b", "a"]);
  });

  it("別のファイルへ移ると、未分類なら何も選択されず、分類済みならそのラベルが選択される", () => {
    const t = setup([row("a"), row("b")], detailsOf(["a"]));
    t.setMode(true);
    expect(t.ui.selection().ids).toEqual(["a"]);
    t.update({ details: detailsOf([]) });
    expect(t.ui.selection().ids).toEqual([]);
    t.update({ details: detailsOf(["b"]) });
    expect(t.ui.selection().ids).toEqual(["b"]);
    t.update({ details: null });
    expect(t.ui.selection().ids).toEqual([]);
  });

  it("非表示・消えたラベルは、選択に入れない", () => {
    const t = setup([row("a", true), row("b")], detailsOf(["a", "b", "gone"]));
    t.setMode(true);
    expect(t.ui.selection().ids).toEqual(["b"]);
  });
});
