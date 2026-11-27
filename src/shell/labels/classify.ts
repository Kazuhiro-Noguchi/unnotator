// 分類ラベルの付け外し（`core/classification`）。純関数（specs/008-properties-labels/data-model.md の「状態遷移」）。
import type { CurrentTarget } from "../explorer/types";
import type { Command, LabelRow, TargetDetails } from "../project-data/types";

type CreateTarget = Extract<Command, { kind: "create_annotation" }>["target"];

export type ClassifyRefusal =
  | "noCurrent"
  | "noLabel"
  | "hidden"
  | "notAllowed"
  | "noProvider"
  | "needMultiple";

export type ClassifyResult =
  | { kind: "apply"; command: Command }
  | { kind: "refuse"; reason: ClassifyRefusal };

export interface ClassifyInput {
  /** 押されたショートカットキーのラベル。 */
  label: LabelRow | undefined;
  current: CurrentTarget | null;
  /** 現在位置の詳細（まだ読めていなければ `null`）。 */
  details: TargetDetails | null;
  /** アイテムの提供元（アイテムの位置のとき）。 */
  provider: string | null;
  /** 設定 `core.classification.multiple`。 */
  multiple: boolean;
}

/** ショートカットキー（1〜9）に割り当てたラベル。 */
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

export interface ClassifyManyInput extends Omit<ClassifyInput, "label"> {
  /** 選択中のラベル（選んだ順）。 */
  labels: readonly LabelRow[];
}

/**
 * 選択中のラベルを、まとめて、現在位置の分類に付ける・外す。
 * 1 つなら `classify` と同じ。複数のときは、複数の分類を許す設定が要る（`multiple`）。
 * すべて付いていれば、選択中のラベルの分類をすべて外す。付いていないものがあれば、付いていないものを付ける。
 */
export function classifyMany(input: ClassifyManyInput): ClassifyResult {
  const { labels, details, multiple } = input;
  const [first, ...rest] = labels;
  if (first === undefined) return { kind: "refuse", reason: "noLabel" };
  if (rest.length === 0) return classify({ ...input, label: first });
  if (!multiple) return { kind: "refuse", reason: "needMultiple" };
  if (input.current === null || details === null) {
    return { kind: "refuse", reason: "noCurrent" };
  }
  const attached = (label: LabelRow) =>
    details.classification.filter((c) => c.label_id === label.id);
  const missing = labels.filter((l) => attached(l).length === 0);
  const commands: Command[] = [];
  if (missing.length === 0) {
    // すべて付いている: 選択中のラベルの分類を、すべて外す。
    for (const label of labels) {
      for (const row of attached(label)) {
        commands.push({ kind: "delete_annotation", id: row.id });
      }
    }
  } else {
    // 付いていないものを付ける（複数を許すので、付け替えにはならない）。
    for (const label of missing) {
      const result = classify({ ...input, label, multiple: true });
      if (result.kind === "refuse") return result;
      commands.push(result.command);
    }
  }
  return { kind: "apply", command: single(commands) };
}
