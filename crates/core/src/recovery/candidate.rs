//! 異常終了後の復元の候補の判定と、その選択（research.md R2・R8）。

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::journal::Journal;
use super::{journal_path, working_path};
use crate::db::open_wal_connection;
use crate::error::StoreError;

/// 復元の候補の情報（確認の表示に使う）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct RecoveryCandidate {
    /// 前回のセッションが開いていたプロジェクトのフォルダ。
    pub project_root: String,
    /// 未保存の変更の件数（`entries` の件数）。
    pub entry_count: u32,
    /// 最後に編集が確定した時刻（ミリ秒）。画面側では `number`。
    #[cfg_attr(feature = "specta", specta(type = Option<f64>))]
    pub last_change_at: Option<i64>,
    /// 作業の開始後に、`project.db` が外から変更されたか。
    pub base_changed: bool,
    /// 前回のセッションのアプリの版。
    pub app_version: String,
}

/// 読めない作業用データを退避したことの知らせ（保存済みのプロジェクトは通常に開いている）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryUnusable {
    pub moved_to: PathBuf,
    pub reason: String,
}

/// 復元用ディレクトリの調べた結果。
#[derive(Debug)]
pub enum Inspection {
    /// 作業用データが無い。
    Missing,
    /// 変更の記録が 1 件も無い残骸（開いただけ・保存直後に落ちた）。
    Residue,
    /// 復元の候補。
    Candidate(RecoveryCandidate),
    /// 読めない・壊れている（理由つき）。
    Unusable(String),
}

/// `project.db` の更新時刻（ミリ秒）と大きさ。
pub fn file_stamp(path: &Path) -> (Option<i64>, Option<i64>) {
    let Ok(meta) = std::fs::metadata(path) else {
        return (None, None);
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|d| i64::try_from(d.as_millis()).ok());
    (mtime, i64::try_from(meta.len()).ok())
}

fn working_project_id(path: &Path) -> Result<String, StoreError> {
    let conn: Connection = open_wal_connection(path)?;
    conn.query_row("SELECT value FROM meta WHERE key = 'project_id'", [], |r| {
        r.get::<_, String>(0)
    })
    .map_err(crate::db::classify)
}

/// 復元用ディレクトリを調べる。何も変更しない（削除も退避も、呼び出し側が行う）。
pub fn inspect(dir: &Path, project_db: &Path) -> Inspection {
    if !dir.exists() {
        return Inspection::Missing;
    }
    let journal_file = journal_path(dir);
    if !journal_file.is_file() {
        // 変更の記録が始まる前に落ちた（journal は、最初の編集より先に作る）
        return Inspection::Residue;
    }
    let journal = match Journal::open(&journal_file) {
        Ok(journal) => journal,
        Err(error) => return Inspection::Unusable(format!("変更履歴を読めない: {error}")),
    };
    let (entry_count, session) = match (journal.entry_count(), journal.session()) {
        (Ok(count), Ok(session)) => (count, session),
        (Err(error), _) | (_, Err(error)) => {
            return Inspection::Unusable(format!("変更履歴を読めない: {error}"));
        }
    };
    if entry_count == 0 {
        return Inspection::Residue;
    }
    match working_project_id(&working_path(dir)) {
        Ok(id) if id == session.project_id => {}
        Ok(_) => return Inspection::Unusable("作業用の複製が別のプロジェクトのもの".to_owned()),
        Err(error) => return Inspection::Unusable(format!("作業用の複製を読めない: {error}")),
    }
    let (mtime, size) = file_stamp(project_db);
    let base_changed = mtime != session.base_mtime_ms || size != session.base_size;
    Inspection::Candidate(RecoveryCandidate {
        project_root: session.project_root,
        entry_count,
        last_change_at: session.last_change_at,
        base_changed,
        app_version: session.app_version,
    })
}
