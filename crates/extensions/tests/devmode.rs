//! 開発者モード（spec.md US7、research.md R8）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use support::{TempDir, manifest, write_extension};
use unnotator_extensions::ExtensionError;
use unnotator_extensions::devmode::{DevWatcher, load_active_folders, load_dev_folder};
use unnotator_extensions::manifest::Manifest;
use unnotator_extensions::registry::{
    ExtensionStatus, Origin, RawExtension, Registry, RegistryInput,
};
use unnotator_extensions::state::ExtensionsState;

fn dev_folder(tmp: &TempDir, id: &str, version: &str) -> PathBuf {
    let root = tmp.path().join("dev");
    write_extension(
        &root,
        &manifest(id, version).media_type("t", &[".t"], &[]).build(),
        &[],
    )
}

fn dev_state(folder: &Path, on: bool) -> ExtensionsState {
    let mut state = ExtensionsState::default();
    state.add_dev_folder(folder.to_owned());
    state.set_dev_mode(on);
    state
}

fn registry(raws: &[RawExtension], state: &ExtensionsState) -> Registry {
    Registry::build(RegistryInput {
        installed: raws,
        state,
        app_api_version: "1.0.0",
    })
}

fn installed(id: &str, version: &str) -> RawExtension {
    RawExtension::new(
        PathBuf::from("/installed"),
        Origin::Installed,
        Manifest::from_value(manifest(id, version).build()).unwrap(),
    )
}

#[test]
fn nothing_is_loaded_while_dev_mode_is_off() {
    let tmp = TempDir::new();
    let folder = dev_folder(&tmp, "com.example.dev", "0.1.0");
    let state = dev_state(&folder, false);
    assert!(matches!(
        load_dev_folder(&state, &folder),
        Err(ExtensionError::DevModeOff)
    ));
    let (raws, problems) = load_active_folders(&state);
    assert!(raws.is_empty() && problems.is_empty());
}

#[test]
fn a_dev_folder_goes_through_the_normal_registry() {
    let tmp = TempDir::new();
    let folder = dev_folder(&tmp, "com.example.dev", "0.1.0");
    let state = dev_state(&folder, true);
    let (raws, problems) = load_active_folders(&state);
    assert!(problems.is_empty());
    assert_eq!(raws[0].origin, Origin::Dev);
    let reg = registry(&raws, &state);
    let entry = reg.entry("com.example.dev").unwrap();
    assert_eq!(entry.origin, Origin::Dev);
    assert_eq!(
        entry.dir, folder,
        "unno://ext/ は、読み込んだフォルダを指す"
    );
    assert!(matches!(entry.status, ExtensionStatus::Enabled { .. }));
    assert_eq!(
        reg.media_rules(&state).classify("a.t"),
        Some("com.example.dev/t")
    );
}

#[test]
fn a_broken_dev_folder_is_a_problem_and_others_still_load() {
    let tmp = TempDir::new();
    let good = dev_folder(&tmp, "com.example.dev", "0.1.0");
    let bad = tmp.path().join("bad");
    std::fs::create_dir_all(&bad).unwrap();
    std::fs::write(bad.join("unnotator-plugin.json"), "{ nope").unwrap();
    let mut state = dev_state(&good, true);
    state.add_dev_folder(bad);
    let (raws, problems) = load_active_folders(&state);
    assert_eq!(raws.len(), 1);
    assert_eq!(problems.len(), 1);
}

#[test]
fn a_dev_extension_wins_over_an_installed_one_with_the_same_id_and_turning_it_off_restores_it() {
    let tmp = TempDir::new();
    let folder = dev_folder(&tmp, "com.example.a", "0.1.0");
    let mut state = dev_state(&folder, true);
    let (mut raws, _) = load_active_folders(&state);
    raws.push(installed("com.example.a", "2.0.0"));
    let reg = registry(&raws, &state);
    let entry = reg.entry("com.example.a").unwrap();
    assert_eq!(
        (entry.origin, entry.version.as_str()),
        (Origin::Dev, "0.1.0")
    );
    assert_eq!(entry.installed_versions.len(), 2, "導入済みは消えない");

    state.set_dev_mode(false);
    let (raws_off, _) = load_active_folders(&state);
    let mut all = raws_off;
    all.push(installed("com.example.a", "2.0.0"));
    let reg = registry(&all, &state);
    assert_eq!(
        reg.entry("com.example.a").unwrap().origin,
        Origin::Installed
    );
    assert!(folder.is_dir(), "フォルダ自体は残る");
}

fn wait_for(watcher: &mut DevWatcher, limit: Duration) -> Vec<(String, Duration)> {
    let started = Instant::now();
    let mut seen = Vec::new();
    while started.elapsed() < limit {
        for id in watcher.poll() {
            seen.push((id, started.elapsed()));
        }
        if !seen.is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    seen
}

#[test]
fn a_change_under_dist_is_reported_by_the_polling_fallback_too() {
    let tmp = TempDir::new();
    let folder = dev_folder(&tmp, "com.example.dev", "0.1.0");
    let mut watcher = DevWatcher::polling(&[("com.example.dev".to_owned(), folder.clone())]);
    assert!(watcher.poll().is_empty());
    std::fs::write(folder.join("dist/index.js"), "export const v = 2;\n").unwrap();
    let seen = wait_for(&mut watcher, Duration::from_secs(5));
    assert_eq!(
        seen.first().map(|(id, _)| id.as_str()),
        Some("com.example.dev")
    );
}

#[test]
fn a_hundred_rewrites_are_reported_few_times_and_soon() {
    let tmp = TempDir::new();
    let folder = dev_folder(&tmp, "com.example.dev", "0.1.0");
    let mut watcher = DevWatcher::new(&[("com.example.dev".to_owned(), folder.clone())])
        .expect("通知を登録できる");
    std::thread::sleep(Duration::from_millis(200));
    for i in 0..100 {
        std::fs::write(
            folder.join("dist/index.js"),
            format!("export const v = {i};\n"),
        )
        .unwrap();
    }
    let started = Instant::now();
    let mut notifications = 0;
    let mut first = None;
    while started.elapsed() < Duration::from_secs(4) {
        let ids = watcher.poll();
        if !ids.is_empty() {
            notifications += 1;
            first.get_or_insert(started.elapsed());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    println!("SC-011 最初の通知まで {first:?}、通知 {notifications} 回");
    assert!(first.expect("通知が来る") < Duration::from_millis(1_500));
    assert!((1..=5).contains(&notifications), "通知 {notifications} 回");
}
