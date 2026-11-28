// 版の範囲の判定。`crates/core/src/extensions_list.rs` の `version_satisfies` と同じ規則。
type Triple = [number, number, number];

function parse(text: string): { numbers: Triple; parts: number } | null {
  const core = text.split(/[-+]/)[0] ?? "";
  const parts = core.split(".");
  if (parts.length < 1 || parts.length > 3) return null;
  const numbers: Triple = [0, 0, 0];
  for (const [i, part] of parts.entries()) {
    if (!/^\d+$/.test(part)) return null;
    numbers[i] = Number(part);
  }
  return { numbers, parts: parts.length };
}

function compare(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 範囲か版を読めなければ false。 */
export function versionSatisfies(range: string, version: string): boolean {
  const r = range.trim();
  if (r === "*") return true;
  let kind: "=" | ">" | "^" | "~" = "=";
  let rest = r;
  if (r.startsWith(">=")) [kind, rest] = [">", r.slice(2)];
  else if (r.startsWith("^")) [kind, rest] = ["^", r.slice(1)];
  else if (r.startsWith("~")) [kind, rest] = ["~", r.slice(1)];
  const base = parse(rest.trim());
  const have = parse(version.trim());
  if (base === null || have === null) return false;
  const [major, minor, patch] = base.numbers;
  if (kind === "=") return compare(have.numbers, base.numbers) === 0;
  if (kind === ">") return compare(have.numbers, base.numbers) >= 0;
  let upper: Triple;
  if (kind === "~") {
    upper = base.parts >= 2 ? [major, minor + 1, 0] : [major + 1, 0, 0];
  } else if (major > 0 || base.parts === 1) {
    upper = [major + 1, 0, 0];
  } else if (minor > 0 || base.parts === 2) {
    upper = [0, minor + 1, 0];
  } else {
    upper = [0, 0, patch + 1];
  }
  return (
    compare(have.numbers, base.numbers) >= 0 && compare(have.numbers, upper) < 0
  );
}
