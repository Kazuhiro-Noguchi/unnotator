// `activate` の戻り値（拡張機能間 API）から、関数のメンバーの名前を集める。ホストへ公開する表になる。
const MAX_MEMBERS = 1000;
const MAX_DEPTH = 4;

export function apiPaths(api: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<object>();
  const walk = (value: unknown, prefix: string, depth: number): void => {
    if (out.length >= MAX_MEMBERS) return;
    if (typeof value !== "object" || value === null) return;
    if (seen.has(value) || depth > MAX_DEPTH) return;
    seen.add(value);
    for (const key of Object.keys(value)) {
      if (!/^[A-Za-z_$][\w$]*$/.test(key)) continue;
      const item = (value as Record<string, unknown>)[key];
      const path = prefix === "" ? key : `${prefix}.${key}`;
      if (typeof item === "function") {
        if (out.length < MAX_MEMBERS) out.push(path);
      } else {
        walk(item, path, depth + 1);
      }
    }
  };
  walk(api, "", 0);
  return out;
}

/** `a.b.c` の形の名前で、オブジェクトの中の関数を引く（親の `this` つき）。 */
export function resolveMember(
  api: unknown,
  path: string,
): { fn: (...a: unknown[]) => unknown; owner: unknown } | null {
  let owner: unknown = null;
  let current: unknown = api;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return null;
    owner = current;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "function"
    ? { fn: current as (...a: unknown[]) => unknown, owner }
    : null;
}
