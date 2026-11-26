// コマンドの登録簿。リボン・クイックアクセス・キー・パレットは、すべて `execute` を通る。
import { format, t } from "../../i18n";
import type {
  CommandAvailability,
  CommandSpec,
  Context,
  Disposable,
  ExecuteResult,
  NotifyLevel,
  ProblemSink,
} from "../types";
import { createWhen } from "../when/parse";

export interface RegistryDeps {
  ctx: Context;
  report: ProblemSink;
  notify: (level: NotifyLevel, text: string) => void;
}

export type CommandRegistry = ReturnType<typeof createCommandRegistry>;

const VERSION_KEY = "$commands.version";

export function createCommandRegistry({ ctx, report, notify }: RegistryDeps) {
  const specs = new Map<string, CommandSpec>();
  const conditions = new Map<string, () => boolean>();
  let version = 0;

  const bump = () => ctx.set(VERSION_KEY, ++version);

  function availability(id: string): () => CommandAvailability {
    return () => {
      ctx.get(VERSION_KEY); // 登録の変化を追跡する
      const spec = specs.get(id);
      if (!spec) return { enabled: false, reason: "unknown" };
      if (!spec.run) return { enabled: false, reason: "unprovided" };
      if (conditions.get(id)?.() === false) {
        return { enabled: false, reason: "condition" };
      }
      return { enabled: true };
    };
  }

  return {
    declare(spec: CommandSpec): void {
      if (specs.has(spec.id)) {
        report({
          code: "command.duplicate",
          source: spec.source,
          message: `コマンド ID が重複している: ${spec.id}`,
        });
        return;
      }
      specs.set(spec.id, { ...spec });
      conditions.set(
        spec.id,
        createWhen(spec.enablement, ctx, report, spec.source),
      );
      bump();
    },

    provide(id: string, run: NonNullable<CommandSpec["run"]>): Disposable {
      const spec = specs.get(id);
      if (!spec) {
        report({
          code: "command.unknown",
          source: "core",
          message: `未登録のコマンドに処理を結ぼうとした: ${id}`,
        });
        return { dispose() {} };
      }
      const previous = spec.run;
      spec.run = run;
      bump();
      return {
        dispose() {
          if (spec.run === run) {
            if (previous) spec.run = previous;
            else delete spec.run;
            bump();
          }
        },
      };
    },

    unregister(source: string): void {
      let changed = false;
      for (const [id, spec] of specs) {
        if (spec.source === source) {
          specs.delete(id);
          conditions.delete(id);
          changed = true;
        }
      }
      if (changed) bump();
    },

    get: (id: string): CommandSpec | undefined => specs.get(id),
    list: (): CommandSpec[] => [...specs.values()],
    availability,

    async execute(id: string, args?: unknown): Promise<ExecuteResult> {
      const spec = specs.get(id);
      if (!spec) {
        report({
          code: "command.unknown",
          source: "core",
          message: `未登録のコマンドを実行しようとした: ${id}`,
        });
        return { ok: false, reason: "unknown" };
      }
      const state = availability(id)();
      if (!state.enabled) return { ok: false, reason: state.reason };
      try {
        const value = await spec.run?.(args);
        return { ok: true, value };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        report({
          code: "command.failed",
          source: spec.source,
          message: `コマンドの実行に失敗した: ${id}`,
          detail,
        });
        notify("error", format(t("commands.failed"), { id }));
        return { ok: false, reason: "failed" };
      }
    },
  };
}
