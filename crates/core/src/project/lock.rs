//! プロジェクトのロック。OS のファイルロック（`File::try_lock`）を使う（research.md R1）。
//!
//! 持ち主のプロセスが落ちると OS がロックを解放するので、残留ロックの判定は要らない。

use std::fs::{File, OpenOptions, TryLockError};
use std::io::Write;
use std::path::Path;

use crate::error::StoreError;

#[derive(Debug)]
pub struct ProjectLock {
    file: File,
}

impl ProjectLock {
    /// ロックを取る。別の持ち主がいれば `InUse`。
    pub fn acquire(path: &Path) -> Result<Self, StoreError> {
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?;
        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => return Err(StoreError::InUse),
            Err(TryLockError::Error(error)) => return Err(StoreError::Io(error)),
        }
        // 診断のために持ち主の情報を書く。判定には使わない。
        file.set_len(0)?;
        writeln!(file, "pid={}", std::process::id())?;
        Ok(Self { file })
    }

    /// 明示的に解放する（`Drop` でも解放される）。
    pub fn release(self) -> Result<(), StoreError> {
        self.file.unlock()?;
        Ok(())
    }
}
