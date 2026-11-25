//! 除外パターン（`.gitignore` の部分集合。自前の実装）。research.md R4。
//!
//! 対応する書式: `*`（`/` 以外）・`**`（`/` を含む任意）・`?`・先頭の `/`（ルート相対）・末尾の `/`（フォルダのみ）・`!`（否定）。
//! 後の行が勝つ。フォルダが除外されたら、その下は（否定があっても）除外のまま。

use thiserror::Error;

use super::path::RESERVED_DIR;

/// 既定の除外（設定 `assets.exclude` の既定値）。
pub const DEFAULT_PATTERNS: &[&str] =
    &[".DS_Store", "Thumbs.db", "desktop.ini", ".*", "*.tmp", "~*"];

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ExcludeError {
    #[error("除外パターンが空です")]
    Empty,
    #[error("除外パターンを解釈できません: {0}")]
    Invalid(String),
}

#[derive(Debug, Clone)]
struct Rule {
    glob: Vec<char>,
    negate: bool,
    dir_only: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ExcludeSet {
    rules: Vec<Rule>,
}

impl ExcludeSet {
    pub fn new<S: AsRef<str>>(patterns: &[S]) -> Result<Self, ExcludeError> {
        let rules = patterns
            .iter()
            .map(|p| parse(p.as_ref()))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self { rules })
    }

    /// 既定の除外だけの集合。
    pub fn defaults() -> Self {
        Self::new(DEFAULT_PATTERNS).unwrap_or_default()
    }

    /// `rel`（ルートからの相対。区切りは `/`）が除外か。祖先のフォルダが除外のときも除外。
    pub fn is_excluded(&self, rel: &str, is_dir: bool) -> bool {
        let parts: Vec<&str> = rel.split('/').filter(|p| !p.is_empty()).collect();
        if parts
            .first()
            .is_some_and(|p| p.eq_ignore_ascii_case(RESERVED_DIR))
        {
            return true;
        }
        let mut prefix = String::new();
        for (i, part) in parts.iter().enumerate() {
            if i > 0 {
                prefix.push('/');
            }
            prefix.push_str(part);
            let last = i + 1 == parts.len();
            let dir = !last || is_dir;
            if self.matches(&prefix, dir) {
                return true;
            }
        }
        false
    }

    fn matches(&self, path: &str, is_dir: bool) -> bool {
        let text: Vec<char> = path.chars().collect();
        let mut excluded = false;
        for rule in &self.rules {
            if rule.dir_only && !is_dir {
                continue;
            }
            if glob_match(&rule.glob, &text) {
                excluded = !rule.negate;
            }
        }
        excluded
    }
}

fn parse(raw: &str) -> Result<Rule, ExcludeError> {
    let mut pattern = raw.trim();
    if pattern.is_empty() {
        return Err(ExcludeError::Empty);
    }
    let negate = pattern.starts_with('!');
    if negate {
        pattern = &pattern[1..];
    }
    let dir_only = pattern.ends_with('/');
    if dir_only {
        pattern = &pattern[..pattern.len() - 1];
    }
    let anchored_by_slash = pattern.starts_with('/');
    if anchored_by_slash {
        pattern = &pattern[1..];
    }
    if pattern.is_empty() || pattern.contains("//") || pattern.contains('\0') {
        return Err(ExcludeError::Invalid(raw.to_owned()));
    }
    let anchored = anchored_by_slash || pattern.contains('/');
    let full = if anchored {
        pattern.to_owned()
    } else {
        format!("**/{pattern}")
    };
    Ok(Rule {
        glob: full.chars().collect(),
        negate,
        dir_only,
    })
}

/// `*`・`**`・`?` を解釈する単純な照合。パターンは短いので、後戻りで足りる。
fn glob_match(pattern: &[char], text: &[char]) -> bool {
    let Some(&first) = pattern.first() else {
        return text.is_empty();
    };
    match first {
        '*' if pattern.get(1) == Some(&'*') => {
            let rest = &pattern[2..];
            if rest.first() == Some(&'/') {
                // `**/` は 0 個以上のフォルダ。区切りの直後からだけ続きを試す。
                let after = &rest[1..];
                (0..=text.len())
                    .filter(|&k| k == 0 || text[k - 1] == '/')
                    .any(|k| glob_match(after, &text[k..]))
            } else {
                (0..=text.len()).any(|k| glob_match(rest, &text[k..]))
            }
        }
        '*' => {
            let rest = &pattern[1..];
            for k in 0..=text.len() {
                if glob_match(rest, &text[k..]) {
                    return true;
                }
                if k < text.len() && text[k] == '/' {
                    break;
                }
            }
            false
        }
        '?' => text.first().is_some_and(|&c| c != '/') && glob_match(&pattern[1..], &text[1..]),
        c => text.first() == Some(&c) && glob_match(&pattern[1..], &text[1..]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(patterns: &[&str]) -> ExcludeSet {
        ExcludeSet::new(patterns).unwrap()
    }

    #[test]
    fn plain_name_matches_at_any_depth() {
        let s = set(&["*.bak"]);
        assert!(s.is_excluded("a.bak", false));
        assert!(s.is_excluded("x/y/a.bak", false));
        assert!(!s.is_excluded("a.bak.txt", false));
    }

    #[test]
    fn star_does_not_cross_slash_but_double_star_does() {
        let s = set(&["/a/*.txt"]);
        assert!(s.is_excluded("a/b.txt", false));
        assert!(!s.is_excluded("a/b/c.txt", false));
        let d = set(&["/a/**/c.txt"]);
        assert!(d.is_excluded("a/c.txt", false));
        assert!(d.is_excluded("a/b/x/c.txt", false));
        assert!(!d.is_excluded("a/bc.txt", false));
        assert!(!d.is_excluded("a/xc.txt", false));
    }

    #[test]
    fn question_mark_matches_one_non_slash_char() {
        let s = set(&["/file?.txt"]);
        assert!(s.is_excluded("file1.txt", false));
        assert!(!s.is_excluded("file12.txt", false));
        assert!(!s.is_excluded("file/.txt", false));
    }

    #[test]
    fn leading_slash_anchors_to_root() {
        let s = set(&["/drafts"]);
        assert!(s.is_excluded("drafts", true));
        assert!(!s.is_excluded("a/drafts", true));
    }

    #[test]
    fn trailing_slash_matches_directories_only() {
        let s = set(&["cache/"]);
        assert!(s.is_excluded("cache", true));
        assert!(!s.is_excluded("cache", false));
        assert!(s.is_excluded("x/cache/file.bin", false)); // フォルダの下は除外
    }

    #[test]
    fn negation_and_later_rule_wins() {
        let s = set(&["*.log", "!keep.log"]);
        assert!(s.is_excluded("a.log", false));
        assert!(!s.is_excluded("keep.log", false));
        let t = set(&["!keep.log", "*.log"]);
        assert!(t.is_excluded("keep.log", false));
    }

    #[test]
    fn excluded_directory_cannot_be_reincluded() {
        let s = set(&["/out/", "!/out/keep.txt"]);
        assert!(s.is_excluded("out/keep.txt", false));
    }

    #[test]
    fn reserved_directory_is_always_excluded() {
        let s = ExcludeSet::new::<&str>(&[]).unwrap();
        assert!(s.is_excluded(".unnotator", true));
        assert!(s.is_excluded(".unnotator/project.db", false));
        assert!(s.is_excluded(".UNNOTATOR/x", false));
        let negated = set(&["!.unnotator"]);
        assert!(negated.is_excluded(".unnotator/lock", false));
    }

    #[test]
    fn defaults_cover_hidden_and_temporary_files() {
        let s = ExcludeSet::defaults();
        for name in [
            ".DS_Store",
            "Thumbs.db",
            "desktop.ini",
            ".hidden",
            "a.tmp",
            "~lock",
        ] {
            assert!(s.is_excluded(name, false), "{name}");
        }
        assert!(!s.is_excluded("photo.png", false));
        assert!(s.is_excluded("x/.git/config", false));
    }

    #[test]
    fn invalid_patterns_are_rejected_with_the_reason() {
        assert_eq!(ExcludeSet::new(&[""]).unwrap_err(), ExcludeError::Empty);
        assert!(matches!(
            ExcludeSet::new(&["a//b"]),
            Err(ExcludeError::Invalid(_))
        ));
        assert!(matches!(
            ExcludeSet::new(&["/"]),
            Err(ExcludeError::Invalid(_))
        ));
        assert!(matches!(
            ExcludeSet::new(&["!"]),
            Err(ExcludeError::Invalid(_))
        ));
    }

    #[test]
    fn japanese_names_match() {
        let s = set(&["下書き*"]);
        assert!(s.is_excluded("x/下書き1.txt", false));
    }
}
