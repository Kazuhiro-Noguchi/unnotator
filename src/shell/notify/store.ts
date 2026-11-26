// 通知。トースト（画面に出ているもの）と、通知センター（ベルから開く、しまってある全部）の 2 つの見方がある。
// info は一定時間でトーストから消え、warn・error は閉じるまで出ている。トーストから消えても、通知センターには残る。
import type { Notification, NotifyLevel, NotifyOptions } from "../types";

export const AUTO_DISMISS_MS = 5000;
/** トーストを同時に出す件数（超えたら古いトーストから消える。通知センターには残る）。 */
export const VISIBLE_NOTIFICATIONS = 3;
/** 通知センターに残す件数の上限（超えたら古いものから消す）。 */
export const HISTORY_LIMIT = 100;

export function createNotifyStore() {
  let all: Notification[] = [];
  const hiddenIds = new Set<number>();
  let toasts: Notification[] = [];
  let nextId = 1;
  /** false の間（通知センターを開いている間）は、トーストを出さない。 */
  let toastsEnabled = true;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const listeners = new Set<() => void>();

  const emit = () => {
    toasts = all.filter((n) => !hiddenIds.has(n.id));
    for (const listener of [...listeners]) listener();
  };
  const stopTimer = (id: number) => {
    const timer = timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(id);
  };

  /** トーストから外す（通知センターには残る）。 */
  function hide(id: number): void {
    stopTimer(id);
    if (!all.some((n) => n.id === id) || hiddenIds.has(id)) return;
    hiddenIds.add(id);
    emit();
  }

  function remove(id: number): void {
    stopTimer(id);
    const before = all.length;
    all = all.filter((n) => n.id !== id);
    hiddenIds.delete(id);
    if (all.length !== before) emit();
  }

  return {
    notify(
      level: NotifyLevel,
      text: string,
      options: NotifyOptions = {},
    ): number {
      const id = nextId++;
      const hasActions = (options.actions?.length ?? 0) > 0;
      const autoDismissMs =
        level !== "info" || hasActions ? null : AUTO_DISMISS_MS;
      const item: Notification = { id, level, text, autoDismissMs };
      if (options.source !== undefined) item.source = options.source;
      if (hasActions && options.actions) item.actions = options.actions;
      if (options.settings !== undefined) item.settings = options.settings;
      all = [...all, item];
      if (!toastsEnabled) hiddenIds.add(id);
      if (autoDismissMs !== null && toastsEnabled)
        timers.set(
          id,
          setTimeout(() => hide(id), autoDismissMs),
        );
      // 同時に出すのは新しい方から VISIBLE_NOTIFICATIONS 件。古いトーストは消える。
      const visible = all.filter((n) => !hiddenIds.has(n.id));
      for (const old of visible.slice(
        0,
        Math.max(0, visible.length - VISIBLE_NOTIFICATIONS),
      )) {
        stopTimer(old.id);
        hiddenIds.add(old.id);
      }
      while (all.length > HISTORY_LIMIT) {
        const oldest = all[0];
        if (!oldest) break;
        stopTimer(oldest.id);
        hiddenIds.delete(oldest.id);
        all = all.slice(1);
      }
      emit();
      return id;
    },
    /** トーストを閉じる（通知センターには残る）。 */
    dismiss: hide,
    /** 通知センターからも消す。 */
    remove,
    /** すべてのトーストを閉じる（通知センターには残る）。 */
    clear(): void {
      let changed = false;
      for (const n of all) {
        stopTimer(n.id);
        if (!hiddenIds.has(n.id)) {
          hiddenIds.add(n.id);
          changed = true;
        }
      }
      if (changed) emit();
    },
    /**
     * トーストを出すかどうか。false にすると、いまのトーストを閉じ、
     * 以後の通知は、トーストにせず通知センターにだけ入る（通知センターを開いている間）。
     */
    setToastsEnabled(enabled: boolean): void {
      toastsEnabled = enabled;
      if (!enabled) this.clear();
    },
    /** 通知センターのすべてを消す。 */
    removeAll(): void {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      hiddenIds.clear();
      if (all.length === 0) return;
      all = [];
      emit();
    },
    /** いまトーストに出ているもの。 */
    list: (): Notification[] => toasts,
    /** 通知センターに入っているすべて（古い順）。 */
    history: (): Notification[] => all,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type NotifyStore = ReturnType<typeof createNotifyStore>;
