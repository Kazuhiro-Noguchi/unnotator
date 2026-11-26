// @vitest-environment happy-dom
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import type { AssetRow } from "../../ipc";
import { createCurrentStore } from "../explorer/current";
import { FakeEmitter } from "../testing/fakes";
import { EditorArea } from "./EditorArea";

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

function row(
  id: string,
  path: string,
  patch: Partial<AssetRow> = {},
): AssetRow {
  return {
    id,
    root_key: "",
    rel_path: path,
    media_type: null,
    file_size: 10,
    mtime_ms: 1,
    status: "todo",
    missing: false,
    ...patch,
  };
}

function setup(
  assets: AssetRow[],
  extra: Partial<Parameters<typeof EditorArea>[0]> = {},
) {
  const current = createCurrentStore();
  const changed = new FakeEmitter<void>();
  const store = new Map(assets.map((a) => [a.id, a]));
  const getAsset = vi.fn(async (id: string) => store.get(id) ?? null);
  const onOpenExternal = vi.fn();
  const onRelink = vi.fn();
  dispose = render(
    () => (
      <EditorArea
        current={current}
        getAsset={getAsset}
        onChanged={(handler) => changed.listen(handler)}
        onOpenExternal={onOpenExternal}
        onRelink={onRelink}
        {...extra}
      />
    ),
    document.body,
  );
  return { current, changed, store, getAsset, onOpenExternal, onRelink };
}

const open = (
  s: ReturnType<typeof setup>,
  id: string,
  mediaType: string | null = null,
) => s.current.open({ assetId: id, itemKey: null, mediaType });

describe("EditorArea（部品）", () => {
  it("何も開いていなければ、空の状態の案内", async () => {
    setup([]);
    await wait();
    expect(document.querySelector(".empty-state")?.textContent).toContain(
      t("empty.editor"),
    );
    expect(document.querySelector("main")?.getAttribute("data-region")).toBe(
      "editor",
    );
  });

  it("エディターが無ければ、汎用プレビューを出す", async () => {
    const s = setup([row("a1", "photo.png")]);
    open(s, "a1");
    await wait();
    expect(document.querySelector("img.preview-image")).not.toBeNull();
    expect(document.querySelector(".empty-state")).toBeNull();
  });

  it("エディターの差し込み口が表示を返したら、プレビューの代わりに使う", async () => {
    const s = setup([row("a1", "photo.png")], {
      resolveSurface: (asset) => <div class="my-editor">{asset.id}</div>,
    });
    open(s, "a1");
    await wait();
    expect(document.querySelector(".my-editor")?.textContent).toBe("a1");
    expect(document.querySelector(".preview")).toBeNull();
  });

  it("差し込み口が null を返したら、プレビューに落ちる", async () => {
    const s = setup([row("a1", "photo.png")], { resolveSurface: () => null });
    open(s, "a1");
    await wait();
    expect(document.querySelector(".preview")).not.toBeNull();
  });

  it("開いたままのアセットがリンク切れに変わると、案内に切り替わる", async () => {
    const s = setup([row("a1", "photo.png")]);
    open(s, "a1");
    await wait();
    s.store.set("a1", row("a1", "photo.png", { missing: true }));
    s.changed.emit();
    await wait();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector(".preview-fallback")?.textContent).toContain(
      t("preview.missing"),
    );
  });

  it("別のアセットへ素早く切り替えたとき、古い取得の結果で上書きしない", async () => {
    let releaseSlow: (() => void) | undefined;
    const slow = row("slow", "slow.pdf");
    const fast = row("fast", "fast.png");
    const current = createCurrentStore();
    const getAsset = vi.fn(
      (id: string) =>
        new Promise<AssetRow | null>((resolve) => {
          if (id === "slow") releaseSlow = () => resolve(slow);
          else resolve(fast);
        }),
    );
    dispose = render(
      () => (
        <EditorArea
          current={current}
          getAsset={getAsset}
          onChanged={() => () => {}}
          onOpenExternal={() => {}}
          onRelink={() => {}}
        />
      ),
      document.body,
    );
    current.open({ assetId: "slow", itemKey: null, mediaType: null });
    await wait();
    current.open({ assetId: "fast", itemKey: null, mediaType: null });
    await wait();
    releaseSlow?.();
    await wait();
    expect(document.querySelector("img.preview-image")).not.toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("開いていたアセットが無くなったら（削除）、空の状態に戻る", async () => {
    const s = setup([row("a1", "photo.png")]);
    open(s, "a1");
    await wait();
    s.store.delete("a1");
    s.changed.emit();
    await wait();
    expect(document.querySelector(".empty-state")).not.toBeNull();
  });

  it("プロジェクトを閉じて現在位置が消えたら、空の状態に戻る", async () => {
    const s = setup([row("a1", "photo.png")]);
    open(s, "a1");
    await wait();
    s.current.clear();
    await wait();
    expect(document.querySelector(".empty-state")).not.toBeNull();
    expect(document.querySelector(".preview")).toBeNull();
  });

  it("プレビューの操作を、アセットの ID つきで外へ渡す", async () => {
    const s = setup([row("a1", "data.zzz")]);
    open(s, "a1");
    await wait();
    document
      .querySelector<HTMLButtonElement>("button[data-preview-external]")
      ?.click();
    expect(s.onOpenExternal).toHaveBeenCalledWith("a1");
  });

  it("アセットを開くたびに、そのアセットを 1 回ずつ取得する", async () => {
    const s = setup([row("a1", "a.png"), row("a2", "b.png")]);
    open(s, "a1");
    await wait();
    open(s, "a2");
    await wait();
    expect(s.getAsset).toHaveBeenCalledTimes(2);
  });
});
