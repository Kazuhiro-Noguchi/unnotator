// Host API の入口。枠から来た `req` を、権限の門 → 各部の実装の順に処理する。
// 送り主の拡張機能 ID は、枠の経路（port）で決まったもの。引数の中の自己申告は使わない。
import type { HostRequest } from "../channel";
import type { Ctx, Handlers, HostApiDeps } from "./api-types";
import { createMiscHandlers } from "./misc";
import { HostApiError } from "./permissions";
import { readHandlers } from "./read";
import { selectionHandlers } from "./selection-api";
import { createSuggestHandlers } from "./suggest";
import { createWriteHandlers } from "./write";

export type { HostApiDeps } from "./api-types";

export interface HostApi {
  handle(request: HostRequest): Promise<unknown>;
  /** 拡張機能の枠がすべて無くなったとき（開いている transaction などを捨てる）。 */
  closeExtension(extId: string): void;
}

/** Rust の `IpcError`（`code`・`message`）を、拡張機能に返すエラーにする。 */
export function toHostError(error: unknown): HostApiError {
  if (error instanceof HostApiError) return error;
  if (typeof error === "object" && error !== null) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    const text = typeof message === "string" ? message : "error";
    switch (code) {
      case "needs_consent":
      case "permission_denied":
        return new HostApiError("PermissionDenied", text);
      case "not_found":
        return new HostApiError("NotFound", text);
      case "invalid_command":
      case "invalid":
        return new HostApiError("ValidationFailed", text);
      default:
        return new HostApiError("Internal", text);
    }
  }
  return new HostApiError("Internal", String(error));
}

export function createHostApi(
  deps: HostApiDeps,
  extra: Handlers[] = [],
): HostApi {
  const write = createWriteHandlers();
  const handlers: Handlers = Object.assign(
    {},
    readHandlers,
    write.handlers,
    createMiscHandlers(),
    selectionHandlers,
    createSuggestHandlers(write.buildCreate),
    ...extra,
  );
  return {
    closeExtension: (extId) => write.abortTransactions(extId),
    async handle(request) {
      try {
        // 門は、実装の有無によらず先に通す（宣言のない呼び出しは、何も起こさない）。
        await deps.gate.authorize(request.extId, request.m);
        const handler = handlers[request.m];
        if (handler === undefined)
          throw new HostApiError("Internal", `not implemented: ${request.m}`);
        const ctx: Ctx = { extId: request.extId, ipc: deps.ipc, deps };
        return await handler(ctx, request.a);
      } catch (error) {
        throw toHostError(error);
      }
    },
  };
}
