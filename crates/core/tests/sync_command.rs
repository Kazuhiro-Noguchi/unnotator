//! `SyncAssets`: 走査・見張りの結果の反映。Undo に積まない書き込み（research.md R9）。

mod support;

use support::{create_annotation, read_assets};
use unnotator_core::command::asset::{AssetMiss, AssetReclass, AssetStamp, AssetUpdate, NewAsset};
use unnotator_core::command::{Command, Status};
use unnotator_core::event::Origin;

fn new_asset(rel_path: &str, size: i64) -> NewAsset {
    NewAsset {
        id: None,
        root_key: String::new(),
        rel_path: rel_path.to_owned(),
        media_type: Some("test/text".to_owned()),
        stamp: AssetStamp {
            file_size: size,
            mtime_ms: 1_000,
        },
    }
}

fn sync(added: Vec<NewAsset>) -> Command {
    Command::SyncAssets {
        added,
        updated: vec![],
        went_missing: vec![],
        restored: vec![],
        reclassified: vec![],
    }
}

fn stamp(file_size: i64, mtime_ms: i64) -> AssetStamp {
    AssetStamp {
        file_size,
        mtime_ms,
    }
}

#[test]
fn sync_writes_the_working_copy_counts_as_unsaved_and_is_journaled() {
    let dir = support::TempDir::new();
    let mut store = support::create_and_open(&dir);
    let before = store.save_state();
    assert_eq!(before.unsaved_count, 0);

    let set = store
        .apply_command(sync(vec![new_asset("a.txt", 3), new_asset("b/c.txt", 4)]))
        .unwrap();
    assert_eq!(set.origin, Origin::Sync);

    let assets = read_assets(dir.path());
    assert_eq!(assets.len(), 2);
    assert_eq!(assets[0].rel_path, "a.txt");
    assert_eq!(assets[0].status, "todo");
    assert!(!assets[0].missing);
    assert_eq!(assets[0].media_type.as_deref(), Some("test/text"));

    assert_eq!(store.save_state().unsaved_count, 1);
    let entries = support::journal_entries(dir.path());
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].1, "sync");
    // `project.db` は保存するまで変わらない
    assert_eq!(
        support::count(&support::read_saved_conn(dir.path()), "assets"),
        0
    );
}

#[test]
fn sync_is_not_on_the_undo_stack_and_keeps_redo() {
    let (dir, mut store) = support::new_project(&["a1"]);
    store.apply_command(create_annotation("a1", "{}")).unwrap();
    store.undo().unwrap();
    let before = store.undo_state();
    assert!(before.can_redo);

    store
        .apply_command(sync(vec![new_asset("n.txt", 1)]))
        .unwrap();

    assert_eq!(store.undo_state(), before, "Undo の履歴は変わらない");
    assert!(store.redo().unwrap().is_some(), "Redo は消えない");
    drop(dir);
}

#[test]
fn undo_after_sync_undoes_the_users_last_edit_not_the_sync() {
    let (dir, mut store) = support::new_project(&["a1"]);
    store.apply_command(create_annotation("a1", "{}")).unwrap();
    store
        .apply_command(sync(vec![new_asset("n.txt", 1)]))
        .unwrap();
    store.undo().unwrap();
    let conn = support::read_conn(dir.path());
    assert_eq!(support::count(&conn, "annotations"), 0);
    assert_eq!(support::count(&conn, "assets"), 2, "自動登録は戻らない");
}

#[test]
fn updated_missing_restored_and_reclassified_touch_only_their_columns() {
    let dir = support::TempDir::new();
    let mut store = support::create_and_open(&dir);
    store
        .apply_command(sync(vec![new_asset("a.txt", 3)]))
        .unwrap();
    let id = read_assets(dir.path())[0].id.clone();
    store
        .apply_command(Command::SetAssetStatus {
            asset_id: id.clone(),
            status: Status::Done,
        })
        .unwrap();

    store
        .apply_command(Command::SyncAssets {
            added: vec![],
            updated: vec![AssetUpdate {
                asset_id: id.clone(),
                base: stamp(3, 1_000),
                now: stamp(9, 2_000),
            }],
            went_missing: vec![],
            restored: vec![],
            reclassified: vec![],
        })
        .unwrap();
    let a = &read_assets(dir.path())[0];
    assert_eq!((a.file_size, a.mtime_ms), (9, 2_000));
    assert_eq!(a.status, "done", "作業状態は変えない");

    store
        .apply_command(Command::SyncAssets {
            added: vec![],
            updated: vec![],
            went_missing: vec![AssetMiss {
                asset_id: id.clone(),
                base: stamp(9, 2_000),
            }],
            restored: vec![],
            reclassified: vec![],
        })
        .unwrap();
    assert!(read_assets(dir.path())[0].missing);

    store
        .apply_command(Command::SyncAssets {
            added: vec![],
            updated: vec![],
            went_missing: vec![],
            restored: vec![AssetUpdate {
                asset_id: id.clone(),
                base: stamp(9, 2_000),
                now: stamp(5, 3_000),
            }],
            reclassified: vec![AssetReclass {
                asset_id: id.clone(),
                media_type: None,
            }],
        })
        .unwrap();
    let a = &read_assets(dir.path())[0];
    assert!(!a.missing);
    assert_eq!((a.file_size, a.mtime_ms), (5, 3_000));
    assert_eq!(a.media_type, None);
    assert_eq!(a.status, "done");
}

#[test]
fn rows_that_changed_while_scanning_are_skipped() {
    let dir = support::TempDir::new();
    let mut store = support::create_and_open(&dir);
    store
        .apply_command(sync(vec![new_asset("a.txt", 3)]))
        .unwrap();
    let id = read_assets(dir.path())[0].id.clone();
    // 走査が写しを取った後で、行が別の値になった（base が合わない）
    store
        .apply_command(Command::SyncAssets {
            added: vec![new_asset("a.txt", 3)], // 同じパスの追加も飛ばす
            updated: vec![AssetUpdate {
                asset_id: id.clone(),
                base: stamp(999, 999),
                now: stamp(1, 1),
            }],
            went_missing: vec![AssetMiss {
                asset_id: id,
                base: stamp(999, 999),
            }],
            restored: vec![],
            reclassified: vec![],
        })
        .unwrap();
    let assets = read_assets(dir.path());
    assert_eq!(assets.len(), 1);
    assert_eq!((assets[0].file_size, assets[0].mtime_ms), (3, 1_000));
    assert!(!assets[0].missing);
    assert_eq!(store.last_sync_skipped(), 3);
}

#[test]
fn an_empty_sync_writes_nothing() {
    let dir = support::TempDir::new();
    let mut store = support::create_and_open(&dir);
    store.apply_command(sync(vec![])).unwrap();
    assert_eq!(store.save_state().unsaved_count, 0);
    assert!(support::journal_entries(dir.path()).is_empty());
}

#[test]
fn invalid_paths_are_rejected_and_nothing_is_written() {
    let dir = support::TempDir::new();
    let mut store = support::create_and_open(&dir);
    for bad in ["", "/abs", "a/../b", ".unnotator/x"] {
        let result = store.apply_command(sync(vec![new_asset("ok.txt", 1), new_asset(bad, 1)]));
        assert!(result.is_err(), "{bad}");
    }
    assert!(read_assets(dir.path()).is_empty());
}

#[test]
fn journal_marks_sync_entries_so_undo_rebuild_can_skip_them() {
    let dir = support::TempDir::new();
    let mut store = support::create_and_open(&dir);
    store
        .apply_command(sync(vec![new_asset("a.txt", 1)]))
        .unwrap();
    store.apply_command(support::create_label("L")).unwrap();
    store
        .apply_command(sync(vec![new_asset("b.txt", 2)]))
        .unwrap();
    let entries = support::journal_entries(dir.path());
    assert_eq!(entries.iter().filter(|e| e.1 == "sync").count(), 2);
    assert_eq!(entries.iter().filter(|e| e.1 == "user").count(), 1);
    // 自動登録の記録は、元に戻す情報を持たない
    assert!(
        entries
            .iter()
            .filter(|e| e.1 == "sync")
            .all(|e| e.3 == "[]")
    );
}
