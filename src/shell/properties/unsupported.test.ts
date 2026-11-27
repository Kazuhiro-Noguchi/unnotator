import { describe, expect, it } from "vitest";
import { isSupportedType, splitAnnotations } from "./unsupported";

const row = (id: string, type: string) => ({
  id,
  type,
  type_version: 1,
  label_id: null,
  attributes_json: "{}",
  summary: "",
  z_order: 0,
  source: "manual",
});

describe("未対応の種別の判定", () => {
  it("core/ の種別は、いつでも対応している", () => {
    expect(isSupportedType("core/classification", new Set())).toBe(true);
  });

  it("担当の拡張機能がある種別だけ、対応している", () => {
    const supported = new Set(["com.example.shape/shape"]);
    expect(isSupportedType("com.example.shape/shape", supported)).toBe(true);
    expect(isSupportedType("com.example.other/thing", supported)).toBe(false);
  });

  it("名前が core で始まるだけの種別は、対応とみなさない", () => {
    expect(isSupportedType("corex/thing", new Set())).toBe(false);
  });

  it("一覧を、対応と未対応に分ける（順序は保つ）", () => {
    const rows = [
      row("1", "core/classification"),
      row("2", "x/y"),
      row("3", "a/b"),
    ];
    const { supported, unsupported } = splitAnnotations(rows, new Set(["a/b"]));
    expect(supported.map((r) => r.id)).toEqual(["1", "3"]);
    expect(unsupported.map((r) => r.id)).toEqual(["2"]);
  });
});
