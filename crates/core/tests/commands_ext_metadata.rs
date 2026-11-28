//! 009: 拡張機能のメタ情報（`assets.setMetadata`）のコマンド。拡張機能 ID ごとの名前空間に記録する。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use support::{new_project, read_conn, row, snapshot, text};
use unnotator_core::command::{Command, ItemRef};
use unnotator_core::error::StoreError;

fn item() -> ItemRef {
    ItemRef {
        asset_id: "a1".into(),
        item_key: "page:3".into(),
        provider: "com.example.doc/pages".into(),
    }
}

fn set_asset(namespace: &str, json: &str) -> Command {
    Command::SetAssetMetadata {
        asset_id: "a1".into(),
        namespace: namespace.into(),
        metadata_json: json.into(),
    }
}

fn metadata_of_asset(dir: &support::TempDir) -> serde_json::Value {
    let conn = read_conn(dir.path());
    let rows = row(&conn, "assets", "a1").unwrap();
    let rusqlite::types::Value::Text(json) = &rows["metadata_json"] else {
        panic!("metadata_json が文字列でない");
    };
    serde_json::from_str(json).unwrap()
}

#[test]
fn namespaces_are_separate_and_replaced_as_a_whole() {
    let (dir, mut store) = new_project(&["a1"]);
    store
        .apply_command(set_asset("com.example.a", r#"{"width":10,"height":20}"#))
        .unwrap();
    store
        .apply_command(set_asset("com.example.b", r#"{"dpi":72}"#))
        .unwrap();
    assert_eq!(
        metadata_of_asset(&dir),
        serde_json::json!({
            "com.example.a": {"width": 10, "height": 20},
            "com.example.b": {"dpi": 72}
        })
    );
    // 同じ名前空間は、丸ごと置き換わる。ほかの名前空間は触らない。
    store
        .apply_command(set_asset("com.example.a", r#"{"width":99}"#))
        .unwrap();
    assert_eq!(
        metadata_of_asset(&dir),
        serde_json::json!({
            "com.example.a": {"width": 99},
            "com.example.b": {"dpi": 72}
        })
    );
}

#[test]
fn apply_undo_redo_round_trips_for_assets_and_items() {
    let (dir, mut store) = new_project(&["a1"]);
    for command in [
        set_asset("com.example.a", r#"{"width":10}"#),
        Command::SetItemMetadata {
            item: item(),
            namespace: "com.example.a".into(),
            metadata_json: r#"{"page":3}"#.into(),
        },
    ] {
        let before = snapshot(&read_conn(dir.path()));
        store.apply_command(command).unwrap();
        let applied = snapshot(&read_conn(dir.path()));
        assert_ne!(before, applied);
        store.undo().unwrap().expect("undo できる");
        assert_eq!(snapshot(&read_conn(dir.path())), before);
        store.redo().unwrap().expect("redo できる");
        assert_eq!(snapshot(&read_conn(dir.path())), applied);
    }
    // アイテムの行は、メタ情報を書くときに作られる（同じ Undo 単位）。
    let conn = read_conn(dir.path());
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM items WHERE item_key = 'page:3'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    let _ = text("");
}

#[test]
fn unchanged_value_writes_nothing_and_leaves_no_undo_entry() {
    let (_dir, mut store) = new_project(&["a1"]);
    store
        .apply_command(set_asset("com.example.a", r#"{"width":10}"#))
        .unwrap();
    let again = store
        .apply_command(set_asset("com.example.a", r#"{"width":10}"#))
        .unwrap();
    assert!(again.changes.is_empty());
}

#[test]
fn invalid_input_is_refused_and_nothing_is_written() {
    let (dir, mut store) = new_project(&["a1"]);
    let before = snapshot(&read_conn(dir.path()));
    for bad in [
        set_asset("", r#"{"w":1}"#),
        set_asset("com.example.a", "[1]"),
        set_asset("com.example.a", "{oops"),
        Command::SetAssetMetadata {
            asset_id: "nope".into(),
            namespace: "com.example.a".into(),
            metadata_json: "{}".into(),
        },
    ] {
        let error = store.apply_command(bad).unwrap_err();
        assert!(
            matches!(
                error,
                StoreError::InvalidCommand(_) | StoreError::NotFound(_)
            ),
            "{error:?}"
        );
    }
    assert_eq!(snapshot(&read_conn(dir.path())), before);
}
