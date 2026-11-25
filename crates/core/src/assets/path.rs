//! アセットのパスの正規化と、重複の検出に使う比較用のキー。
//!
//! `rel_path` の規則は契約（`assets.rel_path` の CHECK）と `data-model.md` の `AssetRow.rel_path`。

use std::path::Path;

use thiserror::Error;

/// `.unnotator/` はプロジェクトの内部。どのルートでも、この名前の部分を持つパスは扱わない。
pub const RESERVED_DIR: &str = ".unnotator";

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PathError {
    #[error("パスが空です")]
    Empty,
    #[error("パスが絶対パスです: {0}")]
    Absolute(String),
    #[error("パスに . や .. の部分があります: {0}")]
    DotSegment(String),
    #[error("予約された名前を含みます: {0}")]
    Reserved(String),
}

/// 区切りを `/` に直し、契約の規則に合うか確かめる。保存・比較する前に必ず通す。
pub fn normalize_rel(raw: &str) -> Result<String, PathError> {
    let unified = raw.replace('\\', "/");
    if unified.is_empty() {
        return Err(PathError::Empty);
    }
    if unified.starts_with('/') || has_drive_prefix(&unified) {
        return Err(PathError::Absolute(raw.to_owned()));
    }
    let mut parts = Vec::new();
    for part in unified.split('/') {
        match part {
            "" => {} // 連続した区切りは 1 つにまとめる
            "." | ".." => return Err(PathError::DotSegment(raw.to_owned())),
            _ if part.eq_ignore_ascii_case(RESERVED_DIR) => {
                return Err(PathError::Reserved(raw.to_owned()));
            }
            _ => parts.push(nfc(part)),
        }
    }
    if parts.is_empty() {
        return Err(PathError::Empty);
    }
    Ok(parts.join("/"))
}

fn has_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// Unicode の正規化（NFC）。
///
/// `unicode-normalization` が承認されるまでは、バイト列のまま返す（research.md R3 の縮退）。
/// macOS で NFD の名前と NFC の名前が別物になりうる、という既知の限界。
pub fn nfc(text: &str) -> String {
    text.to_owned()
}

/// 重複の検出に使う比較用のキー。保存する綴りは変えない。
pub fn compare_key(rel: &str, case_insensitive: bool) -> String {
    if case_insensitive {
        rel.to_lowercase()
    } else {
        rel.to_owned()
    }
}

/// `dir` があるファイルシステムが、大文字小文字を区別しないか。
/// フォルダの中を書き換えずに、既にある名前の大文字小文字を入れ替えた名前が同じものを指すかで確かめる。
/// 確かめる名前が無い（空のフォルダなど）ときは、OS の一般的な既定（Windows・macOS は区別しない）にする。
pub fn fs_is_case_insensitive(dir: &Path) -> bool {
    let default = cfg!(any(target_os = "windows", target_os = "macos"));
    let Ok(entries) = std::fs::read_dir(dir) else {
        return default;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let flipped: String = name
            .chars()
            .map(|c| {
                if c.is_lowercase() {
                    c.to_uppercase().next().unwrap_or(c)
                } else if c.is_uppercase() {
                    c.to_lowercase().next().unwrap_or(c)
                } else {
                    c
                }
            })
            .collect();
        if flipped == name {
            continue;
        }
        return dir.join(&flipped).symlink_metadata().is_ok();
    }
    default
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unifies_separators_and_collapses_duplicates() {
        assert_eq!(normalize_rel("a\\b//c.txt").unwrap(), "a/b/c.txt");
        assert_eq!(normalize_rel("file.txt").unwrap(), "file.txt");
    }

    #[test]
    fn rejects_values_the_contract_forbids() {
        assert_eq!(normalize_rel(""), Err(PathError::Empty));
        assert_eq!(normalize_rel("//"), Err(PathError::Absolute("//".into())));
        assert!(matches!(normalize_rel("/a"), Err(PathError::Absolute(_))));
        assert!(matches!(
            normalize_rel("C:\\a"),
            Err(PathError::Absolute(_))
        ));
        assert!(matches!(
            normalize_rel("a/../b"),
            Err(PathError::DotSegment(_))
        ));
        assert!(matches!(
            normalize_rel("./a"),
            Err(PathError::DotSegment(_))
        ));
    }

    #[test]
    fn rejects_the_reserved_directory_in_any_case() {
        assert!(matches!(
            normalize_rel(".unnotator/project.db"),
            Err(PathError::Reserved(_))
        ));
        assert!(matches!(
            normalize_rel("a/.UNNOTATOR/x"),
            Err(PathError::Reserved(_))
        ));
        assert!(normalize_rel(".unnotator-notes.txt").is_ok());
    }

    #[test]
    fn compare_key_folds_case_only_when_asked() {
        assert_eq!(compare_key("A/B.TXT", true), "a/b.txt");
        assert_eq!(compare_key("A/B.TXT", false), "A/B.TXT");
    }

    #[test]
    fn japanese_names_are_kept() {
        assert_eq!(normalize_rel("画像\\猫.png").unwrap(), "画像/猫.png");
    }

    #[test]
    fn case_probe_matches_the_real_file_system() {
        let dir = std::env::temp_dir().join(format!("unno-case-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Probe.txt"), b"").unwrap();
        let insensitive = dir.join("probe.TXT").exists();
        assert_eq!(fs_is_case_insensitive(&dir), insensitive);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
