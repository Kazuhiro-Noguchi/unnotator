// エクスプローラーの 1 セッション（プロジェクトを開いてから閉じるまで）。
// 索引との通信・開いたフォルダの保存・現在位置・アセットの変化への追従を、1 か所に集める。
import type { Context } from "../types";
import {
  createExplorerController,
  type ExplorerController,
} from "./controller";
import { type CurrentStore, createCurrentStore } from "./current";
import { isEmptyFilter } from "./filter";
import { createExplorerPersist, type ExplorerPersist } from "./persist";
import { createRowsStore, type RowsPort, type RowsStore } from "./rows";

/** アセットの変化を、窓の取り直しにまとめる待ち時間（ミリ秒）。 */
const REFRESH_DEBOUNCE_MS = 80;

export interface ExplorerSessionDeps {
  ipc: RowsPort;
  settings: {
    readUserLayer(): Promise<Record<string, unknown>>;
    write(key: string, value: unknown): Promise<void>;
  };
  ctx: Context;
  /** アセットの増減・状態の変化の通知。解除する関数を返す。 */
  onChanged(handler: () => void): () => void;
}

export interface ExplorerSession {
  rows: RowsStore;
  current: CurrentStore;
  controller: ExplorerController;
  open(folder: string): Promise<void>;
  close(): Promise<void>;
}

export function createExplorerSession(
  deps: ExplorerSessionDeps,
): ExplorerSession {
  const rows = createRowsStore(deps.ipc);
  const current = createCurrentStore();
  let persist: ExplorerPersist | null = null;
  let isOpen = false;
  const controller = createExplorerController({
    rows,
    current,
    persist: () => persist,
  });

  current.subscribe(() => deps.ctx.set("hasCurrent", current.get() !== null));
  controller.subscribe(() =>
    deps.ctx.set("filterActive", !isEmptyFilter(controller.snapshot().filter)),
  );

  let timer: ReturnType<typeof setTimeout> | null = null;
  deps.onChanged(() => {
    if (!isOpen) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (isOpen) void controller.refresh().catch(() => {});
    }, REFRESH_DEBOUNCE_MS);
  });

  return {
    rows,
    current,
    controller,
    async open(folder) {
      persist = createExplorerPersist(
        {
          read: async () =>
            (await deps.settings.readUserLayer())["ui.explorer"],
          write: (value) => deps.settings.write("ui.explorer", value),
        },
        folder,
      );
      isOpen = true;
      current.clear();
      const saved = await persist.load();
      await controller.start(saved);
    },
    async close() {
      isOpen = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      current.clear();
      await persist?.flush();
      persist = null;
      await controller.reset();
    },
  };
}
