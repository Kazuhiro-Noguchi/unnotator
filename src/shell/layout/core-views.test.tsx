// @vitest-environment happy-dom
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import { makeProblemSink } from "../testing/fakes";
import { createContext } from "../when/context";
import { registerCoreViews } from "./core-views";
import { createViewRegistry } from "./views";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

function mountExplorer() {
  const views = createViewRegistry(createContext(), makeProblemSink().sink);
  const openFolder = vi.fn();
  const createNew = vi.fn();
  registerCoreViews(views, { openFolder, createNew });
  const view = views.get("explorer");
  if (!view) throw new Error("explorer view is not registered");
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(() => view.render(), root);
  return { openFolder, createNew };
}

describe("エクスプローラー（プロジェクトを開いていないとき）", () => {
  it("「新規プロジェクトを作成」「既存プロジェクトを開く」の順にボタンを出す", () => {
    mountExplorer();
    const labels = [...document.querySelectorAll(".empty-state button")].map(
      (b) => b.textContent,
    );
    expect(labels).toEqual([t("empty.newProject"), t("empty.openProject")]);
  });

  it("それぞれのボタンで、新規作成・既存を開く処理が呼ばれる", () => {
    const { openFolder, createNew } = mountExplorer();
    const [newButton, openButton] = [
      ...document.querySelectorAll<HTMLButtonElement>(".empty-state button"),
    ];
    newButton?.click();
    expect(createNew).toHaveBeenCalledTimes(1);
    expect(openFolder).not.toHaveBeenCalled();
    openButton?.click();
    expect(openFolder).toHaveBeenCalledTimes(1);
  });
});
