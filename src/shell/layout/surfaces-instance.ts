// アプリで使う、拡張機能の画面の差し込み（エディター領域の `resolveSurface` と、ビューの登録）。
import { createSignal } from "solid-js";
import { extensionHost } from "../../host/instance";
import { createPlacementRuntime } from "../../host/placement-instance";
import { layout, views } from "../services";
import { createStandaloneScreen } from "./standalone";
import { createResolveSurface, syncExtensionViews } from "./surfaces";

export const placementRuntime = createPlacementRuntime(extensionHost);

const [version, setVersion] = createSignal(0);
const bump = () => setVersion((v) => v + 1);

export const resolveSurface = createResolveSurface({
  placement: placementRuntime.placement,
  opener: placementRuntime.opener,
  nameOf: placementRuntime.nameOf,
  version,
  bump,
});

function syncViews(): void {
  syncExtensionViews(views, placementRuntime.surfaces().views, {
    opener: placementRuntime.opener,
    nameOf: placementRuntime.nameOf,
  });
}

syncViews();
placementRuntime.onDidChangeSurfaces(() => {
  syncViews();
  bump();
});

/** 単独で動く画面（設定画面など）。 */
export const standaloneScreen = createStandaloneScreen();

/** 宣言されたビューを開く。サイドバー・パネルに置けるものは前面に出し、`standalone` ならダイアログで出す。 */
export function showExtensionView(
  id: string,
  options: { standalone?: boolean } = {},
): boolean {
  const entry = placementRuntime.surfaces().views.find((v) => v.id === id);
  if (entry === undefined) return false;
  if (options.standalone === true) {
    standaloneScreen.open(entry);
    return true;
  }
  const state = layout.get();
  if (entry.location === "primarySidebar") {
    const shown =
      state.primarySidebar.visible && state.primarySidebar.view === id;
    if (!shown) layout.selectPrimarySidebarView(id);
  } else if (entry.location === "panel") {
    layout.selectBottomTab(id);
  } else {
    layout.selectSecondarySidebarTab(id);
  }
  return true;
}
