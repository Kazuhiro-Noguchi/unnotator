//! 開発者モードでも、権限の門は変わらない（FR-035）。
//! 緩めてよいのは、読み込み元のフォルダと自動再読み込みだけ。拡張機能の出所（`Origin::Dev`）で、
//! 権限の判定が変わってはならない。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;

use support::{TempDir, manifest};
use unnotator_extensions::consent::ConsentStore;
use unnotator_extensions::gate;
use unnotator_extensions::manifest::Manifest;
use unnotator_extensions::registry::{
    ExtensionEntry, Origin, RawExtension, Registry, RegistryInput,
};
use unnotator_extensions::state::ExtensionsState;

fn entry(origin: Origin, dev_mode: bool, permissions: &[&str]) -> ExtensionEntry {
    let raw = RawExtension::new(
        PathBuf::from("/ext"),
        origin,
        Manifest::from_value(
            manifest("com.example.text", "1.0.0")
                .permissions(permissions)
                .build(),
        )
        .unwrap(),
    );
    let mut state = ExtensionsState::default();
    state.set_dev_mode(dev_mode);
    let registry = Registry::build(RegistryInput {
        installed: &[raw],
        state: &state,
        app_api_version: "0.0.1",
    });
    registry.entry("com.example.text").unwrap().clone()
}

/// 共有の権限表にある、すべての Host API のメソッド。
fn all_methods() -> Vec<String> {
    let table: serde_json::Value =
        serde_json::from_str(include_str!("../host-api-permissions.json")).unwrap();
    table["methods"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect()
}

#[test]
fn every_host_api_method_has_the_same_verdict_for_dev_and_installed_extensions() {
    let tmp = TempDir::new();
    let consent = ConsentStore::open(&tmp.data_dir().join("permissions.json"));
    let installed = entry(Origin::Installed, false, &["assets.read"]);
    let dev = entry(Origin::Dev, true, &["assets.read"]);
    let methods = all_methods();
    assert!(methods.len() > 40, "表を読めている");
    for method in &methods {
        let a = format!("{:?}", gate::check_method(&consent, &installed, method));
        let b = format!("{:?}", gate::check_method(&consent, &dev, method));
        assert_eq!(a, b, "{method}");
    }
}

#[test]
fn a_dev_extension_still_needs_declaration_and_consent() {
    let tmp = TempDir::new();
    let mut consent = ConsentStore::open(&tmp.data_dir().join("permissions.json"));
    let dev = entry(Origin::Dev, true, &["assets.read"]);
    // 宣言のない権限は、開発者モードでも拒否
    assert!(gate::check_method(&consent, &dev, "annotations.create").is_err());
    // 宣言していても、同意が無ければ通らない
    assert!(gate::check_method(&consent, &dev, "assets.get").is_err());
    consent.grant(&dev, &["assets.read".to_owned()]).unwrap();
    assert!(gate::check_method(&consent, &dev, "assets.get").is_ok());
    assert!(gate::check_method(&consent, &dev, "annotations.create").is_err());
}

#[test]
fn every_command_has_the_same_verdict_for_dev_and_installed_extensions() {
    let tmp = TempDir::new();
    let consent = ConsentStore::open(&tmp.data_dir().join("permissions.json"));
    let installed = entry(Origin::Installed, false, &["annotations.write"]);
    let dev = entry(Origin::Dev, true, &["annotations.write"]);
    for name in [
        "create_annotation",
        "update_annotation",
        "delete_annotation",
        "create_label",
        "set_asset_status",
        "set_asset_note",
        "sync_assets",
        "delete_asset",
        "no_such_command",
    ] {
        let a = format!("{:?}", gate::check_command(&consent, &installed, name));
        let b = format!("{:?}", gate::check_command(&consent, &dev, name));
        assert_eq!(a, b, "{name}");
    }
}
