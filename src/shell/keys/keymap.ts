// キーマップ: 3 層（コア → 拡張機能 → 利用者）・when つき解決・衝突の検出（research.md R5）。
import type {
  Chord,
  Context,
  Disposable,
  Keybinding,
  KeyConflict,
  ProblemSink,
  RawKeybinding,
  Tier,
} from "../types";
import { createWhen } from "../when/parse";
import { chordId, type Platform, parseKey } from "./chord";

const TIER_RANK: Record<Tier, number> = { core: 0, extension: 1, user: 2 };

export interface KeymapDeps {
  ctx: Context;
  report: ProblemSink;
  platform: Platform;
}

interface Entry extends Keybinding {
  when_: () => boolean;
}

function isRaw(value: unknown): value is RawKeybinding {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.key === "string" &&
    v.key.trim() !== "" &&
    typeof v.command === "string" &&
    v.command !== "" &&
    (v.when === undefined || typeof v.when === "string")
  );
}

export function createKeymap({ ctx, report, platform }: KeymapDeps) {
  /** 「層 + 追加元」ごとの割り当て。 */
  const layers = new Map<string, Entry[]>();
  let order = 0;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };

  /** 無効化（-command）を反映した、有効な割り当て。 */
  function active(): Entry[] {
    const all = [...layers.values()].flat();
    const removals = all.filter((e) => e.command.startsWith("-") && e.when_());
    return all.filter((entry) => {
      if (entry.command.startsWith("-")) return false;
      return !removals.some(
        (removal) =>
          TIER_RANK[removal.tier] >= TIER_RANK[entry.tier] &&
          removal.command.slice(1) === entry.command &&
          chordId(removal.chord) === chordId(entry.chord) &&
          removal !== entry,
      );
    });
  }

  function byPriority(a: Keybinding, b: Keybinding): number {
    return TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.order - b.order;
  }

  function conflicts(): KeyConflict[] {
    const groups = new Map<string, Entry[]>();
    for (const entry of active()) {
      const id = `${chordId(entry.chord)}\u0000${entry.when ?? ""}`;
      const list = groups.get(id) ?? [];
      list.push(entry);
      groups.set(id, list);
    }
    const result: KeyConflict[] = [];
    for (const list of groups.values()) {
      const commands = new Set(list.map((e) => e.command));
      if (commands.size < 2) continue;
      const sorted = [...list].sort(byPriority);
      const topTier = sorted[sorted.length - 1]?.tier;
      const top = sorted.filter((e) => e.tier === topTier);
      if (new Set(top.map((e) => e.command)).size > 1) {
        result.push({
          kind: "conflict",
          chord: top[0]?.chord as Chord,
          when: top[0]?.when ?? null,
          bindings: top,
        });
      } else {
        const winner = top[top.length - 1] as Entry;
        const shadowed = sorted.filter(
          (e) => e.tier !== topTier && e.command !== winner.command,
        );
        if (shadowed.length > 0) {
          result.push({
            kind: "overridden",
            chord: winner.chord,
            winner,
            shadowed,
          });
        }
      }
    }
    return result;
  }

  return {
    setLayer(tier: Tier, source: string, raws: unknown[]): Disposable {
      const id = `${tier}\u0000${source}`;
      const entries: Entry[] = [];
      raws.forEach((raw, index) => {
        if (!isRaw(raw)) {
          report({
            code: "keybinding.invalid",
            source,
            message: `キー割り当ての ${index + 1} 番目が正しくない`,
          });
          return;
        }
        const removing = raw.command.startsWith("-");
        const chord = parseKey(raw.key, platform, {
          literalCtrl: tier === "user",
        });
        if (!chord) {
          report({
            code: "keybinding.invalid",
            source,
            message: `キーを解釈できない: ${raw.key}`,
          });
          return;
        }
        const entry: Entry = {
          key: raw.key,
          chord,
          command: raw.command,
          tier,
          source,
          order: order++,
          when_: createWhen(raw.when, ctx, report, source),
        };
        if (raw.args !== undefined) entry.args = raw.args;
        if (raw.when !== undefined) entry.when = raw.when;
        void removing;
        entries.push(entry);
      });
      layers.set(id, entries);
      emit();
      for (const conflict of conflicts()) {
        if (
          conflict.kind === "conflict" &&
          conflict.bindings.some((b) => b.source === source)
        ) {
          report({
            code: "keybinding.conflict",
            source,
            message: `キーが衝突している: ${conflict.bindings[0]?.key ?? ""}`,
            detail: conflict.bindings.map((b) => b.command).join(", "),
          });
        }
      }
      return {
        dispose() {
          if (layers.get(id) === entries) {
            layers.delete(id);
            emit();
          }
        },
      };
    },

    /** キーを押したときに実行するコマンド。無ければ null。 */
    resolve(chord: Chord): { command: string; args?: unknown } | null {
      const id = chordId(chord);
      const candidates = active()
        .filter((e) => chordId(e.chord) === id && e.when_())
        .sort(byPriority);
      const winner = candidates[candidates.length - 1];
      if (!winner) return null;
      return winner.args === undefined
        ? { command: winner.command }
        : { command: winner.command, args: winner.args };
    },

    bindingsFor(commandId: string): Keybinding[] {
      return active()
        .filter((e) => e.command === commandId)
        .sort(byPriority)
        .map(({ when_: _when, ...binding }) => binding);
    },

    /** すべての有効な割り当て（設定画面の一覧用）。 */
    all(): Keybinding[] {
      return active()
        .sort(byPriority)
        .map(({ when_: _when, ...binding }) => binding);
    },

    conflicts,

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type Keymap = ReturnType<typeof createKeymap>;
