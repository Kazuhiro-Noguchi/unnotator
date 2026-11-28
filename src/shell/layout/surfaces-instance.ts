// アプリで使う、拡張機能の画面の差し込み（エディター領域の `resolveSurface` と、ビューの登録）。
import { createSignal } from "solid-js";
import { extensionHost } from "../../host/instance";
import { createPlacementRuntime } from "../../host/placement-instance";
import { views } from "../services";
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
