//! `ProjectStore` のアセット関連の操作: 走査・適用・再判定・一覧。

use std::sync::atomic::AtomicBool;

use super::ProjectStore;
use crate::assets::media::MediaRules;
use crate::assets::scan::{MissReason, ScanJob, ScanOptions, ScanReport, ScanScope, Skipped};
use crate::assets::{self, AssetFilter, AssetPage, Page};
use crate::command::Command;
use crate::command::asset::{AssetMiss, AssetReclass, AssetUpdate, NewAsset};
use crate::error::StoreError;

/// 走査 1 回の結果の要約。
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ScanSummary {
    pub added: u32,
    pub updated: u32,
    pub went_missing: u32,
    pub restored: u32,
    pub reclassified: u32,
    /// 適用の直前に、行が変わっていたため飛ばした数。
    pub skipped_rows: u32,
    /// 歩けなかった場所。
    pub skipped: Vec<Skipped>,
    pub miss_reasons: Vec<MissReason>,
    /// 最後まで歩いた。
    pub complete: bool,
}

fn count(len: usize) -> u32 {
    u32::try_from(len).unwrap_or(u32::MAX)
}

impl ProjectStore {
    /// 媒体種別の判定規則を設定する。既存のアセットへの反映は `reclassify_assets`。
    pub fn set_media_rules(&mut self, rules: MediaRules) {
        self.media_rules = rules;
    }

    /// 走査の設定（除外・外部ルート・まとまりの大きさ）。設定の変更から作られる。
    pub fn set_scan_options(&mut self, options: ScanOptions) {
        self.scan_options = options;
    }

    pub fn scan_options(&self) -> &ScanOptions {
        &self.scan_options
    }

    /// 走査の準備。いまのアセットの写しと設定を詰めた `ScanJob` を返す。同時に 1 つまで。
    pub fn begin_scan(&mut self, scope: ScanScope) -> Result<ScanJob, StoreError> {
        if self.scanning {
            return Err(StoreError::ScanInProgress);
        }
        let snapshot = assets::all_assets(&self.conn)?;
        self.scanning = true;
        Ok(ScanJob {
            folder: self.layout.folder.clone(),
            options: self.scan_options.clone(),
            rules: self.media_rules.clone(),
            snapshot,
            scope,
        })
    }

    /// 実行しないまま走査をやめる（`ScanJob` を捨てるとき）。
    pub fn abort_scan(&mut self) {
        self.scanning = false;
    }

    /// `ScanJob::run` の結果を適用する（`chunk_rows` 行ごとの `SyncAssets`）。差分が空なら何も書かない。
    /// 全部を続けて適用する。ロックを手放しながら進めたいときは、`plan_apply` と `apply_step` を使う。
    pub fn apply_scan(&mut self, report: ScanReport) -> Result<ScanSummary, StoreError> {
        let mut apply = self.plan_apply(report);
        while self.apply_step(&mut apply)? {}
        Ok(apply.into_summary())
    }

    /// 適用の計画を立てる（まだ何も書かない）。走査中の印は、ここで外す。
    pub fn plan_apply(&mut self, report: ScanReport) -> ScanApply {
        self.scanning = false;
        let summary = ScanSummary {
            added: count(report.added.len()),
            updated: count(report.updated.len()),
            went_missing: count(report.went_missing.len()),
            restored: count(report.restored.len()),
            reclassified: count(report.reclassified.len()),
            skipped: report.skipped.clone(),
            miss_reasons: report.miss_reasons.clone(),
            complete: report.complete,
            ..ScanSummary::default()
        };
        ScanApply {
            chunks: split_chunks(report, self.scan_options.chunk_rows.max(1)),
            summary,
        }
    }

    /// 次の 1 まとまりを適用する。まだ続きがあれば `true`。1 回ごとに短いので、間でロックを手放せる。
    pub fn apply_step(&mut self, apply: &mut ScanApply) -> Result<bool, StoreError> {
        let Some(command) = apply.chunks.pop_front() else {
            return Ok(false);
        };
        self.apply_command(command)?;
        apply.summary.skipped_rows += self.last_sync_skipped();
        Ok(!apply.chunks.is_empty())
    }

    /// 準備 → 実行 → 適用を、このスレッドで続けて行う。
    pub fn scan(&mut self, scope: ScanScope) -> Result<ScanSummary, StoreError> {
        let job = self.begin_scan(scope)?;
        let cancel = AtomicBool::new(false);
        let report = job.run(&cancel, &|_| {});
        self.apply_scan(report)
    }

    /// 判定規則に従って、すべてのアセットの媒体種別を付け直す。変えた件数を返す。アノテーションには触れない。
    pub fn reclassify_assets(&mut self) -> Result<u32, StoreError> {
        let mut changes = Vec::new();
        for row in assets::all_assets(&self.conn)? {
            let name = row.rel_path.rsplit('/').next().unwrap_or(&row.rel_path);
            let now = self.media_rules.classify(name).map(str::to_owned);
            if now != row.media_type {
                changes.push(AssetReclass {
                    asset_id: row.id,
                    media_type: now,
                });
            }
        }
        let total = count(changes.len());
        let report = ScanReport {
            reclassified: changes,
            complete: true,
            ..ScanReport::default()
        };
        let mut apply = self.plan_apply(report);
        while self.apply_step(&mut apply)? {}
        Ok(total)
    }

    /// リンク切れのアセットの、再接続の候補。
    pub fn relink_candidates(
        &self,
        asset_id: &str,
    ) -> Result<Vec<crate::assets::relink::RelinkCandidate>, StoreError> {
        crate::assets::relink::candidates(&self.conn, asset_id)
    }

    /// 配信のための、アセットの実体の場所（読み取り）。リンク切れ・登録の無い ID・見つからないルートは `NotFound`。
    pub fn asset_file(
        &self,
        id: &str,
    ) -> Result<crate::serve::AssetFile, crate::serve::AssetFileError> {
        use crate::serve::AssetFileError;
        let row = assets::get_asset(&self.conn, id)?.ok_or(AssetFileError::NotFound)?;
        if row.missing {
            return Err(AssetFileError::NotFound);
        }
        let root = if row.root_key.is_empty() {
            self.layout.folder.clone()
        } else {
            self.scan_options
                .roots
                .iter()
                .find(|r| r.key == row.root_key)
                .map(|r| r.path.clone())
                .ok_or(AssetFileError::NotFound)?
        };
        Ok(crate::serve::AssetFile {
            root,
            rel_path: row.rel_path,
            size: u64::try_from(row.file_size).unwrap_or(0),
            mtime_ms: row.mtime_ms,
        })
    }

    /// 記録のあるアイテム（状態・属性・アノテーションが付いたもの）の、キーと状態。
    /// 記録の無いアイテムは含まれない（未着手として扱う）。
    pub fn item_statuses(
        &self,
        asset_id: &str,
    ) -> Result<Vec<(String, crate::command::Status)>, StoreError> {
        assets::item_statuses(&self.conn, asset_id)
    }

    /// ラベルの一覧（読み取り。008）。
    pub fn list_labels(&self) -> Result<Vec<crate::query::labels::LabelRow>, StoreError> {
        crate::query::labels::list_labels(&self.conn)
    }

    /// 属性スキーマの一覧（読み取り。008）。
    pub fn list_schemas(&self) -> Result<Vec<crate::query::schemas::SchemaRow>, StoreError> {
        crate::query::schemas::list_schemas(&self.conn)
    }

    /// 現在位置の詳細（読み取り。008）。アセットが無いときは `None`。
    pub fn target_details(
        &self,
        asset_id: &str,
        item_key: Option<&str>,
    ) -> Result<Option<crate::query::target::TargetDetails>, StoreError> {
        crate::query::target::target_details(&self.conn, asset_id, item_key)
    }

    /// 現在位置のアノテーションの 1 ページ（読み取り。008）。
    pub fn annotations_page(
        &self,
        asset_id: &str,
        item_key: Option<&str>,
        cursor: Option<&crate::query::page::AnnotationCursor>,
    ) -> Result<crate::query::page::AnnotationPage, StoreError> {
        crate::query::page::annotations_page_for(&self.conn, asset_id, item_key, cursor)
    }

    /// 拡張機能向けの読み取り（009。`selector_json` を含む）。
    pub fn ext_asset(
        &self,
        asset_id: &str,
    ) -> Result<Option<crate::query::ext::ExtAsset>, StoreError> {
        crate::query::ext::ext_asset(&self.conn, asset_id)
    }

    pub fn ext_item(
        &self,
        asset_id: &str,
        item_key: &str,
    ) -> Result<Option<crate::query::ext::ExtItem>, StoreError> {
        crate::query::ext::ext_item(&self.conn, asset_id, item_key)
    }

    pub fn ext_annotations(
        &self,
        filter: &crate::query::ext::ExtAnnotationFilter,
    ) -> Result<Vec<crate::query::ext::ExtAnnotation>, StoreError> {
        crate::query::ext::ext_annotations(&self.conn, filter)
    }

    pub fn ext_relations(
        &self,
        filter: &crate::query::ext::ExtRelationFilter,
    ) -> Result<Vec<crate::query::ext::ExtRelation>, StoreError> {
        crate::query::ext::ext_relations(&self.conn, filter)
    }

    pub fn ext_groups(
        &self,
        filter: &crate::query::ext::ExtGroupFilter,
    ) -> Result<Vec<crate::query::ext::ExtGroup>, StoreError> {
        crate::query::ext::ext_groups(&self.conn, filter)
    }

    /// 属性スキーマを変えるときの影響の件数（読み取り。008）。
    pub fn attribute_usage(
        &self,
        scope: crate::command::AttributeScope,
        target: &str,
        names: &[String],
    ) -> Result<u32, StoreError> {
        crate::query::usage::attribute_usage(&self.conn, scope, target, names)
    }

    /// 一覧（読み取り）。
    pub fn list_assets(&self, filter: &AssetFilter, page: &Page) -> Result<AssetPage, StoreError> {
        assets::list_assets(&self.conn, filter, page)
    }
}

/// ツリーの索引が、作業用コピーのアセットを読むための出どころ。
impl assets::tree::AssetSource for ProjectStore {
    fn all_assets(&self) -> Result<Vec<assets::AssetRow>, StoreError> {
        assets::all_assets(&self.conn)
    }

    fn asset(&self, id: &str) -> Result<Option<assets::AssetRow>, StoreError> {
        assets::get_asset(&self.conn, id)
    }
}

/// 立てた適用の計画。`apply_step` で 1 まとまりずつ書く。
#[derive(Debug)]
pub struct ScanApply {
    chunks: std::collections::VecDeque<Command>,
    summary: ScanSummary,
}

impl ScanApply {
    pub fn into_summary(self) -> ScanSummary {
        self.summary
    }
}

/// 差分を、`limit` 行以下の `SyncAssets` に区切る。
fn split_chunks(report: ScanReport, limit: usize) -> std::collections::VecDeque<Command> {
    let mut out = std::collections::VecDeque::new();
    let mut chunk = Chunk::default();
    macro_rules! push_all {
        ($rows:expr, $field:ident) => {
            for row in $rows {
                chunk.$field.push(row);
                if chunk.len() >= limit
                    && let Some(command) = chunk.take()
                {
                    out.push_back(command);
                }
            }
        };
    }
    push_all!(report.added, added);
    push_all!(report.updated, updated);
    push_all!(report.went_missing, went_missing);
    push_all!(report.restored, restored);
    push_all!(report.reclassified, reclassified);
    if let Some(command) = chunk.take() {
        out.push_back(command);
    }
    out
}

#[derive(Default)]
struct Chunk {
    added: Vec<NewAsset>,
    updated: Vec<AssetUpdate>,
    went_missing: Vec<AssetMiss>,
    restored: Vec<AssetUpdate>,
    reclassified: Vec<AssetReclass>,
}

impl Chunk {
    fn len(&self) -> usize {
        self.added.len()
            + self.updated.len()
            + self.went_missing.len()
            + self.restored.len()
            + self.reclassified.len()
    }

    fn take(&mut self) -> Option<Command> {
        if self.len() == 0 {
            return None;
        }
        let chunk = std::mem::take(self);
        Some(Command::SyncAssets {
            added: chunk.added,
            updated: chunk.updated,
            went_missing: chunk.went_missing,
            restored: chunk.restored,
            reclassified: chunk.reclassified,
        })
    }
}

// ---- 設定の窓口（プロジェクトの設定を含む） ----

use crate::settings::{Effective, Layer, SettingsChanged, SettingsIssue};

impl ProjectStore {
    /// ユーザー設定のフォルダを付ける（`src-tauri` が、開いたあとに呼ぶ）。
    pub fn attach_user_settings(&mut self, dir: &std::path::Path) {
        self.settings.attach_user(dir);
        self.refresh_scan_options();
    }

    pub fn settings_effective(&self, key: &str) -> Result<Effective, StoreError> {
        self.settings.effective(key)
    }

    pub fn settings_layer(&self, layer: Layer) -> serde_json::Map<String, serde_json::Value> {
        self.settings.layer(layer).cloned().unwrap_or_default()
    }

    pub fn settings_set(
        &mut self,
        layer: Layer,
        key: &str,
        value: serde_json::Value,
    ) -> Result<(), StoreError> {
        if key == "assets.externalRoots" {
            crate::assets::roots::validate(&self.layout.folder, &value).map_err(|why| {
                StoreError::InvalidSetting {
                    key: key.to_owned(),
                    why,
                }
            })?;
        }
        self.settings.set(layer, key, value)?;
        self.refresh_scan_options();
        Ok(())
    }

    /// 外部ルートを足す（プロジェクトの設定へ）。相対化できるときは相対パスで書く。`path` は絶対パス。
    pub fn set_external_root(
        &mut self,
        key: &str,
        path: &std::path::Path,
    ) -> Result<(), StoreError> {
        if !path.is_absolute() {
            return Err(StoreError::InvalidSetting {
                key: "assets.externalRoots".to_owned(),
                why: "フォルダは絶対パスで指定する".to_owned(),
            });
        }
        let stored = crate::assets::roots::relativize(&self.layout.folder, path)
            .unwrap_or_else(|| path.to_path_buf());
        let mut roots = self
            .settings
            .layer(Layer::Project)
            .and_then(|map| map.get("assets.externalRoots"))
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        roots.insert(
            key.to_owned(),
            serde_json::Value::String(stored.to_string_lossy().replace('\\', "/")),
        );
        self.settings_set(
            Layer::Project,
            "assets.externalRoots",
            serde_json::Value::Object(roots),
        )
    }

    pub fn settings_unset(&mut self, layer: Layer, key: &str) -> Result<(), StoreError> {
        self.settings.unset(layer, key)?;
        self.refresh_scan_options();
        Ok(())
    }

    /// 見張りを動かすか（設定 `assets.watch`）。
    pub fn watch_enabled(&self) -> bool {
        self.settings
            .effective("assets.watch")
            .ok()
            .and_then(|e| e.value.as_bool())
            .unwrap_or(true)
    }

    /// 見張りが見るルート（キーとフォルダ）。プロジェクトのフォルダは、キー `''`。
    pub fn watch_roots(&self) -> Vec<(String, std::path::PathBuf)> {
        let mut roots = vec![(String::new(), self.layout.folder.clone())];
        roots.extend(
            self.scan_options
                .roots
                .iter()
                .map(|r| (r.key.clone(), r.path.clone())),
        );
        roots
    }

    /// 設定ファイルが外から変わっていないか確かめて反映する。変わったキーを返す。
    pub fn settings_reload(&mut self) -> Result<Vec<String>, StoreError> {
        let changed = self.settings.reload()?;
        if !changed.is_empty() {
            self.refresh_scan_options();
        }
        Ok(changed)
    }

    pub fn settings_warnings(&self) -> Vec<SettingsIssue> {
        self.settings.warnings()
    }

    pub fn settings_subscribe(&mut self, subscriber: Box<dyn Fn(&SettingsChanged) + Send>) {
        self.settings.subscribe(subscriber);
    }

    /// 設定（`assets.exclude`・`assets.externalRoots`）から、走査の設定を作り直す。
    pub(super) fn refresh_scan_options(&mut self) {
        let exclude = self
            .settings
            .effective("assets.exclude")
            .ok()
            .and_then(|e| e.value.as_array().cloned())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| ScanOptions::default().exclude);
        let roots = self
            .settings
            .effective("assets.externalRoots")
            .ok()
            .and_then(|e| e.value.as_object().cloned())
            .map(|map| crate::assets::roots::specs(&self.layout.folder, &map))
            .unwrap_or_default();
        self.scan_options.exclude = exclude;
        self.scan_options.roots = roots;
    }
}

// ---- 拡張機能の一覧（extensions.json） ----

use crate::extensions_list::{self, ExtensionCheck, InstalledExtension};

impl ProjectStore {
    /// `.unnotator/extensions.json` と、導入済みの拡張機能（呼び出し側が渡す）を突き合わせる。読み取りだけ。
    pub fn check_extensions(
        &self,
        installed: &[InstalledExtension],
    ) -> Result<ExtensionCheck, StoreError> {
        let (required, warnings) = extensions_list::read(&self.layout.dir.join("extensions.json"));
        Ok(extensions_list::check(&required, installed, warnings))
    }
}
