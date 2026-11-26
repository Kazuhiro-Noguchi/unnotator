//! 記録のあるアイテムの状態の問い合わせ（007 の `item_statuses`）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use support::new_project;
use unnotator_core::command::{Command, ItemRef, Status};

fn item(asset: &str, key: &str) -> ItemRef {
    ItemRef {
        asset_id: asset.to_owned(),
        item_key: key.to_owned(),
        provider: "com.example/pages".to_owned(),
    }
}

fn set(store: &mut unnotator_core::project::ProjectStore, asset: &str, key: &str, s: Status) {
    store
        .apply_command(Command::SetItemStatus {
            item: item(asset, key),
            status: s,
        })
        .unwrap();
}

#[test]
fn only_items_with_a_record_are_returned_with_their_status() {
    let (_dir, mut store) = new_project(&["a1", "a2"]);
    set(&mut store, "a1", "page:2", Status::Done);
    set(&mut store, "a1", "page:10", Status::Review);
    set(&mut store, "a2", "page:1", Status::InProgress);
    // キーの昇順（文字列として）。
    assert_eq!(
        store.item_statuses("a1").unwrap(),
        [
            ("page:10".to_owned(), Status::Review),
            ("page:2".to_owned(), Status::Done)
        ]
    );
    assert_eq!(
        store.item_statuses("a2").unwrap(),
        [("page:1".to_owned(), Status::InProgress)]
    );
}

#[test]
fn an_asset_without_records_or_unknown_gives_an_empty_list() {
    let (_dir, store) = new_project(&["a1"]);
    assert!(store.item_statuses("a1").unwrap().is_empty());
    assert!(store.item_statuses("nope").unwrap().is_empty());
}

#[test]
fn undo_removes_the_record_again() {
    let (_dir, mut store) = new_project(&["a1"]);
    set(&mut store, "a1", "page:2", Status::Done);
    assert_eq!(store.item_statuses("a1").unwrap().len(), 1);
    store.undo().unwrap();
    assert!(store.item_statuses("a1").unwrap().is_empty());
    store.redo().unwrap();
    assert_eq!(
        store.item_statuses("a1").unwrap(),
        [("page:2".to_owned(), Status::Done)]
    );
}
