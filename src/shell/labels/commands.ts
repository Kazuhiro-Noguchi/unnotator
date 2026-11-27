// ショートカットキーのコマンド `core.label.pick1`〜`pick9`: 現在位置に分類ラベルを付ける・外す（006 の空の処理を置き換える）。
import { format, t } from "../../i18n";
import type { CommandRegistry } from "../commands/registry";
import type { CurrentTarget } from "../explorer/types";
import type { ProjectData } from "../project-data/store";
import type { Disposable, NotifyLevel } from "../types";
import { type ClassifyRefusal, classify, labelForKey } from "./classify";

export interface LabelCommandDeps {
  commands: Pick<CommandRegistry, "provide">;
  data: Pick<ProjectData, "labels" | "details" | "apply">;
  current: { get(): CurrentTarget | null };
  /** 設定 `core.classification.multiple`。 */
  multiple(): Promise<boolean>;
  /** アイテムの提供元（アイテムの位置のとき）。分からなければ `null`。 */
  providerOf(mediaType: string | null): string | null;
  notify(level: NotifyLevel, text: string): void;
}

const REFUSAL: Record<
  Exclude<ClassifyRefusal, "noCurrent" | "noLabel">,
  Parameters<typeof t>[0]
> = {
  hidden: "labels.pick.hidden",
  notAllowed: "labels.pick.notAllowed",
  noProvider: "labels.pick.notAllowed",
};

export function provideLabelHandlers(deps: LabelCommandDeps): Disposable {
  const handles: Disposable[] = [];
  for (let key = 1; key <= 9; key++) {
    handles.push(
      deps.commands.provide(`core.label.pick${key}`, () => pick(deps, key)),
    );
  }
  return {
    dispose() {
      for (const handle of handles) handle.dispose();
    },
  };
}

async function pick(deps: LabelCommandDeps, key: number): Promise<void> {
  const current = deps.current.get();
  // 現在位置が無いときは、何もしない（知らせもしない）。
  if (current === null) return;
  const result = classify({
    label: labelForKey(deps.data.labels(), key),
    current,
    details: deps.data.details(),
    provider: deps.providerOf(current.mediaType),
    multiple: await deps.multiple(),
  });
  if (result.kind === "refuse") {
    if (result.reason === "noCurrent") return;
    deps.notify(
      "warn",
      result.reason === "noLabel"
        ? format(t("labels.pick.none"), { key: String(key) })
        : t(REFUSAL[result.reason]),
    );
    return;
  }
  try {
    await deps.data.apply(result.command);
  } catch (e) {
    deps.notify(
      "error",
      format(t("labels.pick.failed"), {
        reason: e instanceof Error ? e.message : String(e),
      }),
    );
  }
}
