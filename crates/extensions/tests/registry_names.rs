//! 宣言の名前空間化・参照の解決・意味の確認・翻訳（spec.md US2 のシナリオ 1〜3・5・7）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;

use serde_json::{Value, json};
use support::{TempDir, manifest, write_extension};
use unnotator_extensions::manifest::Manifest;
use unnotator_extensions::manifest::text::Locales;
use unnotator_extensions::names::ContributionKind as K;
use unnotator_extensions::registry::{
    ExtensionStatus, Origin, ProblemKind, RawExtension, Registry, RegistryInput,
};
use unnotator_extensions::state::ExtensionsState;

fn raw(manifest: Value) -> RawExtension {
    RawExtension::new(
        PathBuf::from("/ext"),
        Origin::Installed,
        Manifest::from_value(manifest).unwrap(),
    )
}

fn build(extensions: &[RawExtension]) -> Registry {
    Registry::build(RegistryInput {
        installed: extensions,
        state: &ExtensionsState::default(),
        app_api_version: "0.0.1",
    })
}

fn text_extension() -> Value {
    manifest("com.example.text", "1.0.0")
        .media_type("text", &[".txt", ".md"], &["text/plain"])
        .editor("editor", &["text"])
        .annotation_type("span", &["text"])
        .tool("span.select", "editor", "span")
        .push("commands", json!({ "id": "span.clear", "title": "clear" }))
        .push(
            "keybindings",
            json!({ "key": "S", "command": "tool.activate", "args": "span.select" }),
        )
        .contrib(
            "ribbon",
            json!({
                "groups": [{
                    "tab": "home", "group": "home.tools",
                    "items": [{ "type": "largeButton", "tool": "span.select" }]
                }]
            }),
        )
        .build()
}

#[test]
fn declarations_are_reachable_by_their_qualified_names() {
    let registry = build(&[raw(text_extension())]);
    for (kind, name) in [
        (K::MediaType, "com.example.text/text"),
        (K::Editor, "com.example.text/editor"),
        (K::AnnotationType, "com.example.text/span"),
        (K::Tool, "com.example.text/span.select"),
        (K::Command, "com.example.text/span.clear"),
    ] {
        let found = registry.contribution(kind, name);
        assert!(found.is_some(), "{kind:?} {name}");
        assert_eq!(found.unwrap().extension_id, "com.example.text");
    }
    assert_eq!(registry.contributions(K::MediaType).len(), 1);
    assert!(
        registry.contribution(K::MediaType, "text").is_none(),
        "局所名では引けない"
    );
}

#[test]
fn references_are_resolved_to_full_names() {
    let registry = build(&[raw(text_extension())]);
    let resolved = registry.resolved_manifest("com.example.text").unwrap();
    let c = &resolved["contributes"];
    assert_eq!(c["editors"][0]["mediaTypes"][0], "com.example.text/text");
    assert_eq!(
        c["annotationTypes"][0]["mediaTypes"][0],
        "com.example.text/text"
    );
    assert_eq!(c["tools"][0]["editor"], "com.example.text/editor");
    assert_eq!(c["tools"][0]["annotationType"], "com.example.text/span");
    assert_eq!(
        c["ribbon"]["groups"][0]["items"][0]["tool"],
        "com.example.text/span.select"
    );
    // コアのコマンド・タブは `core/` に直る
    assert_eq!(c["keybindings"][0]["command"], "core/tool.activate");
    assert_eq!(c["ribbon"]["groups"][0]["tab"], "core/home");
    // 宣言の中の名前そのもの（`id`）は、局所名のまま
    assert_eq!(c["tools"][0]["id"], "span.select");
}

#[test]
fn a_declaration_value_keeps_its_qualified_id_next_to_the_local_one() {
    let registry = build(&[raw(text_extension())]);
    let editor = registry
        .contribution(K::Editor, "com.example.text/editor")
        .unwrap();
    assert_eq!(editor.value["id"], "editor");
    assert_eq!(editor.value["qualifiedId"], "com.example.text/editor");
    assert_eq!(editor.value["mediaTypes"][0], "com.example.text/text");
}

#[test]
fn an_unresolved_reference_invalidates_only_that_extension() {
    let broken = manifest("com.example.broken", "1.0.0")
        .editor("editor", &["ghost"])
        .build();
    let registry = build(&[raw(text_extension()), raw(broken)]);
    let entry = registry.entry("com.example.broken").unwrap();
    assert!(matches!(entry.status, ExtensionStatus::Invalid));
    let problem = registry
        .problems()
        .iter()
        .find(|p| p.extension_id == "com.example.broken")
        .unwrap();
    assert_eq!(problem.kind, ProblemKind::UnresolvedReference);
    assert_eq!(problem.pointer, "/contributes/editors/0/mediaTypes/0");
    // 他は影響を受けない
    assert!(matches!(
        registry.entry("com.example.text").unwrap().status,
        ExtensionStatus::Enabled { .. }
    ));
    assert!(
        registry
            .contribution(K::Editor, "com.example.broken/editor")
            .is_none(),
        "無効なものの宣言は載らない"
    );
}

#[test]
fn a_reference_into_an_extension_that_is_not_a_dependency_is_rejected() {
    let other = manifest("com.example.rect", "1.0.0")
        .editor("editor", &["com.example.text/text"])
        .build(); // extensionDependencies を書いていない
    let registry = build(&[raw(text_extension()), raw(other)]);
    let problem = registry
        .problems()
        .iter()
        .find(|p| p.extension_id == "com.example.rect")
        .unwrap();
    assert_eq!(problem.kind, ProblemKind::NotADependency);
    assert_eq!(
        problem.detail.as_ref().unwrap()["extension"],
        "com.example.text"
    );
}

#[test]
fn a_dependency_declaration_can_be_referenced() {
    let rect = manifest("com.example.rect", "1.0.0")
        .dep("com.example.text", "^1.0.0")
        .annotation_type("rect", &["com.example.text/text"])
        .build();
    let registry = build(&[raw(rect), raw(text_extension())]);
    assert!(matches!(
        registry.entry("com.example.rect").unwrap().status,
        ExtensionStatus::Enabled { .. }
    ));
    let resolved = registry.resolved_manifest("com.example.rect").unwrap();
    assert_eq!(
        resolved["contributes"]["annotationTypes"][0]["mediaTypes"][0],
        "com.example.text/text"
    );
}

#[test]
fn duplicate_declaration_ids_are_a_semantic_problem() {
    let dup = manifest("com.example.dup", "1.0.0")
        .media_type("text", &[".txt"], &[])
        .media_type("text", &[".md"], &[])
        .build();
    let registry = build(&[raw(dup)]);
    let problem = &registry.problems()[0];
    assert_eq!(problem.kind, ProblemKind::ManifestSemantic);
    assert_eq!(problem.pointer, "/contributes/mediaTypes/1/id");
    assert!(matches!(
        registry.entry("com.example.dup").unwrap().status,
        ExtensionStatus::Invalid
    ));
}

#[test]
fn reserved_ids_are_refused() {
    for id in ["unnotator.tool", "unnotator"] {
        let registry = build(&[raw(manifest(id, "1.0.0").build())]);
        assert_eq!(
            registry.problems()[0].kind,
            ProblemKind::ManifestSemantic,
            "{id}"
        );
        assert_eq!(registry.problems()[0].pointer, "/id");
    }
}

#[test]
fn an_item_work_unit_needs_an_item_provider() {
    let item = manifest("com.example.item", "1.0.0")
        .push(
            "mediaTypes",
            json!({ "id": "pages", "title": "pages", "extensions": [".pg"], "workUnit": "item" }),
        )
        .build();
    let registry = build(&[raw(item)]);
    let problem = &registry.problems()[0];
    assert_eq!(problem.kind, ProblemKind::ManifestSemantic);
    assert_eq!(problem.pointer, "/contributes/mediaTypes/0/itemProvider");
}

// ---- 翻訳 ----

fn with_locales(dir: &TempDir, files: &[(&str, &str)]) -> RawExtension {
    let m = manifest("com.example.text", "1.0.0")
        .display_name("%displayName%")
        .build();
    let owned: Vec<(String, Vec<u8>)> = files
        .iter()
        .map(|(n, c)| (format!("locales/{n}.json"), c.as_bytes().to_vec()))
        .collect();
    let refs: Vec<(&str, &[u8])> = owned
        .iter()
        .map(|(n, c)| (n.as_str(), c.as_slice()))
        .collect();
    let path = write_extension(dir.path(), &m, &refs);
    let (locales, warnings) = Locales::load(&path);
    RawExtension::new(path, Origin::Installed, Manifest::from_value(m).unwrap())
        .with_locales(locales, warnings)
}

#[test]
fn translation_keys_fall_back_from_the_language_to_english_to_the_key() {
    let tmp = TempDir::new();
    let ext = with_locales(
        &tmp,
        &[
            ("ja", r#"{ "displayName": "テキスト" }"#),
            (
                "en",
                r#"{ "displayName": "Text", "onlyEn": "Only English" }"#,
            ),
        ],
    );
    let registry = build(&[ext]);
    let t = |text: &str, lang: &str| registry.text("com.example.text", text, lang);
    assert_eq!(t("%displayName%", "ja"), "テキスト");
    assert_eq!(
        t("%displayName%", "ja-JP"),
        "テキスト",
        "地域つきの言語は、言語だけに丸める"
    );
    assert_eq!(t("%onlyEn%", "ja"), "Only English");
    assert_eq!(t("%nowhere%", "ja"), "nowhere");
    assert_eq!(t("そのままの文字列", "ja"), "そのままの文字列");
    assert_eq!(t("%displayName%", "fr"), "Text");
}

#[test]
fn a_broken_locale_file_is_a_warning_not_a_failure() {
    let tmp = TempDir::new();
    let ext = with_locales(
        &tmp,
        &[("ja", "{ broken"), ("en", r#"{ "displayName": "Text" }"#)],
    );
    let registry = build(&[ext]);
    assert!(matches!(
        registry.entry("com.example.text").unwrap().status,
        ExtensionStatus::Enabled { .. }
    ));
    let warn = registry
        .problems()
        .iter()
        .find(|p| p.kind == ProblemKind::Locale)
        .expect("警告が残る");
    assert_eq!(warn.extension_id, "com.example.text");
    assert_eq!(
        registry.text("com.example.text", "%displayName%", "ja"),
        "Text"
    );
}
