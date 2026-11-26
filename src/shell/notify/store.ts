// 通知（トースト）。info・warn は一定時間で消え、error は閉じるまで残る。
import type { Notification, NotifyLevel } from "../types";

export const AUTO_DISMISS_MS = 5000;
export const MAX_NOTIFICATIONS = 5;

export function createNotifyStore() {
  let list: Notification[] = [];
  let nextId = 1;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };

  function remove(id: number): void {
    const timer = timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(id);
    const before = list.length;
    list = list.filter((n) => n.id !== id);
    if (list.length !== before) emit();
  }

  return {
    notify(level: NotifyLevel, text: string): number {
      const id = nextId++;
      const autoDismissMs = level === "error" ? null : AUTO_DISMISS_MS;
      list = [...list, { id, level, text, autoDismissMs }];
      if (autoDismissMs !== null)
        timers.set(
          id,
          setTimeout(() => remove(id), autoDismissMs),
        );
      // 同時に出す件数を超えたら、古い info / warn から、無ければ古い error から消す。
      while (list.length > MAX_NOTIFICATIONS) {
        const victim = list.find((n) => n.level !== "error") ?? list[0];
        if (!victim) break;
        const timer = timers.get(victim.id);
        if (timer !== undefined) clearTimeout(timer);
        timers.delete(victim.id);
        list = list.filter((n) => n.id !== victim.id);
      }
      emit();
      return id;
    },
    dismiss: remove,
    list: (): Notification[] => list,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type NotifyStore = ReturnType<typeof createNotifyStore>;
