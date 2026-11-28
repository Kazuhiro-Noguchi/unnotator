// 敵対的な画面。quickstart.md 4 の試みを、画面の枠の中から全部行い、結果を表示する。
// すべて失敗する（false / blocked / error）のが期待。1 つでも成功したら "ALLOWED" と出す。
import { run } from "./attack.js";
export async function resolveView(ctx, host) {
  const result = await run();
  ctx.container.textContent = JSON.stringify(result);
  return { dispose() { ctx.container.textContent = ""; } };
}
