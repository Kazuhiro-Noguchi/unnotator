import { describe, expect, it } from "vitest";
import {
  blankProperty,
  type EditorProperty,
  fromSchemaJson,
  toSchemaJson,
  validateProperties,
} from "./schema-edit";

const prop = (over: Partial<EditorProperty>): EditorProperty => ({
  ...blankProperty(),
  name: "x",
  ...over,
});

describe("スキーマの編集（JSON ⇄ 編集用の形）", () => {
  it("JSON から編集用の項目を作る（型・必須・既定値・選択肢）", () => {
    const json = JSON.stringify({
      type: "object",
      properties: {
        age: { enum: ["child", "adult"], title: "年齢層", default: "adult" },
        n: { type: "integer", description: "個数", default: 3 },
        ok: { type: "boolean" },
      },
      required: ["age"],
    });
    const items = fromSchemaJson(json);
    expect(items.map((i) => i.name)).toEqual(["age", "n", "ok"]);
    expect(items[0]).toMatchObject({
      kind: "enum",
      required: true,
      options: ["child", "adult"],
      defaultText: "adult",
      title: "年齢層",
    });
    expect(items[1]).toMatchObject({
      kind: "integer",
      defaultText: "3",
      description: "個数",
    });
    expect(fromSchemaJson(null)).toEqual([]);
    expect(fromSchemaJson("{")).toEqual([]);
  });

  it("編集用の項目から JSON を作る。往復しても同じ", () => {
    const json = JSON.stringify({
      type: "object",
      properties: {
        age: {
          type: "string",
          enum: ["child", "adult"],
          title: "年齢層",
          default: "adult",
        },
        n: { type: "integer", description: "個数", default: 3 },
      },
      required: ["age"],
    });
    const out = toSchemaJson(fromSchemaJson(json));
    expect(JSON.parse(out)).toEqual({
      type: "object",
      properties: {
        age: { enum: ["child", "adult"], title: "年齢層", default: "adult" },
        n: { type: "integer", description: "個数", default: 3 },
      },
      required: ["age"],
    });
    expect(fromSchemaJson(out)).toEqual(fromSchemaJson(json));
  });

  it("空のタイトル・説明・既定値は、キーごと出さない。必須が無ければ required も出さない", () => {
    const parsed = JSON.parse(toSchemaJson([prop({ kind: "string" })]));
    expect(parsed).toEqual({
      type: "object",
      properties: { x: { type: "string" } },
    });
  });

  it("既定値は、型に直す（数値・真偽）", () => {
    const parsed = JSON.parse(
      toSchemaJson([
        prop({ name: "a", kind: "number", defaultText: "2.5" }),
        prop({ name: "b", kind: "boolean", defaultText: "true" }),
      ]),
    );
    expect(parsed.properties.a.default).toBe(2.5);
    expect(parsed.properties.b.default).toBe(true);
  });
});

describe("validateProperties", () => {
  it("名前の空・重複を拒む", () => {
    expect(validateProperties([prop({ name: " " })])).toEqual([
      { index: 0, code: "name" },
    ]);
    expect(
      validateProperties([prop({ name: "a" }), prop({ name: "a" })]),
    ).toEqual([{ index: 1, code: "duplicate" }]);
  });

  it("選択肢の型は、候補が 1 つ以上・重複なし", () => {
    expect(validateProperties([prop({ kind: "enum", options: [] })])).toEqual([
      { index: 0, code: "options" },
    ]);
    expect(
      validateProperties([prop({ kind: "enum", options: ["a", "a"] })]),
    ).toEqual([{ index: 0, code: "options" }]);
    expect(
      validateProperties([prop({ kind: "enum", options: ["a"] })]),
    ).toEqual([]);
  });

  it("既定値が型に合わなければ、拒む。選択肢の型の既定値は、候補のどれか", () => {
    expect(
      validateProperties([prop({ kind: "integer", defaultText: "1.5" })]),
    ).toEqual([{ index: 0, code: "default" }]);
    expect(
      validateProperties([
        prop({ kind: "enum", options: ["a"], defaultText: "b" }),
      ]),
    ).toEqual([{ index: 0, code: "default" }]);
    expect(
      validateProperties([prop({ kind: "boolean", defaultText: "maybe" })]),
    ).toEqual([{ index: 0, code: "default" }]);
    expect(
      validateProperties([prop({ kind: "integer", defaultText: "4" })]),
    ).toEqual([]);
  });
});
