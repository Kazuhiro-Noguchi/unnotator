//! 拡張機能向けの読み取り（009）。DB を変えない。`selector_json` を含めて返す（媒体の中身は解釈しない）。
//!
//! 008 の `annotations_page` は `selector_json` を返さない（パネル用）。拡張機能は図形を描くために selector を読む。
//! 呼び出し側（`src-tauri` の `ext_*` の IPC）が、先に権限の門を通す。

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, params_from_iter};
use serde::{Deserialize, Serialize};

use crate::command::Status;
use crate::error::StoreError;

/// 1 回の問い合わせで返す件数の上限（`limit` 省略時の既定も同じ）。
pub const MAX_QUERY_LIMIT: u32 = 5000;

fn status_of(text: &str) -> Status {
    Status::parse(text).unwrap_or(Status::Todo)
}

/// `assets` の 1 行（拡張機能の `Asset`）。`metadata_json` は拡張機能 ID ごとの名前空間を持つ。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ExtAsset {
    pub id: String,
    pub root_key: String,
    pub rel_path: String,
    pub media_type: Option<String>,
    /// 2^53 未満なので、TS の `number` で欠けない。
    #[cfg_attr(feature = "specta", specta(type = f64))]
    pub file_size: i64,
    #[cfg_attr(feature = "specta", specta(type = f64))]
    pub mtime_ms: i64,
    pub status: Status,
    pub missing: bool,
    pub metadata_json: String,
    pub attributes_json: String,
}

pub fn ext_asset(conn: &Connection, asset_id: &str) -> Result<Option<ExtAsset>, StoreError> {
    Ok(conn
        .query_row(
            "SELECT id, root_key, rel_path, media_type, file_size, mtime_ms, status, missing, \
             metadata_json, attributes_json FROM assets WHERE id = ?1",
            [asset_id],
            |row| {
                Ok(ExtAsset {
                    id: row.get(0)?,
                    root_key: row.get(1)?,
                    rel_path: row.get(2)?,
                    media_type: row.get(3)?,
                    file_size: row.get(4)?,
                    mtime_ms: row.get(5)?,
                    status: status_of(&row.get::<_, String>(6)?),
                    missing: row.get::<_, i64>(7)? != 0,
                    metadata_json: row.get(8)?,
                    attributes_json: row.get(9)?,
                })
            },
        )
        .optional()?)
}

/// `items` の 1 行（拡張機能の `Item`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ExtItem {
    pub id: String,
    pub asset_id: String,
    pub item_key: String,
    pub provider: String,
    pub status: Status,
    pub metadata_json: String,
    pub attributes_json: String,
}

pub fn ext_item(
    conn: &Connection,
    asset_id: &str,
    item_key: &str,
) -> Result<Option<ExtItem>, StoreError> {
    Ok(conn
        .query_row(
            "SELECT id, asset_id, item_key, provider, status, metadata_json, attributes_json \
             FROM items WHERE asset_id = ?1 AND item_key = ?2",
            [asset_id, item_key],
            |row| {
                Ok(ExtItem {
                    id: row.get(0)?,
                    asset_id: row.get(1)?,
                    item_key: row.get(2)?,
                    provider: row.get(3)?,
                    status: status_of(&row.get::<_, String>(4)?),
                    metadata_json: row.get(5)?,
                    attributes_json: row.get(6)?,
                })
            },
        )
        .optional()?)
}

/// アノテーションの 1 行（`selector_json` を含む）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ExtAnnotation {
    pub id: String,
    pub asset_id: String,
    pub item_key: Option<String>,
    #[serde(rename = "type")]
    pub annotation_type: String,
    pub type_version: u32,
    pub selector_json: String,
    pub label_id: Option<String>,
    pub attributes_json: String,
    pub summary: String,
    pub z_order: i32,
    pub source: String,
    #[cfg_attr(feature = "specta", specta(type = f64))]
    pub created_at: i64,
    #[cfg_attr(feature = "specta", specta(type = f64))]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ExtAnnotationFilter {
    pub asset_id: Option<String>,
    /// `asset_id` と一緒に指定する。無ければアセット全体（アイテムのものを含む）。
    pub item_key: Option<String>,
    pub types: Vec<String>,
    pub label_ids: Vec<String>,
    pub ids: Vec<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

fn clamp(limit: Option<u32>) -> i64 {
    i64::from(limit.unwrap_or(MAX_QUERY_LIMIT).min(MAX_QUERY_LIMIT))
}

fn in_clause(column: &str, values: &[String], params: &mut Vec<Value>) -> String {
    let marks = vec!["?"; values.len()].join(", ");
    params.extend(values.iter().cloned().map(Value::Text));
    format!("{column} IN ({marks})")
}

pub fn ext_annotations(
    conn: &Connection,
    filter: &ExtAnnotationFilter,
) -> Result<Vec<ExtAnnotation>, StoreError> {
    let mut params: Vec<Value> = Vec::new();
    let mut conditions: Vec<String> = Vec::new();
    if let Some(asset_id) = &filter.asset_id {
        conditions.push("a.asset_id = ?".to_owned());
        params.push(Value::Text(asset_id.clone()));
        if let Some(key) = &filter.item_key {
            conditions.push("i.item_key = ?".to_owned());
            params.push(Value::Text(key.clone()));
        }
    } else if filter.item_key.is_some() {
        // アイテムのキーだけでは、どのアセットか決まらない。
        return Ok(Vec::new());
    }
    if !filter.types.is_empty() {
        conditions.push(in_clause("a.type", &filter.types, &mut params));
    }
    if !filter.label_ids.is_empty() {
        conditions.push(in_clause("a.label_id", &filter.label_ids, &mut params));
    }
    if !filter.ids.is_empty() {
        conditions.push(in_clause("a.id", &filter.ids, &mut params));
    }
    let where_sql = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    params.push(Value::Integer(clamp(filter.limit)));
    params.push(Value::Integer(i64::from(filter.offset.unwrap_or(0))));
    let sql = format!(
        "SELECT a.id, a.asset_id, i.item_key, a.type, a.type_version, a.selector_json, a.label_id, \
         a.attributes_json, a.summary, a.z_order, a.source, a.created_at, a.updated_at \
         FROM annotations a LEFT JOIN items i ON i.id = a.item_id {where_sql} \
         ORDER BY a.z_order, a.id LIMIT ? OFFSET ?"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(params), |row| {
        Ok(ExtAnnotation {
            id: row.get(0)?,
            asset_id: row.get(1)?,
            item_key: row.get(2)?,
            annotation_type: row.get(3)?,
            type_version: u32::try_from(row.get::<_, i64>(4)?).unwrap_or(1),
            selector_json: row.get(5)?,
            label_id: row.get(6)?,
            attributes_json: row.get(7)?,
            summary: row.get(8)?,
            z_order: row.get(9)?,
            source: row.get(10)?,
            created_at: row.get(11)?,
            updated_at: row.get(12)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ExtRelation {
    pub id: String,
    #[serde(rename = "type")]
    pub relation_type: String,
    pub from_id: String,
    pub to_id: String,
    pub directed: bool,
    pub label_id: Option<String>,
    pub attributes_json: String,
    pub source: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ExtRelationFilter {
    /// どちらかの端がこれらのアノテーションである関係。
    pub annotation_ids: Vec<String>,
    /// どちらかの端がこのアセットのアノテーションである関係。
    pub asset_id: Option<String>,
    pub types: Vec<String>,
}

pub fn ext_relations(
    conn: &Connection,
    filter: &ExtRelationFilter,
) -> Result<Vec<ExtRelation>, StoreError> {
    let mut params: Vec<Value> = Vec::new();
    let mut conditions: Vec<String> = Vec::new();
    if !filter.annotation_ids.is_empty() {
        let from = in_clause("from_id", &filter.annotation_ids, &mut params);
        let to = in_clause("to_id", &filter.annotation_ids, &mut params);
        conditions.push(format!("({from} OR {to})"));
    }
    if let Some(asset_id) = &filter.asset_id {
        conditions.push(
            "(from_id IN (SELECT id FROM annotations WHERE asset_id = ?) \
             OR to_id IN (SELECT id FROM annotations WHERE asset_id = ?))"
                .to_owned(),
        );
        params.push(Value::Text(asset_id.clone()));
        params.push(Value::Text(asset_id.clone()));
    }
    if !filter.types.is_empty() {
        conditions.push(in_clause("type", &filter.types, &mut params));
    }
    let where_sql = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    params.push(Value::Integer(i64::from(MAX_QUERY_LIMIT)));
    let sql = format!(
        "SELECT id, type, from_id, to_id, directed, label_id, attributes_json, source \
         FROM relations {where_sql} ORDER BY created_at, id LIMIT ?"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(params), |row| {
        Ok(ExtRelation {
            id: row.get(0)?,
            relation_type: row.get(1)?,
            from_id: row.get(2)?,
            to_id: row.get(3)?,
            directed: row.get::<_, i64>(4)? != 0,
            label_id: row.get(5)?,
            attributes_json: row.get(6)?,
            source: row.get(7)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ExtGroup {
    pub id: String,
    #[serde(rename = "type")]
    pub group_type: String,
    pub ordered: bool,
    pub label_id: Option<String>,
    pub attributes_json: String,
    pub source: String,
    /// `position` 順のアノテーション ID。
    pub member_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ExtGroupFilter {
    /// これらのアノテーションを含むグループ。
    pub annotation_ids: Vec<String>,
    /// このアセットのアノテーションを含むグループ。
    pub asset_id: Option<String>,
    pub types: Vec<String>,
}

pub fn ext_groups(conn: &Connection, filter: &ExtGroupFilter) -> Result<Vec<ExtGroup>, StoreError> {
    let mut params: Vec<Value> = Vec::new();
    let mut conditions: Vec<String> = Vec::new();
    if !filter.annotation_ids.is_empty() {
        let inner = in_clause("annotation_id", &filter.annotation_ids, &mut params);
        conditions.push(format!(
            "id IN (SELECT group_id FROM group_members WHERE {inner})"
        ));
    }
    if let Some(asset_id) = &filter.asset_id {
        conditions.push(
            "id IN (SELECT m.group_id FROM group_members m \
             JOIN annotations a ON a.id = m.annotation_id WHERE a.asset_id = ?)"
                .to_owned(),
        );
        params.push(Value::Text(asset_id.clone()));
    }
    if !filter.types.is_empty() {
        conditions.push(in_clause("type", &filter.types, &mut params));
    }
    let where_sql = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    params.push(Value::Integer(i64::from(MAX_QUERY_LIMIT)));
    let sql = format!(
        "SELECT id, type, ordered, label_id, attributes_json, source FROM annotation_groups \
         {where_sql} ORDER BY created_at, id LIMIT ?"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut groups: Vec<ExtGroup> = stmt
        .query_map(params_from_iter(params), |row| {
            Ok(ExtGroup {
                id: row.get(0)?,
                group_type: row.get(1)?,
                ordered: row.get::<_, i64>(2)? != 0,
                label_id: row.get(3)?,
                attributes_json: row.get(4)?,
                source: row.get(5)?,
                member_ids: Vec::new(),
            })
        })?
        .collect::<Result<_, _>>()?;
    let mut members = conn.prepare(
        "SELECT annotation_id FROM group_members WHERE group_id = ?1 ORDER BY position, annotation_id",
    )?;
    for group in &mut groups {
        group.member_ids = members
            .query_map([&group.id], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
    }
    Ok(groups)
}
