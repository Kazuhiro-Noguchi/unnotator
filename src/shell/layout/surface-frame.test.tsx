// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SurfaceHandle,
  SurfaceOpener,
  SurfaceOpenRequest,
  SurfaceState,
} from "../../host/placement-frame";
import { format, t } from "../../i18n";
import { SurfaceFrame } from "./SurfaceFrame";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Opened {
  request: SurfaceOpenRequest;
  handle: SurfaceHandle & {
    disposed: number;
    emitted: Array<[string, unknown]>;
  };
  iframe: HTMLIFrameElement;
}

function fakeOpener() {
  const opened: Opened[] = [];
  const opener: SurfaceOpener = {
    open(request) {
      const iframe = document.createElement("iframe");
      request.container.append(iframe);
      const handle = {
        disposed: 0,
        emitted: [] as Array<[string, unknown]>,
        dispose() {
          handle.disposed += 1;
          iframe.remove();
        },
        emit(key: string, value: unknown) {
          handle.emitted.push([key, value]);
        },
      };
      opened.push({ request, handle, iframe });
      return handle;
    },
  };
  return { opener, opened };
}

const request = {
  extensionId: "x.ext",
  surfaceId: "x.ext/main",
  role: "editor" as const,
  entry: "dist/editor.js",
  ctx: { asset: { id: "a1" } },
};

function mount(
  opener: SurfaceOpener,
  extra: Partial<Parameters<typeof SurfaceFrame>[0]> = {},
) {
  dispose = render(
    () => (
      <SurfaceFrame opener={opener} request={request} name="Ext" {...extra} />
    ),
    document.body,
  );
}

const state = (o: Opened, s: SurfaceState) => o.request.onState(s);

describe("SurfaceFrame（画面の枠の配置）", () => {
  it("開くたびに画面の枠を 1 つ作り、枠の入れ物（surface-frame）の中に置く", async () => {
    const { opener, opened } = fakeOpener();
    mount(opener);
    await flush();
    expect(opened).toHaveLength(1);
    expect(opened[0]?.request).toMatchObject({
      extensionId: "x.ext",
      surfaceId: "x.ext/main",
      role: "editor",
      entry: "dist/editor.js",
      ctx: { asset: { id: "a1" } },
    });
    const wrapper = document.querySelector(".surface-frame");
    expect(wrapper).not.toBeNull();
    expect(wrapper?.contains(opened[0]?.iframe ?? null)).toBe(true);
    expect(opened[0]?.request.container).toBe(wrapper);
  });

  it("閉じる（表示から外れる）と、枠を確実に取り除く", async () => {
    const { opener, opened } = fakeOpener();
    mount(opener);
    await flush();
    dispose?.();
    dispose = undefined;
    expect(opened[0]?.handle.disposed).toBe(1);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("枠が読み込めなければ、枠を取り除き、案内と再読み込みを出して、失敗を知らせる", async () => {
    const { opener, opened } = fakeOpener();
    const onFailed = vi.fn();
    mount(opener, { onFailed });
    await flush();
    const first = opened[0] as Opened;
    state(first, { kind: "failed", message: "boom" });
    await flush();
    expect(onFailed).toHaveBeenCalledWith("boom");
    expect(first.handle.disposed).toBe(1);
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector(".surface-notice")?.textContent).toContain(
      t("host.frame.loadFailed"),
    );
    // 再読み込みで、新しい枠を作る
    const retry = document.querySelector(
      ".surface-notice button",
    ) as HTMLButtonElement;
    expect(retry.textContent).toBe(t("host.frame.retry"));
    retry.click();
    await flush();
    expect(opened).toHaveLength(2);
    expect(document.querySelector(".surface-notice")).toBeNull();
  });

  it("拡張機能が無効になって枠が外されたら、案内に置き換わる（例外を出さない）", async () => {
    const { opener, opened } = fakeOpener();
    mount(opener);
    await flush();
    state(opened[0] as Opened, { kind: "removed" });
    await flush();
    expect(document.querySelector(".surface-notice")?.textContent).toContain(
      format(t("host.frame.stopped"), { name: "Ext" }),
    );
    expect(document.querySelector(".surface-frame")).not.toBeNull();
  });

  it("準備ができたら、読み込み中の印を消す", async () => {
    const { opener, opened } = fakeOpener();
    mount(opener);
    await flush();
    const wrapper = document.querySelector(".surface-frame");
    expect(wrapper?.getAttribute("data-state")).toBe("loading");
    state(opened[0] as Opened, { kind: "ready" });
    await flush();
    expect(wrapper?.getAttribute("data-state")).toBe("ready");
  });

  it("入れ物は、枠が外へはみ出さない・重ならないようにする規則を持つ", () => {
    const css = readFileSync("src/shell/shell.css", "utf8");
    const rule = /\.surface-frame\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/position:\s*relative/);
    expect(rule).toMatch(/overflow:\s*(hidden|clip)/);
    expect(rule).toMatch(/contain:\s*[^;]*paint/);
    expect(rule).toMatch(/isolation:\s*isolate/);
    expect(rule).not.toMatch(/z-index/);
    const frameRule =
      /\.surface-frame\s*>\s*iframe\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(frameRule).toMatch(/width:\s*100%/);
    expect(frameRule).toMatch(/height:\s*100%/);
    expect(frameRule).not.toMatch(/position:\s*(fixed|absolute)/);
    expect(frameRule).not.toMatch(/z-index/);
  });
});
