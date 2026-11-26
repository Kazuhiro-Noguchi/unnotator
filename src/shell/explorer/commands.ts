// エクスプローラーのコマンドの処理: 前後・次の未完了・完了して次へ（`core.nav.*`）と、
// 現在位置の状態を変えるコマンド（`core.status.*`）。006 の空の処理を置き換える。

import { format, t } from "../../i18n";
import type { Direction, Status } from "../../ipc";
import type { CommandRegistry } from "../commands/registry";
import type { Disposable, NotifyLevel } from "../types";
import {
  markDoneAndNext,
  type NavPorts,
  type NavResult,
  navigate,
} from "./nav";

export interface ExplorerCommandDeps {
  commands: CommandRegistry;
  ports: NavPorts;
  notify: (level: NotifyLevel, text: string) => void;
}

/** 結果を、利用者に知らせる文にする（移動できたときは、飛ばした件数だけ）。 */
function report(
  notify: ExplorerCommandDeps["notify"],
  result: NavResult,
  direction: Direction,
): void {
  switch (result.kind) {
    case "moved":
      if (result.skippedMissing > 0) {
        notify(
          "info",
          format(t("explorer.nav.skippedMissing"), {
            count: result.skippedMissing,
          }),
        );
      }
      return;
    case "end":
      notify(
        "info",
        t(
          result.direction === "next"
            ? "explorer.nav.end"
            : "explorer.nav.start",
        ),
      );
      return;
    case "nothing-unfinished":
      notify("info", t("explorer.nav.nothingUnfinished"));
      return;
    case "failed":
      notify(
        "error",
        t(
          result.reason === "write"
            ? "explorer.nav.failedWrite"
            : "explorer.nav.failedSource",
        ),
      );
      return;
    default:
      void direction;
  }
}

export function provideExplorerHandlers(deps: ExplorerCommandDeps): Disposable {
  const { commands, ports, notify } = deps;
  const handles: Disposable[] = [];
  const provide = (id: string, run: () => unknown) =>
    handles.push(commands.provide(id, run));

  const go = (direction: Direction, unfinished: boolean) => async () => {
    report(notify, await navigate(ports, direction, unfinished), direction);
  };
  provide("core.nav.prev", go("prev", false));
  provide("core.nav.next", go("next", false));
  provide("core.nav.nextUnfinished", go("next", true));
  provide("core.nav.markDoneAndNext", async () => {
    report(notify, await markDoneAndNext(ports), "next");
  });

  const setStatus = (status: Status) => async () => {
    const target = ports.current.get();
    if (!target) return;
    try {
      await ports.applyStatus(target, status);
    } catch {
      notify("error", t("explorer.status.failed"));
    }
  };
  provide("core.status.markDone", setStatus("done"));
  provide("core.status.needsReview", setStatus("review"));

  return {
    dispose() {
      for (const handle of handles) handle.dispose();
    },
  };
}
