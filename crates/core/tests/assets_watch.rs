//! US4: フォルダを見張り、変化を自動で取り込む（spec.md US4、FR-020〜FR-023）。
//!
//! 通知の代わりに、変わったパスを直接渡す `Watcher`（`FakeWatcher`）と、通知なしで動く `PollingWatcher` で確かめる。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use support::{
    TempDir, create_and_open, folder_with_files, move_file, read_assets, remove_file,
    rules_for_tests, snapshot, write_file,
};
use unnotator_core::assets::exclude::ExcludeSet;
use unnotator_core::assets::scan::{ScanPath, ScanScope};
use unnotator_core::assets::watch::{
    Debouncer, NotifyWatcher, PollingWatcher, Throttled, WatchBatch, Watcher,
};
use unnotator_core::project::ProjectStore;

/// 用意した順に、変わったパスを返す見張り。
struct FakeWatcher(VecDeque<WatchBatch>);

impl Watcher for FakeWatcher {
    fn tick(&mut self) -> WatchBatch {
        self.0.pop_front().unwrap_or_default()
    }
}

fn path(rel: &str) -> ScanPath {
    ScanPath {
        root_key: String::new(),
        rel_path: rel.to_owned(),
    }
}

fn batch(rels: &[&str]) -> WatchBatch {
    WatchBatch {
        paths: rels.iter().map(|r| path(r)).collect(),
        overflow: false,
    }
}

fn opened(files: &[(&str, &str)]) -> (TempDir, ProjectStore) {
    let dir = folder_with_files(files);
    let mut store = create_and_open(&dir);
    store.set_media_rules(rules_for_tests());
    store.scan(ScanScope::Full).unwrap();
    (dir, store)
}

// ---- まとめ処理 ----

#[test]
fn events_inside_the_window_become_one_batch_after_things_go_quiet() {
    let t0 = Instant::now();
    let mut d = Debouncer::new(Duration::from_millis(500), Duration::from_secs(5), 1000);
    d.push("", "a.txt", t0);
    d.push("", "a.txt", t0 + Duration::from_millis(100));
    d.push("", "b/c.txt", t0 + Duration::from_millis(300));
    assert!(
        d.ready(t0 + Duration::from_millis(600)).is_none(),
        "まだ静かになっていない"
    );
    let batch = d
        .ready(t0 + Duration::from_millis(900))
        .expect("静かになった");
    assert_eq!(batch.paths, [path("a.txt"), path("b/c.txt")]);
    assert!(!batch.overflow);
    assert!(
        d.ready(t0 + Duration::from_secs(10)).is_none(),
        "取り出したら空"
    );
}

#[test]
fn a_constant_stream_is_flushed_after_the_longest_wait() {
    let t0 = Instant::now();
    let mut d = Debouncer::new(Duration::from_millis(500), Duration::from_secs(2), 1000);
    for i in 0..30 {
        d.push(
            "",
            &format!("f{i}.txt"),
            t0 + Duration::from_millis(i * 100),
        );
    }
    assert!(
        d.ready(t0 + Duration::from_millis(2_100)).is_some(),
        "絶え間なく続いても、最長の待ちで出す"
    );
}

#[test]
fn a_folder_swallows_its_children_and_too_many_paths_overflow_to_a_full_scan() {
    let t0 = Instant::now();
    let mut d = Debouncer::new(Duration::from_millis(10), Duration::from_secs(1), 3);
    d.push("", "dir/a.txt", t0);
    d.push("", "dir", t0);
    d.push("", "other.txt", t0);
    let b = d.ready(t0 + Duration::from_secs(1)).unwrap();
    assert_eq!(b.paths, [path("dir"), path("other.txt")]);

    for i in 0..10 {
        d.push("", &format!("f{i}"), t0);
    }
    let b = d.ready(t0 + Duration::from_secs(1)).unwrap();
    assert!(b.overflow, "多すぎるときは、全体の走査に切り替える");
    assert!(b.paths.is_empty());
    assert_eq!(b.scope(), ScanScope::Full);
}

// ---- 部分走査への反映 ----

#[test]
fn added_removed_and_renamed_files_are_applied_through_path_scans() {
    let (dir, mut store) = opened(&[("keep.txt", "1"), ("gone.txt", "2"), ("old.txt", "3")]);
    let mut watcher = FakeWatcher(VecDeque::new());

    write_file(dir.path(), "new/added.txt", b"4");
    remove_file(dir.path(), "gone.txt");
    move_file(dir.path(), "old.txt", "renamed.txt");
    watcher
        .0
        .push_back(batch(&["new", "gone.txt", "old.txt", "renamed.txt"]));
    let summary = store.scan(watcher.tick().scope()).unwrap();

    assert_eq!((summary.added, summary.went_missing), (2, 2));
    let assets = read_assets(dir.path());
    let state: Vec<_> = assets
        .iter()
        .map(|a| (a.rel_path.as_str(), a.missing))
        .collect();
    assert_eq!(
        state,
        [
            ("gone.txt", true),
            ("keep.txt", false),
            ("new/added.txt", false),
            ("old.txt", true),
            ("renamed.txt", false)
        ]
    );
}

#[test]
fn a_path_scan_never_touches_assets_outside_the_paths() {
    let (dir, mut store) = opened(&[("a/x.txt", "1"), ("b/y.txt", "2")]);
    remove_file(dir.path(), "b/y.txt");
    let summary = store.scan(batch(&["a"]).scope()).unwrap();
    assert_eq!(
        summary.went_missing, 0,
        "b は見ていないので、リンク切れにしない"
    );
    assert!(read_assets(dir.path()).iter().all(|a| !a.missing));
}

#[test]
fn path_scans_and_a_full_scan_end_in_the_same_state() {
    let setup = || {
        let (dir, store) = opened(&[("a/1.txt", "1"), ("a/2.txt", "22"), ("b/3.txt", "333")]);
        write_file(dir.path(), "a/4.txt", b"4444");
        write_file(dir.path(), "c/5.txt", b"5");
        remove_file(dir.path(), "b/3.txt");
        write_file(dir.path(), "a/1.txt", b"changed");
        (dir, store)
    };
    let (dir_a, mut by_paths) = setup();
    by_paths.scan(batch(&["a", "b", "c"]).scope()).unwrap();
    let (dir_b, mut full) = setup();
    full.scan(ScanScope::Full).unwrap();

    let strip = |dir: &TempDir| {
        read_assets(dir.path())
            .into_iter()
            .map(|a| (a.rel_path, a.file_size, a.missing))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        strip(&dir_a),
        strip(&dir_b),
        "取りこぼしがあっても、全体の走査で同じになる"
    );
    let _ = snapshot;
}

#[test]
fn ten_thousand_changes_produce_a_handful_of_notifications() {
    let (dir, mut store) = opened(&[]);
    let seen: Arc<Mutex<usize>> = Arc::default();
    let sink = Arc::clone(&seen);
    store.subscribe(Box::new(move |_| *sink.lock().unwrap() += 1));
    for i in 0..10_000 {
        write_file(dir.path(), &format!("bulk/f{i:05}.txt"), b"x");
    }
    let summary = store.scan(batch(&["bulk"]).scope()).unwrap();
    assert_eq!(summary.added, 10_000);
    let count = *seen.lock().unwrap();
    assert!(count <= 100, "通知は件数をまとめた少数: {count}");
}

// ---- 通知なしの代替（定期走査） ----

#[test]
fn the_polling_watcher_reports_changed_folders_without_any_notification() {
    let (dir, mut store) = opened(&[("a/x.txt", "1"), ("b/y.txt", "2")]);
    let mut watcher = PollingWatcher::new(
        vec![(String::new(), dir.path().to_path_buf())],
        ExcludeSet::defaults(),
        1_000,
    );
    assert!(watcher.tick().is_empty(), "最初は基準を覚えるだけ");
    assert!(watcher.tick().is_empty(), "変わらなければ、何も報せない");

    std::thread::sleep(Duration::from_millis(20));
    write_file(dir.path(), "a/new.txt", b"3");
    let first = watcher.tick();
    assert_eq!(first.paths, [path("a")]);
    store.scan(first.scope()).unwrap();
    assert!(
        read_assets(dir.path())
            .iter()
            .any(|a| a.rel_path == "a/new.txt")
    );

    std::thread::sleep(Duration::from_millis(20));
    remove_file(dir.path(), "b/y.txt");
    let second = watcher.tick();
    assert_eq!(second.paths, [path("b")]);
    store.scan(second.scope()).unwrap();
    assert!(
        read_assets(dir.path())
            .iter()
            .find(|a| a.rel_path == "b/y.txt")
            .unwrap()
            .missing
    );
}

#[test]
fn the_polling_watcher_does_a_full_scan_now_and_then_to_catch_in_place_edits() {
    let (dir, mut store) = opened(&[("a.txt", "1")]);
    let mut watcher = PollingWatcher::new(
        vec![(String::new(), dir.path().to_path_buf())],
        ExcludeSet::defaults(),
        3,
    );
    watcher.tick(); // 基準
    write_file(dir.path(), "a.txt", b"edited in place"); // フォルダの更新時刻は変わらない
    let mut last = WatchBatch::default();
    for _ in 0..3 {
        last = watcher.tick();
        if last.overflow {
            break;
        }
    }
    assert!(last.overflow, "一定回数ごとに、全体の走査を求める");
    store.scan(last.scope()).unwrap();
    assert_eq!(read_assets(dir.path())[0].file_size, 15);
}

#[test]
fn the_watch_setting_defaults_on_and_can_be_turned_off() {
    let (_dir, mut store) = opened(&[]);
    assert!(store.watch_enabled());
    store
        .settings_set(
            unnotator_core::settings::Layer::Project,
            "assets.watch",
            serde_json::json!(false),
        )
        .unwrap();
    assert!(!store.watch_enabled());
}

// ---- 通知（notify）と間引き ----

#[test]
fn the_notify_watcher_reports_changes_within_five_seconds() {
    let (dir, mut store) = opened(&[("a/x.txt", "1")]);
    let mut watcher = NotifyWatcher::new(
        vec![(String::new(), dir.path().to_path_buf())],
        ExcludeSet::defaults(),
        100_000,
    )
    .expect("通知を登録できる");

    let started = Instant::now();
    write_file(dir.path(), "a/new.txt", b"2");
    write_file(dir.path(), ".hidden", b"ignored by the default exclusions");
    let mut batch = WatchBatch::default();
    while started.elapsed() < Duration::from_secs(5) {
        batch = watcher.tick();
        if !batch.is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let latency = started.elapsed();
    assert!(!batch.is_empty(), "5 秒以内に届く");
    assert!(!batch.overflow);
    assert!(
        batch
            .paths
            .iter()
            .any(|p| p.rel_path == "a/new.txt" || p.rel_path == "a"),
        "{:?}",
        batch.paths
    );
    assert!(
        batch.paths.iter().all(|p| p.rel_path != ".hidden"),
        "除外は無視する"
    );
    println!("通知から取り込みの指示まで: {latency:?}");

    store.scan(batch.scope()).unwrap();
    assert!(
        read_assets(dir.path())
            .iter()
            .any(|a| a.rel_path == "a/new.txt")
    );
}

#[test]
fn the_notify_watcher_asks_for_a_full_scan_now_and_then() {
    let dir = TempDir::new();
    let mut watcher = NotifyWatcher::new(
        vec![(String::new(), dir.path().to_path_buf())],
        ExcludeSet::defaults(),
        3,
    )
    .expect("通知を登録できる");
    assert!(!watcher.tick().overflow);
    assert!(!watcher.tick().overflow);
    assert!(
        watcher.tick().overflow,
        "取りこぼしに備えて、全体の走査を求める"
    );
}

#[test]
fn a_throttled_watcher_only_runs_every_nth_call() {
    struct Counting(u32);
    impl Watcher for Counting {
        fn tick(&mut self) -> WatchBatch {
            self.0 += 1;
            WatchBatch {
                paths: vec![path(&format!("n{}", self.0))],
                overflow: false,
            }
        }
    }
    let mut throttled = Throttled::new(Counting(0), 3);
    assert!(throttled.tick().is_empty());
    assert!(throttled.tick().is_empty());
    assert_eq!(throttled.tick().paths, [path("n1")]);
    assert!(throttled.tick().is_empty());
}
