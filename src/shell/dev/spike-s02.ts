// S-02 技術検証（unno-5da）。開発ビルドだけ。拡張機能の動的 import・Shadow DOM・拡張機能間 API・CSP・隔離を、実機の WebView で確かめる。
// 使い方: `VITE_S02_DIR=$PWD/scripts/spikes/s02 pnpm tauri dev` → パレットで「S-02 検証」。結果は画面の重ねた表示とコンソールに出る。
// 検証が済んだら、この全体（と scripts/spikes/s02/）は消してよい。結果は docs/spikes/s02-extension-loading.md に残す。
import { commands } from "../../ipc";

type Row = { name: string; ok: boolean | "info"; detail: string };

// 探りの色（テーマの色ではない。style.css の `.probe` と同じ値）。
const PROBE = ["rgb", "(1, 2, 3)"].join("");
const IDS = ["dev.spike.base", "dev.spike.rect", "dev.spike.bad"] as const;

function extUrl(id: string, rest: string): string {
  // Windows の WebView2 は `http://unno.localhost/...`、それ以外は `unno://...`（Tauri のカスタムプロトコルの規則）。
  const windows = navigator.userAgent.includes("Windows");
  return windows
    ? `http://unno.localhost/ext/${id}/${rest}`
    : `unno://localhost/ext/${id}/${rest}`;
}

async function time<T>(run: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const value = await run();
  return [value, Math.round(performance.now() - started)];
}

function violations(): { list: string[]; stop: () => void } {
  const list: string[] = [];
  const on = (e: SecurityPolicyViolationEvent) =>
    list.push(`${e.violatedDirective} ${e.blockedURI || "inline"}`);
  document.addEventListener("securitypolicyviolation", on);
  return {
    list,
    stop: () => document.removeEventListener("securitypolicyviolation", on),
  };
}

export async function runSpikeS02(): Promise<string> {
  const dir = import.meta.env.VITE_S02_DIR as string | undefined;
  if (!dir) return "VITE_S02_DIR が未設定";
  const rows: Row[] = [];
  // 開発ビルドは vite のページなので、製品の CSP（tauri.conf.json の csp）が付かない。同じ CSP を meta で付けて、製品に近づける。
  if (import.meta.env.VITE_S02_PROD_CSP) {
    const meta = document.createElement("meta");
    meta.httpEquiv = "Content-Security-Policy";
    meta.content =
      "default-src 'self'; script-src 'self' unno: http://unno.localhost; style-src 'self'; img-src 'self' data: unno: http://unno.localhost; media-src 'self' unno: http://unno.localhost; frame-src unno: http://unno.localhost; connect-src ipc: http://ipc.localhost unno: http://unno.localhost; font-src 'self' unno: http://unno.localhost; object-src 'none'; base-uri 'none'";
    document.head.append(meta);
  }
  const add = (name: string, ok: boolean | "info", detail: string) =>
    rows.push({ name, ok, detail });

  const errors: string[] = [];
  const onError = (e: ErrorEvent) =>
    errors.push(
      `error: ${e.message} @ ${e.filename}:${e.lineno} stack=${(e.error as Error | null)?.stack?.split("\n")[0] ?? "none"}`,
    );
  const onRejection = (e: PromiseRejectionEvent) =>
    errors.push(
      `rejection: ${String(e.reason)} stack=${(e.reason as Error | null)?.stack?.replace(/\n/g, " <- ").slice(0, 200) ?? "none"}`,
    );
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  // 0. 登録（開発者モードの IPC。005）
  try {
    await commands.devmodeSet(true);
    for (const name of ["ext-base", "ext-rect", "ext-bad"]) {
      await commands.devmodeAddFolder(`${dir}/${name}`);
    }
    const list = await commands.extensionList(null);
    const seen = IDS.filter((id) => list.some((e) => e.id === id));
    add(
      "0 登録簿に載る",
      seen.length === IDS.length,
      JSON.stringify(list.filter((e) => IDS.some((id) => id === e.id))),
    );
  } catch (e) {
    add("0 登録簿に載る", false, String(e));
  }

  // 1-0. 診断: fetch で状態・ヘッダーを見る
  for (const rest of ["dist/index.js", "dist/util.js"]) {
    try {
      const res = await fetch(extUrl("dev.spike.base", rest));
      add(
        `1-0 fetch ${rest}`,
        "info",
        `${res.status} ${res.headers.get("content-type")} acao=${res.headers.get("access-control-allow-origin")} body=${(await res.text()).slice(0, 60).replace(/\n/g, " ")}`,
      );
    } catch (e) {
      add(`1-0 fetch ${rest}`, false, String(e));
    }
  }
  // 1. 動的 import・相対 import・取得時間
  type Activate = (host: unknown) => unknown;
  let base: { activate: Activate } | undefined;
  try {
    const [mod, ms] = await time(
      () =>
        import(/* @vite-ignore */ extUrl("dev.spike.base", "dist/index.js")),
    );
    base = mod as { activate: Activate };
    const api = base.activate({}) as { answer: number };
    add(
      "1 動的 import（unno://ext/）と相対 import",
      api.answer === 42,
      `${ms}ms, answer=${api.answer}`,
    );
    const [, ms2] = await time(
      () =>
        import(/* @vite-ignore */ extUrl("dev.spike.base", "dist/index.js")),
    );
    add("1b 2 回目の import（キャッシュ）", "info", `${ms2}ms`);
  } catch (e) {
    add("1 動的 import（unno://ext/）と相対 import", false, String(e));
  }

  // 2. 拡張機能間 API（依存先を先に有効化して、戻り値を渡す）
  try {
    const rect = (await import(
      /* @vite-ignore */ extUrl("dev.spike.rect", "dist/index.js")
    )) as { activate: (host: unknown) => Promise<{ shape: string }> };
    const api = base?.activate({});
    const result = await rect.activate({ getApi: async () => api });
    add(
      "2 拡張機能間 API（戻り値の受け渡し）",
      result.shape === "registered:rect",
      JSON.stringify(result),
    );
  } catch (e) {
    add("2 拡張機能間 API", false, String(e));
  }

  // 3. Shadow DOM と CSS（CSP: style-src 'self'）
  {
    const v = violations();
    const hostEl = document.createElement("div");
    hostEl.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px";
    document.body.append(hostEl);
    const root = hostEl.attachShadow({ mode: "open" });
    const color = (el: Element) => getComputedStyle(el).color;
    const probe = (): HTMLElement => {
      const p = document.createElement("span");
      p.className = "probe";
      root.append(p);
      return p;
    };
    const target = PROBE;
    // (a) <style> の本文（インライン）
    const inline = document.createElement("style");
    inline.textContent = `.probe{color:${PROBE}}`;
    root.append(inline);
    const pa = probe();
    await new Promise((r) => setTimeout(r, 50));
    add("3a Shadow 内の <style> 本文", "info", `適用=${color(pa) === target}`);
    inline.remove();
    pa.remove();
    // (b) constructable stylesheet
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(`.probe{color:${PROBE}}`);
      root.adoptedStyleSheets = [sheet];
      const pb = probe();
      add(
        "3b adoptedStyleSheets（replaceSync）",
        "info",
        `適用=${color(pb) === target}`,
      );
      pb.remove();
      root.adoptedStyleSheets = [];
    } catch (e) {
      add("3b adoptedStyleSheets", false, String(e));
    }
    // (c) <link rel=stylesheet href=unno://ext/...>
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = extUrl("dev.spike.base", "dist/style.css");
    const loaded = new Promise<string>((resolve) => {
      link.onload = () => resolve("load");
      link.onerror = () => resolve("error");
      setTimeout(() => resolve("timeout"), 2000);
    });
    root.append(link);
    const pc = probe();
    const outcome = await loaded;
    add(
      "3c Shadow 内の <link> で unno://ext/ の CSS",
      "info",
      `${outcome}, 適用=${color(pc) === target}`,
    );
    link.remove();
    pc.remove();
    // (d) fetch して本文を adoptedStyleSheets に入れる（style-src を緩めない経路）
    try {
      const text = await (
        await fetch(extUrl("dev.spike.base", "dist/style.css"))
      ).text();
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(text);
      root.adoptedStyleSheets = [sheet];
      const pd = probe();
      add(
        "3d fetch → adoptedStyleSheets",
        "info",
        `適用=${color(pd) === target}`,
      );
    } catch (e) {
      add("3d fetch → adoptedStyleSheets", false, String(e));
    }
    // (e) 分離: Shadow 内のクラス指定が外へ漏れないか / 外の指定が中へ入らないか
    const outside = document.createElement("span");
    outside.className = "probe";
    document.body.append(outside);
    add(
      "3e 外へ漏れない",
      color(outside) !== target,
      `外の色=${color(outside)}`,
    );
    outside.remove();
    hostEl.remove();
    v.stop();
    add("3 CSP 違反の記録", "info", v.list.join(" | ") || "なし");
  }

  // 4. iframe（sandbox・postMessage・CSP）
  const frameCase = async (
    file: string,
    sandbox: string,
  ): Promise<{ messages: unknown[]; v: string[] }> => {
    const v = violations();
    const messages: unknown[] = [];
    const on = (e: MessageEvent) => {
      if (e.data && (e.data as { spike?: string }).spike === "s02")
        messages.push(e.data);
    };
    window.addEventListener("message", on);
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", sandbox);
    frame.src = extUrl("dev.spike.base", `dist/${file}`);
    frame.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px";
    document.body.append(frame);
    await new Promise((r) => setTimeout(r, 1500));
    frame.contentWindow?.postMessage({ ping: 7 }, "*");
    await new Promise((r) => setTimeout(r, 300));
    frame.remove();
    window.removeEventListener("message", on);
    v.stop();
    return { messages, v: v.list };
  };
  for (const sandbox of ["allow-scripts", "allow-scripts allow-same-origin"]) {
    try {
      const a = await frameCase("view.html", sandbox);
      add(
        `4a iframe sandbox="${sandbox}" 外部 JS の往復`,
        a.messages.length >= 2,
        `${JSON.stringify(a.messages)} violations=${a.v.join("|")}`,
      );
      const b = await frameCase("view-inline.html", sandbox);
      add(
        `4b iframe sandbox="${sandbox}" インライン script（止まるべき）`,
        !JSON.stringify(b.messages).includes("inlineRan"),
        `messages=${JSON.stringify(b.messages)}`,
      );
    } catch (e) {
      add("4 iframe", false, String(e));
    }
  }

  // 5. 例外の隔離と帰属
  for (const [label, file] of [
    ["5a import 時の例外", "throws-at-import.js"],
    ["5b 構文エラー", "syntax.js"],
  ] as const) {
    try {
      await import(/* @vite-ignore */ extUrl("dev.spike.bad", `dist/${file}`));
      add(label, false, "例外にならなかった");
    } catch (e) {
      add(label, true, `捕捉できた: ${String(e).slice(0, 80)}`);
    }
  }
  try {
    const bad = (await import(
      /* @vite-ignore */ extUrl("dev.spike.bad", "dist/index.js")
    )) as { activate: () => unknown };
    bad.activate();
    await new Promise((r) => setTimeout(r, 200));
    add(
      "5c 非同期例外の帰属（error / unhandledrejection に出所が付くか）",
      "info",
      errors.join(" | ") || "イベントなし",
    );
  } catch (e) {
    add("5c", false, String(e));
  }

  // 6. 権限の迂回（withGlobalTauri=false でも __TAURI_INTERNALS__ は見えるか）と外部通信
  try {
    const attack = (await import(
      /* @vite-ignore */ extUrl("dev.spike.bad", "dist/attack.js")
    )) as { run: () => Promise<Record<string, string>> };
    const r = await attack.run();
    add(
      "6 拡張機能の JS から Rust のコマンドを直接呼べるか / 外部通信",
      "info",
      JSON.stringify(r),
    );
  } catch (e) {
    add("6", false, String(e));
  }

  window.removeEventListener("error", onError);
  window.removeEventListener("unhandledrejection", onRejection);

  const text = rows
    .map(
      (r) =>
        `${r.ok === true ? "OK  " : r.ok === false ? "NG  " : "info"} ${r.name}: ${r.detail}`,
    )
    .join("\n");
  console.log(`[S-02]\n${text}`);
  import.meta.hot?.send("s02:report", text);
  const pre = document.createElement("pre");
  pre.style.cssText =
    "position:fixed;inset:20px;z-index:99999;overflow:auto;background:var(--color-bg);color:var(--color-fg);padding:12px;font:12px/1.4 monospace;white-space:pre-wrap;user-select:text";
  pre.textContent = text;
  pre.addEventListener("dblclick", () => pre.remove());
  document.body.append(pre);
  return text;
}
