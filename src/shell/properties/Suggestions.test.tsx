// @vitest-environment happy-dom
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import { Suggestions } from "./Suggestions";
import type { SuggestionRowView, SuggestionsSource } from "./suggestions-view";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

const row = (id: string): SuggestionRowView => ({
  id,
  type: "com.example.a/rect",
  summary: `summary ${id}`,
  source: "com.example.a",
  title: null,
});

function fakeSource(initial: SuggestionRowView[]) {
  let rows = initial;
  const listeners = new Set<() => void>();
  const source = {
    list: vi.fn(() => rows),
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    accept: vi.fn(async (ids: string[]) => {
      rows = rows.filter((r) => !ids.includes(r.id));
      for (const l of listeners) l();
      return ids;
    }),
    acceptAll: vi.fn(async () => {
      rows = [];
      for (const l of listeners) l();
      return [];
    }),
    reject: vi.fn((ids: string[]) => {
      rows = rows.filter((r) => !ids.includes(r.id));
      for (const l of listeners) l();
    }),
    rejectAll: vi.fn(),
  } satisfies SuggestionsSource;
  return source;
}

function mount(source: SuggestionsSource, notify = vi.fn()) {
  dispose = render(
    () => (
      <Suggestions
        source={source}
        assetId="a1"
        itemKey={null}
        nameOf={(id) => id}
        notify={notify}
      />
    ),
    document.body,
  );
  return notify;
}

const items = () => [...document.querySelectorAll(".suggestion-item")];

describe("候補の表示（FR-025）", () => {
  it("候補がなければ何も出さない", () => {
    mount(fakeSource([]));
    expect(document.querySelector(".suggestions")).toBeNull();
  });

  it("候補は、通常のアノテーションと違うクラスで出る。要約と件数が見える", () => {
    mount(fakeSource([row("s1"), row("s2")]));
    expect(items()).toHaveLength(2);
    expect(document.querySelector(".annotation-item")).toBeNull();
    expect(document.body.textContent).toContain("summary s1");
    expect(document.body.textContent).toContain(t("suggestions.title"));
  });

  it("5,000 件でも、描く行は見える範囲の前後だけ（仮想スクロール。SC-007）", () => {
    const many = Array.from({ length: 5000 }, (_, i) => row(`s${i}`));
    mount(fakeSource(many));
    expect(items().length).toBeLessThan(60);
    const body = document.querySelector<HTMLElement>(".suggestion-body");
    expect(body?.style.height).toBe(`${5000 * 32}px`);
  });
});

describe("採用 / 却下の操作（FR-026）", () => {
  it("個別の採用は、その ID だけ。済んだら一覧から消える", async () => {
    const source = fakeSource([row("s1"), row("s2")]);
    mount(source);
    document
      .querySelector<HTMLButtonElement>(
        `.suggestion-item button[aria-label="${t("suggestions.accept")}"]`,
      )
      ?.click();
    await flush();
    expect(source.accept).toHaveBeenCalledWith(["s1"]);
    expect(items()).toHaveLength(1);
  });

  it("個別の却下は、その ID だけ", async () => {
    const source = fakeSource([row("s1"), row("s2")]);
    mount(source);
    document
      .querySelector<HTMLButtonElement>(
        `.suggestion-item button[aria-label="${t("suggestions.reject")}"]`,
      )
      ?.click();
    await flush();
    expect(source.reject).toHaveBeenCalledWith(["s1"]);
  });

  it("一括の採用・却下は、この対象の全部", async () => {
    const source = fakeSource([row("s1"), row("s2")]);
    mount(source);
    const buttons = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".suggestions-actions button",
      ),
    ];
    const byText = (text: string) =>
      buttons.find((b) => b.textContent === text);
    byText(t("suggestions.rejectAll"))?.click();
    expect(source.rejectAll).toHaveBeenCalledWith("a1", null);
    byText(t("suggestions.acceptAll"))?.click();
    await flush();
    expect(source.acceptAll).toHaveBeenCalledWith("a1", null);
  });

  it("採用している間は、押せない（グレーアウト）。二重に送らない", async () => {
    let release: () => void = () => {};
    const source = fakeSource([row("s1")]);
    source.acceptAll.mockImplementation(
      () =>
        new Promise<never[]>((resolve) => {
          release = () => resolve([]);
        }),
    );
    mount(source);
    const accept = () =>
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".suggestions-actions button",
        ),
      ].find((b) => b.textContent === t("suggestions.acceptAll"));
    accept()?.click();
    await flush();
    expect(accept()?.disabled).toBe(true);
    accept()?.click();
    expect(source.acceptAll).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(accept()?.disabled).toBe(false);
  });

  it("採用に失敗したら通知する。候補は残る", async () => {
    const source = fakeSource([row("s1")]);
    source.acceptAll.mockRejectedValue(new Error("revoked"));
    const notify = mount(source);
    [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".suggestions-actions button",
      ),
    ]
      .find((b) => b.textContent === t("suggestions.acceptAll"))
      ?.click();
    await flush();
    expect(notify).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("revoked"),
    );
    expect(items()).toHaveLength(1);
  });
});
