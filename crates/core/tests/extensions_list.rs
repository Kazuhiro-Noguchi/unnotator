//! US6: 必要な拡張機能が入っていなければ、開いたときに分かる（spec.md US6、FR-037〜FR-040）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use support::{TempDir, create_and_open, create_annotation, folder_with_files, read_conn};
use unnotator_core::extensions_list::{InstalledExtension, version_satisfies};
use unnotator_core::project::ProjectStore;

fn installed(items: &[(&str, &str)]) -> Vec<InstalledExtension> {
    items
        .iter()
        .map(|(id, version)| InstalledExtension {
            id: (*id).to_owned(),
            version: (*version).to_owned(),
        })
        .collect()
}

fn opened(extensions_json: Option<&str>) -> (TempDir, ProjectStore) {
    let dir = folder_with_files(&[]);
    let mut store = create_and_open(&dir);
    if let Some(text) = extensions_json {
        std::fs::write(dir.path().join(".unnotator/extensions.json"), text).unwrap();
    }
    store.set_media_rules(support::rules_for_tests());
    (dir, store)
}

const TWO: &str = r#"{"version": 1, "extensions": [
  {"id": "com.example.a", "version": "^1.0.0"},
  {"id": "com.example.b", "version": ">=2.1.0"}
]}"#;

#[test]
fn a_missing_extension_is_listed_with_the_required_range() {
    let (_dir, store) = opened(Some(TWO));
    let check = store
        .check_extensions(&installed(&[("com.example.a", "1.4.2")]))
        .unwrap();
    assert_eq!(check.missing.len(), 1);
    assert_eq!(check.missing[0].id, "com.example.b");
    assert_eq!(check.missing[0].version, ">=2.1.0");
    assert!(check.version_mismatch.is_empty());
    assert!(check.warnings.is_empty());
}

#[test]
fn an_installed_version_outside_the_range_is_a_mismatch_with_both_versions() {
    let (_dir, store) = opened(Some(TWO));
    let check = store
        .check_extensions(&installed(&[
            ("com.example.a", "2.0.0"),
            ("com.example.b", "2.1.0"),
        ]))
        .unwrap();
    assert!(check.missing.is_empty());
    assert_eq!(check.version_mismatch.len(), 1);
    let m = &check.version_mismatch[0];
    assert_eq!(
        (m.id.as_str(), m.required.as_str(), m.installed.as_str()),
        ("com.example.a", "^1.0.0", "2.0.0")
    );
}

#[test]
fn nothing_is_missing_when_everything_fits_and_extra_installs_are_ignored() {
    let (_dir, store) = opened(Some(TWO));
    let check = store
        .check_extensions(&installed(&[
            ("com.example.a", "1.0.0"),
            ("com.example.b", "3.0.0"),
            ("com.example.unrelated", "0.0.1"),
        ]))
        .unwrap();
    assert!(
        check.missing.is_empty() && check.version_mismatch.is_empty() && check.warnings.is_empty()
    );
}

#[test]
fn no_file_means_nothing_is_required_and_no_file_is_created() {
    let (dir, store) = opened(None);
    let check = store.check_extensions(&[]).unwrap();
    assert!(
        check.missing.is_empty() && check.version_mismatch.is_empty() && check.warnings.is_empty()
    );
    assert!(!dir.path().join(".unnotator/extensions.json").exists());
}

#[test]
fn a_broken_file_is_a_warning_and_is_never_rewritten() {
    for text in [
        "{ not json",
        "[1, 2]",
        r#"{"version": 1, "extensions": "x"}"#,
        r#"{"version": 2, "extensions": []}"#,
    ] {
        let (dir, store) = opened(Some(text));
        let check = store.check_extensions(&installed(&[])).unwrap();
        assert_eq!(check.warnings.len(), 1, "{text}");
        assert!(check.missing.is_empty());
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".unnotator/extensions.json")).unwrap(),
            text,
            "書き換えない"
        );
    }
}

#[test]
fn bad_rows_and_duplicates_are_skipped_with_warnings_and_good_rows_still_count() {
    let text = r#"{"version": 1, "extensions": [
      {"id": "com.example.a", "version": "^1.0.0"},
      {"id": "com.example.a", "version": "^9.0.0"},
      {"id": "", "version": "1.0.0"},
      {"id": "com.example.c"},
      {"id": "com.example.d", "version": "banana"},
      "not an object",
      {"id": "com.example.e", "version": "*"}
    ]}"#;
    let (_dir, store) = opened(Some(text));
    let check = store.check_extensions(&installed(&[])).unwrap();
    let missing: Vec<_> = check.missing.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(missing, ["com.example.a", "com.example.e"]);
    assert_eq!(check.missing[0].version, "^1.0.0", "重複は、先の行を使う");
    assert_eq!(check.warnings.len(), 5);
}

#[test]
fn a_missing_extension_never_removes_assets_or_annotations() {
    let (dir, mut store) = opened(Some(TWO));
    store
        .scan(unnotator_core::assets::scan::ScanScope::Full)
        .unwrap();
    support::write_file(dir.path(), "a.txt", b"1");
    store
        .scan(unnotator_core::assets::scan::ScanScope::Full)
        .unwrap();
    let id = support::read_assets(dir.path())[0].id.clone();
    store.apply_command(create_annotation(&id, "{}")).unwrap();
    let check = store.check_extensions(&[]).unwrap();
    assert_eq!(check.missing.len(), 2);
    assert_eq!(support::count(&read_conn(dir.path()), "annotations"), 1);
    assert_eq!(support::count(&read_conn(dir.path()), "assets"), 1);
}

/// 0.x の範囲は semver の規則どおり（`^0.0.1` は `0.0.1` ちょうどだけ。`^0.X.0` は `0.X.y`）。
#[test]
fn caret_ranges_on_zero_versions_follow_semver() {
    let cases: &[(&str, &str, bool)] = &[
        ("^0.0.1", "0.0.1", true),
        ("^0.0.1", "0.0.2", false),
        ("^0.0.1", "0.1.0", false),
        ("^0.0.1", "1.0.0", false),
        ("^0.1.0", "0.1.0", true),
        ("^0.1.0", "0.1.7", true),
        ("^0.1.0", "0.2.0", false),
        ("^0.1.0", "0.0.9", false),
    ];
    for (range, version, expected) in cases {
        assert_eq!(
            version_satisfies(range, version),
            Some(*expected),
            "{range} vs {version}"
        );
    }
}

#[test]
fn version_ranges_are_interpreted_as_documented() {
    let cases: &[(&str, &str, bool)] = &[
        ("1.2.3", "1.2.3", true),
        ("1.2.3", "1.2.4", false),
        ("^1.2.3", "1.2.3", true),
        ("^1.2.3", "1.9.0", true),
        ("^1.2.3", "2.0.0", false),
        ("^1.2.3", "1.2.2", false),
        ("^0.2.3", "0.2.9", true),
        ("^0.2.3", "0.3.0", false),
        ("^0.0.3", "0.0.3", true),
        ("^0.0.3", "0.0.4", false),
        ("~1.2.3", "1.2.9", true),
        ("~1.2.3", "1.3.0", false),
        (">=1.2.3", "1.2.3", true),
        (">=1.2.3", "10.0.0", true),
        (">=1.2.3", "1.2.2", false),
        ("*", "0.0.1", true),
        ("1.2", "1.2.0", true),
        ("^1", "1.5.0", true),
        ("1.2.3", "1.2.3-beta.1", true),
        ("^1.0.0", "garbage", false),
    ];
    for (range, version, expected) in cases {
        assert_eq!(
            version_satisfies(range, version),
            Some(*expected),
            "{range} vs {version}"
        );
    }
    for bad in ["banana", ">1.0.0", "^", "1.2.3.4", ""] {
        assert_eq!(
            version_satisfies(bad, "1.0.0"),
            None,
            "{bad:?} は範囲として読めない"
        );
    }
}

// ---- 005: 版の比較（最新の適合版を選ぶため） ----

mod compare {
    use std::cmp::Ordering::{Equal, Greater, Less};

    use unnotator_core::extensions_list::{compare_versions, version_satisfies};

    #[test]
    fn major_minor_and_patch_are_compared_as_numbers() {
        assert_eq!(compare_versions("1.2.3", "1.2.3"), Some(Equal));
        assert_eq!(compare_versions("1.2.3", "1.2.4"), Some(Less));
        assert_eq!(compare_versions("1.10.0", "1.9.9"), Some(Greater));
        assert_eq!(compare_versions("2.0.0", "10.0.0"), Some(Less));
    }

    #[test]
    fn a_prerelease_is_older_than_its_release() {
        assert_eq!(compare_versions("1.0.0-beta.1", "1.0.0"), Some(Less));
        assert_eq!(compare_versions("1.0.0", "1.0.0-rc.1"), Some(Greater));
        assert_eq!(compare_versions("1.0.0-alpha", "1.0.0-beta"), Some(Less));
        assert_eq!(
            compare_versions("1.0.0-beta.2", "1.0.0-beta.10"),
            Some(Less)
        );
        assert_eq!(
            compare_versions("1.0.0-1", "1.0.0-alpha"),
            Some(Less),
            "数字だけの識別子は、文字を含むものより小さい"
        );
    }

    #[test]
    fn build_metadata_is_ignored() {
        assert_eq!(compare_versions("1.0.0+a", "1.0.0+b"), Some(Equal));
    }

    #[test]
    fn an_unreadable_version_has_no_order() {
        assert_eq!(
            compare_versions("1.0", "1.0.0"),
            None,
            "完全な x.y.z だけを比べる"
        );
        assert_eq!(compare_versions("abc", "1.0.0"), None);
        assert_eq!(compare_versions("1.0.0", ""), None);
    }

    #[test]
    fn the_newest_satisfying_version_can_be_picked() {
        let installed = ["1.0.0", "1.4.2", "1.10.0", "2.0.0", "1.9.9"];
        let newest = installed
            .iter()
            .filter(|v| version_satisfies("^1.0.0", v) == Some(true))
            .max_by(|a, b| compare_versions(a, b).unwrap_or(Equal));
        assert_eq!(newest, Some(&"1.10.0"));
    }
}
