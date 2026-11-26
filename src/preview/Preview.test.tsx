// @vitest-environment happy-dom
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../i18n";
import type { AssetRow } from "../ipc";
import { Preview } from "./Preview";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const wait = async () => {
  for (let i = 0; i < 5; i += 1) await flush();
};

function asset(path: string, patch: Partial<AssetRow> = {}): AssetRow {
  return {
    id: `id-${path}`,
    root_key: "",
    rel_path: path,
    media_type: null,
    file_size: 2048,
    mtime_ms: Date.UTC(2026, 10, 26, 12, 0, 0),
    status: "todo",
    missing: false,
    ...patch,
  };
}

function okFetch(text: string, options: { total?: number } = {}) {
  const bytes = new TextEncoder().encode(text);
  const calls: string[] = [];
  const fetchFn = vi.fn(
    async (_url: string, init?: { headers?: Record<string, string> }) => {
      calls.push(init?.headers?.Range ?? "");
      return new Response(bytes as unknown as BodyInit, {
        status: 206,
        headers: {
          "Content-Range": `bytes 0-${bytes.length - 1}/${options.total ?? bytes.length}`,
        },
      });
    },
  );
  return { fetchFn, calls };
}

function mount(
  getAsset: () => AssetRow,
  props: Partial<Parameters<typeof Preview>[0]> = {},
) {
  const onOpenExternal = vi.fn();
  const onRelink = vi.fn();
  dispose = render(
    () => (
      <Preview
        asset={getAsset()}
        onOpenExternal={onOpenExternal}
        onRelink={onRelink}
        pdfSupported={true}
        {...props}
      />
    ),
    document.body,
  );
  return { onOpenExternal, onRelink };
}

describe("Preview（部品）", () => {
  it("画像を、<img> で表示する", async () => {
    mount(() => asset("a/photo.png"));
    await wait();
    const img = document.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toContain("asset/");
    expect(document.querySelector(".preview-fallback")).toBeNull();
  });

  it("画像が壊れていたら、案内と「既定のアプリで開く」を出す", async () => {
    const { onOpenExternal } = mount(() => asset("a/broken.png"));
    await wait();
    document.querySelector("img")?.dispatchEvent(new Event("error"));
    await wait();
    const fallback = document.querySelector(".preview-fallback");
    expect(fallback?.textContent).toContain(t("preview.imageFailed"));
    document
      .querySelector<HTMLButtonElement>("button[data-preview-external]")
      ?.click();
    expect(onOpenExternal).toHaveBeenCalledTimes(1);
  });

  it("UTF-8 のテキストを、文字として表示する", async () => {
    const { fetchFn } = okFetch("line one\n日本語の行\n");
    mount(() => asset("notes.txt"), { fetchFn });
    await wait();
    const text = document.querySelector(".preview-text");
    expect(text?.textContent).toContain("line one");
    expect(text?.textContent).toContain("日本語の行");
    expect(document.querySelector(".preview-note")).toBeNull();
  });

  it("10MB を超えるテキストでは、先頭だけだと案内する", async () => {
    // Range に応じた長さを返す（実際のサーバーと同じ。1 応答は 4 MiB まで）。
    const total = 11 * 1024 * 1024;
    const fetchFn = vi.fn(
      async (_url: string, init?: { headers?: Record<string, string> }) => {
        const match = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? "");
        const start = Number(match?.[1] ?? 0);
        const end = Math.min(
          Number(match?.[2] ?? 0),
          total - 1,
          start + 4 * 1024 * 1024 - 1,
        );
        return new Response(
          new Uint8Array(end - start + 1).fill(0x61) as unknown as BodyInit,
          {
            status: 206,
            headers: { "Content-Range": `bytes ${start}-${end}/${total}` },
          },
        );
      },
    );
    mount(() => asset("big.txt"), { fetchFn });
    await wait();
    expect(document.querySelector(".preview-note")?.textContent).toContain(
      t("preview.truncated"),
    );
  });

  it("UTF-8 ではないテキストは、案内と「既定のアプリで開く」", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          new Uint8Array([0x63, 0xe9, 0x0a]) as unknown as BodyInit,
          { status: 206, headers: { "Content-Range": "bytes 0-2/3" } },
        ),
    );
    mount(() => asset("latin.txt"), { fetchFn });
    await wait();
    const fallback = document.querySelector(".preview-fallback");
    expect(fallback?.textContent).toContain(t("preview.notUtf8"));
    expect(
      document.querySelector("button[data-preview-external]"),
    ).not.toBeNull();
  });

  it("テキストの内容は、文字として描く（タグやスクリプトを解釈しない）", async () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const { fetchFn } = okFetch(hostile);
    mount(() => asset("evil.txt"), { fetchFn });
    await wait();
    expect(document.querySelector(".preview-text img")).toBeNull();
    expect(document.querySelector(".preview-text script")).toBeNull();
    expect(document.querySelector(".preview-text")?.textContent).toContain(
      hostile,
    );
  });

  it("読み込みに失敗したら、案内を出す（例外にしない）", async () => {
    const fetchFn = vi.fn(async () => new Response("x", { status: 500 }));
    mount(() => asset("a.txt"), { fetchFn });
    await wait();
    expect(document.querySelector(".preview-fallback")?.textContent).toContain(
      t("preview.readFailed"),
    );
  });

  it("PDF を、<iframe> で表示する（表示できる環境）", async () => {
    mount(() => asset("manual.pdf"));
    await wait();
    const frame = document.querySelector("iframe");
    expect(frame?.getAttribute("src")).toContain("asset/");
    expect(frame?.getAttribute("title")).toBeTruthy();
  });

  it("PDF を表示できない環境では、案内に落とす", async () => {
    mount(() => asset("manual.pdf"), { pdfSupported: false });
    await wait();
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector(".preview-fallback")?.textContent).toContain(
      t("preview.noPdf"),
    );
  });

  it("不明な形式は、ファイル情報・案内・「既定のアプリで開く」", async () => {
    const { onOpenExternal } = mount(() =>
      asset("data.zzz", { file_size: 2048 }),
    );
    await wait();
    const fallback = document.querySelector(".preview-fallback");
    expect(fallback?.textContent).toContain("data.zzz");
    expect(fallback?.textContent).toContain("2.0 KB");
    expect(fallback?.textContent).toContain(t("preview.unknownFormat"));
    document
      .querySelector<HTMLButtonElement>("button[data-preview-external]")
      ?.click();
    expect(onOpenExternal).toHaveBeenCalled();
  });

  it("リンク切れは、プレビューを出さず、再接続の案内を出す", async () => {
    const { onRelink } = mount(() => asset("gone.png", { missing: true }));
    await wait();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector(".preview-fallback")?.textContent).toContain(
      t("preview.missing"),
    );
    document
      .querySelector<HTMLButtonElement>("button[data-preview-relink]")
      ?.click();
    expect(onRelink).toHaveBeenCalled();
    expect(document.querySelector("button[data-preview-external]")).toBeNull();
  });

  it("開いたままのアセットがリンク切れに変わると、案内に切り替わる", async () => {
    const { createSignal } = await import("solid-js");
    const [current, setCurrent] = createSignal(asset("a/photo.png"));
    mount(current);
    await wait();
    expect(document.querySelector("img")).not.toBeNull();
    setCurrent(asset("a/photo.png", { missing: true }));
    await wait();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector(".preview-fallback")?.textContent).toContain(
      t("preview.missing"),
    );
  });

  it("素早く切り替えたとき、古い読み込みの結果で新しい表示を上書きしない", async () => {
    const { createSignal } = await import("solid-js");
    let release: (() => void) | undefined;
    const slow = vi.fn(
      (url: string) =>
        new Promise<Response>((resolve) => {
          release = () =>
            resolve(
              new Response(
                new TextEncoder().encode(
                  url.includes("slow") ? "OLD CONTENT" : "x",
                ) as unknown as BodyInit,
                {
                  status: 206,
                  headers: { "Content-Range": "bytes 0-10/11" },
                },
              ),
            );
        }),
    );
    const [current, setCurrent] = createSignal(asset("slow.txt"));
    mount(current, { fetchFn: slow });
    await wait();
    setCurrent(asset("photo.png"));
    await wait();
    release?.();
    await wait();
    expect(document.querySelector("img")).not.toBeNull();
    expect(document.body.textContent).not.toContain("OLD CONTENT");
  });

  it("プレビューを操作しても、アセットのデータは変わらない（読むだけ）", async () => {
    const fetchFn = okFetch("abc").fetchFn;
    const row = asset("a.txt");
    const before = JSON.stringify(row);
    mount(() => row, { fetchFn });
    await wait();
    expect(JSON.stringify(row)).toBe(before);
    for (const call of fetchFn.mock.calls) {
      expect(String(call[0])).toContain("asset/");
    }
  });

  it("長いテキストは、見える行だけを描く", async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `row ${i}`).join("\n");
    const { fetchFn } = okFetch(lines);
    mount(() => asset("long.txt"), { fetchFn });
    await wait();
    const rendered = document.querySelectorAll(".preview-line").length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(200);
  });
});
