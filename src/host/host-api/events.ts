// 変更の通知（`annotations.onDidChange` ほか）。`ChangeSet`（apply・undo・redo・走査の後）を、
// シェルの購読者と、購読している枠の両方へ配る。権限のない枠へは、その種類の変更を届けない。
import type { ChangeSetDto } from "./ipc";

export interface IdChanges {
  created: string[];
  updated: string[];
  deleted: string[];
}

export interface ChangeEvent {
  label: string;
  cause: "command" | "undo" | "redo" | "restore" | "external";
  annotations: IdChanges;
  relations: IdChanges;
  groups: IdChanges;
  assetIds: string[];
}

const empty = (): IdChanges => ({ created: [], updated: [], deleted: [] });

function causeOf(origin: string): ChangeEvent["cause"] {
  switch (origin) {
    case "apply":
      return "command";
    case "undo":
      return "undo";
    case "redo":
      return "redo";
    default:
      return "external";
  }
}

export function toChangeEvent(set: ChangeSetDto, label = ""): ChangeEvent {
  const annotations = empty();
  const relations = empty();
  const groups = empty();
  const memberGroups = new Set<string>();
  const add = (target: IdChanges, kind: string, id: string) => {
    const list =
      kind === "created"
        ? target.created
        : kind === "deleted"
          ? target.deleted
          : target.updated;
    if (!list.includes(id)) list.push(id);
  };
  for (const change of set.changes) {
    if (change.entity === "annotation")
      add(annotations, change.kind, change.id);
    else if (change.entity === "relation")
      add(relations, change.kind, change.id);
    else if (change.entity === "group") add(groups, change.kind, change.id);
    else if (change.entity === "group_member")
      memberGroups.add(change.id.split("/")[0] ?? "");
  }
  // 所属の変更は、そのグループの更新。作成・削除されたグループは、すでに数えている。
  for (const id of memberGroups) {
    const known =
      groups.created.includes(id) ||
      groups.deleted.includes(id) ||
      groups.updated.includes(id);
    if (id !== "" && !known) groups.updated.push(id);
  }
  return {
    label,
    cause: causeOf(set.origin),
    annotations,
    relations,
    groups,
    assetIds: [...set.asset_ids],
  };
}

const has = (c: IdChanges) =>
  c.created.length + c.updated.length + c.deleted.length > 0;

export interface ChangeBridgeDeps {
  allowed(extId: string, permission: string): Promise<boolean>;
}

export interface ChangeBridge {
  /** シェル側の購読。 */
  subscribe(listener: (event: ChangeEvent) => void): () => void;
  /** 枠への押し込み。`emit(key, value)` は `annotations.change` / `labels.change`。 */
  attach(
    extId: string,
    emit: (key: string, value: unknown) => void,
  ): () => void;
  publish(set: ChangeSetDto): void;
  /** 通し番号に、コマンドの表示名を結ぶ（書き込みの戻りで知る）。 */
  noteLabel(seq: number, label: string): void;
}

export function createChangeBridge(deps: ChangeBridgeDeps): ChangeBridge {
  const shell = new Set<(event: ChangeEvent) => void>();
  const frames = new Map<
    symbol,
    { extId: string; emit: (key: string, value: unknown) => void }
  >();
  const labels = new Map<number, string>();

  return {
    subscribe(listener) {
      shell.add(listener);
      return () => void shell.delete(listener);
    },
    attach(extId, emit) {
      const key = Symbol(extId);
      frames.set(key, { extId, emit });
      return () => void frames.delete(key);
    },
    noteLabel(seq, label) {
      labels.set(seq, label);
      // 古いものから捨てる（通知が来なかった番号が溜まらないように）。
      if (labels.size > 64) {
        const first = labels.keys().next().value;
        if (first !== undefined) labels.delete(first);
      }
    },
    publish(set) {
      const label = labels.get(set.seq) ?? "";
      labels.delete(set.seq);
      const event = toChangeEvent(set, label);
      for (const listener of [...shell]) {
        try {
          listener(event);
        } catch {
          // 購読者の例外は、ほかに影響させない。
        }
      }
      const hasLinks =
        has(event.annotations) || has(event.relations) || has(event.groups);
      const labelChanged = set.changes.some(
        (c) => c.entity === "label" || c.entity === "attribute_schema",
      );
      if (!hasLinks && !labelChanged) return;
      const permitted = new Map<string, Promise<boolean>>();
      const allowed = (extId: string, permission: string) => {
        const key = `${extId}\u0000${permission}`;
        let hit = permitted.get(key);
        if (hit === undefined) {
          hit = deps.allowed(extId, permission).catch(() => false);
          permitted.set(key, hit);
        }
        return hit;
      };
      for (const target of [...frames.values()]) {
        const attached = () => [...frames.values()].includes(target);
        void (async () => {
          try {
            if (hasLinks && (await allowed(target.extId, "annotations.read"))) {
              if (attached()) target.emit("annotations.change", event);
            }
            if (labelChanged && (await allowed(target.extId, "labels.read"))) {
              if (attached()) target.emit("labels.change", null);
            }
          } catch {
            // 枠への押し込みの失敗は、ほかの枠に影響させない。
          }
        })();
      }
    },
  };
}
