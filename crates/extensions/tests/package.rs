//! `.unnoplugin` の取り込み: 正しいもの・細工したもの・原子性（spec.md US1、SC-002）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::{Path, PathBuf};

use support::{RawEntry, TempDir, build_zip, manifest, minimal_package, write_zip};
use unnotator_extensions::ExtensionError;
use unnotator_extensions::limits::{MAX_ENTRIES, MAX_FILE_BYTES, MAX_RATIO, MAX_TOTAL_BYTES};
use unnotator_extensions::package::{InstallOutcome, exceeds_ratio, install_package};
use unnotator_extensions::paths::AppPaths;
use unnotator_extensions::store::scan_installed;

fn setup() -> (TempDir, AppPaths) {
    let tmp = TempDir::new();
    let paths = AppPaths::new(&tmp.data_dir(), &tmp.cache_dir());
    (tmp, paths)
}

fn package_at(tmp: &TempDir, entries: &[RawEntry]) -> PathBuf {
    let path = tmp.path().join("p.unnoplugin");
    write_zip(&path, entries);
    path
}

fn good(version: &str) -> Vec<RawEntry> {
    minimal_package(&manifest("com.example.text", version).build())
}

/// 取り込みが拒まれ、`extensions/` に何も残らない（作業フォルダも空）。
fn assert_refused_and_clean(paths: &AppPaths, tmp: &TempDir, entries: &[RawEntry], why: &str) {
    let package = package_at(tmp, entries);
    let result = install_package(paths, &package);
    assert!(
        matches!(result, Err(ExtensionError::Package(_))),
        "{why}: {result:?}"
    );
    assert!(scan_installed(paths).found.is_empty(), "{why}");
    let left: Vec<_> = walk(&paths.extensions_dir());
    assert!(
        left.iter().all(|p| p.ends_with(".staging")),
        "{why}: 残ったもの {left:?}"
    );
    // 外にも書かれていない
    assert!(!tmp.path().join("evil.txt").exists(), "{why}");
    assert!(!tmp.data_dir().join("evil.txt").exists(), "{why}");
}

fn walk(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for e in entries.flatten() {
        out.push(e.path().to_string_lossy().into_owned());
        if e.path().is_dir() && !e.file_name().to_string_lossy().starts_with('.') {
            out.extend(walk(&e.path()));
        }
    }
    out
}

#[test]
fn a_good_package_is_unpacked_to_id_and_version() {
    let (tmp, paths) = setup();
    let mut entries = good("1.0.0");
    entries.push(RawEntry::file("locales/en.json", br#"{"k":"v"}"#));
    entries.push(RawEntry::dir("icons"));
    let outcome = install_package(&paths, &package_at(&tmp, &entries)).unwrap();
    assert_eq!(
        outcome,
        InstallOutcome::Installed {
            id: "com.example.text".into(),
            version: "1.0.0".into()
        }
    );
    let dir = paths.extension_dir("com.example.text", "1.0.0").unwrap();
    assert!(dir.join("unnotator-plugin.json").is_file());
    assert!(dir.join("dist/index.js").is_file());
    assert!(dir.join("locales/en.json").is_file());
    assert_eq!(scan_installed(&paths).found.len(), 1);
    assert_eq!(
        std::fs::read_dir(paths.staging_dir())
            .map(|d| d.count())
            .unwrap_or(0),
        0
    );
}

#[test]
fn the_same_version_again_is_reported_and_changes_nothing() {
    let (tmp, paths) = setup();
    install_package(&paths, &package_at(&tmp, &good("1.0.0"))).unwrap();
    let marker = paths
        .extension_dir("com.example.text", "1.0.0")
        .unwrap()
        .join("marker");
    std::fs::write(&marker, "keep").unwrap();
    let again = install_package(&paths, &package_at(&tmp, &good("1.0.0"))).unwrap();
    assert_eq!(
        again,
        InstallOutcome::AlreadyInstalled {
            id: "com.example.text".into(),
            version: "1.0.0".into()
        }
    );
    assert!(marker.is_file(), "既存を壊さない");
}

#[test]
fn another_version_sits_next_to_the_existing_one() {
    let (tmp, paths) = setup();
    install_package(&paths, &package_at(&tmp, &good("1.0.0"))).unwrap();
    install_package(&paths, &package_at(&tmp, &good("1.1.0"))).unwrap();
    assert_eq!(scan_installed(&paths).found.len(), 2);
}

#[test]
fn dangerous_entry_names_are_refused_and_leave_nothing() {
    let (tmp, paths) = setup();
    let cases: Vec<(&str, &str)> = vec![
        ("../evil.txt", "親へ出る"),
        ("a/../../evil.txt", "途中で親へ出る"),
        ("/abs/evil.txt", "絶対パス"),
        ("C:/evil.txt", "ドライブ指定"),
        ("C:\\evil.txt", "ドライブ指定（バックスラッシュ）"),
        ("a\\..\\..\\evil.txt", "バックスラッシュの区切り"),
        ("CON", "Windows の予約名"),
        ("dist/nul.txt", "Windows の予約名（拡張子つき）"),
        ("dist/aux", "Windows の予約名（途中）"),
        ("a:stream", "代替データストリーム"),
        ("dist/trailing.", "末尾のドット"),
        ("dist/trailing ", "末尾の空白"),
        ("dist/ctl\u{1}name", "制御文字"),
        ("dist//double.js", "空の成分"),
        ("./dist/x.js", "カレントの成分"),
    ];
    assert!(cases.len() >= 12);
    for (name, why) in cases {
        let mut entries = good("1.0.0");
        entries.push(RawEntry::file(name, b"x"));
        assert_refused_and_clean(&paths, &tmp, &entries, &format!("{name:?}（{why}）"));
    }
    let long = format!("dist/{}", "a".repeat(256));
    let mut entries = good("1.0.0");
    entries.push(RawEntry::file(&long, b"x"));
    assert_refused_and_clean(&paths, &tmp, &entries, "長い成分");
}

#[test]
fn links_special_files_and_collisions_are_refused() {
    let (tmp, paths) = setup();
    let mut with_link = good("1.0.0");
    with_link.push(RawEntry::symlink("dist/link", "/etc/passwd"));
    assert_refused_and_clean(&paths, &tmp, &with_link, "シンボリックリンク");

    let mut special = good("1.0.0");
    special.push(RawEntry::file("dist/fifo", b"").with_mode(0o010644));
    assert_refused_and_clean(&paths, &tmp, &special, "特殊ファイル");

    let mut dup = good("1.0.0");
    dup.push(RawEntry::file("dist/a.js", b"1"));
    dup.push(RawEntry::file("dist/a.js", b"2"));
    assert_refused_and_clean(&paths, &tmp, &dup, "重複");

    let mut case = good("1.0.0");
    case.push(RawEntry::file("dist/A.js", b"1"));
    case.push(RawEntry::file("dist/a.js", b"2"));
    assert_refused_and_clean(&paths, &tmp, &case, "大文字小文字の衝突");

    let mut nfc = good("1.0.0");
    nfc.push(RawEntry::file("dist/\u{e9}.js", b"1"));
    nfc.push(RawEntry::file("dist/e\u{301}.js", b"2"));
    assert_refused_and_clean(&paths, &tmp, &nfc, "NFC の衝突");

    let mut clash = good("1.0.0");
    clash.push(RawEntry::file("dist/x", b"1"));
    clash.push(RawEntry::file("dist/x/y.js", b"2"));
    assert_refused_and_clean(&paths, &tmp, &clash, "ファイルとフォルダの同名");
}

#[test]
fn size_and_count_limits_stop_bombs_before_they_fill_the_disk() {
    let (tmp, paths) = setup();
    let mut big = good("1.0.0");
    big.push(RawEntry::zeros_bomb(
        "dist/big.bin",
        MAX_FILE_BYTES + 1,
        None,
    ));
    assert_refused_and_clean(&paths, &tmp, &big, "単体の上限");

    // 宣言を偽る（小さく見せて、実際は大きい）
    let mut lie = good("1.0.0");
    lie.push(RawEntry::zeros_bomb(
        "dist/lie.bin",
        MAX_FILE_BYTES + 1,
        Some(10),
    ));
    assert_refused_and_clean(&paths, &tmp, &lie, "宣言を偽る");

    let mut total = good("1.0.0");
    for i in 0..5 {
        total.push(RawEntry::zeros_bomb(
            &format!("dist/p{i}.bin"),
            MAX_TOTAL_BYTES / 4,
            None,
        ));
    }
    assert_refused_and_clean(&paths, &tmp, &total, "合計の上限");

    let mut many = good("1.0.0");
    for i in 0..=MAX_ENTRIES {
        many.push(RawEntry::file(&format!("dist/f{i}.txt"), b""));
    }
    assert_refused_and_clean(&paths, &tmp, &many, "エントリ数の上限");
}

#[test]
fn the_ratio_rule_ignores_small_files_and_stops_dense_ones() {
    assert!(!exceeds_ratio(10, 1024 * 1024), "1 MiB までは率を見ない");
    assert!(
        exceeds_ratio(1_000, 1_000 * (MAX_RATIO + 1)) || 1_000 * (MAX_RATIO + 1) <= 1024 * 1024
    );
    assert!(exceeds_ratio(
        1024,
        1024 * (MAX_RATIO + 1) + 5 * 1024 * 1024
    ));
    assert!(!exceeds_ratio(1024 * 1024, 100 * 1024 * 1024));
}

#[test]
fn broken_packages_are_refused() {
    let (tmp, paths) = setup();
    assert_refused_and_clean(
        &paths,
        &tmp,
        &[RawEntry::file("dist/index.js", b"x")],
        "マニフェスト無し",
    );
    assert_refused_and_clean(
        &paths,
        &tmp,
        &[RawEntry::file("unnotator-plugin.json", b"{ nope")],
        "壊れたマニフェスト",
    );
    assert_refused_and_clean(
        &paths,
        &tmp,
        &minimal_package(&serde_json::json!({ "id": "Bad_ID", "version": "1.0.0" })),
        "スキーマ違反",
    );
    let not_zip = tmp.path().join("x.unnoplugin");
    std::fs::write(&not_zip, b"this is not a zip").unwrap();
    assert!(matches!(
        install_package(&paths, &not_zip),
        Err(ExtensionError::Package(_))
    ));
    assert!(install_package(&paths, &tmp.path().join("nothing.unnoplugin")).is_err());
    let _ = build_zip(&[]);
}
