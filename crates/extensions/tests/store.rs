//! 導入済みの走査・削除・作業フォルダの片付け（zip は使わない）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use support::{TempDir, manifest, write_extension};
use unnotator_extensions::paths::AppPaths;
use unnotator_extensions::registry::{Origin, ProblemKind};
use unnotator_extensions::store::{cleanup_staging, remove_extension, scan_installed};

fn setup() -> (TempDir, AppPaths) {
    let tmp = TempDir::new();
    let paths = AppPaths::new(&tmp.data_dir(), &tmp.cache_dir());
    std::fs::create_dir_all(paths.extensions_dir()).unwrap();
    (tmp, paths)
}

#[test]
fn installed_folders_become_extensions_and_versions_sit_side_by_side() {
    let (_tmp, paths) = setup();
    let root = paths.extensions_dir();
    write_extension(
        &root,
        &manifest("com.example.a", "1.0.0").build(),
        &[("locales/en.json", br#"{"k":"v"}"#)],
    );
    write_extension(&root, &manifest("com.example.a", "1.1.0").build(), &[]);
    write_extension(&root, &manifest("com.example.b", "2.0.0").build(), &[]);
    let scanned = scan_installed(&paths);
    assert!(scanned.problems.is_empty(), "{:?}", scanned.problems);
    let mut ids: Vec<_> = scanned
        .found
        .iter()
        .map(|r| format!("{}@{}", r.id, r.version))
        .collect();
    ids.sort();
    assert_eq!(
        ids,
        [
            "com.example.a@1.0.0",
            "com.example.a@1.1.0",
            "com.example.b@2.0.0"
        ]
    );
    assert!(scanned.found.iter().all(|r| r.origin == Origin::Installed));
    let a1 = scanned
        .found
        .iter()
        .find(|r| r.version == "1.0.0" && r.id == "com.example.a")
        .unwrap();
    assert_eq!(a1.dir, root.join("com.example.a/1.0.0"));
    assert_eq!(a1.locales.resolve("%k%", "en"), "v", "locales も読む");
}

#[test]
fn staging_and_hidden_folders_are_not_extensions() {
    let (_tmp, paths) = setup();
    std::fs::create_dir_all(paths.staging_dir().join("half-done/x")).unwrap();
    write_extension(
        &paths.extensions_dir(),
        &manifest("com.example.a", "1.0.0").build(),
        &[],
    );
    let scanned = scan_installed(&paths);
    assert_eq!(scanned.found.len(), 1);
    assert!(scanned.problems.is_empty());
}

#[test]
fn a_broken_or_mismatched_manifest_is_a_problem_not_a_crash() {
    let (_tmp, paths) = setup();
    let root = paths.extensions_dir();
    std::fs::create_dir_all(root.join("com.example.broken/1.0.0")).unwrap();
    std::fs::write(
        root.join("com.example.broken/1.0.0/unnotator-plugin.json"),
        "{ nope",
    )
    .unwrap();
    std::fs::create_dir_all(root.join("com.example.empty/1.0.0")).unwrap();
    // フォルダ名と、マニフェストの ID・版が食い違う
    let liar = manifest("com.example.other", "9.9.9").build();
    let dir = write_extension(&root, &liar, &[]);
    std::fs::create_dir_all(root.join("com.example.liar")).unwrap();
    std::fs::rename(&dir, root.join("com.example.liar/1.0.0")).unwrap();
    write_extension(&root, &manifest("com.example.good", "1.0.0").build(), &[]);
    let scanned = scan_installed(&paths);
    assert_eq!(scanned.found.len(), 1);
    assert_eq!(scanned.found[0].id, "com.example.good");
    assert_eq!(scanned.problems.len(), 3);
    assert!(
        scanned.problems.iter().any(
            |p| p.kind == ProblemKind::ManifestSemantic && p.extension_id == "com.example.liar"
        )
    );
}

#[test]
fn removing_a_version_or_everything_leaves_other_versions_alone() {
    let (_tmp, paths) = setup();
    let root = paths.extensions_dir();
    write_extension(&root, &manifest("com.example.a", "1.0.0").build(), &[]);
    write_extension(&root, &manifest("com.example.a", "2.0.0").build(), &[]);
    write_extension(&root, &manifest("com.example.b", "1.0.0").build(), &[]);
    remove_extension(&paths, "com.example.a", Some("1.0.0")).unwrap();
    assert!(!root.join("com.example.a/1.0.0").exists());
    assert!(root.join("com.example.a/2.0.0").is_dir());
    remove_extension(&paths, "com.example.a", None).unwrap();
    assert!(!root.join("com.example.a").exists());
    assert!(root.join("com.example.b/1.0.0").is_dir());
    assert!(
        remove_extension(&paths, "com.example.zzz", None).is_err(),
        "無いものは NotFound"
    );
    assert!(remove_extension(&paths, "../x", None).is_err());
    assert!(remove_extension(&paths, "com.example.b", Some("../..")).is_err());
}

#[test]
fn cleanup_empties_the_staging_folder_only() {
    let (_tmp, paths) = setup();
    std::fs::create_dir_all(paths.staging_dir().join("t1/dist")).unwrap();
    std::fs::write(paths.staging_dir().join("t1/dist/index.js"), "x").unwrap();
    std::fs::write(paths.staging_dir().join("stray.tmp"), "x").unwrap();
    write_extension(
        &paths.extensions_dir(),
        &manifest("com.example.a", "1.0.0").build(),
        &[],
    );
    cleanup_staging(&paths).unwrap();
    assert_eq!(std::fs::read_dir(paths.staging_dir()).unwrap().count(), 0);
    assert!(paths.extensions_dir().join("com.example.a/1.0.0").is_dir());
    cleanup_staging(&paths).unwrap(); // 無くても、何度でも
}
