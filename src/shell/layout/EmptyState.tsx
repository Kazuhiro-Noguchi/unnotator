import { For, Show } from "solid-js";

export interface EmptyAction {
  label: string;
  run: () => void;
}

export function EmptyState(props: {
  message: string;
  action?: EmptyAction | undefined;
  /** 複数のボタンを並べるとき（上から順に並ぶ）。 */
  actions?: readonly EmptyAction[] | undefined;
}) {
  const buttons = () => [
    ...(props.action ? [props.action] : []),
    ...(props.actions ?? []),
  ];
  return (
    <div class="empty-state">
      <p>{props.message}</p>
      <Show when={buttons().length > 0}>
        <For each={buttons()}>
          {(action) => (
            <button type="button" class="button" onClick={() => action.run()}>
              {action.label}
            </button>
          )}
        </For>
      </Show>
    </div>
  );
}
