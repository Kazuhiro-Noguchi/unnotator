//! 性能の計測（SC-001・SC-005）。通常のテストでは走らせない。
//!
//! ```text
//! cargo test -p unnotator-extensions --test perf --release -- --ignored --nocapture
//! ```
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;
use std::time::Instant;

use support::{TempDir, manifest, write_extension};
use unnotator_extensions::manifest::Manifest;
use unnotator_extensions::paths::AppPaths;
use unnotator_extensions::registry::{
    ExtensionStatus, Origin, RawExtension, Registry, RegistryInput,
};
use unnotator_extensions::state::ExtensionsState;
use unnotator_extensions::store::scan_installed;

#[test]
#[ignore = "性能の計測。--ignored で実行する"]
fn resolve_a_thousand_extensions_with_dependencies() {
    // 鎖と枝: n(i) は n(i/2) に依存する木
    let raws: Vec<RawExtension> = (0..1_000)
        .map(|i| {
            let mut b = manifest(&format!("com.example.n{i:04}"), "1.0.0");
            if i > 0 {
                b = b.dep(&format!("com.example.n{:04}", i / 2), "^1.0.0");
            }
            RawExtension::new(
                PathBuf::from("/x"),
                Origin::Installed,
                Manifest::from_value(b.build()).unwrap(),
            )
        })
        .collect();
    let started = Instant::now();
    let registry = Registry::build(RegistryInput {
        installed: &raws,
        state: &ExtensionsState::default(),
        app_api_version: "1.0.0",
    });
    let took = started.elapsed().as_millis();
    let enabled = registry
        .extensions()
        .iter()
        .filter(|e| matches!(e.status, ExtensionStatus::Enabled { .. }))
        .count();
    println!("SC-005 1,000 件の依存解決と登録簿: {took} ms（基準 1,000 ms）有効 {enabled} 件");
    assert_eq!(enabled, 1_000);
    assert!(took < 1_000);
}

#[test]
#[ignore = "性能の計測。--ignored で実行する"]
fn scan_and_build_a_hundred_installed_extensions() {
    let tmp = TempDir::new();
    let paths = AppPaths::new(&tmp.data_dir(), &tmp.cache_dir());
    for i in 0..100 {
        let m = manifest(&format!("com.example.e{i:03}"), "1.0.0")
            .media_type("t", &[&format!(".e{i:03}")], &[])
            .build();
        let files: Vec<(String, Vec<u8>)> = (0..50)
            .map(|f| (format!("assets/f{f:02}.bin"), vec![0u8; 256]))
            .collect();
        let refs: Vec<(&str, &[u8])> = files
            .iter()
            .map(|(n, b)| (n.as_str(), b.as_slice()))
            .collect();
        write_extension(&paths.extensions_dir(), &m, &refs);
    }
    let started = Instant::now();
    let scanned = scan_installed(&paths);
    let scan_ms = started.elapsed().as_millis();
    let registry = Registry::build(RegistryInput {
        installed: &scanned.found,
        state: &ExtensionsState::default(),
        app_api_version: "1.0.0",
    });
    let total = started.elapsed().as_millis();
    println!(
        "SC-001 100 件（各 50 ファイル）の走査 {scan_ms} ms、登録簿まで {total} ms（基準 3,000 ms。取り込み（展開）は含まない）"
    );
    assert_eq!(registry.extensions().len(), 100);
    assert!(total < 3_000);
}
