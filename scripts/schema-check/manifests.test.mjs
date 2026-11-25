import { describe, expect, it } from "vitest";
import { checkManifests } from "./manifests.mjs";

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: "^a" } },
  additionalProperties: false,
};

describe("checkManifests", () => {
  it("期待どおりなら問題なし", () => {
    const problems = checkManifests({
      schema,
      valid: { "ok.json": { id: "a" } },
      invalid: { "bad.json": { id: "b" } },
      expected: { "bad.json": "pattern" },
    });
    expect(problems).toEqual([]);
  });

  it("合格してしまった不正な見本を報告する", () => {
    const problems = checkManifests({
      schema,
      valid: {},
      invalid: { "moved.json": { id: "a" } },
      expected: { "moved.json": "pattern" },
    });
    expect(problems.join("\n")).toContain("合格してしまった");
  });

  it("理由が違う見本を報告する", () => {
    const problems = checkManifests({
      schema,
      valid: {},
      invalid: { "bad.json": { id: "b" } },
      expected: { "bad.json": "required" },
    });
    expect(problems.join("\n")).toContain("期待は required");
  });

  it("不合格な正しい見本を報告する", () => {
    const problems = checkManifests({
      schema,
      valid: { "x.json": { id: "z" } },
      invalid: {},
      expected: {},
    });
    expect(problems.join("\n")).toContain("valid/x.json");
  });
});
