//! 前 / 次 / 次の未完了の探索。ツリーの行の順序（フォルダ先・自然順の深さ優先）と同じ並びで探す。
//! フォルダの開閉には影響されない。設計は `specs/007-tree-preview/data-model.md` の `Neighbor`。

use serde::{Deserialize, Serialize};

use crate::command::Status;

use super::{TreeFilter, TreeIndex};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum Direction {
    Prev,
    Next,
}

/// 探索の結果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Neighbor {
    /// 見つかったアセット。無ければ `None`（端に達した）。
    pub asset_id: Option<String>,
    /// 条件に合ったのに、リンク切れで飛ばした数。
    pub skipped_missing: u32,
    /// 端に達して、見つからなかった。
    pub reached_end: bool,
}

impl TreeIndex {
    /// `from` の次 / 前のアセットを返す。`from` が無い・知らないときは、先頭 / 末尾から探す。
    /// `filter` に合うものだけを辿る（`from` 自身は条件の外でもよい）。端では止まり、先頭に戻らない。
    pub fn neighbor(
        &self,
        from: Option<&str>,
        direction: Direction,
        unfinished_only: bool,
        filter: &TreeFilter,
    ) -> Neighbor {
        let order = self.order();
        let compiled = filter.compile();
        let start = from
            .and_then(|id| self.find(id))
            .and_then(|at| order.iter().position(|n| *n == at));
        let mut skipped_missing = 0u32;
        let mut visit = |position: usize| -> Option<Neighbor> {
            let node = self.node(order[position]);
            let asset = node.asset.as_ref()?;
            if !compiled.matches(node) || (unfinished_only && asset.status == Status::Done) {
                return None;
            }
            if asset.missing {
                skipped_missing += 1;
                return None;
            }
            Some(Neighbor {
                asset_id: Some(asset.id.clone()),
                skipped_missing,
                reached_end: false,
            })
        };
        let found = match direction {
            Direction::Next => {
                let first = start.map_or(0, |p| p + 1);
                (first..order.len()).find_map(&mut visit)
            }
            Direction::Prev => {
                let end = start.unwrap_or(order.len());
                (0..end).rev().find_map(&mut visit)
            }
        };
        found.unwrap_or(Neighbor {
            asset_id: None,
            skipped_missing,
            reached_end: true,
        })
    }
}
