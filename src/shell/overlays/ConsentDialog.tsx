import { For, Show } from "solid-js";
import { format, type MessageKey, t as translate } from "../../i18n";
import { useT } from "../solid";
import { consentRequest } from "./consent";
import { Dialog } from "./Dialog";

/** 権限の説明。表にない権限は、名前をそのまま出す（拡張機能が文言を指定することはできない）。 */
function describe(permission: string): string {
  const key = `host.permission.${permission}` as MessageKey;
  try {
    return translate(key) ?? permission;
  } catch {
    return permission;
  }
}

/** 拡張機能が未同意の権限を使おうとしたときの確認。描くのはホストで、文言はホストが決める。 */
export function ConsentDialog() {
  const t = useT();
  return (
    <Show when={consentRequest()}>
      {(request) => (
        <Dialog
          title={t("host.consent.title")}
          onClose={() => request().resolve(false)}
        >
          <p>{format(t("host.consent.body"), { name: request().name })}</p>
          <ul class="consent-list">
            <For each={request().permissions}>
              {(item) => (
                <li classList={{ "consent-warning": item.warning }}>
                  <span>{describe(item.permission)}</span>
                  <Show when={item.warning}>
                    <small>{t("host.consent.warning")}</small>
                  </Show>
                </li>
              )}
            </For>
          </ul>
          <div class="dialog-actions">
            <button
              type="button"
              class="button primary"
              onClick={() => request().resolve(true)}
            >
              {t("host.consent.allow")}
            </button>
            <button
              type="button"
              class="button"
              onClick={() => request().resolve(false)}
            >
              {t("host.consent.deny")}
            </button>
          </div>
        </Dialog>
      )}
    </Show>
  );
}
