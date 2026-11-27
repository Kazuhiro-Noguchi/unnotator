// @vitest-environment happy-dom
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { t } from "../../i18n";
import type {
  AnnotationRow,
  Command,
  GroupRow,
  RelationRow,
} from "../project-data/types";
import { Links, type LinksProps } from "./Links";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

const ann = (id: string): AnnotationRow => ({
  id,
  type: "t/t",
  type_version: 1,
  label_id: null,
  attributes_json: "{}",
  summary: `s-${id}`,
  z_order: 0,
  source: "manual",
});

const relation: RelationRow = {
  id: "r1",
  type: "core/relation",
  from_id: "a",
  to_id: "b",
  directed: true,
  label_id: null,
  attributes_json: "{}",
  source: "manual",
};

const group = (ordered: boolean): GroupRow => ({
  id: "g1",
  type: "core/group",
  ordered,
  label_id: null,
  attributes_json: "{}",
  source: "manual",
  members: ["a", "b", "c"],
});

function mount(over: Partial<LinksProps> = {}) {
  const ran: Command[] = [];
  const calls: string[] = [];
  const root = document.createElement("div");
  document.body.append(root);
  const props: LinksProps = {
    relations: [relation],
    groups: [group(true)],
    rows: [ann("a"), ann("b"), ann("c")],
    labels: [],
    schemas: [],
    selected: new Set<string>(),
    run: (command) => {
      ran.push(command);
    },
    onCreateRelation: () => {
      calls.push("relation");
    },
    onCreateGroup: () => {
      calls.push("group");
    },
    onAddToGroup: (id) => {
      calls.push(`add:${id}`);
    },
    onMove: (g, id, dir) => {
      calls.push(`move:${g.id}:${id}:${dir}`);
    },
    ...over,
  };
  dispose = render(() => <Links {...props} />, root);
  return { root, ran, calls };
}

const button = (root: HTMLElement, text: string) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === text,
  );

describe("Links（関係とグループ）", () => {
  it("関係は、両端のアノテーションの名前で出す。削除は delete_relation", () => {
    const { root, ran } = mount();
    expect(root.querySelector(".link-title")?.textContent).toContain("s-a");
    expect(root.querySelector(".link-title")?.textContent).toContain("s-b");
    const del = [
      ...root.querySelectorAll<HTMLButtonElement>(".link-item button"),
    ].find((b) => b.textContent === t("properties.delete"));
    del?.click();
    expect(ran).toEqual([{ kind: "delete_relation", id: "r1" }]);
  });

  it("「関係を作る」は、2 つ選んだときだけ押せる", () => {
    const one = mount({ selected: new Set(["a"]) });
    expect(button(one.root, t("relations.create"))?.disabled).toBe(true);
    dispose?.();
    document.body.innerHTML = "";
    const two = mount({ selected: new Set(["a", "b"]) });
    const create = button(two.root, t("relations.create"));
    expect(create?.disabled).toBe(false);
    create?.click();
    expect(two.calls).toEqual(["relation"]);
  });

  it("グループのメンバーを外す・順序ありなら上下に動かせる", () => {
    const { root, ran, calls } = mount();
    const members = root.querySelectorAll<HTMLElement>(".member-list li");
    expect(members).toHaveLength(3);
    const inRow = (index: number, label: string): HTMLButtonElement => {
      const found = members[index]?.querySelector<HTMLButtonElement>(
        `button[aria-label="${label}"]`,
      );
      if (found === null || found === undefined) throw new Error(label);
      return found;
    };
    inRow(1, t("labels.moveUp")).click();
    expect(calls).toEqual(["move:g1:b:up"]);
    inRow(2, t("groups.removeMember")).click();
    expect(ran).toEqual([
      { kind: "remove_group_members", group_id: "g1", annotation_ids: ["c"] },
    ]);
  });

  it("順序なしのグループには、上下のボタンを出さない", () => {
    const { root } = mount({ groups: [group(false)] });
    expect(
      root.querySelector(`button[aria-label="${t("labels.moveUp")}"]`),
    ).toBeNull();
  });

  it("グループの順序あり・なしを切り替える（update_group）", () => {
    const { root, ran } = mount();
    const checkbox = [
      ...root.querySelectorAll<HTMLInputElement>(
        ".link-item input[type=checkbox]",
      ),
    ].at(-1);
    if (checkbox === undefined) throw new Error("チェックボックスが無い");
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(ran).toEqual([
      {
        kind: "update_group",
        id: "g1",
        patch: { ordered: { kind: "set", value: false } },
      },
    ]);
  });

  it("関係・グループが無いときは、案内を出す", () => {
    const { root } = mount({ relations: [], groups: [] });
    expect(root.textContent).toContain(t("relations.none"));
    expect(root.textContent).toContain(t("groups.none"));
  });
});
