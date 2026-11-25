//! 導入済みの拡張機能の走査・削除・作業フォルダの片付け。
//! 導入済みは、`extensions/<id>/<version>/unnotator-plugin.json` があるフォルダの集合（索引ファイルは持たない）。

use std::path::Path;

use crate::error::ExtensionError;
use crate::manifest::parse_manifest;
use crate::manifest::text::Locales;
use crate::paths::{AppPaths, check_id, check_version};
use crate::registry::{Origin, Problem, ProblemKind, RawExtension};

pub const MANIFEST_FILE: &str = "unnotator-plugin.json";

#[derive(Debug, Default)]
pub struct ScanInstalled {
    pub found: Vec<RawExtension>,
    pub problems: Vec<Problem>,
}

fn package_problem(id: &str, version: &str, kind: ProblemKind, message: String) -> Problem {
    Problem {
        extension_id: id.to_owned(),
        version: Some(version.to_owned()),
        kind,
        pointer: String::new(),
        message,
        detail: None,
    }
}

/// フォルダ 1 つを読む。マニフェストは契約のスキーマで検証する。違反は、位置つきの `Problem` で返す。
pub fn read_extension_dir(dir: &Path, origin: Origin) -> Result<RawExtension, Vec<Problem>> {
    let folder_problem = |message: String| {
        vec![Problem {
            extension_id: String::new(),
            version: None,
            kind: ProblemKind::Package,
            pointer: String::new(),
            message: format!("{}: {message}", dir.display()),
            detail: None,
        }]
    };
    let bytes = std::fs::read(dir.join(MANIFEST_FILE))
        .map_err(|e| folder_problem(format!("{MANIFEST_FILE} を読めません: {e}")))?;
    let manifest = parse_manifest(&bytes)?;
    let (locales, warnings) = Locales::load(dir);
    Ok(RawExtension::new(dir.to_owned(), origin, manifest).with_locales(locales, warnings))
}

fn subdirs(dir: &Path) -> Vec<(String, std::path::PathBuf)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<_> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| Some((e.file_name().to_str()?.to_owned(), e.path())))
        .filter(|(name, _)| !name.starts_with('.'))
        .collect();
    out.sort();
    out
}

/// `extensions/` を歩いて、導入済みを集める。読めないもの・名前の食い違うものは `Problem` にする。
pub fn scan_installed(paths: &AppPaths) -> ScanInstalled {
    let mut scanned = ScanInstalled::default();
    for (id, id_dir) in subdirs(&paths.extensions_dir()) {
        for (version, dir) in subdirs(&id_dir) {
            match read_extension_dir(&dir, Origin::Installed) {
                Err(problems) => scanned.problems.extend(problems.into_iter().map(|mut p| {
                    if p.extension_id.is_empty() {
                        p.extension_id.clone_from(&id);
                        p.version = Some(version.clone());
                    }
                    p
                })),
                Ok(raw) if raw.id != id || raw.version != version => {
                    scanned.problems.push(package_problem(
                        &id,
                        &version,
                        ProblemKind::ManifestSemantic,
                        format!(
                            "フォルダ名（{id} {version}）とマニフェスト（{} {}）が食い違っています",
                            raw.id, raw.version
                        ),
                    ));
                }
                Ok(raw) => scanned.found.push(raw),
            }
        }
    }
    scanned
}

/// 削除する。`version` が無ければ全版。無ければ `NotFound`。
pub fn remove_extension(
    paths: &AppPaths,
    id: &str,
    version: Option<&str>,
) -> Result<(), ExtensionError> {
    check_id(id)?;
    let target = match version {
        Some(v) => {
            check_version(v)?;
            paths.extensions_dir().join(id).join(v)
        }
        None => paths.extensions_dir().join(id),
    };
    if !target.is_dir() {
        return Err(ExtensionError::NotFound(format!(
            "{id} {}",
            version.unwrap_or("*")
        )));
    }
    std::fs::remove_dir_all(&target)?;
    // 版が 1 つも無くなった ID のフォルダは、片付ける
    let id_dir = paths.extensions_dir().join(id);
    if id_dir.is_dir() && subdirs(&id_dir).is_empty() {
        let _ = std::fs::remove_dir(&id_dir);
    }
    Ok(())
}

/// 取り込み中の作業フォルダを空にする（起動時。強制終了の跡を片付ける）。
pub fn cleanup_staging(paths: &AppPaths) -> Result<(), ExtensionError> {
    let staging = paths.staging_dir();
    let Ok(entries) = std::fs::read_dir(&staging) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            std::fs::remove_dir_all(&path)?;
        } else {
            std::fs::remove_file(&path)?;
        }
    }
    Ok(())
}
