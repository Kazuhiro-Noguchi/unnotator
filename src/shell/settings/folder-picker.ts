// プロジェクトを開く・保存するなどの操作と、最近使ったプロジェクト（research.md R12・R15）。
// 画面の部品や IPC には依存せず、必要なものは deps で受ける（テストで差し替える）。
import { format, t } from "../../i18n";
import type { NotifyLevel } from "../types";
import { RECENT_PROJECTS_MAX } from "./ui-settings";

/** フォルダを選ぶ入口。既定の実装はパスを入力する簡易のダイアログ（部品側）で、OS 標準に差し替えられる。 */
export interface FolderPicker {
  pick(options: { title: string }): Promise<string | null>;
}

/** 新しいものを先頭にして、重複を除き、最大件数に収める。 */
export function addRecent(list: string[], folder: string): string[] {
  if (folder === "") return list;
  return [folder, ...list.filter((item) => item !== folder)].slice(
    0,
    RECENT_PROJECTS_MAX,
  );
}

export function removeRecent(list: string[], folder: string): string[] {
  return list.filter((item) => item !== folder);
}

export type OpenOutcome = { kind: "opened" } | { kind: "recovery_available" };

export interface ProjectActionsDeps {
  pick: (purpose: "open" | "new") => Promise<string | null>;
  open: (folder: string, create: boolean) => Promise<OpenOutcome>;
  /** 前回の作業用データが残っているときの復元（データを失わないほうを既定にする）。 */
  restore: () => Promise<void>;
  close: () => Promise<void>;
  save: () => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  getRecents: () => string[];
  setRecents: (list: string[]) => void;
  isOpen: () => boolean;
  isDirty: () => boolean;
  onOpened: (folder: string) => void | Promise<void>;
  notify: (level: NotifyLevel, text: string) => void;
}

export function createProjectActions(deps: ProjectActionsDeps) {
  async function openAt(folder: string, create: boolean): Promise<void> {
    const path = folder.trim();
    if (path === "") {
      deps.notify("error", t("project.pathEmpty"));
      return;
    }
    if (deps.isOpen()) {
      if (deps.isDirty()) {
        deps.notify("warn", t("project.dirtyWarning"));
        return;
      }
      try {
        await deps.close();
      } catch (error) {
        deps.notify(
          "error",
          format(t("project.closeFailed"), { reason: reasonOf(error) }),
        );
        return;
      }
    }
    try {
      const outcome = await deps.open(path, create);
      if (outcome.kind === "recovery_available") {
        await deps.restore();
        deps.notify("info", t("project.recoveryRestored"));
      }
    } catch (error) {
      deps.setRecents(removeRecent(deps.getRecents(), path));
      deps.notify(
        "error",
        format(t("project.openFailed"), { path, reason: reasonOf(error) }),
      );
      return;
    }
    deps.setRecents(addRecent(deps.getRecents(), path));
    await deps.onOpened(path);
  }

  async function guarded(
    action: () => Promise<void>,
    failure: "project.saveFailed" | "project.undoFailed" | "project.redoFailed",
  ) {
    try {
      await action();
    } catch (error) {
      deps.notify("error", format(t(failure), { reason: reasonOf(error) }));
    }
  }

  return {
    async openFolder(): Promise<void> {
      const picked = await deps.pick("open");
      if (picked === null) return;
      await openAt(picked, false);
    },
    async createNew(): Promise<void> {
      const picked = await deps.pick("new");
      if (picked === null) return;
      await openAt(picked, true);
    },
    openRecent: (folder: string): Promise<void> => openAt(folder, false),
    save: () => guarded(deps.save, "project.saveFailed"),
    undo: () => guarded(deps.undo, "project.undoFailed"),
    redo: () => guarded(deps.redo, "project.redoFailed"),
  };
}

export type ProjectActions = ReturnType<typeof createProjectActions>;

function reasonOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
