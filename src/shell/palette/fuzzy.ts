// コマンドパレットのあいまい検索（部分列の一致 + 連続・語頭の加点）。
import type { Language } from "../../i18n";
import type { CommandRegistry } from "../commands/registry";
import { allTitles, resolveTitle } from "../title";
import type { UnavailableReason } from "../types";

export interface Candidate {
  id: string;
  texts: string[];
}
export interface Ranked {
  id: string;
  score: number;
}

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

const WORD_BREAK = /[\s._\-/:()]/;

/** 1 つの文字列に対する得点。一致しなければ null。 */
function scoreText(query: string, text: string): number | null {
  const target = normalize(text);
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const ch of query) {
    const at = target.indexOf(ch, from);
    if (at < 0) return null;
    if (at === previous + 1) score += 8; // 連続
    if (at === 0 || WORD_BREAK.test(target[at - 1] ?? "")) score += 6; // 語頭
    if (at === 0) score += 6; // 先頭
    score -= Math.min(at - from, 6) * 0.5; // 離れているほど減点
    previous = at;
    from = at + 1;
  }
  score -= Math.min(target.length, 80) * 0.05; // 短い名前を少し優先
  return score;
}

/** 候補を、入力に合う順に並べる。空の入力は、全件を元の順で返す。 */
export function rank(query: string, candidates: Candidate[]): Ranked[] {
  const q = normalize(query).replace(/\s+/g, "");
  if (q === "") return candidates.map((c) => ({ id: c.id, score: 0 }));
  const results: Array<Ranked & { index: number }> = [];
  candidates.forEach((candidate, index) => {
    let best: number | null = null;
    for (const text of candidate.texts) {
      const score = scoreText(q, text);
      if (score !== null && (best === null || score > best)) best = score;
    }
    if (best !== null) results.push({ id: candidate.id, score: best, index });
  });
  results.sort((a, b) => b.score - a.score || a.index - b.index);
  return results.map(({ id, score }) => ({ id, score }));
}

export interface PaletteEntry {
  id: string;
  title: string;
  category: string | null;
  icon: string | undefined;
  enabled: boolean;
  reason: UnavailableReason | null;
}

/** パレットの候補。実行できないものも出し、その状態を持たせる。 */
export function searchCommands(
  registry: CommandRegistry,
  query: string,
  language: Language,
): PaletteEntry[] {
  const specs = registry.list();
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  const ranked = rank(
    query,
    specs.map((spec) => ({
      id: spec.id,
      texts: [
        ...allTitles(spec.title),
        ...(spec.category ? allTitles(spec.category) : []),
        spec.id,
      ],
    })),
  );
  const entries = ranked.flatMap(({ id, score }) => {
    const spec = byId.get(id);
    if (!spec) return [];
    const state = registry.availability(id)();
    return [
      {
        score,
        entry: {
          id,
          title: resolveTitle(spec.title, language),
          category: spec.category
            ? resolveTitle(spec.category, language)
            : null,
          icon: spec.icon,
          enabled: state.enabled,
          reason: state.enabled ? null : state.reason,
        } satisfies PaletteEntry,
      },
    ];
  });
  // 同じ得点なら、実行できるものを先にする（安定な並べ替え）。
  return entries
    .map((item, index) => ({ ...item, index }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.entry.enabled) - Number(a.entry.enabled) ||
        a.index - b.index,
    )
    .map((item) => item.entry);
}
