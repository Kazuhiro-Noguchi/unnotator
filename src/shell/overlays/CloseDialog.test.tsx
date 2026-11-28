// @vitest-environment happy-dom
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { t } from "../../i18n";
import { askCloseDecision, closeRequest } from "../ui-state";
import { CloseDialog } from "./Overlays";

let dispose: (() => void) | undefined;
afterEach(() => {
  closeRequest()?.resolve("cancel");
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

describe("閉じる確認と候補（FR-027）", () => {
  it("残っている候補があれば、件数と「保存されない」ことを同じ確認に出す", () => {
    dispose = render(() => <CloseDialog />, document.body);
    void askCloseDecision(3);
    return Promise.resolve().then(() => {
      expect(document.body.textContent).toContain("3");
      expect(document.body.textContent).toContain(
        t("close.suggestions").replace("{count}", "3"),
      );
    });
  });

  it("候補がなければ、候補の文は出さない", () => {
    dispose = render(() => <CloseDialog />, document.body);
    void askCloseDecision();
    return Promise.resolve().then(() => {
      expect(document.body.textContent).not.toContain(
        t("close.suggestions").replace("{count}", "0"),
      );
      expect(document.querySelector(".close-suggestions")).toBeNull();
    });
  });
});
