// ラベルのコマンド（006 の空の処理を置き換える）。
//
// 選択（有効なラベル）と、分類は、別の操作:
// - ショートカットキー `core.label.pick1`〜`pick9` は、ラベルのカードをクリックする操作のショートカット。ラベルを選択に足す・外す
//   だけで、何も付かない（選択中のラベルのキーをもう一度押すと、選択から外す）。選んだラベルは、拡張機能がアノテーションを作るときに使う（`labels.active()`）。
// - `core.edit.deselect`（選択解除。Esc）は、ラベルの選択を解除する。
// - `core.label.classify` は、選択中のラベルを、現在位置（アセット・アイテム）の分類として、付ける・外す（付いていれば外す）。
import { format, t } from "../../i18n";
import type { CommandRegistry } from "../commands/registry";
import type { CurrentTarget } from "../explorer/types";
import type { ProjectData } from "../project-data/store";
import type { LabelRow } from "../project-data/types";
import type { Disposable, NotifyLevel } from "../types";
import { type ClassifyRefusal, classifyMany, labelForKey } from "./classify";
import type { ClickMode } from "./selection";

/** 選択の操作に要るもの。 */
export interface LabelSelectDeps {
  /** 選択中のラベル（選んだ順。非表示・消えたものは、含まない）。 */
  selected(): readonly LabelRow[];
  /** ラベルをクリックしたのと同じに、選択を変える。 */
  click(labelId: string, mode: ClickMode): void;
  /** 選択を、すべて解除する。 */
  clear(): void;
  notify(level: NotifyLevel, text: string): void;
}

/** 分類の付け外しに要るもの。 */
export interface LabelClassifyDeps extends LabelSelectDeps {
  data: Pick<ProjectData, "labels" | "details" | "apply">;
  current: { get(): CurrentTarget | null };
  /** 設定 `core.classification.multiple`。 */
  multiple(): Promise<boolean>;
  /** アイテムの提供元（アイテムの位置のとき）。分からなければ `null`。 */
  providerOf(mediaType: string | null): string | null;
}

export interface LabelCommandDeps extends LabelClassifyDeps {
  commands: Pick<CommandRegistry, "provide">;
}

const REFUSAL: Record<
  Exclude<ClassifyRefusal, "noCurrent" | "noLabel">,
  Parameters<typeof t>[0]
> = {
  hidden: "labels.pick.hidden",
  notAllowed: "labels.pick.notAllowed",
  noProvider: "labels.pick.notAllowed",
  needMultiple: "labels.classify.needMultiple",
};

export function provideLabelHandlers(deps: LabelCommandDeps): Disposable {
  const handles: Disposable[] = [];
  for (let key = 1; key <= 9; key++) {
    handles.push(
      deps.commands.provide(`core.label.pick${key}`, () => {
        const label = labelForKey(deps.data.labels(), key);
        return label === undefined
          ? deps.notify(
              "warn",
              format(t("labels.pick.none"), { key: String(key) }),
            )
          : selectLabel(deps, label);
      }),
    );
  }
  handles.push(
    deps.commands.provide("core.edit.deselect", () => deps.clear()),
    deps.commands.provide("core.label.classify", () =>
      classifyActiveLabels(deps),
    ),
  );
  return {
    dispose() {
      for (const handle of handles) handle.dispose();
    },
  };
}

/**
 * ラベルを選ぶ（カードのクリック・ショートカットキー）。既定の `toggle`: 選択に足す・外す（選択中のものを押すと、外す）。
 * `range`（Shift）: 範囲を選ぶ。非表示のラベルは、選べない。
 */
export function selectLabel(
  deps: LabelSelectDeps,
  label: LabelRow,
  mode: ClickMode = "toggle",
): void {
  if (label.hidden) {
    deps.notify("warn", t("labels.pick.hidden"));
    return;
  }
  deps.click(label.id, mode);
}

/**
 * 選択中のラベル（複数なら、すべて）を、現在位置の分類として付ける。すべて付いていれば外す。
 * 単一のときは、別のラベルへの付け替え。複数のラベルを同時に付けるには、設定 `core.classification.multiple` が要る。
 */
export async function classifyActiveLabels(
  deps: LabelClassifyDeps,
): Promise<void> {
  const labels = deps.selected();
  if (labels.length === 0) {
    deps.notify("warn", t("labels.classify.none"));
    return;
  }
  const current = deps.current.get();
  // 現在位置が無いときは、何もしない（知らせもしない）。
  if (current === null) return;
  const result = classifyMany({
    labels,
    current,
    details: deps.data.details(),
    provider: deps.providerOf(current.mediaType),
    multiple: await deps.multiple(),
  });
  if (result.kind === "refuse") {
    if (result.reason === "noCurrent" || result.reason === "noLabel") return;
    deps.notify("warn", t(REFUSAL[result.reason]));
    return;
  }
  try {
    await deps.data.apply(result.command);
  } catch (e) {
    deps.notify(
      "error",
      format(t("labels.pick.failed"), {
        reason: e instanceof Error ? e.message : String(e),
      }),
    );
  }
}
