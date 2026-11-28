// quickstart.md 4 の試みの一覧。各項目は、成功したら "ALLOWED"、失敗（期待どおり）なら "blocked" を返す。
const attempt = async (fn) => {
  try {
    const v = await fn();
    return v === false ? "blocked" : "ALLOWED";
  } catch (e) {
    return "blocked";
  }
};

export async function run() {
  const r = {};
  // 1. Tauri の内部の呼び出し（Rust の IPC を直接）。Windows は入り口のオブジェクトが残るので、届くかを見る。
  r.tauriInvoke = await attempt(async () => {
    const t = window.__TAURI_INTERNALS__;
    if (!t || typeof t.invoke !== "function") return false;
    const answer = await Promise.race([
      t.invoke("devmode_get"),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1000)),
    ]);
    return answer ? true : false;
  });
  // 2. 外部への通信
  r.network = await attempt(async () => {
    await fetch("https://example.com/", { mode: "no-cors" });
    return true;
  });
  // 3. 他の拡張機能の保存領域・親の DOM・他の枠
  r.storage = await attempt(async () => { localStorage.setItem("x", "1"); return true; });
  r.indexedDb = await attempt(async () => { indexedDB.open("x"); return true; });
  r.parentDom = await attempt(async () => { void window.parent.document.body; return true; });
  r.siblingFrames = await attempt(async () => {
    for (let i = 0; i < window.parent.frames.length; i++) void window.parent.frames[i].document;
    return window.parent.frames.length > 0;
  });
  // 4. ナビゲーション・ポップアップ
  r.navigateTop = await attempt(async () => { window.top.location.href = "https://example.com/"; return true; });
  r.popup = await attempt(async () => { const w = window.open("https://example.com/"); return w !== null; });
  // 5. 巨大・大量・不正な形のメッセージ（ホストが検査して拒否する。送れてしまうこと自体は問題ではない）
  r.flood = "sent";
  return r;
}

/** 本体への報告を、わざと壊れた形・巨大な値・他の ID の名乗りで送る（ホスト側の検査のテスト用）。 */
export function hostile(port) {
  port.postMessage({ t: "req", id: 1, m: "annotations.create", a: "x".repeat(2 * 1024 * 1024) }); // 巨大
  for (let i = 0; i < 1000; i++) port.postMessage({ t: "req", id: 2 + i, m: "selection.get", a: null }); // 大量
  port.postMessage({ t: "req", id: 5000, m: "not.in.table", a: null }); // 未知の m
  port.postMessage({ t: "req", id: 5001, m: "annotations.create", a: { fn: () => 1 } }); // 関数（送れず例外）
  port.postMessage({ t: "req", id: 5002, m: "selection.get", a: null, ext: "dev.spike.base", source: "manual" }); // ID の詐称
}
