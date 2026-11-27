import { answer } from "./util.js";
const out = { module: true, answer, origin: String(location.origin), internals: typeof window.__TAURI_INTERNALS__ };
try { localStorage.setItem("k", "v"); out.storage = "ok"; } catch (e) { out.storage = "blocked:" + e.name; }
try { await fetch("unno://localhost/ext/dev.spike.rect/dist/index.js"); out.fetch = "ALLOWED"; } catch (e) { out.fetch = "blocked"; }
window.parent.postMessage({ spike: "s02", out }, "*");
