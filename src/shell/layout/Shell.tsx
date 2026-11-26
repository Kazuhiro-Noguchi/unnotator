import {
  createMemo,
  createSignal,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { isEditableTarget } from "../keys/editable";
import { ctx, layout } from "../services";
import { fromStore, useT } from "../solid";
import { ActivityBar } from "./ActivityBar";
import {
  BottomPanel,
  EditorArea,
  PrimarySidebar,
  SecondarySidebar,
} from "./Panels";
import { Splitter } from "./Splitter";
import {
  BOTTOM_HEIGHT_RANGE,
  effectiveLayout,
  SIDE_WIDTH_RANGE,
} from "./state";

/** 領域の配置。リボンとステータスバーは、それぞれの機能が差し込む。 */
export function Shell(props: {
  ribbon?: JSX.Element;
  statusBar?: JSX.Element;
}) {
  const t = useT();
  const state = fromStore(layout.get, layout.subscribe);
  const [viewport, setViewport] = createSignal({
    width: window.innerWidth || 1200,
    height: window.innerHeight || 800,
  });
  const shown = createMemo(() => effectiveLayout(state(), viewport()));

  onMount(() => {
    const onResize = () => {
      // 描画の直後などに 0 が返ることがある。そのときは、前の値を保つ。
      if (window.innerWidth > 0 && window.innerHeight > 0) {
        setViewport({ width: window.innerWidth, height: window.innerHeight });
      }
    };
    onResize();
    const observer = new ResizeObserver(onResize);
    observer.observe(document.documentElement);
    // フォーカスのある領域と、入力欄にフォーカスがあるかを、コンテキストに入れる。
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Element | null;
      const region = target
        ?.closest?.("[data-region]")
        ?.getAttribute("data-region");
      if (region) ctx.set("focusRegion", region);
      ctx.set("inputFocus", isEditableTarget(event.target));
    };
    const onFocusOut = () => ctx.set("inputFocus", false);
    window.addEventListener("resize", onResize);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener("resize", onResize);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    });
  });

  return (
    <div class="shell">
      <section
        class="ribbon-slot"
        data-region="ribbon"
        aria-label={t("region.ribbon")}
      >
        {props.ribbon}
      </section>
      <div class="shell-main">
        <ActivityBar />
        <Show when={shown().primarySidebar.visible}>
          <PrimarySidebar width={shown().primarySidebar.width} />
          <Splitter
            orientation="vertical"
            value={shown().primarySidebar.width}
            min={SIDE_WIDTH_RANGE.min}
            max={SIDE_WIDTH_RANGE.max}
            grow={1}
            label={t("region.primarySidebar")}
            onChange={(value) => layout.setSize("primarySidebar", value)}
          />
        </Show>
        <div class="shell-center">
          <EditorArea />
          <Show when={shown().bottom.visible}>
            <Splitter
              orientation="horizontal"
              value={shown().bottom.height}
              min={BOTTOM_HEIGHT_RANGE.min}
              max={BOTTOM_HEIGHT_RANGE.max}
              grow={-1}
              label={t("region.bottom")}
              onChange={(value) => layout.setSize("bottom", value)}
            />
            <BottomPanel height={shown().bottom.height} />
          </Show>
        </div>
        <Show when={shown().secondarySidebar.visible}>
          <Splitter
            orientation="vertical"
            value={shown().secondarySidebar.width}
            min={SIDE_WIDTH_RANGE.min}
            max={SIDE_WIDTH_RANGE.max}
            grow={-1}
            label={t("region.secondarySidebar")}
            onChange={(value) => layout.setSize("secondarySidebar", value)}
          />
          <SecondarySidebar width={shown().secondarySidebar.width} />
        </Show>
      </div>
      <section
        class="status-slot"
        data-region="statusBar"
        aria-label={t("region.statusBar")}
      >
        {props.statusBar}
      </section>
    </div>
  );
}
