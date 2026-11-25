//! マニフェスト（`unnotator-plugin.json`）の型と検証。
//!
//! 型は、解決と登録に必要な項目だけを持つ。マニフェストの正本は、契約のスキーマ
//! （`crates/extensions/schema/unnotator-plugin.schema.json`）で、ここでは再定義しない。

pub mod schema;
pub mod text;

pub use schema::validate_selector_schema;

use crate::registry::{Problem, ProblemKind};

use std::collections::BTreeMap;

use serde_json::{Map, Value};

/// 検証を通ったあとのマニフェスト。`raw` は元の JSON（未知のキーも含む）。
#[derive(Debug, Clone, PartialEq)]
pub struct Manifest {
    pub id: String,
    pub version: String,
    pub display_name: Option<String>,
    /// `engines.unnotator`（対応する拡張 API の版の範囲）。
    pub engine_range: String,
    pub main: String,
    /// `extensionDependencies`（ID → 版の範囲）。
    pub dependencies: BTreeMap<String, String>,
    pub activation_events: Vec<String>,
    pub permissions: Vec<String>,
    pub contributes: Map<String, Value>,
    pub python: Option<Value>,
    pub raw: Value,
}

impl Manifest {
    /// JSON から、必要な項目を取り出す。スキーマの検証は別（`parse_manifest`）で、ここは形の最低限だけを見る。
    pub fn from_value(raw: Value) -> Result<Self, String> {
        let obj = raw
            .as_object()
            .ok_or("マニフェストはオブジェクトでなければならない")?;
        let text = |key: &str| -> Result<String, String> {
            obj.get(key)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| format!("`{key}` が文字列として無い"))
        };
        let engine_range = obj
            .get("engines")
            .and_then(|e| e.get("unnotator"))
            .and_then(Value::as_str)
            .ok_or("`engines.unnotator` が無い")?
            .to_owned();
        let dependencies = obj
            .get("extensionDependencies")
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_owned())))
                    .collect()
            })
            .unwrap_or_default();
        let strings = |key: &str| -> Vec<String> {
            obj.get(key)
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default()
        };
        Ok(Self {
            id: text("id")?,
            version: text("version")?,
            display_name: obj
                .get("displayName")
                .and_then(Value::as_str)
                .map(str::to_owned),
            engine_range,
            main: text("main")?,
            dependencies,
            activation_events: strings("activationEvents"),
            permissions: strings("permissions"),
            contributes: obj
                .get("contributes")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default(),
            python: obj.get("python").cloned(),
            raw,
        })
    }
}

fn problem(
    id: &str,
    version: Option<String>,
    kind: ProblemKind,
    pointer: String,
    message: String,
) -> Problem {
    Problem {
        extension_id: id.to_owned(),
        version,
        kind,
        pointer,
        message,
        detail: None,
    }
}

/// マニフェストを、契約のスキーマで検証して読む。違反は、位置（JSON ポインター）と理由つきで、すべて返す。
/// スキーマで書けない確認（参照・重複など）は、登録簿が行う。
pub fn parse_manifest(bytes: &[u8]) -> Result<Manifest, Vec<Problem>> {
    let value: Value = serde_json::from_slice(bytes).map_err(|e| {
        vec![problem(
            "",
            None,
            ProblemKind::ManifestSchema,
            String::new(),
            format!("JSON ではありません: {e}"),
        )]
    })?;
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let version = value
        .get("version")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut problems: Vec<Problem> = schema::schema_errors(&value)
        .into_iter()
        .map(|(pointer, why)| {
            problem(
                &id,
                version.clone(),
                ProblemKind::ManifestSchema,
                pointer,
                why,
            )
        })
        .collect();
    if let Some(types) = value["contributes"]["annotationTypes"].as_array() {
        for (i, t) in types.iter().enumerate() {
            if let Some(selector) = t.get("selectorSchema")
                && let Err(why) = validate_selector_schema(selector)
            {
                problems.push(problem(
                    &id,
                    version.clone(),
                    ProblemKind::SelectorSchema,
                    format!("/contributes/annotationTypes/{i}/selectorSchema"),
                    why,
                ));
            }
        }
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    Manifest::from_value(value).map_err(|why| {
        vec![problem(
            &id,
            version,
            ProblemKind::ManifestSchema,
            String::new(),
            why,
        )]
    })
}
