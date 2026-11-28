// `annotations.suggest`（FR-025・FR-026）。候補を検査（形・種別・`validate`・権限）して、ホストの仮の状態へ入れる。
// 書き込まない。利用者が採用 / 却下するまで（またはプロジェクトを閉じるまで）、応答を返さない。
import type { SuggestionDraft } from "../suggestions";
import type { Ctx, Handlers } from "./api-types";
import { invalid, optStr, positional } from "./convert";
import { HostApiError } from "./permissions";
import type { WriteApi } from "./write";

/** 1 回の `suggest` で渡せる候補の数。 */
export const MAX_SUGGESTIONS = 20_000;
const MAX_TITLE_CHARS = 200;
/** 検査（定義側の枠への問い合わせ）を同時に進める数。 */
const CHECK_CONCURRENCY = 32;

/** 順序を保って、同時に `limit` 個まで進める。1 つ失敗したら、残りを始めずに投げる。 */
async function mapLimit<T, R>(
  list: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(list.length);
  let next = 0;
  let failed: unknown;
  let hasFailed = false;
  async function worker() {
    while (!hasFailed) {
      const index = next++;
      if (index >= list.length) return;
      try {
        out[index] = await fn(list[index] as T, index);
      } catch (error) {
        if (!hasFailed) {
          hasFailed = true;
          failed = error;
        }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, worker),
  );
  if (hasFailed) throw failed;
  return out;
}

export function createSuggestHandlers(
  build: WriteApi["buildCreate"],
): Handlers {
  return {
    "annotations.suggest": async (ctx: Ctx, a: unknown) => {
      const store = ctx.deps.suggestions;
      if (store === undefined)
        throw new HostApiError("Internal", "suggestions are not available");
      const [list, opts] = positional(a);
      if (!Array.isArray(list)) throw invalid("list must be an array");
      if (list.length > MAX_SUGGESTIONS) throw invalid("list is too long");
      let title: string | null = null;
      if (opts !== undefined && opts !== null) {
        if (typeof opts !== "object" || Array.isArray(opts))
          throw invalid("opts must be an object");
        title = optStr((opts as { title?: unknown }).title, "title") ?? null;
        if (title !== null && title.length > MAX_TITLE_CHARS)
          throw invalid("title is too long");
      }
      if (list.length === 0) return { accepted: [], rejectedCount: 0 };
      // 1 件でも通らなければ、何も持たない（どの項目かを示して返す）。
      const items = await mapLimit(
        list,
        CHECK_CONCURRENCY,
        async (raw, index): Promise<SuggestionDraft> => {
          try {
            const { command, annotation } = await build(ctx, raw);
            const target = annotation.target as {
              assetId: string;
              itemKey?: string;
            };
            return {
              id: annotation.id as string,
              assetId: target.assetId,
              itemKey: target.itemKey ?? null,
              type: annotation.type as string,
              summary: annotation.summary as string,
              selector: annotation.selector,
              labelId: (annotation.labelId as string | null) ?? null,
              command,
            };
          } catch (error) {
            if (error instanceof HostApiError)
              throw new HostApiError(error.code, `[${index}] ${error.message}`);
            throw error;
          }
        },
      );
      return await store.add({ source: ctx.extId, title, items });
    },
  };
}
