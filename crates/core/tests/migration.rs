//! US5: 古い形式のプロジェクトを自動で移行する。失敗や新しすぎる版で、元を壊さない。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use rusqlite::Connection;
use support::{TempDir, create_label, read_conn, snapshot};
use unnotator_core::command::Command;
use unnotator_core::db::migrate::Migration;
use unnotator_core::migrations::PROJECT_V1;
use unnotator_core::project::{ProjectStore, StoreConfig};

/// 試験用に版 2 を足した列（契約の外のテスト専用のテーブルを足すだけ）。
static WITH_V2: &[Migration] = &[
    Migration {
        version: 1,
        sql: PROJECT_V1,
    },
    Migration {
        version: 2,
        sql: "CREATE TABLE test_extra (x INTEGER NOT NULL) STRICT; INSERT INTO test_extra VALUES (42);",
    },
];

/// 途中で失敗する版 2。
static BROKEN_V2: &[Migration] = &[
    Migration {
        version: 1,
        sql: PROJECT_V1,
    },
    Migration {
        version: 2,
        sql: "CREATE TABLE test_extra (x INTEGER); THIS IS NOT SQL;",
    },
];

fn config(migrations: &'static [Migration]) -> StoreConfig {
    StoreConfig {
        migrations,
        ..StoreConfig::default()
    }
}

fn user_version(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap()
}

fn meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
        .ok()
}

/// 版 1 のプロジェクトを作り、データを入れて閉じる。
fn version_one_project() -> TempDir {
    let dir = TempDir::new();
    let mut store = ProjectStore::create(dir.path()).unwrap();
    store.apply_command(create_label("person")).unwrap();
    store.apply_command(create_label("car")).unwrap();
    store.close().unwrap();
    dir
}

fn db_bytes(dir: &TempDir) -> Vec<u8> {
    std::fs::read(dir.path().join(".unnotator/project.db")).unwrap()
}

fn bak_path(dir: &TempDir) -> std::path::PathBuf {
    dir.path().join(".unnotator/project.db.bak")
}

#[test]
fn an_older_project_is_migrated_with_a_backup_and_keeps_its_data() {
    let dir = version_one_project();
    let before = snapshot(&read_conn(dir.path()));

    let store = ProjectStore::open_with(dir.path(), config(WITH_V2)).unwrap();
    assert_eq!(store.migrated_from(), Some(1));
    assert_eq!(store.schema_version(), 2);
    store.close().unwrap();

    let conn = read_conn(dir.path());
    assert_eq!(user_version(&conn), 2);
    assert_eq!(meta(&conn, "schema_version").as_deref(), Some("2"));
    let extra: i64 = conn
        .query_row("SELECT x FROM test_extra", [], |r| r.get(0))
        .unwrap();
    assert_eq!(extra, 42);
    // 既存のデータは保たれる（契約のテーブルの内容は、移行の前後で同じ）
    let after = snapshot(&conn);
    let contract_tables = |s: &support::Snapshot| -> support::Snapshot {
        s.iter()
            .filter(|(name, _)| name != "test_extra" && name != "meta")
            .cloned()
            .collect()
    };
    assert_eq!(contract_tables(&after), contract_tables(&before));

    // 移行前の内容が退避されている
    let backup = Connection::open(bak_path(&dir)).unwrap();
    assert_eq!(user_version(&backup), 1);
    let labels: i64 = backup
        .query_row("SELECT count(*) FROM labels", [], |r| r.get(0))
        .unwrap();
    assert_eq!(labels, 2);
}

#[test]
fn a_migrated_project_is_usable_afterwards() {
    let dir = version_one_project();
    let mut store = ProjectStore::open_with(dir.path(), config(WITH_V2)).unwrap();
    store.apply_command(create_label("bike")).unwrap();
    assert!(matches!(
        store.apply_command(Command::DeleteLabel {
            id: "missing".into(),
            disposition: None
        }),
        Err(e) if e.code() == "not_found"
    ));
    store.close().unwrap();
}

#[test]
fn a_current_project_is_not_migrated_and_leaves_no_backup() {
    let dir = version_one_project();
    let store = ProjectStore::open(dir.path()).unwrap();
    assert_eq!(store.migrated_from(), None);
    store.close().unwrap();
    assert!(!bak_path(&dir).exists());

    // 移行済みのものを、もう一度開いても、移行も退避の作り直しもしない
    ProjectStore::open_with(dir.path(), config(WITH_V2))
        .unwrap()
        .close()
        .unwrap();
    let backup_bytes = std::fs::read(bak_path(&dir)).unwrap();
    let again = ProjectStore::open_with(dir.path(), config(WITH_V2)).unwrap();
    assert_eq!(again.migrated_from(), None);
    again.close().unwrap();
    assert_eq!(std::fs::read(bak_path(&dir)).unwrap(), backup_bytes);
}

#[test]
fn a_failing_migration_leaves_the_original_usable() {
    let dir = version_one_project();
    let before = snapshot(&read_conn(dir.path()));

    let err = ProjectStore::open_with(dir.path(), config(BROKEN_V2)).unwrap_err();
    assert_eq!(err.code(), "migration_failed");

    // 元のプロジェクトは版 1 のまま、内容も変わらず、もう一度（通常のアプリで）開ける
    let conn = read_conn(dir.path());
    assert_eq!(user_version(&conn), 1);
    assert_eq!(snapshot(&conn), before);
    assert!(conn.prepare("SELECT x FROM test_extra").is_err());
    drop(conn);
    let store = ProjectStore::open(dir.path()).unwrap();
    assert_eq!(store.migrated_from(), None);
    store.close().unwrap();
}

#[test]
fn a_project_newer_than_the_app_is_refused_without_touching_files() {
    let dir = version_one_project();
    {
        let conn = Connection::open(dir.path().join(".unnotator/project.db")).unwrap();
        conn.execute_batch("PRAGMA user_version = 7;").unwrap();
    }
    let bytes = db_bytes(&dir);

    let err = ProjectStore::open(dir.path()).unwrap_err();
    assert_eq!(err.code(), "too_new");
    assert!(err.to_string().contains('7'));
    assert_eq!(db_bytes(&dir), bytes);
    assert!(!bak_path(&dir).exists());
}
