//! US2: ファイルが消えても動いても、アノテーションは失われない（spec.md US2、FR-011〜FR-015）。

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use support::{
    TempDir, create_and_open, create_annotation, folder_with_files, move_file, read_assets,
    read_conn, remove_file, rules_for_tests, snapshot, write_file,
};
use unnotator_core::assets::scan::ScanScope;
use unnotator_core::command::{Command, Status};
use unnotator_core::project::ProjectStore;

fn opened(files: &[(&str, &str)]) -> (TempDir, ProjectStore) {
    let dir = folder_with_files(files);
    let mut store = create_and_open(&dir);
    store.set_media_rules(rules_for_tests());
    store.scan(ScanScope::Full).unwrap();
    (dir, store)
}

fn id_of(dir: &TempDir, rel: &str) -> String {
    read_assets(dir.path())
        .into_iter()
        .find(|a| a.rel_path == rel)
        .unwrap_or_else(|| panic!("{rel} がない"))
        .id
}

fn relink(asset_id: &str, rel: &str) -> Command {
    Command::RelinkAsset {
        asset_id: asset_id.to_owned(),
        root_key: String::new(),
        rel_path: rel.to_owned(),
    }
}

#[test]
fn a_vanished_file_becomes_missing_and_keeps_everything_attached() {
    let (dir, mut store) = opened(&[("a.txt", "abc")]);
    let id = id_of(&dir, "a.txt");
    store.apply_command(create_annotation(&id, "{}")).unwrap();
    store
        .apply_command(Command::SetAssetStatus {
            asset_id: id.clone(),
            status: Status::Done,
        })
        .unwrap();

    remove_file(dir.path(), "a.txt");
    let summary = store.scan(ScanScope::Full).unwrap();

    assert_eq!(summary.went_missing, 1);
    assert_eq!(summary.miss_reasons[0].reason, "file_not_found");
    let asset = &read_assets(dir.path())[0];
    assert!(asset.missing);
    assert_eq!(asset.status, "done");
    assert_eq!(support::count(&read_conn(dir.path()), "annotations"), 1);
}

#[test]
fn a_moved_file_is_offered_as_a_candidate_and_never_linked_automatically() {
    let (dir, mut store) = opened(&[("a.txt", "abc"), ("other.txt", "zz")]);
    let id = id_of(&dir, "a.txt");
    store.apply_command(create_annotation(&id, "{}")).unwrap();
    move_file(dir.path(), "a.txt", "moved/a.txt");
    store.scan(ScanScope::Full).unwrap();

    let assets = read_assets(dir.path());
    assert_eq!(
        assets.len(),
        3,
        "新しい場所は、通常どおり新しいアセットとして登録される"
    );
    assert!(assets.iter().find(|a| a.id == id).unwrap().missing);

    let candidates = store.relink_candidates(&id).unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].rel_path, "moved/a.txt");
    assert_eq!(candidates[0].missing_asset_id, id);
    assert_eq!(candidates[0].file_size, 3);
}

#[test]
fn every_matching_file_is_a_candidate_when_there_are_several() {
    let (dir, mut store) = opened(&[("a.txt", "abc")]);
    let id = id_of(&dir, "a.txt");
    remove_file(dir.path(), "a.txt");
    write_file(dir.path(), "x/a.txt", b"123");
    write_file(dir.path(), "y/a.txt", b"456");
    write_file(dir.path(), "z/a.txt", b"longer"); // サイズが違うので候補にならない
    store.scan(ScanScope::Full).unwrap();
    let paths: Vec<_> = store
        .relink_candidates(&id)
        .unwrap()
        .into_iter()
        .map(|c| c.rel_path)
        .collect();
    assert_eq!(paths, ["x/a.txt", "y/a.txt"]);
}

#[test]
fn accepting_a_candidate_points_the_same_asset_at_the_new_place_and_undo_restores() {
    let (dir, mut store) = opened(&[("a.txt", "abc")]);
    let id = id_of(&dir, "a.txt");
    store.apply_command(create_annotation(&id, "{}")).unwrap();
    move_file(dir.path(), "a.txt", "moved/a.txt");
    store.scan(ScanScope::Full).unwrap();
    let before = snapshot(&read_conn(dir.path()));

    store.apply_command(relink(&id, "moved/a.txt")).unwrap();

    let assets = read_assets(dir.path());
    assert_eq!(assets.len(), 1, "手つかずの重複は取り除かれる");
    assert_eq!(assets[0].id, id);
    assert_eq!(assets[0].rel_path, "moved/a.txt");
    assert!(!assets[0].missing);
    assert_eq!(support::count(&read_conn(dir.path()), "annotations"), 1);
    let after = snapshot(&read_conn(dir.path()));

    store.undo().unwrap();
    assert_eq!(snapshot(&read_conn(dir.path())), before);
    store.redo().unwrap();
    assert_eq!(snapshot(&read_conn(dir.path())), after);
}

#[test]
fn a_duplicate_that_has_something_attached_blocks_the_relink() {
    let (dir, mut store) = opened(&[("a.txt", "abc")]);
    let id = id_of(&dir, "a.txt");
    move_file(dir.path(), "a.txt", "moved/a.txt");
    store.scan(ScanScope::Full).unwrap();
    let dup = id_of(&dir, "moved/a.txt");
    store
        .apply_command(Command::SetAssetStatus {
            asset_id: dup,
            status: Status::Review,
        })
        .unwrap();
    let before = snapshot(&read_conn(dir.path()));

    let error = store.apply_command(relink(&id, "moved/a.txt")).unwrap_err();

    assert_eq!(error.code(), "invalid_command");
    assert_eq!(snapshot(&read_conn(dir.path())), before);
    // 手つかずでないものは、候補にも出ない
    assert!(store.relink_candidates(&id).unwrap().is_empty());
}

#[test]
fn ignoring_a_candidate_changes_nothing_and_a_returning_file_heals_the_link() {
    let (dir, mut store) = opened(&[("a.txt", "abc")]);
    let id = id_of(&dir, "a.txt");
    store.apply_command(create_annotation(&id, "{}")).unwrap();
    move_file(dir.path(), "a.txt", "moved/a.txt");
    store.scan(ScanScope::Full).unwrap();
    let before = snapshot(&read_conn(dir.path()));
    store.scan(ScanScope::Full).unwrap();
    assert_eq!(
        snapshot(&read_conn(dir.path())),
        before,
        "無視しても、何も変わらない"
    );

    move_file(dir.path(), "moved/a.txt", "a.txt");
    let summary = store.scan(ScanScope::Full).unwrap();
    assert_eq!(summary.restored, 1);
    let asset = read_assets(dir.path())
        .into_iter()
        .find(|a| a.id == id)
        .unwrap();
    assert!(!asset.missing, "元の場所に戻れば、自動で解消する");
    assert_eq!(support::count(&read_conn(dir.path()), "annotations"), 1);
}

#[test]
fn relink_rejects_bad_targets() {
    let (dir, mut store) = opened(&[("a.txt", "abc")]);
    let id = id_of(&dir, "a.txt");
    assert_eq!(
        store
            .apply_command(relink("nope", "b.txt"))
            .unwrap_err()
            .code(),
        "not_found"
    );
    for bad in ["", "/abs", "x/../y", ".unnotator/z"] {
        assert_eq!(
            store.apply_command(relink(&id, bad)).unwrap_err().code(),
            "invalid_command",
            "{bad}"
        );
    }
    assert_eq!(
        store
            .apply_command(relink(&id, "a.txt"))
            .unwrap_err()
            .code(),
        "invalid_command",
        "同じ場所への付け替えは意味がない"
    );
    assert!(store.relink_candidates("nope").is_err());
    assert_eq!(
        store.relink_candidates(&id).unwrap_err().code(),
        "invalid_command",
        "リンク切れでないアセットには、候補がない"
    );
}

#[test]
fn delete_asset_removes_everything_under_it_and_round_trips() {
    let (dir, mut store) = opened(&[("a.txt", "1"), ("b.txt", "2")]);
    let (a, b) = (id_of(&dir, "a.txt"), id_of(&dir, "b.txt"));
    let on_a = {
        let set = store.apply_command(create_annotation(&a, "{}")).unwrap();
        set.changes[0].id.clone()
    };
    let on_b = {
        let set = store.apply_command(create_annotation(&b, "{}")).unwrap();
        set.changes[0].id.clone()
    };
    store
        .apply_command(Command::CreateRelation {
            id: None,
            relation_type: "com.example.link/link".to_owned(),
            from_id: on_a.clone(),
            to_id: on_b.clone(),
            directed: None,
            label_id: None,
            attributes_json: None,
            source: None,
        })
        .unwrap();
    store
        .apply_command(Command::CreateGroup {
            id: None,
            group_type: "com.example.set/set".to_owned(),
            ordered: None,
            label_id: None,
            attributes_json: None,
            members: vec![on_a.clone(), on_b.clone()],
            source: None,
        })
        .unwrap();
    store
        .apply_command(Command::SetItemStatus {
            item: unnotator_core::command::ItemRef {
                asset_id: a.clone(),
                item_key: "page:1".to_owned(),
                provider: "com.example.pages/pages".to_owned(),
            },
            status: Status::Done,
        })
        .unwrap();
    let before = snapshot(&read_conn(dir.path()));

    store
        .apply_command(Command::DeleteAsset {
            asset_id: a.clone(),
        })
        .unwrap();

    let conn = read_conn(dir.path());
    assert_eq!(support::count(&conn, "assets"), 1);
    assert_eq!(support::count(&conn, "annotations"), 1);
    assert_eq!(support::count(&conn, "relations"), 0);
    assert_eq!(support::count(&conn, "items"), 0);
    assert_eq!(support::count(&conn, "group_members"), 1);
    let after = snapshot(&conn);
    drop(conn);

    store.undo().unwrap();
    assert_eq!(snapshot(&read_conn(dir.path())), before);
    store.redo().unwrap();
    assert_eq!(snapshot(&read_conn(dir.path())), after);
    assert_eq!(
        store
            .apply_command(Command::DeleteAsset {
                asset_id: "nope".to_owned()
            })
            .unwrap_err()
            .code(),
        "not_found"
    );
}
