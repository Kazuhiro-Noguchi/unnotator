//! US3: 外部ルートと除外（spec.md US3、FR-016〜FR-019）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::{Path, PathBuf};

use serde_json::json;
use support::{
    TempDir, create_and_open, folder_with_files, read_assets, rules_for_tests, write_file,
};
use unnotator_core::assets::scan::ScanScope;
use unnotator_core::project::ProjectStore;
use unnotator_core::settings::{Layer, Source};

/// プロジェクトのフォルダの隣に、外部ルートにするフォルダを作る。
fn external(dir: &TempDir, name: &str, files: &[(&str, &str)]) -> PathBuf {
    let path = dir.path().parent().unwrap().join(name);
    for (rel, body) in files {
        write_file(&path, rel, body.as_bytes());
    }
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn opened(files: &[(&str, &str)]) -> (TempDir, ProjectStore) {
    let dir = folder_with_files(files);
    let mut store = create_and_open(&dir);
    store.set_media_rules(rules_for_tests());
    (dir, store)
}

fn roots_value(store: &ProjectStore) -> serde_json::Value {
    store
        .settings_effective("assets.externalRoots")
        .unwrap()
        .value
}

#[test]
fn files_under_an_external_root_become_assets_with_the_roots_key() {
    let (dir, mut store) = opened(&[("same.txt", "p")]);
    let raw = external(&dir, "raw", &[("x/y.txt", "abc"), ("same.txt", "e")]);
    store.set_external_root("raw", &raw).unwrap();

    let summary = store.scan(ScanScope::Full).unwrap();

    assert_eq!(summary.added, 3);
    let assets = read_assets(dir.path());
    let keyed: Vec<_> = assets
        .iter()
        .map(|a| (a.root_key.as_str(), a.rel_path.as_str()))
        .collect();
    assert_eq!(
        keyed,
        [("", "same.txt"), ("raw", "same.txt"), ("raw", "x/y.txt")]
    );
    assert_eq!(assets[2].file_size, 3);
    assert_eq!(assets[2].media_type.as_deref(), Some("test/text"));
}

#[test]
fn a_root_is_stored_relative_to_the_project_folder() {
    let (dir, mut store) = opened(&[]);
    let raw = external(&dir, "raw", &[]);
    store.set_external_root("raw", &raw).unwrap();
    assert_eq!(roots_value(&store), json!({"raw": "../raw"}));
    let e = store.settings_effective("assets.externalRoots").unwrap();
    assert_eq!(e.source, Source::Project);
    // ファイルにも、相対パスで書かれている
    let written: serde_json::Value = serde_json::from_slice(
        &std::fs::read(dir.path().join(".unnotator/settings.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(written["assets.externalRoots"], json!({"raw": "../raw"}));
}

#[test]
fn a_missing_root_makes_its_assets_missing_without_stopping_other_roots() {
    let (dir, mut store) = opened(&[("p.txt", "1")]);
    let raw = external(&dir, "raw", &[("a.txt", "1")]);
    let other = external(&dir, "other", &[("b.txt", "2")]);
    store.set_external_root("raw", &raw).unwrap();
    store.set_external_root("other", &other).unwrap();
    store.scan(ScanScope::Full).unwrap();

    let hidden = raw.with_file_name("raw-moved");
    std::fs::rename(&raw, &hidden).unwrap();
    write_file(&other, "c.txt", b"3");
    let summary = store.scan(ScanScope::Full).unwrap();

    assert_eq!(summary.went_missing, 1);
    assert_eq!(summary.miss_reasons[0].reason, "root_not_found");
    assert_eq!(summary.added, 1, "ほかのルートの走査は続く");
    let assets = read_assets(dir.path());
    assert!(assets.iter().find(|a| a.root_key == "raw").unwrap().missing);
    assert!(
        !assets
            .iter()
            .find(|a| a.rel_path == "p.txt")
            .unwrap()
            .missing
    );

    std::fs::rename(&hidden, &raw).unwrap();
    let summary = store.scan(ScanScope::Full).unwrap();
    assert_eq!(summary.restored, 1, "ルートが戻れば、自動で解消する");
    assert!(read_assets(dir.path()).iter().all(|a| !a.missing));
}

#[test]
fn removing_a_root_from_the_settings_keeps_the_rows_as_missing() {
    let (dir, mut store) = opened(&[]);
    let raw = external(&dir, "raw", &[("a.txt", "1")]);
    store.set_external_root("raw", &raw).unwrap();
    store.scan(ScanScope::Full).unwrap();
    store
        .settings_unset(Layer::Project, "assets.externalRoots")
        .unwrap();

    let summary = store.scan(ScanScope::Full).unwrap();

    assert_eq!(summary.went_missing, 1);
    assert_eq!(summary.miss_reasons[0].reason, "root_not_configured");
    let assets = read_assets(dir.path());
    assert_eq!(assets.len(), 1, "行は消さない");
    assert!(assets[0].missing);
}

#[test]
fn an_exclude_added_later_affects_only_new_files() {
    let (dir, mut store) = opened(&[]);
    let raw = external(&dir, "raw", &[("a.log", "1")]);
    store.set_external_root("raw", &raw).unwrap();
    store.scan(ScanScope::Full).unwrap();
    store
        .settings_set(Layer::Project, "assets.exclude", json!(["*.log"]))
        .unwrap();
    write_file(&raw, "b.log", b"2");
    store.scan(ScanScope::Full).unwrap();
    let paths: Vec<_> = read_assets(dir.path())
        .into_iter()
        .map(|a| a.rel_path)
        .collect();
    assert_eq!(
        paths,
        ["a.log"],
        "登録済みは残り、新しい一致ファイルは入らない"
    );
}

#[test]
fn invalid_root_settings_are_rejected_with_a_reason() {
    let (dir, mut store) = opened(&[("sub/x.txt", "1")]);
    let raw = external(&dir, "raw", &[]);
    store.set_external_root("raw", &raw).unwrap();
    let before = roots_value(&store);
    let project = dir.path().to_string_lossy().into_owned();
    let inside = dir.path().join("sub").to_string_lossy().into_owned();
    let parent = dir.path().parent().unwrap().to_string_lossy().into_owned();

    for (name, value) in [
        ("空のキー", json!({"": "../raw2"})),
        ("区切りを含むキー", json!({"a/b": "../raw2"})),
        ("プロジェクトのフォルダそのもの", json!({"p": project})),
        ("プロジェクトの中", json!({"p": inside})),
        ("プロジェクトを含む", json!({"p": parent})),
        (
            "同じ実体を指す 2 つ",
            json!({"a": "../raw", "b": "../raw/"}),
        ),
        ("重なる 2 つ", json!({"a": "../raw", "b": "../raw/deeper"})),
    ] {
        let error = store
            .settings_set(Layer::Project, "assets.externalRoots", value)
            .unwrap_err();
        assert_eq!(error.code(), "invalid_setting", "{name}");
    }
    assert_eq!(roots_value(&store), before);
}

#[test]
fn relativize_computes_paths_between_folders() {
    use unnotator_core::assets::roots::relativize;
    // Windows では、ドライブの無いパス（`/a`）は絶対パスにならないので、ドライブ付きにする
    let root = |path: &str| -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(format!("C:{path}"))
        } else {
            PathBuf::from(path)
        }
    };
    assert_eq!(
        relativize(&root("/a/b/project"), &root("/a/b/raw")),
        Some(PathBuf::from("../raw"))
    );
    assert_eq!(
        relativize(&root("/a/b"), &root("/a/b/c/d")),
        Some(PathBuf::from("c/d"))
    );
    assert_eq!(
        relativize(&root("/a/b"), &root("/a/b")),
        Some(PathBuf::from("."))
    );
    assert_eq!(
        relativize(&root("/a/b"), Path::new("relative")),
        None,
        "絶対でないものは相対化できない"
    );
}
