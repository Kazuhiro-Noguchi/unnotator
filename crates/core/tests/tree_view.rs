//! アセットツリーの見え方（開閉・窓・位置の検索）。
//! `specs/007-tree-preview/data-model.md` の `TreeView`・`TreeRow`・`TreeWindow`。
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::HashSet;

use unnotator_core::assets::AssetRow;
use unnotator_core::assets::tree::{NodeKey, TreeIndex, TreeRow, ViewSpec};
use unnotator_core::command::Status;

fn row(id: &str, root: &str, path: &str, status: Status) -> AssetRow {
    AssetRow {
        id: id.to_owned(),
        root_key: root.to_owned(),
        rel_path: path.to_owned(),
        media_type: None,
        file_size: 1,
        mtime_ms: 1,
        status,
        missing: false,
    }
}

fn sample() -> TreeIndex {
    TreeIndex::build(vec![
        row("a1", "", "b.txt", Status::Todo),
        row("a2", "", "a/img10.png", Status::Done),
        row("a3", "", "a/img2.png", Status::Todo),
        row("a4", "", "a/sub/x.txt", Status::Todo),
        row("a5", "photos", "p/1.png", Status::Todo),
    ])
}

fn key(root: &str, path: &str) -> NodeKey {
    NodeKey {
        root_key: root.to_owned(),
        path: path.to_owned(),
    }
}

fn spec(open: &[(&str, &str)]) -> ViewSpec {
    ViewSpec {
        expanded_folders: open.iter().map(|(r, p)| key(r, p)).collect::<HashSet<_>>(),
        ..ViewSpec::default()
    }
}

/// 行を `深さ 名前` の文字列にして、並びを見やすくする。
fn lines(rows: &[TreeRow]) -> Vec<String> {
    rows.iter()
        .map(|r| match r {
            TreeRow::Root { name, depth, .. }
            | TreeRow::Folder { name, depth, .. }
            | TreeRow::Asset { name, depth, .. } => format!("{depth} {name}"),
            TreeRow::ItemSlot { index, depth, .. } => format!("{depth} #{index}"),
            TreeRow::ItemLoading { depth, .. } => format!("{depth} …"),
        })
        .collect()
}

fn all(index: &TreeIndex, spec: &ViewSpec) -> Vec<TreeRow> {
    let flat = index.flatten(spec);
    flat.window(index, 0, 500).unwrap()
}

#[test]
fn roots_alone_are_shown_when_nothing_is_open() {
    let index = sample();
    let flat = index.flatten(&ViewSpec::default());
    assert_eq!(flat.total(), 2);
    let rows = flat.window(&index, 0, 10).unwrap();
    assert_eq!(lines(&rows), ["0 ", "0 photos"]);
    match &rows[0] {
        TreeRow::Root {
            expanded,
            total,
            done,
            root_key,
            ..
        } => {
            assert!(!expanded);
            assert_eq!((*total, *done), (4, 1));
            assert_eq!(root_key, "");
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn opening_folders_adds_their_children_in_order_with_depth() {
    let index = sample();
    let rows = all(&index, &spec(&[("", ""), ("", "a")]));
    assert_eq!(
        lines(&rows),
        [
            "0 ",
            "1 a",
            "2 sub",
            "2 img2.png",
            "2 img10.png",
            "1 b.txt",
            "0 photos"
        ]
    );
}

#[test]
fn a_folder_row_carries_its_key_expanded_flag_and_totals() {
    let index = sample();
    let rows = all(&index, &spec(&[("", ""), ("", "a")]));
    match &rows[1] {
        TreeRow::Folder {
            root_key,
            path,
            expanded,
            total,
            done,
            ..
        } => {
            assert_eq!((root_key.as_str(), path.as_str()), ("", "a"));
            assert!(*expanded);
            assert_eq!((*total, *done), (3, 1));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn an_asset_row_carries_its_state() {
    let index = sample();
    let rows = all(&index, &spec(&[("", ""), ("", "a")]));
    match &rows[4] {
        TreeRow::Asset {
            id,
            status,
            missing,
            expanded,
            pinned,
            ..
        } => {
            assert_eq!(id, "a2");
            assert_eq!(*status, Status::Done);
            assert!(!missing && !expanded && !pinned);
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_folder_inside_a_closed_folder_stays_hidden_even_if_marked_open() {
    let index = sample();
    let rows = all(&index, &spec(&[("", "a/sub")]));
    assert_eq!(lines(&rows), ["0 ", "0 photos"]);
}

#[test]
fn closing_a_folder_removes_its_rows() {
    let index = sample();
    let open = all(&index, &spec(&[("", ""), ("", "a")])).len();
    let closed = all(&index, &spec(&[("", "")])).len();
    assert_eq!(open - closed, 3);
}

#[test]
fn a_window_returns_the_slice_and_is_empty_past_the_end() {
    let index = sample();
    let spec = spec(&[("", ""), ("", "a")]);
    let flat = index.flatten(&spec);
    assert_eq!(flat.total(), 7);
    let rows = flat.window(&index, 2, 3).unwrap();
    assert_eq!(lines(&rows), ["2 sub", "2 img2.png", "2 img10.png"]);
    assert!(flat.window(&index, 7, 5).unwrap().is_empty());
    assert!(flat.window(&index, 100, 5).unwrap().is_empty());
    assert_eq!(flat.window(&index, 5, 100).unwrap().len(), 2);
}

#[test]
fn a_window_is_capped_at_five_hundred_rows() {
    let rows: Vec<AssetRow> = (0..700)
        .map(|i| row(&format!("x{i}"), "", &format!("f{i:04}.txt"), Status::Todo))
        .collect();
    let index = TreeIndex::build(rows);
    let flat = index.flatten(&spec(&[("", "")]));
    assert_eq!(flat.total(), 701);
    assert_eq!(flat.window(&index, 0, 10_000).unwrap().len(), 500);
}

#[test]
fn a_flat_view_from_before_a_rebuild_is_stale() {
    let mut index = sample();
    let flat = index.flatten(&ViewSpec::default());
    assert!(flat.window(&index, 0, 5).is_some());
    let source = Rows(vec![row("n", "", "n.txt", Status::Todo)]);
    index.note_changes(&unnotator_core::event::ChangeSet {
        seq: 1,
        origin: unnotator_core::event::Origin::Sync,
        changes: vec![unnotator_core::event::Change {
            entity: unnotator_core::event::Entity::Asset,
            id: "n".into(),
            kind: unnotator_core::event::ChangeKind::Created,
        }],
        asset_ids: vec!["n".into()],
    });
    index.refresh(&source).unwrap();
    assert!(flat.window(&index, 0, 5).is_none());
}

struct Rows(Vec<AssetRow>);
impl unnotator_core::assets::tree::AssetSource for Rows {
    fn all_assets(&self) -> Result<Vec<AssetRow>, unnotator_core::error::StoreError> {
        Ok(self.0.clone())
    }
    fn asset(&self, id: &str) -> Result<Option<AssetRow>, unnotator_core::error::StoreError> {
        Ok(self.0.iter().find(|r| r.id == id).cloned())
    }
}

#[test]
fn the_pinned_asset_is_marked() {
    let index = sample();
    let mut spec = spec(&[("", ""), ("", "a")]);
    spec.pinned = Some("a3".to_owned());
    let rows = all(&index, &spec);
    let pinned: Vec<_> = rows
        .iter()
        .filter_map(|r| match r {
            TreeRow::Asset { id, pinned, .. } if *pinned => Some(id.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(pinned, ["a3"]);
}

// --- 位置の検索（T014）---

#[test]
fn locate_gives_the_row_of_a_visible_asset() {
    let index = sample();
    let spec = spec(&[("", ""), ("", "a")]);
    let located = index.flatten(&spec).locate(&index, "a3").unwrap();
    assert_eq!(located.row, Some(3));
    assert_eq!(
        located.ancestors,
        [key("", ""), key("", "a")],
        "祖先はルートから順に"
    );
}

#[test]
fn locate_of_a_hidden_asset_gives_the_ancestors_to_open() {
    let index = sample();
    let located = index
        .flatten(&ViewSpec::default())
        .locate(&index, "a4")
        .unwrap();
    assert_eq!(located.row, None);
    assert_eq!(
        located.ancestors,
        [key("", ""), key("", "a"), key("", "a/sub")]
    );
}

#[test]
fn locate_of_an_unknown_asset_is_none() {
    let index = sample();
    assert!(
        index
            .flatten(&ViewSpec::default())
            .locate(&index, "zz")
            .is_none()
    );
}

#[test]
fn locate_follows_the_view_after_a_state_patch_without_changing_rows() {
    let mut index = sample();
    let spec = spec(&[("", ""), ("", "a")]);
    let before = index.flatten(&spec).locate(&index, "a3").unwrap().row;
    let mut changed = vec![
        row("a1", "", "b.txt", Status::Todo),
        row("a2", "", "a/img10.png", Status::Done),
        row("a3", "", "a/img2.png", Status::Done),
        row("a4", "", "a/sub/x.txt", Status::Todo),
        row("a5", "photos", "p/1.png", Status::Todo),
    ];
    changed.rotate_left(0);
    index.note_changes(&unnotator_core::event::ChangeSet {
        seq: 1,
        origin: unnotator_core::event::Origin::Apply,
        changes: vec![unnotator_core::event::Change {
            entity: unnotator_core::event::Entity::Asset,
            id: "a3".into(),
            kind: unnotator_core::event::ChangeKind::Updated,
        }],
        asset_ids: vec!["a3".into()],
    });
    index.refresh(&Rows(changed)).unwrap();
    let flat = index.flatten(&spec);
    assert_eq!(flat.locate(&index, "a3").unwrap().row, before);
    // 窓の集計は、部分更新のあとの値と一致する。
    let rows = flat.window(&index, 0, 500).unwrap();
    match &rows[1] {
        TreeRow::Folder { done, .. } => assert_eq!(*done, 2),
        other => panic!("{other:?}"),
    }
}

// --- アイテムの枠（T046）---

use unnotator_core::assets::tree::ExpandedAsset;

fn with_items(open: &[(&str, &str)], items: &[(&str, Option<u32>)]) -> ViewSpec {
    let mut s = spec(open);
    s.expanded_assets = items
        .iter()
        .map(|(id, total)| ExpandedAsset {
            asset_id: (*id).to_owned(),
            item_total: *total,
        })
        .collect();
    s
}

#[test]
fn item_slots_follow_their_asset_one_level_deeper() {
    let index = sample();
    let rows = all(
        &index,
        &with_items(&[("", ""), ("", "a")], &[("a3", Some(3))]),
    );
    assert_eq!(
        lines(&rows),
        [
            "0 ",
            "1 a",
            "2 sub",
            "2 img2.png",
            "3 #0",
            "3 #1",
            "3 #2",
            "2 img10.png",
            "1 b.txt",
            "0 photos"
        ]
    );
    match &rows[3] {
        TreeRow::Asset { expanded, .. } => assert!(expanded),
        other => panic!("{other:?}"),
    }
    match &rows[4] {
        TreeRow::ItemSlot {
            asset_id, index, ..
        } => {
            assert_eq!((asset_id.as_str(), *index), ("a3", 0));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn an_unknown_total_gives_one_loading_row() {
    let index = sample();
    let rows = all(&index, &with_items(&[("", ""), ("", "a")], &[("a3", None)]));
    assert_eq!(lines(&rows).iter().filter(|l| l.contains('…')).count(), 1);
    assert!(
        rows.iter()
            .any(|r| matches!(r, TreeRow::ItemLoading { asset_id, depth: 3 } if asset_id == "a3"))
    );
}

#[test]
fn a_zero_total_adds_no_rows_and_a_closed_folder_hides_its_slots() {
    let index = sample();
    let with_zero = all(
        &index,
        &with_items(&[("", ""), ("", "a")], &[("a3", Some(0))]),
    );
    let plain = all(&index, &spec(&[("", ""), ("", "a")]));
    assert_eq!(with_zero.len(), plain.len());
    let hidden = all(&index, &with_items(&[("", "")], &[("a3", Some(5))]));
    assert!(!hidden.iter().any(|r| matches!(r, TreeRow::ItemSlot { .. })));
}

#[test]
fn items_do_not_change_folder_totals_and_count_in_the_window_offsets() {
    let index = sample();
    let spec = with_items(&[("", ""), ("", "a")], &[("a3", Some(4))]);
    let flat = index.flatten(&spec);
    assert_eq!(flat.total(), 7 + 4);
    let rows = flat.window(&index, 4, 3).unwrap();
    assert_eq!(lines(&rows), ["3 #0", "3 #1", "3 #2"]);
    match &all(&index, &spec)[1] {
        TreeRow::Folder { total, .. } => assert_eq!(*total, 3),
        other => panic!("{other:?}"),
    }
}

#[test]
fn several_assets_can_be_expanded_and_locate_counts_the_slots() {
    let index = sample();
    let spec = with_items(&[("", ""), ("", "a")], &[("a3", Some(2)), ("a2", Some(1))]);
    let flat = index.flatten(&spec);
    assert_eq!(flat.locate(&index, "a3").unwrap().row, Some(3));
    assert_eq!(flat.locate(&index, "a2").unwrap().row, Some(6));
    assert_eq!(flat.total(), 7 + 3);
}
