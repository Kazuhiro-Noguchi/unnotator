//! ファイルを安全に書き切るための共通の部品（保存と設定ファイルが使う）。

use std::fs::OpenOptions;
use std::path::Path;

use crate::error::StoreError;

/// ファイルの内容をディスクへ書き切る。
pub fn sync_file(path: &Path) -> Result<(), StoreError> {
    // Windows では、書き込みの権限が要る
    let file = OpenOptions::new().write(true).open(path)?;
    file.sync_all()?;
    Ok(())
}

/// ディレクトリの変更（名前の置き換え）をディスクへ書き切る。Unix のみ。
#[cfg(unix)]
pub fn sync_directory(path: &Path) -> Result<(), StoreError> {
    let directory = std::fs::File::open(path)?;
    directory.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
pub fn sync_directory(_path: &Path) -> Result<(), StoreError> {
    Ok(())
}

/// 書き込みの段階。テストで、その段階の直後に打ち切るために使う。
#[doc(hidden)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteStage {
    /// 一時ファイルへ書いた後
    AfterWrite,
    /// 一時ファイルの `fsync` の後（置き換えの前）
    AfterSync,
    /// 名前の置き換えの後
    AfterRename,
}

/// `path` を、一時ファイル → `fsync` → 名前の置き換え → フォルダの `fsync` で書く。
/// 途中で落ちても、元の内容か新しい完全な内容のどちらかが残る。`stop` の段階の直後で `Aborted` を返す（テスト用）。
pub fn atomic_write(path: &Path, bytes: &[u8], stop: Option<WriteStage>) -> Result<(), StoreError> {
    let parent = path.parent().ok_or_else(|| {
        StoreError::NotFound(format!(
            "書き込み先のフォルダがありません: {}",
            path.display()
        ))
    })?;
    std::fs::create_dir_all(parent)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temporary = parent.join(format!("{name}.tmp-{}", std::process::id()));
    let result = (|| {
        std::fs::write(&temporary, bytes)?;
        if stop == Some(WriteStage::AfterWrite) {
            return Err(StoreError::Aborted);
        }
        sync_file(&temporary)?;
        if stop == Some(WriteStage::AfterSync) {
            return Err(StoreError::Aborted);
        }
        std::fs::rename(&temporary, path)?;
        if stop == Some(WriteStage::AfterRename) {
            return Err(StoreError::Aborted);
        }
        sync_directory(parent)
    })();
    // 置き換えの前に失敗・打ち切りになったときは、一時ファイルを残さない（置き換え後は既に無い）
    if result.is_err() && temporary.exists() && stop != Some(WriteStage::AfterWrite) {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}
