import { createSignal, For, Show } from "solid-js";
import type { MessageKey } from "../../i18n";
import { format } from "../../i18n";
import { appearance } from "../appearance";
import { Icon } from "../Icon";
import { formatKey } from "../keys/chord";
import {
  commands,
  keymap,
  notify,
  platform,
  saveUiSetting,
  settingsPages,
  setUserKeybindings,
  userKeybindings,
} from "../services";
import { fromStore, useLanguage, useT } from "../solid";
import { resolveTitle } from "../title";
import { Dialog } from "./Dialog";

/** 外観（テーマ・言語）。 */
function AppearancePage() {
  const t = useT();
  return (
    <>
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
    </>
  );
}

/** キー割り当て（衝突の表示と keybindings.json の編集）。 */
function KeysPage() {
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
    <>
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
      <button type="button" class="button primary" onClick={save}>
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
    </>
  );
}

// コアのページ。後続の機能は、`settingsPages.addPage` で、カテゴリの下にページを足す。
settingsPages.addCategory({
  id: "general",
  title: { key: "settings.category.general" },
  order: 10,
  source: "core",
});
settingsPages.addPage({
  id: "appearance",
  category: "general",
  title: { key: "settings.appearance" },
  order: 10,
  render: () => <AppearancePage />,
  source: "core",
});
settingsPages.addPage({
  id: "keys",
  category: "general",
  title: { key: "settings.keys.title" },
  order: 20,
  render: () => <KeysPage />,
  source: "core",
});

/** 設定。左に、カテゴリごとの目次（ツリー）、右に、選んだページ。 */
export default function SettingsPage(props: { onClose: () => void }) {
  const t = useT();
  const language = useLanguage();
  const tree = fromStore(() => settingsPages.tree(), settingsPages.subscribe);
  const [selected, setSelected] = createSignal("appearance");
  const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({});
  const page = () => settingsPages.find(selected());

  return (
    <Dialog title={t("settings.title")} onClose={props.onClose} wide>
      <div class="settings-layout">
        <nav class="settings-tree" aria-label={t("settings.title")}>
          <For each={tree()}>
            {(category) => (
              <div class="settings-category">
                <button
                  type="button"
                  class="settings-category-title"
                  aria-expanded={!collapsed()[category.id]}
                  onClick={() =>
                    setCollapsed({
                      ...collapsed(),
                      [category.id]: !collapsed()[category.id],
                    })
                  }
                >
                  <Icon
                    name={
                      collapsed()[category.id]
                        ? "$(chevron-right)"
                        : "$(chevron-down)"
                    }
                    size={12}
                  />
                  {resolveTitle(category.title, language())}
                </button>
                <Show when={!collapsed()[category.id]}>
                  <For each={category.pages}>
                    {(item) => (
                      <button
                        type="button"
                        class="settings-page-link"
                        aria-current={
                          selected() === item.id ? "page" : undefined
                        }
                        onClick={() => setSelected(item.id)}
                      >
                        {resolveTitle(item.title, language())}
                      </button>
                    )}
                  </For>
                </Show>
              </div>
            )}
          </For>
        </nav>
        <div class="settings-content">
          <Show when={page()}>
            {(current) => (
              <>
                <h3>{resolveTitle(current().title, language())}</h3>
                {current().render()}
              </>
            )}
          </Show>
        </div>
      </div>
    </Dialog>
  );
}
