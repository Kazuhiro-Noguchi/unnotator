//! 権限の同意の保存と判定（spec.md US5、research.md R7）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;

use support::{TempDir, manifest};
use unnotator_core::fsio::WriteStage;
use unnotator_extensions::consent::{ConsentStore, PermissionVerdict};
use unnotator_extensions::manifest::Manifest;
use unnotator_extensions::registry::{
    ExtensionEntry, Origin, RawExtension, Registry, RegistryInput,
};
use unnotator_extensions::state::ExtensionsState;

fn entry(version: &str, permissions: &[&str]) -> ExtensionEntry {
    let raw = RawExtension::new(
        PathBuf::from("/ext"),
        Origin::Installed,
        Manifest::from_value(
            manifest("com.example.text", version)
                .permissions(permissions)
                .build(),
        )
        .unwrap(),
    );
    let registry = Registry::build(RegistryInput {
        installed: &[raw],
        state: &ExtensionsState::default(),
        app_api_version: "0.0.1",
    });
    registry.entry("com.example.text").unwrap().clone()
}

fn file(tmp: &TempDir) -> PathBuf {
    tmp.data_dir().join("permissions.json")
}

fn verdict(store: &ConsentStore, e: &ExtensionEntry, p: &str) -> PermissionVerdict {
    store.check(e, p)
}

#[test]
fn undeclared_is_denied_and_declared_needs_consent_until_granted() {
    let tmp = TempDir::new();
    let mut store = ConsentStore::open(&file(&tmp));
    let e = entry("1.0.0", &["assets.read", "annotations.write"]);
    assert_eq!(
        verdict(&store, &e, "labels.write"),
        PermissionVerdict::Denied
    );
    assert_eq!(
        verdict(&store, &e, "assets.read"),
        PermissionVerdict::NeedsConsent { warning: false }
    );
    store.grant(&e, &["assets.read".to_owned()]).unwrap();
    assert_eq!(
        verdict(&store, &e, "assets.read"),
        PermissionVerdict::Allowed
    );
    assert_eq!(
        verdict(&store, &e, "annotations.write"),
        PermissionVerdict::NeedsConsent { warning: false }
    );
    let pending = store.pending(&e);
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].permission, "annotations.write");
}

#[test]
fn consent_survives_a_restart() {
    let tmp = TempDir::new();
    let e = entry("1.0.0", &["assets.read"]);
    ConsentStore::open(&file(&tmp))
        .grant(&e, &["assets.read".to_owned()])
        .unwrap();
    let again = ConsentStore::open(&file(&tmp));
    assert_eq!(
        verdict(&again, &e, "assets.read"),
        PermissionVerdict::Allowed
    );
}

#[test]
fn an_update_keeps_consent_and_asks_only_about_new_permissions() {
    let tmp = TempDir::new();
    let mut store = ConsentStore::open(&file(&tmp));
    let v1 = entry("1.0.0", &["assets.read", "labels.read"]);
    store
        .grant(&v1, &["assets.read".to_owned(), "labels.read".to_owned()])
        .unwrap();

    let same = entry("1.1.0", &["assets.read", "labels.read"]);
    assert!(
        store.pending(&same).is_empty(),
        "変わらない更新は聞き直さない"
    );
    assert_eq!(
        verdict(&store, &same, "labels.read"),
        PermissionVerdict::Allowed
    );

    let more = entry("2.0.0", &["assets.read", "annotations.write"]);
    assert_eq!(
        verdict(&store, &more, "assets.read"),
        PermissionVerdict::Allowed
    );
    assert_eq!(
        verdict(&store, &more, "annotations.write"),
        PermissionVerdict::NeedsConsent { warning: false }
    );
    assert_eq!(
        verdict(&store, &more, "labels.read"),
        PermissionVerdict::Denied,
        "宣言から外れたものは許可されない"
    );
    assert_eq!(store.pending(&more).len(), 1);
}

#[test]
fn network_needs_a_warned_consent() {
    let tmp = TempDir::new();
    let mut store = ConsentStore::open(&file(&tmp));
    let e = entry("1.0.0", &["network"]);
    assert_eq!(
        verdict(&store, &e, "network"),
        PermissionVerdict::NeedsConsent { warning: true }
    );
    assert!(store.pending(&e)[0].warning);
    store.grant(&e, &["network".to_owned()]).unwrap();
    assert_eq!(verdict(&store, &e, "network"), PermissionVerdict::Allowed);
}

#[test]
fn undeclared_permissions_cannot_be_granted() {
    let tmp = TempDir::new();
    let mut store = ConsentStore::open(&file(&tmp));
    let e = entry("1.0.0", &["assets.read"]);
    assert!(store.grant(&e, &["network".to_owned()]).is_err());
    assert_eq!(verdict(&store, &e, "network"), PermissionVerdict::Denied);
}

#[test]
fn revoke_and_forget_remove_consent() {
    let tmp = TempDir::new();
    let mut store = ConsentStore::open(&file(&tmp));
    let e = entry("1.0.0", &["assets.read", "labels.read"]);
    store
        .grant(&e, &["assets.read".to_owned(), "labels.read".to_owned()])
        .unwrap();
    store
        .revoke("com.example.text", "1.0.0", &["labels.read".to_owned()])
        .unwrap();
    assert_eq!(
        verdict(&store, &e, "assets.read"),
        PermissionVerdict::Allowed
    );
    assert_eq!(
        verdict(&store, &e, "labels.read"),
        PermissionVerdict::NeedsConsent { warning: false }
    );
    store.forget("com.example.text").unwrap();
    assert_eq!(
        verdict(&store, &e, "assets.read"),
        PermissionVerdict::NeedsConsent { warning: false }
    );
    // 再導入しても、古い同意は戻らない
    let reopened = ConsentStore::open(&file(&tmp));
    assert_eq!(
        verdict(&reopened, &e, "assets.read"),
        PermissionVerdict::NeedsConsent { warning: false }
    );
}

#[test]
fn a_corrupt_file_is_set_aside_and_everything_is_asked_again() {
    let tmp = TempDir::new();
    std::fs::write(file(&tmp), "{ broken").unwrap();
    let store = ConsentStore::open(&file(&tmp));
    let e = entry("1.0.0", &["assets.read"]);
    assert_eq!(
        verdict(&store, &e, "assets.read"),
        PermissionVerdict::NeedsConsent { warning: false }
    );
    let moved = std::fs::read_dir(tmp.data_dir())
        .unwrap()
        .flatten()
        .filter(|f| {
            f.file_name()
                .to_string_lossy()
                .starts_with("permissions.json.corrupt-")
        })
        .count();
    assert_eq!(moved, 1);
}

#[test]
fn an_interrupted_write_keeps_the_old_consent() {
    let tmp = TempDir::new();
    let mut store = ConsentStore::open(&file(&tmp));
    let e = entry("1.0.0", &["assets.read", "labels.read"]);
    store.grant(&e, &["assets.read".to_owned()]).unwrap();
    let _ = store.grant_with_stop(&e, &["labels.read".to_owned()], Some(WriteStage::AfterSync));
    let again = ConsentStore::open(&file(&tmp));
    assert_eq!(
        verdict(&again, &e, "assets.read"),
        PermissionVerdict::Allowed
    );
    assert_eq!(
        verdict(&again, &e, "labels.read"),
        PermissionVerdict::NeedsConsent { warning: false }
    );
}
