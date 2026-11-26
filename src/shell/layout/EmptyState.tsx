import { Show } from "solid-js";

export function EmptyState(props: {
  message: string;
  action?: { label: string; run: () => void } | undefined;
}) {
  return (
    <div class="empty-state">
      <p>{props.message}</p>
      <Show when={props.action}>
        {(action) => (
          <button type="button" class="button" onClick={() => action().run()}>
            {action().label}
          </button>
        )}
      </Show>
    </div>
  );
}
