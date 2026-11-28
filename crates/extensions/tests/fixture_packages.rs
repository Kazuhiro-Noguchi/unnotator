//! 009 のテスト用の拡張機能（`scripts/make-fixture-packages.py` が作る `.unnoplugin`）が、
//! 取り込めて、走査で有効な拡張機能として読めること。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;

use support::TempDir;
use unnotator_extensions::package::install_package;
use unnotator_extensions::paths::AppPaths;
use unnotator_extensions::store::scan_installed;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/packages")
        .join(format!("{name}.unnoplugin"))
}

#[test]
fn the_009_fixture_packages_install_and_scan() {
    let tmp = TempDir::new();
    let paths = AppPaths::new(&tmp.data_dir(), &tmp.cache_dir());
    for name in ["ext-base", "ext-rect", "ext-bad"] {
        install_package(&paths, &fixture(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
    }
    let scanned = scan_installed(&paths);
    assert!(scanned.problems.is_empty(), "{:?}", scanned.problems);
    let mut ids: Vec<_> = scanned
        .found
        .iter()
        .map(|e| e.manifest.id.clone())
        .collect();
    ids.sort();
    assert_eq!(ids, ["dev.spike.bad", "dev.spike.base", "dev.spike.rect"]);
}
