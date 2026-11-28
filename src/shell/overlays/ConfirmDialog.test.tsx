// @vitest-environment happy-dom
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";
import { askConfirm, confirmRequest } from "./confirm";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

let dispose: (() => void) | undefined;
afterEach(async () => {
  while (confirmRequest() !== null) {
    confirmRequest()?.resolve(false);
    await tick();
  }
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

const base = {
  extId: "com.example.a",
  name: "Example A",
  message: "消しますか？",
  okLabel: undefined,
  cancelLabel: undefined,
};

function button(label: RegExp): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((b) =>
    label.test(b.textContent ?? ""),
  );
  if (!found) throw new Error(`ボタンが無い: ${label}`);
  return found;
}

describe("拡張機能の確認ダイアログ", () => {
  it("見出しに拡張機能の名前を出し、本文は文字として出す", async () => {
    dispose = render(() => <ConfirmDialog />, document.body);
    void askConfirm({ ...base, message: "<img src=x onerror=alert(1)>" });
    await tick();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Example A");
    expect(dialog?.textContent).toContain("<img src=x");
    expect(dialog?.querySelector("img")).toBeNull();
  });

  it("OK で true、キャンセル・Esc で false。ボタンの文言は拡張機能が決められるが、無ければ既定", async () => {
    dispose = render(() => <ConfirmDialog />, document.body);
    const ok = askConfirm({ ...base, okLabel: "消す" });
    await tick();
    button(/消す/).click();
    await expect(ok).resolves.toBe(true);
    const cancelled = askConfirm(base);
    await tick();
    button(/キャンセル|Cancel/).click();
    await expect(cancelled).resolves.toBe(false);
    const escaped = askConfirm(base);
    await tick();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await expect(escaped).resolves.toBe(false);
  });

  it("同時に 2 つ求められたら、順番に出す", async () => {
    dispose = render(() => <ConfirmDialog />, document.body);
    const first = askConfirm(base);
    const second = askConfirm({ ...base, message: "二つ目" });
    await tick();
    expect(document.body.textContent).not.toContain("二つ目");
    button(/OK/).click();
    await first;
    await tick();
    expect(document.body.textContent).toContain("二つ目");
    button(/OK/).click();
    await expect(second).resolves.toBe(true);
  });
});
