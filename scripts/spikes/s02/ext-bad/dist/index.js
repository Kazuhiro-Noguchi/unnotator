// 裏の枠での悪さ: 非同期の例外・拒否されない Promise の拒否・Tauri の入り口の確認。
export function activate() {
  setTimeout(() => { throw new Error("spike-async-throw"); }, 0);
  Promise.reject(new Error("spike-unhandled-rejection"));
  return { reachTauri: typeof window.__TAURI_INTERNALS__?.invoke };
}
