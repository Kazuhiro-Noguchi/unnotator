//! 権限の門（research.md R7、contracts/host-api-gate.md）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::collections::BTreeSet;
use std::path::PathBuf;

use serde_json::Value;
use support::{TempDir, manifest};
use unnotator_extensions::consent::ConsentStore;
use unnotator_extensions::gate::{self, GateError};
use unnotator_extensions::manifest::Manifest;
use unnotator_extensions::registry::{
    ExtensionEntry, Origin, RawExtension, Registry, RegistryInput,
};
use unnotator_extensions::state::ExtensionsState;

fn entry_with(permissions: &[&str], disabled: bool) -> ExtensionEntry {
    let raw = RawExtension::new(
        PathBuf::from("/ext"),
        Origin::Installed,
        Manifest::from_value(
            manifest("com.example.text", "1.0.0")
                .permissions(permissions)
                .build(),
        )
        .unwrap(),
    );
    let mut state = ExtensionsState::default();
    if disabled {
        state.set_disabled("com.example.text", true);
    }
    let registry = Registry::build(RegistryInput {
        installed: &[raw],
        state: &state,
        app_api_version: "0.0.1",
    });
    registry.entry("com.example.text").unwrap().clone()
}

fn entry(permissions: &[&str]) -> ExtensionEntry {
    entry_with(permissions, false)
}

fn store(tmp: &TempDir) -> ConsentStore {
    ConsentStore::open(&tmp.data_dir().join("permissions.json"))
}

#[test]
fn undeclared_permission_is_denied() {
    let tmp = TempDir::new();
    let consent = store(&tmp);
    let e = entry(&["assets.read"]);
    assert!(matches!(
        gate::check_permission(&consent, &e, "annotations.write"),
        Err(GateError::Denied { .. })
    ));
}

#[test]
fn declared_but_not_consented_needs_consent() {
    let tmp = TempDir::new();
    let consent = store(&tmp);
    let e = entry(&["assets.read", "network"]);
    assert_eq!(
        gate::check_permission(&consent, &e, "assets.read"),
        Err(GateError::NeedsConsent {
            permission: "assets.read".to_owned(),
            warning: false
        })
    );
    assert_eq!(
        gate::check_permission(&consent, &e, "network"),
        Err(GateError::NeedsConsent {
            permission: "network".to_owned(),
            warning: true
        })
    );
}

#[test]
fn consented_is_allowed_and_revoke_closes_it_again() {
    let tmp = TempDir::new();
    let mut consent = store(&tmp);
    let e = entry(&["assets.read"]);
    consent.grant(&e, &["assets.read".to_owned()]).unwrap();
    assert_eq!(gate::check_permission(&consent, &e, "assets.read"), Ok(()));
    consent
        .revoke(&e.id, &e.version, &["assets.read".to_owned()])
        .unwrap();
    assert!(matches!(
        gate::check_permission(&consent, &e, "assets.read"),
        Err(GateError::NeedsConsent { .. })
    ));
}

#[test]
fn unknown_permission_is_rejected() {
    let tmp = TempDir::new();
    let consent = store(&tmp);
    let e = entry(&["assets.read"]);
    assert_eq!(
        gate::check_permission(&consent, &e, "root.everything"),
        Err(GateError::UnknownPermission("root.everything".to_owned()))
    );
}

#[test]
fn a_disabled_extension_gets_nothing_even_with_consent() {
    let tmp = TempDir::new();
    let mut consent = store(&tmp);
    let e = entry_with(&["assets.read"], true);
    consent.grant(&e, &["assets.read".to_owned()]).unwrap();
    assert_eq!(
        gate::check_permission(&consent, &e, "assets.read"),
        Err(GateError::Disabled)
    );
    assert_eq!(
        gate::check_method(&consent, &e, "selection.get"),
        Err(GateError::Disabled)
    );
}

#[test]
fn methods_resolve_through_the_table() {
    let tmp = TempDir::new();
    let mut consent = store(&tmp);
    let e = entry(&["assets.read", "annotations.write"]);
    // 権限が要らないメソッドは、宣言も同意も要らない
    assert_eq!(gate::check_method(&consent, &e, "selection.get"), Ok(()));
    assert_eq!(gate::check_method(&consent, &e, "storage.set"), Ok(()));
    // 要るメソッドは、同意が要る
    assert!(matches!(
        gate::check_method(&consent, &e, "assets.get"),
        Err(GateError::NeedsConsent { .. })
    ));
    consent.grant(&e, &["assets.read".to_owned()]).unwrap();
    assert_eq!(gate::check_method(&consent, &e, "assets.get"), Ok(()));
    // 宣言していない権限のメソッドは拒否
    assert!(matches!(
        gate::check_method(&consent, &e, "labels.list"),
        Err(GateError::Denied { .. })
    ));
    // 表にないメソッドは拒否
    assert_eq!(
        gate::check_method(&consent, &e, "fs.rm_rf"),
        Err(GateError::UnknownMethod("fs.rm_rf".to_owned()))
    );
}

#[test]
fn commands_resolve_through_the_table_and_closed_ones_stay_closed() {
    let tmp = TempDir::new();
    let mut consent = store(&tmp);
    let e = entry(&["annotations.write", "labels.write", "project.status"]);
    consent
        .grant(
            &e,
            &[
                "annotations.write".to_owned(),
                "labels.write".to_owned(),
                "project.status".to_owned(),
            ],
        )
        .unwrap();
    assert_eq!(
        gate::check_command(&consent, &e, "create_annotation"),
        Ok(())
    );
    assert_eq!(gate::check_command(&consent, &e, "create_label"), Ok(()));
    assert_eq!(
        gate::check_command(&consent, &e, "set_asset_status"),
        Ok(())
    );
    // 拡張機能には開かないコマンドは、権限があっても通らない
    for name in [
        "sync_assets",
        "relink_asset",
        "delete_asset",
        "set_asset_note",
    ] {
        assert_eq!(
            gate::check_command(&consent, &e, name),
            Err(GateError::NotOpen(name.to_owned())),
            "{name}"
        );
    }
    assert_eq!(
        gate::check_command(&consent, &e, "no_such_command"),
        Err(GateError::UnknownMethod("no_such_command".to_owned()))
    );
}

// --- 共有の表（TS も同じファイルを読む） ---

fn table() -> Value {
    serde_json::from_str(gate::TABLE_JSON).expect("表は JSON")
}

#[test]
fn table_permissions_match_the_manifest_schema() {
    let schema: Value = serde_json::from_str(unnotator_extensions::MANIFEST_SCHEMA).unwrap();
    let in_schema: BTreeSet<String> = schema["properties"]["permissions"]["items"]["enum"]
        .as_array()
        .expect("スキーマに権限の列挙がある")
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    let in_table: BTreeSet<String> = table()["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(in_table, in_schema);
}

#[test]
fn every_method_and_command_names_a_known_permission_or_none() {
    let t = table();
    let known: BTreeSet<&str> = t["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    for (name, value) in t["methods"].as_object().unwrap() {
        match value {
            Value::Null => {}
            Value::String(p) => assert!(known.contains(p.as_str()), "{name} -> {p}"),
            other => panic!("{name}: {other}"),
        }
    }
    for (name, value) in t["commands"].as_object().unwrap() {
        match value {
            Value::Bool(false) => {}
            Value::String(p) => assert!(known.contains(p.as_str()), "{name} -> {p}"),
            other => panic!("{name}: {other}"),
        }
    }
}

#[test]
fn command_table_covers_every_core_command_except_transaction() {
    let t = table();
    let in_table: BTreeSet<&str> = t["commands"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    let in_core: BTreeSet<&str> = unnotator_core::command::COMMAND_NAMES
        .iter()
        .copied()
        .filter(|n| *n != "transaction")
        .collect();
    assert_eq!(in_table, in_core, "コマンドを足したら、表にも足す");
}

#[test]
fn table_covers_the_host_api_surface() {
    let t = table();
    let methods: BTreeSet<&str> = t["methods"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    for required in [
        "assets.get",
        "assets.url",
        "assets.read",
        "assets.readText",
        "assets.setMetadata",
        "assets.setStatus",
        "annotations.query",
        "annotations.create",
        "annotations.transaction",
        "annotations.suggest",
        "relations.query",
        "groups.setMembers",
        "labels.list",
        "labels.active",
        "selection.get",
        "extensions.getApi",
        "python.request",
        "projectFiles.read",
        "projectFiles.write",
        "storage.get",
        "storage.set",
        "settings.get",
        "ui.notify",
        "i18n.t",
        "export.writeFile",
        "import.readFile",
    ] {
        assert!(methods.contains(required), "表に無い: {required}");
    }
}
