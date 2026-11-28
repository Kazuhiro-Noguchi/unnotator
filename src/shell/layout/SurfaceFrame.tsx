// 拡張機能の画面の枠（surface frame）の入れ物。開くたびに枠を 1 つ作り、閉じるときに確実に取り除く。
// 枠の中身（iframe）は、この入れ物の外へ出られない（`shell.css` の `.surface-frame`）。
// 枠の生成は `SurfaceOpener`（`src/host/placement-frame.ts`）に任せる。
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type {
  SurfaceHandle,
  SurfaceOpener,
  SurfaceOpenRequest,
  SurfaceState,
} from "../../host/placement-frame";
import { format } from "../../i18n";
import { useT } from "../solid";

export interface SurfaceFrameProps {
  opener: SurfaceOpener;
  request: Omit<SurfaceOpenRequest, "container" | "onState">;
  /** 拡張機能の表示名（案内に出す）。 */
  name: string;
  /** 読み込みに失敗した。呼び出し側は、次の候補（別のエディター・汎用プレビュー）へ切り替えられる。 */
  onFailed?: (message: string) => void;
  onReady?: () => void;
  /** 開いた枠の操作（`visibility` の通知など）を受け取る。 */
  onHandle?: (handle: SurfaceHandle | null) => void;
}

type View = "loading" | "ready" | "failed" | "removed";

export function SurfaceFrame(props: SurfaceFrameProps) {
  const t = useT();
  const [view, setView] = createSignal<View>("loading");
  let container: HTMLDivElement | undefined;
  let handle: SurfaceHandle | null = null;

  function close(): void {
    handle?.dispose();
    handle = null;
    props.onHandle?.(null);
  }

  function open(): void {
    if (container === undefined) return;
    setView("loading");
    handle = props.opener.open({
      ...props.request,
      container,
      onState: (state: SurfaceState) => {
        if (state.kind === "ready") {
          setView("ready");
          props.onReady?.();
        } else if (state.kind === "failed") {
          close();
          setView("failed");
          props.onFailed?.(state.message);
        } else {
          // 外から枠が取り除かれた。入れ物だけが残る。
          handle = null;
          props.onHandle?.(null);
          setView("removed");
        }
      },
    });
    props.onHandle?.(handle);
  }

  onMount(open);
  onCleanup(close);

  const retry = () => {
    open();
  };

  return (
    <div
      class="surface-frame"
      ref={container}
      data-surface={props.request.surfaceId}
      data-role={props.request.role}
      data-state={view()}
    >
      <Show when={view() === "failed"}>
        <div class="surface-notice" role="status">
          <p>{t("host.frame.loadFailed")}</p>
          <button type="button" class="button" onClick={retry}>
            {t("host.frame.retry")}
          </button>
        </div>
      </Show>
      <Show when={view() === "removed"}>
        <div class="surface-notice" role="status">
          <p>{format(t("host.frame.stopped"), { name: props.name })}</p>
        </div>
      </Show>
    </div>
  );
}
