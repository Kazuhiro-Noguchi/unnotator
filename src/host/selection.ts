// アノテーションの選択を 1 か所で持つ（FR-024、research.md R2）。
// 持ち主は、008 のプロパティパネルの選択（シェルの `Selection`）。エディター・ビュー・拡張機能の枠は、
// ここを通して同じ選択を見る。枠の写し（mirror）の元は `HostState` の `selection`。
import type { HostState } from "./host-api/state";

/** シェルの選択のうち、ホストが使う部分。 */
export interface SelectionPort {
  ids(): ReadonlySet<string>;
  set(ids: Iterable<string>): void;
  subscribe(listener: () => void): () => void;
}

export interface HostSelectionDeps {
  selection: SelectionPort;
  state: HostState;
  /** いま存在するアノテーションの ID（渡した中から）。 */
  exists(ids: string[]): Promise<ReadonlySet<string>>;
}

export interface HostSelection {
  /** 拡張機能からの `selection.set`。存在しない ID は取り除く。呼ばれた順に反映する。 */
  set(ids: string[]): Promise<void>;
  /** シェルの選択の購読を外す。 */
  dispose(): void;
}

export function createHostSelection(deps: HostSelectionDeps): HostSelection {
  const publish = () => deps.state.set("selection", [...deps.selection.ids()]);
  // シェルの側で選択が変わるたび（プロパティパネル・エディター・消えた ID の除去）に、写しの元へ流す。
  const off = deps.selection.subscribe(publish);
  publish();

  let chain: Promise<void> = Promise.resolve();
  return {
    set(ids) {
      const run = chain.then(async () => {
        const unique = [...new Set(ids)];
        const alive =
          unique.length === 0 ? new Set<string>() : await deps.exists(unique);
        deps.selection.set(unique.filter((id) => alive.has(id)));
        // 選択が変わらなくても必ず送る。枠の楽観の更新が食い違っていたら、ホストの値で上書きされる。
        publish();
      });
      chain = run.catch(() => {});
      return run;
    },
    dispose: off,
  };
}
