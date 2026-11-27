//! アセットツリーの索引（構築・集計・部分更新・元に戻す / やり直しへの追従）。
//! `specs/007-tree-preview/data-model.md` の `TreeIndex` の不変条件。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::cell::RefCell;

use rusqlite::Connection;
use unnotator_core::assets::AssetRow;
use unnotator_core::assets::tree::{AssetSource, NodeKind, TreeIndex};
use unnotator_core::command::{Command, Status};
use unnotator_core::error::StoreError;
use unnotator_core::event::{Change, ChangeKind, ChangeSet, Entity, Origin};
use unnotator_core::project::ProjectStore;

fn row(id: &str, root: &str, path: &str, status: Status, missing: bool) -> AssetRow {
    AssetRow {
        id: id.to_owned(),
        root_key: root.to_owned(),
        rel_path: path.to_owned(),
        media_type: None,
        file_size: 1,
        mtime_ms: 1,
        status,
        missing,
    }
}

fn todo(id: &str, path: &str) -> AssetRow {
    row(id, "", path, Status::Todo, false)
}

fn sample() -> Vec<AssetRow> {
    vec![
        todo("a1", "b.txt"),
        todo("a2", "a/img10.png"),
        todo("a3", "a/img2.png"),
        todo("a4", "Z.txt"),
        todo("a5", "a/sub/x.txt"),
        row("a6", "photos", "p/1.png", Status::Done, false),
        row("a7", "photos", "p/2.png", Status::Todo, true),
    ]
}

/// 構造を、深さ優先で `(種類, 深さ, 名前, total, done)` の列にする。
type Shape = Vec<(char, u32, String, u32, u32)>;

fn shape(index: &TreeIndex) -> Shape {
    fn walk(index: &TreeIndex, at: u32, out: &mut Shape) {
        let node = index.node(at);
        let kind = match node.kind {
            NodeKind::Root => 'R',
            NodeKind::Folder => 'F',
            NodeKind::Asset => 'A',
        };
        out.push((kind, node.depth, node.name.clone(), node.total, node.done));
        for child in &node.children {
            walk(index, *child, out);
        }
    }
    let mut out = Vec::new();
    for root in index.roots() {
        walk(index, *root, &mut out);
    }
    out
}

fn names(shape: &Shape) -> Vec<String> {
    shape.iter().map(|s| s.2.clone()).collect()
}

struct FakeSource {
    rows: RefCell<Vec<AssetRow>>,
}

impl FakeSource {
    fn new(rows: Vec<AssetRow>) -> Self {
        Self {
            rows: RefCell::new(rows),
        }
    }
}

impl AssetSource for FakeSource {
    fn all_assets(&self) -> Result<Vec<AssetRow>, StoreError> {
        Ok(self.rows.borrow().clone())
    }
    fn asset(&self, id: &str) -> Result<Option<AssetRow>, StoreError> {
        Ok(self.rows.borrow().iter().find(|r| r.id == id).cloned())
    }
}

fn updated(id: &str) -> ChangeSet {
    changes(&[(id, ChangeKind::Updated)])
}

fn changes(list: &[(&str, ChangeKind)]) -> ChangeSet {
    ChangeSet {
        seq: 1,
        origin: Origin::Apply,
        changes: list
            .iter()
            .map(|(id, kind)| Change {
                entity: Entity::Asset,
                id: (*id).to_owned(),
                kind: *kind,
            })
            .collect(),
        asset_ids: list.iter().map(|(id, _)| (*id).to_owned()).collect(),
    }
}

#[test]
fn folders_come_first_and_each_level_is_in_natural_order() {
    let index = TreeIndex::build(sample());
    let shape = shape(&index);
    assert_eq!(
        names(&shape),
        [
            "",
            "a",
            "sub",
            "x.txt",
            "img2.png",
            "img10.png",
            "b.txt",
            "Z.txt",
            "photos",
            "p",
            "1.png",
            "2.png"
        ]
    );
}

#[test]
fn the_project_root_comes_first_and_external_roots_follow_by_key() {
    let mut rows = sample();
    rows.push(row("b1", "z-root", "f.txt", Status::Todo, false));
    rows.push(row("b2", "A-root", "f.txt", Status::Todo, false));
    let index = TreeIndex::build(rows);
    let roots: Vec<_> = index
        .roots()
        .iter()
        .map(|r| index.node(*r).name.clone())
        .collect();
    assert_eq!(roots, ["", "A-root", "photos", "z-root"]);
    assert!(
        index
            .roots()
            .iter()
            .all(|r| index.node(*r).kind == NodeKind::Root && index.node(*r).depth == 0)
    );
}

#[test]
fn folder_totals_equal_the_assets_below_and_missing_ones_count() {
    let index = TreeIndex::build(sample());
    let by_name = |name: &str| {
        index
            .nodes()
            .iter()
            .find(|n| n.name == name && n.kind != NodeKind::Asset)
            .map(|n| (n.total, n.done))
            .unwrap()
    };
    assert_eq!(by_name("a"), (3, 0));
    assert_eq!(by_name("sub"), (1, 0));
    assert_eq!(by_name("photos"), (2, 1));
    assert_eq!(by_name(""), (5, 0));
}

#[test]
fn by_id_and_order_agree_with_the_tree() {
    let index = TreeIndex::build(sample());
    assert_eq!(index.asset_count(), 7);
    let ids: Vec<_> = index
        .order()
        .iter()
        .map(|i| index.node(*i).asset.as_ref().unwrap().id.clone())
        .collect();
    assert_eq!(ids, ["a5", "a3", "a2", "a1", "a4", "a6", "a7"]);
    for id in &ids {
        let at = index.find(id).unwrap();
        assert_eq!(index.node(at).asset.as_ref().unwrap().id, *id);
    }
    assert_eq!(index.find("nope"), None);
}

#[test]
fn the_same_rows_give_the_same_tree_whatever_the_input_order() {
    let mut reversed = sample();
    reversed.reverse();
    assert_eq!(
        shape(&TreeIndex::build(sample())),
        shape(&TreeIndex::build(reversed))
    );
}

#[test]
fn a_status_change_is_patched_in_place_and_equals_a_rebuild() {
    let source = FakeSource::new(sample());
    let mut index = TreeIndex::build(sample());
    let generation = index.generation();
    source.rows.borrow_mut()[2].status = Status::Done; // a3 = a/img2.png
    source.rows.borrow_mut()[5].status = Status::Todo; // a6 を戻す
    index.note_changes(&changes(&[
        ("a3", ChangeKind::Updated),
        ("a6", ChangeKind::Updated),
    ]));
    assert!(!index.is_stale());
    index.refresh(&source).unwrap();
    assert_eq!(index.generation(), generation, "部分更新では世代は進まない");
    assert_eq!(
        shape(&index),
        shape(&TreeIndex::build(source.all_assets().unwrap()))
    );
    let a3 = index.find("a3").unwrap();
    assert_eq!(index.node(a3).asset.as_ref().unwrap().status, Status::Done);
}

#[test]
fn missing_and_media_type_are_patched_without_changing_totals() {
    let source = FakeSource::new(sample());
    let mut index = TreeIndex::build(sample());
    source.rows.borrow_mut()[0].missing = true;
    source.rows.borrow_mut()[0].media_type = Some("x/y".to_owned());
    index.note_changes(&updated("a1"));
    index.refresh(&source).unwrap();
    let a1 = index.node(index.find("a1").unwrap()).asset.clone().unwrap();
    assert!(a1.missing);
    assert_eq!(a1.media_type.as_deref(), Some("x/y"));
    assert_eq!(
        shape(&index),
        shape(&TreeIndex::build(source.all_assets().unwrap()))
    );
}

#[test]
fn adding_or_deleting_rebuilds_and_advances_the_generation() {
    let source = FakeSource::new(sample());
    let mut index = TreeIndex::build(sample());
    let generation = index.generation();
    source.rows.borrow_mut().push(todo("n1", "new/f.txt"));
    index.note_changes(&changes(&[("n1", ChangeKind::Created)]));
    assert!(index.is_stale());
    index.refresh(&source).unwrap();
    assert!(index.generation() > generation);
    assert!(index.find("n1").is_some());
    assert_eq!(index.asset_count(), 8);

    let generation = index.generation();
    source.rows.borrow_mut().retain(|r| r.id != "a1");
    index.note_changes(&changes(&[("a1", ChangeKind::Deleted)]));
    index.refresh(&source).unwrap();
    assert!(index.generation() > generation);
    assert!(index.find("a1").is_none());
}

#[test]
fn a_moved_path_rebuilds_so_the_order_stays_correct() {
    let source = FakeSource::new(sample());
    let mut index = TreeIndex::build(sample());
    let generation = index.generation();
    source.rows.borrow_mut()[0].rel_path = "a/aaa.txt".to_owned();
    index.note_changes(&updated("a1"));
    index.refresh(&source).unwrap();
    assert!(index.generation() > generation);
    assert_eq!(
        shape(&index),
        shape(&TreeIndex::build(source.all_assets().unwrap()))
    );
}

#[test]
fn changes_to_other_entities_are_ignored() {
    let mut index = TreeIndex::build(sample());
    let mut set = updated("a1");
    set.changes[0].entity = Entity::Annotation;
    index.note_changes(&set);
    assert!(!index.is_stale());
    index.refresh(&FakeSource::new(sample())).unwrap();
}

// --- 元に戻す・やり直しへの追従（T074）---

fn project_with_folders(files: &[(&str, &str)]) -> (support::TempDir, ProjectStore) {
    let dir = support::TempDir::new();
    ProjectStore::create(dir.path(), support::system_config(dir.path()))
        .unwrap()
        .close(None)
        .map_err(|failed| failed.error)
        .unwrap();
    {
        let conn = Connection::open(dir.path().join(".unnotator/project.db")).unwrap();
        for (id, path) in files {
            support::insert_asset(&conn, id, path);
        }
    }
    let store = support::open_store(dir.path());
    (dir, store)
}

fn follow(index: &mut TreeIndex, store: &ProjectStore, set: &ChangeSet) {
    index.note_changes(set);
    index.refresh(store).unwrap();
    assert_eq!(
        shape(index),
        shape(&TreeIndex::build(store.all_assets().unwrap())),
        "索引は再構築した結果と一致する"
    );
}

#[test]
fn undo_and_redo_of_a_status_change_keep_the_index_equal_to_a_rebuild() {
    let (_dir, mut store) =
        project_with_folders(&[("x1", "d/a.txt"), ("x2", "d/b.txt"), ("x3", "c.txt")]);
    let mut index = TreeIndex::build(store.all_assets().unwrap());
    let generation = index.generation();

    let set = store
        .apply_command(Command::SetAssetStatus {
            asset_id: "x1".into(),
            status: Status::Done,
        })
        .unwrap();
    follow(&mut index, &store, &set);
    let folder = index.nodes().iter().find(|n| n.name == "d").unwrap();
    assert_eq!((folder.total, folder.done), (2, 1));

    let set = store.undo().unwrap().expect("元に戻せる");
    assert_eq!(set.origin, Origin::Undo);
    follow(&mut index, &store, &set);
    let folder = index.nodes().iter().find(|n| n.name == "d").unwrap();
    assert_eq!((folder.total, folder.done), (2, 0));

    let set = store.redo().unwrap().expect("やり直せる");
    follow(&mut index, &store, &set);
    let folder = index.nodes().iter().find(|n| n.name == "d").unwrap();
    assert_eq!((folder.total, folder.done), (2, 1));
    assert_eq!(
        index.generation(),
        generation,
        "状態だけの変更は再構築しない"
    );
}
