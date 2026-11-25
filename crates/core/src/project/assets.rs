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
    pub fn apply_scan(&mut self, report: ScanReport) -> Result<ScanSummary, StoreError> {
        self.scanning = false;
        let mut summary = ScanSummary {
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
        summary.skipped_rows = self.apply_chunks(report)?;
        Ok(summary)
    }

    fn apply_chunks(&mut self, report: ScanReport) -> Result<u32, StoreError> {
        let limit = self.scan_options.chunk_rows.max(1);
        let mut skipped = 0;
        let mut chunk = Chunk::default();
        let mut flush = |store: &mut Self, chunk: &mut Chunk| -> Result<(), StoreError> {
            if let Some(command) = chunk.take() {
                store.apply_command(command)?;
                skipped += store.last_sync_skipped();
            }
            Ok(())
        };
        for row in report.added {
            chunk.added.push(row);
            if chunk.len() >= limit {
                flush(self, &mut chunk)?;
            }
        }
        for row in report.updated {
            chunk.updated.push(row);
            if chunk.len() >= limit {
                flush(self, &mut chunk)?;
            }
        }
        for row in report.went_missing {
            chunk.went_missing.push(row);
            if chunk.len() >= limit {
                flush(self, &mut chunk)?;
            }
        }
        for row in report.restored {
            chunk.restored.push(row);
            if chunk.len() >= limit {
                flush(self, &mut chunk)?;
            }
        }
        for row in report.reclassified {
            chunk.reclassified.push(row);
            if chunk.len() >= limit {
                flush(self, &mut chunk)?;
            }
        }
        flush(self, &mut chunk)?;
        Ok(skipped)
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
        self.apply_chunks(report)?;
        Ok(total)
    }

    /// リンク切れのアセットの、再接続の候補。
    pub fn relink_candidates(
        &self,
        asset_id: &str,
    ) -> Result<Vec<crate::assets::relink::RelinkCandidate>, StoreError> {
        crate::assets::relink::candidates(&self.conn, asset_id)
    }

    /// 一覧（読み取り）。
    pub fn list_assets(&self, filter: &AssetFilter, page: &Page) -> Result<AssetPage, StoreError> {
        assets::list_assets(&self.conn, filter, page)
    }
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

use crate::assets::scan::RootSpec;
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
        self.settings.set(layer, key, value)?;
        self.refresh_scan_options();
        Ok(())
    }

    pub fn settings_unset(&mut self, layer: Layer, key: &str) -> Result<(), StoreError> {
        self.settings.unset(layer, key)?;
        self.refresh_scan_options();
        Ok(())
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
            .map(|map| {
                map.iter()
                    .filter_map(|(key, value)| {
                        let path = std::path::PathBuf::from(value.as_str()?);
                        let path = if path.is_absolute() {
                            path
                        } else {
                            self.layout.folder.join(path)
                        };
                        Some(RootSpec {
                            key: key.clone(),
                            path,
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        self.scan_options.exclude = exclude;
        self.scan_options.roots = roots;
    }
}
