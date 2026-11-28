// 画面の枠で読まれる画面用のモジュール（SurfaceModule）。エディターとビューの両方の入り口。
export async function openEditor(ctx, host) {
  ctx.container.textContent = "base editor: " + (ctx.asset?.name ?? "");
  return { reveal() {}, dispose() { ctx.container.textContent = ""; } };
}
export async function resolveView(ctx, host) {
  ctx.container.textContent = "base view";
  return { dispose() { ctx.container.textContent = ""; } };
}
