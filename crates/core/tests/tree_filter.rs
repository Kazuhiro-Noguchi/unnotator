//! アセットツリーのフィルター。`specs/007-tree-preview/data-model.md` の `TreeFilter`。
#![allow(clippy::unwrap_used, clippy::expect_used)]

use unnotator_core::assets::AssetRow;
use unnotator_core::assets::tree::{MediaSel, TreeFilter, TreeIndex, TreeRow, ViewSpec};
use unnotator_core::command::Status;

fn row(
    id: &str,
    root: &str,
    path: &str,
    status: Status,
    media: Option<&str>,
    missing: bool,
) -> AssetRow {
    AssetRow {
        id: id.to_owned(),
        root_key: root.to_owned(),
        rel_path: path.to_owned(),
        media_type: media.map(str::to_owned),
        file_size: 1,
        mtime_ms: 1,
        status,
        missing,
    }
}

fn sample() -> TreeIndex {
    TreeIndex::build(vec![
        row("a1", "", "a/img2.png", Status::Todo, Some("x/image"), false),
        row(
            "a2",
            "",
            "a/img10.png",
            Status::Done,
            Some("x/image"),
            false,
        ),
        row(
            "a3",
            "",
            "a/notes.txt",
            Status::Review,
            Some("x/text"),
            true,
        ),
        row(
            "a4",
            "",
            "b/sub/IMG-3.png",
            Status::Todo,
            Some("x/image"),
            false,
        ),
        row("a5", "", "c/data.bin", Status::InProgress, None, false),
        row(
            "a6",
            "ext",
            "p/photo.png",
            Status::Todo,
            Some("x/image"),
            false,
        ),
    ])
}

fn view(filter: TreeFilter) -> ViewSpec {
    ViewSpec {
        filter,
        ..ViewSpec::default()
    }
}

/// フィルターを掛けたときの行を、`深さ 名前` にする。
fn lines(index: &TreeIndex, spec: &ViewSpec) -> Vec<String> {
    index
        .flatten(spec)
        .window(index, 0, 500)
        .unwrap()
        .iter()
        .map(|r| match r {
            TreeRow::Root { name, depth, .. }
            | TreeRow::Folder { name, depth, .. }
            | TreeRow::Asset { name, depth, .. } => format!("{depth} {name}"),
            _ => String::new(),
        })
        .collect()
}

fn name(text: &str) -> TreeFilter {
    TreeFilter {
        name: Some(text.to_owned()),
        ..TreeFilter::default()
    }
}

#[test]
fn an_empty_filter_changes_nothing() {
    let index = sample();
    assert!(!TreeFilter::default().is_active());
    let plain = lines(&index, &ViewSpec::default());
    assert_eq!(plain, lines(&index, &view(TreeFilter::default())));
    assert_eq!(plain, ["0 ", "0 ext"]);
}

#[test]
fn a_blank_name_is_not_a_condition() {
    assert!(!name("   ").is_active());
    assert!(!name("").is_active());
}

#[test]
fn the_name_ignores_case_and_width_and_matches_a_part() {
    let index = sample();
    let rows = lines(&index, &view(name("ＩＭＧ")));
    assert_eq!(
        rows,
        [
            "0 ",
            "1 a",
            "2 img2.png",
            "2 img10.png",
            "1 b",
            "2 sub",
            "3 IMG-3.png",
        ]
    );
    assert_eq!(
        lines(&index, &view(name("10"))),
        ["0 ", "1 a", "2 img10.png"]
    );
}

#[test]
fn folders_without_a_match_and_empty_roots_are_dropped_and_matching_ones_are_open() {
    let index = sample();
    let rows = lines(&index, &view(name("photo")));
    assert_eq!(rows, ["0 ext", "1 p", "2 photo.png"]);
}

#[test]
fn statuses_combine_with_or() {
    let index = sample();
    let filter = TreeFilter {
        statuses: vec![Status::Done, Status::Review],
        ..TreeFilter::default()
    };
    assert_eq!(
        lines(&index, &view(filter)),
        ["0 ", "1 a", "2 img10.png", "2 notes.txt"]
    );
}

#[test]
fn media_types_combine_with_or_and_unknown_is_selectable() {
    let index = sample();
    let filter = TreeFilter {
        media_types: vec![MediaSel::Is("x/text".to_owned()), MediaSel::Unknown],
        ..TreeFilter::default()
    };
    assert_eq!(
        lines(&index, &view(filter)),
        ["0 ", "1 a", "2 notes.txt", "1 c", "2 data.bin"]
    );
}

#[test]
fn missing_selects_only_or_excludes_broken_links() {
    let index = sample();
    let only = TreeFilter {
        missing: Some(true),
        ..TreeFilter::default()
    };
    assert_eq!(lines(&index, &view(only)), ["0 ", "1 a", "2 notes.txt"]);
    let without = TreeFilter {
        missing: Some(false),
        name: Some("notes".to_owned()),
        ..TreeFilter::default()
    };
    assert_eq!(lines(&index, &view(without)), Vec::<String>::new());
}

#[test]
fn different_conditions_are_anded() {
    let index = sample();
    let filter = TreeFilter {
        name: Some("img".to_owned()),
        statuses: vec![Status::Todo],
        media_types: vec![MediaSel::Is("x/image".to_owned())],
        missing: Some(false),
    };
    assert_eq!(
        lines(&index, &view(filter)),
        ["0 ", "1 a", "2 img2.png", "1 b", "2 sub", "3 IMG-3.png"]
    );
}

#[test]
fn no_match_gives_no_rows() {
    let index = sample();
    let flat = index.flatten(&view(name("zzz-nothing")));
    assert_eq!(flat.total(), 0);
    assert!(flat.window(&index, 0, 10).unwrap().is_empty());
}

#[test]
fn the_pinned_asset_stays_with_its_folders_even_when_it_does_not_match() {
    let index = sample();
    let mut spec = view(name("photo"));
    spec.pinned = Some("a5".to_owned());
    assert_eq!(
        lines(&index, &spec),
        ["0 ", "1 c", "2 data.bin", "0 ext", "1 p", "2 photo.png"]
    );
    let rows = index.flatten(&spec).window(&index, 0, 50).unwrap();
    assert!(
        rows.iter()
            .any(|r| matches!(r, TreeRow::Asset { id, pinned: true, .. } if id == "a5"))
    );
}

#[test]
fn matching_folders_report_themselves_as_open() {
    let index = sample();
    let rows = index
        .flatten(&view(name("img2")))
        .window(&index, 0, 50)
        .unwrap();
    for r in &rows {
        match r {
            TreeRow::Root { expanded, .. } | TreeRow::Folder { expanded, .. } => assert!(expanded),
            _ => {}
        }
    }
}

#[test]
fn locate_works_under_a_filter_and_hides_what_is_filtered_out() {
    let index = sample();
    let spec = view(name("img10"));
    let flat = index.flatten(&spec);
    assert_eq!(flat.locate(&index, "a2").unwrap().row, Some(2));
    assert_eq!(flat.locate(&index, "a5").unwrap().row, None);
}
