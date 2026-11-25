//! `.unnotator/extensions.json` の読み込みと、導入済みの拡張機能との突き合わせ（research.md R8、contracts/settings.md）。
//!
//! 読み取りだけ（作らない・書き換えない）。導入や依存解決は 005 の範囲で、ここは「何が足りないか」を示すだけ。

use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 導入済みの拡張機能（呼び出し側が渡す）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct InstalledExtension {
    pub id: String,
    pub version: String,
}

/// `extensions.json` に書かれた、必要な拡張機能。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct RequiredExtension {
    pub id: String,
    /// 必要な版の範囲（`1.2.3`・`^1.2.3`・`~1.2.3`・`>=1.2.3`・`*`）。
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct VersionMismatch {
    pub id: String,
    pub required: String,
    pub installed: String,
}

/// 読めなかった行・ファイルの理由。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ExtensionsWarning {
    pub why: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ExtensionCheck {
    pub missing: Vec<RequiredExtension>,
    pub version_mismatch: Vec<VersionMismatch>,
    pub warnings: Vec<ExtensionsWarning>,
}

fn warn(warnings: &mut Vec<ExtensionsWarning>, why: impl Into<String>) {
    warnings.push(ExtensionsWarning { why: why.into() });
}

/// ファイルを読む。無ければ空。壊れていれば、空と警告。
pub fn read(path: &Path) -> (Vec<RequiredExtension>, Vec<ExtensionsWarning>) {
    let mut warnings = Vec::new();
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (Vec::new(), warnings);
        }
        Err(error) => {
            warn(
                &mut warnings,
                format!("extensions.json を読めない: {error}"),
            );
            return (Vec::new(), warnings);
        }
    };
    let value: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(error) => {
            warn(
                &mut warnings,
                format!("extensions.json が JSON ではない: {error}"),
            );
            return (Vec::new(), warnings);
        }
    };
    let Some(root) = value.as_object() else {
        warn(
            &mut warnings,
            "extensions.json の最上位がオブジェクトではない",
        );
        return (Vec::new(), warnings);
    };
    if root.get("version").and_then(Value::as_i64) != Some(1) {
        warn(&mut warnings, "extensions.json の版が未対応（1 のみ対応）");
        return (Vec::new(), warnings);
    }
    let Some(rows) = root.get("extensions").and_then(Value::as_array) else {
        warn(
            &mut warnings,
            "extensions.json の extensions が配列ではない",
        );
        return (Vec::new(), warnings);
    };
    let mut seen = HashSet::new();
    let mut required = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let id = row.get("id").and_then(Value::as_str).unwrap_or_default();
        let version = row.get("version").and_then(Value::as_str);
        let (Some(version), false) = (version, id.is_empty()) else {
            warn(
                &mut warnings,
                format!("{} 行目: id と version（文字列）が必要", index + 1),
            );
            continue;
        };
        if version_satisfies(version, "0.0.0").is_none() {
            warn(
                &mut warnings,
                format!("{} 行目 {id}: 版の範囲を読めない: {version}", index + 1),
            );
            continue;
        }
        if !seen.insert(id.to_owned()) {
            warn(
                &mut warnings,
                format!("{} 行目: {id} が重複している（先の行を使う）", index + 1),
            );
            continue;
        }
        required.push(RequiredExtension {
            id: id.to_owned(),
            version: version.to_owned(),
        });
    }
    (required, warnings)
}

/// 必要なものと導入済みを突き合わせる。
pub fn check(
    required: &[RequiredExtension],
    installed: &[InstalledExtension],
    warnings: Vec<ExtensionsWarning>,
) -> ExtensionCheck {
    let mut result = ExtensionCheck {
        warnings,
        ..ExtensionCheck::default()
    };
    for need in required {
        match installed.iter().find(|i| i.id == need.id) {
            None => result.missing.push(need.clone()),
            Some(have) => {
                if version_satisfies(&need.version, &have.version) != Some(true) {
                    result.version_mismatch.push(VersionMismatch {
                        id: need.id.clone(),
                        required: need.version.clone(),
                        installed: have.version.clone(),
                    });
                }
            }
        }
    }
    result
}

type Version = (u64, u64, u64);

/// `x[.y[.z]]`（`-` `+` 以降は無視）。いくつの部分があったかも返す。
fn parse_version(text: &str) -> Option<(Version, usize)> {
    let core = text.split(['-', '+']).next()?;
    let parts: Vec<&str> = core.split('.').collect();
    if parts.is_empty() || parts.len() > 3 {
        return None;
    }
    let mut numbers = [0u64; 3];
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        numbers[i] = part.parse().ok()?;
    }
    Some(((numbers[0], numbers[1], numbers[2]), parts.len()))
}

/// 版 `version` が範囲 `range` に入るか。範囲を読めなければ `None`。版を読めなければ `Some(false)`。
pub fn version_satisfies(range: &str, version: &str) -> Option<bool> {
    let range = range.trim();
    if range == "*" {
        return Some(true);
    }
    let (kind, rest) = if let Some(rest) = range.strip_prefix(">=") {
        ('>', rest)
    } else if let Some(rest) = range.strip_prefix('^') {
        ('^', rest)
    } else if let Some(rest) = range.strip_prefix('~') {
        ('~', rest)
    } else {
        ('=', range)
    };
    let (base, parts) = parse_version(rest.trim())?;
    let Some((have, _)) = parse_version(version.trim()) else {
        return Some(false);
    };
    let (major, minor, patch) = base;
    let satisfied = match kind {
        '=' => have == base,
        '>' => have >= base,
        '~' => {
            let upper = if parts >= 2 {
                (major, minor + 1, 0)
            } else {
                (major + 1, 0, 0)
            };
            have >= base && have < upper
        }
        _ => {
            let upper = if major > 0 || parts == 1 {
                (major + 1, 0, 0)
            } else if minor > 0 || parts == 2 {
                (0, minor + 1, 0)
            } else {
                (0, 0, patch + 1)
            };
            have >= base && have < upper
        }
    };
    Some(satisfied)
}

/// 2 つの版を、SemVer の優先順位で比べる。`x.y.z`（`-プレリリース`・`+ビルド` は任意）だけを読む。
/// どちらかを読めなければ `None`。ビルドのメタ情報は無視する。
pub fn compare_versions(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    let (core_a, pre_a) = parse_full_version(a)?;
    let (core_b, pre_b) = parse_full_version(b)?;
    match core_a.cmp(&core_b) {
        std::cmp::Ordering::Equal => {}
        other => return Some(other),
    }
    Some(match (pre_a, pre_b) {
        (None, None) => std::cmp::Ordering::Equal,
        // プレリリースは、同じ版のリリースより古い
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(x), Some(y)) => compare_prerelease(&x, &y),
    })
}

fn parse_full_version(text: &str) -> Option<(Version, Option<Vec<String>>)> {
    let text = text.trim();
    let without_build = text.split('+').next()?;
    let (core, pre) = match without_build.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (without_build, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let mut numbers = [0u64; 3];
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        numbers[i] = part.parse().ok()?;
    }
    let pre = match pre {
        None => None,
        Some(p) => {
            let ids: Vec<String> = p.split('.').map(str::to_owned).collect();
            if ids.iter().any(|id| {
                id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            }) {
                return None;
            }
            Some(ids)
        }
    };
    Some(((numbers[0], numbers[1], numbers[2]), pre))
}

fn compare_prerelease(a: &[String], b: &[String]) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    for (x, y) in a.iter().zip(b.iter()) {
        let numeric = |s: &str| s.bytes().all(|c| c.is_ascii_digit());
        let order = match (numeric(x), numeric(y)) {
            (true, true) => {
                // 桁が多い数字は、先に長さで比べる（u64 に収まらない場合のため）
                let (xt, yt) = (x.trim_start_matches('0'), y.trim_start_matches('0'));
                xt.len().cmp(&yt.len()).then_with(|| xt.cmp(yt))
            }
            // 数字だけの識別子は、文字を含むものより小さい
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            (false, false) => x.cmp(y),
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    a.len().cmp(&b.len())
}
