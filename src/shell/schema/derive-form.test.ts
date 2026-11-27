import { describe, expect, it } from "vitest";
import type { SchemaRow } from "../project-data/types";
import {
  deriveForm,
  fieldIssues,
  mismatch,
  parseValue,
  schemasFor,
  validateField,
} from "./derive-form";

const schema = (scope: string, target: string, body: object): SchemaRow => ({
  scope,
  target,
  schema_json: JSON.stringify({ type: "object", ...body }),
});

const global = schema("global", "", {
  properties: {
    note: { type: "string", title: "備考" },
    score: { type: "number" },
  },
});
const byType = schema("annotation_type", "x/shape", {
  properties: {
    note: { type: "string", title: "形の備考" },
    sides: { type: "integer" },
  },
  required: ["sides"],
});
const byLabel = schema("label", "l1", {
  properties: {
    age: { enum: ["child", "adult"], title: "年齢層", default: "adult" },
    seen: { type: "boolean" },
  },
  required: ["age"],
});
const rows = [byLabel, byType, global];

describe("schemasFor（対象に当てはまるスキーマを、全体 → 種別 → ラベルの順に）", () => {
  it("アノテーション: 全体・種別・ラベルの順", () => {
    const got = schemasFor(rows, {
      kind: "annotation",
      type: "x/shape",
      labelId: "l1",
    });
    expect(got.map((r) => r.scope)).toEqual([
      "global",
      "annotation_type",
      "label",
    ]);
  });

  it("当てはまらないものは、含めない", () => {
    expect(
      schemasFor(rows, {
        kind: "annotation",
        type: "other/t",
        labelId: null,
      }).map((r) => r.scope),
    ).toEqual(["global"]);
  });

  it("関係・グループは、それぞれの種別を使う", () => {
    const r = schema("relation_type", "x/link", {
      properties: { w: { type: "number" } },
    });
    const g = schema("group_type", "x/set", {
      properties: { n: { type: "integer" } },
    });
    expect(
      schemasFor([r, g, global], {
        kind: "relation",
        type: "x/link",
        labelId: null,
      }).map((s) => s.scope),
    ).toEqual(["global", "relation_type"]);
    expect(
      schemasFor([r, g, global], {
        kind: "group",
        type: "x/set",
        labelId: null,
      }).map((s) => s.scope),
    ).toEqual(["global", "group_type"]);
  });

  it("アセット・アイテム: 空の対象（すべて）→ 媒体種別 / 提供元の順", () => {
    const a = [
      schema("asset", "x/image", { properties: { b: { type: "string" } } }),
      schema("asset", "", { properties: { a: { type: "string" } } }),
    ];
    expect(
      schemasFor(a, { kind: "asset", mediaType: "x/image" }).map(
        (s) => s.target,
      ),
    ).toEqual(["", "x/image"]);
    expect(
      schemasFor(a, { kind: "asset", mediaType: null }).map((s) => s.target),
    ).toEqual([""]);
    const i = [
      schema("item", "p/pages", { properties: { c: { type: "string" } } }),
    ];
    expect(schemasFor(i, { kind: "item", provider: "p/pages" })).toHaveLength(
      1,
    );
    expect(schemasFor(i, { kind: "item", provider: null })).toHaveLength(0);
  });

  it("壊れた JSON のスキーマは、読み飛ばす", () => {
    const bad: SchemaRow = { scope: "global", target: "", schema_json: "{" };
    expect(deriveForm([bad], { kind: "asset", mediaType: null })).toEqual([]);
  });
});

describe("deriveForm", () => {
  const form = deriveForm(rows, {
    kind: "annotation",
    type: "x/shape",
    labelId: "l1",
  });

  it("同名の項目は、後ろ（具体的なほう）が優先。並びは最初に現れた順", () => {
    expect(form.map((f) => f.name)).toEqual([
      "note",
      "score",
      "sides",
      "age",
      "seen",
    ]);
    expect(form.find((f) => f.name === "note")?.title).toBe("形の備考");
  });

  it("型・必須・既定値・選択肢を導く", () => {
    const age = form.find((f) => f.name === "age");
    expect(age).toMatchObject({
      kind: "enum",
      required: true,
      options: ["child", "adult"],
      defaultValue: "adult",
    });
    expect(form.find((f) => f.name === "sides")).toMatchObject({
      kind: "integer",
      required: true,
    });
    expect(form.find((f) => f.name === "seen")).toMatchObject({
      kind: "boolean",
      required: false,
    });
    expect(form.find((f) => f.name === "score")?.title).toBe("score");
  });
});

describe("値の検証", () => {
  const f = (over: object) => ({
    name: "x",
    title: "x",
    kind: "string" as const,
    required: false,
    ...over,
  });

  it("必須の欄が空なら required（空文字・未設定）。boolean は未設定だけ", () => {
    expect(validateField(f({ required: true }), "")).toBe("required");
    expect(validateField(f({ required: true }), undefined)).toBe("required");
    expect(
      validateField(f({ required: true, kind: "boolean" }), false),
    ).toBeNull();
    expect(
      validateField(f({ required: true, kind: "boolean" }), undefined),
    ).toBe("required");
    expect(validateField(f({ required: false }), "")).toBeNull();
  });

  it("型に合わない値を見つける", () => {
    expect(validateField(f({ kind: "integer" }), 1.5)).toBe("integer");
    expect(validateField(f({ kind: "number" }), Number.NaN)).toBe("number");
    expect(validateField(f({ kind: "number" }), "1")).toBe("number");
    expect(validateField(f({ kind: "enum", options: ["a"] }), "b")).toBe(
      "enum",
    );
    expect(validateField(f({ kind: "enum", options: ["a"] }), "a")).toBeNull();
  });

  it("parseValue は、入力の文字を型に直す。空は『未設定』", () => {
    expect(parseValue(f({ kind: "integer" }), "3")).toEqual({
      ok: true,
      value: 3,
    });
    expect(parseValue(f({ kind: "integer" }), "3.5")).toEqual({
      ok: false,
      error: "integer",
    });
    expect(parseValue(f({ kind: "number" }), "abc")).toEqual({
      ok: false,
      error: "number",
    });
    expect(parseValue(f({ kind: "number" }), "2.5")).toEqual({
      ok: true,
      value: 2.5,
    });
    expect(parseValue(f({ kind: "number" }), "")).toEqual({
      ok: true,
      value: undefined,
    });
    expect(parseValue(f({ kind: "string" }), "a")).toEqual({
      ok: true,
      value: "a",
    });
  });

  it("保存済みの値が型に合わなくなったとき、mismatch（値は残す）", () => {
    expect(mismatch(f({ kind: "integer" }), "abc")).toBe(true);
    expect(mismatch(f({ kind: "enum", options: ["a"] }), "z")).toBe(true);
    expect(mismatch(f({ kind: "string" }), undefined)).toBe(false);
    expect(mismatch(f({ kind: "string" }), "ok")).toBe(false);
  });

  it("fieldIssues は、欄ごとの問題をまとめる（既定値は、未設定の値として扱う）", () => {
    const form = deriveForm(rows, {
      kind: "annotation",
      type: "x/shape",
      labelId: "l1",
    });
    const issues = fieldIssues(form, { score: "x" });
    expect(issues.sides).toEqual({ error: "required" });
    expect(issues.score).toEqual({ mismatch: true });
    expect(issues.age).toBeUndefined();
  });
});
