import { createSignal, For, Show } from "solid-js";
import type { MessageKey } from "../../i18n";
import { format } from "../../i18n";
import { appearance } from "../appearance";
import { formatKey } from "../keys/chord";
import {
  commands,
  keymap,
  notify,
  platform,
  saveUiSetting,
  setUserKeybindings,
  userKeybindings,
} from "../services";
import { fromStore, useLanguage, useT } from "../solid";
import { resolveTitle } from "../title";
import { Dialog } from "./Dialog";

/** 設定。この機能では、キー割り当て（衝突の表示と keybindings.json の編集）を持つ。 */
export default function SettingsPage(props: { onClose: () => void }) {
  const t = useT();
  const language = useLanguage();
  const version = fromStore(
    () => keymap.all().length + keymap.conflicts().length,
    keymap.subscribe,
  );
  const conflicts = () => {
    version();
    return keymap.conflicts();
  };
  const rows = () => {
    version();
    return keymap.all();
  };
  const titleOf = (id: string) => {
    const spec = commands.get(id);
    return spec ? resolveTitle(spec.title, language()) : id;
  };

  const [text, setText] = createSignal(
    JSON.stringify(userKeybindings(), null, 2),
  );
  const [error, setError] = createSignal(false);

  function save(): void {
    try {
      const parsed: unknown = JSON.parse(text());
      if (!Array.isArray(parsed)) throw new Error("not an array");
      setError(false);
      setUserKeybindings(parsed);
      saveUiSetting("ui.keybindings", parsed);
      keymap.setLayer("user", "user", parsed);
      notify("info", t("settings.keys.saved"));
    } catch {
      setError(true);
    }
  }

  return (
    <Dialog title={t("settings.title")} onClose={props.onClose} wide>
      <h3>{t("settings.appearance")}</h3>
      <div class="settings-row">
        <label class="field">
          <span>{t("settings.theme")}</span>
          <select
            class="palette-input"
            value={appearance.current().theme}
            onChange={(event) =>
              appearance.setTheme(
                event.currentTarget.value as "system" | "light" | "dark",
              )
            }
          >
            <For each={["system", "light", "dark"]}>
              {(value) => (
                <option value={value}>
                  {t(`choice.${value}` as MessageKey)}
                </option>
              )}
            </For>
          </select>
        </label>
        <label class="field">
          <span>{t("settings.language")}</span>
          <select
            class="palette-input"
            value={appearance.current().language}
            onChange={(event) =>
              appearance.setLanguage(
                event.currentTarget.value as "system" | "ja" | "en",
              )
            }
          >
            <For each={["system", "ja", "en"]}>
              {(value) => (
                <option value={value}>
                  {t(`choice.${value}` as MessageKey)}
                </option>
              )}
            </For>
          </select>
        </label>
      </div>
      <h3>{t("settings.keys.title")}</h3>
      <h4>{t("settings.keys.conflicts")}</h4>
      <Show
        when={conflicts().length > 0}
        fallback={<p>{t("settings.keys.none")}</p>}
      >
        <ul class="settings-conflicts">
          <For each={conflicts()}>
            {(conflict) => (
              <li>
                {conflict.kind === "conflict"
                  ? format(t("settings.keys.conflict"), {
                      key: formatKey(conflict.chord, platform),
                      commands: conflict.bindings
                        .map((b) => titleOf(b.command))
                        .join(", "),
                    })
                  : format(t("settings.keys.overridden"), {
                      key: formatKey(conflict.chord, platform),
                      winner: titleOf(conflict.winner.command),
                      shadowed: conflict.shadowed
                        .map((b) => titleOf(b.command))
                        .join(", "),
                    })}
              </li>
            )}
          </For>
        </ul>
      </Show>
      <h4>{t("settings.keys.editor")}</h4>
      <p class="settings-help">{t("settings.keys.help")}</p>
      <textarea
        class="settings-editor"
        rows="8"
        spellcheck={false}
        aria-label={t("settings.keys.editor")}
        value={text()}
        onInput={(event) => setText(event.currentTarget.value)}
      />
      <Show when={error()}>
        <p class="settings-error" role="alert">
          <span aria-hidden="true">⚠ </span>
          {t("settings.keys.invalid")}
        </p>
      </Show>
      <button type="button" class="button" onClick={save}>
        {t("settings.keys.save")}
      </button>
      <h4>{t("settings.keys.list")}</h4>
      <table class="settings-table">
        <tbody>
          <For each={rows()}>
            {(binding) => (
              <tr>
                <td>{titleOf(binding.command)}</td>
                <td>
                  <kbd class="palette-key">
                    {formatKey(binding.chord, platform)}
                  </kbd>
                </td>
                <td class="settings-when">{binding.when ?? ""}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </Dialog>
  );
}
