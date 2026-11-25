//! `.unnotator/` の配置。

use std::path::{Path, PathBuf};

pub const DIR_NAME: &str = ".unnotator";

#[derive(Debug, Clone)]
pub struct ProjectLayout {
    pub folder: PathBuf,
    /// `<プロジェクトフォルダ>/.unnotator`
    pub dir: PathBuf,
    pub db: PathBuf,
    pub lock: PathBuf,
    /// 移行前の退避（US5）。
    pub backup: PathBuf,
}

impl ProjectLayout {
    pub fn new(folder: &Path) -> Self {
        let dir = folder.join(DIR_NAME);
        Self {
            folder: folder.to_path_buf(),
            db: dir.join("project.db"),
            lock: dir.join("lock"),
            backup: dir.join("project.db.bak"),
            dir,
        }
    }
}
