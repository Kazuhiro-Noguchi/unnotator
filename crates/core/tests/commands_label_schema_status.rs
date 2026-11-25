//! US2: ラベル・属性スキーマ・作業状態のコマンド。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use rusqlite::types::Value;
use support::{create_label, new_project, read_conn, row, snapshot, text};
use unnotator_core::command::{AttributeScope, Command, Field, ItemRef, LabelPatch, Status};
use unnotator_core::event::{ChangeKind, Entity};

#[test]
fn label_create_and_update() {
    let (dir, mut store) = new_project(&[]);
    let set = store.apply_command(create_label("person")).unwrap();
    assert_eq!(set.changes[0].entity, Entity::Label);
    assert!(set.asset_ids.is_empty());
    let id = set.changes[0].id.clone();
    let stored = row(&read_conn(dir.path()), "labels", &id).unwrap();
    assert_eq!(stored["name"], text("person"));
    assert_eq!(stored["hidden"], Value::Integer(0));
    assert_eq!(stored["hotkey"], Value::Null);

    store
        .apply_command(Command::UpdateLabel {
            id: id.clone(),
            patch: LabelPatch {
                name: Field::Set("human".into()),
                hotkey: Field::Set(3),
                hidden: Field::Set(true),
                ..LabelPatch::default()
            },
        })
        .unwrap();
    let stored = row(&read_conn(dir.path()), "labels", &id).unwrap();
    assert_eq!(stored["name"], text("human"));
    assert_eq!(stored["hotkey"], Value::Integer(3));
    assert_eq!(stored["hidden"], Value::Integer(1));

    store
        .apply_command(Command::UpdateLabel {
            id: id.clone(),
            patch: LabelPatch {
                hotkey: Field::Clear,
                ..LabelPatch::default()
            },
        })
        .unwrap();
    assert_eq!(
        row(&read_conn(dir.path()), "labels", &id).unwrap()["hotkey"],
        Value::Null
    );
}

#[test]
fn label_contract_violations_fail_without_changes() {
    let (dir, mut store) = new_project(&[]);
    store.apply_command(create_label("person")).unwrap();
    let before = snapshot(&read_conn(dir.path()));

    // 名前の重複
    assert_eq!(
        store
            .apply_command(create_label("person"))
            .unwrap_err()
            .code(),
        "invalid_command"
    );
    // 色の形が違う
    let mut bad_color = create_label("car");
    if let Command::CreateLabel { color, .. } = &mut bad_color {
        *color = "red".into();
    }
    assert_eq!(
        store.apply_command(bad_color).unwrap_err().code(),
        "invalid_command"
    );
    // ホットキーが範囲外
    let mut bad_hotkey = create_label("bike");
    if let Command::CreateLabel { hotkey, .. } = &mut bad_hotkey {
        *hotkey = Some(10);
    }
    assert_eq!(
        store.apply_command(bad_hotkey).unwrap_err().code(),
        "invalid_command"
    );
    // 存在しないラベルの更新
    assert_eq!(
        store
            .apply_command(Command::UpdateLabel {
                id: "missing".into(),
                patch: LabelPatch::default()
            })
            .unwrap_err()
            .code(),
        "not_found"
    );
    assert_eq!(snapshot(&read_conn(dir.path())), before);
}

#[test]
fn attribute_schema_is_created_then_replaced_by_scope_and_target() {
    let (dir, mut store) = new_project(&[]);
    let schema = |title: &str| {
        format!(
            "{{\"type\":\"object\",\"properties\":{{\"color\":{{\"type\":\"string\",\"title\":\"{title}\"}}}},\"required\":[\"color\"]}}"
        )
    };
    let set = |schema_json: String| Command::SetAttributeSchema {
        scope: AttributeScope::AnnotationType,
        target: "com.example.shape/shape".into(),
        schema_json,
    };
    let first = store.apply_command(set(schema("one"))).unwrap();
    assert_eq!(first.changes[0].entity, Entity::AttributeSchema);
    assert_eq!(first.changes[0].kind, ChangeKind::Created);
    let id = first.changes[0].id.clone();

    let second = store.apply_command(set(schema("two"))).unwrap();
    assert_eq!(second.changes[0].kind, ChangeKind::Updated);
    assert_eq!(second.changes[0].id, id);
    let conn = read_conn(dir.path());
    assert_eq!(support::count(&conn, "attribute_schemas"), 1);
    assert_eq!(
        row(&conn, "attribute_schemas", &id).unwrap()["schema_json"],
        text(&schema("two"))
    );

    let deleted = store
        .apply_command(Command::DeleteAttributeSchema {
            scope: AttributeScope::AnnotationType,
            target: "com.example.shape/shape".into(),
        })
        .unwrap();
    assert_eq!(deleted.changes[0].kind, ChangeKind::Deleted);
    assert_eq!(
        support::count(&read_conn(dir.path()), "attribute_schemas"),
        0
    );
}

#[test]
fn attribute_schema_rejects_bad_shapes_and_scopes() {
    let (dir, mut store) = new_project(&[]);
    let before = snapshot(&read_conn(dir.path()));
    let set = |scope, target: &str, schema_json: &str| Command::SetAttributeSchema {
        scope,
        target: target.into(),
        schema_json: schema_json.into(),
    };
    // global は target が空でなければならない（契約の CHECK）
    assert_eq!(
        store
            .apply_command(set(
                AttributeScope::Global,
                "x",
                "{\"type\":\"object\",\"properties\":{}}"
            ))
            .unwrap_err()
            .code(),
        "invalid_command"
    );
    // サブセットの外（型・キー）
    for bad in [
        "not json",
        "[]",
        "{\"type\":\"array\"}",
        "{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"object\"}}}",
        "{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\",\"pattern\":\"x\"}}}",
        "{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}},\"required\":[\"b\"]}",
    ] {
        assert_eq!(
            store
                .apply_command(set(AttributeScope::Global, "", bad))
                .unwrap_err()
                .code(),
            "invalid_command",
            "{bad}"
        );
    }
    // label スコープの target は、存在するラベルでなければならない
    assert_eq!(
        store
            .apply_command(set(
                AttributeScope::Label,
                "missing",
                "{\"type\":\"object\",\"properties\":{}}"
            ))
            .unwrap_err()
            .code(),
        "not_found"
    );
    // 存在しない削除
    assert_eq!(
        store
            .apply_command(Command::DeleteAttributeSchema {
                scope: AttributeScope::Global,
                target: String::new()
            })
            .unwrap_err()
            .code(),
        "not_found"
    );
    assert_eq!(snapshot(&read_conn(dir.path())), before);
}

#[test]
fn asset_and_item_status() {
    let (dir, mut store) = new_project(&["a1"]);
    let set = store
        .apply_command(Command::SetAssetStatus {
            asset_id: "a1".into(),
            status: Status::Done,
        })
        .unwrap();
    assert_eq!(set.changes[0].entity, Entity::Asset);
    assert_eq!(set.asset_ids, vec!["a1".to_owned()]);
    assert_eq!(
        row(&read_conn(dir.path()), "assets", "a1").unwrap()["status"],
        text("done")
    );

    let item = ItemRef {
        asset_id: "a1".into(),
        item_key: "page:1".into(),
        provider: "com.example.doc/pages".into(),
    };
    // アイテムの行が無ければ作る
    let created = store
        .apply_command(Command::SetItemStatus {
            item: item.clone(),
            status: Status::InProgress,
        })
        .unwrap();
    assert_eq!(created.changes[0].entity, Entity::Item);
    assert_eq!(created.changes[0].kind, ChangeKind::Created);
    let id = created.changes[0].id.clone();
    assert_eq!(
        row(&read_conn(dir.path()), "items", &id).unwrap()["status"],
        text("in_progress")
    );
    // 2 回目は更新
    let updated = store
        .apply_command(Command::SetItemStatus {
            item,
            status: Status::Review,
        })
        .unwrap();
    assert_eq!(updated.changes[0].kind, ChangeKind::Updated);
    assert_eq!(support::count(&read_conn(dir.path()), "items"), 1);
}

#[test]
fn status_of_a_missing_asset_fails() {
    let (dir, mut store) = new_project(&["a1"]);
    let before = snapshot(&read_conn(dir.path()));
    assert_eq!(
        store
            .apply_command(Command::SetAssetStatus {
                asset_id: "missing".into(),
                status: Status::Done
            })
            .unwrap_err()
            .code(),
        "not_found"
    );
    assert_eq!(
        store
            .apply_command(Command::SetItemStatus {
                item: ItemRef {
                    asset_id: "missing".into(),
                    item_key: "k".into(),
                    provider: "p/q".into()
                },
                status: Status::Done
            })
            .unwrap_err()
            .code(),
        "not_found"
    );
    assert_eq!(snapshot(&read_conn(dir.path())), before);
}
