-- unnotator project database schema v1
-- 置き場所: <プロジェクトフォルダ>/.unnotator/project.db
-- 作業用コピー: <アプリデータ>/unnotator/recovery/<hash>/working.db（同一スキーマ）
--   編集は作業用コピーへ即時に書き込み、手動保存時に VACUUM INTO + rename で project.db を置き換える。
--   変更履歴（journal）は別ファイル（crates/core/migrations/recovery/0001_init.sql）で、project.db には含めない。
--
-- 設計原則: このスキーマは媒体（画像・テキスト・音声…）を一切知らない。
--   媒体固有の情報は JSON 列（metadata_json / selector_json / attributes_json）に入り、
--   その形式は拡張機能のマニフェスト（selectorSchema など）が定義する。
--   座標・時刻・文字位置などの列をこのスキーマに追加してはならない。
--
-- 規約
--   * ID は UUID v7 の文字列（小文字・ハイフン付き）。
--   * 時刻は UNIX エポックからのミリ秒（INTEGER）。
--   * JSON 列は *_json と命名し json_valid() で検査する。
--   * 名前空間付き ID は '<拡張機能 ID>/<名前>'（例 'com.example.text/span'）。コア内蔵は 'core/<名前>'。
--   * 必要な SQLite: 3.38 以上（STRICT、json 関数）。rusqlite の bundled 機能を使う。

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- メタ情報
-- 必須キー: schema_version ('1'), project_id (UUID), created_at (ms), app_version
-- 任意キー: saved_at (ms)
-- ---------------------------------------------------------------------------
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- ---------------------------------------------------------------------------
-- アセット（ファイル 1 つ）
-- root_key: '' = プロジェクトフォルダ。それ以外は settings.json の assets.externalRoots のキー。
-- rel_path: ルートからの相対パス。区切りは '/'。
-- media_type: 拡張機能のマニフェストで判定した媒体種別 ID。判定できなければ NULL（「不明」）。
--             拡張機能の導入・削除で変わるため、起動時とマニフェスト変更時に再判定する。
-- status: todo=未着手 / in_progress=作業中 / done=完了 / review=要確認
-- missing: ファイルが見つからない（リンク切れ）。アノテーションは保持する。
-- metadata_json: 媒体固有のメタ情報（拡張機能が host.assets.setMetadata で記録。例 {"width":1920}）。
--                キーは拡張機能 ID で名前空間を切る: {"com.example.image": {"width": 1920, ...}}
-- attributes_json: アセット単位の属性値（scope = 'asset' の属性スキーマに従う）。
-- ---------------------------------------------------------------------------
CREATE TABLE assets (
  id               TEXT PRIMARY KEY,
  root_key         TEXT NOT NULL DEFAULT '',
  rel_path         TEXT NOT NULL CHECK (length(rel_path) > 0 AND rel_path NOT LIKE '/%'),
  media_type       TEXT CHECK (media_type IS NULL OR media_type GLOB '*/*'),
  file_size        INTEGER NOT NULL CHECK (file_size >= 0),
  mtime_ms         INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'todo'
                   CHECK (status IN ('todo', 'in_progress', 'done', 'review')),
  missing          INTEGER NOT NULL DEFAULT 0 CHECK (missing IN (0, 1)),
  metadata_json    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  attributes_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes_json)),
  note             TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (root_key, rel_path)
) STRICT;

CREATE INDEX assets_media_type ON assets (media_type);
CREATE INDEX assets_status ON assets (status);
CREATE INDEX assets_missing ON assets (missing) WHERE missing = 1;

-- ---------------------------------------------------------------------------
-- アイテム（拡張機能のアイテムプロバイダーがアセットを分割した単位）
-- 例: item_key = 'page:3' / 'frame:120' / 'row:42'。キーの形式は拡張機能が決め、安定でなければならない。
-- 状態・属性・アノテーションのいずれかが付いたときにだけ行を作る（全アイテムを列挙して保存しない）。
-- ---------------------------------------------------------------------------
CREATE TABLE items (
  id               TEXT PRIMARY KEY,
  asset_id         TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  item_key         TEXT NOT NULL CHECK (length(item_key) > 0),
  provider         TEXT NOT NULL CHECK (provider GLOB '*/*'),
  status           TEXT NOT NULL DEFAULT 'todo'
                   CHECK (status IN ('todo', 'in_progress', 'done', 'review')),
  metadata_json    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  attributes_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes_json)),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (asset_id, item_key)
) STRICT;

-- ---------------------------------------------------------------------------
-- ラベル
-- name: 書き出し用の識別名（一意）。name_i18n_json: {"ja": "人物", "en": "Person"}
-- applies_to_json: 使える対象の絞り込み。空オブジェクト = すべて。
--   {"annotationTypes": ["com.example.image-rect/rect"], "relationTypes": [], "groupTypes": [],
--    "classification": true, "mediaTypes": ["com.example.image/image"]}
--   各キーは省略可。省略したキーは制限なし。
-- ---------------------------------------------------------------------------
CREATE TABLE labels (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE CHECK (length(name) > 0),
  name_i18n_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(name_i18n_json)),
  color            TEXT NOT NULL CHECK (color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
  hotkey           INTEGER UNIQUE CHECK (hotkey IS NULL OR hotkey BETWEEN 1 AND 9),
  sort_order       INTEGER NOT NULL DEFAULT 0,
  hidden           INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  applies_to_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(applies_to_json)),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
) STRICT;

-- ---------------------------------------------------------------------------
-- 属性スキーマ（JSON Schema サブセット: type=object、properties の各型は
-- string / number / integer / boolean / enum、required、default、title、description）
-- scope と target:
--   global          target = ''                 全アノテーション共通
--   label           target = labels.id          そのラベルのアノテーション・関係・グループ
--   annotation_type target = 種別 ID            その種別のアノテーション
--   relation_type   target = 関係種別 ID
--   group_type      target = グループ種別 ID
--   asset           target = '' または媒体種別 ID  アセット単位
--   item            target = '' または アイテムプロバイダー ID
-- ---------------------------------------------------------------------------
CREATE TABLE attribute_schemas (
  id           TEXT PRIMARY KEY,
  scope        TEXT NOT NULL CHECK (scope IN
               ('global', 'label', 'annotation_type', 'relation_type', 'group_type', 'asset', 'item')),
  target       TEXT NOT NULL DEFAULT '',
  schema_json  TEXT NOT NULL CHECK (json_valid(schema_json)),
  updated_at   INTEGER NOT NULL,
  UNIQUE (scope, target),
  CHECK ((scope = 'global') = (target = '') OR scope IN ('asset', 'item'))
) STRICT;

-- ---------------------------------------------------------------------------
-- アノテーション
-- 対象: asset_id（必須）+ item_id（任意）+ selector_json（位置の指定）
-- type: 名前空間付きの種別 ID。コア内蔵の 'core/classification' は selector_json = '{}' で
--       アセット（item_id があればアイテム）全体への分類を表す。
-- type_version: マニフェストの annotationTypes[].version。読み込み時に古ければ拡張機能の migrate を通す。
-- summary: 種別の拡張機能が生成した短い表示文。拡張機能が無い環境での一覧表示に使う。
-- source: 'manual' または作成した拡張機能 ID（候補の採用を含む）。
-- label_id は ON DELETE RESTRICT。ラベル削除時はコアが「付け替え / 一緒に削除」を先に行う。
-- ---------------------------------------------------------------------------
CREATE TABLE annotations (
  id               TEXT PRIMARY KEY,
  asset_id         TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  item_id          TEXT REFERENCES items (id) ON DELETE CASCADE,
  type             TEXT NOT NULL CHECK (type GLOB '*/*'),
  type_version     INTEGER NOT NULL DEFAULT 1 CHECK (type_version >= 1),
  selector_json    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(selector_json)),
  label_id         TEXT REFERENCES labels (id) ON DELETE RESTRICT,
  attributes_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes_json)),
  summary          TEXT NOT NULL DEFAULT '',
  z_order          INTEGER NOT NULL DEFAULT 0,
  source           TEXT NOT NULL DEFAULT 'manual',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
) STRICT;

CREATE INDEX annotations_asset ON annotations (asset_id, item_id, z_order);
CREATE INDEX annotations_label ON annotations (label_id);
CREATE INDEX annotations_type ON annotations (type);

-- ---------------------------------------------------------------------------
-- 関係（アノテーション同士のリンク）
-- 異なるアセットのアノテーション同士も結べる（例: 画像とキャプションの対応）。
-- どちらかのアノテーションが削除されると関係も削除される（同じ Undo 単位でコアが記録する）。
-- ---------------------------------------------------------------------------
CREATE TABLE relations (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL CHECK (type GLOB '*/*'),
  from_id          TEXT NOT NULL REFERENCES annotations (id) ON DELETE CASCADE,
  to_id            TEXT NOT NULL REFERENCES annotations (id) ON DELETE CASCADE,
  directed         INTEGER NOT NULL DEFAULT 1 CHECK (directed IN (0, 1)),
  label_id         TEXT REFERENCES labels (id) ON DELETE RESTRICT,
  attributes_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes_json)),
  source           TEXT NOT NULL DEFAULT 'manual',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK (from_id <> to_id)
) STRICT;

CREATE INDEX relations_from ON relations (from_id);
CREATE INDEX relations_to ON relations (to_id);

-- ---------------------------------------------------------------------------
-- グループ（アノテーションの集合。追跡・共参照・まとまりなど）
-- ordered = 1 のとき group_members.position が意味を持つ（例: フレーム順の追跡）。
-- メンバーが 0 件になったグループは削除しない（ユーザーが明示的に消す）。
-- ---------------------------------------------------------------------------
CREATE TABLE annotation_groups (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL CHECK (type GLOB '*/*'),
  ordered          INTEGER NOT NULL DEFAULT 0 CHECK (ordered IN (0, 1)),
  label_id         TEXT REFERENCES labels (id) ON DELETE RESTRICT,
  attributes_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes_json)),
  source           TEXT NOT NULL DEFAULT 'manual',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
) STRICT;

CREATE TABLE group_members (
  group_id       TEXT NOT NULL REFERENCES annotation_groups (id) ON DELETE CASCADE,
  annotation_id  TEXT NOT NULL REFERENCES annotations (id) ON DELETE CASCADE,
  position       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, annotation_id)
) STRICT;

CREATE INDEX group_members_annotation ON group_members (annotation_id);

-- ---------------------------------------------------------------------------
-- 拡張機能専用の保存領域（プロジェクトの一部として保存・Undo 対象外）
-- 拡張機能を削除してもデータは残す。
-- ファイルとして置きたいものは .unnotator/plugins/<id>/ を使う（project.files 権限）。
-- ---------------------------------------------------------------------------
CREATE TABLE plugin_data (
  plugin_id   TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK (scope IN ('project', 'asset', 'item')),
  scope_id    TEXT NOT NULL DEFAULT '',
  key         TEXT NOT NULL,
  value_json  TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, scope, scope_id, key),
  CHECK ((scope = 'project') = (scope_id = ''))
) STRICT;

PRAGMA user_version = 1;
