// プロパティパネルの計測（開発ビルドだけ）。プロジェクトを開いて、アセットを 1 つ開いた状態でパレットから実行する。
// 1 つのアセットに 5,000 件のアノテーションを作り（元に戻せる 1 つの操作）、現在位置の読み込みと一覧の読み込みを測る
// （SC-003・SC-004）。結果は通知とコンソールに出す。`specs/008-properties-labels/perf.md` に書き写す。
import { summarize } from "./measure-explorer";

const COUNT = 5000;

async function time<T>(run: () => Promise<T>): Promise<number> {
  const started = performance.now();
  await run();
  return performance.now() - started;
}

export async function measureProperties(): Promise<string> {
  const { explorer } = await import("../explorer/instance");
  const { projectData } = await import("../project-data/instance");
  const { loadAllPages } = await import("../properties/paging");
  const target = explorer.current.get();
  if (target === null) return "アセットを開いてから実行してください";

  const create = await time(() =>
    projectData.apply({
      kind: "transaction",
      commands: Array.from({ length: COUNT }, (_, i) => ({
        kind: "create_annotation",
        target: { asset_id: target.assetId, item: null },
        type: "dev/measure",
        selector_json: "{}",
        summary: `measure ${i}`,
      })),
    }),
  );
  const details: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    details.push(await time(() => projectData.refresh()));
  }
  const pages = await time(() =>
    loadAllPages(
      (cursor) => projectData.annotationsPage(cursor),
      () => true,
    ),
  );
  const d = summarize(details);
  const text = [
    `${COUNT} 件の作成 ${create.toFixed(0)}ms`,
    `詳細の読み込み 中央値 ${d.median.toFixed(1)}ms 最大 ${d.max.toFixed(1)}ms`,
    `一覧の全ページ ${pages.toFixed(0)}ms`,
    "（元に戻す 1 回で、作ったアノテーションが消える）",
  ].join(" / ");
  console.info(`[measure-properties] ${text}`);
  return text;
}
