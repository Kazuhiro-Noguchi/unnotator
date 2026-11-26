// ブラウザの環境（document・matchMedia）に結びついた、テーマと言語の制御。
import { ctx, saveUiSetting } from "./services";
import { createAppearance } from "./theme/theme";

export const appearance = createAppearance({
  ctx,
  root: document.documentElement,
  media: window.matchMedia("(prefers-color-scheme: dark)"),
  save: saveUiSetting,
});
