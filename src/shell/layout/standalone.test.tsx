// @vitest-environment happy-dom
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import type { ViewEntry } from "../../host/placement";
import type {
  SurfaceOpener,
  SurfaceOpenRequest,
} from "../../host/placement-frame";
import { setLanguage } from "../../i18n";
import { createStandaloneScreen, StandaloneScreen } from "./standalone";

let dispose: (() => void) | undefined;
afterEach(() => {
  setLanguage("ja");
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const entry: ViewEntry = {
  extensionId: "x.ext",
  localId: "settings",
  id: "x.ext/settings",
  entry: "dist/settings.js",
  title: { ja: "設定", en: "Settings" },
  location: "panel",
  icon: null,
  when: null,
};

function setup() {
  setLanguage("ja");
  const requests: SurfaceOpenRequest[] = [];
  const disposed: string[] = [];
  const opener: SurfaceOpener = {
    open(request) {
      requests.push(request);
      return {
        dispose: () => void disposed.push(request.surfaceId),
        emit: () => {},
      };
    },
  };
  const screen = createStandaloneScreen();
  dispose = render(
    () => (
      <StandaloneScreen screen={screen} opener={opener} nameOf={(id) => id} />
    ),
    document.body,
  );
  return { screen, requests, disposed };
}

describe("単独で動く画面（FR-010）", () => {
  it("開くまでは何も出さない", async () => {
    setup();
    await flush();
    expect(document.querySelector(".dialog")).toBeNull();
  });

  it("開くと、ダイアログの中に、ビューと同じ種類の枠（role=view）で出す", async () => {
    const s = setup();
    s.screen.open(entry);
    await flush();
    expect(document.querySelector(".dialog")?.getAttribute("aria-label")).toBe(
      "設定",
    );
    expect(document.querySelector(".dialog .surface-frame")).not.toBeNull();
    expect(s.requests[0]).toMatchObject({
      role: "view",
      surfaceId: "x.ext/settings",
      entry: "dist/settings.js",
    });
  });

  it("閉じると、枠を取り除く", async () => {
    const s = setup();
    s.screen.open(entry);
    await flush();
    s.screen.close();
    await flush();
    expect(document.querySelector(".dialog")).toBeNull();
    expect(s.disposed).toEqual(["x.ext/settings"]);
  });

  it("別の画面を開くと、前の枠を取り除いて、新しい枠を作る", async () => {
    const s = setup();
    s.screen.open(entry);
    await flush();
    s.screen.open({ ...entry, id: "x.ext/other", localId: "other" });
    await flush();
    expect(s.disposed).toEqual(["x.ext/settings"]);
    expect(s.requests.map((r) => r.surfaceId)).toEqual([
      "x.ext/settings",
      "x.ext/other",
    ]);
  });
});
