//! 008 の読み取り（現在位置の詳細・アノテーションの全ページ・ラベル・影響の件数）の性能（SC-003・SC-004、原則 VII）。
//! 通常のテストでは走らせない。
//!
//! ```text
//! cargo test -p unnotator-core --test query_perf --release -- --ignored --nocapture
//! ```
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::time::Instant;

use support::new_project;
use unnotator_core::command::{AttributeScope, Command, Target};

const COUNT: usize = 5000;

fn ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

#[test]
#[ignore = "性能の計測。--release で、手で走らせる"]
fn reads_stay_fast_with_5000_annotations_on_one_asset() {
    let (_dir, mut store) = new_project(&["a1"]);
    let commands = (0..COUNT)
        .map(|i| Command::CreateAnnotation {
            id: None,
            target: Target {
                asset_id: "a1".into(),
                item: None,
            },
            annotation_type: "dev/measure".into(),
            type_version: None,
            selector_json: "{}".into(),
            label_id: None,
            attributes_json: Some("{\"k\":1}".into()),
            summary: Some(format!("measure {i}")),
            z_order: None,
            source: None,
        })
        .collect();
    let started = Instant::now();
    store
        .apply_command(Command::Transaction { commands })
        .unwrap();
    println!("{COUNT} 件の作成（1 つの操作）: {:.0} ms", ms(started));

    let mut times = Vec::new();
    for _ in 0..50 {
        let started = Instant::now();
        let details = store.target_details("a1", None).unwrap().unwrap();
        times.push(ms(started));
        assert_eq!(details.annotation_count as usize, COUNT);
    }
    times.sort_by(f64::total_cmp);
    println!(
        "target_details: 中央値 {:.2} ms 最大 {:.2} ms",
        times[times.len() / 2],
        times.last().copied().unwrap_or(0.0)
    );

    let started = Instant::now();
    let mut cursor = None;
    let mut rows = 0;
    let mut pages = 0;
    loop {
        let page = store.annotations_page("a1", None, cursor.as_ref()).unwrap();
        rows += page.rows.len();
        pages += 1;
        match page.next {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    println!(
        "annotations_page の全ページ: {pages} ページ {rows} 件 {:.1} ms",
        ms(started)
    );
    assert_eq!(rows, COUNT);

    let started = Instant::now();
    let usage = store
        .attribute_usage(AttributeScope::Global, "", &["k".to_owned()])
        .unwrap();
    println!("attribute_usage: {usage} 件 {:.1} ms", ms(started));
    let started = Instant::now();
    let labels = store.list_labels().unwrap();
    println!("list_labels: {} 件 {:.2} ms", labels.len(), ms(started));
}
