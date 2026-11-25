//! US2: アノテーションのコマンド（分類を含む）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use rusqlite::types::Value;
use support::{create_annotation, new_project, read_conn, row, snapshot, text};
use unnotator_core::command::{AnnotationPatch, Command, Field, ItemRef, Target};
use unnotator_core::event::{ChangeKind, Entity, Origin};

const ODD_SELECTOR: &str = "{ \"b\": 1,\n  \"a\": [1,   2] }";

#[test]
fn create_stores_row_and_returns_a_diff() {
    let (dir, mut store) = new_project(&["a1"]);
    let set = store
        .apply_command(create_annotation("a1", ODD_SELECTOR))
        .unwrap();

    assert_eq!(set.origin, Origin::Apply);
    assert_eq!(set.changes.len(), 1);
    assert_eq!(set.changes[0].entity, Entity::Annotation);
    assert_eq!(set.changes[0].kind, ChangeKind::Created);
    assert_eq!(set.asset_ids, vec!["a1".to_owned()]);

    let conn = read_conn(dir.path());
    let stored = row(&conn, "annotations", &set.changes[0].id).unwrap();
    // 位置の指定は、1 文字も加工されずに保存される
    assert_eq!(stored["selector_json"], text(ODD_SELECTOR));
    assert_eq!(stored["type"], text("com.example.shape/shape"));
    assert_eq!(stored["type_version"], Value::Integer(1));
    assert_eq!(stored["attributes_json"], text("{}"));
    assert_eq!(stored["summary"], text(""));
    assert_eq!(stored["source"], text("manual"));
    assert_eq!(stored["z_order"], Value::Integer(0));
    assert_eq!(stored["label_id"], Value::Null);
    assert_eq!(stored["item_id"], Value::Null);
}

#[test]
fn z_order_defaults_to_one_more_than_the_max_of_the_same_target() {
    let (dir, mut store) = new_project(&["a1", "a2"]);
    let first = store.apply_command(create_annotation("a1", "{}")).unwrap();
    let second = store.apply_command(create_annotation("a1", "{}")).unwrap();
    let other = store.apply_command(create_annotation("a2", "{}")).unwrap();
    let conn = read_conn(dir.path());
    let z = |set: &unnotator_core::event::ChangeSet| {
        row(&conn, "annotations", &set.changes[0].id).unwrap()["z_order"].clone()
    };
    assert_eq!(z(&first), Value::Integer(0));
    assert_eq!(z(&second), Value::Integer(1));
    assert_eq!(z(&other), Value::Integer(0));
}

#[test]
fn create_with_item_creates_the_item_row_in_the_same_change_and_reuses_it() {
    let (dir, mut store) = new_project(&["a1"]);
    let item = ItemRef {
        asset_id: "a1".into(),
        item_key: "page:3".into(),
        provider: "com.example.doc/pages".into(),
    };
    let command = |item: &ItemRef| Command::CreateAnnotation {
        id: None,
        target: Target {
            asset_id: "a1".into(),
            item: Some(item.clone()),
        },
        annotation_type: "com.example.shape/shape".into(),
        type_version: None,
        selector_json: "{}".into(),
        label_id: None,
        attributes_json: None,
        summary: None,
        z_order: None,
        source: None,
    };

    let first = store.apply_command(command(&item)).unwrap();
    let kinds: Vec<_> = first.changes.iter().map(|c| (c.entity, c.kind)).collect();
    assert!(kinds.contains(&(Entity::Item, ChangeKind::Created)));
    assert!(kinds.contains(&(Entity::Annotation, ChangeKind::Created)));

    let second = store.apply_command(command(&item)).unwrap();
    assert!(second.changes.iter().all(|c| c.entity != Entity::Item));
    let conn = read_conn(dir.path());
    assert_eq!(support::count(&conn, "items"), 1);
}

#[test]
fn update_changes_only_the_specified_fields() {
    let (dir, mut store) = new_project(&["a1"]);
    let label = store
        .apply_command(support::create_label("person"))
        .unwrap();
    let label_id = label.changes[0].id.clone();
    let created = store
        .apply_command(create_annotation("a1", ODD_SELECTOR))
        .unwrap();
    let id = created.changes[0].id.clone();
    let before = row(&read_conn(dir.path()), "annotations", &id).unwrap();

    let set = store
        .apply_command(Command::UpdateAnnotation {
            id: id.clone(),
            patch: AnnotationPatch {
                label_id: Field::Set(label_id.clone()),
                summary: Field::Set("a summary".into()),
                ..AnnotationPatch::default()
            },
        })
        .unwrap();
    assert_eq!(set.changes.len(), 1);
    assert_eq!(set.changes[0].kind, ChangeKind::Updated);

    let after = row(&read_conn(dir.path()), "annotations", &id).unwrap();
    assert_eq!(after["label_id"], text(&label_id));
    assert_eq!(after["summary"], text("a summary"));
    // 指定しなかった項目は、触れない
    for column in [
        "type",
        "type_version",
        "selector_json",
        "z_order",
        "source",
        "attributes_json",
    ] {
        assert_eq!(after[column], before[column], "{column}");
    }

    // ラベルは空にできる
    store
        .apply_command(Command::UpdateAnnotation {
            id: id.clone(),
            patch: AnnotationPatch {
                label_id: Field::Clear,
                ..AnnotationPatch::default()
            },
        })
        .unwrap();
    assert_eq!(
        row(&read_conn(dir.path()), "annotations", &id).unwrap()["label_id"],
        Value::Null
    );
}

#[test]
fn update_can_replace_the_selector_text_exactly() {
    let (dir, mut store) = new_project(&["a1"]);
    let created = store.apply_command(create_annotation("a1", "{}")).unwrap();
    let id = created.changes[0].id.clone();
    store
        .apply_command(Command::UpdateAnnotation {
            id: id.clone(),
            patch: AnnotationPatch {
                selector_json: Field::Set(ODD_SELECTOR.into()),
                ..AnnotationPatch::default()
            },
        })
        .unwrap();
    assert_eq!(
        row(&read_conn(dir.path()), "annotations", &id).unwrap()["selector_json"],
        text(ODD_SELECTOR)
    );
}

#[test]
fn clearing_a_field_that_cannot_be_null_is_invalid() {
    let (dir, mut store) = new_project(&["a1"]);
    let created = store.apply_command(create_annotation("a1", "{}")).unwrap();
    let before = snapshot(&read_conn(dir.path()));
    let err = store
        .apply_command(Command::UpdateAnnotation {
            id: created.changes[0].id.clone(),
            patch: AnnotationPatch {
                summary: Field::Clear,
                ..AnnotationPatch::default()
            },
        })
        .unwrap_err();
    assert_eq!(err.code(), "invalid_command");
    assert_eq!(snapshot(&read_conn(dir.path())), before);
}

#[test]
fn delete_removes_the_annotation() {
    let (dir, mut store) = new_project(&["a1"]);
    let created = store.apply_command(create_annotation("a1", "{}")).unwrap();
    let id = created.changes[0].id.clone();
    let set = store
        .apply_command(Command::DeleteAnnotation { id: id.clone() })
        .unwrap();
    assert_eq!(set.changes[0].kind, ChangeKind::Deleted);
    assert!(row(&read_conn(dir.path()), "annotations", &id).is_none());
}

#[test]
fn failing_commands_change_nothing_and_return_no_diff() {
    let (dir, mut store) = new_project(&["a1"]);
    let before = snapshot(&read_conn(dir.path()));

    // 存在しないアセット
    let err = store
        .apply_command(create_annotation("missing", "{}"))
        .unwrap_err();
    assert_eq!(err.code(), "not_found");
    // JSON として読めない位置の指定
    let err = store
        .apply_command(create_annotation("a1", "{not json"))
        .unwrap_err();
    assert_eq!(err.code(), "invalid_command");
    // 存在しないラベル
    let mut command = create_annotation("a1", "{}");
    if let Command::CreateAnnotation { label_id, .. } = &mut command {
        *label_id = Some("no-such-label".into());
    }
    assert_eq!(
        store.apply_command(command).unwrap_err().code(),
        "not_found"
    );
    // 存在しないアノテーションの更新・削除
    let err = store
        .apply_command(Command::DeleteAnnotation { id: "nope".into() })
        .unwrap_err();
    assert_eq!(err.code(), "not_found");

    assert_eq!(snapshot(&read_conn(dir.path())), before);
}

#[test]
fn classification_is_an_annotation_of_the_builtin_type_with_an_empty_selector() {
    let (dir, mut store) = new_project(&["a1"]);
    let classification = |selector: &str| Command::CreateAnnotation {
        id: None,
        target: Target {
            asset_id: "a1".into(),
            item: None,
        },
        annotation_type: "core/classification".into(),
        type_version: None,
        selector_json: selector.to_owned(),
        label_id: None,
        attributes_json: None,
        summary: None,
        z_order: None,
        source: None,
    };
    let set = store.apply_command(classification(" { } ")).unwrap();
    assert_eq!(set.changes[0].entity, Entity::Annotation);
    // 同じ対象に複数付けてもよい
    store.apply_command(classification("{}")).unwrap();
    assert_eq!(support::count(&read_conn(dir.path()), "annotations"), 2);

    let before = snapshot(&read_conn(dir.path()));
    let err = store
        .apply_command(classification("{\"x\": 1}"))
        .unwrap_err();
    assert_eq!(err.code(), "invalid_command");
    assert_eq!(snapshot(&read_conn(dir.path())), before);
}

#[test]
fn caller_supplied_ids_are_used_and_must_not_collide() {
    let (dir, mut store) = new_project(&["a1"]);
    let mut command = create_annotation("a1", "{}");
    if let Command::CreateAnnotation { id, .. } = &mut command {
        *id = Some("00000000-0000-7000-8000-00000000abcd".into());
    }
    let set = store.apply_command(command.clone()).unwrap();
    assert_eq!(set.changes[0].id, "00000000-0000-7000-8000-00000000abcd");
    assert!(
        row(
            &read_conn(dir.path()),
            "annotations",
            "00000000-0000-7000-8000-00000000abcd"
        )
        .is_some()
    );
    assert_eq!(
        store.apply_command(command).unwrap_err().code(),
        "invalid_command"
    );
}

#[test]
fn annotation_with_relations_or_members_cannot_be_deleted_until_cascade_is_implemented() {
    // US4 で連鎖削除を実装するまでの保護: 記録されない削除（SQLite の ON DELETE CASCADE）を起こさない。
    let (dir, mut store) = new_project(&["a1"]);
    let a = store
        .apply_command(create_annotation("a1", "{}"))
        .unwrap()
        .changes[0]
        .id
        .clone();
    let b = store
        .apply_command(create_annotation("a1", "{}"))
        .unwrap()
        .changes[0]
        .id
        .clone();
    store
        .apply_command(Command::CreateRelation {
            id: None,
            relation_type: "com.example.rel/link".into(),
            from_id: a.clone(),
            to_id: b,
            directed: None,
            label_id: None,
            attributes_json: None,
            source: None,
        })
        .unwrap();
    let before = snapshot(&read_conn(dir.path()));
    let err = store
        .apply_command(Command::DeleteAnnotation { id: a })
        .unwrap_err();
    assert_eq!(err.code(), "invalid_command");
    assert_eq!(snapshot(&read_conn(dir.path())), before);
}
