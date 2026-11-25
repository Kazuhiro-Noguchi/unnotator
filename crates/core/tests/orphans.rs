//! US5: 孤立した作業用データを自動で片付け、一覧から消せる（spec.md US5、FR-025・FR-026、SC-007）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use rusqlite::Connection;
use support::{TempDir, create_label, test_config};
use unnotator_core::project::{OpenOutcome, ProjectStore};
use unnotator_core::recovery::orphan::{cleanup, delete, list};
use unnotator_core::recovery::{corrupt_dir_for, recovery_dir_for};

/// 編集した状態で、`close` を通さずに手放す（異常終了と同じく、作業用データが残る）。
fn leave_working_data(dir: &TempDir) {
    ProjectStore::create(dir.path(), support::system_config(dir.path()))
        .unwrap()
        .close(None)
        .unwrap();
    let mut store = support::open_store(dir.path());
    store.apply_command(create_label("person")).unwrap();
    store.apply_command(create_label("car")).unwrap();
    drop(store);
}

const NOW: i64 = 1_700_000_000_000;
const DAY: i64 = 24 * 60 * 60 * 1000;

/// プロジェクトのフォルダを消して、紐づくプロジェクトが無い状態にする。
fn remove_project(dir: &TempDir) {
    std::fs::remove_dir_all(dir.path().join(".unnotator")).unwrap();
}

fn data_dir(dir: &TempDir) -> std::path::PathBuf {
    recovery_dir_for(&dir.recovery_root(), dir.path())
}

fn id_of(dir: &TempDir) -> String {
    data_dir(dir)
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

#[test]
fn an_orphan_older_than_thirty_days_is_deleted_and_a_newer_one_is_kept() {
    let old = TempDir::new();
    let fresh = TempDir::new();
    // 同じ置き場に 2 つ入れる
    let root = old.recovery_root();
    for dir in [&old, &fresh] {
        leave_working_data(dir);
        remove_project(dir);
    }
    // fresh のデータを、old と同じ置き場へ移す
    let moved = root.join(id_of(&fresh));
    std::fs::rename(data_dir(&fresh), &moved).unwrap();

    // 30 日を超えた時点では、最終の変更が NOW の両方とも超える。fresh だけ最近の変更にする
    {
        let conn = Connection::open(moved.join("journal.db")).unwrap();
        conn.execute(
            "UPDATE session SET last_change_at = ?1",
            [NOW + 40 * DAY - DAY],
        )
        .unwrap();
    }
    let removed = cleanup(&root, NOW + 40 * DAY, None).unwrap();
    assert_eq!(removed, vec![id_of(&old)]);
    assert!(!data_dir(&old).exists());
    assert!(moved.exists());
    // ちょうど 30 日以内なら、残る
    assert!(cleanup(&root, NOW + 29 * DAY, None).unwrap().is_empty());
}

#[test]
fn data_whose_project_still_exists_is_never_deleted_automatically() {
    let dir = TempDir::new();
    leave_working_data(&dir);
    let removed = cleanup(&dir.recovery_root(), NOW + 365 * DAY, None).unwrap();
    assert!(removed.is_empty());
    assert!(data_dir(&dir).exists());
    // 復元の候補として、いつでも開ける
    let outcome = ProjectStore::open(dir.path(), test_config(dir.path())).unwrap();
    assert!(matches!(outcome, OpenOutcome::RecoveryAvailable(_)));
}

#[test]
fn the_list_describes_each_entry() {
    let with_project = TempDir::new();
    leave_working_data(&with_project);
    let orphan = TempDir::new();
    leave_working_data(&orphan);
    remove_project(&orphan);
    let root = with_project.recovery_root();
    std::fs::rename(data_dir(&orphan), root.join(id_of(&orphan))).unwrap();

    let entries = list(&root);
    assert_eq!(entries.len(), 2);
    let alive = entries
        .iter()
        .find(|e| e.id == id_of(&with_project))
        .unwrap();
    assert!(alive.project_exists && !alive.corrupt);
    assert_eq!(alive.entry_count, Some(2));
    assert_eq!(alive.last_change_at, Some(NOW));
    assert!(alive.size_bytes > 0);
    assert!(alive.project_root.as_deref().unwrap().ends_with("project"));
    let gone = entries.iter().find(|e| e.id == id_of(&orphan)).unwrap();
    assert!(!gone.project_exists && !gone.corrupt);
    assert_eq!(gone.entry_count, Some(2));
}

#[test]
fn deleting_one_entry_leaves_the_others() {
    let a = TempDir::new();
    let b = TempDir::new();
    leave_working_data(&a);
    leave_working_data(&b);
    remove_project(&a);
    remove_project(&b);
    let root = a.recovery_root();
    std::fs::rename(data_dir(&b), root.join(id_of(&b))).unwrap();

    delete(&root, &id_of(&a), None).unwrap();
    assert!(!data_dir(&a).exists());
    assert!(root.join(id_of(&b)).exists());
    assert_eq!(
        delete(&root, &id_of(&a), None).unwrap_err().code(),
        "not_found"
    );
}

#[test]
fn the_data_of_the_open_project_and_of_a_project_in_use_cannot_be_deleted() {
    // 開いているプロジェクトのもの
    let (dir, mut store) = support::new_project(&["a1"]);
    store.apply_command(create_label("person")).unwrap();
    let id = id_of(&dir);
    assert_eq!(
        delete(&dir.recovery_root(), &id, Some(dir.path()))
            .unwrap_err()
            .code(),
        "in_use"
    );
    // 別のプロセスが使っているもの（ロックで判定する）。開いている本人が open_dir を渡さなくても守られる
    assert_eq!(
        delete(&dir.recovery_root(), &id, None).unwrap_err().code(),
        "in_use"
    );
    assert!(
        cleanup(&dir.recovery_root(), NOW + 365 * DAY, Some(dir.path()))
            .unwrap()
            .is_empty()
    );
    assert!(data_dir(&dir).exists());
    drop(store);
    // 手放したあとは、消せる
    delete(&dir.recovery_root(), &id, None).unwrap();
}

#[test]
fn ids_that_could_escape_the_recovery_folder_are_refused() {
    let dir = TempDir::new();
    leave_working_data(&dir);
    let outside = dir.recovery_root().parent().unwrap().join("keep");
    std::fs::create_dir_all(&outside).unwrap();
    for bad in ["..", "../project", "a/b", "a\\b", "", ".", "/etc"] {
        assert_eq!(
            delete(&dir.recovery_root(), bad, None).unwrap_err().code(),
            "not_found",
            "{bad:?}"
        );
    }
    assert!(outside.exists());
    assert!(dir.path().exists());
    assert!(data_dir(&dir).exists());
}

#[test]
fn moved_aside_data_is_listed_as_corrupt_and_deleted_after_thirty_days() {
    let dir = TempDir::new();
    leave_working_data(&dir);
    let root = dir.recovery_root();
    let moved = corrupt_dir_for(&root, dir.path(), NOW);
    std::fs::rename(data_dir(&dir), &moved).unwrap();
    // 読めない状態にする
    std::fs::write(moved.join("journal.db"), b"garbage").unwrap();
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(moved.join(format!("journal.db{suffix}")));
    }

    let entries = list(&root);
    assert_eq!(entries.len(), 1);
    assert!(entries[0].corrupt);
    // プロジェクトが存在していても、退避したものは 30 日で消える
    assert!(cleanup(&root, NOW + 29 * DAY, None).unwrap().is_empty());
    let removed = cleanup(&root, NOW + 31 * DAY, None).unwrap();
    assert_eq!(removed.len(), 1);
    assert!(!moved.exists());
}

#[test]
fn a_missing_recovery_root_is_an_empty_list() {
    let dir = TempDir::new();
    let missing = dir.recovery_root().join("never-created");
    assert!(list(&missing).is_empty());
    assert!(cleanup(&missing, NOW, None).unwrap().is_empty());
}
