// 依存先（ext-base）の公開 API を getApi で呼び、結果を通知に出す（依存順・getApi の実機確認）。
export async function activate(host) {
  const base = await host.extensions.getApi("dev.spike.base");
  const shape = await base.registerShape("rect");
  const answer = await base.answer();
  host.ui.notify(`rect: getApi OK -> ${shape} / ${answer}`, "info");
  return { shape, answer };
}
export function deactivate() {}
