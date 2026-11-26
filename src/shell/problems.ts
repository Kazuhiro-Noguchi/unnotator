// シェルの問題の集まり。011 の「問題」ビューが読む（contracts/shell-api.md）。
import type { ProblemInput, ShellProblem } from "./types";

const LIMIT = 500;

export function createProblems(now: () => number = Date.now) {
  let items: ShellProblem[] = [];
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of [...listeners]) listener();
  };

  return {
    report(problem: ProblemInput): void {
      const same = items.find(
        (p) =>
          p.code === problem.code &&
          p.source === problem.source &&
          p.message === problem.message,
      );
      if (same) {
        same.count += 1;
        same.at = now();
      } else {
        items.push({ ...problem, at: now(), count: 1 });
        if (items.length > LIMIT) items = items.slice(items.length - LIMIT);
      }
      emit();
    },
    list(): ShellProblem[] {
      return items.map((p) => ({ ...p }));
    },
    clear(): void {
      items = [];
      emit();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const problemStore = createProblems();
export const reportProblem = problemStore.report;
export const problems = problemStore.list;
