import { createSignal } from "solid-js";
import { t } from "../../i18n";

const KEY_STEP = 16;

/**
 * 領域の境界。ドラッグとキーボード（矢印・Home・End）で大きさを変える。
 * `grow` は、境界を右（縦の境界）または下（横の境界）へ動かしたとき、
 * 領域が大きくなるなら 1、小さくなるなら -1。
 */
export function Splitter(props: {
  orientation: "vertical" | "horizontal";
  value: number;
  min: number;
  max: number;
  grow: 1 | -1;
  label: string;
  onChange: (value: number) => void;
}) {
  const [dragging, setDragging] = createSignal(false);

  function onPointerDown(event: PointerEvent): void {
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const start =
      props.orientation === "vertical" ? event.clientX : event.clientY;
    const startValue = props.value;
    setDragging(true);
    const move = (e: PointerEvent) => {
      const now = props.orientation === "vertical" ? e.clientX : e.clientY;
      props.onChange(startValue + (now - start) * props.grow);
    };
    const up = () => {
      setDragging(false);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  function onKeyDown(event: KeyboardEvent): void {
    const horizontalAxis = props.orientation === "vertical";
    const plus = horizontalAxis ? "ArrowRight" : "ArrowDown";
    const minus = horizontalAxis ? "ArrowLeft" : "ArrowUp";
    let next: number | null = null;
    if (event.key === plus) next = props.value + KEY_STEP * props.grow;
    else if (event.key === minus) next = props.value - KEY_STEP * props.grow;
    else if (event.key === "Home") next = props.min;
    else if (event.key === "End") next = props.max;
    if (next === null) return;
    event.preventDefault();
    props.onChange(next);
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: ARIA の separator（操作できるもの）を使う
    <div
      class="splitter"
      role="separator"
      tabIndex={0}
      aria-orientation={props.orientation}
      aria-label={`${props.label}: ${t("splitter.resize")}`}
      aria-valuenow={Math.round(props.value)}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      data-dragging={dragging()}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}
