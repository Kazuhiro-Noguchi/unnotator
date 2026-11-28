// 拡張機能のマニフェストの `contributes` を、006 のシェルの登録簿へ反映する（FR-011）。
// 拡張機能の有効化の前から宣言だけを入れ、無効・削除で取り除く。
// コマンドの処理は、有効化したときに Host API の `commands.register` が結ぶ。
// それまでの間は、実行時に `onCommand:<id>` を送って有効化を待ち、結ばれた処理へ渡す（遅延有効化）。
// ビュー（views）は US2 の `syncExtensionViews` が扱う。
import {
  applyContributions,
  type Contributes,
  type ContributionTargets,
  removeContributions,
} from "../shell/contributions";
import type { ExtensionInfo } from "./service";

export interface ContributesHost {
  infos(): readonly ExtensionInfo[];
  onDidRefresh(listener: (infos: readonly ExtensionInfo[]) => void): () => void;
  trigger(event: string): Promise<void>;
}

export interface ContributesSyncDeps {
  targets: ContributionTargets;
  host: ContributesHost;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 有効な拡張機能のマニフェストから、シェルへ振り分ける部分を取り出す。読めなければ null。 */
function parseContributes(info: ExtensionInfo): Contributes | null {
  if (info.status !== "enabled" || info.manifest === null) return null;
  try {
    const manifest: unknown = JSON.parse(info.manifest);
    if (!isRecord(manifest) || !isRecord(manifest.contributes)) return null;
    const c = manifest.contributes;
    const result: Contributes = {};
    if (Array.isArray(c.commands))
      result.commands = c.commands as Contributes["commands"] & object;
    if (Array.isArray(c.keybindings))
      result.keybindings = c.keybindings as Contributes["keybindings"] & object;
    if (isRecord(c.ribbon))
      result.ribbon = c.ribbon as NonNullable<Contributes["ribbon"]>;
    return result;
  } catch {
    return null;
  }
}

export function createContributesSync(deps: ContributesSyncDeps) {
  const { targets, host } = deps;
  /** 追加元（拡張機能 ID）→ 反映した内容（変わらない更新で結びを壊さないため）。 */
  const applied = new Map<string, string>();
  let unsubscribe: (() => void) | null = null;

  /** 処理が結ばれていないコマンドに、実行時に有効化してから結ばれた処理へ渡す入口を置く。 */
  function provideLazy(source: string): void {
    for (const spec of targets.commands.list()) {
      if (spec.source !== source || spec.run !== undefined) continue;
      const id = spec.id;
      const local = id.startsWith(`${source}/`)
        ? id.slice(source.length + 1)
        : id;
      const lazy = async (args?: unknown): Promise<unknown> => {
        await host.trigger(`onCommand:${id}`);
        if (local !== id) await host.trigger(`onCommand:${local}`);
        const run = targets.commands.get(id)?.run;
        if (run === undefined || run === lazy)
          throw new Error(`command is not provided: ${id}`);
        return await run(args);
      };
      targets.commands.provide(id, lazy);
    }
  }

  function sync(): void {
    const seen = new Set<string>();
    for (const info of host.infos()) {
      const contributes = parseContributes(info);
      if (contributes === null) continue;
      seen.add(info.id);
      const key = JSON.stringify(contributes);
      if (applied.get(info.id) === key) continue;
      applyContributions(targets, info.id, contributes);
      provideLazy(info.id);
      applied.set(info.id, key);
    }
    for (const source of [...applied.keys()]) {
      if (seen.has(source)) continue;
      removeContributions(targets, source);
      applied.delete(source);
    }
  }

  return {
    sync,
    /** 一覧の更新のたびに反映する。 */
    start(): void {
      unsubscribe?.();
      unsubscribe = host.onDidRefresh(() => sync());
      sync();
    },
    dispose(): void {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
