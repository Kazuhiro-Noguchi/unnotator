import { describe, expect, it } from "vitest";
import type { AnnotationRow } from "../project-data/types";
import { loadAllPages } from "./paging";

const row = (id: string): AnnotationRow => ({
  id,
  type: "t/t",
  type_version: 1,
  label_id: null,
  attributes_json: "{}",
  summary: "",
  z_order: 0,
  source: "manual",
});

describe("loadAllPages", () => {
  it("続きがなくなるまで、順に読んで連結する", async () => {
    const pages = [
      { rows: [row("1"), row("2")], next: { z_order: 0, id: "2" } },
      { rows: [row("3")], next: null },
    ];
    const cursors: unknown[] = [];
    const rows = await loadAllPages(
      async (cursor) => {
        cursors.push(cursor);
        return pages[cursors.length - 1] ?? { rows: [], next: null };
      },
      () => true,
    );
    expect(rows?.map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(cursors).toEqual([null, { z_order: 0, id: "2" }]);
  });

  it("途中で現在位置が変わったら、結果を捨てる（null）", async () => {
    let current = true;
    const result = await loadAllPages(
      async () => {
        current = false;
        return { rows: [row("1")], next: { z_order: 0, id: "1" } };
      },
      () => current,
    );
    expect(result).toBeNull();
  });

  it("読み込みの失敗は、そのまま投げる", async () => {
    await expect(
      loadAllPages(
        async () => {
          throw new Error("boom");
        },
        () => true,
      ),
    ).rejects.toThrow("boom");
  });
});
