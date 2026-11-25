//! 翻訳キー（`%キー%`）の解決。`locales/<言語>.json`（キー → 文字列の平らな表）を読む。
//!
//! 言語の順は「要求された言語 → 言語だけ（`ja-JP` → `ja`）→ `en` → キーそのもの」。

use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Locales(BTreeMap<String, BTreeMap<String, String>>);

impl Locales {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, language: &str, table: BTreeMap<String, String>) {
        self.0.insert(language.to_owned(), table);
    }

    /// `<dir>/locales/*.json` を読む。読めない・壊れているファイルは、その言語が無いものとして扱い、理由を返す。
    pub fn load(dir: &Path) -> (Self, Vec<String>) {
        let mut locales = Self::new();
        let mut warnings = Vec::new();
        let Ok(entries) = std::fs::read_dir(dir.join("locales")) else {
            return (locales, warnings);
        };
        let mut files: Vec<_> = entries.flatten().map(|e| e.path()).collect();
        files.sort();
        for path in files {
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Some(language) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let parsed = std::fs::read_to_string(&path)
                .map_err(|e| e.to_string())
                .and_then(|text| {
                    serde_json::from_str::<BTreeMap<String, serde_json::Value>>(&text)
                        .map_err(|e| e.to_string())
                });
            match parsed {
                Ok(map) => {
                    let table = map
                        .into_iter()
                        .filter_map(|(k, v)| v.as_str().map(|v| (k, v.to_owned())))
                        .collect();
                    locales.insert(language, table);
                }
                Err(why) => warnings.push(format!("locales/{language}.json を読めません: {why}")),
            }
        }
        (locales, warnings)
    }

    /// `%キー%` なら翻訳に、それ以外はそのまま返す。
    pub fn resolve(&self, text: &str, language: &str) -> String {
        let Some(key) = text
            .strip_prefix('%')
            .and_then(|t| t.strip_suffix('%'))
            .filter(|k| !k.is_empty() && !k.contains('%'))
        else {
            return text.to_owned();
        };
        let primary = language.split(['-', '_']).next().unwrap_or(language);
        for lang in [language, primary, "en"] {
            if let Some(value) = self.0.get(lang).and_then(|t| t.get(key)) {
                return value.clone();
            }
        }
        key.to_owned()
    }
}
