//! 統合テスト共通の準備。契約の SQL を適用した DB、アセットの準備、全テーブルのスナップショット。
//!
//! アセットの登録は 004 の範囲なので、ここではテストの準備として行を直接入れる。
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use rusqlite::Connection;
use rusqlite::types::Value;
use unnotator_core::clock::ManualClock;
use unnotator_core::command::{Command, Target};
use unnotator_core::id::SequentialIds;
use unnotator_core::migrations::PROJECT_V1;
use unnotator_core::project::{CloseAction, OpenOutcome, ProjectStore, StoreConfig};
use unnotator_core::recovery::recovery_dir_for;

/// 一時フォルダ。破棄すると中身ごと消える。
/// 中に `project/`（プロジェクトのフォルダ）と `recovery/`（作業用データの置き場）を持つ。
pub struct TempDir {
    root: PathBuf,
    path: PathBuf,
}

impl TempDir {
    pub fn new() -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!(
            "unnotator-test-{}-{}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let path = root.join("project");
        std::fs::create_dir_all(&path).expect("一時フォルダを作れる");
        std::fs::create_dir_all(root.join("recovery")).expect("一時フォルダを作れる");
        Self { root, path }
    }

    /// プロジェクトのフォルダ。
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 作業用データの置き場（`StoreConfig::new` に渡す）。
    pub fn recovery_root(&self) -> PathBuf {
        self.root.join("recovery")
    }
}

impl Default for TempDir {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// 契約の SQL（版 1）を適用した、メモリ上の空の DB。
pub fn empty_project_db() -> Connection {
    let conn = Connection::open_in_memory().expect("メモリ上の DB を開ける");
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    conn.execute_batch(PROJECT_V1)
        .expect("契約の SQL を適用できる");
    conn
}

/// アセットを 1 件登録する（テストの準備）。
pub fn insert_asset(conn: &Connection, id: &str, rel_path: &str) {
    conn.execute(
        "INSERT INTO assets (id, rel_path, file_size, mtime_ms, created_at, updated_at) \
         VALUES (?1, ?2, 0, 0, 0, 0)",
        [id, rel_path],
    )
    .expect("アセットを登録できる");
}

/// 全テーブルの内容（`sqlite_master` の表のうち内部のものを除く）を、順序が決まった形で取り出す。
pub type Snapshot = Vec<(String, Vec<Vec<Value>>)>;

pub fn snapshot(conn: &Connection) -> Snapshot {
    let mut names: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    names.sort();
    names
        .into_iter()
        .map(|name| {
            let columns: Vec<String> = conn
                .prepare(&format!("PRAGMA table_info({name})"))
                .unwrap()
                .query_map([], |row| row.get(1))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            let order = (1..=columns.len())
                .map(|i| i.to_string())
                .collect::<Vec<_>>()
                .join(", ");
            let mut stmt = conn
                .prepare(&format!("SELECT * FROM {name} ORDER BY {order}"))
                .unwrap();
            let rows = stmt
                .query_map([], |row| {
                    (0..columns.len())
                        .map(|i| row.get::<_, Value>(i))
                        .collect::<Result<Vec<_>, _>>()
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            (name, rows)
        })
        .collect()
}

/// `TempDir::path()` のフォルダに対応する、作業用データの置き場（`<root>/recovery`）。
pub fn recovery_root_of(folder: &Path) -> PathBuf {
    folder
        .parent()
        .expect("TempDir のフォルダには親がある")
        .join("recovery")
}

/// 固定の時刻と連番の ID にした設定。
pub fn test_config(folder: &Path) -> StoreConfig {
    StoreConfig {
        clock: Box::new(ManualClock::new(1_700_000_000_000)),
        ids: Box::new(SequentialIds::starting_after(1_000)),
        ..StoreConfig::new(recovery_root_of(folder))
    }
}

/// 既定の設定（実際の時刻と UUID）で、置き場だけをテスト用にした設定。
pub fn system_config(folder: &Path) -> StoreConfig {
    StoreConfig::new(recovery_root_of(folder))
}

/// 開く。復元の候補が出たら、テストの失敗にする。
pub fn open_store(folder: &Path) -> ProjectStore {
    open_store_with(folder, test_config(folder))
}

pub fn open_store_with(folder: &Path, config: StoreConfig) -> ProjectStore {
    match ProjectStore::open(folder, config).expect("開ける") {
        OpenOutcome::Opened { store, .. } => store,
        OpenOutcome::RecoveryAvailable(_) => panic!("復元の候補が出てはいけない"),
    }
}

/// 未保存の変更を保存して閉じる。
pub fn save_and_close(store: ProjectStore) {
    store
        .close(Some(CloseAction::Save))
        .map_err(|failed| failed.error)
        .expect("保存して閉じられる");
}

/// 作業用の複製（`working.db`）の場所。
pub fn working_db_path(folder: &Path) -> PathBuf {
    recovery_dir_for(&recovery_root_of(folder), folder).join("working.db")
}

/// 作業用の複製（`working.db`）を、読み取り専用で開く。無ければ（閉じたあとなど）`project.db`。
/// 開いているプロジェクトの中身を、ストアを通さずに確かめる。
pub fn read_conn(folder: &Path) -> Connection {
    let working = working_db_path(folder);
    let path = if working.is_file() {
        working
    } else {
        folder.join(".unnotator/project.db")
    };
    Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("読み取りで開ける")
}

/// 保存済みの `project.db` を、読み取り専用で開く。
pub fn read_saved_conn(folder: &Path) -> Connection {
    Connection::open_with_flags(
        folder.join(".unnotator/project.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .expect("project.db を読み取りで開ける")
}

/// 固定の時刻と連番の ID で、アセットを登録済みのプロジェクトを開く。
/// アセットの登録は 004 の範囲なので、閉じた状態で行を直接入れて準備する。
pub fn new_project(assets: &[&str]) -> (TempDir, ProjectStore) {
    let dir = TempDir::new();
    ProjectStore::create(dir.path(), system_config(dir.path()))
        .unwrap()
        .close(None)
        .map_err(|failed| failed.error)
        .unwrap();
    {
        let conn = Connection::open(dir.path().join(".unnotator/project.db")).unwrap();
        for id in assets {
            insert_asset(&conn, id, &format!("{id}.bin"));
        }
    }
    let store = open_store(dir.path());
    (dir, store)
}

pub fn target(asset: &str) -> Target {
    Target {
        asset_id: asset.to_owned(),
        item: None,
    }
}

pub fn create_annotation(asset: &str, selector: &str) -> Command {
    Command::CreateAnnotation {
        id: None,
        target: target(asset),
        annotation_type: "com.example.shape/shape".to_owned(),
        type_version: None,
        selector_json: selector.to_owned(),
        label_id: None,
        attributes_json: None,
        summary: None,
        z_order: None,
        source: None,
    }
}

pub fn create_label(name: &str) -> Command {
    Command::CreateLabel {
        id: None,
        name: name.to_owned(),
        name_i18n_json: None,
        color: "#112233".to_owned(),
        hotkey: None,
        sort_order: None,
        hidden: None,
        applies_to_json: None,
    }
}

/// 1 列目（主キー）で引いた 1 行（列名→値）。
pub fn row(
    conn: &Connection,
    table: &str,
    id: &str,
) -> Option<std::collections::BTreeMap<String, Value>> {
    let mut stmt = conn
        .prepare(&format!("SELECT * FROM {table} WHERE id = ?1"))
        .unwrap();
    let names: Vec<String> = stmt.column_names().map(str::to_owned).collect();
    stmt.query_row([id], |r| {
        let mut map = std::collections::BTreeMap::new();
        for (i, name) in names.iter().enumerate() {
            map.insert(name.clone(), r.get::<_, Value>(i)?);
        }
        Ok(map)
    })
    .ok()
}

pub fn text(s: &str) -> Value {
    Value::Text(s.to_owned())
}

pub fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

/// `journal.db` の場所。
pub fn journal_db_path(folder: &Path) -> PathBuf {
    recovery_dir_for(&recovery_root_of(folder), folder).join("journal.db")
}

/// `journal.db` を、読み取り専用で開く。
pub fn journal_conn(folder: &Path) -> Connection {
    Connection::open_with_flags(
        journal_db_path(folder),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .expect("journal.db を読み取りで開ける")
}

/// `journal.db` の `entries` を、古い順に `(label, source, asset_id, inverse_json)` で返す。
pub fn journal_entries(folder: &Path) -> Vec<(String, String, Option<String>, String)> {
    let conn = journal_conn(folder);
    let mut stmt = conn
        .prepare("SELECT label, source, asset_id, inverse_json FROM entries ORDER BY seq")
        .unwrap();
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

// ---------------------------------------------------------------------------
// 004: ファイルの木の準備とアセットの読み出し
// ---------------------------------------------------------------------------

/// `root` の下に `rel` のファイルを作る（途中のフォルダも作る）。
pub fn write_file(root: &Path, rel: &str, bytes: &[u8]) {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("フォルダを作れる");
    }
    std::fs::write(path, bytes).expect("ファイルを書ける");
}

pub fn remove_file(root: &Path, rel: &str) {
    std::fs::remove_file(root.join(rel)).expect("ファイルを消せる");
}

/// `from` を `to` へ動かす（行き先のフォルダも作る）。
pub fn move_file(root: &Path, from: &str, to: &str) {
    let target = root.join(to);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).expect("フォルダを作れる");
    }
    std::fs::rename(root.join(from), target).expect("ファイルを動かせる");
}

/// 更新時刻を、UNIX 時刻（ミリ秒）に設定する。
pub fn touch(root: &Path, rel: &str, mtime_ms: u64) {
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(root.join(rel))
        .expect("ファイルを開ける");
    file.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(mtime_ms))
        .expect("更新時刻を設定できる");
}

/// 一覧に出るアセットの行。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetLine {
    pub id: String,
    pub root_key: String,
    pub rel_path: String,
    pub file_size: i64,
    pub mtime_ms: i64,
    pub missing: bool,
    pub media_type: Option<String>,
    pub status: String,
}

/// `working.db`（無ければ `project.db`）の `assets` を、`(root_key, rel_path)` の順で読む。
pub fn read_assets(folder: &Path) -> Vec<AssetLine> {
    let conn = read_conn(folder);
    let mut stmt = conn
        .prepare(
            "SELECT id, root_key, rel_path, file_size, mtime_ms, missing, media_type, status \
             FROM assets ORDER BY root_key, rel_path",
        )
        .unwrap();
    stmt.query_map([], |r| {
        Ok(AssetLine {
            id: r.get(0)?,
            root_key: r.get(1)?,
            rel_path: r.get(2)?,
            file_size: r.get(3)?,
            mtime_ms: r.get(4)?,
            missing: r.get::<_, i64>(5)? == 1,
            media_type: r.get(6)?,
            status: r.get(7)?,
        })
    })
    .unwrap()
    .collect::<Result<_, _>>()
    .unwrap()
}

/// ユーザー設定の置き場（`TempDir` の下）。
pub fn user_settings_dir(dir: &TempDir) -> PathBuf {
    let path = dir.recovery_root().parent().expect("親がある").join("user");
    std::fs::create_dir_all(&path).expect("フォルダを作れる");
    path
}

/// ファイルの木だけを作った、プロジェクトのフォルダ（まだプロジェクトではない）。
pub fn folder_with_files(files: &[(&str, &str)]) -> TempDir {
    let dir = TempDir::new();
    for (rel, body) in files {
        write_file(dir.path(), rel, body.as_bytes());
    }
    dir
}

/// 新しいプロジェクトを、既にあるファイルの木の上に作って開く（アセットは未登録）。
pub fn create_and_open(dir: &TempDir) -> ProjectStore {
    ProjectStore::create(dir.path(), system_config(dir.path()))
        .unwrap()
        .close(None)
        .map_err(|failed| failed.error)
        .unwrap();
    open_store(dir.path())
}

/// テスト用の判定規則（媒体の語を使わない種別名）。
pub fn rules_for_tests() -> unnotator_core::assets::media::MediaRules {
    use unnotator_core::assets::media::{MediaRule, MediaRules};
    let mut rules = MediaRules::new();
    rules
        .push(MediaRule {
            media_type: "test/text".to_owned(),
            extensions: vec!["txt".to_owned(), "md".to_owned()],
            mime_types: vec!["text/plain".to_owned()],
        })
        .expect("規則を足せる");
    rules
        .push(MediaRule {
            media_type: "test/binary".to_owned(),
            extensions: vec!["bin".to_owned()],
            mime_types: vec![],
        })
        .expect("規則を足せる");
    rules
}
