//! ツリーの見え方（開閉）から、行の並び（`FlatView`）を作り、窓として取り出す。
//!
//! 索引の構造が作り直されると（世代が進むと）、古い `FlatView` は使えない（`window` が `None`）。
//! 設計は `specs/007-tree-preview/data-model.md` の `TreeView`・`TreeRow`・`TreeWindow`、`research.md` R4・R5。

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::command::Status;

use super::{NodeKind, TreeFilter, TreeIndex};

/// 1 回の窓で返す行の上限。
pub const MAX_WINDOW: u32 = 500;

/// フォルダ（またはルート）の識別。ルートは `path` が空。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct NodeKey {
    pub root_key: String,
    pub path: String,
}

/// アイテムの枠を挟むアセット。`item_total` が未定なら「読み込み中」の行が 1 つ入る。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ExpandedAsset {
    pub asset_id: String,
    pub item_total: Option<u32>,
}

/// 見え方の指定。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ViewSpec {
    /// 絞り込み。有効なときは、一致を含むフォルダだけが、開いた状態で残る。
    pub filter: TreeFilter,
    pub expanded_folders: HashSet<NodeKey>,
    pub expanded_assets: Vec<ExpandedAsset>,
    /// 条件から外れても残す、現在位置のアセット。
    pub pinned: Option<String>,
}

/// 窓の 1 行。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum TreeRow {
    Root {
        root_key: String,
        name: String,
        depth: u32,
        expanded: bool,
        total: u32,
        done: u32,
    },
    Folder {
        root_key: String,
        path: String,
        name: String,
        depth: u32,
        expanded: bool,
        total: u32,
        done: u32,
    },
    Asset {
        id: String,
        name: String,
        depth: u32,
        media_type: Option<String>,
        status: Status,
        missing: bool,
        expanded: bool,
        pinned: bool,
    },
    /// アイテムの枠。中身は画面が提供元から埋める。
    ItemSlot {
        asset_id: String,
        index: u32,
        depth: u32,
    },
    ItemLoading {
        asset_id: String,
        depth: u32,
    },
}

/// `locate` の結果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Located {
    /// 見えているときの行の位置。
    pub row: Option<u32>,
    /// 開くべき祖先（ルートから順）。
    pub ancestors: Vec<NodeKey>,
}

#[derive(Debug, Clone, Copy)]
enum FlatRow {
    Node(u32),
    ItemSlot { asset: u32, index: u32 },
    ItemLoading(u32),
}

#[derive(Debug)]
pub struct FlatView {
    generation: u64,
    rows: Vec<FlatRow>,
    expanded_assets: HashSet<String>,
    pinned: Option<String>,
    expanded_folders: HashSet<NodeKey>,
    /// フィルターが有効なとき、見えているフォルダはすべて開いている。
    filter_active: bool,
}

impl TreeIndex {
    /// 開閉の指定から、見える行の並びを作る。
    pub fn flatten(&self, spec: &ViewSpec) -> FlatView {
        let item_totals: HashMap<&str, Option<u32>> = spec
            .expanded_assets
            .iter()
            .map(|e| (e.asset_id.as_str(), e.item_total))
            .collect();
        let keep = self.keep_set(spec);
        let active = keep.is_some();
        let kept = |at: u32| keep.as_ref().is_none_or(|k| k[at as usize]);
        let mut rows = Vec::new();
        // 深さ優先。スタックには (添字, そのフォルダのパス) を積む。
        let mut stack: Vec<(u32, String)> = self
            .roots()
            .iter()
            .rev()
            .filter(|at| kept(**at))
            .map(|at| (*at, String::new()))
            .collect();
        while let Some((at, path)) = stack.pop() {
            let node = self.node(at);
            rows.push(FlatRow::Node(at));
            match node.kind {
                NodeKind::Asset => {
                    if let Some(data) = node.asset.as_ref()
                        && let Some(total) = item_totals.get(data.id.as_str())
                    {
                        match total {
                            Some(count) => {
                                for index in 0..*count {
                                    rows.push(FlatRow::ItemSlot { asset: at, index });
                                }
                            }
                            None => rows.push(FlatRow::ItemLoading(at)),
                        }
                    }
                }
                NodeKind::Root | NodeKind::Folder => {
                    let key = NodeKey {
                        root_key: self.root_key_of(at),
                        path: path.clone(),
                    };
                    if active || spec.expanded_folders.contains(&key) {
                        for child in node.children.iter().rev().filter(|c| kept(**c)) {
                            let child_node = self.node(*child);
                            let child_path = if child_node.kind == NodeKind::Folder {
                                if path.is_empty() {
                                    child_node.name.clone()
                                } else {
                                    format!("{path}/{}", child_node.name)
                                }
                            } else {
                                String::new()
                            };
                            stack.push((*child, child_path));
                        }
                    }
                }
            }
        }
        FlatView {
            generation: self.generation(),
            rows,
            expanded_assets: item_totals.keys().map(|s| (*s).to_owned()).collect(),
            pinned: spec.pinned.clone(),
            expanded_folders: spec.expanded_folders.clone(),
            filter_active: active,
        }
    }

    /// フィルターが有効なとき、残すノード（一致するアセットと、現在位置のアセット、その祖先）。
    fn keep_set(&self, spec: &ViewSpec) -> Option<Vec<bool>> {
        if !spec.filter.is_active() {
            return None;
        }
        let compiled = spec.filter.compile();
        let mut keep = vec![false; self.nodes().len()];
        for at in self.order() {
            let node = self.node(*at);
            let pinned = spec
                .pinned
                .as_deref()
                .is_some_and(|id| node.asset.as_ref().is_some_and(|a| a.id == id));
            keep[*at as usize] = pinned || compiled.matches(node);
        }
        // 親は子より前に作られているので、後ろから親へ伝える。
        for at in (0..self.nodes().len()).rev() {
            if keep[at]
                && let Some(parent) = self.node(u32::try_from(at).unwrap_or(u32::MAX)).parent
            {
                keep[parent as usize] = true;
            }
        }
        Some(keep)
    }

    /// ルートのキー（プロジェクトのフォルダは空）。
    fn root_key_of(&self, mut at: u32) -> String {
        while let Some(parent) = self.node(at).parent {
            at = parent;
        }
        self.node(at).name.clone()
    }

    /// フォルダの、ルートからの相対パス。ルートは空。
    fn folder_path(&self, at: u32) -> String {
        let mut names = Vec::new();
        let mut cursor = at;
        while let Some(parent) = self.node(cursor).parent {
            names.push(self.node(cursor).name.as_str());
            cursor = parent;
        }
        names.reverse();
        names.join("/")
    }

    /// ルートから、そのノードの親までのキー（ルートを含む）。
    fn ancestors_of(&self, at: u32) -> Vec<NodeKey> {
        let root_key = self.root_key_of(at);
        let mut chain = Vec::new();
        let mut cursor = self.node(at).parent;
        while let Some(parent) = cursor {
            chain.push(parent);
            cursor = self.node(parent).parent;
        }
        chain.reverse();
        chain
            .into_iter()
            .map(|p| NodeKey {
                root_key: root_key.clone(),
                path: self.folder_path(p),
            })
            .collect()
    }
}

impl FlatView {
    /// 見える行の数。
    pub fn total(&self) -> u32 {
        u32::try_from(self.rows.len()).unwrap_or(u32::MAX)
    }

    /// 窓を返す。索引が作り直されていたら（世代が違えば）`None`。`limit` は `MAX_WINDOW` まで。
    pub fn window(&self, index: &TreeIndex, offset: u32, limit: u32) -> Option<Vec<TreeRow>> {
        if index.generation() != self.generation {
            return None;
        }
        let start = (offset as usize).min(self.rows.len());
        let end = start
            .saturating_add(limit.min(MAX_WINDOW) as usize)
            .min(self.rows.len());
        Some(
            self.rows[start..end]
                .iter()
                .filter_map(|row| self.to_row(index, *row))
                .collect(),
        )
    }

    fn to_row(&self, index: &TreeIndex, row: FlatRow) -> Option<TreeRow> {
        Some(match row {
            FlatRow::Node(at) => {
                let node = index.node(at);
                match node.kind {
                    NodeKind::Root => {
                        let key = NodeKey {
                            root_key: node.name.clone(),
                            path: String::new(),
                        };
                        TreeRow::Root {
                            root_key: node.name.clone(),
                            name: node.name.clone(),
                            depth: node.depth,
                            expanded: self.filter_active || self.expanded_folders.contains(&key),
                            total: node.total,
                            done: node.done,
                        }
                    }
                    NodeKind::Folder => {
                        let key = NodeKey {
                            root_key: index.root_key_of(at),
                            path: index.folder_path(at),
                        };
                        TreeRow::Folder {
                            root_key: key.root_key.clone(),
                            path: key.path.clone(),
                            name: node.name.clone(),
                            depth: node.depth,
                            expanded: self.filter_active || self.expanded_folders.contains(&key),
                            total: node.total,
                            done: node.done,
                        }
                    }
                    NodeKind::Asset => {
                        let data = node.asset.clone()?;
                        TreeRow::Asset {
                            expanded: self.expanded_assets.contains(&data.id),
                            pinned: self.pinned.as_deref() == Some(data.id.as_str()),
                            id: data.id,
                            name: node.name.clone(),
                            depth: node.depth,
                            media_type: data.media_type,
                            status: data.status,
                            missing: data.missing,
                        }
                    }
                }
            }
            FlatRow::ItemSlot { asset, index: slot } => {
                let node = index.node(asset);
                TreeRow::ItemSlot {
                    asset_id: asset_id(node),
                    index: slot,
                    depth: node.depth + 1,
                }
            }
            FlatRow::ItemLoading(asset) => {
                let node = index.node(asset);
                TreeRow::ItemLoading {
                    asset_id: asset_id(node),
                    depth: node.depth + 1,
                }
            }
        })
    }

    /// アセットの行の位置（見えていれば）と、開くべき祖先。知らないアセットは `None`。
    pub fn locate(&self, index: &TreeIndex, asset_id: &str) -> Option<Located> {
        let at = index.find(asset_id)?;
        let row = self
            .rows
            .iter()
            .position(|r| matches!(r, FlatRow::Node(n) if *n == at))
            .and_then(|p| u32::try_from(p).ok());
        Some(Located {
            row,
            ancestors: index.ancestors_of(at),
        })
    }
}

fn asset_id(node: &super::Node) -> String {
    node.asset
        .as_ref()
        .map(|a| a.id.clone())
        .unwrap_or_default()
}
