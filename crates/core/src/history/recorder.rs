//! 行の変更の記録。ハンドラは行を直接 SQL で変えず、必ずここを通す。
//!
//! 変える前後の行を `RowOp` として順に記録し、その列を逆順（Undo）・順（Redo）に適用すれば、
//! コマンドごとの逆操作を手で書かずに、往復で完全に元へ戻せる（research.md R6）。

use rusqlite::types::Value;
use rusqlite::{Connection, ErrorCode, params_from_iter};

use crate::db::tables::{TableDef, table};
use crate::error::StoreError;

/// 1 行分の値。列の並びは `TableDef::columns` に従う。
pub type Row = Vec<Value>;

/// 1 行に対する 1 回の変更。
#[derive(Debug, Clone, PartialEq)]
pub struct RowOp {
    pub table: &'static str,
    /// 主キーの値（`TableDef::pk` の順）。
    pub key: Vec<Value>,
    pub before: Option<Row>,
    pub after: Option<Row>,
}

fn def(name: &str) -> Result<&'static TableDef, StoreError> {
    table(name).ok_or_else(|| StoreError::InvalidCommand(format!("未知のテーブル: {name}")))
}

/// 契約の CHECK・UNIQUE・外部キーに反する値は、コマンドの不正として返す（FR-018）。
fn map_db_error(error: rusqlite::Error) -> StoreError {
    if let rusqlite::Error::SqliteFailure(failure, message) = &error
        && failure.code == ErrorCode::ConstraintViolation
    {
        return StoreError::InvalidCommand(
            message
                .clone()
                .unwrap_or_else(|| "契約の制約に反しています".to_owned()),
        );
    }
    StoreError::Sqlite(error)
}

fn where_clause(def: &TableDef) -> String {
    def.pk
        .iter()
        .enumerate()
        .map(|(i, column)| format!("{column} = ?{}", i + 1))
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn select_row(conn: &Connection, def: &TableDef, key: &[Value]) -> Result<Option<Row>, StoreError> {
    let sql = format!(
        "SELECT {} FROM {} WHERE {}",
        def.columns.join(", "),
        def.name,
        where_clause(def)
    );
    let mut stmt = conn.prepare_cached(&sql)?;
    let mut rows = stmt.query(params_from_iter(key.iter()))?;
    match rows.next()? {
        Some(row) => Ok(Some(
            (0..def.columns.len())
                .map(|i| row.get::<_, Value>(i))
                .collect::<Result<Vec<_>, _>>()?,
        )),
        None => Ok(None),
    }
}

fn insert_row(conn: &Connection, def: &TableDef, row: &Row) -> Result<(), StoreError> {
    if row.len() != def.columns.len() {
        return Err(StoreError::InvalidCommand(format!(
            "{} の列の数が合わない",
            def.name
        )));
    }
    let placeholders = (1..=def.columns.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({placeholders})",
        def.name,
        def.columns.join(", ")
    );
    conn.prepare_cached(&sql)
        .map_err(map_db_error)?
        .execute(params_from_iter(row.iter()))
        .map_err(map_db_error)?;
    Ok(())
}

fn update_row(conn: &Connection, def: &TableDef, row: &Row) -> Result<(), StoreError> {
    let pk_indexes = def.pk_indexes();
    let key: Vec<&Value> = pk_indexes.iter().map(|&i| &row[i]).collect();
    let data_columns: Vec<usize> = (0..def.columns.len())
        .filter(|i| !pk_indexes.contains(i))
        .collect();
    if data_columns.is_empty() {
        return Ok(());
    }
    let sets = data_columns
        .iter()
        .enumerate()
        .map(|(n, &i)| format!("{} = ?{}", def.columns[i], n + 1))
        .collect::<Vec<_>>()
        .join(", ");
    let offset = data_columns.len();
    let wheres = def
        .pk
        .iter()
        .enumerate()
        .map(|(n, column)| format!("{column} = ?{}", offset + n + 1))
        .collect::<Vec<_>>()
        .join(" AND ");
    let sql = format!("UPDATE {} SET {sets} WHERE {wheres}", def.name);
    let params: Vec<&Value> = data_columns
        .iter()
        .map(|&i| &row[i])
        .chain(key.iter().copied())
        .collect();
    conn.prepare_cached(&sql)
        .map_err(map_db_error)?
        .execute(params_from_iter(params))
        .map_err(map_db_error)?;
    Ok(())
}

fn delete_row(conn: &Connection, def: &TableDef, key: &[Value]) -> Result<(), StoreError> {
    let sql = format!("DELETE FROM {} WHERE {}", def.name, where_clause(def));
    conn.prepare_cached(&sql)
        .map_err(map_db_error)?
        .execute(params_from_iter(key.iter()))
        .map_err(map_db_error)?;
    Ok(())
}

fn key_of(def: &TableDef, row: &Row) -> Vec<Value> {
    def.pk_indexes().iter().map(|&i| row[i].clone()).collect()
}

/// 1 回の適用の間、行の変更を記録する。
pub struct Recorder<'c> {
    conn: &'c Connection,
    ops: Vec<RowOp>,
}

impl<'c> Recorder<'c> {
    pub fn new(conn: &'c Connection) -> Self {
        Self {
            conn,
            ops: Vec::new(),
        }
    }

    pub fn conn(&self) -> &Connection {
        self.conn
    }

    /// 主キーで 1 行を読む（記録はしない）。
    pub fn get(&self, table_name: &str, key: &[Value]) -> Result<Option<Row>, StoreError> {
        select_row(self.conn, def(table_name)?, key)
    }

    pub fn insert(&mut self, table_name: &str, row: Row) -> Result<(), StoreError> {
        let def = def(table_name)?;
        insert_row(self.conn, def, &row)?;
        self.ops.push(RowOp {
            table: def.name,
            key: key_of(def, &row),
            before: None,
            after: Some(row),
        });
        Ok(())
    }

    /// 行を丸ごと置き換える（主キーは変えない）。
    pub fn update(&mut self, table_name: &str, key: &[Value], row: Row) -> Result<(), StoreError> {
        let def = def(table_name)?;
        let before = select_row(self.conn, def, key)?
            .ok_or_else(|| StoreError::NotFound(format!("{table_name}: 対象の行がない")))?;
        if before == row {
            return Ok(());
        }
        update_row(self.conn, def, &row)?;
        self.ops.push(RowOp {
            table: def.name,
            key: key.to_vec(),
            before: Some(before),
            after: Some(row),
        });
        Ok(())
    }

    /// 指定した列だけを変える。指定しない列には触れない。
    pub fn update_columns(
        &mut self,
        table_name: &str,
        key: &[Value],
        changes: &[(&str, Value)],
    ) -> Result<(), StoreError> {
        let def = def(table_name)?;
        let mut row = select_row(self.conn, def, key)?
            .ok_or_else(|| StoreError::NotFound(format!("{table_name}: 対象の行がない")))?;
        for (column, value) in changes {
            let index = def.column_index(column).ok_or_else(|| {
                StoreError::InvalidCommand(format!("{table_name} に列 {column} がない"))
            })?;
            row[index] = value.clone();
        }
        self.update(table_name, key, row)
    }

    pub fn delete(&mut self, table_name: &str, key: &[Value]) -> Result<(), StoreError> {
        let def = def(table_name)?;
        let before = select_row(self.conn, def, key)?
            .ok_or_else(|| StoreError::NotFound(format!("{table_name}: 対象の行がない")))?;
        delete_row(self.conn, def, key)?;
        self.ops.push(RowOp {
            table: def.name,
            key: key.to_vec(),
            before: Some(before),
            after: None,
        });
        Ok(())
    }

    pub fn ops(&self) -> &[RowOp] {
        &self.ops
    }

    pub fn into_ops(self) -> Vec<RowOp> {
        self.ops
    }
}

/// 記録を逆順にたどって元に戻す。
pub fn apply_undo(conn: &Connection, ops: &[RowOp]) -> Result<(), StoreError> {
    for op in ops.iter().rev() {
        let def = def(op.table)?;
        match (&op.before, &op.after) {
            (None, Some(_)) => delete_row(conn, def, &op.key)?,
            (Some(before), None) => insert_row(conn, def, before)?,
            (Some(before), Some(_)) => update_row(conn, def, before)?,
            (None, None) => {}
        }
    }
    Ok(())
}

/// 記録を順にたどってやり直す。
pub fn apply_redo(conn: &Connection, ops: &[RowOp]) -> Result<(), StoreError> {
    for op in ops {
        let def = def(op.table)?;
        match (&op.before, &op.after) {
            (None, Some(after)) => insert_row(conn, def, after)?,
            (Some(_), None) => delete_row(conn, def, &op.key)?,
            (Some(_), Some(after)) => update_row(conn, def, after)?,
            (None, None) => {}
        }
    }
    Ok(())
}

/// 保存済みのファイル（`project.db`）へ、走査の結果だけを書く。
/// 作業用の複製にだけある利用者の未保存の編集を巻き込まないため、行ごと書き戻さず、
/// 前後で変わった列だけを更新する。追加は、すでにあれば何もしない。削除は扱わない。
pub fn apply_changed_columns(conn: &Connection, ops: &[RowOp]) -> Result<(), StoreError> {
    for op in ops {
        let def = def(op.table)?;
        match (&op.before, &op.after) {
            (None, Some(after)) => insert_row_or_ignore(conn, def, after)?,
            (Some(before), Some(after)) => update_changed(conn, def, before, after)?,
            _ => {}
        }
    }
    Ok(())
}

fn insert_row_or_ignore(conn: &Connection, def: &TableDef, row: &Row) -> Result<(), StoreError> {
    if row.len() != def.columns.len() {
        return Err(StoreError::InvalidCommand(format!(
            "{} の列の数が合わない",
            def.name
        )));
    }
    let placeholders = (1..=def.columns.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "INSERT OR IGNORE INTO {} ({}) VALUES ({placeholders})",
        def.name,
        def.columns.join(", ")
    );
    conn.prepare_cached(&sql)?
        .execute(params_from_iter(row.iter()))?;
    Ok(())
}

fn update_changed(
    conn: &Connection,
    def: &TableDef,
    before: &Row,
    after: &Row,
) -> Result<(), StoreError> {
    let pk_indexes = def.pk_indexes();
    let changed: Vec<usize> = (0..def.columns.len())
        .filter(|i| !pk_indexes.contains(i) && before.get(*i) != after.get(*i))
        .collect();
    if changed.is_empty() {
        return Ok(());
    }
    let sets = changed
        .iter()
        .enumerate()
        .map(|(n, &i)| format!("{} = ?{}", def.columns[i], n + 1))
        .collect::<Vec<_>>()
        .join(", ");
    let offset = changed.len();
    let wheres = def
        .pk
        .iter()
        .enumerate()
        .map(|(n, column)| format!("{column} = ?{}", offset + n + 1))
        .collect::<Vec<_>>()
        .join(" AND ");
    let sql = format!("UPDATE {} SET {sets} WHERE {wheres}", def.name);
    let values = changed
        .iter()
        .map(|&i| &after[i])
        .chain(pk_indexes.iter().map(|&i| &after[i]));
    conn.prepare_cached(&sql)?
        .execute(params_from_iter(values))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::migrations::PROJECT_V1;
    use rusqlite::Connection;
    use rusqlite::types::Value;

    fn db() -> Connection {
        let conn = open_in_memory().unwrap();
        conn.execute_batch(PROJECT_V1).unwrap();
        conn
    }

    fn text(s: &str) -> Value {
        Value::Text(s.to_owned())
    }

    fn label_row(id: &str, name: &str) -> Row {
        vec![
            text(id),
            text(name),
            text("{}"),
            text("#112233"),
            Value::Null,
            Value::Integer(0),
            Value::Integer(0),
            text("{}"),
            Value::Integer(1),
            Value::Integer(1),
        ]
    }

    /// 対象テーブルの全行（比較用）。
    fn dump(conn: &Connection, table: &str) -> Vec<Vec<Value>> {
        let columns = crate::db::tables::table(table).unwrap().columns.len();
        let mut stmt = conn
            .prepare(&format!("SELECT * FROM {table} ORDER BY 1, 2"))
            .unwrap();
        stmt.query_map([], |row| {
            (0..columns)
                .map(|i| row.get::<_, Value>(i))
                .collect::<Result<Vec<_>, _>>()
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
    }

    #[test]
    fn records_insert_update_delete_with_before_and_after() {
        let conn = db();
        let mut rec = Recorder::new(&conn);
        rec.insert("labels", label_row("l1", "person")).unwrap();
        rec.update_columns("labels", &[text("l1")], &[("color", text("#ffffff"))])
            .unwrap();
        rec.delete("labels", &[text("l1")]).unwrap();
        let ops = rec.into_ops();
        assert_eq!(ops.len(), 3);
        assert!(ops[0].before.is_none() && ops[0].after.is_some());
        let color_index = crate::db::tables::LABELS.column_index("color").unwrap();
        assert_eq!(
            ops[1].before.as_ref().unwrap()[color_index],
            text("#112233")
        );
        assert_eq!(ops[1].after.as_ref().unwrap()[color_index], text("#ffffff"));
        assert!(ops[2].before.is_some() && ops[2].after.is_none());
        assert_eq!(ops[2].key, vec![text("l1")]);
    }

    #[test]
    fn undo_restores_and_redo_reapplies() {
        let conn = db();
        let mut rec = Recorder::new(&conn);
        rec.insert("labels", label_row("l1", "person")).unwrap();
        rec.insert("labels", label_row("l2", "car")).unwrap();
        let initial = dump(&conn, "labels");
        let ops = rec.into_ops();

        // 続けて更新と削除を行い、その分も 1 つの列として戻す
        let mut rec = Recorder::new(&conn);
        rec.update_columns("labels", &[text("l1")], &[("name", text("human"))])
            .unwrap();
        rec.delete("labels", &[text("l2")]).unwrap();
        let after = dump(&conn, "labels");
        let ops2 = rec.into_ops();
        assert_ne!(initial, after);

        apply_undo(&conn, &ops2).unwrap();
        assert_eq!(dump(&conn, "labels"), initial);
        apply_redo(&conn, &ops2).unwrap();
        assert_eq!(dump(&conn, "labels"), after);

        apply_undo(&conn, &ops2).unwrap();
        apply_undo(&conn, &ops).unwrap();
        assert!(dump(&conn, "labels").is_empty());
        apply_redo(&conn, &ops).unwrap();
        assert_eq!(dump(&conn, "labels"), initial);
    }

    #[test]
    fn composite_primary_key_round_trips() {
        let conn = db();
        conn.execute_batch(
            "INSERT INTO assets (id, rel_path, file_size, mtime_ms, created_at, updated_at) VALUES ('a', 'a.bin', 0, 0, 0, 0);
             INSERT INTO annotations (id, asset_id, type, created_at, updated_at) VALUES ('n1', 'a', 'x.y/z', 0, 0);
             INSERT INTO annotations (id, asset_id, type, created_at, updated_at) VALUES ('n2', 'a', 'x.y/z', 0, 0);
             INSERT INTO annotation_groups (id, type, created_at, updated_at) VALUES ('g', 'x.y/g', 0, 0);",
        )
        .unwrap();
        let mut rec = Recorder::new(&conn);
        rec.insert(
            "group_members",
            vec![text("g"), text("n1"), Value::Integer(0)],
        )
        .unwrap();
        rec.insert(
            "group_members",
            vec![text("g"), text("n2"), Value::Integer(1)],
        )
        .unwrap();
        rec.update_columns(
            "group_members",
            &[text("g"), text("n1")],
            &[("position", Value::Integer(1))],
        )
        .unwrap();
        let after = dump(&conn, "group_members");
        let ops = rec.into_ops();
        apply_undo(&conn, &ops).unwrap();
        assert!(dump(&conn, "group_members").is_empty());
        apply_redo(&conn, &ops).unwrap();
        assert_eq!(dump(&conn, "group_members"), after);
    }

    #[test]
    fn update_of_missing_row_fails_without_recording() {
        let conn = db();
        let mut rec = Recorder::new(&conn);
        let err = rec
            .update_columns("labels", &[text("nope")], &[("name", text("x"))])
            .unwrap_err();
        assert_eq!(err.code(), "not_found");
        assert!(rec.into_ops().is_empty());
    }
}
