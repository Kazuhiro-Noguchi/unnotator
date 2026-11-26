// キーチップの DOM との結びつき: Alt の単独押し・モード中のキー入力・対象の実行。
// 割り当てと状態の遷移は keytips.ts（テスト済みの純関数）。

import type { Language } from "../../i18n";
import { resolveTitle } from "../title";
import type { Disposable, RibbonControl, RibbonTab } from "../types";
import { primaryInvocation } from "./controls/logic";
import {
  assignKeyTips,
  createAltTapDetector,
  type KeyTip,
  type KeyTipState,
  reduceKeyTips,
} from "./keytips";

export interface KeyTipControllerDeps {
  tabs: () => RibbonTab[];
  quickAccess: () => string[];
  commandTitle: (id: string) => string;
  language: () => Language;
  selectedTab: () => string;
  select: (tab: string) => void;
  openBackstage: () => void;
  execute: (command: string, args?: unknown) => void;
}

/** チップの元にする文字列。言語で変わらないように、ID の末尾（英語）を先にする。 */
function tipLabel(id: string, title: string): string {
  const tail = id.split(/[./]/).pop() ?? id;
  return `${tail} ${title}`;
}

export function createKeyTipController(deps: KeyTipControllerDeps) {
  let state: KeyTipState = { level: "off" };
  const listeners = new Set<() => void>();
  const detector = createAltTapDetector();

  const emit = () => {
    for (const listener of [...listeners]) listener();
  };

  function tabTips(): KeyTip[] {
    const tabs = deps.tabs();
    return assignKeyTips([
      ...tabs.map((tab) => ({
        target: `tab:${tab.id}`,
        label: resolveTitle(tab.title, deps.language()),
        ...(tab.keytip ? { fixed: tab.keytip } : {}),
      })),
      ...deps
        .quickAccess()
        .map((id) => ({ target: `qa:${id}`, label: deps.commandTitle(id) })),
    ]);
  }

  /** タブの中の、最上位のコントロール（区切りを除く）。 */
  function controlsOf(tabId: string): RibbonControl[] {
    return (
      deps
        .tabs()
        .find((tab) => tab.id === tabId)
        ?.groups.flatMap((g) => g.controls)
        .filter((c) => c.kind !== "separator") ?? []
    );
  }

  function controlTips(tabId: string): KeyTip[] {
    return assignKeyTips(
      controlsOf(tabId).map((control, index) => ({
        target: `control:${tabId}/${index}`,
        label: control.command
          ? tipLabel(control.command, deps.commandTitle(control.command))
          : "",
        ...(control.keytip ? { fixed: control.keytip } : {}),
      })),
    );
  }

  function activate(target: string): void {
    if (target.startsWith("tab:")) {
      const id = target.slice("tab:".length);
      if (id === "file") {
        state = { level: "off" };
        deps.openBackstage();
      } else {
        deps.select(id);
      }
    } else if (target.startsWith("qa:")) {
      deps.execute(target.slice("qa:".length));
    } else if (target.startsWith("control:")) {
      const [tab, index] = target.slice("control:".length).split("/");
      const control = controlsOf(tab ?? "")[Number(index)];
      const call = control ? primaryInvocation(control) : null;
      if (call) deps.execute(call.command, call.args);
    }
  }

  function dispatch(action: Parameters<typeof reduceKeyTips>[1]): boolean {
    const before = state;
    const step = reduceKeyTips(state, action, {
      tabs: tabTips,
      controls: controlTips,
    });
    state = step.state;
    if (step.activate) activate(step.activate.target);
    emit();
    return before.level !== "off" || state.level !== "off";
  }

  function install(target: Window): Disposable {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (state.level !== "off") {
        if (event.key === "Alt") return;
        const handled =
          event.key === "Escape"
            ? dispatch({ type: "escape" })
            : event.key.length === 1 && !event.ctrlKey && !event.metaKey
              ? dispatch({ type: "key", key: event.key })
              : false;
        // モード中は、キーマップに渡さない（チップの文字がコマンドにならないように）。
        event.preventDefault();
        event.stopImmediatePropagation();
        void handled;
        return;
      }
      detector.keydown(event.key);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (detector.keyup(event.key)) {
        // Windows で、Alt の単独押しがメニューバーへ移るのを止める。
        event.preventDefault();
        // タブが無ければ、選んでいるタブをそのまま使う。
        if (state.level === "off") deps.select(deps.selectedTab());
        dispatch({ type: "alt" });
      }
    };
    const cancel = () => detector.cancel();
    target.addEventListener("keydown", onKeyDown, true);
    target.addEventListener("keyup", onKeyUp, true);
    target.addEventListener("pointerdown", cancel, true);
    return {
      dispose() {
        target.removeEventListener("keydown", onKeyDown, true);
        target.removeEventListener("keyup", onKeyUp, true);
        target.removeEventListener("pointerdown", cancel, true);
      },
    };
  }

  return {
    state: (): KeyTipState => state,
    tips(): { level: KeyTipState["level"]; tips: KeyTip[] } {
      if (state.level === "tabs") return { level: "tabs", tips: tabTips() };
      if (state.level === "controls")
        return { level: "controls", tips: controlTips(state.tab) };
      return { level: "off", tips: [] };
    },
    close(): void {
      state = { level: "off" };
      emit();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    install,
  };
}

export type KeyTipController = ReturnType<typeof createKeyTipController>;
