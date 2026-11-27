import type { MessageKey } from "../../i18n";
import { ExplorerView } from "../explorer/ExplorerView";
import { LabelsHost } from "../labels/LabelsHost";
import { PropertiesHost } from "../properties/PropertiesHost";
import { useT } from "../solid";
import { EmptyState } from "./EmptyState";
import { ProblemsView } from "./ProblemsView";
import { CORE_VIEWS, type ViewRegistry } from "./views";

export interface ProjectEntryActions {
  createNew: () => void;
  openFolder: () => void;
}

function CoreEmpty(props: {
  message: MessageKey;
  entry?: ProjectEntryActions | undefined;
}) {
  const t = useT();
  return (
    <EmptyState
      message={t(props.message)}
      actions={
        props.entry
          ? [
              { label: t("empty.newProject"), run: props.entry.createNew },
              { label: t("empty.openProject"), run: props.entry.openFolder },
            ]
          : undefined
      }
    />
  );
}

/** コアのビューを登録する。中身が無い間は、空の状態の案内を出す。 */
export function registerCoreViews(
  views: ViewRegistry,
  entry: ProjectEntryActions,
): void {
  for (const meta of CORE_VIEWS) {
    views.register({
      id: meta.id,
      title: { key: meta.title },
      icon: meta.icon,
      location: meta.location,
      source: "core",
      render: () =>
        meta.id === "problems" ? (
          <ProblemsView />
        ) : meta.id === "explorer" ? (
          <ExplorerView
            fallback={<CoreEmpty message={meta.empty} entry={entry} />}
          />
        ) : meta.id === "labels" ? (
          <LabelsHost fallback={<CoreEmpty message={meta.empty} />} />
        ) : meta.id === "info" ? (
          <PropertiesHost fallback={<CoreEmpty message={meta.empty} />} />
        ) : (
          <CoreEmpty message={meta.empty} />
        ),
    });
  }
}
