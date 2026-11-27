// ウィンドウを閉じるときの流れ。正常に終了したときは、作業用データ（自動復元の元）を残さない。
// 復元は異常終了（クラッシュ・強制終了）のときだけ働く。
import { format, t } from "../../i18n";
import type { NotifyLevel } from "../types";

export type CloseDecision = "save" | "discard" | "cancel";

export interface WindowCloseDeps {
  isOpen: () => boolean;
  isDirty: () => boolean;
  /** 未保存の変更があるときの確認。 */
  ask: () => Promise<CloseDecision>;
  /** プロジェクトを閉じる（作業用データも消える）。失敗したら投げる。 */
  closeProject: (action: "save" | "discard" | null) => Promise<void>;
  destroyWindow: () => Promise<void>;
  notify: (level: NotifyLevel, text: string) => void;
}

/** ウィンドウの閉じる要求を処理する。確認の最中に重ねて呼ばれたら、何もしない。 */
export function createWindowCloseHandler(deps: WindowCloseDeps) {
  let busy = false;
  return async function handle(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      if (deps.isOpen()) {
        let action: "save" | "discard" | null = null;
        if (deps.isDirty()) {
          const decision = await deps.ask();
          if (decision === "cancel") return;
          action = decision;
        }
        try {
          await deps.closeProject(action);
        } catch (error) {
          deps.notify(
            "error",
            format(t("project.closeFailed"), { reason: reasonOf(error) }),
          );
          return;
        }
      }
      await deps.destroyWindow();
    } finally {
      busy = false;
    }
  };
}

function reasonOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
