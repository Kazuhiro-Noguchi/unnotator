//! 開発者モード: 任意のフォルダの読み込みと、`dist/` の変化の通知（research.md R8）。
//! 検証・名前空間化・依存解決は、通常の導入と同じ道（`Registry::build`）を通る。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use unnotator_core::assets::exclude::ExcludeSet;
use unnotator_core::assets::scan::ScanPath;
use unnotator_core::assets::watch::{NotifyWatcher, WatchBatch, Watcher};

use crate::error::ExtensionError;
use crate::registry::{Origin, Problem, ProblemKind, RawExtension};
use crate::state::ExtensionsState;

fn read_folder(folder: &Path) -> Result<RawExtension, String> {
    crate::store::read_extension_dir(folder, Origin::Dev)
}

/// 開発者モードがオンのときだけ、フォルダを 1 つ読み込む。
pub fn load_dev_folder(
    state: &ExtensionsState,
    folder: &Path,
) -> Result<RawExtension, ExtensionError> {
    if !state.dev_mode() {
        return Err(ExtensionError::DevModeOff);
    }
    read_folder(folder).map_err(ExtensionError::Package)
}

/// 読み込み対象のフォルダ（開発者モードがオフなら無し）をすべて読む。失敗したものは `Problem` にする。
pub fn load_active_folders(state: &ExtensionsState) -> (Vec<RawExtension>, Vec<Problem>) {
    let mut raws = Vec::new();
    let mut problems = Vec::new();
    for folder in state.active_dev_folders() {
        match read_folder(&folder) {
            Ok(raw) => raws.push(raw),
            Err(message) => problems.push(Problem {
                extension_id: String::new(),
                version: None,
                kind: ProblemKind::Package,
                pointer: String::new(),
                message: format!("{}: {message}", folder.display()),
                detail: Some(serde_json::json!({ "folder": folder.to_string_lossy() })),
            }),
        }
    }
    (raws, problems)
}

/// 開発中の拡張機能の `dist/` を見張り、変わった拡張機能の ID を返す。連続した変化はまとまる。
pub struct DevWatcher {
    inner: Box<dyn Watcher>,
}

impl DevWatcher {
    /// `(拡張機能の ID, フォルダ)` ごとに `dist/` を見張る。通知を登録できなければ `Err`（呼び出し側は定期走査へ）。
    pub fn new(folders: &[(String, PathBuf)]) -> Result<Self, notify::Error> {
        let roots = folders
            .iter()
            .map(|(id, folder)| (id.clone(), folder.join("dist")))
            .collect();
        // 取りこぼし対策の全体の走査は、開発中の読み直しには要らない
        let inner = NotifyWatcher::new(roots, ExcludeSet::default(), u32::MAX)?;
        Ok(Self {
            inner: Box::new(inner),
        })
    }

    /// 通知が使えないときの代わり。`dist/` のファイルの大きさと更新時刻を見比べる（呼ぶたびに調べる）。
    pub fn polling(folders: &[(String, PathBuf)]) -> Self {
        let roots = folders
            .iter()
            .map(|(id, folder)| (id.clone(), folder.join("dist")))
            .collect();
        Self {
            inner: Box::new(FilePoller::new(roots)),
        }
    }

    /// 見張りの部品を差し替える（テスト用）。
    pub fn with_watcher(inner: Box<dyn Watcher>) -> Self {
        Self { inner }
    }

    /// 前回から変わった拡張機能の ID（なければ空）。
    pub fn poll(&mut self) -> Vec<String> {
        let batch = self.inner.tick();
        let ids: BTreeSet<String> = batch.paths.into_iter().map(|p| p.root_key).collect();
        ids.into_iter().collect()
    }
}

/// ファイル単位で見比べる見張り（フォルダの更新時刻だけでは、中身の書き換えが分からないため）。
struct FilePoller {
    roots: Vec<(String, PathBuf)>,
    known: Option<std::collections::BTreeMap<(String, String), (u64, i64)>>,
}

impl FilePoller {
    fn new(roots: Vec<(String, PathBuf)>) -> Self {
        Self { roots, known: None }
    }

    fn snapshot(&self) -> std::collections::BTreeMap<(String, String), (u64, i64)> {
        let mut out = std::collections::BTreeMap::new();
        for (id, root) in &self.roots {
            let mut stack = vec![root.clone()];
            while let Some(dir) = stack.pop() {
                let Ok(entries) = std::fs::read_dir(&dir) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let path = entry.path();
                    let Ok(meta) = std::fs::symlink_metadata(&path) else {
                        continue;
                    };
                    if meta.is_dir() {
                        stack.push(path);
                    } else {
                        let mtime = meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .and_then(|d| i64::try_from(d.as_nanos()).ok())
                            .unwrap_or(0);
                        let rel = path
                            .strip_prefix(root)
                            .unwrap_or(&path)
                            .to_string_lossy()
                            .into_owned();
                        out.insert((id.clone(), rel), (meta.len(), mtime));
                    }
                }
            }
        }
        out
    }
}

impl Watcher for FilePoller {
    fn tick(&mut self) -> WatchBatch {
        let now = self.snapshot();
        let Some(before) = self.known.replace(now.clone()) else {
            return WatchBatch::default(); // 最初は基準を覚えるだけ
        };
        let changed: BTreeSet<String> = now
            .iter()
            .filter(|(k, v)| before.get(*k) != Some(*v))
            .map(|(k, _)| k.0.clone())
            .chain(
                before
                    .keys()
                    .filter(|k| !now.contains_key(*k))
                    .map(|k| k.0.clone()),
            )
            .collect();
        WatchBatch {
            paths: changed
                .into_iter()
                .map(|id| ScanPath {
                    root_key: id,
                    rel_path: String::new(),
                })
                .collect(),
            overflow: false,
        }
    }
}
