// @vitest-environment happy-dom
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { ConsentDialog } from "./ConsentDialog";
import { askConsent, consentRequest } from "./consent";

let dispose: (() => void) | undefined;
afterEach(async () => {
  // 解決していない要求が、あとのテストの順番待ちを塞がないようにする。
  while (consentRequest() !== null) {
    consentRequest()?.resolve(false);
    await tick();
  }
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function mount() {
  dispose = render(() => <ConsentDialog />, document.body);
}

const request = {
  extId: "com.example.a",
  name: "Example A",
  permissions: [{ permission: "annotations.write", warning: false }],
};

function button(label: RegExp): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((b) =>
    label.test(b.textContent ?? ""),
  );
  if (!found) throw new Error(`ボタンが無い: ${label}`);
  return found;
}

describe("権限の確認ダイアログ", () => {
  it("要求が無いときは何も描かない", () => {
    mount();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("拡張機能の名前と権限の説明を、ホストの文言で出す", async () => {
    mount();
    void askConsent(request);
    await tick();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Example A");
    expect(dialog?.textContent).toMatch(/アノテーションの作成|annotations/);
  });

  it("許可すると true、拒否すると false で解決し、閉じる", async () => {
    mount();
    const allowed = askConsent(request);
    await tick();
    button(/許可|Allow/).click();
    await expect(allowed).resolves.toBe(true);
    expect(consentRequest()).toBeNull();

    const refused = askConsent(request);
    await tick();
    button(/拒否|Deny/).click();
    await expect(refused).resolves.toBe(false);
  });

  it("Esc や外のクリックで閉じると、拒否として扱う", async () => {
    mount();
    const result = askConsent(request);
    await tick();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await expect(result).resolves.toBe(false);
  });

  it("同時に 2 つ求められたら、順番に 1 つずつ出す", async () => {
    mount();
    const first = askConsent(request);
    const second = askConsent({ ...request, name: "Example B" });
    await tick();
    expect(document.body.textContent).toContain("Example A");
    expect(document.body.textContent).not.toContain("Example B");
    button(/許可|Allow/).click();
    await first;
    await tick();
    expect(document.body.textContent).toContain("Example B");
    button(/拒否|Deny/).click();
    await expect(second).resolves.toBe(false);
  });

  it("拡張機能の文字は、HTML ではなく文字として出す", async () => {
    mount();
    void askConsent({ ...request, name: "<img src=x onerror=alert(1)>" });
    await tick();
    expect(document.querySelector('[role="dialog"] img')).toBeNull();
  });

  it("network は警告の見た目と文言を添える。表にない権限は名前をそのまま出す", async () => {
    mount();
    void askConsent({
      ...request,
      permissions: [
        { permission: "network", warning: true },
        { permission: "future.permission", warning: false },
      ],
    });
    await tick();
    expect(document.querySelector(".consent-warning")).not.toBeNull();
    expect(document.body.textContent).toContain("future.permission");
  });
});
