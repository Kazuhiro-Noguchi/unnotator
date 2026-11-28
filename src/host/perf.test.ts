// @vitest-environment happy-dom
// 拡張機能ホストの性能の測定（T068）。Node（happy-dom）で測れるものだけ。
// 実機（WebView）でしか測れないものは、`specs/009-extension-host/perf.md` の「実機で測るもの」に残す。
// 結果を記録するには `node scripts/measure-extension-host.mjs`（`PERF_OUT` に Markdown を書く）。
import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { CHANNEL_LIMITS, HostChannel, inspectEnvelope } from "./channel";
import { createExtensionHost, type ExtensionInfo } from "./service";
import { createSuggestionStore, type SuggestionDraft } from "./suggestions";

const results: { name: string; value: string; limit: string; ok: boolean }[] =
  [];
function record(name: string, ms: number, limitMs: number, unit = "ms") {
  results.push({
    name,
    value: `${ms.toFixed(2)} ${unit}`,
    limit: `< ${limitMs} ${unit}`,
    ok: ms < limitMs,
  });
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function info(id: string, events: string[]): ExtensionInfo {
  return {
    id,
    version: "1.0.0",
    status: "enabled",
    manifest: JSON.stringify({
      id,
      version: "1.0.0",
      main: "dist/index.js",
      activationEvents: events,
    }),
  };
}

function makeHost(list: ExtensionInfo[]) {
  const container = document.createElement("div");
  document.body.append(container);
  const host = createExtensionHost({
    list: async () => list,
    doc: document,
    container,
    base: "unno://localhost",
    locale: () => "ja",
    handle: async () => null,
    report: () => {},
    pingIntervalMs: 0,
    deliverInit: (_el, _init, port) => {
      port.postMessage({ t: "rep", kind: "ready", v: null });
    },
  });
  return { host, container };
}

describe("性能（specs/009-extension-host/spec.md の SC）", () => {
  it("SC-001: 拡張機能 20 個で、媒体を開くまでコードを読まず、起動の増加が 200 ms 以内", async () => {
    const list = Array.from({ length: 20 }, (_, i) =>
      info(`dev.ext${i}`, [
        `onMediaType:type${i}`,
        `onCommand:dev.ext${i}.run`,
      ]),
    );
    const { host, container } = makeHost(list);
    const t0 = performance.now();
    await host.startup();
    const ms = performance.now() - t0;
    expect(container.querySelectorAll("iframe")).toHaveLength(0);
    record("SC-001 起動時の増加（20 個・onStartup なし）", ms, 200);
    expect(ms).toBeLessThan(200);
  });

  it("SC-007: 候補 5,000 件の追加・一括の採用（保存は候補なしと変わらない: DB に触れない）", async () => {
    const apply = vi.fn(async () => {});
    const store = createSuggestionStore({ apply });
    const items: SuggestionDraft[] = Array.from({ length: 5000 }, (_, i) => ({
      id: `s${i}`,
      assetId: "a1",
      itemKey: null,
      type: "dev.a/rect",
      summary: `rect ${i}`,
      selector: { x: i },
      labelId: null,
      command: { kind: "create_annotation", id: `s${i}` } as never,
    }));
    const t0 = performance.now();
    void store.add({ source: "dev.a", title: null, items });
    store.list("a1", null);
    const addMs = performance.now() - t0;
    expect(apply).not.toHaveBeenCalled();
    const t1 = performance.now();
    await store.acceptAll("a1", null);
    const acceptMs = performance.now() - t1;
    record("SC-007 候補 5,000 件の追加と一覧", addMs, 50);
    record("SC-007 候補 5,000 件の一括の採用（送るまで）", acceptMs, 100);
    expect(addMs).toBeLessThan(50);
  });

  it("SC-009: 最大の大きさのメッセージの検査で、UI が 50 ms 止まらない", () => {
    const worst = {
      t: "req",
      id: 1,
      m: "selection.get",
      a: Array.from({ length: CHANNEL_LIMITS.maxArrayLength }, () =>
        "x".repeat(90),
      ),
    };
    const t0 = performance.now();
    inspectEnvelope(worst, { methods: new Set(["selection.get"]) });
    const ms = performance.now() - t0;
    record("SC-009 最大のメッセージの検査", ms, 50);
    expect(ms).toBeLessThan(50);
  });

  it("R11-3: 枠の生成から activate 完了まで（ready の返答が即時のとき = ホスト側の費用）", async () => {
    const { host, container } = makeHost([info("dev.a", ["onStartup"])]);
    const p = host.startup();
    await tick(2);
    for (const el of container.querySelectorAll("iframe"))
      el.dispatchEvent(new Event("load"));
    const t0 = performance.now();
    await p;
    record(
      "枠の生成から ready まで（ホスト側のみ）",
      performance.now() - t0,
      50,
    );
    expect(host.manager.state("dev.a").status).toBe("active");
  });

  it("R11-3: 1 呼び出しの往復と、検査のオーバーヘッド", async () => {
    const { port1, port2 } = new MessageChannel();
    const channel = new HostChannel(port1 as never, {
      extId: "dev.a",
      methods: new Set(["selection.get"]),
      handle: async () => 1,
    });
    port2.onmessage = (event) => {
      const d = event.data as { id: number; t: string };
      if (d.t === "req")
        port2.postMessage({ t: "res", id: d.id, ok: true, v: 1 });
    };
    // 本体 → 枠の `call` ではなく、枠 → 本体の req の往復（枠の側から送って、res を受ける）を測る。
    const N = 500;
    let pendingResolve: () => void = () => {};
    let received = 0;
    const replies = new Promise<void>((r) => {
      pendingResolve = r;
    });
    port2.onmessage = () => {
      received += 1;
      if (received === N) pendingResolve();
    };
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      port2.postMessage({ t: "req", id: i, m: "selection.get", a: null });
    }
    await replies;
    const perCall = (performance.now() - t0) / N;
    record("1 呼び出しの往復（平均。MessageChannel・検査込み）", perCall, 5);

    const small = {
      t: "req",
      id: 1,
      m: "selection.get",
      a: { x: 1, y: [1, 2, 3] },
    };
    const M = 10000;
    const t1 = performance.now();
    for (let i = 0; i < M; i++)
      inspectEnvelope(small, { methods: new Set(["selection.get"]) });
    record(
      "検査 1 件のオーバーヘッド（小さなメッセージの平均）",
      (performance.now() - t1) / M,
      0.1,
    );
    channel.close();
    port2.close();
  });
});

const REAL_DEVICE = `
## 実機で測るもの（人。\`pnpm tauri dev\` ではなく、リリースビルドで）

- SC-001: 拡張機能 20 個を入れた起動時間（最初の画面まで）と、入れない場合の差が 200 ms 以内。\`node scripts/measure-startup.mjs\` と同じ手順。
- SC-002: 依存先を持つ拡張機能のエディターが、アセットを開いてから 1 秒以内に操作できる（拡張機能自体の初期化を除く）。
- SC-007: 候補 5,000 件の一覧のスクロールが 50 ms 以上止まらない（devtools の長いタスク）。保存の所要時間が候補なしと変わらない。
- SC-009: \`ext-bad\` の実行中、UI が 50 ms 以上止まらない。
- R11-3: 枠の生成から \`activate\` 完了まで（WKWebView・WebView2・WebKitGTK）。
`;

afterAll(() => {
  const out = process.env.PERF_OUT;
  if (out === undefined || out === "") return;
  const rows = results
    .map(
      (r) => `| ${r.name} | ${r.value} | ${r.limit} | ${r.ok ? "OK" : "NG"} |`,
    )
    .join("\n");
  const text = `# 009 拡張機能ホストの性能\n\n測定: ${new Date().toISOString()}（Node + happy-dom。WebView は含まない）\n\n| 項目 | 値 | 基準 | 結果 |\n| --- | --- | --- | --- |\n${rows}\n${REAL_DEVICE}`;
  writeFileSync(out, text);
});
