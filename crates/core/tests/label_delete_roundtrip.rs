//! 008 US4: ラベルの削除（付け替え・一緒に削除）が、1 つの元に戻せる操作で、完全に戻る。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use support::{read_conn, seeded_project, snapshot};
use unnotator_core::command::{Command, LabelDisposition};

fn delete(id: &str, disposition: Option<LabelDisposition>) -> Command {
    Command::DeleteLabel {
        id: id.to_owned(),
        disposition,
    }
}

fn round_trip(command: Command) {
    let (dir, mut store, _seed) = seeded_project();
    let before = snapshot(&read_conn(dir.path()));
    let depth = store.undo_state().undo_depth;
    store.apply_command(command).unwrap();
    assert_eq!(store.undo_state().undo_depth, depth + 1, "1 つの操作");
    let applied = snapshot(&read_conn(dir.path()));
    assert_ne!(before, applied);
    store.undo().unwrap().expect("undo できる");
    assert_eq!(
        snapshot(&read_conn(dir.path())),
        before,
        "undo で完全に戻る"
    );
    store.redo().unwrap().expect("redo できる");
    assert_eq!(snapshot(&read_conn(dir.path())), applied, "redo で再び入る");
}

#[test]
fn usage_counts_what_uses_the_label() {
    let (_dir, store, seed) = seeded_project();
    let usage = store.label_usage(&seed.labels[1]).unwrap();
    assert_eq!(usage.annotations, 2);
    assert_eq!(store.label_usage(&seed.labels[2]).unwrap().annotations, 0);
}

#[test]
fn reassign_moves_every_user_to_the_other_label_and_round_trips() {
    let (dir, mut store, seed) = seeded_project();
    store
        .apply_command(delete(
            &seed.labels[1],
            Some(LabelDisposition::Reassign {
                to_label_id: seed.labels[2].clone(),
            }),
        ))
        .unwrap();
    let conn = read_conn(dir.path());
    let moved: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM annotations WHERE label_id = ?1",
            [&seed.labels[2]],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(moved, 2);
    let gone: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM labels WHERE id = ?1",
            [&seed.labels[1]],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(gone, 0);
    drop(conn);
    round_trip(delete(
        "label-1",
        Some(LabelDisposition::Reassign {
            to_label_id: "label-2".to_owned(),
        }),
    ));
}

#[test]
fn cascade_removes_the_users_with_their_relations_and_round_trips() {
    round_trip(delete("label-1", Some(LabelDisposition::Cascade)));
    let (dir, mut store, seed) = seeded_project();
    store
        .apply_command(delete(&seed.labels[1], Some(LabelDisposition::Cascade)))
        .unwrap();
    let conn = read_conn(dir.path());
    let count = |table: &str| -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(count("annotations"), 1, "分類だけが残る");
    assert_eq!(count("relations"), 0);
    assert_eq!(count("group_members"), 0);
}

#[test]
fn an_unused_label_is_deleted_without_a_disposition_and_round_trips() {
    round_trip(delete("label-2", None));
}

#[test]
fn a_used_label_cannot_be_deleted_without_a_disposition() {
    let (_dir, mut store, seed) = seeded_project();
    assert!(store.apply_command(delete(&seed.labels[1], None)).is_err());
}
