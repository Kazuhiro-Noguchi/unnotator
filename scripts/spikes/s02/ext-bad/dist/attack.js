// 権限なしの拡張機能が、ホストを通さずに Rust のコマンドを直接呼べるか。
export async function run() {
  const r = { internals: typeof window.__TAURI_INTERNALS__, tauri: typeof window.__TAURI__ };
  try { r.invoke = JSON.stringify(await window.__TAURI_INTERNALS__.invoke("devmode_get")); } catch (e) { r.invoke = "error:" + String(e); }
  try { await fetch("https://example.com/", { mode: "no-cors" }); r.network = "ALLOWED"; } catch (e) { r.network = "blocked"; }
  return r;
}
