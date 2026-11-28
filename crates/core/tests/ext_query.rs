//! 009: 拡張機能向けの読み取り（`selector_json` を含む。絞り込みと上限）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use support::{create_annotation, new_project};
use unnotator_core::command::{Command, ItemRef, Target};
use unnotator_core::query::ext::{
    ExtAnnotationFilter, ExtGroupFilter, ExtRelationFilter, MAX_QUERY_LIMIT,
};

fn item(asset: &str, key: &str) -> Target {
    Target {
        asset_id: asset.to_owned(),
        item: Some(ItemRef {
            asset_id: asset.to_owned(),
            item_key: key.to_owned(),
            provider: "com.example.doc/pages".to_owned(),
        }),
    }
}

#[test]
fn annotations_carry_selector_and_filter_by_asset_item_type_and_id() {
    let (_dir, mut store) = new_project(&["a1", "a2"]);
    let first = store
        .apply_command(create_annotation("a1", r#"{"x":1}"#))
        .unwrap()
        .changes[0]
        .id
        .clone();
    store
        .apply_command(create_annotation("a2", r#"{"x":2}"#))
        .unwrap();
    store
        .apply_command(Command::CreateAnnotation {
            id: None,
            target: item("a1", "page:3"),
            annotation_type: "com.example.other/mark".into(),
            type_version: None,
            selector_json: r#"{"p":3}"#.into(),
            label_id: None,
            attributes_json: None,
            summary: Some("三".into()),
            z_order: None,
            source: Some("com.example.ext".into()),
        })
        .unwrap();

    let all = store
        .ext_annotations(&ExtAnnotationFilter::default())
        .unwrap();
    assert_eq!(all.len(), 3);

    let a1 = store
        .ext_annotations(&ExtAnnotationFilter {
            asset_id: Some("a1".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(a1.len(), 2);
    assert!(a1.iter().any(|a| a.selector_json == r#"{"x":1}"#));

    let page3 = store
        .ext_annotations(&ExtAnnotationFilter {
            asset_id: Some("a1".into()),
            item_key: Some("page:3".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(page3.len(), 1);
    assert_eq!(page3[0].item_key.as_deref(), Some("page:3"));
    assert_eq!(page3[0].summary, "三");
    assert_eq!(page3[0].source, "com.example.ext");

    let by_type = store
        .ext_annotations(&ExtAnnotationFilter {
            types: vec!["com.example.other/mark".into()],
            ..Default::default()
        })
        .unwrap();
    assert_eq!(by_type.len(), 1);

    let by_id = store
        .ext_annotations(&ExtAnnotationFilter {
            ids: vec![first.clone()],
            ..Default::default()
        })
        .unwrap();
    assert_eq!(by_id.len(), 1);
    assert_eq!(by_id[0].id, first);

    // アイテムのキーだけでは、アセットが決まらない。
    let orphan_key = store
        .ext_annotations(&ExtAnnotationFilter {
            item_key: Some("page:3".into()),
            ..Default::default()
        })
        .unwrap();
    assert!(orphan_key.is_empty());
}

#[test]
fn annotation_query_pages_with_limit_and_offset_and_caps_the_limit() {
    let (_dir, mut store) = new_project(&["a1"]);
    for n in 0..5 {
        store
            .apply_command(create_annotation("a1", &format!(r#"{{"n":{n}}}"#)))
            .unwrap();
    }
    let page = store
        .ext_annotations(&ExtAnnotationFilter {
            limit: Some(2),
            offset: Some(1),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(page.len(), 2);
    // 上限を超える指定は、上限に丸める（エラーにしない）。
    let big = store
        .ext_annotations(&ExtAnnotationFilter {
            limit: Some(MAX_QUERY_LIMIT * 10),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(big.len(), 5);
}

#[test]
fn relations_and_groups_filter_by_annotation_and_asset() {
    let (_dir, mut store) = new_project(&["a1", "a2"]);
    let mut ids = Vec::new();
    for asset in ["a1", "a1", "a2"] {
        ids.push(
            store
                .apply_command(create_annotation(asset, "{}"))
                .unwrap()
                .changes[0]
                .id
                .clone(),
        );
    }
    store
        .apply_command(Command::CreateRelation {
            id: None,
            relation_type: "com.example.rel/link".into(),
            from_id: ids[0].clone(),
            to_id: ids[2].clone(),
            directed: None,
            label_id: None,
            attributes_json: None,
            source: Some("com.example.ext".into()),
        })
        .unwrap();
    store
        .apply_command(Command::CreateGroup {
            id: None,
            group_type: "com.example.grp/track".into(),
            ordered: Some(true),
            label_id: None,
            attributes_json: None,
            members: vec![ids[1].clone(), ids[0].clone()],
            source: None,
        })
        .unwrap();

    let by_end = store
        .ext_relations(&ExtRelationFilter {
            annotation_ids: vec![ids[2].clone()],
            ..Default::default()
        })
        .unwrap();
    assert_eq!(by_end.len(), 1);
    assert_eq!(by_end[0].source, "com.example.ext");
    assert!(by_end[0].directed);
    // どちらの端のアセットでも見つかる。
    for asset in ["a1", "a2"] {
        assert_eq!(
            store
                .ext_relations(&ExtRelationFilter {
                    asset_id: Some(asset.into()),
                    ..Default::default()
                })
                .unwrap()
                .len(),
            1
        );
    }
    assert!(
        store
            .ext_relations(&ExtRelationFilter {
                annotation_ids: vec![ids[1].clone()],
                ..Default::default()
            })
            .unwrap()
            .is_empty()
    );

    let groups = store
        .ext_groups(&ExtGroupFilter {
            asset_id: Some("a1".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(groups.len(), 1);
    // メンバーは position 順（作成時の並び）。
    assert_eq!(groups[0].member_ids, vec![ids[1].clone(), ids[0].clone()]);
    // ID で絞る（更新の前に、現在の値を読む）
    assert_eq!(
        store
            .ext_groups(&ExtGroupFilter {
                ids: vec![groups[0].id.clone()],
                ..Default::default()
            })
            .unwrap()
            .len(),
        1
    );
    assert!(
        store
            .ext_groups(&ExtGroupFilter {
                ids: vec!["nope".into()],
                ..Default::default()
            })
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store
            .ext_relations(&ExtRelationFilter {
                ids: vec![by_end[0].id.clone()],
                ..Default::default()
            })
            .unwrap()
            .len(),
        1
    );
    assert!(
        store
            .ext_groups(&ExtGroupFilter {
                asset_id: Some("a2".into()),
                ..Default::default()
            })
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store
            .ext_groups(&ExtGroupFilter {
                types: vec!["com.example.grp/track".into()],
                annotation_ids: vec![ids[0].clone()],
                ..Default::default()
            })
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn asset_and_item_rows_include_metadata_and_attributes() {
    let (_dir, mut store) = new_project(&["a1"]);
    assert!(store.ext_asset("nope").unwrap().is_none());
    let asset = store.ext_asset("a1").unwrap().unwrap();
    assert_eq!(asset.metadata_json, "{}");
    assert_eq!(asset.attributes_json, "{}");
    assert!(store.ext_item("a1", "page:3").unwrap().is_none());
    store
        .apply_command(Command::SetItemStatus {
            item: ItemRef {
                asset_id: "a1".into(),
                item_key: "page:3".into(),
                provider: "com.example.doc/pages".into(),
            },
            status: unnotator_core::command::Status::Done,
        })
        .unwrap();
    let item = store.ext_item("a1", "page:3").unwrap().unwrap();
    assert_eq!(item.provider, "com.example.doc/pages");
    assert_eq!(item.status, unnotator_core::command::Status::Done);
}
