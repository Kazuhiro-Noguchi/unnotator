import { StandaloneScreen } from "./standalone";
import { placementRuntime, standaloneScreen } from "./surfaces-instance";

/** アプリの単独の画面の置き場（`Overlays` から使う）。 */
export function StandaloneHost() {
  return (
    <StandaloneScreen
      screen={standaloneScreen}
      opener={placementRuntime.opener}
      nameOf={placementRuntime.nameOf}
    />
  );
}
