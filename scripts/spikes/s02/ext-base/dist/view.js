// Windows（WebView2）の確認: 枠の中に __TAURI_INTERNALS__ があるとき、Rust のコマンドが実際に呼べるか。
(async () => {
  let result = "no-internals";
  try {
    const t = window.__TAURI_INTERNALS__;
    if (t && typeof t.invoke === "function") {
      const r = await Promise.race([
        t.invoke("devmode_get"),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1000)),
      ]);
      result = "INVOKE-SUCCEEDED:" + JSON.stringify(r).slice(0, 60);
    }
  } catch (e) {
    result = "invoke-rejected:" + String(e && e.message ? e.message : e).slice(0, 80);
  }
  window.parent.postMessage({ spike: "s02", invoke: result }, "*");
})();
