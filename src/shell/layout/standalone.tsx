// 単独で動く画面（設定画面など。FR-010）。ビューと同じ種類の枠（role=view）を、ダイアログの中に出す。
// 許可された API だけを、枠の経路（メッセージ）で使える。
import { createSignal, Show } from "solid-js";
import type { ViewEntry } from "../../host/placement";
import type { SurfaceOpener } from "../../host/placement-frame";
import { Dialog } from "../overlays/Dialog";
import { useLanguage } from "../solid";
import { resolveTitle } from "../title";
import { SurfaceFrame } from "./SurfaceFrame";

export function createStandaloneScreen() {
  const [current, setCurrent] = createSignal<ViewEntry | null>(null);
  return {
    current,
    /** 開く。すでに開いていれば、前の枠を取り除いてから新しい枠を作る。 */
    open(entry: ViewEntry): void {
      setCurrent(entry);
    },
    close(): void {
      setCurrent(null);
    },
  };
}

export type StandaloneScreenStore = ReturnType<typeof createStandaloneScreen>;

export function StandaloneScreen(props: {
  screen: StandaloneScreenStore;
  opener: SurfaceOpener;
  nameOf(extensionId: string): string;
}) {
  const language = useLanguage();
  return (
    // `keyed` で、別の画面に切り替わるたびに、枠を作り直す。
    <Show when={props.screen.current()} keyed>
      {(entry) => (
        <Dialog
          title={resolveTitle(entry.title, language())}
          onClose={() => props.screen.close()}
          wide
        >
          <div class="surface-screen">
            <SurfaceFrame
              opener={props.opener}
              request={{
                extensionId: entry.extensionId,
                surfaceId: entry.id,
                role: "view",
                entry: entry.entry,
                ctx: {},
              }}
              name={props.nameOf(entry.extensionId)}
            />
          </div>
        </Dialog>
      )}
    </Show>
  );
}
