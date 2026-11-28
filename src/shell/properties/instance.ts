// プロパティパネルの状態（1 つだけ）。下書き・選択・対応している種別。

import type { CommandRegistry } from "../commands/registry";
import { explorer } from "../explorer/instance";
import { projectData } from "../project-data/instance";
import type { Disposable, NotifyLevel } from "../types";
import { provideEditHandlers } from "./commands";
import { createDraftStore } from "./draft";
import { createSelection } from "./selection";
import type { SuggestionsSource } from "./suggestions-view";

export const drafts = createDraftStore();
export const selection = createSelection();
export const current = explorer.current;
export { projectData };

/**
 * 候補の保管（ホスト側）との受け口。シェルがホストを読み込むと循環するので、ホストの起動時（`host/instance.ts`）が差し込む。
 */
export const suggestionsPort: {
  source: SuggestionsSource | null;
  nameOf: (extId: string) => string;
} = { source: null, nameOf: (id) => id };

/**
 * 対応している（担当の拡張機能がある）アノテーションの種別。拡張機能の実行は 009 で結ぶので、それまでは空。
 * 空のあいだは、`core/` 以外の種別がすべて「未対応」になる（憲章 IV: データは消さない）。
 */
const NO_SUPPORTED_TYPES: ReadonlySet<string> = new Set();
export const supportedTypes = (): ReadonlySet<string> => NO_SUPPORTED_TYPES;

export function provideEditCommands(
  registry: CommandRegistry,
  notify: (level: NotifyLevel, text: string) => void,
): Disposable {
  return provideEditHandlers({
    commands: registry,
    data: projectData,
    selection,
    notify,
  });
}
