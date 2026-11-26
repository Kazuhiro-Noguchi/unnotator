// エクスプローラーの画面側の計測（開発ビルドだけ）。10 万件のプロジェクトを開いて、パレットから実行する。
// 結果は通知とコンソールに出す。`specs/007-tree-preview/perf.md` に書き写す（SC-001・002・004・007）。

export interface Stats {
  count: number;
  median: number;
  max: number;
}

export function summarize(values: readonly number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length === 0
      ? 0
      : sorted.length % 2 === 1
        ? (sorted[mid] ?? 0)
        : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return { count: sorted.length, median, max: sorted.at(-1) ?? 0 };
}

async function time<T>(run: () => Promise<T>): Promise<number> {
  const started = performance.now();
  await run();
  return performance.now() - started;
}

/** ツリーを端から端まで、見える範囲ずつ取り、取得の時間と、50ms を超える長いタスクの数を測る。 */
export async function measureScroll(): Promise<{
  fetch: Stats;
  longTasks: number;
}> {
  const { explorer } = await import("../explorer/instance");
  let longTasks = 0;
  const observer = new PerformanceObserver((list) => {
    longTasks += list.getEntries().filter((e) => e.duration > 50).length;
  });
  try {
    observer.observe({ entryTypes: ["longtask"] });
  } catch {
    // 非対応の環境では、長いタスクは数えない。
  }
  const total = explorer.rows.total();
  const times: number[] = [];
  for (let start = 0; start < total; start += 30) {
    times.push(
      await time(() => explorer.controller.setViewport(start, start + 30)),
    );
  }
  observer.disconnect();
  return { fetch: summarize(times), longTasks };
}

/** 「次へ」から現在位置が更新されるまで。 */
export async function measureNext(runs = 100): Promise<Stats> {
  const { navPorts } = await import("../explorer/instance");
  const { navigate } = await import("../explorer/nav");
  const times: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    times.push(await time(() => navigate(navPorts, "next", false)));
  }
  return summarize(times);
}

/** 先頭が `large` のテキスト（サンプルの 11MB）を読んで表示できるまで。 */
export async function measureLargeText(): Promise<number | null> {
  const { commands } = await import("../../ipc");
  const { loadTextHead } = await import("../../preview/text");
  const { assetUrl } = await import("../../preview/url");
  const page = await commands.assetList(
    {
      root_key: null,
      path_prefix: null,
      media_type: { kind: "any" },
      status: null,
      missing: null,
    },
    { limit: 50_000, after: null },
  );
  const target = page.items.find((a) => a.rel_path.endsWith("large.txt"));
  if (!target) return null;
  return time(() => loadTextHead({ url: assetUrl(target.id) }));
}

export async function measureAll(): Promise<string> {
  const { explorer } = await import("../explorer/instance");
  const scroll = await measureScroll();
  const next = await measureNext();
  const large = await measureLargeText();
  const text = [
    `行 ${explorer.rows.total()}`,
    `スクロールの取得 中央値 ${scroll.fetch.median.toFixed(1)}ms 最大 ${scroll.fetch.max.toFixed(1)}ms 長いタスク ${scroll.longTasks} 件`,
    `次へ 中央値 ${next.median.toFixed(1)}ms 最大 ${next.max.toFixed(1)}ms`,
    `10MB のテキスト ${large === null ? "（large.txt が無い）" : `${large.toFixed(0)}ms`}`,
  ].join(" / ");
  console.info(`[measure-explorer] ${text}`);
  return text;
}
