import { Show } from "solid-js";
import { format } from "../../i18n";
import { useT } from "../solid";
import { confirmRequest } from "./confirm";
import { Dialog } from "./Dialog";

/** 拡張機能が `host.ui.confirm` で求めた確認。描くのはホストで、見出しは拡張機能の名前つきの固定の文言。 */
export function ConfirmDialog() {
  const t = useT();
  return (
    <Show when={confirmRequest()}>
      {(request) => (
        <Dialog
          title={format(t("host.confirm.title"), { name: request().name })}
          onClose={() => request().resolve(false)}
        >
          <p class="confirm-message">{request().message}</p>
          <div class="dialog-actions">
            <button
              type="button"
              class="button primary"
              onClick={() => request().resolve(true)}
            >
              {request().okLabel ?? t("dialog.ok")}
            </button>
            <button
              type="button"
              class="button"
              onClick={() => request().resolve(false)}
            >
              {request().cancelLabel ?? t("dialog.cancel")}
            </button>
          </div>
        </Dialog>
      )}
    </Show>
  );
}
