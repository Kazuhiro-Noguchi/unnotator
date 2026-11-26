// コアのコマンドのうち、この機能で実装済みの処理を結ぶ。結ばれないものは「未提供」のまま無効に並ぶ。
import type { ProjectActions } from "../settings/folder-picker";
import type { Disposable } from "../types";
import type { CommandRegistry } from "./registry";

export interface LayoutControls {
  toggle: (region: "primarySidebar" | "secondarySidebar" | "bottom") => void;
  showPrimarySidebarView: (view: string) => void;
}

export interface AppearanceControls {
  setTheme: (choice: "system" | "light" | "dark") => void;
  setLanguage: (choice: "system" | "ja" | "en") => void;
}

export interface CoreHandlerDeps {
  commands: CommandRegistry;
  actions: ProjectActions;
  layout: LayoutControls;
  appearance: AppearanceControls;
  openPalette: () => void;
  openSettings: () => void;
  openAbout: () => void;
}

export function provideCoreHandlers(deps: CoreHandlerDeps): Disposable {
  const { commands, actions, layout } = deps;
  const handles: Disposable[] = [];
  const provide = (id: string, run: (args?: unknown) => unknown) =>
    handles.push(commands.provide(id, run));

  provide("core.undo", () => actions.undo());
  provide("core.redo", () => actions.redo());
  provide("core.project.save", () => actions.save());
  provide("core.project.open", () => actions.openFolder());
  provide("core.project.new", () => actions.createNew());
  provide("core.project.openRecent", (args) =>
    typeof args === "string" ? actions.openRecent(args) : undefined,
  );
  provide("core.palette.open", () => deps.openPalette());
  provide("core.app.settings", () => deps.openSettings());
  provide("core.app.about", () => deps.openAbout());

  provide("core.view.primarySidebar.toggle", () =>
    layout.toggle("primarySidebar"),
  );
  provide("core.view.secondarySidebar.toggle", () =>
    layout.toggle("secondarySidebar"),
  );
  provide("core.view.bottom.toggle", () => layout.toggle("bottom"));

  provide("core.view.theme.set", (args) => {
    if (args === "system" || args === "light" || args === "dark")
      deps.appearance.setTheme(args);
  });
  provide("core.view.language.set", (args) => {
    if (args === "system" || args === "ja" || args === "en")
      deps.appearance.setLanguage(args);
  });

  for (const view of ["explorer", "labels", "search", "extensions"]) {
    provide(`core.primarySidebar.show.${view}`, () =>
      layout.showPrimarySidebarView(view),
    );
  }

  return {
    dispose() {
      for (const handle of handles) handle.dispose();
    },
  };
}
