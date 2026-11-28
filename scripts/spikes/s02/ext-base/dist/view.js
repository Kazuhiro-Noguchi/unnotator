const out = { origin: String(location.origin), hasTauriInternals: typeof window.__TAURI_INTERNALS__ !== "undefined", parentAccess: "?" };
try { out.parentAccess = String(window.parent.document.title).slice(0, 5); } catch (e) { out.parentAccess = "blocked:" + e.name; }
window.parent.postMessage({ spike: "s02", out }, "*");
window.addEventListener("message", (e) => { if (e.data && e.data.ping) window.parent.postMessage({ spike: "s02", pong: e.data.ping }, "*"); });
// Windows（WebView2）の確認: 枠の中に __TAURI_INTERNALS__ があるとき、Rust のコマンドが実際に届くか。
// invoke の応答は枠の中の関数には戻らないことがある（タイムアウト）ので、応答ではなく、副作用
// （本体が listen している s02-iframe-probe イベントの受信）で判定する。S-02 の検証コード（本体側）は、T070 で削除した。
(async () => {
  let result = "no-internals";
  try {
    const t = window.__TAURI_INTERNALS__;
    if (t && typeof t.invoke === "function") {
      result = "invoke-pending";
      const p = t.invoke("plugin:event|emit", { event: "s02-iframe-probe", payload: location.href });
      const r = await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 800))]);
      result = "resolved:" + JSON.stringify(r).slice(0, 40);
    }
  } catch (e) {
    result = "rejected:" + String(e && e.message ? e.message : e).slice(0, 80);
  }
  window.parent.postMessage({ spike: "s02", invoke: result }, "*");
})();
