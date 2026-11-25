//! 外部ルート（設定 `assets.externalRoots`: キー → フォルダ）。research.md R11。
//!
//! パスは、プロジェクトのフォルダからの相対（`..` を含んでよい）か絶対で書く。
//! 保存するときは、相対化できれば相対パスで、できなければ絶対パスで書く（フォルダごと動かしても使えるように）。

use std::path::{Component, Path, PathBuf};

use serde_json::{Map, Value};

use super::scan::RootSpec;

/// `target` を、`base` からの相対パスにする。両方が絶対パスで、同じ起点（同じドライブ）のときだけ。
pub fn relativize(base: &Path, target: &Path) -> Option<PathBuf> {
    if !base.is_absolute() || !target.is_absolute() {
        return None;
    }
    let base: Vec<Component<'_>> = base.components().collect();
    let target: Vec<Component<'_>> = target.components().collect();
    let common = base.iter().zip(&target).take_while(|(a, b)| a == b).count();
    // 起点（ドライブ・ルート）が違えば、相対化できない
    if common == 0 {
        return None;
    }
    let mut out = PathBuf::new();
    for _ in common..base.len() {
        out.push("..");
    }
    for component in &target[common..] {
        out.push(component.as_os_str());
    }
    if out.as_os_str().is_empty() {
        out.push(".");
    }
    Some(out)
}

/// `.` と `..` を字面で畳む（ファイルシステムは見ない）。
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 設定の値を、絶対パスにする。あるフォルダは、シンボリックリンクを解決した実体のパスにする（重なりの判定のため）。
pub fn resolve(folder: &Path, raw: &str) -> PathBuf {
    let path = Path::new(raw);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        folder.join(path)
    };
    let normalized = lexical(&joined);
    std::fs::canonicalize(&normalized).unwrap_or(normalized)
}

fn overlaps(a: &Path, b: &Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
}

/// 設定の値（キー → パス）の検証。形式は `settings::keys` が確かめるので、ここでは重なりを見る。
pub fn validate(folder: &Path, value: &Value) -> Result<(), String> {
    let Some(map) = value.as_object() else {
        return Err("オブジェクトでなければならない".to_owned());
    };
    let project = std::fs::canonicalize(folder).unwrap_or_else(|_| lexical(folder));
    let mut seen: Vec<(&String, PathBuf)> = Vec::new();
    for (key, raw) in map {
        let path = resolve(&project, raw.as_str().unwrap_or_default());
        if overlaps(&path, &project) {
            return Err(format!("{key}: プロジェクトのフォルダと重なっている"));
        }
        if let Some((other, _)) = seen.iter().find(|(_, p)| overlaps(p, &path)) {
            return Err(format!("{key}: {other} と同じ場所か、重なっている"));
        }
        seen.push((key, path));
    }
    Ok(())
}

/// 走査に使うルートの一覧。問題のあるもの（重なり）は使わない。
pub fn specs(folder: &Path, map: &Map<String, Value>) -> Vec<RootSpec> {
    let project = std::fs::canonicalize(folder).unwrap_or_else(|_| lexical(folder));
    let mut used: Vec<RootSpec> = Vec::new();
    for (key, raw) in map {
        let Some(raw) = raw.as_str() else {
            continue;
        };
        let path = resolve(&project, raw);
        if key.is_empty() || key.contains('/') || overlaps(&path, &project) {
            continue;
        }
        if used.iter().any(|root| overlaps(&root.path, &path)) {
            continue;
        }
        used.push(RootSpec {
            key: key.clone(),
            path,
        });
    }
    used
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn relativize_between_siblings_children_and_equal_paths() {
        assert_eq!(
            relativize(Path::new("/a/b/p"), Path::new("/a/b/raw")),
            Some(PathBuf::from("../raw"))
        );
        assert_eq!(
            relativize(Path::new("/a"), Path::new("/a/b/c")),
            Some(PathBuf::from("b/c"))
        );
        assert_eq!(
            relativize(Path::new("/a"), Path::new("/a")),
            Some(PathBuf::from("."))
        );
        assert_eq!(relativize(Path::new("a"), Path::new("/a")), None);
    }

    #[test]
    fn resolve_folds_dots_and_trailing_slashes() {
        let folder = Path::new("/nonexistent-root/p");
        assert_eq!(
            resolve(folder, "../raw/"),
            PathBuf::from("/nonexistent-root/raw")
        );
        assert_eq!(
            resolve(folder, "./x/../y"),
            PathBuf::from("/nonexistent-root/p/y")
        );
        assert_eq!(resolve(folder, "/abs/dir"), PathBuf::from("/abs/dir"));
    }

    #[test]
    fn validate_rejects_overlaps_and_specs_skips_them() {
        let folder = Path::new("/nonexistent-root/p");
        assert!(validate(folder, &json!({"a": "../raw", "b": "../other"})).is_ok());
        assert!(validate(folder, &json!({"a": "."})).is_err());
        assert!(validate(folder, &json!({"a": "sub"})).is_err());
        assert!(validate(folder, &json!({"a": "../.."})).is_err());
        assert!(validate(folder, &json!({"a": "../raw", "b": "../raw/x"})).is_err());
        let map = json!({"a": "../raw", "b": "../raw/x", "c": "../other"});
        let used = specs(folder, map.as_object().unwrap());
        let keys: Vec<_> = used.iter().map(|r| r.key.as_str()).collect();
        assert_eq!(keys, ["a", "c"]);
    }
}
