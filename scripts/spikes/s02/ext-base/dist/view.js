const out = { origin: String(location.origin), hasTauriInternals: typeof window.__TAURI_INTERNALS__ !== "undefined", parentAccess: "?" };
try { out.parentAccess = String(window.parent.document.title).slice(0, 5); } catch (e) { out.parentAccess = "blocked:" + e.name; }
window.parent.postMessage({ spike: "s02", out }, "*");
window.addEventListener("message", (e) => { if (e.data && e.data.ping) window.parent.postMessage({ spike: "s02", pong: e.data.ping }, "*"); });
