//! アセット（プロジェクトのフォルダや外部ルートの下のファイル）の走査・除外・判定規則・再接続・見張り。
//!
//! 媒体に関係しない（憲章 I）。媒体種別の判定規則は外から渡される値で、コアは表を持たない。

pub mod exclude;
pub mod media;
pub mod path;
pub mod relink;
pub mod roots;
pub mod scan;
pub mod watch;

use rusqlite::Connection;
use rusqlite::types::Value;
use serde::{Deserialize, Serialize};

use crate::command::Status;
use crate::error::StoreError;

/// アセットの 1 行（`Asset`（plugin-api）の、コアが持つ部分）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct AssetRow {
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
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum MediaFilter {
    #[default]
    Any,
    /// 媒体種別が判定できない（「不明」）もの。
    Unknown,
    Is(String),
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct AssetFilter {
    pub root_key: Option<String>,
    /// ルートからの相対パスの前方一致（フォルダなら末尾を `/` にする）。
    pub path_prefix: Option<String>,
    pub media_type: MediaFilter,
    pub status: Option<Status>,
    pub missing: Option<bool>,
}

/// 一覧の続き。`(root_key, rel_path)` の順の、この行の次から。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct AssetCursor {
    pub root_key: String,
    pub rel_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Page {
    #[serde(default)]
    pub after: Option<AssetCursor>,
    pub limit: u32,
}

impl Page {
    pub fn first(limit: u32) -> Self {
        Self { after: None, limit }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct AssetPage {
    pub items: Vec<AssetRow>,
    /// まだ続きがあるときだけ。
    pub next: Option<AssetCursor>,
}

const COLUMNS: &str = "id, root_key, rel_path, media_type, file_size, mtime_ms, status, missing";

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AssetRow> {
    let status: String = row.get(6)?;
    Ok(AssetRow {
        id: row.get(0)?,
        root_key: row.get(1)?,
        rel_path: row.get(2)?,
        media_type: row.get(3)?,
        file_size: row.get(4)?,
        mtime_ms: row.get(5)?,
        status: Status::parse(&status).unwrap_or(Status::Todo),
        missing: row.get::<_, i64>(7)? == 1,
    })
}

/// ID で 1 件読む。
pub fn get_asset(conn: &Connection, id: &str) -> Result<Option<AssetRow>, StoreError> {
    let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM assets WHERE id = ?"))?;
    let mut rows = stmt.query_map([id], read_row)?;
    Ok(rows.next().transpose()?)
}

/// すべてのアセットを `(root_key, rel_path)` の順で読む（走査の写し）。
pub fn all_assets(conn: &Connection) -> Result<Vec<AssetRow>, StoreError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM assets ORDER BY root_key, rel_path"
    ))?;
    let rows = stmt
        .query_map([], read_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 一覧（読み取り）。`(root_key, rel_path)` の順で、カーソルの続きから `limit` 件。
pub fn list_assets(
    conn: &Connection,
    filter: &AssetFilter,
    page: &Page,
) -> Result<AssetPage, StoreError> {
    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<Value> = Vec::new();
    let mut add = |condition: String, values: Vec<Value>| {
        conditions.push(condition);
        params.extend(values);
    };
    if let Some(cursor) = &page.after {
        add(
            "(root_key, rel_path) > (?, ?)".to_owned(),
            vec![
                Value::Text(cursor.root_key.clone()),
                Value::Text(cursor.rel_path.clone()),
            ],
        );
    }
    if let Some(root) = &filter.root_key {
        add("root_key = ?".to_owned(), vec![Value::Text(root.clone())]);
    }
    if let Some(prefix) = &filter.path_prefix {
        let length = i64::try_from(prefix.chars().count()).unwrap_or(i64::MAX);
        add(
            "substr(rel_path, 1, ?) = ?".to_owned(),
            vec![Value::Integer(length), Value::Text(prefix.clone())],
        );
    }
    match &filter.media_type {
        MediaFilter::Any => {}
        MediaFilter::Unknown => add("media_type IS NULL".to_owned(), vec![]),
        MediaFilter::Is(id) => add("media_type = ?".to_owned(), vec![Value::Text(id.clone())]),
    }
    if let Some(status) = filter.status {
        add(
            "status = ?".to_owned(),
            vec![Value::Text(status.as_str().to_owned())],
        );
    }
    if let Some(missing) = filter.missing {
        add(
            "missing = ?".to_owned(),
            vec![Value::Integer(i64::from(missing))],
        );
    }
    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    let limit = i64::from(page.limit.max(1));
    let sql = format!(
        "SELECT {COLUMNS} FROM assets {where_clause} ORDER BY root_key, rel_path LIMIT {}",
        limit + 1
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut items = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), read_row)?
        .collect::<Result<Vec<_>, _>>()?;
    let next = if i64::try_from(items.len()).unwrap_or(i64::MAX) > limit {
        items.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
        items.last().map(|last| AssetCursor {
            root_key: last.root_key.clone(),
            rel_path: last.rel_path.clone(),
        })
    } else {
        None
    };
    Ok(AssetPage { items, next })
}
