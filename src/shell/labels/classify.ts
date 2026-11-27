// 分類ラベルの付け外し（`core/classification`）。純関数（specs/008-properties-labels/data-model.md の「状態遷移」）。
import type { CurrentTarget } from "../explorer/types";
import type { Command, LabelRow, TargetDetails } from "../project-data/types";

type CreateTarget = Extract<Command, { kind: "create_annotation" }>["target"];

export type ClassifyRefusal =
  | "noCurrent"
  | "noLabel"
  | "hidden"
  | "notAllowed"
  | "noProvider";

export type ClassifyResult =
  | { kind: "apply"; command: Command }
  | { kind: "refuse"; reason: ClassifyRefusal };

export interface ClassifyInput {
  /** 押された数字キーのラベル。 */
  label: LabelRow | undefined;
  current: CurrentTarget | null;
  /** 現在位置の詳細（まだ読めていなければ `null`）。 */
  details: TargetDetails | null;
  /** アイテムの提供元（アイテムの位置のとき）。 */
  provider: string | null;
  /** 設定 `core.classification.multiple`。 */
  multiple: boolean;
}

/** 数字キー（1〜9）に割り当てたラベル。 */
export function labelForKey(
  labels: readonly LabelRow[],
  key: number,
): LabelRow | undefined {
  return labels.find((l) => l.hotkey === key);
}

/** `applies_to` が、この位置に分類を付けることを許すか。省略したキーは制限なし。 */
function allowsClassification(
  label: LabelRow,
  mediaType: string | null,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(label.applies_to_json);
  } catch {
    return true;
  }
  if (typeof parsed !== "object" || parsed === null) return true;
  const rule = parsed as { classification?: unknown; mediaTypes?: unknown };
  if (rule.classification === false) return false;
  if (Array.isArray(rule.mediaTypes)) {
    return mediaType !== null && rule.mediaTypes.includes(mediaType);
  }
  return true;
}

export function classify(input: ClassifyInput): ClassifyResult {
  const { label, current, details, provider, multiple } = input;
  if (current === null || details === null) {
    return { kind: "refuse", reason: "noCurrent" };
  }
  if (label === undefined) return { kind: "refuse", reason: "noLabel" };
  if (label.hidden) return { kind: "refuse", reason: "hidden" };
  if (!allowsClassification(label, current.mediaType)) {
    return { kind: "refuse", reason: "notAllowed" };
  }

  const already = details.classification.filter((c) => c.label_id === label.id);
  if (already.length > 0) {
    return {
      kind: "apply",
      command: single(
        already.map((c) => ({ kind: "delete_annotation", id: c.id })),
      ),
    };
  }

  let target: CreateTarget = { asset_id: current.assetId, item: null };
  if (current.itemKey !== null) {
    if (provider === null) return { kind: "refuse", reason: "noProvider" };
    target = {
      asset_id: current.assetId,
      item: {
        asset_id: current.assetId,
        item_key: current.itemKey,
        provider,
      },
    };
  }
  const create: Command = {
    kind: "create_annotation",
    target,
    type: "core/classification",
    selector_json: "{}",
    label_id: label.id,
  };
  // 単一: 付いている別のラベルを外して付け替える（1 つの元に戻せる操作）。
  const removals: Command[] = multiple
    ? []
    : details.classification.map((c) => ({
        kind: "delete_annotation",
        id: c.id,
      }));
  return { kind: "apply", command: single([...removals, create]) };
}

function single(commands: Command[]): Command {
  const [first] = commands;
  return commands.length === 1 && first !== undefined
    ? first
    : { kind: "transaction", commands };
}
