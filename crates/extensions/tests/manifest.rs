//! マニフェストの検証（契約のスキーマ）と selectorSchema の妥当性（spec.md US2、SC-004）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;

use serde_json::json;
use support::manifest;
use unnotator_extensions::manifest::{parse_manifest, validate_selector_schema};
use unnotator_extensions::registry::ProblemKind;

fn fixtures(sub: &str) -> Vec<(String, Vec<u8>)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/manifests")
        .join(sub);
    let mut out: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .filter(|e| {
            e.path().extension().is_some_and(|x| x == "json") && e.file_name() != "expected.json"
        })
        .map(|e| {
            (
                e.file_name().to_string_lossy().into_owned(),
                std::fs::read(e.path()).unwrap(),
            )
        })
        .collect();
    out.sort();
    out
}

#[test]
fn every_valid_example_is_accepted() {
    let all = fixtures("valid");
    assert!(!all.is_empty());
    for (name, bytes) in all {
        let parsed = parse_manifest(&bytes);
        assert!(parsed.is_ok(), "{name}: {:?}", parsed.err());
    }
}

#[test]
fn every_invalid_example_is_refused_with_a_pointer_and_a_reason() {
    let all = fixtures("invalid");
    assert!(all.len() >= 5);
    for (name, bytes) in all {
        let problems = parse_manifest(&bytes).expect_err(&name);
        assert!(!problems.is_empty(), "{name}");
        assert!(
            problems
                .iter()
                .all(|p| p.kind == ProblemKind::ManifestSchema),
            "{name}"
        );
        assert!(problems.iter().all(|p| !p.message.is_empty()), "{name}");
    }
}

#[test]
fn a_missing_field_points_at_the_object_and_a_bad_value_points_at_the_field() {
    let missing = parse_manifest(
        br#"{ "version": "1.0.0", "engines": {"unnotator":"^1.0.0"}, "main": "dist/index.js" }"#,
    )
    .unwrap_err();
    assert_eq!(missing[0].pointer, "");
    let bad = parse_manifest(br#"{ "id": "Bad_ID", "version": "1.0.0", "engines": {"unnotator":"^1.0.0"}, "main": "dist/index.js" }"#).unwrap_err();
    assert_eq!(bad[0].pointer, "/id");
}

#[test]
fn text_that_is_not_json_is_a_problem_not_a_panic() {
    let problems = parse_manifest(b"{ nope").unwrap_err();
    assert_eq!(problems[0].kind, ProblemKind::ManifestSchema);
}

#[test]
fn a_selector_schema_must_be_a_valid_json_schema() {
    assert!(validate_selector_schema(&json!({ "type": "object", "required": ["a"], "properties": { "a": { "type": "integer" } } })).is_ok());
    assert!(validate_selector_schema(&json!({ "type": "nonsense" })).is_err());
    assert!(validate_selector_schema(&json!({ "properties": 3 })).is_err());
}

#[test]
fn a_bad_selector_schema_is_reported_at_its_place() {
    let m = manifest("com.example.a", "1.0.0")
        .media_type("t", &[".t"], &[])
        .push(
            "annotationTypes",
            json!({ "id": "span", "version": 1, "title": "s", "mediaTypes": ["t"], "selectorSchema": { "type": "nonsense" } }),
        )
        .bytes();
    let problems = parse_manifest(&m).unwrap_err();
    let p = problems
        .iter()
        .find(|p| p.kind == ProblemKind::SelectorSchema)
        .expect("selectorSchema の問題");
    assert_eq!(p.pointer, "/contributes/annotationTypes/0/selectorSchema");
}

#[test]
fn a_failure_still_reports_the_extension_id_when_it_can_be_read() {
    let problems = parse_manifest(br#"{ "id": "com.example.x", "version": "nope", "engines": {"unnotator":"^1.0.0"}, "main": "dist/index.js" }"#).unwrap_err();
    assert_eq!(problems[0].extension_id, "com.example.x");
}
