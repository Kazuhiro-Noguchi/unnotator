// 拡張機能間 API（`host.extensions.getApi`）の仲介（research.md R4）。
// 依存先の裏の枠が、`activate` の戻り値の関数の名前の表をホストへ公開する。
// 依存元は、その表から作ったプロキシで呼ぶ。呼び出しはホストを必ず通り、依存の宣言と引数・戻り値を検査する。
import { isPlainData } from "./channel";
import type { Ctx, Handlers } from "./host-api/api-types";
import type { ManifestIndex } from "./host-api/manifests";
import { HostApiError, type HostErrorCode } from "./host-api/permissions";

const MAX_MEMBERS = 1000;
const PATH = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const CODES: ReadonlySet<string> = new Set<HostErrorCode>([
  "PermissionDenied",
  "NotFound",
  "ValidationFailed",
  "Conflict",
  "Cancelled",
  "PythonUnavailable",
  "WorkerCrashed",
  "Timeout",
  "Internal",
]);

export interface ApiBrokerDeps {
  manifests: ManifestIndex;
  /** 依存先の裏の枠（必要なら有効化する）。得られなければ `undefined`。 */
  background(
    extId: string,
  ): Promise<{ call(m: string, a: unknown): Promise<unknown> } | undefined>;
}

export interface ApiBroker {
  handlers: Handlers;
  /** 拡張機能を止めたとき、公開した表を捨てる。 */
  forget(extId: string): void;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HostApiError("ValidationFailed", "invalid getApi arguments");
  }
  return value as Record<string, unknown>;
}

export function createApiBroker(deps: ApiBrokerDeps): ApiBroker {
  const published = new Map<string, string[]>();

  async function getApi(ctx: Ctx, raw: unknown): Promise<unknown> {
    const a = record(raw);

    // 公開: 依存先自身の枠から。送り主は port で決まった ID（他の拡張機能の分は公開できない）。
    if (a.publish !== undefined) {
      const list = a.publish;
      if (
        !Array.isArray(list) ||
        list.length > MAX_MEMBERS ||
        !list.every((p) => typeof p === "string" && PATH.test(p))
      ) {
        throw new HostApiError("ValidationFailed", "invalid published members");
      }
      published.set(ctx.extId, [...(list as string[])]);
      return null;
    }

    const id = a.id;
    if (typeof id !== "string") {
      throw new HostApiError("ValidationFailed", "id is required");
    }
    // 依存を宣言した拡張機能だけ（FR-005・FR-034）。
    const declared = deps.manifests.get(ctx.extId)?.extensionDependencies ?? [];
    if (!declared.includes(id)) {
      throw new HostApiError(
        "PermissionDenied",
        `${ctx.extId} does not declare a dependency on ${id}`,
      );
    }
    const frame = await deps.background(id);
    if (frame === undefined) {
      throw new HostApiError("NotFound", `${id} is not available`);
    }
    if (a.call === undefined) return [...(published.get(id) ?? [])];

    const member = a.call;
    if (
      typeof member !== "string" ||
      !(published.get(id) ?? []).includes(member)
    ) {
      throw new HostApiError(
        "NotFound",
        `${id} does not publish ${String(member)}`,
      );
    }
    const args = a.args ?? [];
    if (!Array.isArray(args) || !isPlainData(args)) {
      throw new HostApiError(
        "ValidationFailed",
        "arguments must be structured-cloneable data",
      );
    }
    let result: unknown;
    try {
      result = await frame.call("invoke", {
        kind: "api",
        localId: "",
        member,
        args,
      });
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      throw new HostApiError(
        typeof code === "string" && CODES.has(code)
          ? (code as HostErrorCode)
          : "Internal",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!isPlainData(result)) {
      throw new HostApiError(
        "ValidationFailed",
        "the result is not structured-cloneable data",
      );
    }
    return result;
  }

  return {
    handlers: { "extensions.getApi": getApi },
    forget: (extId) => void published.delete(extId),
  };
}
