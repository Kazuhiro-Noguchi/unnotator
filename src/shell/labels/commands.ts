// ラベルのコマンド。ショートカットキー `core.label.pick1`〜`pick9` は、ラベルのカードをクリックする操作のショートカット:
// 現在位置に分類ラベルを付ける・外す（選択は、その結果として決まる。`active.ts`）。`core.edit.deselect`（選択解除。Esc）は、選択を解除する
// （現在位置の分類をすべて外す）。006 の空の処理を置き換える。
import { format, t } from "../../i18n";
import type { CommandRegistry } from "../commands/registry";
import type { CurrentTarget } from "../explorer/types";
import type { ProjectData } from "../project-data/store";
import type { Command, LabelRow } from "../project-data/types";
import type { Disposable, NotifyLevel } from "../types";
import { type ClassifyRefusal, classify, labelForKey } from "./classify";

export interface LabelCommandDeps extends LabelPickDeps {
  commands: Pick<CommandRegistry, "provide">;
}

/** ラベルのクリック・キーの操作に要るもの（コマンドの登録簿は、含まない）。 */
export interface LabelPickDeps {
  data: Pick<ProjectData, "labels" | "details" | "apply">;
  current: { get(): CurrentTarget | null };
  /** 設定 `core.classification.multiple`。 */
  multiple(): Promise<boolean>;
  /** アイテムの提供元（アイテムの位置のとき）。分からなければ `null`。 */
  providerOf(mediaType: string | null): string | null;
  notify(level: NotifyLevel, text: string): void;
}

const REFUSAL: Record<
  Exclude<ClassifyRefusal, "noCurrent" | "noLabel">,
  Parameters<typeof t>[0]
> = {
  hidden: "labels.pick.hidden",
  notAllowed: "labels.pick.notAllowed",
  noProvider: "labels.pick.notAllowed",
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
          : pickLabel(deps, label);
      }),
    );
  }
  handles.push(
    deps.commands.provide("core.edit.deselect", () => deselectLabels(deps)),
  );
  return {
    dispose() {
      for (const handle of handles) handle.dispose();
    },
  };
}

function fail(deps: LabelPickDeps, e: unknown): void {
  deps.notify(
    "error",
    format(t("labels.pick.failed"), {
      reason: e instanceof Error ? e.message : String(e),
    }),
  );
}

/**
 * ラベルをクリックする（またはショートカットキーを押す）: 現在位置に、そのラベルの分類を付ける。
 * 付いていれば外す。単一のときは、別のラベルへの付け替え。
 */
export async function pickLabel(
  deps: LabelPickDeps,
  label: LabelRow,
): Promise<void> {
  const current = deps.current.get();
  // 現在位置が無いときは、何もしない（知らせもしない）。
  if (current === null) return;
  const result = classify({
    label,
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
    fail(deps, e);
  }
}

/** 選択を解除する: 現在位置の分類を、すべて外す（1 つの元に戻せる操作）。 */
export async function deselectLabels(deps: LabelPickDeps): Promise<void> {
  const classification = deps.data.details()?.classification ?? [];
  const removals: Command[] = classification.map((c) => ({
    kind: "delete_annotation",
    id: c.id,
  }));
  const [only] = removals;
  if (only === undefined) return;
  try {
    await deps.data.apply(
      removals.length === 1
        ? only
        : { kind: "transaction", commands: removals },
    );
  } catch (e) {
    fail(deps, e);
  }
}
