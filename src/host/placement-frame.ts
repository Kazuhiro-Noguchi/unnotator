// 画面の枠（エディター・ビュー・プレビュー）を、開くたびに作る（FR-008・FR-009）。
// 画面の部品（`SurfaceFrame`）は `SurfaceOpener` だけを知る。枠の生成・テーマの受け渡し・後片付けはここ。
import type { Frame, FrameManager } from "./frames";

export type SurfaceRole = "editor" | "view" | "preview";

export type SurfaceState =
  | { kind: "ready" }
  | { kind: "failed"; message: string }
  /** 拡張機能の無効化などで、外から枠が取り除かれた。 */
  | { kind: "removed" };

export interface SurfaceOpenRequest {
  extensionId: string;
  /** 画面の完全な名前（`<拡張機能の ID>/<局所名>`）。 */
  surfaceId: string;
  role: SurfaceRole;
  /** 画面用モジュール（拡張機能のフォルダからの相対パス）。 */
  entry: string;
  /** `EditorContext` などの、`container` 以外（`asset`・`itemKey`）。 */
  ctx: Record<string, unknown>;
  container: HTMLElement;
  onState(state: SurfaceState): void;
}

export interface SurfaceHandle {
  /** 画面を閉じる。枠に `dispose` を呼んでから取り除く。`onState` は呼ばない。 */
  dispose(): void;
  /** 写し・イベントを枠へ押し込む（`visibility` など）。 */
  emit(key: string, value: unknown): void;
}

export interface SurfaceOpener {
  open(request: SurfaceOpenRequest): SurfaceHandle;
}

/** 枠へ渡すテーマの色の変数（`src/themes/light.css` の名前。テストで足し忘れを検出する）。 */
export const THEME_VARIABLE_NAMES: readonly string[] = [
  "--color-bg",
  "--color-fg",
  "--color-fg-muted",
  "--color-fg-disabled",
  "--color-border",
  "--color-surface",
  "--color-surface-low",
  "--color-island",
  "--color-frame",
  "--color-surface-hover",
  "--color-surface-active",
  "--color-surface-high",
  "--color-outline",
  "--color-inverse-surface",
  "--color-inverse-fg",
  "--color-accent",
  "--color-accent-fg",
  "--color-selection",
  "--color-on-selection",
  "--color-danger",
  "--color-warning",
  "--color-info",
  "--color-success",
  "--color-focus",
  "--color-backdrop",
  "--color-shadow",
];

/** 文書に効いているテーマの色の変数を読む（空のものは含めない）。 */
export function readThemeVariables(doc: Document): Record<string, string> {
  const view = doc.defaultView;
  const styles = view?.getComputedStyle(doc.documentElement);
  const inline = doc.documentElement.style;
  const out: Record<string, string> = {};
  for (const name of THEME_VARIABLE_NAMES) {
    const value = (
      styles?.getPropertyValue(name) || inline.getPropertyValue(name)
    ).trim();
    if (value !== "") out[name] = value;
  }
  return out;
}

/** テーマの切り替え（`data-theme` の変化）を見張る。解除する関数を返す。 */
export function observeThemeAttribute(
  doc: Document,
  listener: () => void,
): () => void {
  const View = doc.defaultView?.MutationObserver;
  if (View === undefined) return () => {};
  const observer = new View(listener);
  observer.observe(doc.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "class"],
  });
  return () => observer.disconnect();
}

export interface SurfaceOpenerDeps {
  frames: FrameManager;
  /** `unno://localhost` または `http://unno.localhost` */
  base: string;
  locale(): string;
  versionOf(extensionId: string): string;
  themeVariables(): Record<string, string>;
  observeTheme(listener: () => void): () => void;
  /** 写しの初期値（選択・有効なラベル・現在のアセットなど）。 */
  mirror?(): Record<string, unknown>;
  /** 準備（`ready`）を待つ時間。既定は 30 秒。 */
  readyTimeoutMs?: number;
}

const DEFAULT_MIRROR = {
  selection: [],
  "labels.active": null,
  settings: {},
  "assets.current": null,
  "tools.active": null,
};

/** 拡張機能のフォルダの外を指せない URL にする（先頭の `/` と `..` の成分を落とす）。 */
export function entryUrl(base: string, id: string, entry: string): string {
  const path = entry
    .split("/")
    .filter((part) => part !== "" && part !== "." && part !== "..")
    .join("/");
  return `${base}/ext/${id}/${path}`;
}

export function createSurfaceOpener(deps: SurfaceOpenerDeps): SurfaceOpener {
  const timeoutMs = deps.readyTimeoutMs ?? 30_000;
  return {
    open(request) {
      let disposed = false;
      let ready = false;
      let settled = false;
      const notify = (state: SurfaceState) => {
        if (disposed) return;
        request.onState(state);
      };
      const fail = (message: string) => {
        if (settled || disposed) return;
        settled = true;
        notify({ kind: "failed", message });
      };
      const timer = setTimeout(
        () => fail("surface did not become ready"),
        timeoutMs,
      );

      const frame: Frame = deps.frames.create({
        extensionId: request.extensionId,
        role: request.role,
        container: request.container,
        init: {
          ext: {
            id: request.extensionId,
            version: deps.versionOf(request.extensionId),
            path: "",
          },
          url: entryUrl(deps.base, request.extensionId, request.entry),
          locale: deps.locale(),
          messages: {},
          theme: deps.themeVariables(),
          mirror: deps.mirror?.() ?? { ...DEFAULT_MIRROR },
          ctx: request.ctx,
        },
        onReport: (kind, value) => {
          if (kind === "ready") {
            clearTimeout(timer);
            if (settled) return;
            ready = true;
            settled = true;
            notify({ kind: "ready" });
          } else if (kind === "error" && !ready) {
            clearTimeout(timer);
            const message =
              typeof value === "object" && value !== null && "message" in value
                ? String((value as { message: unknown }).message)
                : String(value);
            fail(message);
          }
        },
        onRemoved: () => {
          clearTimeout(timer);
          if (!disposed) notify({ kind: "removed" });
        },
      });

      const stopObserving = deps.observeTheme(() =>
        frame.channel.emit("theme", deps.themeVariables()),
      );

      return {
        dispose() {
          if (disposed) return;
          // 後で `notify` が働かないよう、先に印を付ける。
          disposed = true;
          clearTimeout(timer);
          stopObserving();
          // 枠の中の `dispose`（signal の中断・インスタンスの後片付け）は待たずに、枠を取り除く。
          void frame.channel.call("dispose", null).catch(() => {});
          deps.frames.remove(frame);
        },
        emit(key, value) {
          if (!disposed) frame.channel.emit(key, value);
        },
      };
    },
  };
}
