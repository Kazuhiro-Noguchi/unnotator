import { answer } from "./util.js";
// 公開 API（getApi で依存元が呼ぶ）。関数のメンバーだけが、ホストへ公開される。
export function activate(host) {
  return { answer: () => answer, registerShape: (name) => `registered:${name}` };
}
export function deactivate() {}
