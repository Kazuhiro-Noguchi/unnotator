//! アプリの領域の置き場（data-model.md「ディスク上の置き場」）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::Path;

use support::TempDir;
use unnotator_extensions::paths::AppPaths;

#[test]
fn the_layout_follows_the_data_model() {
    let tmp = TempDir::new();
    let data = tmp.data_dir();
    let cache = tmp.cache_dir();
    let paths = AppPaths::new(&data, &cache);
    assert_eq!(paths.extensions_dir(), data.join("extensions"));
    assert_eq!(paths.staging_dir(), data.join("extensions/.staging"));
    assert_eq!(paths.permissions_file(), data.join("permissions.json"));
    assert_eq!(paths.state_file(), data.join("extensions-state.json"));
    assert_eq!(paths.blobs_dir(), data.join("blobs"));
    assert_eq!(paths.previews_dir(), cache.join("previews"));
}

#[test]
fn the_portable_layout_lives_next_to_the_executable() {
    let exe_dir = Path::new("/apps/unnotator");
    let paths = AppPaths::portable(exe_dir);
    assert_eq!(
        paths.extensions_dir(),
        Path::new("/apps/unnotator/data/extensions")
    );
    assert_eq!(
        paths.previews_dir(),
        Path::new("/apps/unnotator/data/cache/previews")
    );
}

#[test]
fn an_extension_dir_is_id_then_version() {
    let tmp = TempDir::new();
    let paths = AppPaths::new(&tmp.data_dir(), &tmp.cache_dir());
    let dir = paths.extension_dir("com.example.text", "1.2.3").unwrap();
    assert_eq!(dir, paths.extensions_dir().join("com.example.text/1.2.3"));
}

#[test]
fn ids_and_versions_that_could_escape_are_refused() {
    let tmp = TempDir::new();
    let paths = AppPaths::new(&tmp.data_dir(), &tmp.cache_dir());
    for bad_id in [
        "",
        "..",
        ".",
        "a/b",
        "a\\b",
        "../x",
        "com.example/..",
        "C:",
        ".hidden",
        "a b",
        "com.example.\u{0}",
    ] {
        assert!(
            paths.extension_dir(bad_id, "1.0.0").is_err(),
            "id {bad_id:?} は拒む"
        );
    }
    for bad_version in ["", "..", "1.0.0/..", "1\\0", "../..", ".1", "1.0 0"] {
        assert!(
            paths
                .extension_dir("com.example.text", bad_version)
                .is_err(),
            "version {bad_version:?} は拒む"
        );
    }
    // プレリリースとビルドは使える
    assert!(
        paths
            .extension_dir("com.example.text", "1.0.0-beta.1+build5")
            .is_ok()
    );
}
