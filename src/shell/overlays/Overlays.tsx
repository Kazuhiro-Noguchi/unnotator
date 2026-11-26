import { createSignal, lazy, Show, Suspense } from "solid-js";
import { format } from "../../i18n";
import { commands } from "../../ipc";
import { useT } from "../solid";
import {
  aboutOpen,
  backstageOpen,
  folderRequest,
  paletteOpen,
  setAboutOpen,
  setBackstageOpen,
  setPaletteOpen,
  setSettingsOpen,
  settingsOpen,
} from "../ui-state";
import { Dialog } from "./Dialog";

const Palette = lazy(() => import("./Palette"));
const SettingsPage = lazy(() => import("./SettingsPage"));
const Backstage = lazy(() => import("./Backstage"));

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
        <Show when={settingsOpen()}>
          <SettingsPage onClose={() => setSettingsOpen(false)} />
        </Show>
      </Suspense>
      <Show when={aboutOpen()}>
        <AboutDialog />
      </Show>
      <FolderDialog />
    </>
  );
}
