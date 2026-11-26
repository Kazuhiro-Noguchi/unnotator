// クイックアクセス（タブの左に常時表示するコマンド）。`ui.quickAccess` に保存する。
import type { CommandRegistry } from "../commands/registry";
import { QUICK_ACCESS_MAX } from "../settings/ui-settings";

export interface QuickAccessDeps {
  initial: string[];
  commands: CommandRegistry;
  save: (ids: string[]) => void;
}

export function createQuickAccess({
  initial,
  commands,
  save,
}: QuickAccessDeps) {
  let list = [...initial];
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  const commit = () => {
    save([...list]);
    emit();
  };

  return {
    ids: (): string[] => [...list],
    /** 登録済みのコマンドだけ。コマンドが無くなっても、配列からは消さない（戻れば復活する）。 */
    visible(): string[] {
      return list.filter(
        (id) =>
          commands.availability(id)().enabled || commands.get(id) !== undefined,
      );
    },
    has: (id: string): boolean => list.includes(id),
    add(id: string): boolean {
      if (list.includes(id) || list.length >= QUICK_ACCESS_MAX) return false;
      list = [...list, id];
      commit();
      return true;
    },
    remove(id: string): void {
      if (!list.includes(id)) return;
      list = list.filter((item) => item !== id);
      commit();
    },
    /** 読み込んだ設定で差し替える（保存はしない）。 */
    setAll(ids: string[]): void {
      list = [...ids];
      emit();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type QuickAccess = ReturnType<typeof createQuickAccess>;
