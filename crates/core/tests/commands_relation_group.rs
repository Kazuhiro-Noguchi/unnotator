//! US2: 関係とグループのコマンド。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use rusqlite::Connection;
use rusqlite::types::Value;
use support::{create_annotation, new_project, read_conn, row, snapshot, text};
use unnotator_core::command::{Command, Field, GroupPatch, RelationPatch};
use unnotator_core::event::{ChangeKind, Entity};
use unnotator_core::project::ProjectStore;

fn annotation(store: &mut ProjectStore, asset: &str) -> String {
    store
        .apply_command(create_annotation(asset, "{}"))
        .unwrap()
        .changes[0]
        .id
        .clone()
}

fn relation(from: &str, to: &str) -> Command {
    Command::CreateRelation {
        id: None,
        relation_type: "com.example.rel/link".into(),
        from_id: from.into(),
        to_id: to.into(),
        directed: None,
        label_id: None,
        attributes_json: None,
        source: None,
    }
}

fn group(members: Vec<String>) -> Command {
    Command::CreateGroup {
        id: None,
        group_type: "com.example.grp/track".into(),
        ordered: Some(true),
        label_id: None,
        attributes_json: None,
        members,
        source: None,
    }
}

/// グループのメンバーを position の順に（アノテーション ID で）返す。
fn members(conn: &Connection, group_id: &str) -> Vec<(String, i64)> {
    let mut stmt = conn
        .prepare("SELECT annotation_id, position FROM group_members WHERE group_id = ?1 ORDER BY position")
        .unwrap();
    stmt.query_map([group_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[test]
fn relation_create_update_delete() {
    let (dir, mut store) = new_project(&["a1", "a2"]);
    let a = annotation(&mut store, "a1");
    let b = annotation(&mut store, "a2");

    let set = store.apply_command(relation(&a, &b)).unwrap();
    assert_eq!(set.changes[0].entity, Entity::Relation);
    // 異なるアセットのアノテーション同士も結べる。両端のアセットが差分に出る
    assert_eq!(set.asset_ids, vec!["a1".to_owned(), "a2".to_owned()]);
    let id = set.changes[0].id.clone();
    let stored = row(&read_conn(dir.path()), "relations", &id).unwrap();
    assert_eq!(stored["directed"], Value::Integer(1));
    assert_eq!(stored["from_id"], text(&a));

    store
        .apply_command(Command::UpdateRelation {
            id: id.clone(),
            patch: RelationPatch {
                directed: Field::Set(false),
                attributes_json: Field::Set("{\"k\": 1}".into()),
                ..RelationPatch::default()
            },
        })
        .unwrap();
    let stored = row(&read_conn(dir.path()), "relations", &id).unwrap();
    assert_eq!(stored["directed"], Value::Integer(0));
    assert_eq!(stored["attributes_json"], text("{\"k\": 1}"));

    let set = store
        .apply_command(Command::DeleteRelation { id: id.clone() })
        .unwrap();
    assert_eq!(set.changes[0].kind, ChangeKind::Deleted);
    assert!(row(&read_conn(dir.path()), "relations", &id).is_none());
}

#[test]
fn relation_rejects_self_links_and_missing_ends() {
    let (dir, mut store) = new_project(&["a1"]);
    let a = annotation(&mut store, "a1");
    let before = snapshot(&read_conn(dir.path()));
    assert_eq!(
        store.apply_command(relation(&a, &a)).unwrap_err().code(),
        "invalid_command"
    );
    assert_eq!(
        store
            .apply_command(relation(&a, "missing"))
            .unwrap_err()
            .code(),
        "not_found"
    );
    assert_eq!(snapshot(&read_conn(dir.path())), before);
}

#[test]
fn group_create_numbers_members_from_zero() {
    let (dir, mut store) = new_project(&["a1"]);
    let a = annotation(&mut store, "a1");
    let b = annotation(&mut store, "a1");
    let c = annotation(&mut store, "a1");
    let set = store
        .apply_command(group(vec![a.clone(), b.clone(), c.clone()]))
        .unwrap();
    let group_id = set
        .changes
        .iter()
        .find(|c| c.entity == Entity::Group)
        .unwrap()
        .id
        .clone();
    assert_eq!(
        members(&read_conn(dir.path()), &group_id),
        vec![(a, 0), (b, 1), (c, 2)]
    );
    assert_eq!(
        set.changes
            .iter()
            .filter(|c| c.entity == Entity::GroupMember)
            .count(),
        3
    );
}

#[test]
fn add_remove_and_move_keep_positions_contiguous() {
    let (dir, mut store) = new_project(&["a1"]);
    let ids: Vec<String> = (0..5).map(|_| annotation(&mut store, "a1")).collect();
    let set = store
        .apply_command(group(vec![ids[0].clone(), ids[1].clone()]))
        .unwrap();
    let g = set
        .changes
        .iter()
        .find(|c| c.entity == Entity::Group)
        .unwrap()
        .id
        .clone();
    let conn = || read_conn(dir.path());
    let order = |conn: &Connection| -> Vec<String> {
        members(conn, &g).into_iter().map(|(a, _)| a).collect()
    };

    // 末尾に追加
    store
        .apply_command(Command::AddGroupMembers {
            group_id: g.clone(),
            annotation_ids: vec![ids[2].clone()],
            at: None,
        })
        .unwrap();
    assert_eq!(
        order(&conn()),
        vec![ids[0].clone(), ids[1].clone(), ids[2].clone()]
    );

    // 途中に挿入
    store
        .apply_command(Command::AddGroupMembers {
            group_id: g.clone(),
            annotation_ids: vec![ids[3].clone(), ids[4].clone()],
            at: Some(1),
        })
        .unwrap();
    assert_eq!(
        order(&conn()),
        vec![
            ids[0].clone(),
            ids[3].clone(),
            ids[4].clone(),
            ids[1].clone(),
            ids[2].clone()
        ]
    );
    let positions: Vec<i64> = members(&conn(), &g).into_iter().map(|(_, p)| p).collect();
    assert_eq!(positions, vec![0, 1, 2, 3, 4]);

    // 並べ替え
    store
        .apply_command(Command::MoveGroupMember {
            group_id: g.clone(),
            annotation_id: ids[2].clone(),
            to_position: 0,
        })
        .unwrap();
    assert_eq!(order(&conn())[0], ids[2]);

    // 外す（詰め直す）
    store
        .apply_command(Command::RemoveGroupMembers {
            group_id: g.clone(),
            annotation_ids: vec![ids[3].clone(), ids[1].clone()],
        })
        .unwrap();
    let remaining = members(&conn(), &g);
    assert_eq!(
        remaining.iter().map(|(_, p)| *p).collect::<Vec<_>>(),
        vec![0, 1, 2]
    );
}

#[test]
fn group_stays_when_it_loses_all_members() {
    let (dir, mut store) = new_project(&["a1"]);
    let a = annotation(&mut store, "a1");
    let set = store.apply_command(group(vec![a.clone()])).unwrap();
    let g = set
        .changes
        .iter()
        .find(|c| c.entity == Entity::Group)
        .unwrap()
        .id
        .clone();
    store
        .apply_command(Command::RemoveGroupMembers {
            group_id: g.clone(),
            annotation_ids: vec![a],
        })
        .unwrap();
    let conn = read_conn(dir.path());
    assert!(row(&conn, "annotation_groups", &g).is_some());
    assert!(members(&conn, &g).is_empty());
}

#[test]
fn group_update_and_delete() {
    let (dir, mut store) = new_project(&["a1"]);
    let a = annotation(&mut store, "a1");
    let set = store.apply_command(group(vec![a])).unwrap();
    let g = set
        .changes
        .iter()
        .find(|c| c.entity == Entity::Group)
        .unwrap()
        .id
        .clone();
    store
        .apply_command(Command::UpdateGroup {
            id: g.clone(),
            patch: GroupPatch {
                ordered: Field::Set(false),
                ..GroupPatch::default()
            },
        })
        .unwrap();
    assert_eq!(
        row(&read_conn(dir.path()), "annotation_groups", &g).unwrap()["ordered"],
        Value::Integer(0)
    );

    let set = store
        .apply_command(Command::DeleteGroup { id: g.clone() })
        .unwrap();
    assert!(
        set.changes
            .iter()
            .any(|c| c.entity == Entity::GroupMember && c.kind == ChangeKind::Deleted)
    );
    let conn = read_conn(dir.path());
    assert!(row(&conn, "annotation_groups", &g).is_none());
    assert!(members(&conn, &g).is_empty());
}

#[test]
fn group_rejects_unknown_or_duplicate_members_without_changes() {
    let (dir, mut store) = new_project(&["a1"]);
    let a = annotation(&mut store, "a1");
    let before = snapshot(&read_conn(dir.path()));
    assert_eq!(
        store
            .apply_command(group(vec![a.clone(), "missing".into()]))
            .unwrap_err()
            .code(),
        "not_found"
    );
    assert_eq!(
        store
            .apply_command(group(vec![a.clone(), a.clone()]))
            .unwrap_err()
            .code(),
        "invalid_command"
    );
    assert_eq!(snapshot(&read_conn(dir.path())), before);
}
