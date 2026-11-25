//! パスの閉じ込め。許された根の外へ出る読み取りを、ここで止める。

use std::path::{Component, Path, PathBuf};

use super::ServeError;

#[cfg(windows)]
fn is_reparse(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse(_meta: &std::fs::Metadata) -> bool {
    false
}

/// 拡張機能・ブロブの置き場: 成分ごとに調べ、リンク（シンボリックリンク・Windows の接合点）が 1 つでもあれば拒む。
/// 成分は、`url::check_segment` を通った（または同等に検査した）ものを渡す。
pub fn confine_no_links(root: &Path, segments: &[String]) -> Result<PathBuf, ServeError> {
    let mut path = root.to_path_buf();
    for segment in segments {
        path.push(segment);
        match std::fs::symlink_metadata(&path) {
            Ok(meta) => {
                if meta.file_type().is_symlink() || is_reparse(&meta) {
                    return Err(ServeError::Forbidden);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(ServeError::NotFound),
            Err(_) => return Err(ServeError::Forbidden),
        }
    }
    Ok(path)
}

/// アセット: ルートの中にあることを、実パスで確かめる。中を指すリンクは通し、外へ出るリンクは拒む。
/// ルート直下の `.unnotator/` は、内側でも読ませない。`rel` は DB の相対パス（区切りは `/`）。
pub fn confine_inside(root: &Path, rel: &str) -> Result<PathBuf, ServeError> {
    if rel.is_empty() || rel.contains('\\') || rel.contains('\0') {
        return Err(ServeError::Forbidden);
    }
    let relative = Path::new(rel);
    if relative.is_absolute()
        || relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(ServeError::Forbidden);
    }
    if is_internal(relative) {
        return Err(ServeError::Forbidden);
    }
    let canonical_root = std::fs::canonicalize(root).map_err(|_| ServeError::NotFound)?;
    let canonical = match std::fs::canonicalize(root.join(relative)) {
        Ok(path) => path,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(ServeError::NotFound),
        Err(_) => return Err(ServeError::Forbidden),
    };
    let inside = canonical
        .strip_prefix(&canonical_root)
        .map_err(|_| ServeError::Forbidden)?;
    if is_internal(inside) {
        return Err(ServeError::Forbidden);
    }
    Ok(canonical)
}

/// 先頭が `.unnotator`（大文字小文字を区別しない）か。
fn is_internal(relative: &Path) -> bool {
    relative
        .components()
        .next()
        .and_then(|c| c.as_os_str().to_str().map(str::to_lowercase))
        .is_some_and(|first| first == ".unnotator")
}
