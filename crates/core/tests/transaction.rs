//! US2: transaction と、適用の入口の性質（全体が適用される・されない、通知、確定前の差し込み口）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use support::{create_annotation, create_label, new_project, read_conn, snapshot};
use unnotator_core::command::Command;
use unnotator_core::error::StoreError;
use unnotator_core::event::{ChangeKind, ChangeObserver, ChangeSet, Entity, Origin};
use unnotator_core::history::recorder::RowOp;

#[test]
fn a_failure_in_the_middle_applies_nothing() {
    let (dir, mut store) = new_project(&["a1"]);
    let before = snapshot(&read_conn(dir.path()));
    let err = store
        .apply_command(Command::Transaction {
            commands: vec![
                create_label("person"),
                create_annotation("a1", "{}"),
                create_annotation("missing", "{}"), // 失敗する
                create_label("car"),
            ],
        })
        .unwrap_err();
    assert_eq!(err.code(), "not_found");
    assert_eq!(snapshot(&read_conn(dir.path())), before);
}

#[test]
fn nested_transactions_are_invalid() {
    let (dir, mut store) = new_project(&["a1"]);
    let before = snapshot(&read_conn(dir.path()));
    let err = store
        .apply_command(Command::Transaction {
            commands: vec![Command::Transaction { commands: vec![] }],
        })
        .unwrap_err();
    assert_eq!(err.code(), "invalid_command");
    assert_eq!(snapshot(&read_conn(dir.path())), before);
}

#[test]
fn success_yields_one_change_set_and_later_commands_can_use_earlier_ids() {
    let (dir, mut store) = new_project(&["a1"]);
    let label_id = "00000000-0000-7000-8000-0000000000aa";
    let mut label = create_label("person");
    if let Command::CreateLabel { id, .. } = &mut label {
        *id = Some(label_id.into());
    }
    let mut annotation = create_annotation("a1", "{}");
    if let Command::CreateAnnotation { label_id: l, .. } = &mut annotation {
        *l = Some(label_id.into());
    }

    let set = store
        .apply_command(Command::Transaction {
            commands: vec![label, annotation],
        })
        .unwrap();
    let entities: Vec<_> = set.changes.iter().map(|c| (c.entity, c.kind)).collect();
    assert_eq!(
        entities,
        vec![
            (Entity::Label, ChangeKind::Created),
            (Entity::Annotation, ChangeKind::Created)
        ]
    );
    let conn = read_conn(dir.path());
    assert_eq!(support::count(&conn, "labels"), 1);
    assert_eq!(support::count(&conn, "annotations"), 1);
}

#[test]
fn subscribers_are_notified_after_success_only() {
    let (_dir, mut store) = new_project(&["a1"]);
    let seen: Arc<Mutex<Vec<ChangeSet>>> = Arc::default();
    let sink = Arc::clone(&seen);
    store.subscribe(Box::new(move |set| sink.lock().unwrap().push(set.clone())));

    let ok = store.apply_command(create_annotation("a1", "{}")).unwrap();
    assert!(
        store
            .apply_command(create_annotation("missing", "{}"))
            .is_err()
    );

    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0], ok);
}

struct FailingObserver;
impl ChangeObserver for FailingObserver {
    fn before_commit(
        &mut self,
        _conn: &Connection,
        _origin: Origin,
        _ops: &[RowOp],
    ) -> Result<(), StoreError> {
        Err(StoreError::InvalidCommand("journal を書けない".into()))
    }
}

struct RecordingObserver(Arc<Mutex<Vec<usize>>>);
impl ChangeObserver for RecordingObserver {
    fn before_commit(
        &mut self,
        _conn: &Connection,
        _origin: Origin,
        ops: &[RowOp],
    ) -> Result<(), StoreError> {
        self.0.lock().unwrap().push(ops.len());
        Ok(())
    }
}

#[test]
fn observers_see_the_row_ops_before_commit_and_can_abort_the_apply() {
    let (dir, mut store) = new_project(&["a1"]);
    let seen: Arc<Mutex<Vec<usize>>> = Arc::default();
    store.add_observer(Box::new(RecordingObserver(Arc::clone(&seen))));
    store.apply_command(create_annotation("a1", "{}")).unwrap();
    assert_eq!(*seen.lock().unwrap(), vec![1]);

    let before = snapshot(&read_conn(dir.path()));
    store.add_observer(Box::new(FailingObserver));
    let err = store
        .apply_command(create_annotation("a1", "{}"))
        .unwrap_err();
    assert_eq!(err.code(), "invalid_command");
    // 差し込み口が失敗したら、適用も取り消される
    assert_eq!(snapshot(&read_conn(dir.path())), before);
}
