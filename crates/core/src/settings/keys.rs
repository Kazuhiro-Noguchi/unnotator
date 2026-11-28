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
    /// 文字列（取り得る値の集合は、画面が決める）。
    String,
    /// 任意の JSON（形は画面が検査する。1 MiB まで）。
    Json,
}

/// `Json` の項目の大きさの上限（バイト）。
const JSON_VALUE_LIMIT: usize = 1024 * 1024;

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
    // 分類ラベルを複数付けられるか（008）。false なら、付け替え。
    CoreKey {
        name: "core.classification.multiple",
        kind: ValueKind::Bool,
        default_json: "false",
    },
    // 媒体種別 → 既定のエディターの ID（009）。プロジェクト設定。
    CoreKey {
        name: "core.editors.default",
        // キーは修飾名（`<拡張機能 ID>/<名前>`）で `/` を含むので、`StringMap`（`/` を拒む）ではなく Json にする。
        kind: ValueKind::Json,
        default_json: "{}",
    },
    // 画面の設定（006）。利用者の設定（user 層）だけに置く。
    CoreKey {
        name: "ui.theme",
        kind: ValueKind::String,
        default_json: r#""system""#,
    },
    CoreKey {
        name: "ui.language",
        kind: ValueKind::String,
        default_json: r#""system""#,
    },
    CoreKey {
        name: "ui.layout",
        kind: ValueKind::Json,
        default_json: "{}",
    },
    CoreKey {
        name: "ui.quickAccess",
        kind: ValueKind::StringList,
        default_json: r#"["core.project.save","core.undo","core.redo"]"#,
    },
    CoreKey {
        name: "ui.keybindings",
        kind: ValueKind::Json,
        default_json: "[]",
    },
    CoreKey {
        name: "ui.recentProjects",
        kind: ValueKind::StringList,
        default_json: "[]",
    },
    // エクスプローラーの開いたフォルダ（007）。プロジェクトのフォルダごとの一覧。
    CoreKey {
        name: "ui.explorer",
        kind: ValueKind::Json,
        default_json: "{}",
    },
];

/// コアの項目の名前の領域。この領域の知らない名前は、打ち間違いとして拒む。
const CORE_NAMESPACES: &[&str] = &["assets.", "core.", "ui."];

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
            if key.starts_with("ui.") {
                // 画面の設定の配列は、パターンではなく ID やパス。空でなければよい。
                if strings.iter().any(|s| s.is_empty()) {
                    return Err("要素は空でない文字列でなければならない".to_owned());
                }
                return Ok(());
            }
            ExcludeSet::new(&strings).map_err(|error| error.to_string())?;
            Ok(())
        }
        ValueKind::String => value
            .is_string()
            .then_some(())
            .ok_or_else(|| "文字列でなければならない".to_owned()),
        ValueKind::Json => {
            let size = serde_json::to_string(value).map_or(usize::MAX, |text| text.len());
            if size > JSON_VALUE_LIMIT {
                return Err("大きすぎる（1 MiB まで）".to_owned());
            }
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
    fn ui_keys_exist_with_their_defaults() {
        for name in [
            "ui.theme",
            "ui.language",
            "ui.layout",
            "ui.quickAccess",
            "ui.keybindings",
            "ui.recentProjects",
        ] {
            assert!(core_key(name).is_some(), "{name}");
        }
        assert_eq!(default_value("ui.theme"), Some(json!("system")));
        assert_eq!(default_value("ui.language"), Some(json!("system")));
        assert_eq!(default_value("ui.layout"), Some(json!({})));
        assert_eq!(
            default_value("ui.quickAccess"),
            Some(json!(["core.project.save", "core.undo", "core.redo"]))
        );
        assert_eq!(default_value("ui.keybindings"), Some(json!([])));
        assert_eq!(default_value("ui.recentProjects"), Some(json!([])));
    }

    #[test]
    fn ui_explorer_exists_with_an_empty_default_and_is_a_size_limited_json() {
        assert!(core_key("ui.explorer").is_some());
        assert_eq!(default_value("ui.explorer"), Some(json!({})));
        assert!(validate("ui.explorer", &json!({"/p": ["a:b"]})).is_ok());
        let big = "x".repeat(1024 * 1024 + 1);
        assert!(validate("ui.explorer", &json!({ "/p": [big] })).is_err());
    }

    #[test]
    fn editors_default_is_a_size_limited_json_defaulting_to_empty() {
        // 媒体種別 → 既定のエディターの ID（009）。プロジェクト設定。
        assert!(core_key("core.editors.default").is_some());
        assert_eq!(default_value("core.editors.default"), Some(json!({})));
        assert!(
            validate(
                "core.editors.default",
                &json!({"com.example.a/text": "com.example.a/editor"})
            )
            .is_ok()
        );
        let big = "x".repeat(1024 * 1024 + 1);
        assert!(validate("core.editors.default", &json!({ "t": big })).is_err());
    }

    #[test]
    fn classification_multiple_is_a_bool_defaulting_to_false() {
        assert!(core_key("core.classification.multiple").is_some());
        assert_eq!(
            default_value("core.classification.multiple"),
            Some(json!(false))
        );
        assert!(validate("core.classification.multiple", &json!(true)).is_ok());
        assert!(validate("core.classification.multiple", &json!("yes")).is_err());
        // `core.` の領域の打ち間違いは拒む。
        assert!(validate("core.classification.multipl", &json!(true)).is_err());
    }

    #[test]
    fn ui_typos_are_rejected() {
        assert!(validate("ui.thme", &json!("dark")).is_err());
    }

    #[test]
    fn ui_theme_must_be_a_string() {
        assert!(validate("ui.theme", &json!("dark")).is_ok());
        assert!(validate("ui.theme", &json!(1)).is_err());
        assert!(validate("ui.language", &json!(true)).is_err());
    }

    #[test]
    fn ui_json_values_accept_any_json_up_to_one_mib() {
        assert!(validate("ui.layout", &json!({"version": 1})).is_ok());
        assert!(validate("ui.keybindings", &json!([{"key": "a"}, 3])).is_ok());
        let big = "x".repeat(1024 * 1024 + 1);
        assert!(validate("ui.layout", &json!({ "big": big })).is_err());
    }

    #[test]
    fn ui_string_lists_need_non_empty_strings_but_not_patterns() {
        assert!(validate("ui.recentProjects", &json!(["/a/b", "C:\\x"])).is_ok());
        assert!(validate("ui.recentProjects", &json!([""])).is_err());
        assert!(validate("ui.recentProjects", &json!([1])).is_err());
        assert!(validate("ui.recentProjects", &json!("x")).is_err());
        // パターンとして解釈できない文字列も、`ui.` では通る（パスや ID を入れるため）。
        assert!(validate("ui.quickAccess", &json!(["core.undo", "a[b"])).is_ok());
    }

    #[test]
    fn extension_keys_accept_any_json_and_core_typos_are_rejected() {
        assert!(validate("com.example.x", &json!({"a": [1]})).is_ok());
        assert!(validate("assets.excluded", &json!([])).is_err());
        assert!(validate("a b", &json!(1)).is_err());
    }
}
