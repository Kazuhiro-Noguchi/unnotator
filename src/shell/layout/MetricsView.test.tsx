// @vitest-environment happy-dom
import { render } from "solid-js/web";
import { beforeEach, describe, expect, it } from "vitest";
import { createMetrics } from "../../host/metrics";
import { setLanguage } from "../../i18n";
import { MetricsView } from "./MetricsView";

describe("MetricsView（開発者モードの計測）", () => {
  beforeEach(() => setLanguage("ja"));

  it("計測が無いときは案内を出す", () => {
    const el = document.createElement("div");
    const dispose = render(() => <MetricsView metrics={createMetrics()} />, el);
    expect(el.textContent).toContain("計測はまだありません");
    dispose();
  });

  it("拡張機能ごとの行を出し、変化に追従する", () => {
    const metrics = createMetrics();
    const el = document.createElement("div");
    const dispose = render(() => <MetricsView metrics={metrics} />, el);
    metrics.recordActivation("a.b", 12);
    metrics.recordCall("a.b", "x", 10, true);
    metrics.recordCall("a.b", "x", 70, false);
    const row = el.querySelector("tbody tr");
    expect(row?.textContent).toContain("a.b");
    const cells = [...(row?.querySelectorAll("td") ?? [])].map(
      (c) => c.textContent,
    );
    expect(cells).toEqual(["a.b", "12", "2", "40", "70", "1", "1"]);
    dispose();
  });
});
