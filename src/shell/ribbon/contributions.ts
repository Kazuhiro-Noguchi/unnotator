// 拡張機能のリボンへの寄与（contributes.ribbon）を、コアのタブ・グループに統合する。
// 形はスキーマ（unnotator-plugin.schema.json の ribbon・ribbonGroup・ribbonItem）に合わせる。
// 参照（command など）は、005 の登録簿が完全 ID に解決したものを受ける。
import type {
  ControlKind,
  ProblemSink,
  RibbonControl,
  RibbonGroup,
  RibbonTab,
  Title,
} from "../types";

export interface ContributedItem {
  type: ControlKind;
  command?: string;
  tool?: string;
  args?: unknown;
  items?: ContributedItem[];
  when?: string;
}

export interface ContributedGroup {
  id: string;
  title: string | Title;
  priority?: number;
  items: ContributedItem[];
  when?: string;
}

export interface ContributesRibbon {
  groups?: Array<{
    tab: string;
    group?: string;
    id?: string;
    title?: string | Title;
    priority?: number;
    items: ContributedItem[];
    when?: string;
  }>;
  tabs?: Array<{
    id: string;
    title: string | Title;
    order?: number;
    groups: ContributedGroup[];
    when?: string;
  }>;
  contextualTabs?: Array<{
    id: string;
    title: string | Title;
    when: string;
    groups: ContributedGroup[];
  }>;
}

export interface ContributionEntry {
  source: string;
  ribbon: ContributesRibbon;
}

const EXTENSION_TAB_ORDER = 100;
const CONTEXTUAL_TAB_ORDER = 900;

const asTitle = (title: string | Title | undefined): Title =>
  typeof title === "string" ? { ja: title, en: title } : (title ?? {});

const qualified = (source: string, id: string) => `${source}/${id}`;

function toControl(item: ContributedItem): RibbonControl {
  const control: RibbonControl = { kind: item.type };
  if (item.command !== undefined) control.command = item.command;
  if (item.tool !== undefined) control.tool = item.tool;
  if (item.args !== undefined) control.args = item.args;
  if (item.when !== undefined) control.when = item.when;
  if (item.items) control.items = item.items.map(toControl);
  return control;
}

function toGroup(source: string, group: ContributedGroup): RibbonGroup {
  const result: RibbonGroup = {
    id: qualified(source, group.id),
    title: asTitle(group.title),
    priority: group.priority ?? 0,
    controls: group.items.map(toControl),
    source,
  };
  if (group.when !== undefined) result.when = group.when;
  return result;
}

/** コアのタブに、寄与を統合した結果を返す（コアの定義は変えない）。 */
export function mergeRibbon(
  core: RibbonTab[],
  entries: ContributionEntry[],
  report: ProblemSink,
  reported: Set<string>,
): RibbonTab[] {
  const tabs: RibbonTab[] = structuredClone(core);

  const missing = (source: string, target: string) => {
    const key = `${source}\u0000${target}`;
    if (reported.has(key)) return;
    reported.add(key);
    report({
      code: "ribbon.target-missing",
      source,
      message: `リボンの寄与が、存在しないタブ・グループを指している: ${target}`,
    });
  };

  // 1 周目: 新しいタブ（他の拡張機能のタブに足せるよう、先に全部作る）。
  for (const { source, ribbon } of entries) {
    for (const tab of ribbon.tabs ?? []) {
      const added: RibbonTab = {
        id: qualified(source, tab.id),
        title: asTitle(tab.title),
        order: tab.order ?? EXTENSION_TAB_ORDER,
        groups: tab.groups.map((g) => toGroup(source, g)),
        contextual: false,
        source,
      };
      if (tab.when !== undefined) added.when = tab.when;
      tabs.push(added);
    }
    for (const tab of ribbon.contextualTabs ?? []) {
      tabs.push({
        id: qualified(source, tab.id),
        title: asTitle(tab.title),
        order: CONTEXTUAL_TAB_ORDER,
        groups: tab.groups.map((g) => toGroup(source, g)),
        when: tab.when,
        contextual: true,
        source,
      });
    }
  }

  // 2 周目: 既存のタブへのグループ・既存のグループへの項目。
  for (const { source, ribbon } of entries) {
    for (const entry of ribbon.groups ?? []) {
      const tab = tabs.find((t) => t.id === entry.tab);
      if (!tab) {
        missing(source, entry.tab);
        continue;
      }
      if (entry.group !== undefined) {
        const target = tab.groups.find((g) => g.id === entry.group);
        if (!target) {
          missing(source, entry.group);
          continue;
        }
        target.controls.push(...entry.items.map(toControl));
      } else if (entry.id !== undefined && entry.title !== undefined) {
        tab.groups.push(
          toGroup(source, {
            id: entry.id,
            title: entry.title,
            items: entry.items,
            ...(entry.priority !== undefined
              ? { priority: entry.priority }
              : {}),
            ...(entry.when !== undefined ? { when: entry.when } : {}),
          }),
        );
      } else {
        missing(source, entry.tab);
      }
    }
  }
  return tabs;
}

/**
 * 選んでいるタブが消えたときの戻り先。残っていればそのまま、
 * 消えたら直前の通常のタブ、それも無ければ先頭の通常のタブ（ファイルを除く）。
 */
export function chooseFallbackTab(
  tabs: RibbonTab[],
  selected: string,
  previousNormal: string | null,
): string | null {
  if (tabs.some((tab) => tab.id === selected)) return selected;
  const previous = tabs.find(
    (tab) => tab.id === previousNormal && !tab.contextual,
  );
  if (previous) return previous.id;
  const first = tabs.find((tab) => tab.id !== "file" && !tab.contextual);
  return first?.id ?? tabs[0]?.id ?? null;
}
