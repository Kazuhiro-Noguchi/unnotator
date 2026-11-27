export function activate() {
  setTimeout(() => { throw new Error("spike-async-throw"); }, 0);
  Promise.reject(new Error("spike-unhandled-rejection"));
  return { reachTauri: typeof window.__TAURI_INTERNALS__?.invoke };
}
