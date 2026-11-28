// 候補の表示の入口。ホストの候補の保管（`src/host/suggestions.ts`）のうち、画面が使う部分だけ。
// 画面は、保管の中身（検査・コマンド）を知らない。

export interface SuggestionRowView {
  id: string;
  type: string;
  summary: string;
  /** 提案した拡張機能の ID。 */
  source: string;
  title: string | null;
}

export interface SuggestionsSource {
  list(assetId: string, itemKey: string | null): readonly SuggestionRowView[];
  subscribe(listener: () => void): () => void;
  /** 採用する。失敗したら投げる（候補は残る）。 */
  accept(ids: string[]): Promise<unknown>;
  acceptAll(assetId: string, itemKey: string | null): Promise<unknown>;
  reject(ids: string[]): void;
  rejectAll(assetId: string, itemKey: string | null): void;
}
