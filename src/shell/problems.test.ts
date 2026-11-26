import { describe, expect, it } from "vitest";
import { createProblems } from "./problems";
import type { ProblemCode } from "./types";

describe("シェルの問題", () => {
  it("報告した問題が集まる", () => {
    const store = createProblems(() => 1000);
    store.report({ code: "command.unknown", source: "core", message: "x" });
    expect(store.list()).toEqual([
      {
        code: "command.unknown",
        source: "core",
        message: "x",
        at: 1000,
        count: 1,
      },
    ]);
  });

  it("同じ（code・source・message）は 1 件にまとめて回数を数える", () => {
    let now = 1;
    const store = createProblems(() => now++);
    const p = { code: "when.syntax" as const, source: "a", message: "m" };
    store.report(p);
    store.report(p);
    store.report(p);
    store.report({ ...p, source: "b" });
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list[0]?.count).toBe(3);
    expect(list[0]?.at).toBe(3); // 最後の時刻に更新される
  });

  it("500 件を超えたら、古いものから捨てる", () => {
    const store = createProblems(() => 0);
    for (let i = 0; i < 600; i++) {
      store.report({ code: "command.failed", source: "s", message: `m${i}` });
    }
    const list = store.list();
    expect(list).toHaveLength(500);
    expect(list[0]?.message).toBe("m100");
    expect(list.at(-1)?.message).toBe("m599");
  });

  it("全ての ProblemCode を扱える", () => {
    const codes: ProblemCode[] = [
      "when.syntax",
      "command.duplicate",
      "command.unknown",
      "command.failed",
      "keybinding.invalid",
      "keybinding.conflict",
      "ribbon.target-missing",
      "settings.invalid",
    ];
    const store = createProblems(() => 0);
    for (const code of codes) store.report({ code, source: "s", message: "m" });
    expect(store.list().map((p) => p.code)).toEqual(codes);
  });

  it("購読者に変更を知らせる", () => {
    const store = createProblems(() => 0);
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.report({ code: "command.failed", source: "s", message: "m" });
    expect(calls).toBe(1);
    off();
    store.report({ code: "command.failed", source: "s", message: "n" });
    expect(calls).toBe(1);
  });

  it("clear で空にできる", () => {
    const store = createProblems(() => 0);
    store.report({ code: "command.failed", source: "s", message: "m" });
    store.clear();
    expect(store.list()).toEqual([]);
  });
});
