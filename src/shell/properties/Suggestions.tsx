import { createSignal, For, Show } from "solid-js";
import { format } from "../../i18n";
import { fromStore, useT } from "../solid";
import type { NotifyLevel } from "../types";
import { ROW_HEIGHT } from "./AnnotationList";
import type { AsyncAction, SuggestionsSource } from "./suggestions-view";
import { visibleWindow } from "./window";

const OVERSCAN = 5;
const FALLBACK_VISIBLE = 8;

export interface SuggestionsProps {
  source: SuggestionsSource;
  assetId: string;
  itemKey: string | null;
  /** 提案した拡張機能の表示名。 */
  nameOf(extId: string): string;
  notify: (level: NotifyLevel, text: string) => void;
}

/**
 * 候補（`annotations.suggest`）の一覧。通常のアノテーションとは別の区画・見た目で出し、
 * 採用 / 却下を操作できる。仮想スクロールなので、数千件でも描く行は見える範囲だけ。
 */
export function Suggestions(props: SuggestionsProps) {
  const t = useT();
  const rows = fromStore(
    () => props.source.list(props.assetId, props.itemKey),
    (l) => props.source.subscribe(l),
  );
  const [busy, setBusy] = createSignal(false);
  const [scrollTop, setScrollTop] = createSignal(0);
  const [height, setHeight] = createSignal(0);
  const win = () =>
    visibleWindow(
      scrollTop(),
      height() || ROW_HEIGHT * FALLBACK_VISIBLE,
      ROW_HEIGHT,
      rows().length,
      OVERSCAN,
    );
  const shown = () => rows().slice(win().start, win().end);

  // 採用は 1 度に 1 つだけ進める（二重に送らない）。失敗は通知する。
  const accept = async (run: AsyncAction) => {
    if (busy()) return;
    setBusy(true);
    try {
      await run();
    } catch (e) {
      props.notify(
        "error",
        format(t("suggestions.acceptFailed"), {
          reason: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Show when={rows().length > 0}>
      <section class="suggestions" aria-label={t("suggestions.title")}>
        <h3>
          {t("suggestions.title")}{" "}
          <span class="prop-count">
            {format(t("suggestions.count"), { count: String(rows().length) })}
          </span>
        </h3>
        <div class="suggestions-actions">
          <button
            type="button"
            class="button primary"
            disabled={busy()}
            onClick={() =>
              void accept(() =>
                props.source.acceptAll(props.assetId, props.itemKey),
              )
            }
          >
            {t("suggestions.acceptAll")}
          </button>
          <button
            type="button"
            class="button"
            disabled={busy()}
            onClick={() => props.source.rejectAll(props.assetId, props.itemKey)}
          >
            {t("suggestions.rejectAll")}
          </button>
        </div>
        <div
          class="suggestion-list"
          ref={(el) => {
            queueMicrotask(() => setHeight(el.clientHeight));
          }}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <ul
            class="suggestion-body"
            style={{ height: `${rows().length * ROW_HEIGHT}px` }}
          >
            <For each={shown()}>
              {(row, i) => (
                <li
                  class="suggestion-item"
                  style={{
                    top: `${(win().start + i()) * ROW_HEIGHT}px`,
                    height: `${ROW_HEIGHT}px`,
                  }}
                  title={format(t("suggestions.from"), {
                    name: props.nameOf(row.source),
                  })}
                >
                  <span class="suggestion-badge">{t("suggestions.badge")}</span>
                  <span class="suggestion-title">
                    {row.summary || row.type}
                  </span>
                  <button
                    type="button"
                    class="button"
                    aria-label={t("suggestions.accept")}
                    disabled={busy()}
                    onClick={() =>
                      void accept(() => props.source.accept([row.id]))
                    }
                  >
                    {t("suggestions.accept")}
                  </button>
                  <button
                    type="button"
                    class="button"
                    aria-label={t("suggestions.reject")}
                    disabled={busy()}
                    onClick={() => props.source.reject([row.id])}
                  >
                    {t("suggestions.reject")}
                  </button>
                </li>
              )}
            </For>
          </ul>
        </div>
      </section>
    </Show>
  );
}
