//! アプリの領域の置き場（拡張機能・ブロブ・同意・状態）。
//!
//! 置き場所そのものは、アプリ本体（`src-tauri`）が決めて渡す。ここは、その下の構造だけを知っている。

use std::path::{Path, PathBuf};

use crate::error::ExtensionError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppPaths {
    data: PathBuf,
    cache: PathBuf,
}

impl AppPaths {
    /// `data_dir` は `<アプリのデータ>/unnotator`、`cache_dir` は `<アプリのキャッシュ>/unnotator` に当たる置き場。
    pub fn new(data_dir: &Path, cache_dir: &Path) -> Self {
        Self {
            data: data_dir.to_owned(),
            cache: cache_dir.to_owned(),
        }
    }

    /// ポータブル版: 実行ファイルの隣の `data/` の下に、すべてを置く。
    pub fn portable(exe_dir: &Path) -> Self {
        let data = exe_dir.join("data");
        let cache = data.join("cache");
        Self { data, cache }
    }

    pub fn data_dir(&self) -> &Path {
        &self.data
    }

    pub fn extensions_dir(&self) -> PathBuf {
        self.data.join("extensions")
    }

    /// 取り込み中の作業フォルダ（起動時に空にする）。
    pub fn staging_dir(&self) -> PathBuf {
        self.extensions_dir().join(".staging")
    }

    pub fn permissions_file(&self) -> PathBuf {
        self.data.join("permissions.json")
    }

    pub fn state_file(&self) -> PathBuf {
        self.data.join("extensions-state.json")
    }

    /// ブロブの置き場（`blobDir`）。
    pub fn blobs_dir(&self) -> PathBuf {
        self.data.join("blobs")
    }

    pub fn previews_dir(&self) -> PathBuf {
        self.cache.join("previews")
    }

    /// `extensions/<id>/<version>/`。`id`・`version` が置き場の外に出る形なら拒む。
    pub fn extension_dir(&self, id: &str, version: &str) -> Result<PathBuf, ExtensionError> {
        check_id(id)?;
        check_version(version)?;
        Ok(self.extensions_dir().join(id).join(version))
    }
}

/// 拡張機能の ID として、フォルダ名に使える形か（英数・`.`・`-`。先頭は `.` でない）。
pub fn check_id(id: &str) -> Result<(), ExtensionError> {
    let ok = !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('.')
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
        && !id.contains("..");
    if ok {
        Ok(())
    } else {
        Err(ExtensionError::Invalid(format!(
            "拡張機能の ID として使えません: {id:?}"
        )))
    }
}

/// 版として、フォルダ名に使える形か（英数・`.`・`-`・`+`。先頭は数字）。
pub fn check_version(version: &str) -> Result<(), ExtensionError> {
    let ok = !version.is_empty()
        && version.len() <= 64
        && version.as_bytes()[0].is_ascii_digit()
        && version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'+')
        && !version.contains("..");
    if ok {
        Ok(())
    } else {
        Err(ExtensionError::Invalid(format!(
            "版として使えません: {version:?}"
        )))
    }
}
