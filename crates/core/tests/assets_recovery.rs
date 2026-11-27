//! 走査（自動登録）は、003 の保存と異常終了からの復元の上で成り立つ（SC-013、quickstart §7）。
//!
//! 異常終了は、子プロセスを実際に強制終了して模擬する。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};

use support::{TempDir, create_label, read_assets, read_saved_conn, write_file};
use unnotator_core::assets::scan::ScanScope;
use unnotator_core::project::{CloseAction, OpenOutcome, PendingRecovery, ProjectStore};

/// 子プロセス: ラベルを作り、ファイルを走査して登録し、さらにラベルを作ってから止まる。
#[test]
fn assets_recovery_child_helper() {
    let Ok(folder) = std::env::var("UNNOTATOR_TEST_ASSET_CHILD") else {
        return;
    };
    let folder = Path::new(&folder);
    let mut store = support::open_store(folder);
    store.apply_command(create_label("before-scan")).unwrap();
    let summary = store.scan(ScanScope::Full).unwrap();
    assert_eq!(summary.added, 2);
    store.apply_command(create_label("after-scan")).unwrap();
    println!("DONE");
    std::thread::sleep(std::time::Duration::from_secs(60));
}

fn spawn_child(folder: &Path) -> Child {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "assets_recovery_child_helper",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("UNNOTATOR_TEST_ASSET_CHILD", folder)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    loop {
        let line = lines.next().expect("子プロセスが DONE を出す").unwrap();
        if line.contains("DONE") {
            break;
        }
    }
    child
}

fn crash(mut child: Child) {
    child.kill().unwrap();
    child.wait().unwrap();
}

fn prepared() -> TempDir {
    let dir = TempDir::new();
    write_file(dir.path(), "a.txt", b"abc");
    write_file(dir.path(), "sub/b.bin", b"12");
    ProjectStore::create(dir.path(), support::system_config(dir.path()))
        .unwrap()
        .close(None)
        .unwrap();
    dir
}

fn pending(folder: &Path) -> PendingRecovery {
    match ProjectStore::open(folder, support::test_config(folder)).unwrap() {
        OpenOutcome::RecoveryAvailable(pending) => pending,
        OpenOutcome::Opened { .. } => panic!("復元の候補が出るはず"),
    }
}

#[test]
fn synced_assets_are_in_project_db_already_and_are_not_counted_as_unsaved() {
    let dir = prepared();
    crash(spawn_child(dir.path()));

    // 走査の結果は、保存を待たずにプロジェクトのファイルへ入っている
    assert_eq!(support::count(&read_saved_conn(dir.path()), "assets"), 2);
    // 復元の候補になるのは、利用者の編集（ラベル 2 件）だけ
    let pending = pending(dir.path());
    assert_eq!(pending.candidate().entry_count, 2);

    let store = pending.restore().unwrap();
    assert_eq!(read_assets(dir.path()).len(), 2);
    assert!(store.save_state().dirty);
    assert_eq!(store.save_state().unsaved_count, 2);
}

#[test]
fn undo_after_restore_undoes_the_users_edits_but_never_the_sync() {
    let dir = prepared();
    crash(spawn_child(dir.path()));
    let mut store = pending(dir.path()).restore().unwrap();

    // 利用者の操作は 2 件。自動登録は、履歴に積まれない
    assert_eq!(store.undo_state().undo_depth, 2);
    store.undo().unwrap().unwrap(); // after-scan
    store.undo().unwrap().unwrap(); // before-scan
    assert!(store.undo().unwrap().is_none());
    let conn = support::read_conn(dir.path());
    assert_eq!(support::count(&conn, "labels"), 0);
    assert_eq!(
        support::count(&conn, "assets"),
        2,
        "Undo しても、アセットは残る"
    );
}

#[test]
fn saving_after_restore_puts_the_assets_into_the_project_file() {
    let dir = prepared();
    crash(spawn_child(dir.path()));
    let store = pending(dir.path()).restore().unwrap();
    store
        .close(Some(CloseAction::Save))
        .map_err(|f| f.error)
        .unwrap();
    let saved = read_saved_conn(dir.path());
    assert_eq!(support::count(&saved, "assets"), 2);
    assert_eq!(support::count(&saved, "labels"), 2);
}
