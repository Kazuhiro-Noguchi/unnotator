//! ツリーのフィルター（名前・状態・媒体種別・リンク切れ）。条件同士は AND、状態と媒体種別の中は OR。
//! 設計は `specs/007-tree-preview/data-model.md` の `TreeFilter`。

use serde::{Deserialize, Serialize};

use crate::command::Status;

use super::{Node, order};

/// 媒体種別の選択。媒体の中身は知らず、ID（不透明な文字列）か「不明」だけを扱う。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum MediaSel {
    /// 媒体種別が判定できない（「不明」）もの。
    Unknown,
    Is(String),
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TreeFilter {
    /// 名前の一部（大文字小文字・全角半角を区別しない）。空白だけなら条件なし。
    pub name: Option<String>,
    /// 空は条件なし。複数は OR。
    pub statuses: Vec<Status>,
    /// 空は条件なし。複数は OR。
    pub media_types: Vec<MediaSel>,
    /// `Some(true)` = リンク切れだけ、`Some(false)` = 無いものだけ。
    pub missing: Option<bool>,
}

impl TreeFilter {
    fn needle(&self) -> Option<String> {
        let folded = order::fold(self.name.as_deref()?.trim());
        (!folded.is_empty()).then_some(folded)
    }

    /// 何か条件があるか。
    pub fn is_active(&self) -> bool {
        self.needle().is_some()
            || !self.statuses.is_empty()
            || !self.media_types.is_empty()
            || self.missing.is_some()
    }

    /// 比べる前の準備（名前の畳み込みを 1 回で済ませる）。
    pub(crate) fn compile(&self) -> CompiledFilter<'_> {
        CompiledFilter {
            needle: self.needle(),
            filter: self,
        }
    }
}

pub(crate) struct CompiledFilter<'a> {
    needle: Option<String>,
    filter: &'a TreeFilter,
}

impl CompiledFilter<'_> {
    /// アセットのノードが、すべての条件に合うか。
    pub(crate) fn matches(&self, node: &Node) -> bool {
        let Some(asset) = node.asset.as_ref() else {
            return false;
        };
        let f = self.filter;
        if let Some(needle) = &self.needle
            && !node.folded.contains(needle.as_str())
        {
            return false;
        }
        if !f.statuses.is_empty() && !f.statuses.contains(&asset.status) {
            return false;
        }
        if !f.media_types.is_empty()
            && !f
                .media_types
                .iter()
                .any(|sel| match (sel, &asset.media_type) {
                    (MediaSel::Unknown, None) => true,
                    (MediaSel::Is(want), Some(have)) => want == have,
                    _ => false,
                })
        {
            return false;
        }
        if let Some(missing) = f.missing
            && asset.missing != missing
        {
            return false;
        }
        true
    }
}
