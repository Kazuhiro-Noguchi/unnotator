//! 10 万件のツリーの索引の計測（`#[ignore]`）。結果は `specs/007-tree-preview/perf.md` に書く。
//! 実行: `cargo test -p unnotator-core --release -- --ignored tree_perf --nocapture`
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::time::Instant;

use unnotator_core::assets::AssetRow;
use unnotator_core::assets::tree::{AssetSource, NodeKey, TreeFilter, TreeIndex, ViewSpec};
use unnotator_core::command::Status;
use unnotator_core::error::StoreError;
use unnotator_core::event::{Change, ChangeKind, ChangeSet, Entity, Origin};

const COUNT: usize = 100_000;

fn rows() -> Vec<AssetRow> {
    (0..COUNT)
        .map(|i| AssetRow {
            id: format!("id-{i:06}"),
            root_key: String::new(),
            rel_path: format!("dir{:03}/sub{:02}/img{}.png", i % 500, (i / 500) % 10, i),
            media_type: Some("x/image".to_owned()),
            file_size: 1,
            mtime_ms: 1,
            status: if i % 3 == 0 {
                Status::Done
            } else {
                Status::Todo
            },
            missing: false,
        })
        .collect()
}

struct Rows(RefCell<HashMap<String, AssetRow>>);
impl AssetSource for Rows {
    fn all_assets(&self) -> Result<Vec<AssetRow>, StoreError> {
        Ok(self.0.borrow().values().cloned().collect())
    }
    fn asset(&self, id: &str) -> Result<Option<AssetRow>, StoreError> {
        Ok(self.0.borrow().get(id).cloned())
    }
}

#[test]
#[ignore = "計測。--ignored で実行する"]
fn tree_perf_100k() {
    let data = rows();

    let started = Instant::now();
    let mut index = TreeIndex::build(data.clone());
    let build = started.elapsed();
    println!("構築（10 万件）: {build:?}");

    let mut open: HashSet<NodeKey> = HashSet::new();
    open.insert(NodeKey {
        root_key: String::new(),
        path: String::new(),
    });
    for d in 0..500 {
        open.insert(NodeKey {
            root_key: String::new(),
            path: format!("dir{d:03}"),
        });
    }
    let spec = ViewSpec {
        expanded_folders: open,
        ..ViewSpec::default()
    };
    let started = Instant::now();
    let flat = index.flatten(&spec);
    println!(
        "見え方の作成（行 {}）: {:?}",
        flat.total(),
        started.elapsed()
    );

    let started = Instant::now();
    for k in 0..100 {
        let offset = (k * 487) % flat.total().saturating_sub(120).max(1);
        let rows = flat.window(&index, offset, 120).unwrap();
        assert!(!rows.is_empty());
    }
    println!(
        "窓の取得（120 行 × 100 回）の平均: {:?}",
        started.elapsed() / 100
    );

    // 全部開いた見え方（10 万行超）
    let mut everything = HashSet::new();
    everything.insert(NodeKey {
        root_key: String::new(),
        path: String::new(),
    });
    for d in 0..500 {
        everything.insert(NodeKey {
            root_key: String::new(),
            path: format!("dir{d:03}"),
        });
        for sub in 0..10 {
            everything.insert(NodeKey {
                root_key: String::new(),
                path: format!("dir{d:03}/sub{sub:02}"),
            });
        }
    }
    let started = Instant::now();
    let big = index.flatten(&ViewSpec {
        expanded_folders: everything,
        ..ViewSpec::default()
    });
    println!(
        "全部開いた見え方（行 {}）: {:?}",
        big.total(),
        started.elapsed()
    );
    let started = Instant::now();
    for k in 0..100 {
        let offset = (k * 1009) % big.total().saturating_sub(120).max(1);
        assert!(!big.window(&index, offset, 120).unwrap().is_empty());
    }
    println!(
        "窓の取得（全部開いた、120 行 × 100 回）の平均: {:?}",
        started.elapsed() / 100
    );

    // フィルター（名前の一部 + 状態）
    let filtered = ViewSpec {
        filter: TreeFilter {
            name: Some("ＩＭＧ99".to_owned()),
            statuses: vec![Status::Todo],
            ..TreeFilter::default()
        },
        ..ViewSpec::default()
    };
    let started = Instant::now();
    let flat = index.flatten(&filtered);
    println!(
        "フィルター（名前 + 状態、行 {}）: {:?}",
        flat.total(),
        started.elapsed()
    );

    // 状態の部分更新（実際のストアは ID で 1 件読む。ここは表引きの偽物）
    let source = Rows(RefCell::new(
        data.into_iter().map(|r| (r.id.clone(), r)).collect(),
    ));
    let started = Instant::now();
    for k in 0..100 {
        let id = format!("id-{:06}", k * 7 + 1);
        if let Some(row) = source.0.borrow_mut().get_mut(&id) {
            row.status = Status::Done;
        }
        index.note_changes(&ChangeSet {
            seq: 1,
            origin: Origin::Apply,
            changes: vec![Change {
                entity: Entity::Asset,
                id: id.clone(),
                kind: ChangeKind::Updated,
            }],
            asset_ids: vec![id],
        });
        index.refresh(&source).unwrap();
    }
    println!(
        "状態の部分更新（反映まで、1 回）の平均: {:?}",
        started.elapsed() / 100
    );

    // 再構築
    let started = Instant::now();
    index.note_changes(&ChangeSet {
        seq: 2,
        origin: Origin::Sync,
        changes: vec![Change {
            entity: Entity::Asset,
            id: "x".to_owned(),
            kind: ChangeKind::Created,
        }],
        asset_ids: vec![],
    });
    index.refresh(&source).unwrap();
    println!("再構築（10 万件）: {:?}", started.elapsed());
}
