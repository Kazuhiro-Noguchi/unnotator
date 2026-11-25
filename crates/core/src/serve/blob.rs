//! ブロブの置き場（Python ワーカーが書く）と、プレビューのキャッシュ。どちらも、直下の名前だけを引く。

use std::path::{Path, PathBuf};

use super::ServeError;
use super::url::check_segment;

/// 置き場の直下の名前として安全か（区切りなし・先頭がドットでない）。
fn check_name(name: &str) -> Result<(), ServeError> {
    check_segment(name)?;
    if name.starts_with('.') {
        return Err(ServeError::BadRequest("先頭がドット".to_owned()));
    }
    Ok(())
}

/// 直下の `name` を、リンクでないことを確かめて返す。
fn resolve_direct(dir: &Path, name: &str) -> Result<PathBuf, ServeError> {
    check_name(name)?;
    let path = dir.join(name);
    match std::fs::symlink_metadata(&path) {
        Ok(meta) if meta.file_type().is_symlink() => Err(ServeError::Forbidden),
        Ok(_) => Ok(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(ServeError::NotFound),
        Err(_) => Err(ServeError::Forbidden),
    }
}

/// ブロブの置き場（`blobDir`）。
#[derive(Debug, Clone)]
pub struct BlobStore {
    dir: PathBuf,
}

impl BlobStore {
    /// 置き場を作る（無ければ）。
    pub fn open(dir: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(&dir)?;
        Ok(Self { dir })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// 中身をすべて消す（起動時の片付け）。置き場そのものは残す。
    pub fn clear(&self) -> std::io::Result<()> {
        for entry in std::fs::read_dir(&self.dir)? {
            let path = entry?.path();
            let meta = std::fs::symlink_metadata(&path)?;
            if meta.is_dir() {
                std::fs::remove_dir_all(&path)?;
            } else {
                std::fs::remove_file(&path)?;
            }
        }
        Ok(())
    }

    pub fn resolve(&self, name: &str) -> Result<PathBuf, ServeError> {
        resolve_direct(&self.dir, name)
    }
}

/// サムネイルのキャッシュ（アセット ID → ファイル）。読むだけ。
#[derive(Debug, Clone)]
pub struct PreviewCache {
    dir: PathBuf,
}

impl PreviewCache {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn resolve(&self, asset_id: &str) -> Result<PathBuf, ServeError> {
        resolve_direct(&self.dir, asset_id)
    }
}
