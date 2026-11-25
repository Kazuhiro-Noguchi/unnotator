//! コアの設定項目の表（名前・型・既定値）と、値の検証。
//!
//! 拡張機能の項目（`<拡張機能 ID>.<キー>`）は、JSON として妥当であることだけを確かめて保つ（型は拡張機能が決める）。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::assets::exclude::ExcludeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum ValueKind {
    /// 文字列の配列。
    StringList,
    Bool,
    /// キー → 文字列のオブジェクト。
    StringMap,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct CoreKey {
    pub name: &'static str,
    pub kind: ValueKind,
    /// 既定値（JSON のテキスト）。
    pub default_json: &'static str,
}

/// コアが持つ項目。`data-model.md` の「コアの項目」と一致させる。
pub const CORE_KEYS: &[CoreKey] = &[
    CoreKey {
        name: "assets.exclude",
        kind: ValueKind::StringList,
        default_json: r#"[".DS_Store","Thumbs.db","desktop.ini",".*","*.tmp","~*"]"#,
    },
    CoreKey {
        name: "assets.externalRoots",
        kind: ValueKind::StringMap,
        default_json: "{}",
    },
    CoreKey {
        name: "assets.followSymlinks",
        kind: ValueKind::Bool,
        default_json: "false",
    },
    CoreKey {
        name: "assets.watch",
        kind: ValueKind::Bool,
        default_json: "true",
    },
];

/// コアの項目の名前の領域。この領域の知らない名前は、打ち間違いとして拒む。
const CORE_NAMESPACES: &[&str] = &["assets."];

pub fn core_key(name: &str) -> Option<&'static CoreKey> {
    CORE_KEYS.iter().find(|k| k.name == name)
}

pub fn default_value(name: &str) -> Option<Value> {
    core_key(name).and_then(|k| serde_json::from_str(k.default_json).ok())
}

/// 値を検証する。問題があれば、その理由。
pub fn validate(key: &str, value: &Value) -> Result<(), String> {
    if key.is_empty() || key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("項目の名前が空か、空白・制御文字を含んでいる".to_owned());
    }
    let Some(core) = core_key(key) else {
        if CORE_NAMESPACES.iter().any(|ns| key.starts_with(ns)) {
            return Err("コアの領域に、そのような項目はない".to_owned());
        }
        return Ok(());
    };
    match core.kind {
        ValueKind::Bool => value
            .is_boolean()
            .then_some(())
            .ok_or_else(|| "真偽値でなければならない".to_owned()),
        ValueKind::StringList => {
            let items = value
                .as_array()
                .ok_or_else(|| "文字列の配列でなければならない".to_owned())?;
            let strings: Vec<&str> = items
                .iter()
                .map(|v| {
                    v.as_str()
                        .ok_or_else(|| "要素は文字列でなければならない".to_owned())
                })
                .collect::<Result<_, _>>()?;
            ExcludeSet::new(&strings).map_err(|error| error.to_string())?;
            Ok(())
        }
        ValueKind::StringMap => {
            let map = value
                .as_object()
                .ok_or_else(|| "オブジェクトでなければならない".to_owned())?;
            for (name, entry) in map {
                if name.is_empty() || name.contains('/') || name.contains('\\') {
                    return Err(format!("キーが正しくない: {name:?}"));
                }
                if entry.as_str().is_none_or(str::is_empty) {
                    return Err(format!("{name} の値は、空でない文字列でなければならない"));
                }
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::exclude::DEFAULT_PATTERNS;
    use serde_json::json;

    #[test]
    fn the_default_exclude_json_matches_the_default_patterns() {
        let parsed = default_value("assets.exclude").unwrap();
        let expected: Vec<Value> = DEFAULT_PATTERNS.iter().map(|p| json!(p)).collect();
        assert_eq!(parsed, Value::Array(expected));
    }

    #[test]
    fn every_default_passes_its_own_validation() {
        for key in CORE_KEYS {
            validate(key.name, &default_value(key.name).unwrap()).unwrap();
        }
    }

    #[test]
    fn extension_keys_accept_any_json_and_core_typos_are_rejected() {
        assert!(validate("com.example.x", &json!({"a": [1]})).is_ok());
        assert!(validate("assets.excluded", &json!([])).is_err());
        assert!(validate("a b", &json!(1)).is_err());
    }
}
