//! US5: 設定がユーザーとプロジェクトの 2 段で効き、プロジェクトが優先される（spec.md US5、FR-027〜FR-036）。

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::sync::{Arc, Mutex};

use serde_json::json;
use support::{
    TempDir, create_and_open, folder_with_files, read_assets, user_settings_dir, write_file,
};
use unnotator_core::assets::scan::ScanScope;
use unnotator_core::fsio::WriteStage;
use unnotator_core::settings::keys::CORE_KEYS;
use unnotator_core::settings::{Layer, Settings, SettingsChanged, Source};

fn project_file(dir: &TempDir) -> std::path::PathBuf {
    dir.path().join(".unnotator/settings.json")
}

fn opened_with_user(
    files: &[(&str, &str)],
) -> (
    TempDir,
    unnotator_core::project::ProjectStore,
    std::path::PathBuf,
) {
    let dir = folder_with_files(files);
    let mut store = create_and_open(&dir);
    let user = user_settings_dir(&dir);
    store.attach_user_settings(&user);
    (dir, store, user.join("settings.json"))
}

#[test]
fn the_core_key_table_has_the_documented_names_types_and_defaults() {
    let names: Vec<_> = CORE_KEYS.iter().map(|k| k.name).collect();
    assert_eq!(
        names,
        [
            "assets.exclude",
            "assets.externalRoots",
            "assets.followSymlinks",
            "assets.watch",
            // 画面の設定（006）。
            "ui.theme",
            "ui.language",
            "ui.layout",
            "ui.quickAccess",
            "ui.keybindings",
            "ui.recentProjects"
        ]
    );
    let (_dir, store, _) = opened_with_user(&[]);
    let exclude = store.settings_effective("assets.exclude").unwrap();
    assert_eq!(exclude.source, Source::Default);
    assert!(
        exclude
            .value
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == ".DS_Store")
    );
    assert_eq!(
        store
            .settings_effective("assets.externalRoots")
            .unwrap()
            .value,
        json!({})
    );
    assert_eq!(
        store
            .settings_effective("assets.followSymlinks")
            .unwrap()
            .value,
        json!(false)
    );
    assert_eq!(
        store.settings_effective("assets.watch").unwrap().value,
        json!(true)
    );
}

#[test]
fn the_project_value_wins_over_the_user_value_and_unset_falls_back() {
    let (_dir, mut store, _) = opened_with_user(&[]);
    store
        .settings_set(Layer::User, "assets.watch", json!(false))
        .unwrap();
    let e = store.settings_effective("assets.watch").unwrap();
    assert_eq!((e.value.clone(), e.source), (json!(false), Source::User));

    store
        .settings_set(Layer::Project, "assets.watch", json!(true))
        .unwrap();
    let e = store.settings_effective("assets.watch").unwrap();
    assert_eq!((e.value.clone(), e.source), (json!(true), Source::Project));

    store
        .settings_unset(Layer::Project, "assets.watch")
        .unwrap();
    let e = store.settings_effective("assets.watch").unwrap();
    assert_eq!((e.value, e.source), (json!(false), Source::User));

    store.settings_unset(Layer::User, "assets.watch").unwrap();
    assert_eq!(
        store.settings_effective("assets.watch").unwrap().source,
        Source::Default
    );
}

#[test]
fn a_change_is_written_at_once_and_is_neither_undoable_nor_unsaved() {
    let (dir, mut store, user_file) = opened_with_user(&[]);
    let undo_before = store.undo_state();
    store
        .settings_set(Layer::Project, "assets.watch", json!(false))
        .unwrap();
    store
        .settings_set(Layer::User, "assets.watch", json!(true))
        .unwrap();

    let written: serde_json::Value =
        serde_json::from_slice(&std::fs::read(project_file(&dir)).unwrap()).unwrap();
    assert_eq!(written, json!({"assets.watch": false}));
    assert!(user_file.is_file());
    assert_eq!(store.save_state().unsaved_count, 0);
    assert!(!store.save_state().dirty);
    assert_eq!(store.undo_state(), undo_before);
    assert!(support::journal_entries(dir.path()).is_empty());
}

#[test]
fn unknown_and_extension_keys_are_kept_through_read_modify_write() {
    let (dir, mut store, _) = opened_with_user(&[]);
    std::fs::write(
        project_file(&dir),
        r#"{"com.example.theme": {"wide": true}, "future.key": [1, 2]}"#,
    )
    .unwrap();
    store.settings_reload().unwrap();
    store
        .settings_set(Layer::Project, "assets.watch", json!(false))
        .unwrap();
    store
        .settings_set(Layer::Project, "com.example.other", json!("x"))
        .unwrap();

    let written: serde_json::Value =
        serde_json::from_slice(&std::fs::read(project_file(&dir)).unwrap()).unwrap();
    assert_eq!(written["com.example.theme"], json!({"wide": true}));
    assert_eq!(written["future.key"], json!([1, 2]));
    assert_eq!(written["assets.watch"], json!(false));
    assert_eq!(written["com.example.other"], json!("x"));
    // 拡張機能のキーは、拡張機能が入っていなくても読める
    assert_eq!(
        store.settings_effective("com.example.theme").unwrap().value,
        json!({"wide": true})
    );
}

#[test]
fn a_broken_file_is_not_overwritten_until_a_write_and_then_it_is_moved_aside() {
    let (dir, mut store, _) = opened_with_user(&[]);
    std::fs::write(project_file(&dir), "{ not json").unwrap();
    store.settings_reload().unwrap();

    assert_eq!(store.settings_warnings().len(), 1);
    assert_eq!(
        store.settings_effective("assets.watch").unwrap().source,
        Source::Default
    );
    assert_eq!(
        std::fs::read_to_string(project_file(&dir)).unwrap(),
        "{ not json"
    );

    store
        .settings_set(Layer::Project, "assets.watch", json!(false))
        .unwrap();
    let moved: Vec<_> = std::fs::read_dir(dir.path().join(".unnotator"))
        .unwrap()
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("settings.json.corrupt-")
        })
        .collect();
    assert_eq!(moved.len(), 1);
    assert_eq!(
        std::fs::read_to_string(moved[0].path()).unwrap(),
        "{ not json"
    );
    assert!(store.settings_warnings().is_empty());
}

#[test]
fn invalid_values_are_rejected_and_the_existing_value_is_unchanged() {
    let (dir, mut store, _) = opened_with_user(&[]);
    store
        .settings_set(Layer::Project, "assets.exclude", json!(["*.bak"]))
        .unwrap();
    let before = std::fs::read(project_file(&dir)).unwrap();

    for (key, value) in [
        ("assets.exclude", json!([1, 2])),
        ("assets.exclude", json!("*.bak")),
        ("assets.exclude", json!([""])),
        ("assets.externalRoots", json!([])),
        ("assets.externalRoots", json!({"a": 1})),
        ("assets.watch", json!("yes")),
        ("assets.nope", json!(true)), // コアの領域の、知らない項目
        ("", json!(1)),
    ] {
        let error = store.settings_set(Layer::Project, key, value).unwrap_err();
        assert_eq!(error.code(), "invalid_setting", "{key}");
    }
    assert_eq!(std::fs::read(project_file(&dir)).unwrap(), before);
    assert_eq!(
        store.settings_effective("assets.exclude").unwrap().value,
        json!(["*.bak"])
    );
}

#[test]
fn a_bad_value_on_disk_is_ignored_in_favour_of_the_lower_layer() {
    let (dir, mut store, _) = opened_with_user(&[]);
    store
        .settings_set(Layer::User, "assets.watch", json!(false))
        .unwrap();
    std::fs::write(project_file(&dir), r#"{"assets.watch": "maybe"}"#).unwrap();
    store.settings_reload().unwrap();
    let e = store.settings_effective("assets.watch").unwrap();
    assert_eq!((e.value, e.source), (json!(false), Source::User));
    assert!(
        store
            .settings_warnings()
            .iter()
            .any(|w| w.why.contains("assets.watch"))
    );
}

#[test]
fn external_changes_are_picked_up_but_our_own_writes_are_not_reported_twice() {
    let (dir, mut store, _) = opened_with_user(&[]);
    let seen: Arc<Mutex<Vec<SettingsChanged>>> = Arc::default();
    let sink = Arc::clone(&seen);
    store.settings_subscribe(Box::new(move |c| sink.lock().unwrap().push(c.clone())));

    store
        .settings_set(Layer::Project, "assets.watch", json!(false))
        .unwrap();
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert_eq!(seen.lock().unwrap()[0].keys, ["assets.watch"]);
    // 自分の書き込みのあとの読み直しは、何も報せない
    assert!(store.settings_reload().unwrap().is_empty());
    assert_eq!(seen.lock().unwrap().len(), 1);

    // 別のプログラムが書き換えた
    std::fs::write(
        project_file(&dir),
        r#"{"assets.watch": true, "com.example.x": 1}"#,
    )
    .unwrap();
    let changed = store.settings_reload().unwrap();
    assert_eq!(changed, ["assets.watch", "com.example.x"]);
    assert_eq!(seen.lock().unwrap().len(), 2);
    assert_eq!(
        store.settings_effective("assets.watch").unwrap().value,
        json!(true)
    );
    assert!(store.settings_reload().unwrap().is_empty());
}

#[test]
fn the_project_layer_refuses_writes_without_the_lock_but_the_user_layer_works() {
    let dir = TempDir::new();
    let user = user_settings_dir(&dir);
    let mut settings = Settings::new(
        Some(user.join("settings.json")),
        Some((dir.path().join("p.json"), false)),
    );
    assert_eq!(
        settings
            .set(Layer::Project, "assets.watch", json!(false))
            .unwrap_err()
            .code(),
        "read_only"
    );
    assert!(!dir.path().join("p.json").exists());
    settings
        .set(Layer::User, "assets.watch", json!(false))
        .unwrap();
}

#[test]
fn user_settings_work_without_any_project() {
    let dir = TempDir::new();
    let user = user_settings_dir(&dir);
    let mut settings = Settings::open_user(&user);
    settings
        .set(Layer::User, "assets.watch", json!(false))
        .unwrap();
    assert_eq!(
        settings.effective("assets.watch").unwrap().source,
        Source::User
    );
    assert_eq!(
        settings
            .set(Layer::Project, "assets.watch", json!(true))
            .unwrap_err()
            .code(),
        "not_open"
    );
    let again = Settings::open_user(&user);
    assert_eq!(again.effective("assets.watch").unwrap().value, json!(false));
}

#[test]
fn stopping_a_write_midway_leaves_the_old_or_the_new_settings_whole() {
    let dir = TempDir::new();
    let user = user_settings_dir(&dir);
    for stage in [
        WriteStage::AfterWrite,
        WriteStage::AfterSync,
        WriteStage::AfterRename,
    ] {
        let mut settings = Settings::open_user(&user);
        settings
            .set(Layer::User, "assets.watch", json!(true))
            .unwrap();
        let result = settings.set_with_stop(Layer::User, "assets.watch", json!(false), stage);
        assert!(result.is_err());
        let after = Settings::open_user(&user);
        assert!(after.warnings().is_empty(), "{stage:?}");
        let expected = if stage == WriteStage::AfterRename {
            json!(false)
        } else {
            json!(true)
        };
        assert_eq!(
            after.effective("assets.watch").unwrap().value,
            expected,
            "{stage:?}"
        );
    }
}

#[test]
fn the_exclude_setting_drives_the_scan() {
    let (dir, mut store, _) = opened_with_user(&[("a.txt", "1"), ("b.bak", "2"), ("c.log", "3")]);
    store
        .settings_set(Layer::User, "assets.exclude", json!(["*.log"]))
        .unwrap();
    store
        .settings_set(Layer::Project, "assets.exclude", json!(["*.bak"]))
        .unwrap();
    store.scan(ScanScope::Full).unwrap();
    let paths: Vec<_> = read_assets(dir.path())
        .into_iter()
        .map(|a| a.rel_path)
        .collect();
    assert_eq!(paths, ["a.txt", "c.log"], "プロジェクトの値だけが効く");

    store
        .settings_unset(Layer::Project, "assets.exclude")
        .unwrap();
    store.scan(ScanScope::Full).unwrap();
    let paths: Vec<_> = read_assets(dir.path())
        .into_iter()
        .map(|a| a.rel_path)
        .collect();
    assert!(
        paths.contains(&"b.bak".to_owned()),
        "プロジェクトの値を消すと、ユーザーの値が効く"
    );
    // 登録済みの c.log は、除外に一致するようになっても残る（新規にだけ効く）
    assert!(paths.contains(&"c.log".to_owned()));
    write_file(dir.path(), "d.log", b"4");
    store.scan(ScanScope::Full).unwrap();
    let paths: Vec<_> = read_assets(dir.path())
        .into_iter()
        .map(|a| a.rel_path)
        .collect();
    assert!(
        !paths.contains(&"d.log".to_owned()),
        "ユーザーの除外が、新しいファイルに効く"
    );
}
