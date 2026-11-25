//! `extensions-state.json`（data-model.md）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;

use support::TempDir;
use unnotator_core::fsio::WriteStage;
use unnotator_extensions::state::ExtensionsState;

fn file(tmp: &TempDir) -> PathBuf {
    tmp.data_dir().join("extensions-state.json")
}

#[test]
fn a_missing_file_gives_the_defaults() {
    let tmp = TempDir::new();
    let state = ExtensionsState::load(&file(&tmp));
    assert!(state.disabled().is_empty());
    assert!(state.pins().is_empty());
    assert!(state.media_overrides().is_empty());
    assert!(!state.dev_mode());
    assert!(state.active_dev_folders().is_empty());
}

#[test]
fn everything_survives_a_round_trip() {
    let tmp = TempDir::new();
    let mut state = ExtensionsState::load(&file(&tmp));
    state.set_disabled("com.example.old", true);
    state.pin("com.example.text", Some("1.0.0")).unwrap();
    state
        .set_media_override(".txt", Some("com.example.text/text"))
        .unwrap();
    state.set_dev_mode(true);
    state.add_dev_folder(PathBuf::from("/work/my-ext"));
    state.save(&file(&tmp)).unwrap();

    let again = ExtensionsState::load(&file(&tmp));
    assert!(again.disabled().contains("com.example.old"));
    assert_eq!(
        again.pins().get("com.example.text").map(String::as_str),
        Some("1.0.0")
    );
    assert_eq!(
        again.media_overrides().get(".txt").map(String::as_str),
        Some("com.example.text/text")
    );
    assert!(again.dev_mode());
    assert_eq!(
        again.active_dev_folders(),
        vec![PathBuf::from("/work/my-ext")]
    );
}

#[test]
fn unknown_keys_are_kept() {
    let tmp = TempDir::new();
    std::fs::write(
        file(&tmp),
        r#"{ "version": 1, "disabled": [], "future": { "x": [1, 2] } }"#,
    )
    .unwrap();
    let mut state = ExtensionsState::load(&file(&tmp));
    state.set_disabled("com.example.a", true);
    state.save(&file(&tmp)).unwrap();
    let text = std::fs::read_to_string(file(&tmp)).unwrap();
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(json["future"]["x"][1], 2);
    assert_eq!(json["disabled"][0], "com.example.a");
}

#[test]
fn a_corrupt_file_is_set_aside_and_defaults_are_used() {
    let tmp = TempDir::new();
    std::fs::write(file(&tmp), "{ not json").unwrap();
    let state = ExtensionsState::load(&file(&tmp));
    assert!(state.disabled().is_empty());
    let moved: Vec<_> = std::fs::read_dir(tmp.data_dir())
        .unwrap()
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("extensions-state.json.corrupt-")
        })
        .collect();
    assert_eq!(moved.len(), 1, "壊れたファイルは退避される");
    assert!(!file(&tmp).exists(), "元の場所には残さない");
}

#[test]
fn an_interrupted_write_keeps_the_old_content() {
    let tmp = TempDir::new();
    let mut state = ExtensionsState::load(&file(&tmp));
    state.set_disabled("com.example.keep", true);
    state.save(&file(&tmp)).unwrap();

    state.set_disabled("com.example.new", true);
    for stage in [WriteStage::AfterWrite, WriteStage::AfterSync] {
        let _ = state.save_with_stop(&file(&tmp), Some(stage));
        let again = ExtensionsState::load(&file(&tmp));
        assert!(again.disabled().contains("com.example.keep"), "{stage:?}");
        assert!(!again.disabled().contains("com.example.new"), "{stage:?}");
    }
    let _ = state.save_with_stop(&file(&tmp), Some(WriteStage::AfterRename));
    let after = ExtensionsState::load(&file(&tmp));
    assert!(
        after.disabled().contains("com.example.new"),
        "置き換えのあとは新しい内容"
    );
}

#[test]
fn dev_folders_are_ignored_while_dev_mode_is_off() {
    let mut state = ExtensionsState::default();
    state.add_dev_folder(PathBuf::from("/work/a"));
    assert!(state.active_dev_folders().is_empty());
    assert_eq!(
        state.dev_folders(),
        vec![PathBuf::from("/work/a")],
        "記録は残る"
    );
    state.set_dev_mode(true);
    assert_eq!(state.active_dev_folders(), vec![PathBuf::from("/work/a")]);
    state.remove_dev_folder(&PathBuf::from("/work/a"));
    assert!(state.dev_folders().is_empty());
}

#[test]
fn media_overrides_are_normalized_and_checked() {
    let mut state = ExtensionsState::default();
    state
        .set_media_override("TXT", Some("com.example.text/text"))
        .unwrap();
    assert!(
        state.media_overrides().contains_key(".txt"),
        "小文字・先頭のドット付きにそろえる"
    );
    assert!(
        state.set_media_override(".a/b", Some("x.y/z")).is_err(),
        "拡張子に区切りは使えない"
    );
    assert!(
        state
            .set_media_override(".txt", Some("nonamespace"))
            .is_err(),
        "種別 ID は名前空間つき"
    );
    state.set_media_override(".txt", None).unwrap();
    assert!(state.media_overrides().is_empty());
}

#[test]
fn pins_can_be_set_and_cleared() {
    let mut state = ExtensionsState::default();
    state.pin("com.example.text", Some("1.0.0")).unwrap();
    assert!(
        state
            .pin("com.example.text", Some("not-a-version"))
            .is_err()
    );
    state.pin("com.example.text", None).unwrap();
    assert!(state.pins().is_empty());
}
