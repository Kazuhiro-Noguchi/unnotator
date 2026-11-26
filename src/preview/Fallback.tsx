import { Show } from "solid-js";
import type { AssetRow } from "../ipc";
import { useT } from "../shell/solid";

/** 表示できないときの理由。 */
export type FallbackReason =
  | "not-utf8"
  | "no-pdf-support"
  | "image-failed"
  | "read-failed"
  | "unknown-format"
  | "missing";

const MESSAGE = {
  "not-utf8": "preview.notUtf8",
  "no-pdf-support": "preview.noPdf",
  "image-failed": "preview.imageFailed",
  "read-failed": "preview.readFailed",
  "unknown-format": "preview.unknownFormat",
  missing: "preview.missing",
} as const;

function sizeText(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** ファイルの情報と、理由の案内、操作（既定のアプリで開く / 再接続）。 */
export function Fallback(props: {
  asset: AssetRow;
  reason: FallbackReason;
  onOpenExternal: () => void;
  onRelink: () => void;
}) {
  const t = useT();
  const name = () =>
    props.asset.rel_path.split("/").pop() ?? props.asset.rel_path;
  return (
    <div class="preview-fallback" role="status">
      <p class="preview-reason">{t(MESSAGE[props.reason])}</p>
      <dl class="preview-info">
        <dt>{t("preview.info.name")}</dt>
        <dd>{name()}</dd>
        <dt>{t("preview.info.size")}</dt>
        <dd>{sizeText(props.asset.file_size)}</dd>
        <dt>{t("preview.info.modified")}</dt>
        <dd>
          {props.asset.mtime_ms === null
            ? "—"
            : new Date(props.asset.mtime_ms).toLocaleString()}
        </dd>
        <dt>{t("preview.info.type")}</dt>
        <dd>{props.asset.media_type ?? t("preview.info.unknownType")}</dd>
      </dl>
      <Show
        when={props.reason === "missing"}
        fallback={
          <button
            type="button"
            class="button"
            data-preview-external
            onClick={() => props.onOpenExternal()}
          >
            {t("preview.openExternal")}
          </button>
        }
      >
        <button
          type="button"
          class="button"
          data-preview-relink
          onClick={() => props.onRelink()}
        >
          {t("preview.relink")}
        </button>
      </Show>
    </div>
  );
}
