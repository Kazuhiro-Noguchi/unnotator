-- unnotator recovery journal schema v1
-- 置き場所: <アプリデータ>/unnotator/recovery/<sha256(正規化したプロジェクトフォルダの絶対パス)>/journal.db
-- 同じフォルダに作業用コピー working.db（project スキーマ）を置く。
--
-- 役割
--   1. 異常終了後の復元判定（session の base_* と .unnotator/project.db の現在値を比べる）
--   2. 復元確認ダイアログでの変更件数・最終更新時刻の表示
--   3. 復元後の Undo 履歴の再構築（新しい順に最大 500 件）
--
-- 書き込み順序（1 コマンドごと）
--   working.db のトランザクションをコミット → entries に 1 行追加してコミット。
--   entries が遅れても working.db が正なので整合性は崩れない（Undo 履歴が 1 件少なくなるだけ）。
--
-- 手動保存の成功時: entries を全削除し、base_* を保存後の project.db の値に更新する。
-- 「保存しない」で閉じたとき・保存済みで閉じたとき: このフォルダごと削除する。
-- 復元判定: フォルダが残っていて entries が 1 件以上、かつ pid のプロセスが生存していなければ復元を提案する。

PRAGMA foreign_keys = ON;

CREATE TABLE session (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  project_root     TEXT NOT NULL,             -- プロジェクトフォルダの絶対パス（表示・孤立判定用）
  project_id       TEXT NOT NULL,             -- project.db の meta.project_id
  base_mtime_ms    INTEGER,                   -- 作業開始時（または最後の保存時）の project.db の mtime
  base_size        INTEGER,
  opened_at        INTEGER NOT NULL,
  last_change_at   INTEGER,
  app_version      TEXT NOT NULL,
  pid              INTEGER NOT NULL
) STRICT;

-- command_json / inverse_json は Rust の Command enum を serde で直列化したもの（コア内部形式）。
-- 形式を変えたら app_version で判別し、読めない entries は Undo 再構築から除外する（working.db は使える）。
CREATE TABLE entries (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  at             INTEGER NOT NULL,
  label          TEXT NOT NULL,                 -- Undo メニューの表示名（例: "範囲を追加"）
  source         TEXT NOT NULL DEFAULT 'user',  -- 'user' または拡張機能 ID
  asset_id       TEXT,                          -- Undo 時に開くアセット（無ければ NULL）
  command_json   TEXT NOT NULL CHECK (json_valid(command_json)),
  inverse_json   TEXT NOT NULL CHECK (json_valid(inverse_json))
) STRICT;

PRAGMA user_version = 1;
