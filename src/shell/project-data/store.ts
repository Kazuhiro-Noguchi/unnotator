// プロジェクトのデータ（ラベル・属性スキーマ・現在位置の詳細）の読み取りキャッシュ。
// 変更は `ChangeSet` で知り、必要な範囲だけ読み直す（specs/008-properties-labels/research.md R2）。
import type { CurrentTarget } from "../explorer/types";
import type {
  AnnotationCursor,
  AnnotationPage,
  AttributeScope,
  ChangeSet,
  Command,
  LabelRow,
  LabelUsage,
  SchemaRow,
  TargetDetails,
} from "./types";

/** IPC の出入口（`src/ipc/` につなぐのは `instance.ts`）。 */
export interface ProjectDataIpc {
  labelsList(): Promise<LabelRow[]>;
  schemasList(): Promise<SchemaRow[]>;
  targetDetails(
    assetId: string,
    itemKey: string | null,
  ): Promise<TargetDetails>;
  annotationsPage(
    assetId: string,
    itemKey: string | null,
    cursor: AnnotationCursor | null,
  ): Promise<AnnotationPage>;
  /** ラベルを使っているものの件数（削除の前の確認）。 */
  labelUsage(labelId: string): Promise<LabelUsage>;
  /** 属性スキーマを変えるときの、値が入っているものの件数。 */
  attributeUsage(
    scope: AttributeScope,
    target: string,
    names: string[],
  ): Promise<number>;
  /** 書き込みは `apply_command` だけ（憲章 III）。 */
  apply(command: Command): Promise<ChangeSet>;
}

export interface ProjectDataDeps {
  ipc: ProjectDataIpc;
  current: {
    get(): CurrentTarget | null;
    subscribe(listener: () => void): () => void;
  };
  /** プロジェクトの変更（`ChangeSet`）の購読。戻り値で解除する。 */
  onChanged(handler: (set: ChangeSet) => void): () => void;
}

export interface ProjectData {
  labels(): readonly LabelRow[];
  schemas(): readonly SchemaRow[];
  /** 現在位置の詳細。何も開いていない・読めないときは `null`。 */
  details(): TargetDetails | null;
  /** 読み込みの失敗の理由（直近）。成功したら `null`。 */
  error(): string | null;
  subscribe(listener: () => void): () => void;
  /** ラベルとスキーマ（と現在位置の詳細）を読み直す。プロジェクトを開いたとき。 */
  refresh(): Promise<void>;
  /** プロジェクトを閉じたとき。 */
  reset(): void;
  apply(command: Command): Promise<ChangeSet>;
  annotationsPage(cursor: AnnotationCursor | null): Promise<AnnotationPage>;
  attributeUsage(
    scope: AttributeScope,
    target: string,
    names: string[],
  ): Promise<number>;
  labelUsage(labelId: string): Promise<LabelUsage>;
  dispose(): void;
}

export function createProjectData(deps: ProjectDataDeps): ProjectData {
  let labels: readonly LabelRow[] = [];
  let schemas: readonly SchemaRow[] = [];
  let details: TargetDetails | null = null;
  let error: string | null = null;
  let detailsToken = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const message = (e: unknown) =>
    e instanceof Error ? e.message : typeof e === "string" ? e : "error";

  async function loadLabels() {
    try {
      labels = await deps.ipc.labelsList();
      error = null;
    } catch (e) {
      error = message(e);
    }
    notify();
  }

  async function loadSchemas() {
    try {
      schemas = await deps.ipc.schemasList();
      error = null;
    } catch (e) {
      error = message(e);
    }
    notify();
  }

  /** 古い読み込みが、新しい現在位置の結果を上書きしないよう、番号で見分ける。 */
  async function loadDetails() {
    const token = ++detailsToken;
    const target = deps.current.get();
    if (target === null) {
      details = null;
      notify();
      return;
    }
    try {
      const next = await deps.ipc.targetDetails(target.assetId, target.itemKey);
      if (token !== detailsToken) return;
      details = next;
      error = null;
    } catch (e) {
      if (token !== detailsToken) return;
      details = null;
      error = message(e);
    }
    notify();
  }

  const offCurrent = deps.current.subscribe(() => void loadDetails());
  const offChanged = deps.onChanged((set) => {
    const entities = new Set(set.changes.map((c) => c.entity));
    if (entities.has("label")) void loadLabels();
    if (entities.has("attribute_schema")) void loadSchemas();
    const target = deps.current.get();
    if (target !== null && set.asset_ids.includes(target.assetId)) {
      void loadDetails();
    }
  });

  return {
    labels: () => labels,
    schemas: () => schemas,
    details: () => details,
    error: () => error,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async refresh() {
      await Promise.all([loadLabels(), loadSchemas(), loadDetails()]);
    },
    reset() {
      detailsToken += 1;
      labels = [];
      schemas = [];
      details = null;
      error = null;
      notify();
    },
    apply: (command) => deps.ipc.apply(command),
    annotationsPage(cursor) {
      const target = deps.current.get();
      if (target === null) return Promise.resolve({ rows: [], next: null });
      return deps.ipc.annotationsPage(target.assetId, target.itemKey, cursor);
    },
    attributeUsage: (scope, target, names) =>
      deps.ipc.attributeUsage(scope, target, names),
    labelUsage: (labelId) => deps.ipc.labelUsage(labelId),
    dispose() {
      offCurrent();
      offChanged();
      listeners.clear();
    },
  };
}
