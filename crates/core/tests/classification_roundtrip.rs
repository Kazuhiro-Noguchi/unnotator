//! 008 US1: 分類（`core/classification`）の付け外し・付け替えの往復（apply → undo → redo）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use support::{new_project, read_conn, snapshot, target};
use unnotator_core::command::Command;

fn classify(id: &str, asset: &str, label: &str) -> Command {
    Command::CreateAnnotation {
        id: Some(id.to_owned()),
        target: target(asset),
        annotation_type: "core/classification".to_owned(),
        type_version: None,
        selector_json: "{}".to_owned(),
        label_id: Some(label.to_owned()),
        attributes_json: None,
        summary: None,
        z_order: None,
        source: None,
    }
}

fn two_labels() -> (support::TempDir, unnotator_core::project::ProjectStore) {
    let (dir, mut store) = new_project(&["a1"]);
    for (id, name) in [("l1", "cat"), ("l2", "dog")] {
        store
            .apply_command(Command::CreateLabel {
                id: Some(id.to_owned()),
                name: name.to_owned(),
                name_i18n_json: None,
                color: "#112233".to_owned(),
                hotkey: None,
                sort_order: None,
                hidden: None,
                applies_to_json: None,
            })
            .unwrap();
    }
    (dir, store)
}

/// 変更の前後と、undo・redo の後の状態を比べる。
fn round_trip(
    dir: &support::TempDir,
    store: &mut unnotator_core::project::ProjectStore,
    command: Command,
) {
    let before = snapshot(&read_conn(dir.path()));
    store.apply_command(command).unwrap();
    let applied = snapshot(&read_conn(dir.path()));
    assert_ne!(before, applied, "変更が入る");
    store.undo().unwrap().expect("undo できる");
    assert_eq!(snapshot(&read_conn(dir.path())), before, "undo で戻る");
    store.redo().unwrap().expect("redo できる");
    assert_eq!(snapshot(&read_conn(dir.path())), applied, "redo で再び入る");
}

#[test]
fn applying_a_classification_round_trips() {
    let (dir, mut store) = two_labels();
    round_trip(&dir, &mut store, classify("c1", "a1", "l1"));
}

#[test]
fn removing_a_classification_round_trips() {
    let (dir, mut store) = two_labels();
    store.apply_command(classify("c1", "a1", "l1")).unwrap();
    round_trip(
        &dir,
        &mut store,
        Command::DeleteAnnotation {
            id: "c1".to_owned(),
        },
    );
}

#[test]
fn replacing_a_classification_is_one_undo_step() {
    let (dir, mut store) = two_labels();
    store.apply_command(classify("c1", "a1", "l1")).unwrap();
    round_trip(
        &dir,
        &mut store,
        Command::Transaction {
            commands: vec![
                Command::DeleteAnnotation {
                    id: "c1".to_owned(),
                },
                classify("c2", "a1", "l2"),
            ],
        },
    );
    // 付け替えの後は、l2 の分類だけが残る
    let conn = read_conn(dir.path());
    let labels: Vec<String> = conn
        .prepare("SELECT label_id FROM annotations WHERE type = 'core/classification'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(labels, ["l2"]);
}

#[test]
fn a_classification_selector_must_be_empty() {
    let (_dir, mut store) = two_labels();
    let Command::CreateAnnotation {
        id,
        target,
        annotation_type,
        label_id,
        ..
    } = classify("c1", "a1", "l1")
    else {
        unreachable!()
    };
    let bad = Command::CreateAnnotation {
        id,
        target,
        annotation_type,
        type_version: None,
        selector_json: "{\"x\":1}".to_owned(),
        label_id,
        attributes_json: None,
        summary: None,
        z_order: None,
        source: None,
    };
    assert!(store.apply_command(bad).is_err());
}
