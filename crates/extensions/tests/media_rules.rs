//! 媒体種別の判定と、アセット・extensions.json への接続（spec.md US4、research.md R11）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;

use serde_json::Value;
use support::{TempDir, manifest};
use unnotator_core::assets::scan::ScanScope;
use unnotator_core::assets::{AssetFilter, Page};
use unnotator_core::project::{OpenOutcome, ProjectStore, StoreConfig};
use unnotator_extensions::manifest::Manifest;
use unnotator_extensions::registry::{Origin, RawExtension, Registry, RegistryInput};
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
        app_api_version: "1.0.0",
    })
}

fn text_ext() -> RawExtension {
    raw(manifest("com.example.text", "1.0.0")
        .media_type("text", &[".txt", ".md"], &["text/plain"])
        .build())
}

fn classify(registry: &Registry, state: &ExtensionsState, name: &str) -> Option<String> {
    registry
        .media_rules(state)
        .classify(name)
        .map(str::to_owned)
}

#[test]
fn a_declared_extension_decides_the_media_type_case_insensitively() {
    let state = ExtensionsState::default();
    let registry = build(&[text_ext()], &state);
    assert_eq!(
        classify(&registry, &state, "a.txt").as_deref(),
        Some("com.example.text/text")
    );
    assert_eq!(
        classify(&registry, &state, "NOTES.MD").as_deref(),
        Some("com.example.text/text")
    );
    assert_eq!(
        classify(&registry, &state, "a.bin"),
        None,
        "当てはまらなければ不明"
    );
    assert_eq!(
        registry.media_rules(&state).classify_mime("text/plain"),
        Some("com.example.text/text")
    );
}

#[test]
fn compound_extensions_win_over_their_tail() {
    let state = ExtensionsState::default();
    let archive = raw(manifest("com.example.archive", "1.0.0")
        .media_type("bundle", &[".tar.gz"], &[])
        .build());
    let zipped = raw(manifest("com.example.zipped", "1.0.0")
        .media_type("gz", &[".gz"], &[])
        .build());
    let registry = build(&[zipped, archive], &state);
    assert_eq!(
        classify(&registry, &state, "a.tar.gz").as_deref(),
        Some("com.example.archive/bundle")
    );
    assert_eq!(
        classify(&registry, &state, "a.gz").as_deref(),
        Some("com.example.zipped/gz")
    );
}

#[test]
fn the_result_for_a_shared_extension_does_not_depend_on_install_order() {
    let state = ExtensionsState::default();
    let one = raw(manifest("com.example.one", "1.0.0")
        .media_type("doc", &[".dat"], &[])
        .build());
    let two = raw(manifest("com.example.two", "1.0.0")
        .media_type("doc", &[".dat"], &[])
        .build());
    let three = raw(manifest("com.example.three", "1.0.0")
        .media_type("doc", &[".dat"], &[])
        .build());
    let all = [one, two, three];
    let mut seen = std::collections::BTreeSet::new();
    for order in [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ] {
        let shuffled: Vec<_> = order.iter().map(|&i| all[i].clone()).collect();
        let registry = build(&shuffled, &state);
        seen.insert(classify(&registry, &state, "x.dat"));
    }
    assert_eq!(seen.len(), 1, "導入の順に依らず同じ結果: {seen:?}");
    // 種別 ID の昇順で先のものが勝つ
    assert_eq!(
        seen.into_iter().next().unwrap().as_deref(),
        Some("com.example.one/doc")
    );
}

#[test]
fn a_user_override_beats_the_declarations() {
    let mut state = ExtensionsState::default();
    let one = raw(manifest("com.example.one", "1.0.0")
        .media_type("doc", &[".dat"], &[])
        .build());
    let two = raw(manifest("com.example.two", "1.0.0")
        .media_type("doc", &[".dat"], &[])
        .build());
    state
        .set_media_override(".dat", Some("com.example.two/doc"))
        .unwrap();
    let registry = build(&[one, two], &state);
    assert_eq!(
        classify(&registry, &state, "x.dat").as_deref(),
        Some("com.example.two/doc")
    );
    // 存在しない種別への上書きは、無視する（宣言の結果になる）
    state
        .set_media_override(".dat", Some("com.example.ghost/doc"))
        .unwrap();
    assert_eq!(
        classify(&registry, &state, "x.dat").as_deref(),
        Some("com.example.one/doc")
    );
}

#[test]
fn disabled_or_invalid_extensions_declare_nothing() {
    let mut state = ExtensionsState::default();
    state.set_disabled("com.example.text", true);
    let registry = build(&[text_ext()], &state);
    assert_eq!(classify(&registry, &state, "a.txt"), None);
    // 依存が欠けて無効なものも
    let needy = raw(manifest("com.example.needy", "1.0.0")
        .dep("com.example.ghost", "*")
        .media_type("x", &[".nx"], &[])
        .build());
    let registry = build(&[needy], &ExtensionsState::default());
    assert_eq!(
        classify(&registry, &ExtensionsState::default(), "a.nx"),
        None
    );
}

#[test]
fn mime_rules_give_a_content_type_from_the_declarations_only() {
    let state = ExtensionsState::default();
    let registry = build(&[text_ext()], &state);
    let mime = registry.mime_rules(&state);
    assert_eq!(mime.for_file_name("a.txt"), Some("text/plain"));
    assert_eq!(
        mime.for_file_name("A.MD"),
        Some("text/plain"),
        "拡張子ごとに先頭の MIME"
    );
    assert_eq!(
        mime.for_file_name("a.zzz"),
        None,
        "宣言に無いものは None（コアは表を持たない）"
    );
}

#[test]
fn the_installed_list_feeds_the_extensions_check() {
    let state = ExtensionsState::default();
    let registry = build(&[text_ext()], &state);
    let list = registry.installed_list();
    assert_eq!(list.len(), 1);
    assert_eq!(
        (list[0].id.as_str(), list[0].version.as_str()),
        ("com.example.text", "1.0.0")
    );

    let mut disabled = ExtensionsState::default();
    disabled.set_disabled("com.example.text", true);
    let registry = build(&[text_ext()], &disabled);
    assert!(
        registry.installed_list().is_empty(),
        "使えるものだけを「入っている」とする"
    );
}

// ---- 004 との統合 ----

fn open_project(tmp: &TempDir, files: &[(&str, &str)]) -> ProjectStore {
    let folder = tmp.path().join("project");
    std::fs::create_dir_all(&folder).unwrap();
    for (rel, body) in files {
        std::fs::write(folder.join(rel), body).unwrap();
    }
    let config = || StoreConfig::new(tmp.path().join("recovery"));
    ProjectStore::create(&folder, config())
        .unwrap()
        .close(None)
        .map_err(|f| f.error)
        .unwrap();
    match ProjectStore::open(&folder, config()).unwrap() {
        OpenOutcome::Opened { store, .. } => store,
        OpenOutcome::RecoveryAvailable(_) => panic!("復元の候補が出てはいけない"),
    }
}

fn media_types(store: &ProjectStore) -> Vec<(String, Option<String>)> {
    store
        .list_assets(&AssetFilter::default(), &Page::first(100))
        .unwrap()
        .items
        .into_iter()
        .map(|a| (a.rel_path, a.media_type))
        .collect()
}

#[test]
fn installing_and_removing_an_extension_reclassifies_assets_without_touching_annotations() {
    let tmp = TempDir::new();
    let mut store = open_project(&tmp, &[("a.txt", "x"), ("b.bin", "y")]);
    let state = ExtensionsState::default();

    // 入れる前: すべて不明
    store.scan(ScanScope::Full).unwrap();
    assert!(media_types(&store).iter().all(|(_, t)| t.is_none()));

    // 入れる
    let registry = build(&[text_ext()], &state);
    store.set_media_rules(registry.media_rules(&state));
    let changed = store.reclassify_assets().unwrap();
    assert_eq!(changed, 1);
    let types = media_types(&store);
    assert_eq!(
        types[0],
        ("a.txt".to_owned(), Some("com.example.text/text".to_owned()))
    );
    assert_eq!(types[1], ("b.bin".to_owned(), None));

    // 消す（無効にする）と、不明に戻る
    let mut off = ExtensionsState::default();
    off.set_disabled("com.example.text", true);
    let registry = build(&[text_ext()], &off);
    store.set_media_rules(registry.media_rules(&off));
    assert_eq!(store.reclassify_assets().unwrap(), 1);
    assert!(media_types(&store).iter().all(|(_, t)| t.is_none()));
}

#[test]
fn the_installed_list_reveals_what_extensions_json_still_needs() {
    let tmp = TempDir::new();
    let store = open_project(&tmp, &[]);
    std::fs::write(
        tmp.path().join("project/.unnotator/extensions.json"),
        r#"{ "version": 1, "extensions": [
            { "id": "com.example.text", "version": "^2.0.0" },
            { "id": "com.example.missing", "version": "*" }
        ] }"#,
    )
    .unwrap();
    let state = ExtensionsState::default();
    let registry = build(&[text_ext()], &state);
    let check = store.check_extensions(&registry.installed_list()).unwrap();
    assert_eq!(check.missing.len(), 1);
    assert_eq!(check.missing[0].id, "com.example.missing");
    assert_eq!(check.version_mismatch.len(), 1);
    assert_eq!(check.version_mismatch[0].installed, "1.0.0");
}
