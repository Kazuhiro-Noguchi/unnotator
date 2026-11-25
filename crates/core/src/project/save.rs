//! 保存（準備 → 実行 → 仕上げ）。research.md R7、contracts/api.md。
//!
//! 実行（`SaveJob::run`）は `ProjectStore` を借りないので、別スレッドで実行でき、その間も編集を続けられる。

use std::fs::OpenOptions;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};

use crate::error::StoreError;

/// 保存の実行の段階。テストで、その段階の直後に打ち切るために使う。
#[doc(hidden)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveStage {
    /// `VACUUM INTO` の後
    AfterVacuum,
    /// 出力の検証の後
    AfterVerify,
    /// `fsync` の後（名前の置き換えの前）
    AfterSync,
    /// 名前の置き換えの後
    AfterRename,
    /// 親ディレクトリの `fsync` の後
    AfterDirSync,
}

/// 保存の実行の結果。仕上げに渡す。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SaveOutcome {
    pub(crate) base_seq: i64,
    pub(crate) saved_count: u32,
    pub(crate) mtime_ms: Option<i64>,
    pub(crate) size: Option<i64>,
}

/// 準備で作る、保存の実行の指示。
#[derive(Debug)]
pub struct SaveJob {
    pub(crate) working: PathBuf,
    pub(crate) temporary: PathBuf,
    pub(crate) target: PathBuf,
    pub(crate) project_id: String,
    pub(crate) schema_version: u32,
    pub(crate) base_seq: i64,
    pub(crate) saved_count: u32,
}

fn io_error(error: std::io::Error) -> StoreError {
    StoreError::Io(error)
}

fn remove_if_exists(path: &Path) -> Result<(), StoreError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error(error)),
    }
}

/// 出力の版と `meta.project_id` を確かめる。
fn verify(path: &Path, project_id: &str, schema_version: u32) -> Result<(), StoreError> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version != i64::from(schema_version) {
        return Err(StoreError::Corrupt(format!(
            "保存した内容の版が想定と違う: {version}"
        )));
    }
    let stored: String = conn.query_row(
        "SELECT value FROM meta WHERE key = 'project_id'",
        [],
        |row| row.get(0),
    )?;
    if stored != project_id {
        return Err(StoreError::Corrupt(
            "保存した内容のプロジェクト ID が違う".to_owned(),
        ));
    }
    Ok(())
}

fn sync_file(path: &Path) -> Result<(), StoreError> {
    // Windows では、書き込みの権限が要る
    let file = OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(io_error)?;
    file.sync_all().map_err(io_error)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), StoreError> {
    let directory = std::fs::File::open(path).map_err(io_error)?;
    directory.sync_all().map_err(io_error)
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), StoreError> {
    Ok(())
}

impl SaveJob {
    /// 実行する。失敗したら、一時ファイルを削除して `Err`（元の `project.db` は無傷）。
    pub fn run(self) -> Result<SaveOutcome, StoreError> {
        self.execute(None, &mut |_| {})
    }

    /// 指定した段階の直後で打ち切る（テスト用）。その段階の状態のまま `Err(Aborted)` を返す。
    #[doc(hidden)]
    pub fn run_with_stop(self, stage: SaveStage) -> Result<SaveOutcome, StoreError> {
        self.execute(Some(stage), &mut |_| {})
    }

    /// 各段階の直後に `hook` を呼びながら実行する（テスト用。段階の間に編集を差し込むため）。
    #[doc(hidden)]
    pub fn run_with_hook(self, mut hook: impl FnMut(SaveStage)) -> Result<SaveOutcome, StoreError> {
        self.execute(None, &mut hook)
    }

    fn execute(
        self,
        stop: Option<SaveStage>,
        hook: &mut dyn FnMut(SaveStage),
    ) -> Result<SaveOutcome, StoreError> {
        match self.steps(stop, hook) {
            Ok(outcome) => Ok(outcome),
            Err(StoreError::Aborted) => Err(StoreError::Aborted),
            Err(error) => {
                let _ = std::fs::remove_file(&self.temporary);
                Err(error)
            }
        }
    }

    fn steps(
        &self,
        stop: Option<SaveStage>,
        hook: &mut dyn FnMut(SaveStage),
    ) -> Result<SaveOutcome, StoreError> {
        let mut stopped = |stage: SaveStage| -> Result<(), StoreError> {
            hook(stage);
            if stop == Some(stage) {
                Err(StoreError::Aborted)
            } else {
                Ok(())
            }
        };

        // 1. 古い一時ファイルを削除する
        remove_if_exists(&self.temporary)?;

        // 2. 作業用の複製を、一貫したスナップショットとして一時ファイルへ書き出す
        {
            let conn = Connection::open(&self.working)?;
            conn.execute(
                "VACUUM INTO ?1",
                [self.temporary.to_string_lossy().as_ref()],
            )?;
        }
        stopped(SaveStage::AfterVacuum)?;

        // 3. 出力を確かめる
        verify(&self.temporary, &self.project_id, self.schema_version)?;
        stopped(SaveStage::AfterVerify)?;

        // 4. ディスクへ書き切る
        sync_file(&self.temporary)?;
        stopped(SaveStage::AfterSync)?;

        // 5. 名前の置き換えで確定する
        std::fs::rename(&self.temporary, &self.target).map_err(io_error)?;
        stopped(SaveStage::AfterRename)?;

        // 6. 名前の置き換えを、ディスクへ書き切る
        if let Some(parent) = self.target.parent() {
            sync_directory(parent)?;
        }
        stopped(SaveStage::AfterDirSync)?;

        // 7. 新しい `project.db` の更新時刻・大きさ（外から変えられたかの判定の基準）
        let (mtime_ms, size) = crate::recovery::candidate::file_stamp(&self.target);
        Ok(SaveOutcome {
            base_seq: self.base_seq,
            saved_count: self.saved_count,
            mtime_ms,
            size,
        })
    }
}
