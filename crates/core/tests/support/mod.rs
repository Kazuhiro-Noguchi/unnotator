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
use unnotator_core::project::{ProjectStore, StoreConfig};

/// 一時フォルダ。破棄すると中身ごと消える。
pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    pub fn new() -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "unnotator-test-{}-{}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&path).expect("一時フォルダを作れる");
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Default for TempDir {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
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

/// 読み取り専用の接続（開いているプロジェクトの中身を、ストアを通さずに確かめる）。
pub fn read_conn(folder: &Path) -> Connection {
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
    ProjectStore::create(dir.path()).unwrap().close().unwrap();
    {
        let conn = Connection::open(dir.path().join(".unnotator/project.db")).unwrap();
        for id in assets {
            insert_asset(&conn, id, &format!("{id}.bin"));
        }
    }
    let store = ProjectStore::open_with(
        dir.path(),
        StoreConfig {
            clock: Box::new(ManualClock::new(1_700_000_000_000)),
            ids: Box::new(SequentialIds::starting_after(1_000)),
        },
    )
    .unwrap();
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
