import { createSignal, For, onCleanup, onMount } from "solid-js";
import { keyTips } from "../services";
import { fromStore } from "../solid";

/** Alt を押したときに、各対象の上に重ねて出すチップ。 */
export function KeyTipLayer() {
  const info = fromStore(() => keyTips.tips(), keyTips.subscribe);
  const [tick, setTick] = createSignal(0);
  onMount(() => {
    const redraw = () => setTick((n) => n + 1);
    window.addEventListener("resize", redraw);
    onCleanup(() => window.removeEventListener("resize", redraw));
  });

  const placed = () => {
    tick();
    return info().tips.flatMap((tip) => {
      if (tip.chip === "") return [];
      const el = document.querySelector(
        `[data-keytip="${CSS.escape(tip.target)}"]`,
      );
      const box = (
        el?.querySelector("button, input") ?? el
      )?.getBoundingClientRect();
      if (!box || box.width === 0) return [];
      return [{ ...tip, x: box.left + box.width / 2, y: box.bottom - 4 }];
    });
  };

  return (
    <div class="keytip-layer" aria-hidden="true">
      <For each={placed()}>
        {(tip) => (
          <kbd class="keytip" style={{ left: `${tip.x}px`, top: `${tip.y}px` }}>
            {tip.chip}
          </kbd>
        )}
      </For>
    </div>
  );
}
