// `selection.set` の Host API。権限は要らない（選択は本体の状態で、アノテーションの中身は読めない）。
import type { Handlers } from "./api-types";
import { invalid, positional } from "./convert";

/** 1 回の `set` で渡せる ID の数。 */
export const MAX_SELECTION_IDS = 10_000;

export const selectionHandlers: Handlers = {
  "selection.set": async (ctx, a) => {
    const [list] = positional(a);
    if (!Array.isArray(list) || list.some((id) => typeof id !== "string"))
      throw invalid("ids must be a string array");
    if (list.length > MAX_SELECTION_IDS) throw invalid("ids is too long");
    await ctx.deps.selection?.set(list as string[]);
    return null;
  },
};
