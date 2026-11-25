//! 名前空間つきの名前と、参照の解決（spec.md US2、research.md R5）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;
use unnotator_extensions::MANIFEST_SCHEMA;
use unnotator_extensions::names::{
    ContributionKind, QualifiedId, REF_PLACES, RefContext, RefError, normalize_pointer, qualify,
    resolve_ref,
};

fn deps(ids: &[&str]) -> BTreeSet<String> {
    ids.iter().map(|s| (*s).to_owned()).collect()
}

/// `declared` に、完全な名前（`<id>/<名前>`）だけを並べる。
fn resolve(
    raw: &str,
    kind: ContributionKind,
    core_fallback: bool,
    own: &str,
    dependencies: &[&str],
    declared: &[&str],
) -> Result<String, RefError> {
    let dependencies = deps(dependencies);
    let set: BTreeSet<String> = declared.iter().map(|s| (*s).to_owned()).collect();
    let exists = move |_: ContributionKind, name: &str| set.contains(name);
    let ctx = RefContext {
        own_id: own,
        dependencies: &dependencies,
        declared: &exists,
    };
    resolve_ref(raw, kind, core_fallback, &ctx)
}

#[test]
fn a_qualified_id_is_parsed_and_formatted() {
    let id = QualifiedId::parse("com.example.text/span").unwrap();
    assert_eq!(id.extension(), "com.example.text");
    assert_eq!(id.name(), "span");
    assert_eq!(id.to_string(), "com.example.text/span");
    assert_eq!(qualify("com.example.text", "span"), "com.example.text/span");
    assert!(
        QualifiedId::parse("span").is_none(),
        "局所名は完全な名前ではない"
    );
    assert!(QualifiedId::parse("a/b/c").is_none());
    assert!(QualifiedId::parse("/b").is_none());
    assert!(QualifiedId::parse("a/").is_none());
    assert!(QualifiedId::parse("core/classification").unwrap().is_core());
}

#[test]
fn a_local_name_becomes_the_full_name_of_its_own_declaration() {
    let got = resolve(
        "text",
        ContributionKind::MediaType,
        false,
        "com.example.text",
        &[],
        &["com.example.text/text"],
    );
    assert_eq!(got.unwrap(), "com.example.text/text");
}

#[test]
fn own_and_dependency_qualified_names_pass() {
    let own = resolve(
        "com.example.text/text",
        ContributionKind::MediaType,
        false,
        "com.example.text",
        &[],
        &["com.example.text/text"],
    );
    assert_eq!(own.unwrap(), "com.example.text/text");
    let dep = resolve(
        "com.example.image/image",
        ContributionKind::MediaType,
        false,
        "com.example.rect",
        &["com.example.image"],
        &["com.example.image/image"],
    );
    assert_eq!(dep.unwrap(), "com.example.image/image");
}

#[test]
fn an_extension_that_is_not_a_dependency_is_rejected() {
    let got = resolve(
        "com.example.image/image",
        ContributionKind::MediaType,
        false,
        "com.example.rect",
        &[],
        &["com.example.image/image"],
    );
    assert_eq!(
        got.unwrap_err(),
        RefError::NotADependency {
            extension: "com.example.image".to_owned()
        }
    );
}

#[test]
fn a_name_nobody_declared_is_unresolved() {
    let local = resolve(
        "ghost",
        ContributionKind::Editor,
        false,
        "com.example.text",
        &[],
        &[],
    );
    assert!(matches!(local, Err(RefError::Unresolved { .. })));
    // 依存先ではあるが、そこに宣言が無い
    let in_dep = resolve(
        "com.example.image/ghost",
        ContributionKind::Editor,
        false,
        "com.example.rect",
        &["com.example.image"],
        &[],
    );
    assert!(matches!(in_dep, Err(RefError::Unresolved { .. })));
}

#[test]
fn a_core_name_passes_and_core_fallback_applies_only_where_allowed() {
    // `core/…` はそのまま通す（表への照合は 008 以降）
    let core = resolve(
        "core/classification",
        ContributionKind::AnnotationType,
        false,
        "com.example.text",
        &[],
        &[],
    );
    assert_eq!(core.unwrap(), "core/classification");
    // コマンド・タブは、自分に無ければコアのものとみなす（`tool.activate` など）
    let command = resolve(
        "tool.activate",
        ContributionKind::Command,
        true,
        "com.example.text",
        &[],
        &[],
    );
    assert_eq!(command.unwrap(), "core/tool.activate");
    // 自分に宣言があれば、そちらが先
    let own = resolve(
        "tool.activate",
        ContributionKind::Command,
        true,
        "com.example.text",
        &[],
        &["com.example.text/tool.activate"],
    );
    assert_eq!(own.unwrap(), "com.example.text/tool.activate");
    // フォールバックの無い種類では、未解決
    let strict = resolve(
        "tool.activate",
        ContributionKind::Tool,
        false,
        "com.example.text",
        &[],
        &[],
    );
    assert!(matches!(strict, Err(RefError::Unresolved { .. })));
}

#[test]
fn pointers_are_normalized_for_lookup() {
    assert_eq!(
        normalize_pointer("/contributes/tools/3/editor"),
        "/contributes/tools/*/editor"
    );
    assert_eq!(
        normalize_pointer("/contributes/ribbon/groups/0/items/2/items/1/command"),
        "/contributes/ribbon/groups/*/items/*/command",
        "入れ子の items は 1 段にまとめる"
    );
    assert_eq!(normalize_pointer("/id"), "/id");
}

/// スキーマを歩いて、`$ref: #/$defs/ref` の出現箇所を集める。
fn discover_ref_places() -> BTreeSet<String> {
    fn walk(
        node: &Value,
        pattern: &str,
        defs: &BTreeMap<String, Value>,
        seen: &mut BTreeSet<(String, String)>,
        found: &mut BTreeSet<String>,
    ) {
        let Some(obj) = node.as_object() else { return };
        if let Some(target) = obj.get("$ref").and_then(Value::as_str) {
            let name = target.rsplit('/').next().unwrap_or_default().to_owned();
            if name == "ref" {
                found.insert(normalize_pointer(pattern));
                return;
            }
            let key = (name.clone(), normalize_pointer(pattern));
            if !seen.insert(key) {
                return;
            }
            if let Some(def) = defs.get(&name) {
                walk(def, pattern, defs, seen, found);
            }
            return;
        }
        for key in ["oneOf", "anyOf", "allOf"] {
            if let Some(list) = obj.get(key).and_then(Value::as_array) {
                for sub in list {
                    walk(sub, pattern, defs, seen, found);
                }
            }
        }
        for key in ["if", "then", "else"] {
            if let Some(sub) = obj.get(key) {
                walk(sub, pattern, defs, seen, found);
            }
        }
        if let Some(props) = obj.get("properties").and_then(Value::as_object) {
            for (name, sub) in props {
                walk(sub, &format!("{pattern}/{name}"), defs, seen, found);
            }
        }
        if let Some(items) = obj.get("items") {
            walk(items, &format!("{pattern}/0"), defs, seen, found);
        }
        if let Some(extra) = obj.get("additionalProperties").filter(|v| v.is_object()) {
            walk(extra, &format!("{pattern}/0"), defs, seen, found);
        }
    }

    let schema: Value = serde_json::from_str(MANIFEST_SCHEMA).unwrap();
    let defs: BTreeMap<String, Value> = schema["$defs"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let mut found = BTreeSet::new();
    walk(&schema, "", &defs, &mut BTreeSet::new(), &mut found);
    found
}

#[test]
fn the_reference_table_covers_every_ref_in_the_schema() {
    let discovered = discover_ref_places();
    let table: BTreeSet<String> = REF_PLACES.iter().map(|p| p.pattern.to_owned()).collect();
    assert!(!discovered.is_empty());
    let missing: Vec<_> = discovered.difference(&table).collect();
    let extra: Vec<_> = table.difference(&discovered).collect();
    assert!(
        missing.is_empty(),
        "スキーマにあるのに表に無い参照の場所: {missing:#?}"
    );
    assert!(
        extra.is_empty(),
        "表にあるのにスキーマに無い参照の場所: {extra:#?}"
    );
}
