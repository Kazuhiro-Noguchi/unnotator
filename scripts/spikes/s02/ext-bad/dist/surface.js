// 敵対的な画面。quickstart.md 4 の試みを、画面の枠の中から全部行い、結果を表示する。
// すべて失敗する（false / blocked / error）のが期待。1 つでも成功したら "ALLOWED" と出す。
import { run } from "./attack.js";
export async function resolveView(ctx, host) {
  const result = await run();
  // 折り返して、全項目が見えるようにする（インラインの style は CSSOM で設定する）。
  ctx.container.style.whiteSpace = "pre-wrap";
  ctx.container.style.fontFamily = "monospace";
  ctx.container.textContent = JSON.stringify(result, null, 1);
  return { dispose() { ctx.container.textContent = ""; } };
}
