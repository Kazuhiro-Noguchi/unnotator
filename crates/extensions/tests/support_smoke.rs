//! テスト補助そのものの確認（細工した zip を作る道具が、期待どおりのバイト列を作ること）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use support::{RawEntry, TempDir, build_zip, manifest, write_extension};

#[test]
fn temp_dirs_do_not_collide() {
    let a = TempDir::new();
    let b = TempDir::new();
    assert_ne!(a.path(), b.path());
}

#[test]
fn the_manifest_builder_makes_the_required_fields() {
    let m = manifest("com.example.text", "1.0.0")
        .dep("com.example.base", "^1.0.0")
        .media_type("text", &[".txt"], &["text/plain"])
        .build();
    assert_eq!(m["id"], "com.example.text");
    assert_eq!(m["engines"]["unnotator"], "^1.0.0");
    assert_eq!(m["extensionDependencies"]["com.example.base"], "^1.0.0");
    assert_eq!(m["contributes"]["mediaTypes"][0]["id"], "text");
}

#[test]
fn write_extension_lays_out_id_and_version() {
    let tmp = TempDir::new();
    let m = manifest("com.example.text", "1.2.3").build();
    let dir = write_extension(tmp.path(), &m, &[("locales/en.json", b"{}")]);
    assert!(dir.ends_with("com.example.text/1.2.3"));
    assert!(dir.join("unnotator-plugin.json").is_file());
    assert!(dir.join("locales/en.json").is_file());
}

#[test]
fn a_zip_starts_with_the_local_header_and_ends_with_the_end_record() {
    let zip = build_zip(&[RawEntry::file("a.txt", b"hello"), RawEntry::dir("d")]);
    assert_eq!(&zip[..4], &0x0403_4b50_u32.to_le_bytes());
    let eocd = zip.len() - 22;
    assert_eq!(&zip[eocd..eocd + 4], &0x0605_4b50_u32.to_le_bytes());
}

#[test]
fn the_bomb_is_tiny_compared_with_what_it_declares() {
    let entry = RawEntry::zeros_bomb("big.bin", 10 * 1024 * 1024, None);
    assert!(
        entry.data.len() < 100 * 1024,
        "圧縮後 {} バイト",
        entry.data.len()
    );
    assert_eq!(entry.declared_size, Some(10 * 1024 * 1024));
}
