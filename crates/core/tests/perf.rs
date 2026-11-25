//! 性能の計測（SC-006・SC-007、原則 VII）。通常のテストでは走らせない。
//!
//! ```text
//! cargo test -p unnotator-core --test perf --release -- --ignored --nocapture
//! ```
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::time::Instant;

use rusqlite::Connection;
use support::{TempDir, create_annotation, insert_asset};
use unnotator_core::command::Command;
use unnotator_core::project::ProjectStore;

fn db_path(dir: &TempDir) -> std::path::PathBuf {
    dir.path().join(".unnotator/project.db")
}

fn ms(start: Instant) -> u128 {
    start.elapsed().as_millis()
}

/// 準備は、計測の対象ではないので、1 つのトランザクションで直接入れる。
fn bulk_annotations(conn: &Connection, count: usize) {
    let tx = conn.unchecked_transaction().unwrap();
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO annotations (id, asset_id, type, selector_json, z_order, created_at, updated_at) \
                 VALUES (?1, 'a1', 'com.example.shape/shape', '{\"i\": 1}', ?2, 0, 0)",
            )
            .unwrap();
        for i in 0..count {
            stmt.execute(rusqlite::params![format!("n{i:08}"), i as i64])
                .unwrap();
        }
    }
    tx.commit().unwrap();
}

#[test]
#[ignore = "性能の計測。--ignored で実行する"]
fn open_a_project_with_ten_thousand_annotations() {
    let dir = TempDir::new();
    ProjectStore::create(dir.path(), support::system_config(dir.path()))
        .unwrap()
        .close(None)
        .unwrap();
    {
        let conn = Connection::open(db_path(&dir)).unwrap();
        insert_asset(&conn, "a1", "a.bin");
        bulk_annotations(&conn, 10_000);
    }
    let start = Instant::now();
    let store = support::open_store(dir.path());
    let elapsed = ms(start);
    println!("SC-007: 1 万件のプロジェクトを開く: {elapsed} ms");
    store.close(None).unwrap();
    assert!(elapsed < 5_000, "5 秒以内のはずが {elapsed} ms");
}

#[test]
#[ignore = "性能の計測。--ignored で実行する"]
fn delete_and_undo_an_annotation_with_a_thousand_relations_and_memberships() {
    let dir = TempDir::new();
    ProjectStore::create(dir.path(), support::system_config(dir.path()))
        .unwrap()
        .close(None)
        .unwrap();
    {
        let conn = Connection::open(db_path(&dir)).unwrap();
        insert_asset(&conn, "a1", "a.bin");
        bulk_annotations(&conn, 1_001);
        let tx = conn.unchecked_transaction().unwrap();
        for i in 1..=1_000 {
            // n00000000 が中心。関係を 1,000 本、所属を 1,000 件（1,000 個のグループにそれぞれ所属）
            tx.execute(
                "INSERT INTO relations (id, type, from_id, to_id, created_at, updated_at) \
                 VALUES (?1, 'com.example.rel/link', 'n00000000', ?2, 0, 0)",
                rusqlite::params![format!("r{i:08}"), format!("n{i:08}")],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO annotation_groups (id, type, created_at, updated_at) VALUES (?1, 'com.example.grp/g', 0, 0)",
                [format!("g{i:08}")],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO group_members (group_id, annotation_id, position) VALUES (?1, 'n00000000', 0)",
                [format!("g{i:08}")],
            )
            .unwrap();
        }
        tx.commit().unwrap();
    }

    let mut store = support::open_store(dir.path());
    let start = Instant::now();
    store
        .apply_command(Command::DeleteAnnotation {
            id: "n00000000".into(),
        })
        .unwrap();
    let delete = ms(start);
    let start = Instant::now();
    store.undo().unwrap().unwrap();
    let undo = ms(start);
    let start = Instant::now();
    store.redo().unwrap().unwrap();
    let redo = ms(start);
    println!("SC-006: 削除 {delete} ms / Undo {undo} ms / Redo {redo} ms");
    assert!(delete < 1_000, "削除が {delete} ms");
    assert!(undo < 1_000, "Undo が {undo} ms");
    assert!(redo < 1_000, "Redo が {redo} ms");
}

fn rss_kib() -> Option<u64> {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

/// 大きめの transaction を 500 個積んだときの、時間とメモリ（観察のみ。research.md R6）。
#[test]
#[ignore = "性能の計測。--ignored で実行する"]
fn five_hundred_large_transactions_in_the_history() {
    let dir = TempDir::new();
    ProjectStore::create(dir.path(), support::system_config(dir.path()))
        .unwrap()
        .close(None)
        .unwrap();
    {
        let conn = Connection::open(db_path(&dir)).unwrap();
        insert_asset(&conn, "a1", "a.bin");
    }
    let mut store = support::open_store(dir.path());
    let before = rss_kib();
    let start = Instant::now();
    for _ in 0..500 {
        store
            .apply_command(Command::Transaction {
                commands: (0..20)
                    .map(|_| create_annotation("a1", "{\"i\": 1}"))
                    .collect(),
            })
            .unwrap();
    }
    let elapsed = ms(start);
    let after = rss_kib();
    println!(
        "履歴: 20 件の transaction を 500 個: {elapsed} ms / 履歴の深さ {} / メモリ {before:?} → {after:?} KiB",
        store.undo_state().undo_depth
    );
    assert_eq!(store.undo_state().undo_depth, 500);
}

// ---- 003: 保存と開く（SC-003、research.md R6・R7） ----

fn project_with(count: usize) -> TempDir {
    let dir = TempDir::new();
    ProjectStore::create(dir.path(), support::system_config(dir.path()))
        .unwrap()
        .close(None)
        .unwrap();
    let conn = Connection::open(db_path(&dir)).unwrap();
    insert_asset(&conn, "a1", "a.bin");
    bulk_annotations(&conn, count);
    drop(conn);
    dir
}

/// 開く（作業用の複製の作成を含む）→ 1 件編集 → 保存、の時間を測る。
fn measure_open_and_save(count: usize) -> (u128, u128) {
    let dir = project_with(count);
    let start = Instant::now();
    let mut store = support::open_store(dir.path());
    let open = ms(start);
    store.apply_command(create_annotation("a1", "{}")).unwrap();
    let start = Instant::now();
    store.save().unwrap();
    let save = ms(start);
    println!("SC-003: {count} 件: 開く {open} ms / 保存 {save} ms");
    store.close(None).unwrap();
    (open, save)
}

#[test]
#[ignore = "性能の計測。--ignored で実行する"]
fn save_a_project_with_a_hundred_thousand_annotations() {
    let (_open, save) = measure_open_and_save(100_000);
    assert!(save < 3_000, "3 秒以内のはずが {save} ms");
}

#[test]
#[ignore = "性能の計測。--ignored で実行する"]
fn open_and_save_a_project_with_a_million_annotations() {
    let (open, save) = measure_open_and_save(1_000_000);
    // 起動の目標（2 秒）と、保存の目標（3 秒。10 万件の基準を、100 万件でも守れるか）を観察する
    assert!(open < 2_000, "開くのに {open} ms");
    assert!(save < 3_000, "保存に {save} ms");
}
