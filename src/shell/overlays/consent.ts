// 権限の確認ダイアログの状態。内容は呼び出し側（ホスト）が決め、拡張機能は指定できない。
import { createSignal } from "solid-js";

export interface ConsentRequest {
  extId: string;
  /** 表示する名前（登録簿の表示名。無ければ ID）。 */
  name: string;
  permissions: { permission: string; warning: boolean }[];
  resolve: (granted: boolean) => void;
}

export const [consentRequest, setConsentRequest] =
  createSignal<ConsentRequest | null>(null);

let queue: Promise<unknown> = Promise.resolve();

/** 利用者に権限を聞く。同時に出すのは 1 つで、あとから来たものは順番を待つ。 */
export function askConsent(
  request: Omit<ConsentRequest, "resolve">,
): Promise<boolean> {
  const run = queue.then(
    () =>
      new Promise<boolean>((resolve) => {
        setConsentRequest({
          ...request,
          resolve: (granted) => {
            setConsentRequest(null);
            resolve(granted);
          },
        });
      }),
  );
  queue = run.catch(() => {});
  return run;
}
