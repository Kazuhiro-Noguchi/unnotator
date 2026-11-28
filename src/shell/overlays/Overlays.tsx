import { createSignal, lazy, Show, Suspense } from "solid-js";
import { format } from "../../i18n";
import { commands } from "../../ipc";
import { StandaloneHost } from "../layout/StandaloneHost";
import { useT } from "../solid";
import {
  aboutOpen,
  backstageOpen,
  closeRequest,
  folderRequest,
  paletteOpen,
  schemaOpen,
  setAboutOpen,
  setBackstageOpen,
  setPaletteOpen,
  setSchemaOpen,
  setSettingsOpen,
  settingsOpen,
} from "../ui-state";
import { ConfirmDialog } from "./ConfirmDialog";
import { ConsentDialog } from "./ConsentDialog";
import { Dialog } from "./Dialog";

const Palette = lazy(() => import("./Palette"));
const SettingsPage = lazy(() => import("./SettingsPage"));
const Backstage = lazy(() => import("./Backstage"));
const SchemaDialog = lazy(() => import("./SchemaDialog"));

function FolderDialog() {
  const t = useT();
  const [path, setPath] = createSignal("");
  return (
    <Show when={folderRequest()}>
      {(request) => (
        <Dialog title={request().title} onClose={() => request().resolve(null)}>
          <label class="field">
            <span>{t("folder.prompt")}</span>
            <input
              class="palette-input"
              type="text"
              value={path()}
              ref={(el) => queueMicrotask(() => el.focus())}
              onInput={(event) => setPath(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.isComposing)
                  request().resolve(path());
              }}
            />
          </label>
          <div class="dialog-actions">
            <button
              type="button"
              class="button primary"
              onClick={() => request().resolve(path())}
            >
              {t("dialog.ok")}
            </button>
            <button
              type="button"
              class="button"
              onClick={() => request().resolve(null)}
            >
              {t("dialog.cancel")}
            </button>
          </div>
        </Dialog>
      )}
    </Show>
  );
}

export function CloseDialog() {
  const t = useT();
  return (
    <Show when={closeRequest()}>
      {(request) => (
        <Dialog
          title={t("close.title")}
          onClose={() => request().resolve("cancel")}
        >
          <p>{t("close.message")}</p>
          <Show when={request().suggestions > 0}>
            <p class="close-suggestions">
              {format(t("close.suggestions"), {
                count: String(request().suggestions),
              })}
            </p>
          </Show>
          <div class="dialog-actions">
            <button
              type="button"
              class="button primary"
              onClick={() => request().resolve("save")}
            >
              {t("close.save")}
            </button>
            <button
              type="button"
              class="button"
              onClick={() => request().resolve("discard")}
            >
              {t("close.discard")}
            </button>
            <button
              type="button"
              class="button"
              onClick={() => request().resolve("cancel")}
            >
              {t("dialog.cancel")}
            </button>
          </div>
        </Dialog>
      )}
    </Show>
  );
}

function AboutDialog() {
  const t = useT();
  const [info, setInfo] = createSignal<{
    name: string;
    version: string;
  } | null>(null);
  void commands
    .appInfo()
    .then(setInfo)
    .catch(() => {});
  return (
    <Dialog title={t("about.title")} onClose={() => setAboutOpen(false)}>
      <p>{info()?.name ?? "unnotator"}</p>
      <p>{format(t("about.version"), { version: info()?.version ?? "" })}</p>
    </Dialog>
  );
}

/** 重ねて出す部品。パレット・設定は、開くときに読み込む（起動を遅くしない）。 */
export function Overlays() {
  return (
    <>
      <Suspense>
        <Show when={paletteOpen()}>
          <Palette onClose={() => setPaletteOpen(false)} />
        </Show>
        <Show when={backstageOpen()}>
          <Backstage onClose={() => setBackstageOpen(false)} />
        </Show>
        <Show when={schemaOpen()}>
          <SchemaDialog onClose={() => setSchemaOpen(false)} />
        </Show>
        <Show when={settingsOpen()}>
          <SettingsPage onClose={() => setSettingsOpen(false)} />
        </Show>
      </Suspense>
      <Show when={aboutOpen()}>
        <AboutDialog />
      </Show>
      <FolderDialog />
      <CloseDialog />
      <ConsentDialog />
      <ConfirmDialog />
      <StandaloneHost />
    </>
  );
}
