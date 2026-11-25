//! 契約のスキーマ（`unnotator-plugin.schema.json`）による検証。スキーマは再定義せず、そのまま使う。

use std::sync::OnceLock;

use serde_json::Value;

use crate::MANIFEST_SCHEMA;

fn validator() -> &'static Result<jsonschema::Validator, String> {
    static V: OnceLock<Result<jsonschema::Validator, String>> = OnceLock::new();
    V.get_or_init(|| {
        let schema: Value = serde_json::from_str(MANIFEST_SCHEMA).map_err(|e| e.to_string())?;
        jsonschema::validator_for(&schema).map_err(|e| e.to_string())
    })
}

/// スキーマの違反を（JSON ポインター, 説明）で返す。
pub fn schema_errors(instance: &Value) -> Vec<(String, String)> {
    match validator() {
        Ok(v) => v
            .iter_errors(instance)
            .map(|e| (e.instance_path().to_string(), e.to_string()))
            .collect(),
        Err(why) => vec![(String::new(), format!("スキーマを読めません: {why}"))],
    }
}

/// `selectorSchema` が、JSON Schema（2020-12）として正しいか。
pub fn validate_selector_schema(schema: &Value) -> Result<(), String> {
    jsonschema::meta::validate(schema).map_err(|e| e.to_string())?;
    jsonschema::validator_for(schema)
        .map(|_| ())
        .map_err(|e| e.to_string())
}
