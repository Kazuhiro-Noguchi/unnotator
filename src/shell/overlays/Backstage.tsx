import { For, Show } from "solid-js";
import { Icon } from "../Icon";
import { commands, ctx, recentProjects } from "../services";
import { fromContext, useLanguage, useT } from "../solid";
import { resolveTitle } from "../title";
import { Dialog } from "./Dialog";

const ENTRIES = [
  "core.project.new",
  "core.project.open",
  "core.project.save",
  "core.project.saveAs",
  "core.project.import",
  "core.project.export",
];

/** ファイルタブ（Backstage）。 */
export default function Backstage(props: { onClose: () => void }) {
  const t = useT();
  const language = useLanguage();
  return (
    <Dialog title={t("backstage.title")} onClose={props.onClose} wide>
      <div class="backstage">
        <div class="backstage-list">
          <For each={ENTRIES}>
            {(id) => {
              const state = fromContext(ctx, () => commands.availability(id)());
              const spec = () => commands.get(id);
              const label = () =>
                spec() ? resolveTitle(spec()?.title ?? {}, language()) : id;
              return (
                <button
                  type="button"
                  class="backstage-entry"
                  disabled={!state().enabled}
                  onClick={() => {
                    props.onClose();
                    void commands.execute(id);
                  }}
                >
                  <Icon name={spec()?.icon} size={18} />
                  <span>{label()}</span>
                </button>
              );
            }}
          </For>
        </div>
        <div class="backstage-recent">
          <h3>{t("backstage.recent")}</h3>
          <Show
            when={recentProjects().length > 0}
            fallback={<p>{t("recent.none")}</p>}
          >
            <For each={recentProjects()}>
              {(path) => (
                <button
                  type="button"
                  class="backstage-entry"
                  title={path}
                  onClick={() => {
                    props.onClose();
                    void commands.execute("core.project.openRecent", path);
                  }}
                >
                  <Icon name="$(recent)" size={16} />
                  <span class="backstage-path">{path}</span>
                </button>
              )}
            </For>
          </Show>
        </div>
      </div>
    </Dialog>
  );
}
