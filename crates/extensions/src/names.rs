//! 名前空間つきの名前（`<拡張機能の ID>/<名前>`）と、参照の解決。
//!
//! 宣言の `id`（局所名）に拡張機能の ID を付けたものが完全な名前で、保存データの種別 ID もこの形になる。
//! 参照（スキーマの `$defs/ref`）は、局所名・`<拡張機能の ID>/<名前>`・`core/<名前>` のどれかで書かれる。

use std::collections::BTreeSet;
use std::fmt;

use serde::{Deserialize, Serialize};

/// `contributes` の宣言の種類（`id` を持ち、名前空間つきで引けるもの）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContributionKind {
    MediaType,
    Editor,
    Previewer,
    ItemProvider,
    AnnotationType,
    RelationType,
    GroupType,
    Tool,
    Command,
    View,
    StatusBarItem,
    Exporter,
    Importer,
    /// リボンのタブ（`contributes.ribbon.tabs[].id`）。
    RibbonTab,
}

impl ContributionKind {
    /// 宣言を持つ種類のすべて。
    pub const ALL: &'static [ContributionKind] = &[
        Self::MediaType,
        Self::Editor,
        Self::Previewer,
        Self::ItemProvider,
        Self::AnnotationType,
        Self::RelationType,
        Self::GroupType,
        Self::Tool,
        Self::Command,
        Self::View,
        Self::StatusBarItem,
        Self::Exporter,
        Self::Importer,
        Self::RibbonTab,
    ];

    /// マニフェストの `contributes` のキー（`RibbonTab` は `ribbon.tabs`）。
    pub fn key(self) -> &'static str {
        match self {
            Self::MediaType => "mediaTypes",
            Self::Editor => "editors",
            Self::Previewer => "previewers",
            Self::ItemProvider => "itemProviders",
            Self::AnnotationType => "annotationTypes",
            Self::RelationType => "relationTypes",
            Self::GroupType => "groupTypes",
            Self::Tool => "tools",
            Self::Command => "commands",
            Self::View => "views",
            Self::StatusBarItem => "statusBarItems",
            Self::Exporter => "exporters",
            Self::Importer => "importers",
            Self::RibbonTab => "ribbon.tabs",
        }
    }
}

/// 完全な名前。`ext` は拡張機能の ID、またはコアを表す `core`。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct QualifiedId {
    ext: String,
    name: String,
}

impl QualifiedId {
    pub fn new(ext: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            ext: ext.into(),
            name: name.into(),
        }
    }

    /// `<ext>/<name>` を解釈する。区切りがちょうど 1 つで、両側が空でなければ `Some`。
    pub fn parse(text: &str) -> Option<Self> {
        let (ext, name) = text.split_once('/')?;
        if ext.is_empty() || name.is_empty() || name.contains('/') {
            return None;
        }
        Some(Self::new(ext, name))
    }

    pub fn extension(&self) -> &str {
        &self.ext
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn is_core(&self) -> bool {
        self.ext == "core"
    }
}

impl fmt::Display for QualifiedId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.ext, self.name)
    }
}

/// 局所名から完全な名前を作る。
pub fn qualify(extension_id: &str, local: &str) -> String {
    format!("{extension_id}/{local}")
}

// ---- 参照の場所 ----------------------------------------------------------------

/// 参照（`$defs/ref`）を持つ場所と、指す先の種類。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RefPlace {
    /// 正規化した JSON ポインター（`normalize_pointer` の結果）。
    pub pattern: &'static str,
    pub target: ContributionKind,
    /// 自分に宣言が無いとき、コアのもの（`core/<名前>`）とみなすか。コマンドやタブ（`tool.activate`・`home`）。
    pub core_fallback: bool,
}

const fn place(pattern: &'static str, target: ContributionKind, core_fallback: bool) -> RefPlace {
    RefPlace {
        pattern,
        target,
        core_fallback,
    }
}

/// スキーマの `$defs/ref` の出現箇所の全部（テストが、スキーマを歩いた結果との一致を確かめる）。
pub const REF_PLACES: &[RefPlace] = &[
    place(
        "/contributes/annotationTypes/*/mediaTypes/*",
        ContributionKind::MediaType,
        false,
    ),
    place(
        "/contributes/editors/*/mediaTypes/*",
        ContributionKind::MediaType,
        false,
    ),
    place(
        "/contributes/exporters/*/annotationTypes/*",
        ContributionKind::AnnotationType,
        false,
    ),
    place(
        "/contributes/importers/*/annotationTypes/*",
        ContributionKind::AnnotationType,
        false,
    ),
    place(
        "/contributes/groupTypes/*/members/*",
        ContributionKind::AnnotationType,
        false,
    ),
    place(
        "/contributes/itemProviders/*/mediaTypes/*",
        ContributionKind::MediaType,
        false,
    ),
    place(
        "/contributes/keybindings/*/command",
        ContributionKind::Command,
        true,
    ),
    place(
        "/contributes/mediaTypes/*/itemProvider",
        ContributionKind::ItemProvider,
        false,
    ),
    place(
        "/contributes/previewers/*/mediaTypes/*",
        ContributionKind::MediaType,
        false,
    ),
    place(
        "/contributes/relationTypes/*/from/*",
        ContributionKind::AnnotationType,
        false,
    ),
    place(
        "/contributes/relationTypes/*/to/*",
        ContributionKind::AnnotationType,
        false,
    ),
    place(
        "/contributes/ribbon/contextualTabs/*/groups/*/items/*/command",
        ContributionKind::Command,
        true,
    ),
    place(
        "/contributes/ribbon/contextualTabs/*/groups/*/items/*/tool",
        ContributionKind::Tool,
        false,
    ),
    place(
        "/contributes/ribbon/groups/*/items/*/command",
        ContributionKind::Command,
        true,
    ),
    place(
        "/contributes/ribbon/groups/*/items/*/tool",
        ContributionKind::Tool,
        false,
    ),
    place(
        "/contributes/ribbon/groups/*/tab",
        ContributionKind::RibbonTab,
        true,
    ),
    place(
        "/contributes/ribbon/tabs/*/groups/*/items/*/command",
        ContributionKind::Command,
        true,
    ),
    place(
        "/contributes/ribbon/tabs/*/groups/*/items/*/tool",
        ContributionKind::Tool,
        false,
    ),
    place(
        "/contributes/statusBarItems/*/command",
        ContributionKind::Command,
        true,
    ),
    place(
        "/contributes/tools/*/annotationType",
        ContributionKind::AnnotationType,
        false,
    ),
    place(
        "/contributes/tools/*/editor",
        ContributionKind::Editor,
        false,
    ),
];

/// 配列の添字を `*` にし、入れ子の `items/*` を 1 段にまとめる。
pub fn normalize_pointer(pointer: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for segment in pointer.split('/').skip(1) {
        let segment = if !segment.is_empty() && segment.bytes().all(|b| b.is_ascii_digit()) {
            "*"
        } else {
            segment
        };
        let n = out.len();
        if segment == "items" && n >= 2 && out[n - 2] == "items" && out[n - 1] == "*" {
            // `…/items/*` のあとに `items` が続く: 入れ子の items は、次の `*` と合わせて飛ばす
            out.push("\u{0}skip-items");
            continue;
        }
        if segment == "*" && out.last() == Some(&"\u{0}skip-items") {
            out.pop();
            continue;
        }
        out.push(segment);
    }
    let mut text = String::new();
    for segment in out {
        text.push('/');
        text.push_str(segment);
    }
    text
}

/// 参照の場所（正規化済みの JSON ポインター）から、表の項目を引く。
pub fn ref_place(normalized_pointer: &str) -> Option<&'static RefPlace> {
    REF_PLACES.iter().find(|p| p.pattern == normalized_pointer)
}

// ---- 参照の解決 ----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefError {
    /// 指す先の宣言が見つからない。
    Unresolved { reference: String },
    /// 依存に書かれていない拡張機能の宣言を指している。
    NotADependency { extension: String },
}

pub struct RefContext<'a> {
    /// 参照を書いた拡張機能の ID。
    pub own_id: &'a str,
    /// 解決済みの依存先の ID。
    pub dependencies: &'a BTreeSet<String>,
    /// 完全な名前の宣言があるか。
    pub declared: &'a dyn Fn(ContributionKind, &str) -> bool,
}

/// 参照 `raw` を、完全な名前に直す。
pub fn resolve_ref(
    raw: &str,
    kind: ContributionKind,
    core_fallback: bool,
    ctx: &RefContext<'_>,
) -> Result<String, RefError> {
    let unresolved = || RefError::Unresolved {
        reference: raw.to_owned(),
    };
    if raw.contains('/') {
        let id = QualifiedId::parse(raw).ok_or_else(unresolved)?;
        if id.is_core() {
            return Ok(raw.to_owned());
        }
        if id.extension() == ctx.own_id || ctx.dependencies.contains(id.extension()) {
            return if (ctx.declared)(kind, raw) {
                Ok(raw.to_owned())
            } else {
                Err(unresolved())
            };
        }
        return Err(RefError::NotADependency {
            extension: id.extension().to_owned(),
        });
    }
    let own = qualify(ctx.own_id, raw);
    if (ctx.declared)(kind, &own) {
        Ok(own)
    } else if core_fallback {
        Ok(format!("core/{raw}"))
    } else {
        Err(unresolved())
    }
}
