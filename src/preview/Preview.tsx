// 汎用プレビュー: エディターが無いアセットの中身を、表示だけする（憲章 I が認める唯一の例外）。
// プロジェクトのデータを読み書きしない。読むのは `unno://asset/` だけ。
// specs/007-tree-preview/contracts/explorer-api.md の 4。
import {
  createEffect,
  createSignal,
  Match,
  on,
  onCleanup,
  Switch,
} from "solid-js";
import type { AssetRow } from "../ipc";
import { useT } from "../shell/solid";
import { choosePreviewKind } from "./choose";
import { Fallback, type FallbackReason } from "./Fallback";
import { TextPreview } from "./TextPreview";
import {
  buildLineIndex,
  type FetchFn,
  type LineIndex,
  loadTextHead,
  TextLoadError,
} from "./text";
import { assetUrl, detectPdfSupport } from "./url";

export interface PreviewProps {
  asset: AssetRow;
  /** 既定のアプリで開く。 */
  onOpenExternal: () => void;
  /** リンク切れのときの再接続（004 の画面へ）。 */
  onRelink: () => void;
  /** PDF を表示できる環境か（省略すると、実行環境から調べる）。 */
  pdfSupported?: boolean;
  /** テストで差し替える。 */
  fetchFn?: FetchFn;
}

type State =
  | { kind: "loading" }
  | { kind: "image"; url: string }
  | { kind: "pdf"; url: string }
  | { kind: "text"; lines: LineIndex; truncated: boolean }
  | { kind: "fallback"; reason: FallbackReason };

/**
 * PDF の `<iframe>` は、読み込むとフォーカスを奪い、以後のキー操作（PageDown・元に戻すなど）が
 * シェルに届かなくなる。読み込み前にフォーカスのあった要素（ツリー）へ、フォーカスを戻す。
 */
function giveFocusBack(frame: HTMLIFrameElement, before: Element | null): void {
  if (
    document.activeElement === frame &&
    before instanceof HTMLElement &&
    before !== frame &&
    before.isConnected
  ) {
    before.focus();
  }
}

export function Preview(props: PreviewProps) {
  const t = useT();
  /** 表示を切り替えた時点で、フォーカスのあった要素。 */
  let focusBefore: Element | null = null;
  const [state, setState] = createSignal<State>({ kind: "loading" });

  createEffect(
    on(
      () =>
        [props.asset.id, props.asset.rel_path, props.asset.missing] as const,
      ([id, relPath, missing]) => {
        const controller = new AbortController();
        onCleanup(() => controller.abort());
        focusBefore = document.activeElement;
        // 古い読み込みの結果で、新しい表示を上書きしない（中断に加えて、完了時にも確かめる）。
        const stillCurrent = () => !controller.signal.aborted;

        if (missing) {
          setState({ kind: "fallback", reason: "missing" });
          return;
        }
        const kind = choosePreviewKind(relPath);
        const url = assetUrl(id);
        if (kind === "image") {
          setState({
            kind: "image",
            url: assetUrl(id, undefined, { display: true }),
          });
        } else if (kind === "pdf") {
          const supported = props.pdfSupported ?? detectPdfSupport();
          setState(
            supported
              ? { kind: "pdf", url: assetUrl(id, undefined, { display: true }) }
              : { kind: "fallback", reason: "no-pdf-support" },
          );
        } else if (kind === "text") {
          setState({ kind: "loading" });
          void loadTextHead({
            url,
            signal: controller.signal,
            ...(props.fetchFn ? { fetchFn: props.fetchFn } : {}),
          })
            .then((loaded) => {
              if (!stillCurrent()) return;
              setState({
                kind: "text",
                lines: buildLineIndex(loaded.text),
                truncated: loaded.truncated,
              });
            })
            .catch((error: unknown) => {
              if (!stillCurrent()) return;
              setState({
                kind: "fallback",
                reason:
                  error instanceof TextLoadError && error.reason === "not-utf8"
                    ? "not-utf8"
                    : "read-failed",
              });
            });
        } else {
          setState({ kind: "fallback", reason: "unknown-format" });
        }
      },
    ),
  );

  const fallback = (reason: FallbackReason) => (
    <Fallback
      asset={props.asset}
      reason={reason}
      onOpenExternal={props.onOpenExternal}
      onRelink={props.onRelink}
    />
  );

  return (
    <div class="preview">
      <Switch>
        <Match when={state().kind === "loading"}>
          <p class="preview-loading" role="status">
            {t("preview.loading")}
          </p>
        </Match>
        <Match when={state().kind === "image"}>
          <img
            class="preview-image"
            src={(state() as { url: string }).url}
            alt={t("preview.image.alt")}
            onError={() =>
              setState({ kind: "fallback", reason: "image-failed" })
            }
          />
        </Match>
        <Match when={state().kind === "pdf"}>
          <iframe
            class="preview-pdf"
            src={(state() as { url: string }).url}
            title={t("preview.pdf.title")}
            onLoad={(event) => giveFocusBack(event.currentTarget, focusBefore)}
          />
        </Match>
        <Match when={state().kind === "text"}>
          <TextPreview
            lines={(state() as { lines: LineIndex }).lines}
            truncated={(state() as { truncated: boolean }).truncated}
          />
        </Match>
        <Match when={state().kind === "fallback"}>
          {fallback((state() as { reason: FallbackReason }).reason)}
        </Match>
      </Switch>
    </div>
  );
}
