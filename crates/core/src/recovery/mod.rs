//! 保存と復元（003）。作業用データの配置・変更履歴（journal）・復元の候補・孤立したデータ。

pub mod candidate;
pub mod hash;
pub mod journal;
pub mod orphan;

use std::path::{Path, PathBuf};

/// 作業用データのディレクトリ名に付ける、退避の印。
pub const CORRUPT_MARK: &str = ".corrupt-";

/// プロジェクトのフォルダに対応する、作業用データのディレクトリ（`<root>/<hash>`）。
pub fn recovery_dir_for(root: &Path, folder: &Path) -> PathBuf {
    root.join(hash::path_hash(folder))
}

/// 作業用の複製。
pub fn working_path(dir: &Path) -> PathBuf {
    dir.join("working.db")
}

/// 変更履歴。
pub fn journal_path(dir: &Path) -> PathBuf {
    dir.join("journal.db")
}

/// 読めなかった作業用データの退避先（`<hash>.corrupt-<時刻>`）。
pub fn corrupt_dir_for(root: &Path, folder: &Path, now_ms: i64) -> PathBuf {
    root.join(format!("{}{CORRUPT_MARK}{now_ms}", hash::path_hash(folder)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("unnotator-rec-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn same_project_same_place_and_different_projects_differ() {
        let base = temp("layout");
        let (a, b) = (base.join("a"), base.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let root = base.join("recovery");
        assert_eq!(recovery_dir_for(&root, &a), recovery_dir_for(&root, &a));
        assert_eq!(
            recovery_dir_for(&root, &a),
            recovery_dir_for(&root, &a.join("."))
        );
        assert_ne!(recovery_dir_for(&root, &a), recovery_dir_for(&root, &b));
        assert_eq!(recovery_dir_for(&root, &a).parent(), Some(root.as_path()));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn file_names_inside_the_directory() {
        let dir = Path::new("/r/abc");
        assert_eq!(working_path(dir), Path::new("/r/abc/working.db"));
        assert_eq!(journal_path(dir), Path::new("/r/abc/journal.db"));
    }

    #[test]
    fn corrupt_directory_is_a_sibling_named_with_the_hash_and_time() {
        let base = temp("corrupt");
        let root = base.join("recovery");
        let name = hash::path_hash(&base);
        let moved = corrupt_dir_for(&root, &base, 1_700_000_000_123);
        assert_eq!(moved.parent(), Some(root.as_path()));
        assert_eq!(
            moved.file_name().and_then(|n| n.to_str()),
            Some(format!("{name}.corrupt-1700000000123").as_str())
        );
        std::fs::remove_dir_all(&base).unwrap();
    }
}
