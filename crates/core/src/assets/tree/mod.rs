//! アセットツリーの索引（並び順・フォルダの集計・フィルター・窓の取得）。
//!
//! 媒体に関係しない（憲章 I）。パス・状態・媒体種別の ID（不透明な文字列）だけを扱う。
//! 設計は `specs/007-tree-preview/data-model.md` の `TreeIndex`。

pub mod nav;
pub mod order;

use std::collections::{HashMap, HashSet};

use crate::command::Status;
use crate::error::StoreError;
use crate::event::{ChangeKind, ChangeSet, Entity};

use super::AssetRow;

/// 索引の元になる行の出どころ。ストアと、テストの偽物が実装する。
pub trait AssetSource {
    /// すべてのアセットを返す（順序は問わない）。
    fn all_assets(&self) -> Result<Vec<AssetRow>, StoreError>;
    /// ID で 1 件。
    fn asset(&self, id: &str) -> Result<Option<AssetRow>, StoreError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKind {
    /// ルート（プロジェクトのフォルダ `''` か、外部ルートのキー）。
    Root,
    Folder,
    Asset,
}

/// アセットの葉だけが持つ値。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetData {
    pub id: String,
    pub root_key: String,
    pub rel_path: String,
    pub media_type: Option<String>,
    pub status: Status,
    pub missing: bool,
}

#[derive(Debug, Clone)]
pub struct Node {
    pub kind: NodeKind,
    pub name: String,
    /// 畳み込み済みの名前（フィルターの比較用）。
    pub folded: String,
    pub parent: Option<u32>,
    pub children: Vec<u32>,
    pub depth: u32,
    /// 配下のアセットの総数と、`status = done` の数（リンク切れも数える）。アセットの葉は 1 と 0/1。
    pub total: u32,
    pub done: u32,
    pub asset: Option<AssetData>,
}

impl Node {
    fn new(kind: NodeKind, name: String, parent: Option<u32>, depth: u32) -> Self {
        Self {
            kind,
            folded: order::fold(&name),
            name,
            parent,
            children: Vec::new(),
            depth,
            total: 0,
            done: 0,
            asset: None,
        }
    }
}

#[derive(Debug)]
pub struct TreeIndex {
    nodes: Vec<Node>,
    roots: Vec<u32>,
    by_id: HashMap<String, u32>,
    order: Vec<u32>,
    generation: u64,
    stale: bool,
    dirty: HashSet<String>,
}

impl TreeIndex {
    /// 行から作る。入力の順序に依らず、同じ行からは同じ木になる。
    pub fn build(rows: Vec<AssetRow>) -> Self {
        let mut index = Self {
            nodes: Vec::with_capacity(rows.len() + rows.len() / 8 + 1),
            roots: Vec::new(),
            by_id: HashMap::with_capacity(rows.len()),
            order: Vec::with_capacity(rows.len()),
            generation: 0,
            stale: false,
            dirty: HashSet::new(),
        };
        index.fill(rows);
        index
    }

    fn fill(&mut self, rows: Vec<AssetRow>) {
        self.nodes.clear();
        self.roots.clear();
        self.by_id.clear();
        self.order.clear();

        let mut roots: HashMap<String, u32> = HashMap::new();
        // (親, 名前, フォルダか) → 添字
        let mut lookup: HashMap<(u32, String, bool), u32> = HashMap::new();
        for row in rows {
            let root = match roots.get(&row.root_key) {
                Some(at) => *at,
                None => {
                    let at = self.push(Node::new(NodeKind::Root, row.root_key.clone(), None, 0));
                    roots.insert(row.root_key.clone(), at);
                    at
                }
            };
            let segments: Vec<&str> = row.rel_path.split('/').collect();
            let mut parent = root;
            let last = segments.len().saturating_sub(1);
            for (depth, segment) in segments.iter().take(last).enumerate() {
                let key = (parent, (*segment).to_owned(), true);
                parent = match lookup.get(&key) {
                    Some(at) => *at,
                    None => {
                        let depth = u32::try_from(depth + 1).unwrap_or(u32::MAX);
                        let at = self.push(Node::new(
                            NodeKind::Folder,
                            (*segment).to_owned(),
                            Some(parent),
                            depth,
                        ));
                        self.nodes[parent as usize].children.push(at);
                        lookup.insert(key, at);
                        at
                    }
                };
            }
            let name = segments.last().copied().unwrap_or("").to_owned();
            let depth = u32::try_from(last + 1).unwrap_or(u32::MAX);
            let mut node = Node::new(NodeKind::Asset, name, Some(parent), depth);
            node.total = 1;
            node.done = u32::from(row.status == Status::Done);
            node.asset = Some(AssetData {
                id: row.id.clone(),
                root_key: row.root_key,
                rel_path: row.rel_path,
                media_type: row.media_type,
                status: row.status,
                missing: row.missing,
            });
            let at = self.push(node);
            self.nodes[parent as usize].children.push(at);
            self.by_id.insert(row.id, at);
        }

        // 集計: 親は子より前に作られるので、後ろから足し込む。
        for at in (0..self.nodes.len()).rev() {
            if let Some(parent) = self.nodes[at].parent {
                let (total, done) = (self.nodes[at].total, self.nodes[at].done);
                let parent = &mut self.nodes[parent as usize];
                parent.total += total;
                parent.done += done;
            }
        }

        // 並べ替え: フォルダが先、各グループは名前の自然順。
        for at in 0..self.nodes.len() {
            let mut children = std::mem::take(&mut self.nodes[at].children);
            children.sort_by(|a, b| {
                let (a, b) = (&self.nodes[*a as usize], &self.nodes[*b as usize]);
                (a.kind == NodeKind::Asset)
                    .cmp(&(b.kind == NodeKind::Asset))
                    .then_with(|| order::natural_cmp(&a.name, &b.name))
            });
            self.nodes[at].children = children;
        }

        let mut roots: Vec<u32> = roots.into_values().collect();
        roots.sort_by(|a, b| {
            order::natural_cmp(&self.nodes[*a as usize].name, &self.nodes[*b as usize].name)
        });
        self.roots = roots;

        // 深さ優先で、アセットの並びを作る。
        let mut stack: Vec<u32> = self.roots.iter().rev().copied().collect();
        while let Some(at) = stack.pop() {
            let node = &self.nodes[at as usize];
            if node.kind == NodeKind::Asset {
                self.order.push(at);
            } else {
                stack.extend(node.children.iter().rev().copied());
            }
        }
    }

    fn push(&mut self, node: Node) -> u32 {
        let at = u32::try_from(self.nodes.len()).unwrap_or(u32::MAX);
        self.nodes.push(node);
        at
    }

    /// 構造が作り直されるたびに進む。
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// 次の `refresh` で作り直しが要るか。
    pub fn is_stale(&self) -> bool {
        self.stale
    }

    /// 差分を受け取る。追加・削除は作り直し、更新は読み直しの印を付ける。
    pub fn note_changes(&mut self, set: &ChangeSet) {
        for change in &set.changes {
            if change.entity != Entity::Asset {
                continue;
            }
            match change.kind {
                ChangeKind::Created | ChangeKind::Deleted => self.stale = true,
                ChangeKind::Updated => {
                    self.dirty.insert(change.id.clone());
                }
            }
        }
    }

    /// 印の付いた分を反映する。パスの付け替えと追加・削除は作り直し、状態などは部分更新。
    pub fn refresh(&mut self, source: &dyn AssetSource) -> Result<(), StoreError> {
        let dirty = std::mem::take(&mut self.dirty);
        if !self.stale {
            for id in &dirty {
                let Some(at) = self.by_id.get(id).copied() else {
                    self.stale = true;
                    break;
                };
                let Some(row) = source.asset(id)? else {
                    self.stale = true;
                    break;
                };
                if !self.patch(at, row) {
                    self.stale = true;
                    break;
                }
            }
        }
        if self.stale {
            let rows = source.all_assets()?;
            self.fill(rows);
            self.generation += 1;
            self.stale = false;
        }
        Ok(())
    }

    /// 構造が変わらない更新（状態・リンク切れ・媒体種別）を、その場で反映する。
    /// パスやルートが違うときは `false`（作り直しが要る）。
    fn patch(&mut self, at: u32, row: AssetRow) -> bool {
        let Some(data) = self.nodes[at as usize].asset.as_ref() else {
            return false;
        };
        if data.root_key != row.root_key || data.rel_path != row.rel_path {
            return false;
        }
        let was_done = data.status == Status::Done;
        let now_done = row.status == Status::Done;
        if let Some(data) = self.nodes[at as usize].asset.as_mut() {
            data.status = row.status;
            data.missing = row.missing;
            data.media_type = row.media_type;
        }
        if was_done != now_done {
            let mut cursor = Some(at);
            while let Some(index) = cursor {
                let node = &mut self.nodes[index as usize];
                node.done = if now_done {
                    node.done + 1
                } else {
                    node.done.saturating_sub(1)
                };
                cursor = node.parent;
            }
        }
        true
    }

    pub fn nodes(&self) -> &[Node] {
        &self.nodes
    }

    pub fn node(&self, index: u32) -> &Node {
        &self.nodes[index as usize]
    }

    /// ルートの添字（プロジェクトのフォルダが先頭、外部ルートはキーの自然順）。
    pub fn roots(&self) -> &[u32] {
        &self.roots
    }

    /// アセットだけの深さ優先の並び（ナビゲーションの順序）。
    pub fn order(&self) -> &[u32] {
        &self.order
    }

    pub fn find(&self, asset_id: &str) -> Option<u32> {
        self.by_id.get(asset_id).copied()
    }

    /// アセットの数。
    pub fn asset_count(&self) -> usize {
        self.order.len()
    }
}
