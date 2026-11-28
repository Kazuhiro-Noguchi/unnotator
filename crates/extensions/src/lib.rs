//! unnotator-extensions: 拡張機能の導入・登録簿・権限・開発者モード。
//!
//! 拡張機能の実行（JS の読み込み・有効化）は 009、Python ワーカーは 010 の範囲。
//! ここは、導入されたものを検証し、名前空間つきの宣言にまとめ、依存の順番を決めるところまで。
//! 媒体の種別は、拡張機能が宣言した文字列として扱い、解釈しない。

pub mod consent;
pub mod devmode;
pub mod error;
pub mod gate;
pub mod limits;
pub mod manifest;
pub mod names;
pub mod package;
pub mod paths;
pub mod registry;
pub mod resolve;
pub mod state;
pub mod store;

pub use error::ExtensionError;

/// マニフェスト v1 の JSON Schema（契約の正本をそのまま埋め込む）。
pub const MANIFEST_SCHEMA: &str = include_str!("../schema/unnotator-plugin.schema.json");

/// アプリの拡張 API の版。`packages/plugin-api` の `API_VERSION` と一致させる（テストで確かめる）。
pub const EXTENSION_API_VERSION: &str = "0.0.1";

#[cfg(test)]
mod tests {
    use super::{EXTENSION_API_VERSION, MANIFEST_SCHEMA};

    #[test]
    fn api_version_matches_the_plugin_api_package() {
        let dts = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/plugin-api/index.d.ts"
        ))
        .expect("plugin-api の型定義を読める");
        let expected = format!("API_VERSION: '{EXTENSION_API_VERSION}'");
        assert!(dts.contains(&expected), "{expected} が index.d.ts に無い");
    }

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
