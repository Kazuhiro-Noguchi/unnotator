//! US4: 削除しても関連が壊れない（連鎖削除）。アノテーションとラベルの削除は、1 回の Undo で戻る。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use rusqlite::Connection;
use rusqlite::types::Value;
use support::{count, create_label, new_project, read_conn, row, snapshot, text};
use unnotator_core::command::{
    AnnotationPatch, AttributeScope, Command, Field, GroupPatch, LabelDisposition, RelationPatch,
    Target,
};
use unnotator_core::event::{ChangeKind, Entity};
use unnotator_core::project::ProjectStore;

fn id(n: u32) -> String {
    format!("00000000-0000-7000-8000-{n:012x}")
}

fn annotation(n: u32, asset: &str) -> Command {
    Command::CreateAnnotation {
        id: Some(id(n)),
        target: Target {
            asset_id: asset.into(),
            item: None,
        },
        annotation_type: "com.example.shape/shape".into(),
        type_version: None,
        selector_json: "{}".into(),
        label_id: None,
        attributes_json: None,
        summary: None,
        z_order: None,
        source: None,
    }
}

fn relation(n: u32, from: u32, to: u32) -> Command {
    Command::CreateRelation {
        id: Some(id(n)),
        relation_type: "com.example.rel/link".into(),
        from_id: id(from),
        to_id: id(to),
        directed: None,
        label_id: None,
        attributes_json: None,
        source: None,
    }
}

fn group(n: u32, members: &[u32]) -> Command {
    Command::CreateGroup {
        id: Some(id(n)),
        group_type: "com.example.grp/track".into(),
        ordered: Some(true),
        label_id: None,
        attributes_json: None,
        members: members.iter().map(|m| id(*m)).collect(),
        source: None,
    }
}

fn label(n: u32, name: &str) -> Command {
    let mut command = create_label(name);
    if let Command::CreateLabel { id: slot, .. } = &mut command {
        *slot = Some(id(n));
    }
    command
}

fn set_label_of_annotation(n: u32, label: u32) -> Command {
    Command::UpdateAnnotation {
        id: id(n),
        patch: AnnotationPatch {
            label_id: Field::Set(id(label)),
            ..AnnotationPatch::default()
        },
    }
}

fn set_label_of_relation(n: u32, label: u32) -> Command {
    Command::UpdateRelation {
        id: id(n),
        patch: RelationPatch {
            label_id: Field::Set(id(label)),
            ..RelationPatch::default()
        },
    }
}

fn set_label_of_group(n: u32, label: u32) -> Command {
    Command::UpdateGroup {
        id: id(n),
        patch: GroupPatch {
            label_id: Field::Set(id(label)),
            ..GroupPatch::default()
        },
    }
}

fn setup(store: &mut ProjectStore, commands: Vec<Command>) {
    for command in commands {
        store.apply_command(command).unwrap();
    }
}

fn members(conn: &Connection, group_id: &str) -> Vec<(String, i64)> {
    let mut stmt = conn
        .prepare("SELECT annotation_id, position FROM group_members WHERE group_id = ?1 ORDER BY position")
        .unwrap();
    stmt.query_map([group_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

// ---- アノテーションの連鎖削除（FR-027、FR-030） ----

#[test]
fn deleting_an_annotation_removes_its_relations_and_leaves_its_groups() {
    let (dir, mut store) = new_project(&["a1", "a2"]);
    // 1・2・3 は a1、4 は a2。関係は 1→2 と 3→1 と 2→4（1 を含まない）。順序つきグループは [3, 1, 2]
    setup(
        &mut store,
        vec![
            annotation(1, "a1"),
            annotation(2, "a1"),
            annotation(3, "a1"),
            annotation(4, "a2"),
            relation(20, 1, 2),
            relation(21, 3, 1),
            relation(22, 2, 4),
            group(30, &[3, 1, 2]),
        ],
    );
    let before = snapshot(&read_conn(dir.path()));

    let set = store
        .apply_command(Command::DeleteAnnotation { id: id(1) })
        .unwrap();
    let conn = read_conn(dir.path());
    // 1 を端に持つ関係は消え、それ以外は残る
    assert!(row(&conn, "relations", &id(20)).is_none());
    assert!(row(&conn, "relations", &id(21)).is_none());
    assert!(row(&conn, "relations", &id(22)).is_some());
    // グループからは外れ、残りの位置は連続する。グループ自体は残る
    assert_eq!(members(&conn, &id(30)), vec![(id(3), 0), (id(2), 1)]);
    // 関係の相手（2・3）は残る
    assert!(row(&conn, "annotations", &id(2)).is_some());
    assert!(row(&conn, "annotations", &id(3)).is_some());
    assert!(row(&conn, "annotations", &id(1)).is_none());

    // 差分: 削除されたものがすべて載る。対象のアセットも分かる
    let deleted: Vec<(Entity, String)> = set
        .changes
        .iter()
        .filter(|c| c.kind == ChangeKind::Deleted)
        .map(|c| (c.entity, c.id.clone()))
        .collect();
    assert!(deleted.contains(&(Entity::Annotation, id(1))));
    assert!(deleted.contains(&(Entity::Relation, id(20))));
    assert!(deleted.contains(&(Entity::Relation, id(21))));
    assert!(set.asset_ids.contains(&"a1".to_owned()));

    // 1 回の Undo で、アノテーション・関係・グループ所属が順序も含めて元に戻る
    store.undo().unwrap().unwrap();
    assert_eq!(snapshot(&read_conn(dir.path())), before);
    assert_eq!(
        members(&read_conn(dir.path()), &id(30)),
        vec![(id(3), 0), (id(1), 1), (id(2), 2)]
    );
    store.redo().unwrap().unwrap();
    assert!(row(&read_conn(dir.path()), "annotations", &id(1)).is_none());
}

#[test]
fn a_group_that_loses_its_last_member_stays() {
    let (dir, mut store) = new_project(&["a1"]);
    setup(&mut store, vec![annotation(1, "a1"), group(30, &[1])]);
    store
        .apply_command(Command::DeleteAnnotation { id: id(1) })
        .unwrap();
    let conn = read_conn(dir.path());
    assert!(row(&conn, "annotation_groups", &id(30)).is_some());
    assert!(members(&conn, &id(30)).is_empty());
}

#[test]
fn a_relation_between_different_assets_reports_both_assets_when_deleted() {
    let (_dir, mut store) = new_project(&["a1", "a2"]);
    setup(
        &mut store,
        vec![annotation(1, "a1"), annotation(2, "a2"), relation(20, 1, 2)],
    );
    let set = store
        .apply_command(Command::DeleteAnnotation { id: id(1) })
        .unwrap();
    assert!(set.asset_ids.contains(&"a1".to_owned()));
    assert!(set.asset_ids.contains(&"a2".to_owned()));
}

// ---- ラベルの削除（FR-028） ----

/// ラベル 10・11 と、10 を使うアノテーション 1・関係 20・グループ 30、10 専用の属性スキーマ。
fn labeled_project() -> (support::TempDir, ProjectStore) {
    let (dir, mut store) = new_project(&["a1"]);
    setup(
        &mut store,
        vec![
            label(10, "person"),
            label(11, "human"),
            annotation(1, "a1"),
            annotation(2, "a1"),
            relation(20, 1, 2),
            group(30, &[1, 2]),
            set_label_of_annotation(1, 10),
            set_label_of_relation(20, 10),
            set_label_of_group(30, 10),
            Command::SetAttributeSchema {
                scope: AttributeScope::Label,
                target: id(10),
                schema_json: "{\"type\":\"object\",\"properties\":{}}".into(),
            },
        ],
    );
    (dir, store)
}

#[test]
fn label_usage_counts_what_uses_the_label() {
    let (_dir, store) = labeled_project();
    let usage = store.label_usage(&id(10)).unwrap();
    assert_eq!(
        (
            usage.annotations,
            usage.relations,
            usage.groups,
            usage.attribute_schemas
        ),
        (1, 1, 1, 1)
    );
    let unused = store.label_usage(&id(11)).unwrap();
    assert_eq!(
        (
            unused.annotations,
            unused.relations,
            unused.groups,
            unused.attribute_schemas
        ),
        (0, 0, 0, 0)
    );
    assert_eq!(
        store.label_usage("missing").unwrap_err().code(),
        "not_found"
    );
}

#[test]
fn deleting_a_used_label_without_disposition_fails_and_changes_nothing() {
    let (dir, mut store) = labeled_project();
    let before = snapshot(&read_conn(dir.path()));
    let err = store
        .apply_command(Command::DeleteLabel {
            id: id(10),
            disposition: None,
        })
        .unwrap_err();
    assert_eq!(err.code(), "label_in_use");
    assert!(err.to_string().contains('1'));
    assert_eq!(snapshot(&read_conn(dir.path())), before);
}

#[test]
fn reassign_moves_everything_to_the_other_label_and_one_undo_restores() {
    let (dir, mut store) = labeled_project();
    let before = snapshot(&read_conn(dir.path()));
    let set = store
        .apply_command(Command::DeleteLabel {
            id: id(10),
            disposition: Some(LabelDisposition::Reassign {
                to_label_id: id(11),
            }),
        })
        .unwrap();
    let conn = read_conn(dir.path());
    assert!(row(&conn, "labels", &id(10)).is_none());
    assert_eq!(
        row(&conn, "annotations", &id(1)).unwrap()["label_id"],
        text(&id(11))
    );
    assert_eq!(
        row(&conn, "relations", &id(20)).unwrap()["label_id"],
        text(&id(11))
    );
    assert_eq!(
        row(&conn, "annotation_groups", &id(30)).unwrap()["label_id"],
        text(&id(11))
    );
    // そのラベル専用の属性スキーマも消える
    assert_eq!(count(&conn, "attribute_schemas"), 0);
    // 使っていたものは消えない
    assert_eq!(count(&conn, "annotations"), 2);
    assert!(
        set.changes
            .iter()
            .any(|c| c.entity == Entity::Label && c.kind == ChangeKind::Deleted)
    );

    store.undo().unwrap().unwrap();
    assert_eq!(snapshot(&read_conn(dir.path())), before);
}

#[test]
fn cascade_deletes_what_uses_the_label_including_its_links_and_one_undo_restores() {
    let (dir, mut store) = labeled_project();
    let before = snapshot(&read_conn(dir.path()));
    store
        .apply_command(Command::DeleteLabel {
            id: id(10),
            disposition: Some(LabelDisposition::Cascade),
        })
        .unwrap();
    let conn = read_conn(dir.path());
    assert!(row(&conn, "labels", &id(10)).is_none());
    // ラベルを使っていたアノテーション 1 と、その関係 20、ラベルを使っていたグループ 30 が消える
    assert!(row(&conn, "annotations", &id(1)).is_none());
    assert!(row(&conn, "relations", &id(20)).is_none());
    assert!(row(&conn, "annotation_groups", &id(30)).is_none());
    assert_eq!(count(&conn, "group_members"), 0);
    // ラベルを使っていないアノテーション 2 は残る
    assert!(row(&conn, "annotations", &id(2)).is_some());
    assert_eq!(count(&conn, "attribute_schemas"), 0);

    store.undo().unwrap().unwrap();
    assert_eq!(snapshot(&read_conn(dir.path())), before);
    store.redo().unwrap().unwrap();
    assert!(row(&read_conn(dir.path()), "labels", &id(10)).is_none());
}

#[test]
fn an_unused_label_can_be_deleted_without_disposition() {
    let (dir, mut store) = labeled_project();
    let before = snapshot(&read_conn(dir.path()));
    store
        .apply_command(Command::DeleteLabel {
            id: id(11),
            disposition: None,
        })
        .unwrap();
    assert!(row(&read_conn(dir.path()), "labels", &id(11)).is_none());
    store.undo().unwrap().unwrap();
    assert_eq!(snapshot(&read_conn(dir.path())), before);
}

#[test]
fn reassign_to_a_missing_or_the_same_label_is_rejected() {
    let (dir, mut store) = labeled_project();
    let before = snapshot(&read_conn(dir.path()));
    let reassign = |to: String| Command::DeleteLabel {
        id: id(10),
        disposition: Some(LabelDisposition::Reassign { to_label_id: to }),
    };
    assert_eq!(
        store
            .apply_command(reassign("missing".into()))
            .unwrap_err()
            .code(),
        "not_found"
    );
    assert_eq!(
        store.apply_command(reassign(id(10))).unwrap_err().code(),
        "invalid_command"
    );
    assert_eq!(
        store
            .apply_command(Command::DeleteLabel {
                id: "missing".into(),
                disposition: None
            })
            .unwrap_err()
            .code(),
        "not_found"
    );
    assert_eq!(snapshot(&read_conn(dir.path())), before);
    let _ = Value::Null;
}
