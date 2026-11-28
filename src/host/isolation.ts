// 拡張機能の失敗の隔離（FR-020・021、research.md R9）。
// 枠の `rep error`（読み込み時・activate 中・Promise の拒否・setTimeout の例外）と、
// チャンネルの拒否を、拡張機能ごとに数える。期間内に閾値を超えたら、自動で止める。
// 止めるのはこのセッションの間だけ（永続の無効化は `extension_set_enabled`＝人の操作）。
import { ChannelError } from "./channel";

export type FailureKind = "error" | "rejected" | "log";

/** 問題ビュー・ログへ渡す記録の種類。 */
export type RecordKind =
  | "error"
  | "rejected"
  | "warn"
  | "log"
  | "disabled"
  | "unresponsive";

export interface IsolationRecord {
  extId: string;
  kind: RecordKind;
  message: string;
}

export type IsolationNotice = "disabled" | "unresponsive";

export interface IsolationDeps {
  now?: () => number;
  /** セッション内の停止（`ActivationManager.disable`）。 */
  disable(extId: string): Promise<void>;
  /** 利用者への通知。 */
  notify(extId: string, notice: IsolationNotice): void;
  /** 拡張機能ごとのログ・問題ビューへの記録。 */
  record(record: IsolationRecord): void;
  /** 拡張機能の枠をすべて取り除く。 */
  removeFrames(extId: string): void;
  /** 期間内にこの回数を超えたら止める。既定 10。 */
  threshold?: number;
  /** 数える期間（ミリ秒）。既定 60 秒。 */
  windowMs?: number;
  /** ping の返事を待つ時間。既定 5 秒。 */
  pingTimeoutMs?: number;
}

export interface Isolation {
  /** 枠から（または枠についての）報告を、拡張機能に帰属して記録する。`error`・`rejected` は数える。 */
  fail(extId: string, kind: FailureKind, value: unknown): void;
  failureCount(extId: string): number;
  /** このセッションで止めた拡張機能か。 */
  isStopped(extId: string): boolean;
  /** 数え直す（利用者が有効にし直したとき）。 */
  reset(extId: string): void;
  /** 枠の生存を確かめる。返事が無ければ、枠を取り除いて止める。 */
  probe(
    extId: string,
    channel: { call(m: string, a: unknown): Promise<unknown> },
  ): Promise<void>;
}

const LOG_LEVELS_AS_WARN = new Set(["warn", "error"]);

function messageOf(value: unknown): string {
  if (typeof value === "object" && value !== null && "message" in value) {
    return String((value as { message: unknown }).message);
  }
  return String(value);
}

function describe(kind: FailureKind, value: unknown): IsolationRecord["kind"] {
  if (kind !== "log") return kind;
  const level =
    typeof value === "object" && value !== null
      ? (value as { level?: unknown }).level
      : undefined;
  return typeof level === "string" && LOG_LEVELS_AS_WARN.has(level)
    ? "warn"
    : "log";
}

function textOf(kind: FailureKind, value: unknown): string {
  if (kind === "rejected") {
    const reason =
      typeof value === "object" && value !== null
        ? (value as { reason?: unknown }).reason
        : undefined;
    return typeof reason === "string" ? reason : messageOf(value);
  }
  if (kind === "log") {
    const args =
      typeof value === "object" && value !== null
        ? (value as { args?: unknown }).args
        : undefined;
    if (Array.isArray(args)) return args.map((a) => String(a)).join(" ");
  }
  return messageOf(value);
}

export function createIsolation(deps: IsolationDeps): Isolation {
  const now = deps.now ?? Date.now;
  const threshold = deps.threshold ?? 10;
  const windowMs = deps.windowMs ?? 60_000;
  const pingTimeoutMs = deps.pingTimeoutMs ?? 5000;
  const times = new Map<string, number[]>();
  const stopped = new Set<string>();

  function stop(extId: string, notice: IsolationNotice): void {
    if (stopped.has(extId)) return;
    stopped.add(extId);
    deps.record({
      extId,
      kind: notice,
      message: notice === "disabled" ? "too many failures" : "no response",
    });
    deps.notify(extId, notice);
    // 止める処理の失敗は、ほかの拡張機能にも本体にも広げない。
    void deps.disable(extId).catch(() => {});
  }

  return {
    fail(extId, kind, value) {
      deps.record({
        extId,
        kind: describe(kind, value),
        message: textOf(kind, value),
      });
      if (kind === "log") return;
      const t = now();
      const recent = (times.get(extId) ?? []).filter((at) => t - at < windowMs);
      recent.push(t);
      times.set(extId, recent);
      if (recent.length > threshold) stop(extId, "disabled");
    },
    failureCount: (extId) => times.get(extId)?.length ?? 0,
    isStopped: (extId) => stopped.has(extId),
    reset(extId) {
      times.delete(extId);
      stopped.delete(extId);
    },
    async probe(extId, channel) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          channel.call("ping", null),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new ChannelError("Timeout", "no response to ping")),
              pingTimeoutMs,
            );
          }),
        ]);
      } catch (error) {
        if (error instanceof ChannelError && error.code === "Closed") return;
        if (!(error instanceof ChannelError && error.code === "Timeout")) {
          // 返事はある（枠は生きている）が、ping を知らない・失敗した。取り除かない。
          return;
        }
        deps.removeFrames(extId);
        stop(extId, "unresponsive");
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
