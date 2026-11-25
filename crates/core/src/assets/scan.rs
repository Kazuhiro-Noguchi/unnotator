//! 走査。フォルダを歩いて「いまあるファイルの一覧」を作り、DB の写しと突き合わせて差分を出す（research.md R1・R2）。
//!
//! `ScanJob::run` は DB に触れず、別スレッドで実行できる。差分の適用は `ProjectStore::apply_scan`。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

use super::AssetRow;
use super::exclude::{DEFAULT_PATTERNS, ExcludeSet};
use super::media::MediaRules;
use super::path::{compare_key, fs_is_case_insensitive, normalize_rel};
use crate::command::asset::{AssetMiss, AssetReclass, AssetStamp, AssetUpdate, NewAsset};

/// 外部ルート（キーとフォルダ）。キー `''` はプロジェクトのフォルダなので、ここには入れない。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct RootSpec {
    pub key: String,
    pub path: PathBuf,
}

/// 走査の設定。設定（`assets.exclude`・`assets.externalRoots`）から作られる。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanOptions {
    pub exclude: Vec<String>,
    pub roots: Vec<RootSpec>,
    /// 1 回の `SyncAssets` に入れる行数の上限。
    pub chunk_rows: usize,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            exclude: DEFAULT_PATTERNS.iter().map(|p| (*p).to_owned()).collect(),
            roots: Vec::new(),
            chunk_rows: 5_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ScanPath {
    pub root_key: String,
    /// ルートからの相対パス。空ならルート全体。
    pub rel_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum ScanScope {
    /// すべてのルート。
    Full,
    /// 見張りが報せた場所だけ。
    Paths(Vec<ScanPath>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum ScanPhase {
    Walking,
    Applying,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ScanProgress {
    /// これまでに見つけたファイルの数。
    pub found: u32,
    pub phase: ScanPhase,
}

/// 歩けなかった場所。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Skipped {
    pub root_key: String,
    pub rel_path: String,
    /// `permission_denied` / `io_error` / `invalid_path`
    pub reason: String,
}

/// リンク切れにした理由。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct MissReason {
    pub asset_id: String,
    /// `file_not_found` / `root_not_found` / `root_not_configured`
    pub reason: String,
}

/// 走査の結果の差分。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScanReport {
    pub added: Vec<NewAsset>,
    pub updated: Vec<AssetUpdate>,
    pub went_missing: Vec<AssetMiss>,
    pub restored: Vec<AssetUpdate>,
    pub reclassified: Vec<AssetReclass>,
    pub skipped: Vec<Skipped>,
    pub miss_reasons: Vec<MissReason>,
    /// 最後まで歩いた。中断したときは `false`（無いことの証拠にならないので、リンク切れは出さない）。
    pub complete: bool,
}

/// 走査の指示。準備で作り、別スレッドで `run` する。
#[derive(Debug)]
pub struct ScanJob {
    pub(crate) folder: PathBuf,
    pub(crate) options: ScanOptions,
    pub(crate) rules: MediaRules,
    pub(crate) snapshot: Vec<AssetRow>,
    pub(crate) scope: ScanScope,
}

struct Found {
    rel: String,
    stamp: AssetStamp,
}

/// 歩く場所。
struct Target {
    root_key: String,
    prefix: String,
    root_dir: PathBuf,
}

impl ScanJob {
    pub fn run(self, cancel: &AtomicBool, progress: &dyn Fn(ScanProgress)) -> ScanReport {
        let exclude =
            ExcludeSet::new(&self.options.exclude).unwrap_or_else(|_| ExcludeSet::defaults());
        let roots = self.roots();
        let targets = self.targets(&roots);

        let mut report = ScanReport {
            complete: true,
            ..ScanReport::default()
        };
        let mut found: HashMap<(String, String), Found> = HashMap::new();
        let mut root_missing: HashSet<String> = HashSet::new();
        let mut skipped_dirs: Vec<(String, String)> = Vec::new();
        let mut case_insensitive: HashMap<String, bool> = HashMap::new();
        let mut count: u32 = 0;

        for target in &targets {
            if !target.root_dir.is_dir() {
                root_missing.insert(target.root_key.clone());
                continue;
            }
            let ci = *case_insensitive
                .entry(target.root_key.clone())
                .or_insert_with(|| fs_is_case_insensitive(&target.root_dir));
            let mut stack = vec![target.prefix.clone()];
            while let Some(rel_dir) = stack.pop() {
                if cancel.load(Ordering::Relaxed) {
                    report.complete = false;
                    break;
                }
                let abs = join(&target.root_dir, &rel_dir);
                let meta = match std::fs::symlink_metadata(&abs) {
                    Ok(meta) => meta,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => {
                        skip(&mut report, &mut skipped_dirs, target, &rel_dir, &error);
                        continue;
                    }
                };
                if meta.file_type().is_symlink() {
                    continue;
                }
                if meta.is_file() {
                    if !rel_dir.is_empty() && !exclude.is_excluded(&rel_dir, false) {
                        record(
                            &mut found,
                            &mut report,
                            target,
                            &rel_dir,
                            &meta,
                            ci,
                            &mut count,
                        );
                    }
                    continue;
                }
                if !rel_dir.is_empty() && exclude.is_excluded(&rel_dir, true) {
                    continue;
                }
                let entries = match std::fs::read_dir(&abs) {
                    Ok(entries) => entries,
                    Err(error) => {
                        skip(&mut report, &mut skipped_dirs, target, &rel_dir, &error);
                        continue;
                    }
                };
                for entry in entries.flatten() {
                    let Ok(file_type) = entry.file_type() else {
                        continue;
                    };
                    if file_type.is_symlink() {
                        continue;
                    }
                    let name = entry.file_name();
                    let Some(name) = name.to_str() else {
                        report.skipped.push(Skipped {
                            root_key: target.root_key.clone(),
                            rel_path: format!("{rel_dir}/{}", name.to_string_lossy()),
                            reason: "invalid_path".to_owned(),
                        });
                        continue;
                    };
                    let rel = if rel_dir.is_empty() {
                        name.to_owned()
                    } else {
                        format!("{rel_dir}/{name}")
                    };
                    if file_type.is_dir() {
                        if !exclude.is_excluded(&rel, true) {
                            stack.push(rel);
                        }
                    } else if file_type.is_file() && !exclude.is_excluded(&rel, false) {
                        match entry.metadata() {
                            Ok(meta) => {
                                record(
                                    &mut found,
                                    &mut report,
                                    target,
                                    &rel,
                                    &meta,
                                    ci,
                                    &mut count,
                                );
                            }
                            Err(error) => {
                                skip(&mut report, &mut skipped_dirs, target, &rel, &error)
                            }
                        }
                    }
                }
                progress(ScanProgress {
                    found: count,
                    phase: ScanPhase::Walking,
                });
            }
            if !report.complete {
                break;
            }
        }
        progress(ScanProgress {
            found: count,
            phase: ScanPhase::Walking,
        });

        self.diff(
            &mut report,
            found,
            &DiffContext {
                exclude: &exclude,
                roots: &roots,
                targets: &targets,
                root_missing: &root_missing,
                skipped_dirs: &skipped_dirs,
                case_insensitive: &case_insensitive,
            },
        );
        report
    }

    /// キー → フォルダ。プロジェクトのフォルダは、キー `''`。
    fn roots(&self) -> HashMap<String, PathBuf> {
        let mut roots = HashMap::new();
        roots.insert(String::new(), self.folder.clone());
        for root in &self.options.roots {
            roots.insert(root.key.clone(), root.path.clone());
        }
        roots
    }

    fn targets(&self, roots: &HashMap<String, PathBuf>) -> Vec<Target> {
        let mut keys: Vec<&String> = roots.keys().collect();
        keys.sort();
        match &self.scope {
            ScanScope::Full => keys
                .into_iter()
                .map(|key| Target {
                    root_key: key.clone(),
                    prefix: String::new(),
                    root_dir: roots[key].clone(),
                })
                .collect(),
            ScanScope::Paths(paths) => paths
                .iter()
                .filter_map(|p| {
                    let prefix = if p.rel_path.is_empty() {
                        String::new()
                    } else {
                        normalize_rel(&p.rel_path).ok()?
                    };
                    Some(Target {
                        root_dir: roots.get(&p.root_key)?.clone(),
                        root_key: p.root_key.clone(),
                        prefix,
                    })
                })
                .collect(),
        }
    }

    fn in_scope(&self, targets: &[Target], row: &AssetRow) -> bool {
        match self.scope {
            ScanScope::Full => true,
            ScanScope::Paths(_) => targets.iter().any(|t| {
                t.root_key == row.root_key
                    && (t.prefix.is_empty()
                        || row.rel_path == t.prefix
                        || row.rel_path.starts_with(&format!("{}/", t.prefix)))
            }),
        }
    }

    fn diff(
        &self,
        report: &mut ScanReport,
        mut found: HashMap<(String, String), Found>,
        cx: &DiffContext<'_>,
    ) {
        for row in &self.snapshot {
            if !self.in_scope(cx.targets, row) {
                continue;
            }
            let ci = cx
                .case_insensitive
                .get(&row.root_key)
                .copied()
                .unwrap_or(false);
            let key = (row.root_key.clone(), compare_key(&row.rel_path, ci));
            let base = AssetStamp {
                file_size: row.file_size,
                mtime_ms: row.mtime_ms,
            };
            if let Some(file) = found.remove(&key) {
                if row.missing {
                    report.restored.push(AssetUpdate {
                        asset_id: row.id.clone(),
                        base,
                        now: file.stamp,
                    });
                } else if file.stamp != base {
                    report.updated.push(AssetUpdate {
                        asset_id: row.id.clone(),
                        base,
                        now: file.stamp,
                    });
                }
                continue;
            }
            if row.missing {
                continue;
            }
            let reason = if cx.root_missing.contains(&row.root_key) {
                Some("root_not_found")
            } else if !cx.roots.contains_key(&row.root_key) {
                Some("root_not_configured")
            } else if report.complete
                && !cx
                    .skipped_dirs
                    .iter()
                    .any(|(root, dir)| *root == row.root_key && under(&row.rel_path, dir))
                && !cx.exclude.is_excluded(&row.rel_path, false)
                && !cx
                    .roots
                    .get(&row.root_key)
                    .is_some_and(|root| join(root, &row.rel_path).symlink_metadata().is_ok())
            {
                Some("file_not_found")
            } else {
                None
            };
            if let Some(reason) = reason {
                report.went_missing.push(AssetMiss {
                    asset_id: row.id.clone(),
                    base,
                });
                report.miss_reasons.push(MissReason {
                    asset_id: row.id.clone(),
                    reason: reason.to_owned(),
                });
            }
        }
        let mut added: Vec<NewAsset> = found
            .into_iter()
            .map(|((root_key, _), file)| {
                let name = file.rel.rsplit('/').next().unwrap_or(&file.rel);
                NewAsset {
                    id: None,
                    media_type: self.rules.classify(name).map(str::to_owned),
                    root_key,
                    rel_path: file.rel,
                    stamp: file.stamp,
                }
            })
            .collect();
        added.sort_by(|a, b| (&a.root_key, &a.rel_path).cmp(&(&b.root_key, &b.rel_path)));
        report.added = added;
    }
}

struct DiffContext<'a> {
    exclude: &'a ExcludeSet,
    roots: &'a HashMap<String, PathBuf>,
    targets: &'a [Target],
    root_missing: &'a HashSet<String>,
    skipped_dirs: &'a [(String, String)],
    case_insensitive: &'a HashMap<String, bool>,
}

fn join(root: &Path, rel: &str) -> PathBuf {
    if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    }
}

fn under(path: &str, dir: &str) -> bool {
    dir.is_empty() || path == dir || path.starts_with(&format!("{dir}/"))
}

fn skip(
    report: &mut ScanReport,
    skipped_dirs: &mut Vec<(String, String)>,
    target: &Target,
    rel: &str,
    error: &std::io::Error,
) {
    let reason = if error.kind() == std::io::ErrorKind::PermissionDenied {
        "permission_denied"
    } else {
        "io_error"
    };
    skipped_dirs.push((target.root_key.clone(), rel.to_owned()));
    report.skipped.push(Skipped {
        root_key: target.root_key.clone(),
        rel_path: rel.to_owned(),
        reason: reason.to_owned(),
    });
}

fn record(
    found: &mut HashMap<(String, String), Found>,
    report: &mut ScanReport,
    target: &Target,
    rel: &str,
    meta: &std::fs::Metadata,
    case_insensitive: bool,
    count: &mut u32,
) {
    // 契約の規則（空・絶対・`.`・`..`・予約名）に合わないパスは、アセットにしない
    let Ok(normalized) = normalize_rel(rel) else {
        report.skipped.push(Skipped {
            root_key: target.root_key.clone(),
            rel_path: rel.to_owned(),
            reason: "invalid_path".to_owned(),
        });
        return;
    };
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0);
    let stamp = AssetStamp {
        file_size: i64::try_from(meta.len()).unwrap_or(i64::MAX),
        mtime_ms,
    };
    *count = count.saturating_add(1);
    found.insert(
        (
            target.root_key.clone(),
            compare_key(&normalized, case_insensitive),
        ),
        Found {
            rel: normalized,
            stamp,
        },
    );
}
