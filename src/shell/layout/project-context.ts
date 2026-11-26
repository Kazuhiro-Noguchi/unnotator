// プロジェクトの状態（開いている・未保存・Undo / Redo）を、コンテキストに反映する。
import type { Context } from "../types";

export interface ProjectContextDeps {
  ctx: Context;
  undoState: () => Promise<{ can_undo: boolean; can_redo: boolean }>;
  saveState: () => Promise<{ dirty: boolean }>;
  onStateChanged: (handler: (state: { dirty: boolean }) => void) => () => void;
  onProjectChanged: (handler: () => void) => () => void;
}

export function bindProjectContext(deps: ProjectContextDeps) {
  const { ctx } = deps;
  let open = false;

  async function refreshUndo(): Promise<void> {
    try {
      const undo = await deps.undoState();
      if (!open) return;
      ctx.set("canUndo", undo.can_undo);
      ctx.set("canRedo", undo.can_redo);
    } catch {
      // 状態が読めなくても、画面は止めない。
    }
  }

  const offState = deps.onStateChanged((state) => {
    if (!open) return;
    ctx.set("projectDirty", state.dirty);
    void refreshUndo();
  });
  const offChanged = deps.onProjectChanged(() => {
    if (open) void refreshUndo();
  });

  return {
    async setOpen(value: boolean): Promise<void> {
      open = value;
      ctx.set("projectOpen", value);
      if (!value) {
        ctx.set("projectDirty", false);
        ctx.set("canUndo", false);
        ctx.set("canRedo", false);
        return;
      }
      try {
        const save = await deps.saveState();
        ctx.set("projectDirty", save.dirty);
      } catch {
        // 読めなければ、未保存なしとして扱う。
      }
      await refreshUndo();
    },
    dispose(): void {
      offState();
      offChanged();
    },
  };
}

export const APP_NAME = "unnotator";

/** ウィンドウのタイトル。未保存のときだけ ● が付く。 */
export function titleText(name: string | null, dirty: boolean): string {
  if (!name) return APP_NAME;
  return `${dirty ? "● " : ""}${name} — ${APP_NAME}`;
}

/** フォルダのパスから、最後の名前を取る。 */
export function projectName(folder: string): string {
  const trimmed = folder.replace(/[\\/]+$/, "");
  if (trimmed === "") return folder === "" ? "" : folder;
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? trimmed;
}
