//! 取り込みの途中で強制終了しても、半端な拡張機能が出ず、既存の版が壊れない（SC-003）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;
use std::process::Command;

use support::{TempDir, manifest, minimal_package, write_zip};
use unnotator_extensions::package::{CrashPoint, install_package, install_package_with_crash};
use unnotator_extensions::paths::AppPaths;
use unnotator_extensions::store::{cleanup_staging, scan_installed};

const ENV_DIR: &str = "UNNO_CRASH_DIR";
const ENV_POINT: &str = "UNNO_CRASH_POINT";

/// 子プロセスとして呼ばれたときだけ働く。取り込みの途中で、自分を強制終了する。
#[test]
fn child_installs_and_aborts() {
    let (Ok(dir), Ok(point)) = (std::env::var(ENV_DIR), std::env::var(ENV_POINT)) else {
        return;
    };
    let root = PathBuf::from(dir);
    let paths = AppPaths::new(&root.join("data"), &root.join("cache"));
    let crash = if point == "extract" {
        CrashPoint::DuringExtract
    } else {
        CrashPoint::BeforeRename
    };
    let _ = install_package_with_crash(&paths, &root.join("new.unnoplugin"), Some(crash));
    // ここに来たら、強制終了されなかった（親が失敗にする）
    std::process::exit(0);
}

fn run_once(point: &str) {
    let tmp = TempDir::new();
    let paths = AppPaths::new(&tmp.data_dir(), &tmp.cache_dir());
    let package = |version: &str, path: &std::path::Path| {
        let mut entries = minimal_package(&manifest("com.example.text", version).build());
        entries.push(support::RawEntry::file(
            "dist/extra.js",
            &vec![b'x'; 10_000],
        ));
        write_zip(path, &entries);
    };
    // 既存の 1.0.0 を入れておく
    package("1.0.0", &tmp.path().join("old.unnoplugin"));
    install_package(&paths, &tmp.path().join("old.unnoplugin")).unwrap();
    package("2.0.0", &tmp.path().join("new.unnoplugin"));

    let status = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "child_installs_and_aborts", "--nocapture"])
        .env(ENV_DIR, tmp.path())
        .env(ENV_POINT, point)
        .status()
        .unwrap();
    assert!(!status.success(), "子は強制終了するはず（{point}）");

    // 半端なものは、一覧に出ない。既存の版は残る
    let found = scan_installed(&paths).found;
    let versions: Vec<_> = found.iter().map(|r| r.version.as_str()).collect();
    assert_eq!(versions, ["1.0.0"], "{point}: {versions:?}");
    // 起動時の片付けで、作業フォルダが空になる
    cleanup_staging(&paths).unwrap();
    assert_eq!(
        std::fs::read_dir(paths.staging_dir())
            .map(|d| d.count())
            .unwrap_or(0),
        0
    );
    // 片付けのあとに、同じ版を、また入れられる
    install_package(&paths, &tmp.path().join("new.unnoplugin")).unwrap();
    assert_eq!(scan_installed(&paths).found.len(), 2);
}

#[test]
fn a_crash_during_extraction_leaves_nothing_half_installed() {
    for _ in 0..3 {
        run_once("extract");
    }
}

#[test]
fn a_crash_just_before_the_rename_leaves_nothing_half_installed() {
    for _ in 0..3 {
        run_once("rename");
    }
}

#[test]
#[ignore = "100 回の繰り返し。--ignored で実行する"]
fn a_hundred_crashes_never_leave_a_half_installed_extension() {
    for i in 0..100 {
        run_once(if i % 2 == 0 { "extract" } else { "rename" });
    }
}
