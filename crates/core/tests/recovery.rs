//! US3: アプリが異常終了しても、保存していない編集を取り戻せる（spec.md US3、FR-018〜FR-024、SC-004・SC-005）。
//!
//! 異常終了は、002 のロックのテストと同じく、子プロセスを実際に強制終了して模擬する。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};

use rusqlite::Connection;
use support::{TempDir, create_label, read_conn, read_saved_conn, snapshot};
use unnotator_core::db::migrate::Migration;
use unnotator_core::migrations::PROJECT_V1;
use unnotator_core::project::save::SaveStage;
use unnotator_core::project::{OpenOutcome, PendingRecovery, ProjectStore, StoreConfig};
use unnotator_core::recovery::recovery_dir_for;

// ---- 子プロセス（異常終了の模擬） ----

/// 子プロセスとして、編集してから止まる補助。環境変数が無いときは何もしない。
#[test]
fn recovery_child_helper() {
    let (Ok(folder), Ok(mode)) = (
        std::env::var("UNNOTATOR_TEST_CHILD"),
        std::env::var("UNNOTATOR_TEST_CHILD_MODE"),
    ) else {
        return;
    };
    let folder = Path::new(&folder);
    let mut store = support::open_store(folder);
    let (kind, count) = mode.split_once(':').unwrap_or((mode.as_str(), "0"));
    let count: usize = count.parse().unwrap();
    for i in 0..count {
        store
            .apply_command(create_label(&format!("label-{i}")))
            .unwrap();
    }
    match kind {
        "edits" => {}
        // 保存の途中（VACUUM INTO の直後）で止まる
        "save_abort" => {
            let job = store.begin_save().unwrap().expect("未保存がある");
            let _ = job.run_with_stop(SaveStage::AfterVacuum);
        }
        // 保存の途中で止まったまま、さらに 2 件編集する（保存中の編集）
        "save_edit" => {
            let job = store.begin_save().unwrap().expect("未保存がある");
            let _ = job.run_with_stop(SaveStage::AfterVacuum);
            for i in 0..2 {
                store
                    .apply_command(create_label(&format!("during-{i}")))
                    .unwrap();
            }
        }
        other => panic!("未知のモード: {other}"),
    }
    println!("DONE");
    std::thread::sleep(std::time::Duration::from_secs(60));
}

fn spawn_child(folder: &Path, mode: &str) -> Child {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "recovery_child_helper",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("UNNOTATOR_TEST_CHILD", folder)
        .env("UNNOTATOR_TEST_CHILD_MODE", mode)
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

/// 強制終了する（Unix では SIGKILL）。
fn crash(mut child: Child) {
    child.kill().unwrap();
    child.wait().unwrap();
}

/// 空のプロジェクトを作って閉じた状態の一時フォルダ。
fn prepared() -> TempDir {
    let dir = TempDir::new();
    ProjectStore::create(dir.path(), support::system_config(dir.path()))
        .unwrap()
        .close(None)
        .unwrap();
    dir
}

/// 子プロセスと同じ編集を、別のプロジェクトに適用した結果（期待する内容）。`meta` は除く。
fn expected_after(edits: usize) -> support::Snapshot {
    let dir = prepared();
    let mut store = support::open_store(dir.path());
    for i in 0..edits {
        store
            .apply_command(create_label(&format!("label-{i}")))
            .unwrap();
    }
    without_meta(snapshot(&read_conn(dir.path())))
}

fn without_meta(snapshot: support::Snapshot) -> support::Snapshot {
    snapshot
        .into_iter()
        .filter(|(name, _)| name != "meta")
        .collect()
}

fn pending(folder: &Path) -> PendingRecovery {
    pending_with(folder, support::test_config(folder))
}

fn pending_with(folder: &Path, config: StoreConfig) -> PendingRecovery {
    match ProjectStore::open(folder, config).unwrap() {
        OpenOutcome::RecoveryAvailable(pending) => pending,
        OpenOutcome::Opened { .. } => panic!("復元の候補が出るはず"),
    }
}

fn recovery_dir(dir: &TempDir) -> std::path::PathBuf {
    recovery_dir_for(&dir.recovery_root(), dir.path())
}

const NOW: i64 = 1_700_000_000_000;

// ---- 候補の提示と復元 ----

#[test]
fn after_a_crash_the_next_open_offers_recovery_with_count_and_time() {
    let dir = prepared();
    crash(spawn_child(dir.path(), "edits:3"));

    let pending = pending(dir.path());
    let candidate = pending.candidate();
    assert_eq!(candidate.entry_count, 3);
    assert_eq!(candidate.last_change_at, Some(NOW));
    assert!(!candidate.base_changed);
    assert_eq!(candidate.app_version, env!("CARGO_PKG_VERSION"));
    assert!(candidate.project_root.ends_with("project"));
    // 選ぶまで、何も消えず、何も変わらない
    assert!(recovery_dir(&dir).join("working.db").exists());
    assert_eq!(support::count(&read_saved_conn(dir.path()), "labels"), 0);
}

#[test]
fn restore_brings_back_every_edit_made_before_the_crash_as_unsaved_changes() {
    // 編集の途中の各時点（コマンドごと）で強制終了しても、適用が成功していた編集がすべて戻る（SC-004）
    for edits in [1, 2, 5, 12] {
        let dir = prepared();
        crash(spawn_child(dir.path(), &format!("edits:{edits}")));

        let store = pending(dir.path()).restore().unwrap();
        assert_eq!(
            without_meta(snapshot(&read_conn(dir.path()))),
            expected_after(edits),
            "{edits} 件"
        );
        let state = store.save_state();
        assert!(state.dirty, "未保存のまま再開する");
        assert_eq!(state.unsaved_count, u32::try_from(edits).unwrap());
        assert_eq!(state.last_change_at, Some(NOW));
        // 保存するまで、project.db は変わっていない
        assert_eq!(support::count(&read_saved_conn(dir.path()), "labels"), 0);
        // 保存すれば取り戻した内容が project.db に入る
        store
            .close(Some(unnotator_core::project::CloseAction::Save))
            .unwrap();
        assert_eq!(
            support::count(&read_saved_conn(dir.path()), "labels"),
            i64::try_from(edits).unwrap()
        );
        assert!(!recovery_dir(&dir).exists());
    }
}

#[test]
fn the_undo_history_is_rebuilt_from_the_journal_up_to_500() {
    let dir = prepared();
    crash(spawn_child(dir.path(), "edits:600"));

    let mut store = pending(dir.path()).restore().unwrap();
    assert_eq!(store.save_state().unsaved_count, 600);
    assert_eq!(store.undo_state().undo_depth, 500);
    assert!(!store.undo_state().can_redo);
    assert_eq!(support::count(&read_conn(dir.path()), "labels"), 600);

    for _ in 0..500 {
        store.undo().unwrap().expect("戻せる");
    }
    // 直近から順に戻って、501 件目より古い分は戻せない
    assert_eq!(support::count(&read_conn(dir.path()), "labels"), 100);
    assert!(store.undo().unwrap().is_none());
    // Redo もできる
    store.redo().unwrap().expect("やり直せる");
    assert_eq!(support::count(&read_conn(dir.path()), "labels"), 101);
}

#[test]
fn undo_after_restore_goes_back_one_edit_at_a_time_and_new_edits_continue() {
    let dir = prepared();
    crash(spawn_child(dir.path(), "edits:3"));
    // 連番の ID は、復元後に重ならないよう、別の起点から始める（実際は UUID v7 なので重ならない）
    let config = StoreConfig {
        ids: Box::new(unnotator_core::id::SequentialIds::starting_after(5_000)),
        ..support::test_config(dir.path())
    };
    let mut store = pending_with(dir.path(), config).restore().unwrap();

    store.undo().unwrap().unwrap();
    assert_eq!(support::count(&read_conn(dir.path()), "labels"), 2);
    store.apply_command(create_label("after")).unwrap();
    assert_eq!(support::count(&read_conn(dir.path()), "labels"), 3);
    // 復元したあとの編集も、journal に記録され、続けて取り戻せる
    drop(store);
    let again = pending(dir.path());
    assert_eq!(again.candidate().entry_count, 5);
}

#[test]
fn discard_removes_the_leftovers_and_opens_the_saved_project() {
    let dir = prepared();
    crash(spawn_child(dir.path(), "edits:4"));
    let saved = snapshot(&read_saved_conn(dir.path()));

    let store = pending(dir.path()).discard().unwrap();
    assert!(!store.save_state().dirty);
    assert_eq!(snapshot(&read_conn(dir.path())), saved);
    store.close(None).unwrap();
    assert!(!recovery_dir(&dir).exists());
    // 破棄したあとは、もう候補は出ない
    support::open_store(dir.path()).close(None).unwrap();
}

#[test]
fn choosing_nothing_keeps_the_candidate_for_the_next_open() {
    let dir = prepared();
    crash(spawn_child(dir.path(), "edits:2"));

    drop(pending(dir.path()));
    drop(pending(dir.path()));
    let again = pending(dir.path());
    assert_eq!(again.candidate().entry_count, 2);
    assert_eq!(
        without_meta(snapshot(&read_conn(dir.path()))),
        expected_after(2)
    );
}

#[test]
fn a_candidate_holds_the_lock_so_nobody_else_can_open_the_project() {
    let dir = prepared();
    crash(spawn_child(dir.path(), "edits:1"));
    let pending = pending(dir.path());
    let err = ProjectStore::open(dir.path(), support::test_config(dir.path())).unwrap_err();
    assert_eq!(err.code(), "in_use");
    drop(pending);
}

// ---- 周辺のケース（T024） ----

#[test]
fn a_crash_in_the_middle_of_a_save_keeps_project_db_whole_and_the_edits_recoverable() {
    let dir = prepared();
    let before = snapshot(&read_saved_conn(dir.path()));
    crash(spawn_child(dir.path(), "save_abort:3"));

    // 保存の一時ファイルが残っているが、project.db は壊れていない
    assert!(dir.path().join(".unnotator/project.db.saving").exists());
    assert_eq!(snapshot(&read_saved_conn(dir.path())), before);

    let pending = pending(dir.path());
    assert_eq!(pending.candidate().entry_count, 3);
    let store = pending.restore().unwrap();
    assert_eq!(
        without_meta(snapshot(&read_conn(dir.path()))),
        expected_after(3)
    );
    // 開いたときに、一時ファイルは削除されている
    assert!(!dir.path().join(".unnotator/project.db.saving").exists());
    drop(store);
}

#[test]
fn an_empty_leftover_is_not_a_candidate_and_is_removed() {
    let dir = prepared();
    crash(spawn_child(dir.path(), "edits:0"));
    assert!(recovery_dir(&dir).exists());

    let store = support::open_store(dir.path());
    assert!(!store.save_state().dirty);
    store.close(None).unwrap();
    assert!(!recovery_dir(&dir).exists());
}

#[test]
fn a_lost_last_journal_entry_still_restores_the_working_copy_with_one_less_undo_step() {
    let dir = prepared();
    crash(spawn_child(dir.path(), "edits:4"));
    // 追記が遅れて失われた状態を作る（working.db は正）
    {
        let conn = Connection::open(support::journal_db_path(dir.path())).unwrap();
        conn.execute(
            "DELETE FROM entries WHERE seq = (SELECT max(seq) FROM entries)",
            [],
        )
        .unwrap();
    }

    let pending = pending(dir.path());
    assert_eq!(pending.candidate().entry_count, 3);
    let store = pending.restore().unwrap();
    assert_eq!(support::count(&read_conn(dir.path()), "labels"), 4);
    assert_eq!(store.undo_state().undo_depth, 3);
}

#[test]
fn an_unreadable_record_stops_the_rebuild_at_that_point() {
    let dir = prepared();
    crash(spawn_child(dir.path(), "edits:5"));
    {
        // 2 番目の記録を、JSON としては正しいが、読めない形にする
        let conn = Connection::open(support::journal_db_path(dir.path())).unwrap();
        conn.execute(
            "UPDATE entries SET inverse_json = '{\"x\": 1}' WHERE seq = (SELECT seq FROM entries ORDER BY seq LIMIT 1 OFFSET 1)",
            [],
        )
        .unwrap();
    }
    let mut store = pending(dir.path()).restore().unwrap();
    // 新しい 3 件（5・4・3 番目）だけが戻せる。working.db は 5 件のまま使える
    assert_eq!(store.undo_state().undo_depth, 3);
    assert_eq!(support::count(&read_conn(dir.path()), "labels"), 5);
    for _ in 0..3 {
        store.undo().unwrap().unwrap();
    }
    assert!(store.undo().unwrap().is_none());
    assert_eq!(support::count(&read_conn(dir.path()), "labels"), 2);
}

#[test]
fn a_crash_while_saving_recovers_both_the_edits_before_and_during_the_save() {
    let dir = prepared();
    crash(spawn_child(dir.path(), "save_edit:3"));

    let pending = pending(dir.path());
    assert_eq!(pending.candidate().entry_count, 5);
    let store = pending.restore().unwrap();
    assert_eq!(support::count(&read_conn(dir.path()), "labels"), 5);
    assert_eq!(support::count(&read_saved_conn(dir.path()), "labels"), 0);
    assert_eq!(store.save_state().unsaved_count, 5);
}

static WITH_V2: &[Migration] = &[
    Migration {
        version: 1,
        sql: PROJECT_V1,
    },
    Migration {
        version: 2,
        sql: "CREATE TABLE test_extra (x INTEGER);",
    },
];

#[test]
fn an_older_working_copy_is_migrated_on_restore_and_the_history_is_empty() {
    let dir = prepared();
    crash(spawn_child(dir.path(), "edits:3"));

    let config = StoreConfig {
        migrations: WITH_V2,
        ..support::test_config(dir.path())
    };
    let store = pending_with(dir.path(), config).restore().unwrap();
    assert_eq!(store.schema_version(), 2);
    assert_eq!(store.migrated_from(), Some(1));
    assert_eq!(support::count(&read_conn(dir.path()), "labels"), 3);
    // 記録の中身が古い構造を指すので、Undo の履歴は空
    assert!(!store.undo_state().can_undo);
    assert!(store.save_state().dirty);
    let version: i64 = read_conn(dir.path())
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 2);
}

#[test]
fn a_broken_journal_is_moved_aside_and_the_saved_project_opens() {
    let dir = prepared();
    crash(spawn_child(dir.path(), "edits:3"));
    let leftover = recovery_dir(&dir);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(leftover.join(format!("journal.db{suffix}")));
    }
    std::fs::write(leftover.join("journal.db"), b"garbage, not a database").unwrap();

    let OpenOutcome::Opened {
        store,
        recovery_unusable,
    } = ProjectStore::open(dir.path(), support::test_config(dir.path())).unwrap()
    else {
        panic!("保存済みのプロジェクトが開くはず");
    };
    let unusable = recovery_unusable.expect("退避を知らせる");
    assert!(
        unusable
            .moved_to
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains(".corrupt-")
    );
    // 削除されず、退避されている
    assert!(unusable.moved_to.join("working.db").exists());
    // 保存済みのプロジェクトが、新しい作業用データで開いている
    assert!(!store.save_state().dirty);
    assert_ne!(unusable.moved_to, leftover);
}

#[test]
fn a_broken_working_copy_is_moved_aside_too() {
    let dir = prepared();
    crash(spawn_child(dir.path(), "edits:3"));
    let leftover = recovery_dir(&dir);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(leftover.join(format!("working.db{suffix}")));
    }
    std::fs::write(leftover.join("working.db"), b"garbage, not a database").unwrap();

    let OpenOutcome::Opened {
        recovery_unusable, ..
    } = ProjectStore::open(dir.path(), support::test_config(dir.path())).unwrap()
    else {
        panic!("保存済みのプロジェクトが開くはず");
    };
    let unusable = recovery_unusable.expect("退避を知らせる");
    assert!(unusable.moved_to.join("journal.db").exists());
}

#[test]
fn the_candidate_says_when_project_db_was_changed_from_outside_and_overwrites_nothing() {
    let dir = prepared();
    crash(spawn_child(dir.path(), "edits:2"));
    std::thread::sleep(std::time::Duration::from_millis(30));
    {
        let conn = Connection::open(dir.path().join(".unnotator/project.db")).unwrap();
        conn.execute(
            "UPDATE meta SET value = ?1 WHERE key = 'app_version'",
            ["changed-from-outside-with-a-longer-value"],
        )
        .unwrap();
    }
    let outside = snapshot(&read_saved_conn(dir.path()));

    let pending = pending(dir.path());
    assert!(pending.candidate().base_changed);
    // 選ぶまで、project.db は外から変えられたまま
    assert_eq!(snapshot(&read_saved_conn(dir.path())), outside);
    let store = pending.restore().unwrap();
    assert_eq!(snapshot(&read_saved_conn(dir.path())), outside);
    drop(store);
}
