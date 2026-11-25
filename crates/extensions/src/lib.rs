//! unnotator-extensions

/// 拡張機能のマニフェスト v1 の JSON Schema（契約の正本をそのまま埋め込む）。
pub const MANIFEST_SCHEMA: &str = include_str!("../schema/unnotator-plugin.schema.json");

#[cfg(test)]
mod tests {
    use super::MANIFEST_SCHEMA;

    #[test]
    fn manifest_schema_is_json_with_draft_2020_12() {
        let value: serde_json::Value = serde_json::from_str(MANIFEST_SCHEMA)
            .expect("マニフェストのスキーマは JSON として読める");
        assert_eq!(
            value["$schema"],
            "https://json-schema.org/draft/2020-12/schema"
        );
    }
}
