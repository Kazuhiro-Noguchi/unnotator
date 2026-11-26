import type { MessageKey } from "../i18n";

export interface StartupDeps {
  setTitle: (title: string) => Promise<void>;
  appInfo: () => Promise<{ name: string; version: string }>;
  reportReady: () => Promise<void>;
  t: (key: MessageKey) => string;
  /** 最初の描画が終わったときに `callback` を 1 回呼ぶよう登録する。 */
  onFirstRender: (callback: () => void) => void;
  /** 利用者の設定（配置・テーマ・言語など）を読んで適用する。最初の描画を待たせない。 */
  applySettings?: () => Promise<void>;
}

/**
 * 起動時の処理。ウィンドウのタイトルを i18n の文字列に設定し、
 * 最初の描画が終わったら Rust に知らせる。失敗しても例外は外に出さない。
 */
export async function startup(deps: StartupDeps): Promise<void> {
  try {
    await deps.setTitle(deps.t("app.title"));
    await deps.appInfo();
    deps.onFirstRender(() => {
      void deps.reportReady().catch(() => {});
    });
    // 最初の描画を待たせず、既定の見た目で描いたあとに、読み込んだ設定へ差し替える。
    void deps.applySettings?.().catch(() => {});
  } catch {
    // 起動の補助的な処理なので、失敗しても画面は出す。
  }
}
