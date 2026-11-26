// リボンのモデル: コアの定義 + `when` の評価 + コマンドの状態への追従（拡張機能の寄与は US5 で足す）。
import type { CommandRegistry } from "../commands/registry";
import type {
  CommandAvailability,
  Context,
  Disposable,
  ProblemSink,
  RibbonControl,
  RibbonGroup,
  RibbonTab,
} from "../types";
import { createWhen } from "../when/parse";
import {
  type ContributesRibbon,
  type ContributionEntry,
  mergeRibbon,
} from "./contributions";

export interface ControlState {
  enabled: boolean;
  reason?: Extract<CommandAvailability, { enabled: false }>["reason"];
  checked: boolean;
}

export interface RibbonModelDeps {
  core: RibbonTab[];
  ctx: Context;
  commands: CommandRegistry;
  report: ProblemSink;
}

export const RIBBON_VERSION_KEY = "$ribbon.version";

export function createRibbonModel({
  core,
  ctx,
  commands,
  report,
}: RibbonModelDeps) {
  const entries: ContributionEntry[] = [];
  const reportedMissing = new Set<string>();
  let merged: RibbonTab[] | null = null;
  const whens = new Map<string, () => boolean>();
  const reportedUnknown = new Set<string>();
  let version = 0;

  function invalidate(): void {
    merged = null;
    reportedMissing.clear();
    ctx.set(RIBBON_VERSION_KEY, ++version);
  }

  function when(source: string | undefined, owner: string): boolean {
    if (source === undefined || source.trim() === "") return true;
    const key = `${owner}\u0000${source}`;
    let fn = whens.get(key);
    if (!fn) {
      fn = createWhen(source, ctx, report, owner);
      whens.set(key, fn);
    }
    return fn();
  }

  function checkCommand(control: RibbonControl, owner: string): void {
    if (control.command && !commands.get(control.command)) {
      if (!reportedUnknown.has(control.command)) {
        reportedUnknown.add(control.command);
        report({
          code: "command.unknown",
          source: owner,
          message: `リボンが未登録のコマンドを指している: ${control.command}`,
        });
      }
    }
  }

  function visibleControls(
    controls: RibbonControl[],
    owner: string,
  ): RibbonControl[] {
    return controls
      .filter((control) => when(control.when, owner))
      .map((control) => {
        checkCommand(control, owner);
        return control.items
          ? { ...control, items: visibleControls(control.items, owner) }
          : control;
      });
  }

  function visibleGroup(group: RibbonGroup): RibbonGroup | null {
    if (!when(group.when, group.source)) return null;
    const controls = visibleControls(group.controls, group.source);
    // 見えるコントロールが無いグループは、出さない（中身が足されたら現れる）。
    return controls.length === 0 ? null : { ...group, controls };
  }

  return {
    /** いま見えるタブ（`when` が真のもの）。`order` の順で、同じなら宣言順。 */
    tabs(): RibbonTab[] {
      ctx.get(RIBBON_VERSION_KEY);
      merged ??= mergeRibbon(core, entries, report, reportedMissing);
      return (
        merged
          .map((tab, index) => ({ tab, index }))
          .sort((a, b) => a.tab.order - b.tab.order || a.index - b.index)
          .map(({ tab }) => tab)
          .filter((tab) => when(tab.when, tab.source))
          .map((tab) => ({
            ...tab,
            groups: tab.groups.flatMap((g) => {
              const visible = visibleGroup(g);
              return visible ? [visible] : [];
            }),
            hadGroups: tab.groups.length > 0,
          }))
          // グループを持つのに、見えるグループが 1 つも無いタブは、出さない（足されたら現れる）。
          .filter((tab) => !tab.hadGroups || tab.groups.length > 0)
          .map(({ hadGroups: _hadGroups, ...tab }) => tab)
      );
    },

    controlState(control: RibbonControl): ControlState {
      const checked = control.checked ? when(control.checked, "core") : false;
      if (!control.command) return { enabled: true, checked };
      const state = commands.availability(control.command)();
      return state.enabled
        ? { enabled: true, checked }
        : { enabled: false, reason: state.reason, checked };
    },

    run(control: RibbonControl): Promise<unknown> {
      if (!control.command) return Promise.resolve(null);
      return commands.execute(control.command, control.args);
    },

    /** 拡張機能の寄与（contributes.ribbon）を足す。Disposable で外れる。 */
    addContribution(source: string, ribbon: ContributesRibbon): Disposable {
      const entry: ContributionEntry = { source, ribbon };
      entries.push(entry);
      invalidate();
      return {
        dispose() {
          const at = entries.indexOf(entry);
          if (at >= 0) {
            entries.splice(at, 1);
            invalidate();
          }
        },
      };
    },

    /** ある追加元の寄与を、すべて外す。 */
    removeSource(source: string): void {
      let changed = false;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]?.source === source) {
          entries.splice(i, 1);
          changed = true;
        }
      }
      if (changed) invalidate();
    },
  };
}

export type RibbonModel = ReturnType<typeof createRibbonModel>;
