//! 008: アセットのメモ・属性、アイテムの属性のコマンド（apply → undo → redo の往復）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use support::{new_project, read_conn, row, snapshot, text};
use unnotator_core::command::{Command, ItemRef};
use unnotator_core::event::{ChangeKind, Entity};

fn item() -> ItemRef {
    ItemRef {
        asset_id: "a1".into(),
        item_key: "page:3".into(),
        provider: "com.example.doc/pages".into(),
    }
}

/// 適用 → undo → redo の状態を比べる。
fn round_trip(
    dir: &support::TempDir,
    store: &mut unnotator_core::project::ProjectStore,
    command: Command,
) {
    let before = snapshot(&read_conn(dir.path()));
    store.apply_command(command).unwrap();
    let applied = snapshot(&read_conn(dir.path()));
    assert_ne!(before, applied);
    store.undo().unwrap().expect("undo できる");
    assert_eq!(snapshot(&read_conn(dir.path())), before);
    store.redo().unwrap().expect("redo できる");
    assert_eq!(snapshot(&read_conn(dir.path())), applied);
}

#[test]
fn asset_note_round_trips_and_can_be_cleared() {
    let (dir, mut store) = new_project(&["a1"]);
    round_trip(
        &dir,
        &mut store,
        Command::SetAssetNote {
            asset_id: "a1".into(),
            note: Some("メモ".into()),
        },
    );
    let conn = read_conn(dir.path());
    assert_eq!(row(&conn, "assets", "a1").unwrap()["note"], text("メモ"));
    // 空にできる（NULL に戻る）
    round_trip(
        &dir,
        &mut store,
        Command::SetAssetNote {
            asset_id: "a1".into(),
            note: None,
        },
    );
    let conn = read_conn(dir.path());
    assert_eq!(
        row(&conn, "assets", "a1").unwrap()["note"],
        rusqlite::types::Value::Null
    );
}

#[test]
fn asset_attributes_round_trip_and_reach_the_diff() {
    let (dir, mut store) = new_project(&["a1"]);
    let set = store
        .apply_command(Command::SetAssetAttributes {
            asset_id: "a1".into(),
            attributes_json: r#"{"quality":"good"}"#.into(),
        })
        .unwrap();
    assert_eq!(set.changes.len(), 1);
    assert_eq!(set.changes[0].entity, Entity::Asset);
    assert_eq!(set.changes[0].kind, ChangeKind::Updated);
    assert_eq!(set.asset_ids, vec!["a1".to_owned()]);
    store.undo().unwrap();
    round_trip(
        &dir,
        &mut store,
        Command::SetAssetAttributes {
            asset_id: "a1".into(),
            attributes_json: r#"{"quality":"good"}"#.into(),
        },
    );
}

#[test]
fn attributes_must_be_a_json_object_and_the_asset_must_exist() {
    let (_dir, mut store) = new_project(&["a1"]);
    for bad in ["[1]", "\"x\"", "{", ""] {
        assert!(
            store
                .apply_command(Command::SetAssetAttributes {
                    asset_id: "a1".into(),
                    attributes_json: bad.into(),
                })
                .is_err(),
            "{bad}"
        );
    }
    assert!(
        store
            .apply_command(Command::SetAssetNote {
                asset_id: "nope".into(),
                note: Some("x".into()),
            })
            .is_err()
    );
    assert!(
        store
            .apply_command(Command::SetItemAttributes {
                item: ItemRef {
                    asset_id: "nope".into(),
                    ..item()
                },
                attributes_json: "{}".into(),
            })
            .is_err()
    );
}

#[test]
fn item_attributes_create_the_item_row_in_the_same_undo_step() {
    let (dir, mut store) = new_project(&["a1"]);
    round_trip(
        &dir,
        &mut store,
        Command::SetItemAttributes {
            item: item(),
            attributes_json: r#"{"k":1}"#.into(),
        },
    );
    let conn = read_conn(dir.path());
    let stored: String = conn
        .query_row(
            "SELECT attributes_json FROM items WHERE asset_id = 'a1' AND item_key = 'page:3'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(stored, r#"{"k":1}"#);
    // 既にある行は、そのまま更新する
    round_trip(
        &dir,
        &mut store,
        Command::SetItemAttributes {
            item: item(),
            attributes_json: r#"{"k":2}"#.into(),
        },
    );
}

#[test]
fn setting_the_same_value_does_not_touch_the_history() {
    let (_dir, mut store) = new_project(&["a1"]);
    store
        .apply_command(Command::SetAssetNote {
            asset_id: "a1".into(),
            note: Some("x".into()),
        })
        .unwrap();
    let depth = store.undo_state().undo_depth;
    let set = store
        .apply_command(Command::SetAssetNote {
            asset_id: "a1".into(),
            note: Some("x".into()),
        })
        .unwrap();
    assert!(set.changes.is_empty());
    assert_eq!(store.undo_state().undo_depth, depth);
    // 属性も同じ
    store
        .apply_command(Command::SetAssetAttributes {
            asset_id: "a1".into(),
            attributes_json: "{}".into(),
        })
        .unwrap();
    assert_eq!(store.undo_state().undo_depth, depth);
}
