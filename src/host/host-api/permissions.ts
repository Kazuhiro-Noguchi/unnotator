// 権限の確認（contracts/host-api-gate.md の「本体（TS）の門」）。
// 表は Rust と共有の `host-api-permissions.json`。表にないものは拒否（既定は拒否）。
// 未同意のときだけ、ホストが描くダイアログで利用者に聞く。Rust の `ext_*` の IPC が最終の門。
import table from "../../../crates/extensions/host-api-permissions.json";

/** 拡張機能に返すエラー（`UnnotatorError.code` と同じ名前）。 */
export type HostErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "ValidationFailed"
  | "Conflict"
  | "Cancelled"
  | "PythonUnavailable"
  | "WorkerCrashed"
  | "Timeout"
  | "Internal";

export class HostApiError extends Error {
  constructor(
    readonly code: HostErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HostApiError";
  }
}

const methods = table.methods as Record<string, string | null>;

/** メソッドに必要な権限。`null` は不要、`undefined` は表にない。 */
export function requiredPermission(method: string): string | null | undefined {
  return Object.hasOwn(methods, method) ? methods[method] : undefined;
}

export interface PermissionVerdict {
  /** `allowed` / `needs_consent` / `denied` */
  verdict: string;
  warning: boolean;
}

export interface ConsentPrompt {
  extId: string;
  permissions: { permission: string; warning: boolean }[];
}

export interface PermissionDeps {
  checkPermission(
    extId: string,
    permission: string,
  ): Promise<PermissionVerdict>;
  /** 同意を保存する（Rust の `extension_consent`）。 */
  consent(extId: string, permissions: string[]): Promise<void>;
  /** ホストが描くダイアログ。許可なら true。 */
  ask(prompt: ConsentPrompt): Promise<boolean>;
  /** 同意を保存した直後に呼ぶ。許可で見えるようになる値（写しなど）を、枠へ送り直すために使う。 */
  onGranted?(extId: string, permission: string): void | Promise<void>;
}

export interface PermissionGate {
  /** Host API のメソッドを呼んでよいか。だめなら `PermissionDenied`。 */
  authorize(extId: string, method: string): Promise<void>;
  /** 権限そのものを確かめる（必要なら聞く）。 */
  requirePermission(extId: string, permission: string): Promise<void>;
  /** 拒否の記憶を消す。同意の取り消し・付け直しのとき、もう一度聞けるようにする。 */
  forget(extId: string): void;
}

const denied = (message: string) =>
  new HostApiError("PermissionDenied", message);

export function createPermissionGate(deps: PermissionDeps): PermissionGate {
  /** 今の起動のあいだ、利用者が拒否した権限。同じ権限を続けて聞かない。 */
  const refused = new Set<string>();
  /** 聞いている最中のダイアログ。同じ拡張機能・権限の同時の呼び出しは、これを待つ。 */
  const asking = new Map<string, Promise<void>>();
  const keyOf = (extId: string, permission: string) =>
    `${extId}\u0000${permission}`;

  async function requirePermission(
    extId: string,
    permission: string,
  ): Promise<void> {
    const key = keyOf(extId, permission);
    if (refused.has(key)) throw denied(`permission refused: ${permission}`);
    const pending = asking.get(key);
    if (pending !== undefined) return pending;

    const run = (async () => {
      let verdict: PermissionVerdict;
      try {
        verdict = await deps.checkPermission(extId, permission);
      } catch {
        throw denied(`permission check failed: ${permission}`);
      }
      if (verdict.verdict === "allowed") return;
      if (verdict.verdict !== "needs_consent")
        throw denied(`permission not declared: ${permission}`);
      const granted = await deps.ask({
        extId,
        permissions: [{ permission, warning: verdict.warning }],
      });
      if (!granted) {
        refused.add(key);
        throw denied(`permission refused: ${permission}`);
      }
      await deps.consent(extId, [permission]);
      try {
        await deps.onGranted?.(extId, permission);
      } catch {
        // 送り直しの失敗で、許可した呼び出し自体は失敗させない。
      }
    })();
    asking.set(key, run);
    try {
      await run;
    } finally {
      asking.delete(key);
    }
  }

  return {
    async authorize(extId, method) {
      const required = requiredPermission(method);
      if (required === undefined) throw denied(`unknown method: ${method}`);
      if (required === null) return;
      await requirePermission(extId, required);
    },
    requirePermission,
    forget(extId) {
      const prefix = `${extId}\u0000`;
      for (const key of [...refused]) {
        if (key.startsWith(prefix)) refused.delete(key);
      }
    },
  };
}
