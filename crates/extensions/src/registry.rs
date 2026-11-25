//! 登録簿: 有効な拡張機能の宣言を、名前空間つきで引ける形にまとめる。
//!
//! 登録簿は不変の値で、導入済みの集合と状態から `Registry::build` で作り直す（同じ入力から、同じ結果）。
//! 1 つの拡張機能の失敗は、他の拡張機能を妨げない（`Problem` として残り、その拡張機能だけが無効になる）。

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use unnotator_core::extensions_list::compare_versions;

use crate::manifest::Manifest;
use crate::manifest::text::Locales;
use crate::names::{
    ContributionKind, RefContext, RefError, normalize_pointer, qualify, ref_place, resolve_ref,
};
use crate::state::ExtensionsState;

/// 導入の経路。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Origin {
    /// `.unnoplugin` の取り込み。
    Installed,
    /// 開発者モードで読み込んだフォルダ。
    Dev,
}

/// ディスクから読んだ、まだ検討していない拡張機能。
#[derive(Debug, Clone, PartialEq)]
pub struct RawExtension {
    pub id: String,
    pub version: String,
    pub dir: PathBuf,
    pub origin: Origin,
    pub manifest: Manifest,
    pub locales: Locales,
    pub locale_warnings: Vec<String>,
}

impl RawExtension {
    pub fn new(dir: PathBuf, origin: Origin, manifest: Manifest) -> Self {
        Self {
            id: manifest.id.clone(),
            version: manifest.version.clone(),
            dir,
            origin,
            manifest,
            locales: Locales::new(),
            locale_warnings: Vec::new(),
        }
    }

    pub fn with_locales(mut self, locales: Locales, warnings: Vec<String>) -> Self {
        self.locales = locales;
        self.locale_warnings = warnings;
        self
    }
}

pub struct RegistryInput<'a> {
    pub installed: &'a [RawExtension],
    pub state: &'a ExtensionsState,
    pub app_api_version: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DisabledReason {
    /// 利用者が無効にした。
    UserDisabled,
    /// 依存先が無効。
    DependencyDisabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionStatus {
    /// 有効。`order` は有効化の順番（依存先が先）。
    Enabled {
        order: usize,
    },
    Disabled(DisabledReason),
    /// 問題があり、有効にならない（理由は `Registry::problems`）。
    Invalid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProblemKind {
    /// 取り込みの検査。
    Package,
    ManifestSchema,
    /// スキーマで書けない確認（重複・予約 ID・`workUnit` など）。
    ManifestSemantic,
    SelectorSchema,
    UnresolvedReference,
    NotADependency,
    MissingDependency,
    DependencyVersion,
    DependencyDisabled,
    /// 依存先が（問題があって）有効にならない。
    DependencyInvalid,
    Engine,
    Cycle,
    PinnedVersionMissing,
    /// 警告。拡張機能は無効にならない。
    Locale,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub extension_id: String,
    pub version: Option<String>,
    pub kind: ProblemKind,
    /// マニフェスト内の位置（JSON ポインター。無ければ空）。
    pub pointer: String,
    pub message: String,
    /// 構造化した詳細（必要な範囲・入っている版・循環の経路・欠けた ID など）。
    pub detail: Option<Value>,
}

/// 名前空間つきで引ける宣言。
#[derive(Debug, Clone, PartialEq)]
pub struct Contribution {
    pub extension_id: String,
    pub kind: ContributionKind,
    /// 完全な名前（`<拡張機能の ID>/<名前>`）。
    pub id: String,
    /// 参照を解決した宣言。`qualifiedId` を足してある。
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExtensionEntry {
    pub id: String,
    pub version: String,
    pub dir: PathBuf,
    pub origin: Origin,
    pub manifest: Manifest,
    pub status: ExtensionStatus,
}

#[derive(Debug, Clone, Default)]
pub struct Registry {
    entries: Vec<ExtensionEntry>,
    order: Vec<String>,
    contributions: BTreeMap<(ContributionKind, String), Contribution>,
    resolved: BTreeMap<String, Value>,
    locales: BTreeMap<String, Locales>,
    problems: Vec<Problem>,
}

impl Registry {
    pub fn extensions(&self) -> &[ExtensionEntry] {
        &self.entries
    }

    pub fn entry(&self, id: &str) -> Option<&ExtensionEntry> {
        self.entries.iter().find(|e| e.id == id)
    }

    /// 有効な拡張機能の ID を、有効化の順（依存先が先）に。
    pub fn order(&self) -> &[String] {
        &self.order
    }

    pub fn problems(&self) -> &[Problem] {
        &self.problems
    }

    pub fn contribution(&self, kind: ContributionKind, qualified: &str) -> Option<&Contribution> {
        self.contributions.get(&(kind, qualified.to_owned()))
    }

    /// 種類ごとの宣言を、完全な名前の昇順で。
    pub fn contributions(&self, kind: ContributionKind) -> Vec<&Contribution> {
        self.contributions
            .iter()
            .filter(|((k, _), _)| *k == kind)
            .map(|(_, c)| c)
            .collect()
    }

    /// 参照を解決したマニフェスト（有効な拡張機能だけ）。
    pub fn resolved_manifest(&self, id: &str) -> Option<&Value> {
        self.resolved.get(id)
    }

    /// `%キー%` を、その拡張機能の翻訳で解決する。
    pub fn text(&self, id: &str, text: &str, language: &str) -> String {
        match self.locales.get(id) {
            Some(locales) => locales.resolve(text, language),
            None => text.to_owned(),
        }
    }

    pub fn build(input: RegistryInput<'_>) -> Registry {
        let mut registry = Registry::default();
        let chosen = choose(input.installed);
        for (order, raw) in chosen.iter().enumerate() {
            registry.add(raw, order);
        }
        registry.problems.sort_by(|a, b| {
            (&a.extension_id, &a.pointer, &a.message).cmp(&(
                &b.extension_id,
                &b.pointer,
                &b.message,
            ))
        });
        registry
    }

    fn add(&mut self, raw: &RawExtension, order: usize) {
        let manifest = &raw.manifest;
        let mut problems = local_checks(raw);
        let mut resolved = manifest.raw.clone();
        if problems.is_empty() {
            let own = own_declarations(manifest);
            let dependencies: BTreeSet<String> = manifest.dependencies.keys().cloned().collect();
            let known: BTreeSet<(ContributionKind, String)> = self
                .contributions
                .keys()
                .cloned()
                .chain(
                    own.iter()
                        .map(|(kind, local)| (*kind, qualify(&raw.id, local))),
                )
                .collect();
            let exists =
                |kind: ContributionKind, name: &str| known.contains(&(kind, name.to_owned()));
            let ctx = RefContext {
                own_id: &raw.id,
                dependencies: &dependencies,
                declared: &exists,
            };
            resolve_refs(&mut resolved, &mut String::new(), &ctx, raw, &mut problems);
        }
        let status = if problems.is_empty() {
            ExtensionStatus::Enabled { order }
        } else {
            ExtensionStatus::Invalid
        };
        if problems.is_empty() {
            self.register(raw, &resolved);
            self.order.push(raw.id.clone());
        }
        for warning in &raw.locale_warnings {
            problems.push(problem(raw, ProblemKind::Locale, "", warning.clone(), None));
        }
        self.problems.extend(problems);
        self.locales.insert(raw.id.clone(), raw.locales.clone());
        self.entries.push(ExtensionEntry {
            id: raw.id.clone(),
            version: raw.version.clone(),
            dir: raw.dir.clone(),
            origin: raw.origin,
            manifest: manifest.clone(),
            status,
        });
        self.entries.sort_by(|a, b| a.id.cmp(&b.id));
    }

    /// 解決済みの宣言を、種類ごとに登録する。
    fn register(&mut self, raw: &RawExtension, resolved: &Value) {
        for kind in ContributionKind::ALL {
            for item in declaration_items(resolved, *kind) {
                let Some(local) = item.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let qualified = qualify(&raw.id, local);
                let mut value = item.clone();
                value["qualifiedId"] = json!(qualified);
                self.contributions.insert(
                    (*kind, qualified.clone()),
                    Contribution {
                        extension_id: raw.id.clone(),
                        kind: *kind,
                        id: qualified,
                        value,
                    },
                );
            }
        }
        self.resolved.insert(raw.id.clone(), resolved.clone());
    }
}

fn problem(
    raw: &RawExtension,
    kind: ProblemKind,
    pointer: &str,
    message: String,
    detail: Option<Value>,
) -> Problem {
    Problem {
        extension_id: raw.id.clone(),
        version: Some(raw.version.clone()),
        kind,
        pointer: pointer.to_owned(),
        message,
        detail,
    }
}

/// ID ごとに、最も新しい版を選ぶ（依存の解決は `resolve.rs`）。
fn choose(installed: &[RawExtension]) -> Vec<&RawExtension> {
    let mut latest: BTreeMap<&str, &RawExtension> = BTreeMap::new();
    for raw in installed {
        let newer = match latest.get(raw.id.as_str()) {
            None => true,
            Some(current) => {
                compare_versions(&raw.version, &current.version)
                    .unwrap_or_else(|| raw.version.cmp(&current.version))
                    == std::cmp::Ordering::Greater
            }
        };
        if newer {
            latest.insert(raw.id.as_str(), raw);
        }
    }
    // 依存先が先になるように並べる（簡易。循環・欠落は resolve.rs が扱う）
    let mut ordered: Vec<&RawExtension> = Vec::new();
    let mut visiting = BTreeSet::new();
    fn visit<'a>(
        id: &str,
        latest: &BTreeMap<&str, &'a RawExtension>,
        ordered: &mut Vec<&'a RawExtension>,
        visiting: &mut BTreeSet<String>,
    ) {
        let Some(raw) = latest.get(id) else { return };
        if ordered.iter().any(|r| r.id == id) || !visiting.insert(id.to_owned()) {
            return;
        }
        for dep in raw.manifest.dependencies.keys() {
            visit(dep, latest, ordered, visiting);
        }
        ordered.push(raw);
    }
    for id in latest.keys() {
        visit(id, &latest, &mut ordered, &mut visiting);
    }
    ordered
}

/// 自分の宣言（種類と局所名）。
fn own_declarations(manifest: &Manifest) -> Vec<(ContributionKind, String)> {
    let mut out = Vec::new();
    for kind in ContributionKind::ALL {
        for item in declaration_items(&manifest.raw, *kind) {
            if let Some(local) = item.get("id").and_then(Value::as_str) {
                out.push((*kind, local.to_owned()));
            }
        }
    }
    out
}

/// `contributes` の中の、`kind` の宣言の配列。
fn declaration_items(root: &Value, kind: ContributionKind) -> Vec<&Value> {
    let contributes = &root["contributes"];
    let list = match kind {
        ContributionKind::RibbonTab => &contributes["ribbon"]["tabs"],
        other => &contributes[other.key()],
    };
    list.as_array()
        .map(|a| a.iter().collect())
        .unwrap_or_default()
}

fn declaration_pointer(kind: ContributionKind, index: usize, leaf: &str) -> String {
    match kind {
        ContributionKind::RibbonTab => format!("/contributes/ribbon/tabs/{index}/{leaf}"),
        other => format!("/contributes/{}/{index}/{leaf}", other.key()),
    }
}

/// 宣言の重複・予約 ID・`workUnit` など、スキーマで書けない確認。
fn local_checks(raw: &RawExtension) -> Vec<Problem> {
    let mut out = Vec::new();
    let id = raw.id.as_str();
    let reserved = ["unnotator", "core"]
        .iter()
        .any(|r| id == *r || id.starts_with(&format!("{r}.")));
    if reserved {
        out.push(problem(
            raw,
            ProblemKind::ManifestSemantic,
            "/id",
            format!("予約された ID は使えません: {id}"),
            None,
        ));
    }
    for kind in ContributionKind::ALL {
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        for (index, item) in declaration_items(&raw.manifest.raw, *kind)
            .into_iter()
            .enumerate()
        {
            let Some(local) = item.get("id").and_then(Value::as_str) else {
                continue;
            };
            if !seen.insert(local) {
                out.push(problem(
                    raw,
                    ProblemKind::ManifestSemantic,
                    &declaration_pointer(*kind, index, "id"),
                    format!("宣言の ID が重複しています: {local}"),
                    Some(json!({ "id": local })),
                ));
            }
            if *kind == ContributionKind::MediaType
                && item.get("workUnit").and_then(Value::as_str) == Some("item")
                && item.get("itemProvider").is_none()
            {
                out.push(problem(
                    raw,
                    ProblemKind::ManifestSemantic,
                    &declaration_pointer(*kind, index, "itemProvider"),
                    "workUnit が item の媒体種別には itemProvider が必要です".to_owned(),
                    None,
                ));
            }
        }
    }
    out
}

/// マニフェストの JSON を歩いて、参照の場所にある文字列を完全な名前に直す。
fn resolve_refs(
    value: &mut Value,
    pointer: &mut String,
    ctx: &RefContext<'_>,
    raw: &RawExtension,
    problems: &mut Vec<Problem>,
) {
    match value {
        Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                let len = pointer.len();
                pointer.push('/');
                pointer.push_str(key);
                resolve_refs(child, pointer, ctx, raw, problems);
                pointer.truncate(len);
            }
        }
        Value::Array(list) => {
            for (index, child) in list.iter_mut().enumerate() {
                let len = pointer.len();
                pointer.push('/');
                pointer.push_str(&index.to_string());
                resolve_refs(child, pointer, ctx, raw, problems);
                pointer.truncate(len);
            }
        }
        Value::String(text) => {
            let Some(place) = ref_place(&normalize_pointer(pointer)) else {
                return;
            };
            match resolve_ref(text, place.target, place.core_fallback, ctx) {
                Ok(full) => *text = full,
                Err(RefError::Unresolved { reference }) => problems.push(problem(
                    raw,
                    ProblemKind::UnresolvedReference,
                    pointer,
                    format!("参照を解決できません: {reference}"),
                    Some(json!({ "reference": reference })),
                )),
                Err(RefError::NotADependency { extension }) => problems.push(problem(
                    raw,
                    ProblemKind::NotADependency,
                    pointer,
                    format!("依存に書かれていない拡張機能を参照しています: {extension}"),
                    Some(json!({ "extension": extension })),
                )),
            }
        }
        _ => {}
    }
}
