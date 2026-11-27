//! US1: プロジェクトのフォルダのファイルが、走査でアセットになる（spec.md US1、FR-001〜FR-010）。

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::sync::atomic::{AtomicBool, Ordering};

use support::{
    TempDir, create_and_open, create_annotation, folder_with_files, journal_entries, read_assets,
    rules_for_tests, touch, write_file,
};
use unnotator_core::assets::media::{MediaRule, MediaRules};
use unnotator_core::assets::scan::{ScanOptions, ScanScope};
use unnotator_core::assets::{AssetFilter, MediaFilter, Page};
use unnotator_core::command::{Command, Status};
use unnotator_core::error::StoreError;

fn opened(files: &[(&str, &str)]) -> (TempDir, unnotator_core::project::ProjectStore) {
    let dir = folder_with_files(files);
    let mut store = create_and_open(&dir);
    store.set_media_rules(rules_for_tests());
    (dir, store)
}

#[test]
fn files_become_todo_assets_with_slash_separated_relative_paths() {
    let (dir, mut store) = opened(&[
        ("a.txt", "abc"),
        ("sub/b.bin", "12"),
        ("sub/deep/c.md", "x"),
    ]);
    let summary = store.scan(ScanScope::Full).unwrap();
    assert_eq!(summary.added, 3);

    let assets = read_assets(dir.path());
    let paths: Vec<_> = assets.iter().map(|a| a.rel_path.as_str()).collect();
    assert_eq!(paths, ["a.txt", "sub/b.bin", "sub/deep/c.md"]);
    for asset in &assets {
        assert_eq!(asset.root_key, "");
        assert_eq!(asset.status, "todo");
        assert!(!asset.missing);
        assert!(asset.mtime_ms > 0);
    }
    assert_eq!(assets[0].file_size, 3);
    assert_eq!(assets[1].file_size, 2);
    assert_eq!(assets[0].media_type.as_deref(), Some("test/text"));
    assert_eq!(assets[1].media_type.as_deref(), Some("test/binary"));
}

#[test]
fn rescanning_changes_nothing() {
    let (dir, mut store) = opened(&[("a.txt", "abc"), ("b.txt", "d")]);
    store.scan(ScanScope::Full).unwrap();
    let before = read_assets(dir.path());
    let unsaved = store.save_state().unsaved_count;
    let journal = journal_entries(dir.path()).len();

    let summary = store.scan(ScanScope::Full).unwrap();

    assert_eq!(
        summary.added + summary.updated + summary.went_missing + summary.restored,
        0
    );
    assert_eq!(read_assets(dir.path()), before, "重複なし・ID 不変");
    assert_eq!(store.save_state().unsaved_count, unsaved, "書き込み 0 件");
    assert_eq!(journal_entries(dir.path()).len(), journal);
}

#[test]
fn the_project_directory_and_excluded_files_are_not_assets() {
    let (dir, mut store) = opened(&[
        ("keep.txt", "1"),
        ("skip.bak", "2"),
        ("drafts/x.txt", "3"),
        (".hidden.txt", "4"),
        ("note.tmp", "5"),
    ]);
    store.set_scan_options(ScanOptions {
        exclude: vec!["*.bak".to_owned(), "/drafts/".to_owned()],
        ..ScanOptions::default()
    });
    store.scan(ScanScope::Full).unwrap();
    let paths: Vec<_> = read_assets(dir.path())
        .into_iter()
        .map(|a| a.rel_path)
        .collect();
    // `.unnotator/`（project.db・lock）は、設定に関わらず対象外。隠しファイルと `note.tmp` は、この設定には含まれない。
    assert_eq!(paths, [".hidden.txt", "keep.txt", "note.tmp"]);
}

#[test]
fn default_exclusions_skip_hidden_and_temporary_files() {
    let (dir, mut store) = opened(&[
        ("keep.txt", "1"),
        (".DS_Store", "x"),
        ("a.tmp", "y"),
        (".git/config", "z"),
    ]);
    store.scan(ScanScope::Full).unwrap();
    let paths: Vec<_> = read_assets(dir.path())
        .into_iter()
        .map(|a| a.rel_path)
        .collect();
    assert_eq!(paths, ["keep.txt"]);
}

#[test]
fn a_changed_file_updates_only_its_size_and_mtime() {
    let (dir, mut store) = opened(&[("a.txt", "abc")]);
    store.scan(ScanScope::Full).unwrap();
    let id = read_assets(dir.path())[0].id.clone();
    store
        .apply_command(Command::SetAssetStatus {
            asset_id: id.clone(),
            status: Status::Done,
        })
        .unwrap();
    store.apply_command(create_annotation(&id, "{}")).unwrap();

    write_file(dir.path(), "a.txt", b"longer content");
    touch(dir.path(), "a.txt", 1_700_000_100_000);
    let summary = store.scan(ScanScope::Full).unwrap();

    assert_eq!(summary.updated, 1);
    let asset = &read_assets(dir.path())[0];
    assert_eq!(asset.id, id);
    assert_eq!(asset.file_size, 14);
    assert_eq!(asset.mtime_ms, 1_700_000_100_000);
    assert_eq!(asset.status, "done");
    assert_eq!(
        support::count(&support::read_conn(dir.path()), "annotations"),
        1
    );
}

#[test]
fn unmatched_extensions_are_unknown_but_listed_and_rules_can_be_reapplied() {
    let (dir, mut store) = opened(&[("a.txt", "1"), ("b.xyz", "2")]);
    store.scan(ScanScope::Full).unwrap();
    let assets = read_assets(dir.path());
    assert_eq!(assets[1].rel_path, "b.xyz");
    assert_eq!(assets[1].media_type, None, "判定できなければ「不明」");

    let id = assets[1].id.clone();
    store.apply_command(create_annotation(&id, "{}")).unwrap();
    let mut rules = MediaRules::new();
    rules
        .push(MediaRule {
            media_type: "test/other".to_owned(),
            extensions: vec!["xyz".to_owned()],
            mime_types: vec![],
        })
        .unwrap();
    store.set_media_rules(rules);
    let changed = store.reclassify_assets().unwrap();

    assert_eq!(changed, 2, "a.txt は不明になり、b.xyz は新しい種別になる");
    let assets = read_assets(dir.path());
    assert_eq!(assets[0].media_type, None);
    assert_eq!(assets[1].media_type.as_deref(), Some("test/other"));
    assert_eq!(
        support::count(&support::read_conn(dir.path()), "annotations"),
        1
    );
    assert_eq!(store.reclassify_assets().unwrap(), 0, "2 回目は変わらない");
}

#[test]
fn a_case_only_rename_does_not_create_a_duplicate_on_a_case_insensitive_file_system() {
    let (dir, mut store) = opened(&[("Photo.txt", "1")]);
    store.scan(ScanScope::Full).unwrap();
    let insensitive = unnotator_core::assets::path::fs_is_case_insensitive(dir.path());
    std::fs::rename(dir.path().join("Photo.txt"), dir.path().join("photo.txt")).unwrap();
    store.scan(ScanScope::Full).unwrap();
    let assets = read_assets(dir.path());
    if insensitive {
        assert_eq!(assets.len(), 1, "同じファイルを 2 つのアセットにしない");
        assert!(!assets[0].missing);
    } else {
        assert_eq!(assets.len(), 2);
        assert!(
            assets
                .iter()
                .any(|a| a.rel_path == "Photo.txt" && a.missing)
        );
    }
}

#[cfg(unix)]
#[test]
fn symbolic_links_are_not_followed() {
    let (dir, mut store) = opened(&[("real.txt", "1"), ("d/inner.txt", "2")]);
    std::os::unix::fs::symlink(dir.path().join("real.txt"), dir.path().join("link.txt")).unwrap();
    std::os::unix::fs::symlink(dir.path(), dir.path().join("d/loop")).unwrap();
    store.scan(ScanScope::Full).unwrap();
    let paths: Vec<_> = read_assets(dir.path())
        .into_iter()
        .map(|a| a.rel_path)
        .collect();
    assert_eq!(paths, ["d/inner.txt", "real.txt"]);
}

// ---- 頑健さ（T013） ----

#[cfg(unix)]
#[test]
fn an_unreadable_folder_is_skipped_and_its_assets_are_not_marked_missing() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, mut store) = opened(&[("ok.txt", "1"), ("locked/secret.txt", "2")]);
    store.scan(ScanScope::Full).unwrap();
    let locked = dir.path().join("locked");
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::read_dir(&locked).is_ok() {
        // root などで権限が効かない環境では、このテストの前提が成り立たない
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        return;
    }
    let summary = store.scan(ScanScope::Full).unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();

    assert_eq!(summary.skipped.len(), 1);
    assert_eq!(summary.skipped[0].rel_path, "locked");
    assert_eq!(summary.skipped[0].reason, "permission_denied");
    assert_eq!(summary.went_missing, 0, "読めないだけでリンク切れにしない");
    assert!(read_assets(dir.path()).iter().all(|a| !a.missing));
}

#[test]
fn a_cancelled_scan_never_marks_assets_missing() {
    let (dir, mut store) = opened(&[("a.txt", "1"), ("b.txt", "2")]);
    store.scan(ScanScope::Full).unwrap();
    std::fs::remove_file(dir.path().join("a.txt")).unwrap();
    write_file(dir.path(), "c.txt", b"3");

    let cancel = AtomicBool::new(true);
    let job = store.begin_scan(ScanScope::Full).unwrap();
    let report = job.run(&cancel, &|_| {});
    let summary = store.apply_scan(report).unwrap();

    assert!(!summary.complete);
    assert_eq!(
        summary.went_missing, 0,
        "中断した走査は、無いことの証拠にならない"
    );
    assert!(read_assets(dir.path()).iter().all(|a| !a.missing));

    // 続けて通常の走査をすれば、整合する
    store.scan(ScanScope::Full).unwrap();
    let assets = read_assets(dir.path());
    assert!(assets.iter().any(|a| a.rel_path == "a.txt" && a.missing));
    assert!(assets.iter().any(|a| a.rel_path == "c.txt"));
}

#[test]
fn progress_is_monotonic_and_a_second_scan_is_refused() {
    let files: Vec<(String, String)> = (0..50)
        .map(|i| (format!("f{i}.txt"), "x".to_owned()))
        .collect();
    let refs: Vec<(&str, &str)> = files
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    let (_dir, mut store) = opened(&refs);

    let job = store.begin_scan(ScanScope::Full).unwrap();
    assert!(matches!(
        store.begin_scan(ScanScope::Full),
        Err(StoreError::ScanInProgress)
    ));
    let seen = std::sync::Mutex::new(Vec::new());
    let cancel = AtomicBool::new(false);
    let report = job.run(&cancel, &|p| seen.lock().unwrap().push(p.found));
    let seen = seen.into_inner().unwrap();
    assert!(seen.windows(2).all(|w| w[0] <= w[1]));
    assert_eq!(seen.last().copied(), Some(50));
    store.apply_scan(report).unwrap();
    assert!(
        store.begin_scan(ScanScope::Full).is_ok(),
        "適用が終わると、また走査できる"
    );
    let _ = Ordering::SeqCst;
}

#[test]
fn large_differences_are_applied_in_bounded_chunks() {
    let files: Vec<(String, String)> = (0..95)
        .map(|i| (format!("f{i:03}.txt"), "x".to_owned()))
        .collect();
    let refs: Vec<(&str, &str)> = files
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    let (dir, mut store) = opened(&refs);
    store.set_scan_options(ScanOptions {
        chunk_rows: 10,
        ..ScanOptions::default()
    });
    let summary = store.scan(ScanScope::Full).unwrap();
    assert_eq!(summary.added, 95);
    assert!(journal_entries(dir.path()).is_empty(), "変更履歴に入れない");
    assert_eq!(
        support::count(&support::read_saved_conn(dir.path()), "assets"),
        95
    );
    assert_eq!(read_assets(dir.path()).len(), 95);
}

#[test]
fn list_assets_filters_and_pages_by_cursor() {
    let (_dir, mut store) = opened(&[
        ("a.txt", "1"),
        ("b.txt", "2"),
        ("img/c.bin", "3"),
        ("img/d.xyz", "4"),
        ("z.md", "5"),
    ]);
    store.scan(ScanScope::Full).unwrap();

    let all = store
        .list_assets(&AssetFilter::default(), &Page::first(100))
        .unwrap();
    assert_eq!(all.items.len(), 5);
    assert!(all.next.is_none());

    let mut seen = Vec::new();
    let mut page = Page::first(2);
    loop {
        let result = store.list_assets(&AssetFilter::default(), &page).unwrap();
        assert!(result.items.len() <= 2);
        seen.extend(result.items.iter().map(|a| a.rel_path.clone()));
        match result.next {
            Some(cursor) => {
                page = Page {
                    after: Some(cursor),
                    limit: 2,
                }
            }
            None => break,
        }
    }
    assert_eq!(seen, ["a.txt", "b.txt", "img/c.bin", "img/d.xyz", "z.md"]);

    let unknown = store
        .list_assets(
            &AssetFilter {
                media_type: MediaFilter::Unknown,
                ..AssetFilter::default()
            },
            &Page::first(10),
        )
        .unwrap();
    assert_eq!(unknown.items.len(), 1);
    assert_eq!(unknown.items[0].rel_path, "img/d.xyz");

    let text = store
        .list_assets(
            &AssetFilter {
                media_type: MediaFilter::Is("test/text".to_owned()),
                ..AssetFilter::default()
            },
            &Page::first(10),
        )
        .unwrap();
    assert_eq!(text.items.len(), 3);

    let folder = store
        .list_assets(
            &AssetFilter {
                path_prefix: Some("img/".to_owned()),
                ..AssetFilter::default()
            },
            &Page::first(10),
        )
        .unwrap();
    assert_eq!(folder.items.len(), 2);

    let done = store
        .list_assets(
            &AssetFilter {
                status: Some(Status::Done),
                ..AssetFilter::default()
            },
            &Page::first(10),
        )
        .unwrap();
    assert!(done.items.is_empty());
    let missing = store
        .list_assets(
            &AssetFilter {
                missing: Some(true),
                ..AssetFilter::default()
            },
            &Page::first(10),
        )
        .unwrap();
    assert!(missing.items.is_empty());
}

// ---- 走査はプロジェクトの内部の扱い: 編集履歴・未保存に入れず、project.db の表だけを更新する ----

fn saved_asset(dir: &TempDir, rel_path: &str) -> (String, i64, i64) {
    let conn = support::read_saved_conn(dir.path());
    conn.query_row(
        "SELECT status, file_size, missing FROM assets WHERE rel_path = ?1",
        [rel_path],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .unwrap()
}

#[test]
fn a_scan_updates_project_db_but_is_neither_journaled_nor_unsaved() {
    let (dir, mut store) = opened(&[("a.txt", "abc"), ("b.txt", "d")]);

    store.scan(ScanScope::Full).unwrap();

    assert_eq!(
        support::count(&support::read_saved_conn(dir.path()), "assets"),
        2
    );
    assert!(journal_entries(dir.path()).is_empty(), "編集履歴に入れない");
    let state = store.save_state();
    assert!(!state.dirty && state.unsaved_count == 0 && state.last_change_at.is_none());
}

#[test]
fn a_scan_never_saves_the_users_unsaved_edits() {
    let (dir, mut store) = opened(&[("a.txt", "abc")]);
    store.scan(ScanScope::Full).unwrap();
    let id = read_assets(dir.path())[0].id.clone();
    store
        .apply_command(Command::SetAssetStatus {
            asset_id: id,
            status: Status::Done,
        })
        .unwrap();
    store.apply_command(support::create_label("L")).unwrap();

    // ファイルが変わって、2 回目の走査が差分を書く
    write_file(dir.path(), "a.txt", b"longer content");
    touch(dir.path(), "a.txt", 1_700_000_100_000);
    write_file(dir.path(), "new.txt", b"n");
    store.scan(ScanScope::Full).unwrap();

    let (status, size, _) = saved_asset(&dir, "a.txt");
    assert_eq!(size, 14, "走査の結果（サイズ）は project.db に入る");
    assert_eq!(status, "todo", "利用者の未保存の編集（状態）は入らない");
    assert_eq!(saved_asset(&dir, "new.txt").0, "todo");
    let saved = support::read_saved_conn(dir.path());
    assert_eq!(support::count(&saved, "labels"), 0, "ラベルも入らない");
    // 作業用の複製には両方ある
    let working = support::read_conn(dir.path());
    assert_eq!(support::count(&working, "labels"), 1);
    let state = store.save_state();
    assert!(state.dirty);
    assert_eq!(state.unsaved_count, 2, "利用者の編集 2 件だけ");
    assert_eq!(journal_entries(dir.path()).len(), 2);
}

#[test]
fn files_that_go_missing_are_marked_in_project_db_too() {
    let (dir, mut store) = opened(&[("a.txt", "abc")]);
    store.scan(ScanScope::Full).unwrap();

    support::remove_file(dir.path(), "a.txt");
    store.scan(ScanScope::Full).unwrap();

    assert_eq!(saved_asset(&dir, "a.txt").2, 1);
    assert!(!store.save_state().dirty);
}

#[test]
fn closing_after_a_scan_alone_asks_nothing_and_keeps_the_assets() {
    let (dir, mut store) = opened(&[("a.txt", "abc")]);
    store.scan(ScanScope::Full).unwrap();

    store.close(None).unwrap();

    assert_eq!(
        support::count(&support::read_saved_conn(dir.path()), "assets"),
        1
    );
}

#[test]
fn a_later_save_keeps_the_scan_results() {
    let (dir, mut store) = opened(&[("a.txt", "abc")]);
    store.scan(ScanScope::Full).unwrap();
    store.apply_command(support::create_label("L")).unwrap();

    store.save().unwrap();

    let saved = support::read_saved_conn(dir.path());
    assert_eq!(support::count(&saved, "assets"), 1);
    assert_eq!(support::count(&saved, "labels"), 1);
}
