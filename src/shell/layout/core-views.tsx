import type { MessageKey } from "../../i18n";
import { useT } from "../solid";
import { EmptyState } from "./EmptyState";
import { ProblemsView } from "./ProblemsView";
import { CORE_VIEWS, type ViewRegistry } from "./views";

function CoreEmpty(props: {
  message: MessageKey;
  onOpenFolder?: (() => void) | undefined;
}) {
  const t = useT();
  return (
    <EmptyState
      message={t(props.message)}
      action={
        props.onOpenFolder
          ? { label: t("empty.openFolder"), run: props.onOpenFolder }
          : undefined
      }
    />
  );
}

/** コアのビューを登録する。中身が無い間は、空の状態の案内を出す。 */
export function registerCoreViews(
  views: ViewRegistry,
  openFolder: () => void,
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
        ) : (
          <CoreEmpty
            message={meta.empty}
            onOpenFolder={meta.id === "explorer" ? openFolder : undefined}
          />
        ),
    });
  }
}
