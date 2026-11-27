// 属性スキーマを変えたときの、既存の値への影響（FR-016）。値は消さない。件数を示して確認を求めるだけ。

interface RawProperty {
  type?: unknown;
  enum?: unknown;
}

function properties(json: string | null): Record<string, RawProperty> | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;
    const props = (parsed as { properties?: unknown }).properties;
    return typeof props === "object" && props !== null
      ? (props as Record<string, RawProperty>)
      : {};
  } catch {
    return null;
  }
}

/** 型・選択肢の「中身」だけを比べる（タイトル・説明・既定値・必須は、値に影響しない）。 */
function signature(property: RawProperty): string {
  return JSON.stringify([property.type ?? null, property.enum ?? null]);
}

/** 既存の値に影響する属性の名前。`after` が `null` なら、スキーマの削除。 */
export function affectedNames(
  before: string | null,
  after: string | null,
): string[] {
  const old = properties(before);
  if (old === null) return [];
  const next = after === null ? {} : properties(after);
  if (next === null) return [];
  const names: string[] = [];
  for (const [name, property] of Object.entries(old)) {
    const updated = next[name];
    if (updated === undefined || !isCompatible(property, updated)) {
      names.push(name);
    }
  }
  return names;
}

/** 型が同じで、選択肢が減っていなければ、既存の値は引き続き有効。 */
function isCompatible(before: RawProperty, after: RawProperty): boolean {
  if (signature(before) === signature(after)) return true;
  if (
    Array.isArray(before.enum) &&
    Array.isArray(after.enum) &&
    before.type === after.type
  ) {
    return before.enum.every((value) =>
      (after.enum as unknown[]).includes(value),
    );
  }
  return false;
}

export type Assessment =
  | { kind: "proceed" }
  | { kind: "confirm"; count: number };

export function assess(count: number): Assessment {
  return count === 0 ? { kind: "proceed" } : { kind: "confirm", count };
}
