// 拡張機能の contributes を、シェルの各登録簿（コマンド・キー・リボン）へ振り分ける。
// 呼ぶのは 009（拡張機能ホスト）。コマンドの処理は、拡張機能が有効になったときに 009 が `provide` で結ぶ。
import type { CommandRegistry } from "./commands/registry";
import type { Keymap } from "./keys/keymap";
import type { ContributesRibbon } from "./ribbon/contributions";
import type { RibbonModel } from "./ribbon/model";
import type { CommandSpec, Context, RawKeybinding, Title } from "./types";

export interface ContributedCommand {
  id: string;
  title: string | Title;
  category?: string | Title;
  icon?: string;
  enablement?: string;
}

export interface Contributes {
  commands?: ContributedCommand[];
  keybindings?: RawKeybinding[];
  ribbon?: ContributesRibbon;
}

export interface ContributionTargets {
  ctx: Context;
  commands: CommandRegistry;
  keymap: Keymap;
  ribbon: RibbonModel;
  /** ステータスバー。拡張機能が出した項目を、無効化のときに外す。 */
  status?: { removeSource(source: string): void };
}

const asTitle = (title: string | Title): Title =>
  typeof title === "string" ? { ja: title, en: title } : title;

const fullId = (source: string, id: string) =>
  id.includes("/") ? id : `${source}/${id}`;

/** 同じ追加元の前の寄与を外してから、新しい寄与を登録する。 */
export function applyContributions(
  targets: ContributionTargets,
  source: string,
  contributes: Contributes,
): void {
  removeContributions(targets, source);

  for (const command of contributes.commands ?? []) {
    if (typeof command !== "object" || command === null || !command.id)
      continue;
    const spec: CommandSpec = {
      id: fullId(source, command.id),
      title: asTitle(command.title),
      source,
    };
    if (command.category !== undefined)
      spec.category = asTitle(command.category);
    if (command.icon !== undefined) spec.icon = command.icon;
    if (command.enablement !== undefined) spec.enablement = command.enablement;
    targets.commands.declare(spec);
  }

  if (contributes.keybindings) {
    targets.keymap.setLayer("extension", source, contributes.keybindings);
  }
  if (contributes.ribbon) {
    targets.ribbon.addContribution(source, contributes.ribbon);
  }
}

/** 拡張機能を無効にしたとき: その追加元の寄与とコンテキストを、すべて外す。 */
export function removeContributions(
  targets: ContributionTargets,
  source: string,
): void {
  targets.commands.unregister(source);
  targets.keymap.setLayer("extension", source, []);
  targets.ribbon.removeSource(source);
  targets.status?.removeSource(source);
  targets.ctx.remove(source);
}
