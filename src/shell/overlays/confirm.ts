// 拡張機能（`host.ui.confirm`）の確認ダイアログの状態。描くのはホストで、見出しに拡張機能の名前を必ず出す。
import { createSignal } from "solid-js";

export interface ConfirmRequest {
  extId: string;
  /** 表示する名前（登録簿の表示名。無ければ ID）。 */
  name: string;
  message: string;
  okLabel: string | undefined;
  cancelLabel: string | undefined;
  resolve: (ok: boolean) => void;
}

export const [confirmRequest, setConfirmRequest] =
  createSignal<ConfirmRequest | null>(null);

let queue: Promise<unknown> = Promise.resolve();

/** 利用者に確認する。同時に出すのは 1 つで、あとから来たものは順番を待つ。 */
export function askConfirm(
  request: Omit<ConfirmRequest, "resolve">,
): Promise<boolean> {
  const run = queue.then(
    () =>
      new Promise<boolean>((resolve) => {
        setConfirmRequest({
          ...request,
          resolve: (ok) => {
            setConfirmRequest(null);
            resolve(ok);
          },
        });
      }),
  );
  queue = run.catch(() => {});
  return run;
}
