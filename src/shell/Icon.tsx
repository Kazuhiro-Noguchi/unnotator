import { For, Show } from "solid-js";
import { iconShapes, parseIconRef } from "./icons";

/** `$(name)` のアイコン。装飾なので、読み上げの対象にしない（名前はボタンの文字が持つ）。 */
export function Icon(props: { name: string | undefined; size?: number }) {
  const shapes = () => iconShapes(parseIconRef(props.name) ?? "unknown");
  return (
    <Show when={props.name !== undefined}>
      <svg
        class="icon"
        viewBox="0 0 24 24"
        aria-hidden="true"
        width={props.size ?? 20}
        height={props.size ?? 20}
      >
        <For each={shapes()}>{(d) => <path d={d} />}</For>
      </svg>
    </Show>
  );
}
