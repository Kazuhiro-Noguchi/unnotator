// シェルのテストが共通で使う道具。実際の IPC・DOM・タイマーの代わりになる。
import type { ProblemInput, ProblemSink } from "../types";

/** 問題の受け皿。集まった問題を取り出せる。 */
export function makeProblemSink(): {
  sink: ProblemSink;
  problems: ProblemInput[];
} {
  const problems: ProblemInput[] = [];
  return { sink: (p) => problems.push(p), problems };
}

/** 偽のイベントの発生源。購読と発火ができる。 */
export class FakeEmitter<T> {
  private handlers = new Set<(payload: T) => void>();
  listen(handler: (payload: T) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  emit(payload: T): void {
    for (const handler of [...this.handlers]) handler(payload);
  }
  get size(): number {
    return this.handlers.size;
  }
}

/** 偽の設定ファイル（user 層）。`settingsLayer` / `settingsSet` と同じ形。 */
export class FakeUserSettings {
  values: Record<string, unknown> = {};
  setCalls: Array<{ key: string; valueJson: string }> = [];
  failSet = false;
  failLayer = false;

  constructor(initial: Record<string, unknown> = {}) {
    this.values = { ...initial };
  }

  async layer(): Promise<string> {
    if (this.failLayer) throw new Error("layer failed");
    return JSON.stringify(this.values);
  }

  async set(key: string, valueJson: string): Promise<void> {
    this.setCalls.push({ key, valueJson });
    if (this.failSet) throw new Error("set failed");
    this.values[key] = JSON.parse(valueJson);
  }
}

export interface FakeKeyInit {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  target?: unknown;
  repeat?: boolean;
}

/** `KeyboardEvent` の代わり。`preventDefault` の呼び出しを記録する。 */
export function fakeKeyEvent(init: FakeKeyInit) {
  let prevented = false;
  let stopped = false;
  return {
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    metaKey: init.metaKey ?? false,
    isComposing: init.isComposing ?? false,
    keyCode: init.keyCode ?? 0,
    repeat: init.repeat ?? false,
    target: init.target ?? null,
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
    get defaultPrevented() {
      return prevented;
    },
    get propagationStopped() {
      return stopped;
    },
  };
}

/** 偽の編集可能な要素（入力欄）。 */
export function fakeElement(tag: string, editable = false) {
  return { tagName: tag.toUpperCase(), isContentEditable: editable };
}
