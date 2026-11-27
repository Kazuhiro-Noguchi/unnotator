//! 008 US5: 関係とグループの編集（apply → undo → redo の往復）と、制約。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use support::{read_conn, seeded_project, snapshot};
use unnotator_core::command::Command;

fn round_trip(command: Command) {
    let (dir, mut store, _seed) = seeded_project();
    let before = snapshot(&read_conn(dir.path()));
    store.apply_command(command).unwrap();
    let applied = snapshot(&read_conn(dir.path()));
    assert_ne!(before, applied);
    store.undo().unwrap().expect("undo できる");
    assert_eq!(snapshot(&read_conn(dir.path())), before, "undo で戻る");
    store.redo().unwrap().expect("redo できる");
    assert_eq!(snapshot(&read_conn(dir.path())), applied, "redo で再び入る");
}

fn relation(from: &str, to: &str) -> Command {
    Command::CreateRelation {
        id: None,
        relation_type: "com.example.shape/link".to_owned(),
        from_id: from.to_owned(),
        to_id: to.to_owned(),
        directed: None,
        label_id: None,
        attributes_json: None,
        source: None,
    }
}

#[test]
fn a_relation_can_join_annotations_of_different_assets_and_round_trips() {
    // ann-0 は a1、ann-2 は a2
    round_trip(relation("ann-0", "ann-2"));
}

#[test]
fn a_relation_to_itself_or_to_a_missing_annotation_is_refused() {
    let (_dir, mut store, _seed) = seeded_project();
    assert!(store.apply_command(relation("ann-0", "ann-0")).is_err());
    assert!(store.apply_command(relation("ann-0", "nope")).is_err());
}

#[test]
fn deleting_a_relation_round_trips() {
    round_trip(Command::DeleteRelation {
        id: "rel-0".to_owned(),
    });
}

#[test]
fn creating_a_group_with_members_round_trips() {
    round_trip(Command::CreateGroup {
        id: None,
        group_type: "com.example.shape/set".to_owned(),
        ordered: Some(true),
        label_id: None,
        attributes_json: None,
        members: vec!["ann-0".to_owned(), "ann-1".to_owned()],
        source: None,
    });
}

#[test]
fn member_edits_round_trip() {
    round_trip(Command::AddGroupMembers {
        group_id: "grp-0".to_owned(),
        annotation_ids: vec!["ann-0".to_owned()],
        at: None,
    });
    round_trip(Command::RemoveGroupMembers {
        group_id: "grp-0".to_owned(),
        annotation_ids: vec!["ann-1".to_owned()],
    });
    round_trip(Command::MoveGroupMember {
        group_id: "grp-0".to_owned(),
        annotation_id: "ann-2".to_owned(),
        to_position: 0,
    });
}

#[test]
fn a_group_with_no_members_is_kept() {
    let (dir, mut store, _seed) = seeded_project();
    store
        .apply_command(Command::RemoveGroupMembers {
            group_id: "grp-0".to_owned(),
            annotation_ids: vec!["ann-1".to_owned(), "ann-2".to_owned()],
        })
        .unwrap();
    let conn = read_conn(dir.path());
    let groups: i64 = conn
        .query_row("SELECT COUNT(*) FROM annotation_groups", [], |r| r.get(0))
        .unwrap();
    let members: i64 = conn
        .query_row("SELECT COUNT(*) FROM group_members", [], |r| r.get(0))
        .unwrap();
    assert_eq!((groups, members), (1, 0));
}

#[test]
fn deleting_an_annotation_removes_its_relation_and_membership_in_one_step() {
    let (dir, mut store, _seed) = seeded_project();
    let before = snapshot(&read_conn(dir.path()));
    let depth = store.undo_state().undo_depth;
    store
        .apply_command(Command::DeleteAnnotation {
            id: "ann-1".to_owned(),
        })
        .unwrap();
    assert_eq!(store.undo_state().undo_depth, depth + 1);
    let conn = read_conn(dir.path());
    let count = |table: &str| -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(count("relations"), 0);
    assert_eq!(count("group_members"), 1);
    drop(conn);
    store.undo().unwrap();
    assert_eq!(snapshot(&read_conn(dir.path())), before);
}
