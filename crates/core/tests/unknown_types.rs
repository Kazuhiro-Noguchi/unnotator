//! US6: 拡張機能が無くても、未知の種別のアノテーションと拡張機能専用のデータは失われない。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use rusqlite::Connection;
use rusqlite::types::Value;
use support::{TempDir, new_project, read_conn, row, snapshot, text};
use unnotator_core::command::{
    AnnotationPatch, Command, Field, ItemRef, LabelPatch, Status, Target,
};
use unnotator_core::db::migrate::Migration;
use unnotator_core::migrations::PROJECT_V1;
use unnotator_core::project::{ProjectStore, StoreConfig};

const FUTURE_TYPE: &str = "com.example.future/shape";
/// 空白やキーの順を含む、コアが知らない形式の位置の指定。
const SELECTOR: &str = "{ \"zz\": [1,  2.50, {\"k\":null}],\n \"aa\": \"日本語\" }";
const SUMMARY: &str = "将来の拡張機能が作った要約";
const ANNOTATION_ID: &str = "00000000-0000-7000-8000-00000000f001";

/// 未知の種別のアノテーション・アイテム・拡張機能専用のデータを含むプロジェクト。
fn project_with_unknown_data() -> (TempDir, ProjectStore) {
    let (dir, mut store) = new_project(&["a1"]);
    store
        .apply_command(Command::CreateAnnotation {
            id: Some(ANNOTATION_ID.into()),
            target: Target {
                asset_id: "a1".into(),
                item: Some(ItemRef {
                    asset_id: "a1".into(),
                    item_key: "frame:120".into(),
                    provider: "com.example.future/frames".into(),
                }),
            },
            annotation_type: FUTURE_TYPE.into(),
            type_version: Some(3),
            selector_json: SELECTOR.into(),
            label_id: None,
            attributes_json: Some("{ \"x\": 1 }".into()),
            summary: Some(SUMMARY.into()),
            z_order: Some(5),
            source: Some("com.example.future".into()),
        })
        .unwrap();
    {
        let conn = Connection::open(dir.path().join(".unnotator/project.db")).unwrap();
        conn.execute_batch(
            "INSERT INTO plugin_data (plugin_id, scope, scope_id, key, value_json, updated_at) VALUES
               ('com.example.future', 'project', '', 'config', '{ \"a\":  1 }', 1),
               ('com.example.future', 'asset', 'a1', 'cache', '[1,2,  3]', 2);",
        )
        .unwrap();
    }
    (dir, store)
}

/// コアが書き換えてはならない項目（種別・位置の指定・種別の版・要約文・作成元）。
fn untouchable(dir: &TempDir) -> Vec<Value> {
    let stored = row(&read_conn(dir.path()), "annotations", ANNOTATION_ID).unwrap();
    [
        "type",
        "type_version",
        "selector_json",
        "summary",
        "source",
        "item_id",
        "asset_id",
    ]
    .iter()
    .map(|column| stored[*column].clone())
    .collect()
}

fn plugin_data(dir: &TempDir) -> Vec<Vec<Value>> {
    snapshot(&read_conn(dir.path()))
        .into_iter()
        .find(|(name, _)| name == "plugin_data")
        .map(|(_, rows)| rows)
        .unwrap()
}

#[test]
fn unknown_type_data_is_stored_byte_for_byte() {
    let (dir, _store) = project_with_unknown_data();
    let stored = row(&read_conn(dir.path()), "annotations", ANNOTATION_ID).unwrap();
    assert_eq!(stored["type"], text(FUTURE_TYPE));
    assert_eq!(stored["selector_json"], text(SELECTOR));
    assert_eq!(stored["type_version"], Value::Integer(3));
    assert_eq!(stored["summary"], text(SUMMARY));
    assert_eq!(plugin_data(&dir).len(), 2);
}

#[test]
fn label_attribute_and_status_edits_leave_the_unknown_parts_alone() {
    let (dir, mut store) = project_with_unknown_data();
    let before = untouchable(&dir);
    let plugin_before = plugin_data(&dir);

    let label = support::create_label("person");
    let label_id = store.apply_command(label).unwrap().changes[0].id.clone();
    store
        .apply_command(Command::UpdateAnnotation {
            id: ANNOTATION_ID.into(),
            patch: AnnotationPatch {
                label_id: Field::Set(label_id.clone()),
                attributes_json: Field::Set("{ \"y\":  2 }".into()),
                ..AnnotationPatch::default()
            },
        })
        .unwrap();
    store
        .apply_command(Command::UpdateLabel {
            id: label_id,
            patch: LabelPatch {
                name: Field::Set("human".into()),
                ..LabelPatch::default()
            },
        })
        .unwrap();
    store
        .apply_command(Command::SetAssetStatus {
            asset_id: "a1".into(),
            status: Status::Done,
        })
        .unwrap();
    store
        .apply_command(Command::SetItemStatus {
            item: ItemRef {
                asset_id: "a1".into(),
                item_key: "frame:120".into(),
                provider: "com.example.future/frames".into(),
            },
            status: Status::Review,
        })
        .unwrap();

    assert_eq!(untouchable(&dir), before);
    assert_eq!(plugin_data(&dir), plugin_before);
    let stored = row(&read_conn(dir.path()), "annotations", ANNOTATION_ID).unwrap();
    assert_eq!(stored["attributes_json"], text("{ \"y\":  2 }"));
}

#[test]
fn close_and_reopen_keeps_everything() {
    let (dir, store) = project_with_unknown_data();
    let before = snapshot(&read_conn(dir.path()));
    store.close().unwrap();
    ProjectStore::open(dir.path()).unwrap().close().unwrap();
    assert_eq!(snapshot(&read_conn(dir.path())), before);
}

#[test]
fn delete_then_undo_restores_the_unknown_annotation_exactly() {
    let (dir, mut store) = project_with_unknown_data();
    let before = snapshot(&read_conn(dir.path()));
    store
        .apply_command(Command::DeleteAnnotation {
            id: ANNOTATION_ID.into(),
        })
        .unwrap();
    assert!(row(&read_conn(dir.path()), "annotations", ANNOTATION_ID).is_none());
    // 拡張機能専用のデータは、アノテーションの削除でも消えない
    assert_eq!(plugin_data(&dir).len(), 2);
    store.undo().unwrap().unwrap();
    assert_eq!(snapshot(&read_conn(dir.path())), before);
}

static WITH_V2: &[Migration] = &[
    Migration {
        version: 1,
        sql: PROJECT_V1,
    },
    Migration {
        version: 2,
        sql: "CREATE TABLE test_extra (x INTEGER);",
    },
];

#[test]
fn migration_keeps_unknown_data_and_plugin_data() {
    let (dir, store) = project_with_unknown_data();
    let before = untouchable(&dir);
    let plugin_before = plugin_data(&dir);
    store.close().unwrap();

    let migrated = ProjectStore::open_with(
        dir.path(),
        StoreConfig {
            migrations: WITH_V2,
            ..StoreConfig::default()
        },
    )
    .unwrap();
    assert_eq!(migrated.migrated_from(), Some(1));
    migrated.close().unwrap();

    assert_eq!(untouchable(&dir), before);
    assert_eq!(plugin_data(&dir), plugin_before);
}

#[test]
fn plugin_data_is_outside_the_recorded_tables() {
    // コマンドの経路（Recorder）が扱うテーブルに、拡張機能専用のデータは入っていない。
    assert!(unnotator_core::db::tables::table("plugin_data").is_none());
    // どのコマンドを適用しても、plugin_data は変わらない。
    let (dir, mut store) = project_with_unknown_data();
    let before = plugin_data(&dir);
    store
        .apply_command(Command::Transaction {
            commands: vec![
                support::create_label("a"),
                support::create_annotation("a1", "{}"),
            ],
        })
        .unwrap();
    store.undo().unwrap().unwrap();
    store.redo().unwrap().unwrap();
    assert_eq!(plugin_data(&dir), before);
}
