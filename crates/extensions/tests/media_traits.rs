//! 媒体種別の作業単位とアイテム提供の宣言（007 の `media_traits`）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;

use serde_json::{Value, json};
use support::manifest;
use unnotator_extensions::manifest::Manifest;
use unnotator_extensions::registry::{Origin, RawExtension, Registry, RegistryInput, WorkUnit};
use unnotator_extensions::state::ExtensionsState;

fn raw(value: Value) -> RawExtension {
    RawExtension::new(
        PathBuf::from("/ext"),
        Origin::Installed,
        Manifest::from_value(value).unwrap(),
    )
}

fn build(extensions: &[RawExtension], state: &ExtensionsState) -> Registry {
    Registry::build(RegistryInput {
        installed: extensions,
        state,
        app_api_version: "0.0.1",
    })
}

fn paged() -> RawExtension {
    raw(manifest("com.example.doc", "1.0.0")
        .push(
            "mediaTypes",
            json!({
                "id": "doc", "title": "doc", "extensions": [".doc"],
                "workUnit": "item", "itemProvider": "pages"
            }),
        )
        .push(
            "itemProviders",
            json!({ "id": "pages", "title": "pages", "mediaTypes": ["doc"] }),
        )
        .push(
            "mediaTypes",
            json!({ "id": "plain", "title": "plain", "extensions": [".txt"] }),
        )
        .push(
            "mediaTypes",
            json!({
                "id": "browse", "title": "browse", "extensions": [".brw"],
                "itemProvider": "pages"
            }),
        )
        .build())
}

#[test]
fn item_work_units_and_item_providers_are_reported_by_media_type() {
    let state = ExtensionsState::default();
    let registry = build(&[paged()], &state);
    let traits = registry.media_traits();
    let find = |id: &str| traits.iter().find(|t| t.media_type == id);
    let doc = find("com.example.doc/doc").expect("宣言がある");
    assert_eq!(doc.work_unit, WorkUnit::Item);
    assert_eq!(doc.provider.as_deref(), Some("com.example.doc/pages"));
    let browse = find("com.example.doc/browse").expect("提供元だけの宣言");
    assert_eq!(browse.work_unit, WorkUnit::Asset);
    assert_eq!(browse.provider.as_deref(), Some("com.example.doc/pages"));
}

#[test]
fn media_types_without_a_declaration_are_left_out() {
    let state = ExtensionsState::default();
    let registry = build(&[paged()], &state);
    assert!(
        registry
            .media_traits()
            .iter()
            .all(|t| t.media_type != "com.example.doc/plain")
    );
}

#[test]
fn the_list_is_in_a_fixed_order() {
    let state = ExtensionsState::default();
    let registry = build(&[paged()], &state);
    let ids: Vec<_> = registry
        .media_traits()
        .into_iter()
        .map(|t| t.media_type)
        .collect();
    let mut sorted = ids.clone();
    sorted.sort();
    assert_eq!(ids, sorted);
}

#[test]
fn a_disabled_extension_contributes_nothing() {
    let mut state = ExtensionsState::default();
    state.set_disabled("com.example.doc", true);
    let registry = build(&[paged()], &state);
    assert!(registry.media_traits().is_empty());
}

#[test]
fn an_extension_with_no_media_types_gives_an_empty_list() {
    let state = ExtensionsState::default();
    let registry = build(&[raw(manifest("com.example.x", "1.0.0").build())], &state);
    assert!(registry.media_traits().is_empty());
}
