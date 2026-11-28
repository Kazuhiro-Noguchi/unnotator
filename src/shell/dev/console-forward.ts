// 開発時だけ: 画面のエラーと console を、開発サーバーへ送る（config/vite.config.ts が UNNO_DEV_CONSOLE に書く）。
// 実機（WebView）の中のエラーを、開発者ツールを開かずに読むための補助。製品のビルドには含まれない。
export function forwardConsole(): void {
  const hot = import.meta.hot;
  if (!import.meta.env.DEV || hot === undefined) return;
  const send = (kind: string, ...parts: unknown[]) => {
    const text = parts
      .map((p) =>
        p instanceof Error ? `${p.message}\n${p.stack ?? ""}` : String(p),
      )
      .join(" ");
    try {
      hot.send("dev:log", `[${new Date().toISOString()}] ${kind} ${text}`);
    } catch {
      // 送れなくても、画面には影響させない。
    }
  };
  window.addEventListener("error", (e) =>
    send("error", e.message, e.error ?? "", `${e.filename}:${e.lineno}`),
  );
  window.addEventListener("unhandledrejection", (e) =>
    send("unhandledrejection", e.reason ?? ""),
  );
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      send(level, ...args);
      original(...args);
    };
  }
  send("boot", "console forwarding on");
}
