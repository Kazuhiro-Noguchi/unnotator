//! 孤立した作業用データの一覧・個別削除・自動削除（research.md R9）。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::journal::Journal;
use super::{CORRUPT_MARK, journal_path, recovery_dir_for};
use crate::error::StoreError;
use crate::project::layout::ProjectLayout;
use crate::project::lock::ProjectLock;

/// 自動で削除するまでの日数。
pub const ORPHAN_DAYS: i64 = 30;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// 一覧の 1 件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct RecoveryEntry {
    /// ディレクトリ名（`<hash>` または `<hash>.corrupt-<時刻>`）。
    pub id: String,
    /// 紐づくプロジェクトのフォルダ（読めなければ `None`）。
    pub project_root: Option<String>,
    pub entry_count: Option<u32>,
    /// 最後に変更した時刻（ミリ秒。画面側では `number`）。
    #[cfg_attr(feature = "specta", specta(type = Option<f64>))]
    pub last_change_at: Option<i64>,
    /// ディレクトリ内のファイルの合計の大きさ。画面側では `number`。
    #[cfg_attr(feature = "specta", specta(type = f64))]
    pub size_bytes: u64,
    /// 紐づくプロジェクトが存在するか（存在すれば、自動では削除しない）。
    pub project_exists: bool,
    /// 読めなかったものか。
    pub corrupt: bool,
}

struct Scanned {
    entry: RecoveryEntry,
    /// 経過日数を数える起点（ミリ秒）。
    age_base: i64,
    /// 読めなかったために退避したもの（プロジェクトが存在しても、期限で削除する）。
    moved_aside: bool,
    path: PathBuf,
}

fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| match entry.metadata() {
            Ok(meta) if meta.is_dir() => dir_size(&entry.path()),
            Ok(meta) => meta.len(),
            Err(_) => 0,
        })
        .sum()
}

fn modified_ms(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

fn scan_one(path: &Path) -> Option<Scanned> {
    if !path.is_dir() {
        return None;
    }
    let id = path.file_name()?.to_string_lossy().into_owned();
    let moved_at = id
        .split_once(CORRUPT_MARK)
        .and_then(|(_, ms)| ms.parse::<i64>().ok());
    let moved_aside = id.contains(CORRUPT_MARK);

    let journal = Journal::open(&journal_path(path)).ok();
    let (project_root, entry_count, last_change_at, opened_at) = match &journal {
        Some(journal) => match (journal.session(), journal.entry_count()) {
            (Ok(session), Ok(count)) => (
                Some(session.project_root),
                Some(count),
                session.last_change_at,
                Some(session.opened_at),
            ),
            _ => (None, None, None, None),
        },
        None => (None, None, None, None),
    };
    drop(journal);
    let corrupt = moved_aside || project_root.is_none();
    let project_exists = project_root
        .as_deref()
        .is_some_and(|root| ProjectLayout::new(Path::new(root)).db.is_file());
    let age_base = last_change_at
        .or(opened_at)
        .or(moved_at)
        .unwrap_or_else(|| modified_ms(path));
    Some(Scanned {
        entry: RecoveryEntry {
            id,
            project_root,
            entry_count,
            last_change_at: last_change_at.or(moved_at),
            size_bytes: dir_size(path),
            project_exists,
            corrupt,
        },
        age_base,
        moved_aside,
        path: path.to_path_buf(),
    })
}

fn scan(root: &Path) -> Vec<Scanned> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut scanned: Vec<Scanned> = entries
        .flatten()
        .filter_map(|entry| scan_one(&entry.path()))
        .collect();
    scanned.sort_by(|a, b| a.entry.id.cmp(&b.entry.id));
    scanned
}

/// 孤立した作業用データの一覧（復元の候補になりうるものも含む）。
pub fn list(root: &Path) -> Vec<RecoveryEntry> {
    scan(root).into_iter().map(|s| s.entry).collect()
}

/// 別のプロセス（または、いま開いているプロジェクト）が使っていないことを確かめる。
fn ensure_not_in_use(
    scanned: &Scanned,
    root: &Path,
    open_dir: Option<&Path>,
) -> Result<(), StoreError> {
    if let Some(open) = open_dir
        && recovery_dir_for(root, open) == scanned.path
    {
        return Err(StoreError::InUse);
    }
    if scanned.entry.project_exists
        && let Some(project_root) = scanned.entry.project_root.as_deref()
    {
        // ロックを取れなければ、別のプロセスが使っている。取れたら、すぐに手放す。
        let layout = ProjectLayout::new(Path::new(project_root));
        let lock = ProjectLock::acquire(&layout.lock)?;
        lock.release()?;
    }
    Ok(())
}

/// 1 件を削除する。`id` に区切りや `..` を含むものは `not_found`。使用中のものは `in_use`。
pub fn delete(root: &Path, id: &str, open_dir: Option<&Path>) -> Result<(), StoreError> {
    let invalid = id.is_empty()
        || id == "."
        || id == ".."
        || id.contains('/')
        || id.contains('\\')
        || id.contains('\0');
    if invalid {
        return Err(StoreError::NotFound(format!(
            "作業用データがありません: {id}"
        )));
    }
    let path = root.join(id);
    let Some(scanned) = scan_one(&path) else {
        return Err(StoreError::NotFound(format!(
            "作業用データがありません: {id}"
        )));
    };
    ensure_not_in_use(&scanned, root, open_dir)?;
    std::fs::remove_dir_all(&path)?;
    Ok(())
}

/// 30 日を超えた孤立のものを削除し、削除した `id` を返す。
/// 紐づくプロジェクトが存在するものは、何日経っても削除しない（読めなくて退避したものは、削除する）。
pub fn cleanup(
    root: &Path,
    now_ms: i64,
    open_dir: Option<&Path>,
) -> Result<Vec<String>, StoreError> {
    let mut removed = Vec::new();
    for scanned in scan(root) {
        let expired = now_ms.saturating_sub(scanned.age_base) > ORPHAN_DAYS * DAY_MS;
        let eligible = scanned.moved_aside || !scanned.entry.project_exists;
        if !(expired && eligible) {
            continue;
        }
        if ensure_not_in_use(&scanned, root, open_dir).is_err() {
            continue;
        }
        if let Err(error) = std::fs::remove_dir_all(&scanned.path) {
            tracing::warn!(%error, id = %scanned.entry.id, "孤立した作業用データを削除できなかった");
            continue;
        }
        removed.push(scanned.entry.id);
    }
    Ok(removed)
}
