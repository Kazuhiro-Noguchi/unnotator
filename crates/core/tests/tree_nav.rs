//! 前 / 次 / 次の未完了の探索。`specs/007-tree-preview/data-model.md` の `Neighbor`。
#![allow(clippy::unwrap_used, clippy::expect_used)]

use unnotator_core::assets::AssetRow;
use unnotator_core::assets::tree::{Direction, MediaSel, TreeFilter, TreeIndex, ViewSpec};
use unnotator_core::command::Status;

fn row(id: &str, path: &str, status: Status, missing: bool, media: Option<&str>) -> AssetRow {
    AssetRow {
        id: id.to_owned(),
        root_key: String::new(),
        rel_path: path.to_owned(),
        media_type: media.map(str::to_owned),
        file_size: 1,
        mtime_ms: 1,
        status,
        missing,
    }
}

/// ツリーの順序（深さ優先、フォルダ先・自然順）は a1 a2 a3 a4 a5 a6 a7。
fn sample() -> TreeIndex {
    TreeIndex::build(vec![
        row("a1", "a/f1.txt", Status::Done, false, Some("x/text")),
        row("a2", "a/f2.txt", Status::Todo, false, Some("x/text")),
        row("a3", "a/f3.txt", Status::Done, true, Some("x/text")),
        row("a4", "a/f4.txt", Status::Review, false, Some("x/image")),
        row("a5", "b/f5.txt", Status::InProgress, true, None),
        row("a6", "b/f6.txt", Status::Done, false, None),
        row("a7", "z.txt", Status::Todo, false, Some("x/text")),
    ])
}

fn none() -> TreeFilter {
    TreeFilter::default()
}

fn next(index: &TreeIndex, from: Option<&str>) -> Option<String> {
    index
        .neighbor(from, Direction::Next, false, &none(), &[])
        .asset_id
}

#[test]
fn the_order_matches_the_tree_rows() {
    let index = sample();
    let flat = index.flatten(&ViewSpec {
        expanded_folders: ["", "a", "b"]
            .iter()
            .map(|p| unnotator_core::assets::tree::NodeKey {
                root_key: String::new(),
                path: (*p).to_owned(),
            })
            .collect(),
        ..ViewSpec::default()
    });
    let ids: Vec<String> = flat
        .window(&index, 0, 100)
        .unwrap()
        .into_iter()
        .filter_map(|r| match r {
            unnotator_core::assets::tree::TreeRow::Asset { id, .. } => Some(id),
            _ => None,
        })
        .collect();
    let mut walked = Vec::new();
    let mut cursor = None;
    // 欠けたものも含めて辿るため、リンク切れの飛ばしを避けて確かめる（missing を許す別の探索）。
    while let Some(id) = index
        .neighbor(cursor.as_deref(), Direction::Next, false, &none(), &[])
        .asset_id
    {
        walked.push(id.clone());
        cursor = Some(id);
    }
    let visible_not_missing: Vec<String> = ids
        .into_iter()
        .filter(|id| id != "a3" && id != "a5")
        .collect();
    assert_eq!(walked, visible_not_missing);
}

#[test]
fn next_walks_forward_in_order_and_skips_missing_files() {
    let index = sample();
    assert_eq!(next(&index, Some("a1")).as_deref(), Some("a2"));
    let result = index.neighbor(Some("a2"), Direction::Next, false, &none(), &[]);
    assert_eq!(result.asset_id.as_deref(), Some("a4"));
    assert_eq!(result.skipped_missing, 1);
    assert!(!result.reached_end);
}

#[test]
fn prev_walks_backward_and_skips_missing_files() {
    let index = sample();
    let result = index.neighbor(Some("a4"), Direction::Prev, false, &none(), &[]);
    assert_eq!(result.asset_id.as_deref(), Some("a2"));
    assert_eq!(result.skipped_missing, 1);
}

#[test]
fn from_nothing_starts_at_the_first_or_last() {
    let index = sample();
    assert_eq!(next(&index, None).as_deref(), Some("a1"));
    let last = index.neighbor(None, Direction::Prev, false, &none(), &[]);
    assert_eq!(last.asset_id.as_deref(), Some("a7"));
}

#[test]
fn it_stops_at_the_ends_instead_of_wrapping() {
    let index = sample();
    let end = index.neighbor(Some("a7"), Direction::Next, false, &none(), &[]);
    assert_eq!((end.asset_id, end.reached_end), (None, true));
    let start = index.neighbor(Some("a1"), Direction::Prev, false, &none(), &[]);
    assert_eq!((start.asset_id, start.reached_end), (None, true));
}

#[test]
fn next_unfinished_skips_done_and_includes_review_and_in_progress() {
    let index = sample();
    let result = index.neighbor(Some("a1"), Direction::Next, true, &none(), &[]);
    assert_eq!(result.asset_id.as_deref(), Some("a2"));
    let result = index.neighbor(Some("a2"), Direction::Next, true, &none(), &[]);
    assert_eq!(result.asset_id.as_deref(), Some("a4"), "要確認は未完了");
    // a4 の次は、a5（作業中だがリンク切れ）を飛ばして a6（完了）も飛ばし、a7
    let result = index.neighbor(Some("a4"), Direction::Next, true, &none(), &[]);
    assert_eq!(result.asset_id.as_deref(), Some("a7"));
    assert_eq!(result.skipped_missing, 1);
}

#[test]
fn a_missing_file_that_would_not_qualify_is_not_counted_as_skipped() {
    let index = sample();
    // a3 は完了済みのリンク切れ。未完了の探索では、そもそも対象外なので数えない。
    let result = index.neighbor(Some("a2"), Direction::Next, true, &none(), &[]);
    assert_eq!(result.asset_id.as_deref(), Some("a4"));
    assert_eq!(result.skipped_missing, 0);
}

#[test]
fn no_unfinished_left_reports_the_end() {
    let index = sample();
    let result = index.neighbor(Some("a7"), Direction::Next, true, &none(), &[]);
    assert!(result.reached_end);
    assert_eq!(result.asset_id, None);
}

#[test]
fn the_filter_decides_what_is_walked() {
    let index = sample();
    let images_and_text = TreeFilter {
        media_types: vec![MediaSel::Is("x/image".to_owned()), MediaSel::Unknown],
        ..TreeFilter::default()
    };
    let result = index.neighbor(Some("a2"), Direction::Next, false, &images_and_text, &[]);
    assert_eq!(result.asset_id.as_deref(), Some("a4"));
    let result = index.neighbor(Some("a4"), Direction::Next, false, &images_and_text, &[]);
    assert_eq!(
        result.asset_id.as_deref(),
        Some("a6"),
        "a5 はリンク切れで飛ばす"
    );
    assert_eq!(result.skipped_missing, 1);
}

#[test]
fn the_starting_point_may_be_outside_the_filter() {
    let index = sample();
    let only_done = TreeFilter {
        statuses: vec![Status::Done],
        ..TreeFilter::default()
    };
    // a2 は Todo で条件の外。その次の、条件に合う a3 はリンク切れなので飛ばして a6
    let result = index.neighbor(Some("a2"), Direction::Next, false, &only_done, &[]);
    assert_eq!(result.asset_id.as_deref(), Some("a6"));
}

#[test]
fn an_unknown_starting_asset_starts_from_the_beginning() {
    let index = sample();
    assert_eq!(next(&index, Some("nope")).as_deref(), Some("a1"));
}

#[test]
fn it_does_not_depend_on_which_folders_are_open() {
    let index = sample();
    let closed = index.neighbor(Some("a1"), Direction::Next, false, &none(), &[]);
    assert_eq!(closed.asset_id.as_deref(), Some("a2"));
}

#[test]
fn an_empty_tree_has_no_neighbor() {
    let index = TreeIndex::build(vec![]);
    let result = index.neighbor(None, Direction::Next, false, &none(), &[]);
    assert!(result.asset_id.is_none() && result.reached_end);
}

#[test]
fn item_unit_media_types_stay_in_the_unfinished_search_even_when_the_asset_is_done() {
    let index = sample();
    // a6 は完了の「不明」。a6 が item 単位の媒体なら、完了でも対象に残る（画面がアイテムで調べる）。
    let with = index.neighbor(
        Some("a4"),
        Direction::Next,
        true,
        &none(),
        &["x/image".to_owned(), "x/text".to_owned()],
    );
    assert_eq!(with.asset_id.as_deref(), Some("a7"));
    let all_item = index.neighbor(
        Some("a1"),
        Direction::Next,
        true,
        &none(),
        &["x/text".to_owned()],
    );
    assert_eq!(all_item.asset_id.as_deref(), Some("a2"));
    let done_text = TreeIndex::build(vec![
        row("d1", "a.txt", Status::Todo, false, Some("x/text")),
        row("d2", "b.txt", Status::Done, false, Some("x/text")),
    ]);
    let kept = done_text.neighbor(
        Some("d1"),
        Direction::Next,
        true,
        &none(),
        &["x/text".to_owned()],
    );
    assert_eq!(kept.asset_id.as_deref(), Some("d2"));
    let dropped = done_text.neighbor(Some("d1"), Direction::Next, true, &none(), &[]);
    assert!(dropped.reached_end);
}

#[test]
fn the_found_asset_reports_its_media_type_and_status() {
    let index = sample();
    let found = index.neighbor(Some("a1"), Direction::Next, false, &none(), &[]);
    assert_eq!(found.media_type.as_deref(), Some("x/text"));
    assert_eq!(found.status, Some(Status::Todo));
    let end = index.neighbor(Some("a7"), Direction::Next, false, &none(), &[]);
    assert_eq!((end.media_type, end.status), (None, None));
}
