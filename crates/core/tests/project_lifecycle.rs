//! US1: プロジェクトフォルダの作成・オープン・クローズ・ロック。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};

use rusqlite::{Connection, OpenFlags};
use support::TempDir;
use unnotator_core::clock::ManualClock;
use unnotator_core::id::SequentialIds;
use unnotator_core::project::{ProjectStore, StoreConfig};

fn read_only(folder: &Path) -> Connection {
    Connection::open_with_flags(
        folder.join(".unnotator/project.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .expect("project.db を読み取りで開ける")
}

fn meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .ok()
}

fn config() -> StoreConfig {
    StoreConfig {
        clock: Box::new(ManualClock::new(1_700_000_000_000)),
        ids: Box::new(SequentialIds::default()),
    }
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

// ---- 作成と開き直し（US1 の 1・2、FR-001〜FR-003） ----

#[test]
fn create_makes_unnotator_dir_with_contract_schema_and_meta() {
    let dir = TempDir::new();
    let store = ProjectStore::create_with(dir.path(), config()).unwrap();
    let project_id = store.project_id().to_owned();
    store.close().unwrap();

    assert!(dir.path().join(".unnotator/project.db").is_file());
    let conn = read_only(dir.path());
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 1);
    assert_eq!(meta(&conn, "schema_version").as_deref(), Some("1"));
    assert_eq!(
        meta(&conn, "project_id").as_deref(),
        Some(project_id.as_str())
    );
    assert_eq!(meta(&conn, "created_at").as_deref(), Some("1700000000000"));
    assert_eq!(
        meta(&conn, "app_version").as_deref(),
        Some(env!("CARGO_PKG_VERSION"))
    );
}

#[test]
fn reopen_returns_same_project_and_content() {
    let dir = TempDir::new();
    let first = ProjectStore::create(dir.path()).unwrap();
    let project_id = first.project_id().to_owned();
    first.close().unwrap();

    let second = ProjectStore::open(dir.path()).unwrap();
    assert_eq!(second.project_id(), project_id);
    second.close().unwrap();
}

#[test]
fn create_refuses_to_overwrite_an_existing_project() {
    let dir = TempDir::new();
    ProjectStore::create(dir.path()).unwrap().close().unwrap();
    let err = ProjectStore::create(dir.path()).unwrap_err();
    assert_eq!(err.code(), "already_exists");
}

#[test]
fn project_folder_can_be_copied_and_opened_elsewhere() {
    let original = TempDir::new();
    let store = ProjectStore::create(original.path()).unwrap();
    let project_id = store.project_id().to_owned();
    store.close().unwrap();

    let moved = TempDir::new();
    copy_dir(original.path(), moved.path());
    let reopened = ProjectStore::open(moved.path()).unwrap();
    assert_eq!(reopened.project_id(), project_id);
}

// ---- ロック（US1 の 3・4、FR-004〜FR-006） ----

#[test]
fn second_open_fails_with_in_use_and_leaves_data_untouched() {
    let dir = TempDir::new();
    let first = ProjectStore::create(dir.path()).unwrap();
    let before = support::snapshot(&read_only(dir.path()));

    let err = ProjectStore::open(dir.path()).unwrap_err();
    assert_eq!(err.code(), "in_use");
    let err = ProjectStore::create(dir.path()).unwrap_err();
    assert_eq!(err.code(), "in_use");

    assert_eq!(support::snapshot(&read_only(dir.path())), before);
    first.close().unwrap();
}

#[test]
fn lock_is_released_on_close_and_on_drop() {
    let dir = TempDir::new();
    let store = ProjectStore::create(dir.path()).unwrap();
    store.close().unwrap();
    let store = ProjectStore::open(dir.path()).unwrap();
    drop(store);
    ProjectStore::open(dir.path()).unwrap().close().unwrap();
}

/// 別プロセスとしてロックを保持するための補助。環境変数が無いときは何もしない。
#[test]
fn lock_holder_helper() {
    let Ok(folder) = std::env::var("UNNOTATOR_TEST_HOLD_LOCK") else {
        return;
    };
    let _store = ProjectStore::open(Path::new(&folder)).unwrap();
    println!("LOCKED");
    std::thread::sleep(std::time::Duration::from_secs(60));
}

#[test]
fn lock_held_by_another_process_blocks_and_is_released_when_it_dies() {
    let dir = TempDir::new();
    ProjectStore::create(dir.path()).unwrap().close().unwrap();

    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "lock_holder_helper",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("UNNOTATOR_TEST_HOLD_LOCK", dir.path())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    loop {
        let line = lines.next().expect("子プロセスが LOCKED を出す").unwrap();
        if line.contains("LOCKED") {
            break;
        }
    }

    // 持ち主が生きている間は引き継げない
    assert_eq!(ProjectStore::open(dir.path()).unwrap_err().code(), "in_use");

    // 持ち主が落ちると（OS がロックを解放するので）引き継げる
    child.kill().unwrap();
    child.wait().unwrap();
    ProjectStore::open(dir.path()).unwrap().close().unwrap();
}

// ---- 失敗（US1 の 5、FR-007、Edge Cases） ----

#[test]
fn missing_folder_is_not_found() {
    let dir = TempDir::new();
    let missing = dir.path().join("nope");
    assert_eq!(
        ProjectStore::create(&missing).unwrap_err().code(),
        "not_found"
    );
    assert_eq!(
        ProjectStore::open(&missing).unwrap_err().code(),
        "not_found"
    );
}

#[test]
fn opening_a_folder_without_a_project_is_not_found() {
    let dir = TempDir::new();
    assert_eq!(
        ProjectStore::open(dir.path()).unwrap_err().code(),
        "not_found"
    );
    // 何も作らない
    assert!(!dir.path().join(".unnotator").exists());
}

#[test]
fn a_file_path_is_an_io_error() {
    let dir = TempDir::new();
    let file = dir.path().join("file.txt");
    std::fs::write(&file, "x").unwrap();
    assert_eq!(ProjectStore::create(&file).unwrap_err().code(), "io");
}

#[cfg(unix)]
#[test]
fn read_only_folder_is_an_io_error_and_creates_nothing() {
    use std::os::unix::fs::PermissionsExt;
    let dir = TempDir::new();
    let folder = dir.path().join("ro");
    std::fs::create_dir(&folder).unwrap();
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o555)).unwrap();
    let result = ProjectStore::create(&folder);
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755)).unwrap();
    if let Err(err) = result {
        assert_eq!(err.code(), "io");
        assert!(!folder.join(".unnotator").exists());
    }
    // root で実行されるなど、書き込めてしまう環境では確かめない
}

#[test]
fn non_sqlite_project_db_is_corrupt_and_left_untouched() {
    let dir = TempDir::new();
    let unnotator = dir.path().join(".unnotator");
    std::fs::create_dir_all(&unnotator).unwrap();
    let db = unnotator.join("project.db");
    std::fs::write(&db, b"this is not a database, just some bytes").unwrap();

    let err = ProjectStore::open(dir.path()).unwrap_err();
    assert_eq!(err.code(), "corrupt");
    assert_eq!(
        std::fs::read(&db).unwrap(),
        b"this is not a database, just some bytes"
    );
}

#[test]
fn sqlite_database_without_meta_is_not_a_project() {
    let dir = TempDir::new();
    let unnotator = dir.path().join(".unnotator");
    std::fs::create_dir_all(&unnotator).unwrap();
    let db = unnotator.join("project.db");
    {
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE other (x INTEGER);")
            .unwrap();
    }
    let before = std::fs::read(&db).unwrap();

    let err = ProjectStore::open(dir.path()).unwrap_err();
    assert_eq!(err.code(), "not_a_project");
    assert_eq!(std::fs::read(&db).unwrap(), before);
}
