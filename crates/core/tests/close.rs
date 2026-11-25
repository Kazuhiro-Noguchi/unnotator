//! US2: 閉じるときに、未保存の変更をどうするか選べる（spec.md US2、FR-015〜FR-017）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use support::{create_annotation, create_label, new_project, read_conn, read_saved_conn, snapshot};
use unnotator_core::project::{CloseAction, OpenOutcome, ProjectStore};
use unnotator_core::recovery::recovery_dir_for;

fn recovery_dir(dir: &support::TempDir) -> std::path::PathBuf {
    recovery_dir_for(&dir.recovery_root(), dir.path())
}

#[test]
fn close_with_save_writes_the_edits_and_removes_the_working_data() {
    let (dir, mut store) = new_project(&["a1"]);
    store.apply_command(create_label("person")).unwrap();
    store.apply_command(create_annotation("a1", "{}")).unwrap();
    let edited = snapshot(&read_conn(dir.path()));
    assert!(recovery_dir(&dir).exists());

    store.close(Some(CloseAction::Save)).unwrap();

    assert_eq!(snapshot(&read_saved_conn(dir.path())), edited);
    assert!(!recovery_dir(&dir).exists());
    // ロックも解放されている
    support::open_store(dir.path()).close(None).unwrap();
}

#[test]
fn close_with_discard_keeps_project_db_as_it_was_opened() {
    let (dir, mut store) = new_project(&["a1"]);
    let opened = snapshot(&read_saved_conn(dir.path()));
    let bytes = std::fs::read(dir.path().join(".unnotator/project.db")).unwrap();
    store.apply_command(create_label("person")).unwrap();

    store.close(Some(CloseAction::Discard)).unwrap();

    assert_eq!(snapshot(&read_saved_conn(dir.path())), opened);
    assert_eq!(
        std::fs::read(dir.path().join(".unnotator/project.db")).unwrap(),
        bytes
    );
    assert!(!recovery_dir(&dir).exists());
    // 次に開いても、復元の候補は出ない
    support::open_store(dir.path()).close(None).unwrap();
}

#[test]
fn close_without_a_choice_fails_and_hands_the_store_back_untouched() {
    let (dir, mut store) = new_project(&["a1"]);
    store.apply_command(create_label("person")).unwrap();
    store.apply_command(create_label("car")).unwrap();

    let failed = store.close(None).unwrap_err();
    assert_eq!(failed.error.code(), "unsaved_changes");

    // 「閉じるのをやめる」: そのまま使い続けられ、編集も Undo の履歴も残っている
    let mut store = failed.store;
    assert_eq!(store.save_state().unsaved_count, 2);
    assert_eq!(store.undo_state().undo_depth, 2);
    assert_eq!(support::count(&read_conn(dir.path()), "labels"), 2);
    store.apply_command(create_label("bike")).unwrap();
    store.undo().unwrap().unwrap();
    assert_eq!(support::count(&read_conn(dir.path()), "labels"), 2);
    assert!(recovery_dir(&dir).exists());
    store.close(Some(CloseAction::Discard)).unwrap();
}

#[test]
fn close_with_nothing_unsaved_needs_no_choice_and_leaves_nothing_behind() {
    let (dir, store) = new_project(&["a1"]);
    store.close(None).unwrap();
    assert!(!recovery_dir(&dir).exists());

    // 保存したあとも、選ばずに閉じられる
    let mut store = support::open_store(dir.path());
    store.apply_command(create_label("person")).unwrap();
    store.save().unwrap();
    store.close(None).unwrap();
    assert!(!recovery_dir(&dir).exists());
    assert_eq!(support::count(&read_saved_conn(dir.path()), "labels"), 1);
}

#[test]
fn the_choice_is_ignored_when_nothing_is_unsaved() {
    for action in [CloseAction::Save, CloseAction::Discard] {
        let (dir, store) = new_project(&["a1"]);
        store.close(Some(action)).unwrap();
        assert!(!recovery_dir(&dir).exists());
    }
}

#[cfg(unix)]
#[test]
fn a_failing_save_during_close_keeps_the_project_open_and_the_edits() {
    use std::os::unix::fs::PermissionsExt;

    let (dir, mut store) = new_project(&["a1"]);
    store.apply_command(create_label("person")).unwrap();

    let unnotator = dir.path().join(".unnotator");
    std::fs::set_permissions(&unnotator, std::fs::Permissions::from_mode(0o555)).unwrap();
    let result = store.close(Some(CloseAction::Save));
    std::fs::set_permissions(&unnotator, std::fs::Permissions::from_mode(0o755)).unwrap();
    let Err(failed) = result else {
        // root で実行されるなど、書き込めてしまう環境では確かめない
        return;
    };

    let store = failed.store;
    assert_eq!(store.save_state().unsaved_count, 1);
    assert_eq!(support::count(&read_conn(dir.path()), "labels"), 1);
    assert_eq!(support::count(&read_saved_conn(dir.path()), "labels"), 0);
    assert!(recovery_dir(&dir).exists());
    // 直せば、もう一度閉じられる
    store.close(Some(CloseAction::Save)).unwrap();
    assert_eq!(support::count(&read_saved_conn(dir.path()), "labels"), 1);
}

#[test]
fn closing_while_saving_is_refused() {
    let (dir, mut store) = new_project(&["a1"]);
    store.apply_command(create_label("person")).unwrap();
    let job = store.begin_save().unwrap().expect("未保存がある");

    for action in [None, Some(CloseAction::Save), Some(CloseAction::Discard)] {
        let failed = store.close(action).unwrap_err();
        assert_eq!(failed.error.code(), "already_saving");
        store = failed.store;
    }
    // 保存を終えれば、閉じられる
    let outcome = job.run().unwrap();
    store.finish_save(outcome).unwrap();
    store.close(None).unwrap();
    assert_eq!(support::count(&read_saved_conn(dir.path()), "labels"), 1);
}

#[test]
fn dropping_without_close_leaves_the_working_data_as_a_recovery_candidate() {
    let (dir, mut store) = new_project(&["a1"]);
    store.apply_command(create_label("person")).unwrap();
    drop(store);

    assert!(recovery_dir(&dir).join("working.db").exists());
    assert!(recovery_dir(&dir).join("journal.db").exists());
    // ロックは解放されていて、開くと復元の候補が出る
    let outcome = ProjectStore::open(dir.path(), support::test_config(dir.path())).unwrap();
    let OpenOutcome::RecoveryAvailable(pending) = outcome else {
        panic!("復元の候補が出るはず");
    };
    assert_eq!(pending.candidate().entry_count, 1);
}
