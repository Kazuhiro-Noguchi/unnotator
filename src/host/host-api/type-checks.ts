// 種別の `validate` / `summarize`（research.md R3・FR-017）。
// 契約では同期の関数なので、種別を定義した拡張機能の裏の枠の中で動く。ホストは、書き込みの前に、
// その枠へ非同期に問い合わせる（枠との間だけが非同期。契約の形は変えない）。失敗したら書かない。
import { invalid } from "./convert";
import type { AssetDto } from "./ipc";
import type { ManifestIndex } from "./manifests";
import { toAsset } from "./mappers";
import { HostApiError } from "./permissions";

/** summary の文字数の上限。 */
export const MAX_SUMMARY_CHARS = 500;
/** 問い合わせの待ち時間の既定（ミリ秒）。 */
export const DEFAULT_CHECK_TIMEOUT_MS = 5000;

export interface CheckInput {
  /** `<拡張機能 ID>/<ローカル名>` */
  type: string;
  selector: unknown;
  assetId: string;
}

export interface TypeChecksDeps {
  manifests: ManifestIndex;
  /** 定義側の裏の枠（必要なら有効化する）。得られなければ `undefined`。 */
  background(
    extId: string,
  ): Promise<{ call(m: string, a: unknown): Promise<unknown> } | undefined>;
  /** 種別の実装が登録しているメンバー（`validate`・`summarize`・`migrate`）。 */
  members(extId: string, localId: string): readonly string[];
  /** ホストが読むアセット（拡張機能の権限とは別。検査のために `Asset` を渡す）。 */
  asset(assetId: string): Promise<AssetDto | null>;
  locale(): string;
  timeoutMs?: number;
}

export interface TypeChecks {
  /** 検査して summary を返す。失敗は `ValidationFailed` / `Timeout`。 */
  check(input: CheckInput): Promise<{ summary: string }>;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new HostApiError("Timeout", "type check timed out")),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function reason(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

export function createTypeChecks(deps: TypeChecksDeps): TypeChecks {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;

  async function invoke(
    frame: { call(m: string, a: unknown): Promise<unknown> },
    localId: string,
    member: string,
    args: unknown[],
  ): Promise<unknown> {
    try {
      return await withTimeout(
        frame.call("invoke", {
          kind: "annotationTypes",
          localId,
          member,
          args,
        }),
        timeoutMs,
      );
    } catch (error) {
      if (error instanceof HostApiError) throw error;
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "Timeout")
        throw new HostApiError("Timeout", "type check timed out");
      throw invalid(`${member} failed: ${reason(error)}`);
    }
  }

  return {
    async check({ type, selector, assetId }) {
      const slash = type.indexOf("/");
      const definer = type.slice(0, slash);
      const localId = type.slice(slash + 1);
      // コアの種別は、コアが検査する。
      if (definer === "core") return { summary: "" };
      const facts = deps.manifests.get(definer);
      if (
        facts === undefined ||
        !facts.contributes.annotationTypes.includes(localId)
      )
        throw invalid(`annotation type is not declared: ${type}`);
      const row = await deps.asset(assetId);
      if (row === null) throw new HostApiError("NotFound", "asset not found");
      const frame = await deps.background(definer);
      if (frame === undefined)
        throw invalid(`extension is not available: ${definer}`);
      const asset = toAsset(row);
      const members = deps.members(definer, localId);

      if (members.includes("validate")) {
        const result = await invoke(frame, localId, "validate", [
          selector,
          asset,
        ]);
        if (!Array.isArray(result) || result.some((m) => typeof m !== "string"))
          throw invalid("validate must return an array of strings");
        if (result.length > 0)
          throw invalid(
            `validation failed: ${result.slice(0, 10).join(" / ").slice(0, 1000)}`,
          );
      }
      if (!members.includes("summarize")) return { summary: "" };
      const summary = await invoke(frame, localId, "summarize", [
        selector,
        { asset, locale: deps.locale() },
      ]);
      if (typeof summary !== "string")
        throw invalid("summarize must return a string");
      return { summary: summary.slice(0, MAX_SUMMARY_CHARS) };
    },
  };
}
