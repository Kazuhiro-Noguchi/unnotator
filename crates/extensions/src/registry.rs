//! 登録簿: 有効な拡張機能の宣言を、名前空間つきで引ける形にまとめる。
//!
//! 登録簿は不変の値で、導入済みの集合と状態から `Registry::build` で作り直す（同じ入力から、同じ結果）。
//! 1 つの拡張機能の失敗は、他の拡張機能を妨げない（`Problem` として残り、その拡張機能だけが無効になる）。

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use unnotator_core::assets::media::{MediaRule, MediaRules};
use unnotator_core::extensions_list::InstalledExtension;

use crate::manifest::Manifest;
use crate::manifest::text::Locales;
use crate::names::{
    ContributionKind, RefContext, RefError, normalize_pointer, qualify, ref_place, resolve_ref,
};
use crate::resolve::{Candidate, Reason, newest_first, resolve};
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
    /// 入っている版（新しい順）。
    pub installed_versions: Vec<String>,
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

    /// 登録簿の外で見つかった問題（読めない導入済みのフォルダなど）を足す。
    pub fn add_problems(&mut self, extra: impl IntoIterator<Item = Problem>) {
        self.problems.extend(extra);
        self.problems.sort_by(|a, b| {
            (&a.extension_id, &a.pointer, &a.message).cmp(&(
                &b.extension_id,
                &b.pointer,
                &b.message,
            ))
        });
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

    /// 004 の判定規則を作る。利用者の上書きが先頭、そのあとは完全な媒体種別 ID の昇順
    /// （導入や読み込みの順に依らず、同じ結果になる。research.md R11）。
    pub fn media_rules(&self, state: &ExtensionsState) -> MediaRules {
        let mut rules = MediaRules::new();
        for (extension, media_type) in state.media_overrides() {
            // 宣言が（無効などで）無い種別への上書きは、無視する
            if self
                .contribution(ContributionKind::MediaType, media_type)
                .is_some()
            {
                let _ = rules.push(MediaRule {
                    media_type: media_type.clone(),
                    extensions: vec![extension.clone()],
                    mime_types: Vec::new(),
                });
            }
        }
        for media in self.contributions(ContributionKind::MediaType) {
            let strings = |key: &str| -> Vec<String> {
                media
                    .value
                    .get(key)
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default()
            };
            let _ = rules.push(MediaRule {
                media_type: media.id.clone(),
                extensions: strings("extensions"),
                mime_types: strings("mimeTypes"),
            });
        }
        rules
    }

    /// 拡張子 → `Content-Type` の対応。宣言から作る（コアは MIME の表を持たない）。
    pub fn mime_rules(&self, state: &ExtensionsState) -> MimeRules {
        let mut rules = MimeRules::default();
        let first_mime = |media_type: &str| -> Option<String> {
            self.contribution(ContributionKind::MediaType, media_type)
                .and_then(|c| c.value.get("mimeTypes"))
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        for (extension, media_type) in state.media_overrides() {
            if let Some(mime) = first_mime(media_type) {
                rules.add(extension, mime);
            }
        }
        for media in self.contributions(ContributionKind::MediaType) {
            let Some(mime) = first_mime(&media.id) else {
                continue;
            };
            for extension in media
                .value
                .get("extensions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                rules.add(extension, mime.clone());
            }
        }
        rules
    }

    /// 使える（有効な）拡張機能の ID と版。004 の `extensions.json` の確認に渡す。
    pub fn installed_list(&self) -> Vec<InstalledExtension> {
        self.entries
            .iter()
            .filter(|e| matches!(e.status, ExtensionStatus::Enabled { .. }))
            .map(|e| InstalledExtension {
                id: e.id.clone(),
                version: e.version.clone(),
            })
            .collect()
    }

    pub fn build(input: RegistryInput<'_>) -> Registry {
        let mut registry = Registry::default();
        // 1. 版ごとの、他に依らない確認（重複・予約 ID）。通らない版は、解決の対象から外す
        let mut local_problems: BTreeMap<(String, String), Vec<Problem>> = BTreeMap::new();
        let mut candidates: Vec<Candidate> = Vec::new();
        // 開発中のものがある ID は、導入済みを解決の対象から外す（導入済みは消えない）
        let dev_ids: BTreeSet<&str> = input
            .installed
            .iter()
            .filter(|r| r.origin == Origin::Dev)
            .map(|r| r.id.as_str())
            .collect();
        for raw in input.installed {
            if raw.origin == Origin::Installed && dev_ids.contains(raw.id.as_str()) {
                continue;
            }
            let found = local_checks(raw);
            if found.is_empty() {
                candidates.push(Candidate {
                    id: raw.id.clone(),
                    version: raw.version.clone(),
                    engine_range: raw.manifest.engine_range.clone(),
                    dependencies: raw.manifest.dependencies.clone(),
                });
            } else {
                local_problems.insert((raw.id.clone(), raw.version.clone()), found);
            }
        }

        // 2. 依存の解決
        let resolution = resolve(
            &candidates,
            input.state.disabled(),
            input.state.pins(),
            input.app_api_version,
        );

        let find = |id: &str, version: &str| -> Option<&RawExtension> {
            input
                .installed
                .iter()
                .find(|r| r.id == id && r.version == version)
        };

        // 3. 有効化の順に、参照を解決して登録する（依存先が先に済んでいる）
        let mut order = 0;
        for (id, version) in &resolution.chosen {
            let Some(raw) = find(id, version) else {
                continue;
            };
            registry.add(raw, &mut order, input.installed);
        }

        // 4. 有効にならない ID
        for (id, (version, reason)) in &resolution.rejected {
            let versions = versions_of(input.installed, id);
            // 代表の版が、確認の段階で外れたものなら、その問題を出す
            let broken = local_problems
                .iter()
                .find(|((i, _), _)| i == id)
                .map(|(_, p)| p.clone());
            let shown = versions.first().cloned().unwrap_or_else(|| version.clone());
            let Some(raw) = find(id, &shown).or_else(|| find(id, version)) else {
                continue;
            };
            let status = match (&broken, reason.is_user_choice()) {
                (Some(_), _) => ExtensionStatus::Invalid,
                (None, true) => ExtensionStatus::Disabled(match reason {
                    Reason::UserDisabled => DisabledReason::UserDisabled,
                    _ => DisabledReason::DependencyDisabled,
                }),
                (None, false) => ExtensionStatus::Invalid,
            };
            if let Some(problems) = broken {
                registry.problems.extend(problems);
            } else if !reason.is_user_choice() {
                registry.problems.push(reason_problem(raw, reason));
            }
            registry.push_entry(raw, status, versions);
        }

        // 5. 版の確認で外れ、他の版が有効になった ID の、外れた版の問題
        for ((id, version), problems) in &local_problems {
            if registry
                .entries
                .iter()
                .any(|e| &e.id == id && &e.version == version)
            {
                continue;
            }
            if resolution.rejected.contains_key(id) {
                continue; // 4 で出した
            }
            registry.problems.extend(problems.iter().cloned());
        }

        // 6. 確認で外れた版しかない ID
        let known: BTreeSet<&str> = registry.entries.iter().map(|e| e.id.as_str()).collect();
        let mut only_broken: BTreeMap<&str, &RawExtension> = BTreeMap::new();
        for raw in input.installed {
            if !known.contains(raw.id.as_str())
                && local_problems.contains_key(&(raw.id.clone(), raw.version.clone()))
            {
                only_broken.entry(raw.id.as_str()).or_insert(raw);
            }
        }
        for (id, raw) in only_broken {
            let versions = versions_of(input.installed, id);
            registry.push_entry(raw, ExtensionStatus::Invalid, versions);
        }

        registry.entries.sort_by(|a, b| a.id.cmp(&b.id));
        registry.problems.sort_by(|a, b| {
            (&a.extension_id, &a.pointer, &a.message).cmp(&(
                &b.extension_id,
                &b.pointer,
                &b.message,
            ))
        });
        registry
    }

    fn push_entry(
        &mut self,
        raw: &RawExtension,
        status: ExtensionStatus,
        installed_versions: Vec<String>,
    ) {
        self.locales.insert(raw.id.clone(), raw.locales.clone());
        self.entries.push(ExtensionEntry {
            id: raw.id.clone(),
            version: raw.version.clone(),
            dir: raw.dir.clone(),
            origin: raw.origin,
            manifest: raw.manifest.clone(),
            status,
            installed_versions,
        });
    }

    /// 解決の済んだ拡張機能の、参照の解決と登録。依存先のどれかが有効でなければ、無効にする。
    fn add(&mut self, raw: &RawExtension, order: &mut usize, installed: &[RawExtension]) {
        let manifest = &raw.manifest;
        let mut problems = Vec::new();
        let mut resolved = manifest.raw.clone();

        // 依存先が、参照の解決の段階で無効になっていないか
        for dep in manifest.dependencies.keys() {
            let enabled = self
                .entries
                .iter()
                .any(|e| &e.id == dep && matches!(e.status, ExtensionStatus::Enabled { .. }));
            if !enabled {
                problems.push(problem(
                    raw,
                    ProblemKind::DependencyInvalid,
                    "",
                    format!("依存先が有効になりません: {dep}"),
                    Some(json!({ "dependency": dep })),
                ));
            }
        }
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
            let status = ExtensionStatus::Enabled { order: *order };
            *order += 1;
            self.register(raw, &resolved);
            self.order.push(raw.id.clone());
            status
        } else {
            ExtensionStatus::Invalid
        };
        for warning in &raw.locale_warnings {
            problems.push(problem(raw, ProblemKind::Locale, "", warning.clone(), None));
        }
        self.problems.extend(problems);
        let versions = versions_of(installed, &raw.id);
        self.push_entry(raw, status, versions);
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

/// ID の、入っている版（新しい順）。
fn versions_of(installed: &[RawExtension], id: &str) -> Vec<String> {
    let mut versions: Vec<String> = installed
        .iter()
        .filter(|r| r.id == id)
        .map(|r| r.version.clone())
        .collect();
    newest_first(&mut versions);
    versions
}

/// 有効にならない理由を、`Problem` にする。
fn reason_problem(raw: &RawExtension, reason: &Reason) -> Problem {
    use ProblemKind as K;
    let (kind, message, detail) = match reason {
        Reason::UserDisabled => (
            K::DependencyDisabled,
            "利用者が無効にしました".to_owned(),
            None,
        ),
        Reason::PinnedVersionMissing { pinned, installed } => (
            K::PinnedVersionMissing,
            format!("固定した版 {pinned} が入っていません"),
            Some(json!({ "pinned": pinned, "installed": installed })),
        ),
        Reason::Engine { required, app } => (
            K::Engine,
            format!("アプリの拡張 API {app} は、必要な範囲 {required} を満たしません"),
            Some(json!({ "required": required, "app": app })),
        ),
        Reason::MissingDependency {
            dependency,
            required,
        } => (
            K::MissingDependency,
            format!("依存する拡張機能 {dependency}（{required}）が入っていません"),
            Some(json!({ "dependency": dependency, "required": required })),
        ),
        Reason::DependencyVersion {
            dependency,
            required,
            installed,
        } => (
            K::DependencyVersion,
            format!("依存する拡張機能 {dependency} の版が、必要な範囲 {required} を満たしません"),
            Some(json!({ "dependency": dependency, "required": required, "installed": installed })),
        ),
        Reason::DependencyDisabled { dependency } => (
            K::DependencyDisabled,
            format!("依存する拡張機能 {dependency} が無効です"),
            Some(json!({ "dependency": dependency })),
        ),
        Reason::DependencyInvalid { dependency } => (
            K::DependencyInvalid,
            format!("依存する拡張機能 {dependency} が有効になりません"),
            Some(json!({ "dependency": dependency })),
        ),
        Reason::Cycle { path } => (
            K::Cycle,
            format!("依存が輪になっています: {}", path.join(" → ")),
            Some(json!({ "path": path })),
        ),
    };
    problem(raw, kind, "", message, detail)
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

/// 拡張子 → `Content-Type`（宣言された MIME の先頭）。先に足したものが勝つ。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MimeRules {
    by_extension: BTreeMap<String, String>,
}

impl MimeRules {
    /// 拡張子（`.txt`・`txt`・`.TXT` のどれでも）に、MIME を割り当てる。すでにあれば、何もしない。
    pub fn add(&mut self, extension: &str, mime: String) {
        let key = extension.trim_start_matches('.').to_lowercase();
        if !key.is_empty() {
            self.by_extension.entry(key).or_insert(mime);
        }
    }

    /// ファイル名から。`a.tar.gz` は、長い拡張子（`tar.gz`）→ 短い拡張子（`gz`）の順に試す。
    pub fn for_file_name(&self, name: &str) -> Option<&str> {
        let lower = name.to_lowercase();
        let body = lower.strip_prefix('.').unwrap_or(&lower);
        let mut start = 0;
        while let Some(dot) = body[start..].find('.') {
            let ext = &body[start + dot + 1..];
            if let Some(mime) = self.by_extension.get(ext) {
                return Some(mime.as_str());
            }
            start += dot + 1;
        }
        None
    }

    pub fn is_empty(&self) -> bool {
        self.by_extension.is_empty()
    }
}
