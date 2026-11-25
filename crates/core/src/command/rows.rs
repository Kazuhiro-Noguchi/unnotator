//! 行を組み立てる・値を引く小さな補助。ハンドラから共通で使う。

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension};

use crate::db::tables::TableDef;
use crate::error::StoreError;
use crate::history::recorder::Row;

pub fn text(s: &str) -> Value {
    Value::Text(s.to_owned())
}

pub fn opt_text(s: Option<&str>) -> Value {
    s.map_or(Value::Null, text)
}

pub fn int(i: i64) -> Value {
    Value::Integer(i)
}

pub fn boolean(b: bool) -> Value {
    Value::Integer(i64::from(b))
}

/// 列名で値を指定して行を組み立てる。指定しなかった列は NULL（必要な列は呼び出し側が指定する）。
pub struct RowBuilder {
    def: &'static TableDef,
    row: Row,
}

impl RowBuilder {
    pub fn new(def: &'static TableDef) -> Self {
        Self {
            def,
            row: vec![Value::Null; def.columns.len()],
        }
    }

    pub fn set(mut self, column: &str, value: Value) -> Self {
        if let Some(index) = self.def.column_index(column) {
            self.row[index] = value;
        }
        self
    }

    pub fn build(self) -> Row {
        self.row
    }
}

/// 1 つの値を返すクエリ。行が無ければ `None`。
pub fn query_optional<T: rusqlite::types::FromSql>(
    conn: &Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> Result<Option<T>, StoreError> {
    Ok(conn.query_row(sql, params, |row| row.get(0)).optional()?)
}

/// 行が存在すること。無ければ `NotFound`。
pub fn require(conn: &Connection, table: &str, id: &str, what: &str) -> Result<(), StoreError> {
    let found: Option<i64> =
        query_optional(conn, &format!("SELECT 1 FROM {table} WHERE id = ?1"), [id])?;
    found
        .map(|_| ())
        .ok_or_else(|| StoreError::NotFound(format!("{what} {id}")))
}

use super::Field;

/// パッチの 1 項目を、更新する列の一覧に足す。`Clear` は空にできる（`nullable`）項目だけ。
pub fn push_field<T>(
    changes: &mut Vec<(&'static str, Value)>,
    column: &'static str,
    field: &Field<T>,
    nullable: bool,
    to_value: impl Fn(&T) -> Value,
) -> Result<(), StoreError> {
    match field {
        Field::Keep => {}
        Field::Set(value) => changes.push((column, to_value(value))),
        Field::Clear if nullable => changes.push((column, Value::Null)),
        Field::Clear => {
            return Err(StoreError::InvalidCommand(format!(
                "{column} は空にできない"
            )));
        }
    }
    Ok(())
}

pub fn mismatch() -> StoreError {
    StoreError::InvalidCommand("コマンドと処理が合っていない（内部エラー）".to_owned())
}

/// 1 列目が文字列の行を、すべて集める（ID の一覧など）。
pub fn query_ids(
    conn: &Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> Result<Vec<String>, StoreError> {
    let mut stmt = conn.prepare_cached(sql)?;
    let rows = stmt.query_map(params, |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}
