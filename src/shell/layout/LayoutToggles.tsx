import { For } from "solid-js";
import { Icon } from "../Icon";
import { commands, ctx } from "../services";
import { fromContext, useLanguage } from "../solid";
import { resolveTitle } from "../title";

/** 領域の表示切替。リボンの右端（クイックアクセスの反対側）に置く。 */
const TOGGLES = [
  {
    command: "core.view.primarySidebar.toggle",
    on: "$(primary-sidebar)",
    off: "$(primary-sidebar-off)",
    key: "primarySidebarVisible",
  },
  {
    command: "core.view.bottom.toggle",
    on: "$(bottom-panel)",
    off: "$(bottom-panel-off)",
    key: "bottomVisible",
  },
  {
    command: "core.view.secondarySidebar.toggle",
    on: "$(secondary-sidebar)",
    off: "$(secondary-sidebar-off)",
    key: "secondarySidebarVisible",
  },
] as const;

export function LayoutToggles() {
  const language = useLanguage();
  return (
    <div class="layout-toggles">
      <For each={TOGGLES}>
        {(toggle) => {
          const on = fromContext(ctx, () => ctx.get(toggle.key) === true);
          const title = () => {
            const spec = commands.get(toggle.command);
            return spec ? resolveTitle(spec.title, language()) : "";
          };
          return (
            <button
              type="button"
              class="ribbon-button quick"
              aria-pressed={on()}
              aria-label={title()}
              title={title()}
              onClick={() => void commands.execute(toggle.command)}
            >
              {/* 表示中は実線、非表示のときは破線の枠で示す（背景の色は変えない）。 */}
              <Icon name={on() ? toggle.on : toggle.off} size={18} />
            </button>
          );
        }}
      </For>
    </div>
  );
}
