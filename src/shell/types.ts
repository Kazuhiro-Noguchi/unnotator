// シェルの型（specs/006-shell-layout/data-model.md）。論理のモジュールがここを共有する。
import type { MessageKey } from "../i18n";

export type Disposable = { dispose(): void };

// ---- when 式とコンテキスト ----
export type ContextValue = string | number | boolean | null;

export type WhenExpr =
  | { kind: "key"; name: string }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "not"; operand: WhenExpr }
  | { kind: "eq" | "neq"; left: WhenExpr; right: WhenExpr }
  | { kind: "and" | "or"; left: WhenExpr; right: WhenExpr };

export interface Context {
  /** 未設定は null。反応するスコープの中で読むと購読が張られる。 */
  get(key: string): ContextValue;
  set(key: string, value: ContextValue): void;
  /** 拡張機能用。`<owner>.<key>` として保存する。 */
  setNamespaced(owner: string, key: string, value: ContextValue): void;
  /** 拡張機能が無効になったとき、その名前空間を消す。 */
  remove(owner: string): void;
  /**
   * `compute` が読んだキーを追跡し、そのどれかが変わったら再計算して、
   * 値が変わったときだけ `onChange` を呼ぶ。最初の値は呼ばずに返す。
   */
  watch<T>(compute: () => T, onChange: (value: T) => void): Watch<T>;
}

export interface Watch<T> extends Disposable {
  readonly value: T;
}

// ---- 問題 ----
export type ProblemCode =
  | "when.syntax"
  | "command.duplicate"
  | "command.unknown"
  | "command.failed"
  | "keybinding.invalid"
  | "keybinding.conflict"
  | "ribbon.target-missing"
  | "settings.invalid"
  | "extension.failure";

export interface ShellProblem {
  code: ProblemCode;
  source: string;
  message: string;
  detail?: string;
  /** 記録した時刻（ミリ秒）。 */
  at: number;
  /** 同じ（code・source・message）をまとめた回数。 */
  count: number;
}

export type ProblemInput = Omit<ShellProblem, "at" | "count">;
export type ProblemSink = (problem: ProblemInput) => void;

// ---- 表示名 ----
export type Title = { ja?: string; en?: string } | { key: MessageKey };

// ---- コマンド ----
export interface CommandSpec {
  /** コア: `core.<名前>`（`/` を含まない）。拡張機能: `<拡張機能 ID>/<名前>`。 */
  id: string;
  title: Title;
  category?: Title;
  /** `$(name)`（コア）または拡張機能内の相対パス。 */
  icon?: string;
  /** when 式。 */
  enablement?: string;
  /** 無ければ「未提供」（無効）。 */
  run?: (args?: unknown) => unknown;
  /** 追加元。`core` または拡張機能 ID。 */
  source: string;
}

export type UnavailableReason = "unprovided" | "condition" | "unknown";
export type CommandAvailability =
  | { enabled: true }
  | { enabled: false; reason: UnavailableReason };
export type ExecuteResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: UnavailableReason | "failed" };

// ---- キー ----
export interface Chord {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  /** 小文字に正規化したキー。 */
  key: string;
}

export type Tier = "core" | "extension" | "user";

export interface RawKeybinding {
  key: string;
  command: string;
  args?: unknown;
  when?: string;
}

export interface Keybinding {
  key: string;
  chord: Chord;
  /** `-` で始まるときは、下の層の同じ割り当ての無効化。 */
  command: string;
  args?: unknown;
  when?: string;
  tier: Tier;
  source: string;
  order: number;
}

export type KeyConflict =
  | {
      kind: "conflict";
      chord: Chord;
      when: string | null;
      bindings: Keybinding[];
    }
  | {
      kind: "overridden";
      chord: Chord;
      winner: Keybinding;
      shadowed: Keybinding[];
    };

// ---- リボン ----
export type ControlKind =
  | "largeButton"
  | "smallButton"
  | "splitButton"
  | "toggle"
  | "dropdown"
  | "numberInput"
  | "gallery"
  | "separator";
export type Form = "large" | "small" | "icon" | "dropdown";

export interface RibbonControl {
  kind: ControlKind;
  command?: string;
  tool?: string;
  args?: unknown;
  items?: RibbonControl[];
  when?: string;
  /** ボタンを、ラベルなしのアイコンだけで出す（名前はツールチップと読み上げに残る）。 */
  iconOnly?: boolean;
  /** トグルの状態を表す when 式（真ならオン）。 */
  checked?: string;
  /** トグルを、大きなアイコンで出す（`largeButton` と同じ形）。 */
  large?: boolean;
  numberRange?: { min: number; max: number; step: number };
}

export interface RibbonGroup {
  id: string;
  title: Title;
  priority: number;
  controls: RibbonControl[];
  when?: string;
  source: string;
}

export interface RibbonTab {
  id: string;
  title: Title;
  order: number;
  groups: RibbonGroup[];
  when?: string;
  contextual: boolean;
  source: string;
}

// ---- 画面の配置 ----
export interface LayoutState {
  version: 1;
  primarySidebar: { visible: boolean; width: number; view: string };
  secondarySidebar: { visible: boolean; width: number; tab: string };
  bottom: { visible: boolean; height: number; tab: string };
}

// ---- ステータス・通知 ----
export interface StatusState {
  message: string | null;
  progress: { done: number; total: number } | null;
  jobs: number;
}

export interface StatusItem {
  source: string;
  id: string;
  alignment: "left" | "right";
  priority: number;
  text: string;
  tooltip?: string;
  command?: string;
}

export type NotifyLevel = "info" | "warn" | "error";
export interface NotificationAction {
  label: string;
  /** 主な操作（塗りつぶしのボタン）。 */
  primary?: boolean;
  run: () => void;
}

/** 通知に添えられるもの。 */
export interface NotifyOptions {
  /** 送り元（「ソース: Git」のように、左下に出す）。 */
  source?: string;
  /** 操作のボタン（右下に並べる）。ある通知は、自動では消えない。 */
  actions?: NotificationAction[];
  /** 歯車ボタンを押したときの動き（その送り元の設定を開くなど）。 */
  settings?: () => void;
}

export interface Notification extends NotifyOptions {
  id: number;
  level: NotifyLevel;
  text: string;
  /** warn・error と、操作のある通知は null（閉じるまで残る）。 */
  autoDismissMs: number | null;
}
