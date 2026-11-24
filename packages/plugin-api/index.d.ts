/**
 * @unnotator/plugin-api v1.0.0
 *
 * 拡張機能（TS/JS モジュール）とコアのシェルの間の契約。
 * 拡張機能は ES Module として読み込まれ、`activate(host)` が呼ばれる。
 *
 * 設計原則
 *  - コアは媒体を知らない。座標・時刻・文字位置などは selector（JSON）の中にだけ現れ、
 *    その形式はアノテーション種別を定義した拡張機能が決める。
 *  - 描画や座標系の API は媒体の拡張機能が `activate()` の戻り値として公開し、
 *    他の拡張機能は `host.extensions.getApi()` で受け取る。
 *  - 書き込みはすべて host の API を通る（Rust コアのコマンドになり Undo・変更履歴に乗る）。
 *  - ID はローカル名で登録し、コアが '<拡張機能 id>/<名前>' に名前空間化する。
 *    他拡張機能・コアの要素を参照するときは完全 ID を使う。
 */

export declare const API_VERSION: '1.0.0';

// ---------------------------------------------------------------------------
// エントリポイント
// ---------------------------------------------------------------------------

/**
 * 拡張機能のエントリ。戻り値（任意）は他の拡張機能へ公開する API になる。
 * 例: 画像拡張機能が `{ registerShapeRenderer, registerTool }` を返す。
 */
export type ActivateFunction = (host: Host) => void | object | Promise<void | object>;
export type DeactivateFunction = () => void | Promise<void>;

export interface ExtensionModule {
  activate: ActivateFunction;
  deactivate?: DeactivateFunction;
}

// ---------------------------------------------------------------------------
// 基本型
// ---------------------------------------------------------------------------

export interface Disposable {
  dispose(): void;
}

/** UUID v7 文字列 */
export type Id = string;
/** '<拡張機能 id>/<名前>' または 'core/<名前>' */
export type QualifiedId = string;
/** JSON で表現できる値 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type WorkStatus = 'todo' | 'in_progress' | 'done' | 'review';

export interface ByteRange {
  /** 開始オフセット（バイト、含む） */
  offset: number;
  /** 読む長さ（バイト）。省略時は末尾まで */
  length?: number;
}

export type Event<T> = (listener: (e: T) => void) => Disposable;

// ---------------------------------------------------------------------------
// アセットとアイテム
// ---------------------------------------------------------------------------

export interface Asset {
  id: Id;
  /** '' = プロジェクトフォルダ。それ以外は settings.json の assets.externalRoots のキー */
  rootKey: string;
  /** ルートからの相対パス（区切り '/'） */
  relPath: string;
  /** 判定できなければ null */
  mediaType: QualifiedId | null;
  fileSize: number;
  mtimeMs: number;
  status: WorkStatus;
  missing: boolean;
  /** 拡張機能 ID ごとに名前空間を切ったメタ情報 */
  metadata: Record<string, JsonObject>;
  attributes: JsonObject;
}

export interface ItemInfo {
  /** 拡張機能が決める安定したキー（例 'page:3', 'frame:120'） */
  key: string;
  /** ツリーに表示する名前 */
  title: string;
  description?: string;
  /** DB に記録済みのアイテムなら状態などが入る */
  status?: WorkStatus;
  hasAnnotations?: boolean;
}

export interface Item {
  id: Id;
  assetId: Id;
  key: string;
  provider: QualifiedId;
  status: WorkStatus;
  metadata: JsonObject;
  attributes: JsonObject;
}

/** アノテーションの対象 */
export interface Target {
  assetId: Id;
  /** アイテム単位のときだけ指定 */
  itemKey?: string;
}

// ---------------------------------------------------------------------------
// アノテーション・関係・グループ・ラベル
// ---------------------------------------------------------------------------

export interface Annotation<S extends JsonValue = JsonValue> {
  id: Id;
  target: Target;
  /** 'core/classification' はアセット / アイテム全体への分類（selector は {}） */
  type: QualifiedId;
  typeVersion: number;
  selector: S;
  labelId: Id | null;
  attributes: JsonObject;
  summary: string;
  zOrder: number;
  source: 'manual' | string;
  createdAt: number;
  updatedAt: number;
}

export interface NewAnnotation<S extends JsonValue = JsonValue> {
  target: Target;
  type: QualifiedId;
  selector: S;
  labelId?: Id | null;
  attributes?: JsonObject;
  zOrder?: number;
}

export interface AnnotationPatch<S extends JsonValue = JsonValue> {
  selector?: S;
  labelId?: Id | null;
  /** 部分更新（指定したキーだけ置き換え、null でキー削除） */
  attributes?: { [key: string]: JsonValue };
  zOrder?: number;
}

export interface AnnotationQuery {
  assetId?: Id;
  itemKey?: string;
  types?: QualifiedId[];
  labelIds?: Id[];
  ids?: Id[];
  limit?: number;
  offset?: number;
}

export interface Relation {
  id: Id;
  type: QualifiedId;
  fromId: Id;
  toId: Id;
  directed: boolean;
  labelId: Id | null;
  attributes: JsonObject;
  source: 'manual' | string;
}

export interface NewRelation {
  type: QualifiedId;
  fromId: Id;
  toId: Id;
  labelId?: Id | null;
  attributes?: JsonObject;
}

export interface RelationQuery {
  annotationIds?: Id[];
  assetId?: Id;
  types?: QualifiedId[];
}

export interface Group {
  id: Id;
  type: QualifiedId;
  ordered: boolean;
  /** ordered のときは position 順 */
  memberIds: Id[];
  labelId: Id | null;
  attributes: JsonObject;
  source: 'manual' | string;
}

export interface NewGroup {
  type: QualifiedId;
  memberIds: Id[];
  labelId?: Id | null;
  attributes?: JsonObject;
}

export interface GroupQuery {
  annotationIds?: Id[];
  assetId?: Id;
  types?: QualifiedId[];
}

export interface Label {
  id: Id;
  name: string;
  displayName: string;
  color: string;
  hotkey: number | null;
  hidden: boolean;
  appliesTo: {
    annotationTypes?: QualifiedId[];
    relationTypes?: QualifiedId[];
    groupTypes?: QualifiedId[];
    mediaTypes?: QualifiedId[];
    classification?: boolean;
  };
}

export interface LabelFilter {
  annotationType?: QualifiedId;
  relationType?: QualifiedId;
  groupType?: QualifiedId;
  mediaType?: QualifiedId;
  classification?: boolean;
  includeHidden?: boolean;
}

export interface ChangeEvent {
  /** 変更が属するコマンドの表示名（Undo 表示と同じ） */
  label: string;
  /** undo / redo による変更か */
  cause: 'command' | 'undo' | 'redo' | 'restore' | 'external';
  annotations: { created: Id[]; updated: Id[]; deleted: Id[] };
  relations: { created: Id[]; updated: Id[]; deleted: Id[] };
  groups: { created: Id[]; updated: Id[]; deleted: Id[] };
  assetIds: Id[];
}

export interface SuggestionResult {
  /** ユーザーが採用した候補から作られたアノテーションの ID */
  accepted: Id[];
  rejectedCount: number;
}

// ---------------------------------------------------------------------------
// 提供者インターフェース（拡張機能が実装する）
// ---------------------------------------------------------------------------

export interface EditorContext {
  /** 描画先。Shadow DOM のルート直下の要素 */
  container: HTMLElement;
  asset: Asset;
  itemKey?: string;
  /** エディターを閉じるときに中断される */
  signal: AbortSignal;
  /** タイトルや未保存表示など、シェルに伝える状態 */
  setTitle(title: string): void;
}

export interface EditorInstance {
  /** プロパティパネルなどで選ばれたアノテーションを見える位置に出す */
  reveal(annotationId: Id): void;
  /** アイテムの切り替え（ItemProvider を持つ媒体のみ） */
  setItem?(itemKey: string): Promise<void>;
  /** ツールの切り替え通知 */
  onToolChanged?(toolId: QualifiedId | null): void;
  dispose(): void;
}

export interface EditorProvider {
  open(ctx: EditorContext): Promise<EditorInstance>;
}

export interface PreviewContext {
  container: HTMLElement;
  asset: Asset;
  signal: AbortSignal;
}

export interface PreviewProvider {
  render(ctx: PreviewContext): Promise<Disposable>;
}

export interface ItemProvider {
  /** 範囲を指定して列挙する（ツリーの仮想スクロールから呼ばれる） */
  list(asset: Asset, range: { offset: number; limit: number }, signal: AbortSignal): Promise<{ items: ItemInfo[]; total?: number }>;
  /** キーから表示名を得る（DB にだけ残っているアイテムの表示用） */
  describe?(asset: Asset, itemKey: string): Promise<ItemInfo>;
}

export interface SummaryContext {
  asset: Asset;
  locale: string;
}

export interface AnnotationTypeImpl<S extends JsonValue = JsonValue> {
  /** 拡張機能が無い環境でも一覧に出す短い表示文。保存時にコアが呼んで記録する */
  summarize(selector: S, ctx: SummaryContext): string;
  /** スキーマ検証の後に呼ばれる追加検証。エラーメッセージを返す（空なら正常） */
  validate?(selector: S, asset: Asset): string[];
  /** 古い typeVersion の selector を現在の形式に変換する */
  migrate?(fromVersion: number, selector: JsonValue): S;
}

export interface ViewContext {
  container: HTMLElement;
  signal: AbortSignal;
  /** ビューの表示状態の変化 */
  onDidChangeVisibility: Event<boolean>;
}

export interface ViewProvider {
  resolve(ctx: ViewContext): Promise<Disposable>;
}

export interface ExportContext {
  /** 書き出し対象（コアの共通オプション画面で選ばれたもの） */
  assetIds: Id[];
  labelIds: Id[] | null;
  /** 書き出し先（file のときはファイルパス、folder のときはフォルダパス）。fs.export 権限で書ける */
  destination: string;
  options: JsonObject;
  signal: AbortSignal;
  progress(fraction: number, message?: string): void;
  /** ファイルを書く（destination 配下に限る） */
  writeFile(relPath: string, data: string | ArrayBuffer): Promise<void>;
}

export interface ExportResult {
  written: number;
  skipped: { reason: string; count: number }[];
}

export interface ExporterImpl {
  export(ctx: ExportContext): Promise<ExportResult>;
}

export interface ImportContext {
  source: string;
  options: JsonObject;
  signal: AbortSignal;
  progress(fraction: number, message?: string): void;
  readFile(relPath?: string): Promise<ArrayBuffer>;
}

export interface ImportResult {
  created: number;
  skipped: { reason: string; count: number }[];
}

export interface ImporterImpl {
  /** 作成は host.annotations / relations / groups を transaction 内で使う */
  import(ctx: ImportContext): Promise<ImportResult>;
}

export interface Progress {
  fraction?: number;
  message?: string;
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Host（コアが拡張機能に渡す API）
// 各メソッドはマニフェストの permissions で許可されていなければ PermissionDeniedError を投げる。
// ---------------------------------------------------------------------------

export interface Host {
  /** この拡張機能の ID とバージョン */
  readonly extension: { id: string; version: string; path: string };

  editors: { register(localId: string, provider: EditorProvider): Disposable };
  previewers: { register(localId: string, provider: PreviewProvider): Disposable };
  items: { register(localId: string, provider: ItemProvider): Disposable };
  annotationTypes: { register<S extends JsonValue>(localId: string, impl: AnnotationTypeImpl<S>): Disposable };
  views: { register(localId: string, provider: ViewProvider): Disposable };
  exporters: { register(localId: string, impl: ExporterImpl): Disposable };
  importers: { register(localId: string, impl: ImporterImpl): Disposable };

  commands: {
    register(localId: string, handler: (args?: unknown) => unknown): Disposable;
    execute<T = unknown>(id: QualifiedId, args?: unknown): Promise<T>;
  };

  tools: {
    /** 現在のツール（無ければ null = 選択ツール） */
    active(): QualifiedId | null;
    activate(id: QualifiedId | null): void;
    onDidChange: Event<QualifiedId | null>;
  };

  /** assets.read / assets.metadata */
  assets: {
    get(id: Id): Promise<Asset>;
    /** <img> / <video> などに渡せる unno://asset/{id} の URL */
    url(id: Id): string;
    read(id: Id, range?: ByteRange): Promise<ArrayBuffer>;
    readText(id: Id, encoding?: string): Promise<string>;
    /** 自分の拡張機能 ID の名前空間に記録される */
    setMetadata(id: Id, metadata: JsonObject, itemKey?: string): Promise<void>;
    getItem(assetId: Id, itemKey: string): Promise<Item | null>;
    /** project.status */
    setStatus(target: Target, status: WorkStatus): Promise<void>;
    /** 現在エディターで開いている対象 */
    current(): Target | null;
    onDidChangeCurrent: Event<Target | null>;
  };

  /** annotations.read / annotations.write */
  annotations: {
    query(q: AnnotationQuery): Promise<Annotation[]>;
    create<S extends JsonValue>(a: NewAnnotation<S>): Promise<Annotation<S>>;
    update<S extends JsonValue>(id: Id, patch: AnnotationPatch<S>): Promise<void>;
    remove(ids: Id[]): Promise<void>;
    /** 候補として表示し、ユーザーの採用を待つ */
    suggest(list: NewAnnotation[], opts?: { title?: string }): Promise<SuggestionResult>;
    /** 中の操作を 1 回の Undo 単位にまとめる */
    transaction<T>(label: string, fn: () => Promise<T>): Promise<T>;
    onDidChange: Event<ChangeEvent>;
  };

  relations: {
    query(q: RelationQuery): Promise<Relation[]>;
    create(r: NewRelation): Promise<Relation>;
    update(id: Id, patch: { labelId?: Id | null; attributes?: { [key: string]: JsonValue } }): Promise<void>;
    remove(ids: Id[]): Promise<void>;
  };

  groups: {
    query(q: GroupQuery): Promise<Group[]>;
    create(g: NewGroup): Promise<Group>;
    setMembers(id: Id, memberIds: Id[]): Promise<void>;
    update(id: Id, patch: { labelId?: Id | null; attributes?: { [key: string]: JsonValue } }): Promise<void>;
    remove(ids: Id[]): Promise<void>;
  };

  /** labels.read / labels.write */
  labels: {
    list(filter?: LabelFilter): Promise<Label[]>;
    /** リボンのギャラリーや 1〜9 キーで選ばれているラベル */
    active(): Label | null;
    onDidChangeActive: Event<Label | null>;
    onDidChange: Event<void>;
    /** 属性スキーマ（JSON Schema）を得る。ラベル・種別・global を合成した結果 */
    attributeSchema(opts: { labelId?: Id | null; annotationType?: QualifiedId }): Promise<JsonObject>;
  };

  /** シェルが持つ選択状態（アノテーション・関係・グループの ID） */
  selection: {
    get(): Id[];
    set(ids: Id[]): void;
    onDidChange: Event<Id[]>;
  };

  extensions: {
    /** extensionDependencies に書いた拡張機能の公開 API を得る */
    getApi<T = unknown>(extensionId: string): Promise<T>;
  };

  /** python.spawn */
  python: {
    request<T = unknown>(
      method: string,
      params?: unknown,
      opts?: { signal?: AbortSignal; onProgress?: (p: Progress) => void },
    ): Promise<T>;
    /** unno://blob/{id} の内容を得る */
    readBlob(blobId: string): Promise<ArrayBuffer>;
  };

  /** project.files: .unnotator/plugins/<自分の ID>/ 配下 */
  projectFiles: {
    read(relPath: string): Promise<ArrayBuffer | null>;
    write(relPath: string, data: string | ArrayBuffer): Promise<void>;
  };

  /** プロジェクトに保存される拡張機能専用の値（Undo 対象外） */
  storage: {
    get<T extends JsonValue>(key: string, scope?: { assetId?: Id; itemKey?: string }): Promise<T | undefined>;
    set(key: string, value: JsonValue, scope?: { assetId?: Id; itemKey?: string }): Promise<void>;
  };

  settings: {
    /** マニフェストの settings で宣言したキー（project の値が user の値より優先） */
    get<T = unknown>(key: string): T;
    onDidChange: Event<string[]>;
  };

  ui: {
    notify(message: string, level?: 'info' | 'warn' | 'error'): void;
    setStatusBarItem(localId: string, item: { text: string; tooltip?: string } | null): void;
    confirm(message: string, opts?: { okLabel?: string; cancelLabel?: string }): Promise<boolean>;
    /** ビューを前面に出す */
    showView(id: QualifiedId): void;
  };

  /** when 式で使えるコンテキストキーを設定する（自分の ID で名前空間化される） */
  context: {
    set(key: string, value: string | number | boolean | null): void;
  };

  i18n: {
    readonly locale: string;
    t(key: string, vars?: Record<string, string | number>): string;
  };

  log: Logger;
}

// ---------------------------------------------------------------------------
// エラー
// ---------------------------------------------------------------------------

export interface UnnotatorError extends Error {
  code:
    | 'PermissionDenied'
    | 'NotFound'
    | 'ValidationFailed'
    | 'Conflict'
    | 'Cancelled'
    | 'PythonUnavailable'
    | 'WorkerCrashed'
    | 'Timeout'
    | 'Internal';
  details?: JsonValue;
}
