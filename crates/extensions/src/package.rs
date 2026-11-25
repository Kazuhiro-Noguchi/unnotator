//! `.unnoplugin`（zip）の検査と、安全な展開。
//!
//! 取り込み本体（`zip` クレートを使う）は、依存の承認（`unno-ceam`）のあとに入れる。
//! それまでは、取り込みの口だけを置き、常に「未対応」を返す。

use std::path::Path;

use crate::error::ExtensionError;
use crate::paths::AppPaths;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallOutcome {
    Installed { id: String, version: String },
    AlreadyInstalled { id: String, version: String },
}

pub fn install_package(
    _paths: &AppPaths,
    _package: &Path,
) -> Result<InstallOutcome, ExtensionError> {
    Err(ExtensionError::Package(
        "`.unnoplugin` の取り込みはまだ使えません（依存の承認待ち）".to_owned(),
    ))
}
