//! 媒体種別の判定規則。規則は外から渡される値（拡張機能のマニフェストから 005 が作る）で、
//! コアは表を持たない（憲章 I）。拡張子・MIME のどちらかに当てはまった最初の規則の種別 ID を返す。

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum MediaRuleError {
    #[error("媒体種別 ID の形式が正しくありません: {0}")]
    InvalidId(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct MediaRule {
    /// 契約の CHECK（`media_type GLOB '*/*'`）を満たす ID。
    pub media_type: String,
    /// 拡張子（ドット無し。`tar.gz` のように複数のドットも可）。大文字小文字は区別しない。
    #[serde(default)]
    pub extensions: Vec<String>,
    #[serde(default)]
    pub mime_types: Vec<String>,
}

/// 規則の集合。先に宣言されたものが勝つ。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct MediaRules {
    rules: Vec<MediaRule>,
}

impl MediaRules {
    pub fn new() -> Self {
        Self::default()
    }

    /// 規則を末尾に足す。種別 ID が `<名前空間>/<名前>` の形でなければ拒む。
    pub fn push(&mut self, rule: MediaRule) -> Result<(), MediaRuleError> {
        let valid = rule
            .media_type
            .split_once('/')
            .is_some_and(|(a, b)| !a.is_empty() && !b.is_empty());
        if !valid {
            return Err(MediaRuleError::InvalidId(rule.media_type));
        }
        self.rules.push(MediaRule {
            extensions: rule
                .extensions
                .iter()
                .map(|e| e.trim_start_matches('.').to_lowercase())
                .collect(),
            mime_types: rule.mime_types.iter().map(|m| m.to_lowercase()).collect(),
            media_type: rule.media_type,
        });
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    /// ファイル名から判定する。当てはまらなければ `None`（「不明」）。
    /// `a.tar.gz` は、長い拡張子（`tar.gz`）→ 短い拡張子（`gz`）の順に試す。
    pub fn classify(&self, file_name: &str) -> Option<&str> {
        let lower = file_name.to_lowercase();
        // 先頭のドットだけの名前（`.gitignore`）は拡張子を持たない。
        let body = lower.strip_prefix('.').unwrap_or(&lower);
        let mut start = 0;
        while let Some(dot) = body[start..].find('.') {
            let ext = &body[start + dot + 1..];
            if !ext.is_empty()
                && let Some(found) = self.by_extension(ext)
            {
                return Some(found);
            }
            start += dot + 1;
        }
        None
    }

    fn by_extension(&self, ext: &str) -> Option<&str> {
        self.rules
            .iter()
            .find(|r| r.extensions.iter().any(|e| e == ext))
            .map(|r| r.media_type.as_str())
    }

    /// MIME から判定する（`unno://` など、MIME を持っている呼び出し側が使う）。
    pub fn classify_mime(&self, mime: &str) -> Option<&str> {
        let lower = mime.to_lowercase();
        self.rules
            .iter()
            .find(|r| r.mime_types.contains(&lower))
            .map(|r| r.media_type.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(id: &str, exts: &[&str], mimes: &[&str]) -> MediaRule {
        MediaRule {
            media_type: id.to_owned(),
            extensions: exts.iter().map(|s| (*s).to_owned()).collect(),
            mime_types: mimes.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    fn rules() -> MediaRules {
        let mut r = MediaRules::new();
        r.push(rule("test/text", &["txt", "md"], &["text/plain"]))
            .unwrap();
        r.push(rule("test/binary", &[".BIN", "tar.gz"], &[]))
            .unwrap();
        r
    }

    #[test]
    fn extension_is_case_insensitive() {
        assert_eq!(rules().classify("a.TXT"), Some("test/text"));
        assert_eq!(rules().classify("b.bin"), Some("test/binary"));
    }

    #[test]
    fn unknown_extension_and_no_extension_are_unknown() {
        assert_eq!(rules().classify("a.xyz"), None);
        assert_eq!(rules().classify("README"), None);
        assert_eq!(rules().classify(".txt"), None); // 先頭のドットだけ
    }

    #[test]
    fn longer_extension_is_tried_first() {
        assert_eq!(rules().classify("backup.tar.gz"), Some("test/binary"));
        assert_eq!(rules().classify("notes.v2.md"), Some("test/text"));
    }

    #[test]
    fn empty_rules_classify_nothing() {
        assert_eq!(MediaRules::new().classify("a.txt"), None);
        assert!(MediaRules::new().is_empty());
    }

    #[test]
    fn first_declared_rule_wins() {
        let mut r = MediaRules::new();
        r.push(rule("a/first", &["x"], &[])).unwrap();
        r.push(rule("b/second", &["x"], &[])).unwrap();
        assert_eq!(r.classify("f.x"), Some("a/first"));
    }

    #[test]
    fn mime_lookup_works() {
        assert_eq!(rules().classify_mime("Text/Plain"), Some("test/text"));
        assert_eq!(rules().classify_mime("image/x"), None);
    }

    #[test]
    fn ids_must_look_like_namespace_slash_name() {
        let mut r = MediaRules::new();
        for bad in ["", "plain", "/x", "x/"] {
            assert!(matches!(
                r.push(rule(bad, &["a"], &[])),
                Err(MediaRuleError::InvalidId(_))
            ));
        }
        assert!(r.is_empty());
    }
}
