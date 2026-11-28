// マニフェスト（登録簿が返す JSON）のうち、Host API の検査に要る部分。
// 宣言のないもの（種別・コマンド・ビュー・設定のキー・依存）は、実行時に拒否する（FR-031）。
import { isRecord } from "./convert";

export interface ManifestFacts {
  id: string;
  /** 宣言した権限。 */
  permissions: string[];
  extensionDependencies: string[];
  /** 登録を許す、ローカル名。 */
  contributes: {
    commands: string[];
    annotationTypes: string[];
    relationTypes: string[];
    groupTypes: string[];
    itemProviders: string[];
    exporters: string[];
    importers: string[];
    editors: string[];
    previewers: string[];
    views: string[];
    statusBarItems: string[];
    tools: string[];
  };
  settingKeys: string[];
}

export interface ManifestSource {
  id: string;
  manifest: string | null;
}

function names(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) =>
    isRecord(entry) && typeof entry.id === "string" ? [entry.id] : [],
  );
}

export function parseManifest(source: ManifestSource): ManifestFacts | null {
  if (source.manifest === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(source.manifest);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const c = isRecord(raw.contributes) ? raw.contributes : {};
  const settings = isRecord(c.settings) ? c.settings : {};
  const properties = isRecord(settings.properties) ? settings.properties : {};
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    id: source.id,
    permissions: strings(raw.permissions),
    extensionDependencies: isRecord(raw.extensionDependencies)
      ? Object.keys(raw.extensionDependencies)
      : [],
    contributes: {
      commands: names(c.commands),
      annotationTypes: names(c.annotationTypes),
      relationTypes: names(c.relationTypes),
      groupTypes: names(c.groupTypes),
      itemProviders: names(c.itemProviders),
      exporters: names(c.exporters),
      importers: names(c.importers),
      editors: names(c.editors),
      previewers: names(c.previewers),
      views: names(c.views),
      statusBarItems: names(c.statusBarItems),
      tools: names(c.tools),
    },
    settingKeys: Object.keys(properties),
  };
}

export interface ManifestIndex {
  get(extId: string): ManifestFacts | undefined;
  all(): ManifestFacts[];
}

/** 登録簿の一覧から引く索引。一覧は読み直されるので、毎回元を見る（同じ文字列の解析は使い回す）。 */
export function createManifestIndex(
  source: () => readonly ManifestSource[],
): ManifestIndex {
  const cache = new Map<
    string,
    { text: string; facts: ManifestFacts | null }
  >();
  const facts = (info: ManifestSource): ManifestFacts | undefined => {
    if (info.manifest === null) return undefined;
    const hit = cache.get(info.id);
    if (hit !== undefined && hit.text === info.manifest)
      return hit.facts ?? undefined;
    const parsed = parseManifest(info);
    cache.set(info.id, { text: info.manifest, facts: parsed });
    return parsed ?? undefined;
  };
  return {
    get: (extId) => {
      const info = source().find((i) => i.id === extId);
      return info === undefined ? undefined : facts(info);
    },
    all: () =>
      source().flatMap((info) => {
        const f = facts(info);
        return f === undefined ? [] : [f];
      }),
  };
}
