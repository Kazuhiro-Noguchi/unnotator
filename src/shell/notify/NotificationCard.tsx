import { For, Show } from "solid-js";
import { format } from "../../i18n";
import { Icon } from "../Icon";
import { useT } from "../solid";
import type { Notification } from "../types";

/** 送り元が無い通知の表示（アプリ本体からの通知）。 */
const DEFAULT_SOURCE = "unnotator";

const LEVEL_ICON = {
  info: "$(info)",
  warn: "$(problems)",
  error: "$(circle-x)",
} as const;

/**
 * 通知 1 件。左に段階のアイコン、本文、右上に歯車（任意）と閉じる、
 * 下の段に、左へ送り元、右へ操作のボタン（任意）。トーストと通知センターで共通。
 * 色だけでなく、アイコンと文言（情報・警告・エラー。画面には出さない）でも、段階を示す。
 */
export function NotificationCard(props: {
  item: Notification;
  /** 閉じるボタンの動き。 */
  onClose: () => void;
  /** 閉じるボタンの名前。 */
  closeLabel: string;
  /** 操作のボタンを押した後の動き（既定は onClose）。 */
  onAction?: () => void;
}) {
  const t = useT();
  return (
    <div
      class={`toast ${props.item.level}`}
      role={props.item.level === "error" ? "alert" : "status"}
    >
      <span class="toast-mark">
        <Icon name={LEVEL_ICON[props.item.level]} size={16} />
      </span>
      <div class="toast-body">
        <p class="toast-text">
          <span class="toast-level">{t(`notify.${props.item.level}`)}</span>{" "}
          {props.item.text}
        </p>
      </div>
      <div class="toast-tools">
        <Show when={props.item.settings}>
          {(open) => (
            <button
              type="button"
              class="button icon-button"
              aria-label={t("notify.settings")}
              title={t("notify.settings")}
              onClick={() => open()()}
            >
              <Icon name="$(settings)" size={14} />
            </button>
          )}
        </Show>
        <button
          type="button"
          class="button icon-button"
          aria-label={props.closeLabel}
          title={props.closeLabel}
          onClick={() => props.onClose()}
        >
          <Icon name="$(close)" size={14} />
        </button>
      </div>
      <div class="toast-footer">
        <span class="toast-source">
          {format(t("notify.source"), {
            source: props.item.source ?? DEFAULT_SOURCE,
          })}
        </span>
        <div class="toast-actions">
          <For each={props.item.actions ?? []}>
            {(action) => (
              <button
                type="button"
                class="button"
                classList={{ primary: action.primary === true }}
                onClick={() => {
                  action.run();
                  (props.onAction ?? props.onClose)();
                }}
              >
                {action.label}
              </button>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
