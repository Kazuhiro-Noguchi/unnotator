import { describe, expect, it } from "vitest";
import { checkPrerequisites, runSteps } from "./index.mjs";

describe("runSteps", () => {
  it("1 つが失敗しても残りを実行し、終了コードが 0 以外になる", async () => {
    const ran = [];
    const steps = [
      { name: "a", run: async () => ran.push("a") },
      {
        name: "b",
        run: async () => {
          ran.push("b");
          throw new Error("boom");
        },
      },
      { name: "c", run: async () => ran.push("c") },
    ];
    const lines = [];
    const result = await runSteps(steps, (line) => lines.push(line));
    expect(ran).toEqual(["a", "b", "c"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.failed).toEqual(["b"]);
    expect(lines.filter((l) => l.startsWith("==")).length).toBe(3);
  });

  it("すべて成功すると終了コードが 0", async () => {
    const result = await runSteps(
      [{ name: "a", run: async () => {} }],
      () => {},
    );
    expect(result.exitCode).toBe(0);
    expect(result.failed).toEqual([]);
  });
});

describe("checkPrerequisites", () => {
  it("足りないものを名指しする", () => {
    const missing = checkPrerequisites({
      hasCommand: () => false,
      exists: () => false,
    });
    expect(missing.join("\n")).toContain("cargo");
    expect(missing.join("\n")).toContain("node_modules");
  });

  it("そろっていれば空", () => {
    expect(
      checkPrerequisites({ hasCommand: () => true, exists: () => true }),
    ).toEqual([]);
  });
});
