//! US1: 編集は保存するまで元のファイルに入らず、保存は安全に確定する（spec.md US1、FR-001〜FR-012・FR-024）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use rusqlite::Connection;
use support::{
    create_annotation, create_label, journal_entries, new_project, read_conn, read_saved_conn,
    snapshot,
};
use unnotator_core::project::save::SaveStage;
use unnotator_core::project::{CloseAction, ProjectStore};
use unnotator_core::recovery::journal::{inverted, ops_from_json};

const NOW: i64 = 1_700_000_000_000;

fn project_db_bytes(dir: &support::TempDir) -> Vec<u8> {
    std::fs::read(dir.path().join(".unnotator/project.db")).unwrap()
}

fn saving_path(dir: &support::TempDir) -> std::path::PathBuf {
    dir.path().join(".unnotator/project.db.saving")
}

fn integrity_ok(conn: &Connection) -> bool {
    let result: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .unwrap();
    result == "ok"
}

// ---- 編集は作業用の複製に入り、保存でだけ project.db が変わる ----

#[test]
fn editing_does_not_touch_project_db_until_saved() {
    let (dir, mut store) = new_project(&["a1"]);
    let before = project_db_bytes(&dir);

    store.apply_command(create_label("person")).unwrap();
    store.apply_command(create_annotation("a1", "{}")).unwrap();

    assert_eq!(project_db_bytes(&dir), before);
    assert_eq!(support::count(&read_saved_conn(dir.path()), "labels"), 0);
    // 編集は作業用の複製にある
    assert_eq!(support::count(&read_conn(dir.path()), "labels"), 1);
    assert_eq!(support::count(&read_conn(dir.path()), "annotations"), 1);
}

#[test]
fn save_state_reports_unsaved_count_and_time() {
    let (_dir, mut store) = new_project(&["a1"]);
    let state = store.save_state();
    assert!(!state.dirty && !state.saving);
    assert_eq!((state.unsaved_count, state.last_change_at), (0, None));

    store.apply_command(create_label("person")).unwrap();
    store.apply_command(create_label("car")).unwrap();
    let state = store.save_state();
    assert!(state.dirty && !state.saving);
    assert_eq!(state.unsaved_count, 2);
    assert_eq!(state.last_change_at, Some(NOW));

    // Undo も 1 件として数える
    store.undo().unwrap().unwrap();
    assert_eq!(store.save_state().unsaved_count, 3);
}

#[test]
fn failed_commands_do_not_count_as_changes() {
    let (_dir, mut store) = new_project(&["a1"]);
    assert!(
        store
            .apply_command(create_annotation("missing", "{}"))
            .is_err()
    );
    assert_eq!(store.save_state().unsaved_count, 0);
}

#[test]
fn save_writes_everything_to_project_db_and_clears_the_unsaved_state() {
    let (dir, mut store) = new_project(&["a1"]);
    store.apply_command(create_label("person")).unwrap();
    store
        .apply_command(create_annotation("a1", "{\"i\": 1}"))
        .unwrap();

    let state = store.save().unwrap();
    assert!(!state.dirty && !state.saving);
    assert_eq!(state.unsaved_count, 0);
    assert_eq!(state.last_change_at, None);

    let saved = read_saved_conn(dir.path());
    assert!(integrity_ok(&saved));
    assert_eq!(snapshot(&saved), snapshot(&read_conn(dir.path())));
    assert_eq!(support::count(&saved, "labels"), 1);
    assert_eq!(support::count(&saved, "annotations"), 1);
    assert!(!saving_path(&dir).exists());
}

#[test]
fn saving_with_nothing_unsaved_succeeds_and_leaves_project_db_untouched() {
    let (dir, mut store) = new_project(&["a1"]);
    let bytes = project_db_bytes(&dir);
    let modified = std::fs::metadata(dir.path().join(".unnotator/project.db"))
        .unwrap()
        .modified()
        .unwrap();

    assert!(store.begin_save().unwrap().is_none());
    assert!(!store.save_state().saving);
    let state = store.save().unwrap();
    assert!(!state.dirty);

    assert_eq!(project_db_bytes(&dir), bytes);
    let after = std::fs::metadata(dir.path().join(".unnotator/project.db"))
        .unwrap()
        .modified()
        .unwrap();
    assert_eq!(after, modified);
}

#[test]
fn undo_after_save_works_and_makes_the_project_unsaved_again() {
    let (dir, mut store) = new_project(&["a1"]);
    store.apply_command(create_label("person")).unwrap();
    store.save().unwrap();
    let saved = snapshot(&read_saved_conn(dir.path()));

    // 保存しても、Undo の履歴は残る
    assert!(store.undo_state().can_undo);
    store.undo().unwrap().unwrap();
    assert_eq!(support::count(&read_conn(dir.path()), "labels"), 0);
    assert!(store.save_state().dirty);
    assert_eq!(store.save_state().unsaved_count, 1);
    // 保存するまで、project.db は保存済みのまま
    assert_eq!(snapshot(&read_saved_conn(dir.path())), saved);
    store.redo().unwrap().unwrap();
    assert_eq!(support::count(&read_conn(dir.path()), "labels"), 1);
}

#[test]
fn saved_project_db_is_in_delete_mode_without_side_files() {
    let (dir, mut store) = new_project(&["a1"]);
    store.apply_command(create_label("person")).unwrap();
    store.save().unwrap();

    let mode: String = read_saved_conn(dir.path())
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "delete");
    let names: Vec<String> = std::fs::read_dir(dir.path().join(".unnotator"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    for suffix in ["-wal", "-shm", "-journal", ".saving"] {
        assert!(
            !names.iter().any(|n| n.ends_with(suffix)),
            "{suffix} が残っている: {names:?}"
        );
    }
}

#[test]
fn saving_twice_in_a_row_and_after_more_edits_keeps_working() {
    let (dir, mut store) = new_project(&["a1"]);
    store.apply_command(create_label("one")).unwrap();
    store.save().unwrap();
    store.apply_command(create_label("two")).unwrap();
    store.apply_command(create_label("three")).unwrap();
    store.save().unwrap();
    store.save().unwrap();
    assert_eq!(support::count(&read_saved_conn(dir.path()), "labels"), 3);
}

// ---- 保存の各段階での打ち切り（FR-009・FR-011・FR-024、SC-002） ----

const STAGES: [SaveStage; 5] = [
    SaveStage::AfterVacuum,
    SaveStage::AfterVerify,
    SaveStage::AfterSync,
    SaveStage::AfterRename,
    SaveStage::AfterDirSync,
];

#[test]
fn an_abort_at_any_stage_leaves_project_db_whole_and_either_old_or_new() {
    for stage in STAGES {
        let (dir, mut store) = new_project(&["a1"]);
        store.apply_command(create_label("person")).unwrap();
        let old = snapshot(&read_saved_conn(dir.path()));
        let new = snapshot(&read_conn(dir.path()));
        assert_ne!(old, new);

        let job = store.begin_save().unwrap().expect("未保存がある");
        assert!(store.save_state().saving);
        let err = job.run_with_stop(stage).unwrap_err();
        assert_eq!(err.code(), "aborted", "{stage:?}");

        let saved = read_saved_conn(dir.path());
        assert!(integrity_ok(&saved), "{stage:?}");
        let now = snapshot(&saved);
        let renamed = matches!(stage, SaveStage::AfterRename | SaveStage::AfterDirSync);
        assert_eq!(now, if renamed { new } else { old }, "{stage:?}");
        // 名前の置き換えの前なら、一時ファイルが残っている
        assert_eq!(saving_path(&dir).exists(), !renamed, "{stage:?}");

        // 保存の中断を呼び出し側が知らせると、保存中の印が下りる。編集は未保存のまま残る
        store.abort_save();
        assert!(!store.save_state().saving);
        assert_eq!(store.save_state().unsaved_count, 1, "{stage:?}");
        // 作業内容は無傷
        assert_eq!(support::count(&read_conn(dir.path()), "labels"), 1);
        drop(saved);

        // 開き直すと、残っていた一時ファイルは削除される
        store.close(Some(CloseAction::Discard)).unwrap();
        let reopened = support::open_store(dir.path());
        assert!(!saving_path(&dir).exists(), "{stage:?}");
        assert!(integrity_ok(&read_saved_conn(dir.path())));
        reopened.close(None).unwrap();
    }
}

#[test]
fn a_stale_temporary_file_does_not_block_the_next_save() {
    let (dir, mut store) = new_project(&["a1"]);
    std::fs::write(saving_path(&dir), b"leftover from an old crash").unwrap();
    store.apply_command(create_label("person")).unwrap();
    store.save().unwrap();
    assert!(!saving_path(&dir).exists());
    assert_eq!(support::count(&read_saved_conn(dir.path()), "labels"), 1);
}

#[cfg(unix)]
#[test]
fn a_failed_save_changes_nothing_and_leaves_no_temporary_file() {
    use std::os::unix::fs::PermissionsExt;

    let (dir, mut store) = new_project(&["a1"]);
    store.apply_command(create_label("person")).unwrap();
    let project_before = project_db_bytes(&dir);
    let working_before = snapshot(&read_conn(dir.path()));
    let entries_before = journal_entries(dir.path());

    let unnotator = dir.path().join(".unnotator");
    std::fs::set_permissions(&unnotator, std::fs::Permissions::from_mode(0o555)).unwrap();
    let result = store.save();
    std::fs::set_permissions(&unnotator, std::fs::Permissions::from_mode(0o755)).unwrap();
    if result.is_ok() {
        // root で実行されるなど、書き込めてしまう環境では確かめない
        return;
    }

    assert_eq!(project_db_bytes(&dir), project_before);
    assert_eq!(snapshot(&read_conn(dir.path())), working_before);
    assert_eq!(journal_entries(dir.path()), entries_before);
    assert!(!saving_path(&dir).exists());
    // 失敗しても、保存中のままにならず、編集は未保存のまま。直せば保存できる
    let state = store.save_state();
    assert!(!state.saving && state.dirty);
    assert_eq!(state.unsaved_count, 1);
    store.save().unwrap();
    assert_eq!(support::count(&read_saved_conn(dir.path()), "labels"), 1);
}

// ---- journal（FR-006・FR-007、research.md R4） ----

#[test]
fn every_apply_undo_and_redo_appends_one_entry_that_reads_back_as_row_changes() {
    let (dir, mut store) = new_project(&["a1"]);
    store.apply_command(create_label("person")).unwrap();
    store.apply_command(create_annotation("a1", "{}")).unwrap();
    store.undo().unwrap().unwrap();
    store.redo().unwrap().unwrap();

    let entries = journal_entries(dir.path());
    let labels: Vec<&str> = entries.iter().map(|e| e.0.as_str()).collect();
    assert_eq!(
        labels,
        ["create_label", "create_annotation", "undo", "redo"]
    );
    assert!(entries.iter().all(|e| e.1 == "user"));
    // アセットは、差分の最初のアセット
    assert_eq!(entries[0].2, None);
    assert_eq!(entries[1].2.as_deref(), Some("a1"));
    assert_eq!(entries[2].2.as_deref(), Some("a1"));

    let ops: Vec<_> = entries
        .iter()
        .map(|e| ops_from_json(&e.3).expect("読み戻せる"))
        .collect();
    assert!(
        ops[0]
            .iter()
            .all(|op| op.table == "labels" && op.before.is_none())
    );
    assert!(ops[1].iter().any(|op| op.table == "annotations"));
    // Undo の記録は、直前の適用の向きを反転して順序を逆にしたもの。Redo はもう一度反転
    assert_eq!(ops[2], inverted(&ops[1]));
    assert_eq!(ops[3], inverted(&ops[2]));
}

#[test]
fn a_failed_journal_append_does_not_fail_the_edit() {
    let (dir, mut store) = new_project(&["a1"]);
    store.apply_command(create_label("first")).unwrap();
    // journal の entries を壊して、追記を失敗させる（working.db が正という契約の確認）
    {
        let conn = Connection::open(support::journal_db_path(dir.path())).unwrap();
        conn.execute_batch("DROP TABLE entries;").unwrap();
    }
    store.apply_command(create_label("second")).unwrap();
    store.undo().unwrap().unwrap();
    store.redo().unwrap().unwrap();
    assert_eq!(support::count(&read_conn(dir.path()), "labels"), 2);
    assert!(store.undo_state().can_undo);
}

// ---- 作成 ----

#[test]
fn a_created_project_can_be_saved_closed_and_reopened() {
    let dir = support::TempDir::new();
    let mut store = ProjectStore::create(dir.path(), support::system_config(dir.path())).unwrap();
    let project_id = store.project_id().to_owned();
    store.apply_command(create_label("person")).unwrap();
    store.close(Some(CloseAction::Save)).unwrap();

    let reopened = support::open_store(dir.path());
    assert_eq!(reopened.project_id(), project_id);
    assert_eq!(support::count(&read_conn(dir.path()), "labels"), 1);
}
