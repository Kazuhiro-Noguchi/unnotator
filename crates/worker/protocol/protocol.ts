/**
 * unnotator Python worker protocol v1（Rust コア ⇔ Python ワーカー）
 *
 * 伝送: 標準入出力上の JSON-RPC 2.0。区切りは LSP と同じヘッダー形式:
 *   Content-Length: <UTF-8 バイト数>\r\n
 *   \r\n
 *   <JSON 本文>
 * ワーカーの stdout はプロトコル専用。SDK は起動時に sys.stdout を stderr に向け直す。
 * stderr はコアが拡張機能ごとのログファイルに記録する。
 *
 * 寿命の規則
 *  - コアは起動直後に initialize を送り、応答まで他の要求を送らない。
 *  - ワーカーは stdin の EOF を受けたら直ちに終了する（親プロセスの異常終了対策）。
 *  - shutdown 応答後、コアは exit 通知を送り、3 秒で終了しなければ強制終了する。
 *  - $/cancelRequest 後 5 秒応答が無ければ、コアはワーカーを強制終了する。
 */

export const PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 基本形
// ---------------------------------------------------------------------------

export type RequestId = number | string;

export interface RequestMessage<P = unknown> {
  jsonrpc: '2.0';
  id: RequestId;
  method: string;
  params?: P;
}

export interface NotificationMessage<P = unknown> {
  jsonrpc: '2.0';
  method: string;
  params?: P;
}

export interface ResponseMessage<R = unknown> {
  jsonrpc: '2.0';
  id: RequestId | null;
  result?: R;
  error?: ResponseError;
}

export interface ResponseError {
  code: number;
  message: string;
  data?: unknown;
}

export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  RequestCancelled: -32800,
  EnvSyncFailed: -33001,
  WorkerCrashed: -33002,
  Timeout: -33003,
  PermissionDenied: -33004,
  /** これより小さい値（-33100 以下）は拡張機能が自由に使う */
  ExtensionDefinedStart: -33100,
} as const;

// ---------------------------------------------------------------------------
// 共有データ型
// ---------------------------------------------------------------------------

/** params 内でアセットを参照する書き方。コアが AssetRef に展開してからワーカーへ送る */
export interface AssetPlaceholder {
  $asset: string;
  itemKey?: string;
}

export interface AssetRef {
  id: string;
  /** 絶対パス（OS ネイティブの区切り） */
  path: string;
  mediaType: string | null;
  fileSize: number;
  mtimeMs: number;
  /** 呼び出し元の拡張機能の名前空間のメタ情報 */
  metadata: Record<string, unknown>;
  itemKey?: string;
}

/**
 * 大きなバイナリの参照。1MB 未満は Base64 を JSON に直接入れてよい（{"$base64": "..."}）。
 * $blob はコアが initialize で渡した blobDir 直下のファイル名。
 * コアはジョブ完了後に、UI モジュールが取得し終えたものを削除する。アプリ終了時は全削除。
 */
export interface BlobRef {
  $blob: string;
  /** 任意: 配列データのとき（numpy の dtype 名） */
  dtype?: 'uint8' | 'int8' | 'uint16' | 'int16' | 'uint32' | 'int32' | 'float16' | 'float32' | 'float64';
  shape?: number[];
  mimeType?: string;
}

export interface InlineBinary {
  $base64: string;
  dtype?: BlobRef['dtype'];
  shape?: number[];
  mimeType?: string;
}

// ---------------------------------------------------------------------------
// コア → ワーカー
// ---------------------------------------------------------------------------

/** method: 'initialize'（要求） */
export interface InitializeParams {
  protocolVersion: typeof PROTOCOL_VERSION;
  appVersion: string;
  extension: { id: string; version: string; path: string };
  /** プロジェクトを開いていなければ null */
  projectRoot: string | null;
  /** マニフェストの settings で宣言したキーの現在値 */
  settings: Record<string, unknown>;
  /** BlobRef を書くフォルダ（ワーカー専用、存在保証あり） */
  blobDir: string;
  locale: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface InitializeResult {
  protocolVersion: typeof PROTOCOL_VERSION;
  /** ワーカーが提供するメソッド名（'initialize' などの予約名を除く） */
  methods: string[];
  /** 任意の自己申告情報（例: 使用デバイス） */
  info?: Record<string, unknown>;
}

/** method: 'shutdown'（要求、params なし、result は null） */
export type ShutdownResult = null;

/** method: 'exit'（通知、params なし） */

/** method: '$/cancelRequest'（通知） */
export interface CancelParams {
  id: RequestId;
}

/** method: '$/settingsChanged'（通知） */
export interface SettingsChangedParams {
  settings: Record<string, unknown>;
}

/**
 * 拡張機能定義のメソッド（要求）。
 * UI モジュールの host.python.request(method, params) がそのまま中継される。
 * params 内の AssetPlaceholder は AssetRef に置き換えられる（assets.read 権限が必要）。
 * 結果の中の BlobRef は、コアが unno://blob/{id} として UI モジュールから読めるようにする。
 */

// ---------------------------------------------------------------------------
// ワーカー → コア
// ---------------------------------------------------------------------------

/** method: '$/progress'（通知） */
export interface ProgressParams {
  /** 対象の要求 ID */
  id: RequestId;
  /** 0〜1。不明なら省略 */
  fraction?: number;
  message?: string;
}

/** method: '$/log'（通知） */
export interface LogParams {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

/** method: 'host/getAsset'（要求、assets.read が必要） */
export interface GetAssetParams {
  id: string;
  itemKey?: string;
}
export type GetAssetResult = AssetRef;

/** method: 'host/queryAnnotations'（要求、annotations.read が必要。参照のみ） */
export interface QueryAnnotationsParams {
  assetId?: string;
  itemKey?: string;
  types?: string[];
  labelIds?: string[];
  limit?: number;
  offset?: number;
}

export interface AnnotationRecord {
  id: string;
  assetId: string;
  itemKey?: string;
  type: string;
  typeVersion: number;
  selector: unknown;
  labelId: string | null;
  labelName: string | null;
  attributes: Record<string, unknown>;
}

export interface QueryAnnotationsResult {
  annotations: AnnotationRecord[];
  total: number;
}

/** method: 'host/listLabels'（要求、labels.read が必要） */
export interface ListLabelsResult {
  labels: { id: string; name: string; color: string; appliesTo: Record<string, unknown> }[];
}

// ---------------------------------------------------------------------------
// メソッド表（実装のチェックリスト）
// ---------------------------------------------------------------------------

export interface CoreToWorkerRequests {
  initialize: { params: InitializeParams; result: InitializeResult };
  shutdown: { params: undefined; result: ShutdownResult };
}

export interface CoreToWorkerNotifications {
  exit: undefined;
  '$/cancelRequest': CancelParams;
  '$/settingsChanged': SettingsChangedParams;
}

export interface WorkerToCoreRequests {
  'host/getAsset': { params: GetAssetParams; result: GetAssetResult };
  'host/queryAnnotations': { params: QueryAnnotationsParams; result: QueryAnnotationsResult };
  'host/listLabels': { params: Record<string, never>; result: ListLabelsResult };
}

export interface WorkerToCoreNotifications {
  '$/progress': ProgressParams;
  '$/log': LogParams;
}
