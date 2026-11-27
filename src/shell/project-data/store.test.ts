import { describe, expect, it } from "vitest";
import { createCurrentStore } from "../explorer/current";
import { createProjectData, type ProjectDataIpc } from "./store";
import type {
  AnnotationPage,
  ChangeSet,
  LabelRow,
  SchemaRow,
  TargetDetails,
} from "./types";

function label(id: string, name: string): LabelRow {
  return {
    id,
    name,
    name_i18n_json: "{}",
    color: "#112233",
    hotkey: null,
    sort_order: 0,
    hidden: false,
    applies_to_json: "{}",
  };
}

function details(assetId: string, note: string | null = null): TargetDetails {
  return {
    asset: {
      id: assetId,
      root_key: "",
      rel_path: `${assetId}.bin`,
      media_type: null,
      missing: false,
      status: "todo",
      note,
      attributes_json: "{}",
    },
    item: null,
    classification: [],
    annotation_count: 0,
    relations: [],
    groups: [],
  };
}

function changeSet(
  entities: ChangeSet["changes"][number]["entity"][],
  assetIds: string[] = [],
): ChangeSet {
  return {
    seq: 1,
    origin: "apply",
    changes: entities.map((entity) => ({
      entity,
      id: "x",
      kind: "updated" as const,
    })),
    asset_ids: assetIds,
  };
}

function setup() {
  const calls = { labels: 0, schemas: 0, details: [] as string[] };
  let labelRows = [label("l1", "cat")];
  let schemaRows: SchemaRow[] = [];
  let notes: Record<string, string | null> = {};
  const emptyPage: AnnotationPage = { rows: [], next: null };
  const ipc: ProjectDataIpc = {
    labelsList: async () => {
      calls.labels += 1;
      return labelRows;
    },
    schemasList: async () => {
      calls.schemas += 1;
      return schemaRows;
    },
    targetDetails: async (assetId) => {
      calls.details.push(assetId);
      return details(assetId, notes[assetId] ?? null);
    },
    annotationsPage: async () => emptyPage,
    attributeUsage: async () => 0,
    apply: async () => changeSet([]),
  };
  const current = createCurrentStore();
  let emit: (set: ChangeSet) => void = () => {};
  const data = createProjectData({
    ipc,
    current,
    onChanged: (handler) => {
      emit = handler;
      return () => {};
    },
  });
  return {
    data,
    current,
    calls,
    emit: (set: ChangeSet) => emit(set),
    setLabels: (rows: LabelRow[]) => {
      labelRows = rows;
    },
    setSchemas: (rows: SchemaRow[]) => {
      schemaRows = rows;
    },
    setNote: (assetId: string, note: string) => {
      notes = { ...notes, [assetId]: note };
    },
  };
}

const open = (id: string) => ({ assetId: id, itemKey: null, mediaType: null });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ProjectData", () => {
  it("refresh でラベルとスキーマを読む", async () => {
    const t = setup();
    expect(t.data.labels()).toEqual([]);
    await t.data.refresh();
    expect(t.data.labels().map((l) => l.name)).toEqual(["cat"]);
    expect(t.data.schemas()).toEqual([]);
  });

  it("現在位置が変わると、詳細を読み、購読者に知らせる", async () => {
    const t = setup();
    let notified = 0;
    t.data.subscribe(() => {
      notified += 1;
    });
    t.current.open(open("a1"));
    await flush();
    expect(t.data.details()?.asset.id).toBe("a1");
    expect(notified).toBeGreaterThan(0);
    t.current.clear();
    await flush();
    expect(t.data.details()).toBeNull();
  });

  it("ラベルの変更では、ラベルだけを丸ごと読み直す", async () => {
    const t = setup();
    await t.data.refresh();
    t.setLabels([label("l1", "cat"), label("l2", "dog")]);
    t.emit(changeSet(["label"]));
    await flush();
    expect(t.data.labels()).toHaveLength(2);
    expect(t.calls.labels).toBe(2);
    expect(t.calls.schemas).toBe(1);
  });

  it("スキーマの変更では、スキーマだけを読み直す", async () => {
    const t = setup();
    await t.data.refresh();
    t.setSchemas([{ scope: "global", target: "", schema_json: "{}" }]);
    t.emit(changeSet(["attribute_schema"]));
    await flush();
    expect(t.data.schemas()).toHaveLength(1);
    expect(t.calls.labels).toBe(1);
    expect(t.calls.schemas).toBe(2);
  });

  it("現在位置のアセットが asset_ids に含まれるときだけ、詳細を読み直す", async () => {
    const t = setup();
    t.current.open(open("a1"));
    await flush();
    expect(t.calls.details).toEqual(["a1"]);
    t.emit(changeSet(["annotation"], ["a2"]));
    await flush();
    expect(t.calls.details).toEqual(["a1"]);
    t.setNote("a1", "memo");
    t.emit(changeSet(["asset"], ["a1"]));
    await flush();
    expect(t.calls.details).toEqual(["a1", "a1"]);
    expect(t.data.details()?.asset.note).toBe("memo");
  });

  it("古い読み込みの結果は、新しい現在位置を上書きしない", async () => {
    const t = setup();
    t.current.open(open("a1"));
    t.current.open(open("a2"));
    await flush();
    expect(t.data.details()?.asset.id).toBe("a2");
  });

  it("reset で、すべて空に戻る", async () => {
    const t = setup();
    await t.data.refresh();
    t.current.open(open("a1"));
    await flush();
    t.data.reset();
    expect(t.data.labels()).toEqual([]);
    expect(t.data.details()).toBeNull();
  });
});
