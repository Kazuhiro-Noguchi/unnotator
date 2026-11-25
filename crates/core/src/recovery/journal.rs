//! 変更履歴（`journal.db`）の読み書き。契約 `recovery/0001_init.sql` の構造のまま使う（contracts/journal.md）。
//!
//! `inverse_json` には、`working.db` への順方向の変更（`RowOp` の列）を JSON で入れる。

use std::path::Path;

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value as Json, json};

use crate::db::tables::table;
use crate::db::{classify, open_wal_connection};
use crate::error::StoreError;
use crate::history::recorder::{Row, RowOp};
use crate::migrations::RECOVERY_V1;

/// `session` の 1 行。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionInfo {
    pub project_root: String,
    pub project_id: String,
    pub base_mtime_ms: Option<i64>,
    pub base_size: Option<i64>,
    pub opened_at: i64,
    pub last_change_at: Option<i64>,
    pub app_version: String,
    pub pid: u32,
}

/// 追記する 1 件。
#[derive(Debug, Clone)]
pub struct NewEntry<'a> {
    pub at: i64,
    pub label: &'a str,
    pub source: &'a str,
    pub asset_id: Option<&'a str>,
    pub command_json: &'a str,
    pub inverse_json: &'a str,
}

/// 読み出した 1 件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub seq: i64,
    pub at: i64,
    pub label: String,
    pub source: String,
    pub asset_id: Option<String>,
    pub command_json: String,
    pub inverse_json: String,
}

/// 記録の中身が読めない（形の違い・BLOB・未知のテーブル）。Undo の再構築から除外する。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unreadable(pub String);

// ---- RowOp ⇄ JSON ----

fn value_to_json(value: &Value) -> Json {
    match value {
        Value::Null => json!({"t": "n"}),
        Value::Integer(i) => json!({"t": "i", "v": i}),
        Value::Real(r) => json!({"t": "r", "v": r}),
        Value::Text(s) => json!({"t": "s", "v": s}),
        Value::Blob(bytes) => {
            let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            json!({"t": "b", "v": hex})
        }
    }
}

fn value_from_json(json: &Json) -> Result<Value, Unreadable> {
    let unreadable = |what: &str| Unreadable(format!("値が読めない: {what}"));
    let kind = json
        .get("t")
        .and_then(Json::as_str)
        .ok_or_else(|| unreadable("t がない"))?;
    match kind {
        "n" => Ok(Value::Null),
        "i" => json
            .get("v")
            .and_then(Json::as_i64)
            .map(Value::Integer)
            .ok_or_else(|| unreadable("整数")),
        "r" => json
            .get("v")
            .and_then(Json::as_f64)
            .map(Value::Real)
            .ok_or_else(|| unreadable("実数")),
        "s" => json
            .get("v")
            .and_then(Json::as_str)
            .map(|s| Value::Text(s.to_owned()))
            .ok_or_else(|| unreadable("文字列")),
        other => Err(unreadable(&format!("未対応の型 {other}"))),
    }
}

fn row_to_json(row: &Option<Row>) -> Json {
    match row {
        None => Json::Null,
        Some(values) => Json::Array(values.iter().map(value_to_json).collect()),
    }
}

fn row_from_json(json: &Json) -> Result<Option<Row>, Unreadable> {
    match json {
        Json::Null => Ok(None),
        Json::Array(values) => values
            .iter()
            .map(value_from_json)
            .collect::<Result<Row, _>>()
            .map(Some),
        _ => Err(Unreadable("行が配列でも null でもない".to_owned())),
    }
}

/// `RowOp` の列を、`inverse_json` の文字列にする。
pub fn ops_to_json(ops: &[RowOp]) -> String {
    let array: Vec<Json> = ops
        .iter()
        .map(|op| {
            json!({
                "table": op.table,
                "key": op.key.iter().map(value_to_json).collect::<Vec<_>>(),
                "before": row_to_json(&op.before),
                "after": row_to_json(&op.after),
            })
        })
        .collect();
    Json::Array(array).to_string()
}

/// `inverse_json` を `RowOp` の列に戻す。読めなければ `Unreadable`。
pub fn ops_from_json(text: &str) -> Result<Vec<RowOp>, Unreadable> {
    let json: Json = serde_json::from_str(text).map_err(|e| Unreadable(e.to_string()))?;
    let Json::Array(items) = json else {
        return Err(Unreadable("配列ではない".to_owned()));
    };
    items
        .iter()
        .map(|item| {
            let name = item
                .get("table")
                .and_then(Json::as_str)
                .ok_or_else(|| Unreadable("table がない".to_owned()))?;
            let def = table(name).ok_or_else(|| Unreadable(format!("未知のテーブル: {name}")))?;
            let key = item
                .get("key")
                .and_then(Json::as_array)
                .ok_or_else(|| Unreadable("key がない".to_owned()))?
                .iter()
                .map(value_from_json)
                .collect::<Result<Vec<_>, _>>()?;
            let before = row_from_json(item.get("before").unwrap_or(&Json::Null))?;
            let after = row_from_json(item.get("after").unwrap_or(&Json::Null))?;
            for row in [&before, &after].into_iter().flatten() {
                if row.len() != def.columns.len() {
                    return Err(Unreadable(format!("{name} の列の数が合わない")));
                }
            }
            if key.len() != def.pk.len() {
                return Err(Unreadable(format!("{name} の主キーの数が合わない")));
            }
            Ok(RowOp {
                table: def.name,
                key,
                before,
                after,
            })
        })
        .collect()
}

/// Undo / Redo の記録: 向きを反転し（`before` と `after` を入れ替え）、順序を逆にした列。
/// 「`working.db` への順方向の変更」として、通常の操作と同じに扱える。
pub fn inverted(ops: &[RowOp]) -> Vec<RowOp> {
    ops.iter()
        .rev()
        .map(|op| RowOp {
            table: op.table,
            key: op.key.clone(),
            before: op.after.clone(),
            after: op.before.clone(),
        })
        .collect()
}

// ---- journal.db ----

/// `journal.db`。
#[derive(Debug)]
pub struct Journal {
    conn: Connection,
}

fn session_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionInfo> {
    Ok(SessionInfo {
        project_root: row.get(0)?,
        project_id: row.get(1)?,
        base_mtime_ms: row.get(2)?,
        base_size: row.get(3)?,
        opened_at: row.get(4)?,
        last_change_at: row.get(5)?,
        app_version: row.get(6)?,
        pid: row.get(7)?,
    })
}

const SESSION_COLUMNS: &str = "project_root, project_id, base_mtime_ms, base_size, opened_at, last_change_at, app_version, pid";

impl Journal {
    /// 新しく作る（契約の構造を適用し、`session` に 1 行を書く）。すでにあれば失敗する。
    pub fn create(path: &Path, session: &SessionInfo) -> Result<Self, StoreError> {
        if path.exists() {
            return Err(StoreError::AlreadyExists);
        }
        let conn = open_wal_connection(path)?;
        conn.execute_batch(RECOVERY_V1).map_err(classify)?;
        conn.execute(
            "INSERT INTO session (id, project_root, project_id, base_mtime_ms, base_size, \
             opened_at, last_change_at, app_version, pid) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                session.project_root,
                session.project_id,
                session.base_mtime_ms,
                session.base_size,
                session.opened_at,
                session.last_change_at,
                session.app_version,
                session.pid
            ],
        )?;
        Ok(Self { conn })
    }

    /// 既存のものを開く。構造が違う・`session` が無いときは、壊れているとして `Corrupt`。
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        if !path.is_file() {
            return Err(StoreError::NotFound(format!(
                "変更履歴がありません: {}",
                path.display()
            )));
        }
        let conn = open_wal_connection(path)?;
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(classify)?;
        let journal = Self { conn };
        if version != 1 {
            return Err(StoreError::Corrupt(format!(
                "変更履歴の版が想定と違う: {version}"
            )));
        }
        journal.session().map_err(|error| match error {
            StoreError::Sqlite(error) => StoreError::Corrupt(error.to_string()),
            other => other,
        })?;
        Ok(journal)
    }

    pub fn session(&self) -> Result<SessionInfo, StoreError> {
        self.conn
            .query_row(
                &format!("SELECT {SESSION_COLUMNS} FROM session WHERE id = 1"),
                [],
                session_from_row,
            )
            .map_err(classify)
    }

    /// 復元して再開するとき、PID と開始時刻を書き換える。
    pub fn restart_session(&self, opened_at: i64, pid: u32) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE session SET opened_at = ?1, pid = ?2 WHERE id = 1",
            params![opened_at, pid],
        )?;
        Ok(())
    }

    /// 1 件を追記し、`session.last_change_at` を更新する（同じトランザクション）。追記した `seq` を返す。
    pub fn append(&mut self, entry: &NewEntry<'_>) -> Result<i64, StoreError> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO entries (at, label, source, asset_id, command_json, inverse_json) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                entry.at,
                entry.label,
                entry.source,
                entry.asset_id,
                entry.command_json,
                entry.inverse_json
            ],
        )?;
        let seq = tx.last_insert_rowid();
        tx.execute(
            "UPDATE session SET last_change_at = ?1 WHERE id = 1",
            [entry.at],
        )?;
        tx.commit()?;
        Ok(seq)
    }

    pub fn entry_count(&self) -> Result<u32, StoreError> {
        let count: i64 = self
            .conn
            .query_row("SELECT count(*) FROM entries", [], |row| row.get(0))?;
        Ok(u32::try_from(count).unwrap_or(u32::MAX))
    }

    /// いまの `entries` の最大の `seq`（無ければ 0）。保存の基準。
    pub fn max_seq(&self) -> Result<i64, StoreError> {
        Ok(self
            .conn
            .query_row("SELECT max(seq) FROM entries", [], |row| {
                row.get::<_, Option<i64>>(0)
            })?
            .unwrap_or(0))
    }

    /// 保存の仕上げ: `seq` 以下の `entries` を削除し、`base_*` を更新する。
    /// 残った `entries` があれば `last_change_at` はその最後の時刻に、無ければ `NULL` にする。
    pub fn finish_save(
        &mut self,
        seq: i64,
        base_mtime_ms: Option<i64>,
        base_size: Option<i64>,
    ) -> Result<(), StoreError> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM entries WHERE seq <= ?1", [seq])?;
        let last: Option<i64> = tx
            .query_row("SELECT max(at) FROM entries", [], |row| row.get(0))
            .optional()?
            .flatten();
        tx.execute(
            "UPDATE session SET base_mtime_ms = ?1, base_size = ?2, last_change_at = ?3 WHERE id = 1",
            params![base_mtime_ms, base_size, last],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// 新しい順に、最大 `limit` 件。
    pub fn recent(&self, limit: usize) -> Result<Vec<Entry>, StoreError> {
        self.recent_where("1 = 1", limit)
    }

    /// 新しい順に、Undo の再構築に使える記録を最大 `limit` 件。走査・見張りの反映（`source = 'sync'`）は除く。
    pub fn recent_undoable(&self, limit: usize) -> Result<Vec<Entry>, StoreError> {
        self.recent_where("source <> 'sync'", limit)
    }

    fn recent_where(&self, condition: &str, limit: usize) -> Result<Vec<Entry>, StoreError> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT seq, at, label, source, asset_id, command_json, inverse_json \
             FROM entries WHERE {condition} ORDER BY seq DESC LIMIT ?1"
        ))?;
        let rows = stmt
            .query_map([i64::try_from(limit).unwrap_or(i64::MAX)], |row| {
                Ok(Entry {
                    seq: row.get(0)?,
                    at: row.get(1)?,
                    label: row.get(2)?,
                    source: row.get(3)?,
                    asset_id: row.get(4)?,
                    command_json: row.get(5)?,
                    inverse_json: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 閉じる（WAL の補助ファイルを片付ける）。
    pub fn close(self) -> Result<(), StoreError> {
        self.conn
            .close()
            .map_err(|(_, error)| StoreError::Sqlite(error))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "unnotator-journal-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("journal.db")
    }

    fn session() -> SessionInfo {
        SessionInfo {
            project_root: "/p".into(),
            project_id: "pid".into(),
            base_mtime_ms: Some(10),
            base_size: Some(20),
            opened_at: 100,
            last_change_at: None,
            app_version: "0.0.1".into(),
            pid: 4242,
        }
    }

    fn entry<'a>(at: i64, label: &'a str, inverse: &'a str) -> NewEntry<'a> {
        NewEntry {
            at,
            label,
            source: "user",
            asset_id: Some("a1"),
            command_json: "{}",
            inverse_json: inverse,
        }
    }

    fn cleanup(path: &Path) {
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn session_is_written_and_updated() {
        let path = temp_path("session");
        let mut journal = Journal::create(&path, &session()).unwrap();
        assert_eq!(journal.session().unwrap(), session());

        journal.append(&entry(150, "x", "[]")).unwrap();
        assert_eq!(journal.session().unwrap().last_change_at, Some(150));

        journal.restart_session(900, 7).unwrap();
        let restarted = journal.session().unwrap();
        assert_eq!((restarted.opened_at, restarted.pid), (900, 7));

        // 作り直しはできない
        assert_eq!(
            Journal::create(&path, &session()).unwrap_err().code(),
            "already_exists"
        );
        cleanup(&path);
    }

    #[test]
    fn entries_append_count_delete_up_to_and_read_newest_first() {
        let path = temp_path("entries");
        let mut journal = Journal::create(&path, &session()).unwrap();
        assert_eq!(journal.entry_count().unwrap(), 0);
        assert_eq!(journal.max_seq().unwrap(), 0);
        let s1 = journal.append(&entry(1, "a", "[]")).unwrap();
        let s2 = journal.append(&entry(2, "b", "[]")).unwrap();
        let s3 = journal.append(&entry(3, "c", "[]")).unwrap();
        assert!(s1 < s2 && s2 < s3);
        assert_eq!(journal.entry_count().unwrap(), 3);
        assert_eq!(journal.max_seq().unwrap(), s3);

        let recent = journal.recent(2).unwrap();
        assert_eq!(
            recent.iter().map(|e| e.label.as_str()).collect::<Vec<_>>(),
            ["c", "b"]
        );
        assert_eq!(recent[0].asset_id.as_deref(), Some("a1"));

        // s2 以下を削除（保存）。base_* が更新され、last_change_at は残った最後の時刻になる
        journal.finish_save(s2, Some(111), Some(222)).unwrap();
        assert_eq!(journal.entry_count().unwrap(), 1);
        let session = journal.session().unwrap();
        assert_eq!(
            (
                session.base_mtime_ms,
                session.base_size,
                session.last_change_at
            ),
            (Some(111), Some(222), Some(3))
        );
        // 全部削除すると last_change_at は NULL に戻る
        journal.finish_save(s3, Some(1), Some(2)).unwrap();
        assert_eq!(journal.entry_count().unwrap(), 0);
        assert_eq!(journal.session().unwrap().last_change_at, None);
        // seq は戻らない（AUTOINCREMENT）
        let s4 = journal.append(&entry(4, "d", "[]")).unwrap();
        assert!(s4 > s3);
        cleanup(&path);
    }

    #[test]
    fn journal_is_wal_and_reopens() {
        let path = temp_path("wal");
        let mut journal = Journal::create(&path, &session()).unwrap();
        journal.append(&entry(1, "a", "[]")).unwrap();
        let mode: String = journal
            .conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        drop(journal);
        let reopened = Journal::open(&path).unwrap();
        assert_eq!(reopened.entry_count().unwrap(), 1);
        assert_eq!(
            Journal::open(&path.with_file_name("none.db"))
                .unwrap_err()
                .code(),
            "not_found"
        );
        cleanup(&path);
    }

    #[test]
    fn a_file_that_is_not_a_journal_is_corrupt() {
        let path = temp_path("corrupt");
        std::fs::write(&path, b"not a database at all, just bytes").unwrap();
        assert_eq!(Journal::open(&path).unwrap_err().code(), "corrupt");
        cleanup(&path);

        let path = temp_path("foreign");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("CREATE TABLE other (x INTEGER);")
                .unwrap();
        }
        assert_eq!(Journal::open(&path).unwrap_err().code(), "corrupt");
        cleanup(&path);
    }

    fn sample_ops() -> Vec<RowOp> {
        vec![
            RowOp {
                table: "labels",
                key: vec![Value::Text("l1".into())],
                before: None,
                after: Some(vec![
                    Value::Text("l1".into()),
                    Value::Text("person".into()),
                    Value::Null,
                    Value::Text("#112233".into()),
                    Value::Null,
                    Value::Integer(0),
                    Value::Integer(0),
                    Value::Null,
                    Value::Integer(5),
                    Value::Integer(5),
                ]),
            },
            RowOp {
                table: "group_members",
                key: vec![Value::Text("g".into()), Value::Text("a".into())],
                before: Some(vec![
                    Value::Text("g".into()),
                    Value::Text("a".into()),
                    Value::Integer(0),
                ]),
                after: None,
            },
        ]
    }

    #[test]
    fn row_ops_round_trip_through_json_including_composite_keys_and_all_value_types() {
        let ops = sample_ops();
        assert_eq!(ops_from_json(&ops_to_json(&ops)).unwrap(), ops);

        // 実数・負の整数・日本語・引用符
        let odd = vec![RowOp {
            table: "annotations",
            key: vec![Value::Text("a".into())],
            before: None,
            after: Some(
                crate::db::tables::ANNOTATIONS
                    .columns
                    .iter()
                    .enumerate()
                    .map(|(i, _)| match i % 4 {
                        0 => Value::Text("日本語 \"q\" \\ \n".into()),
                        1 => Value::Real(2.5),
                        2 => Value::Integer(-7),
                        _ => Value::Null,
                    })
                    .collect(),
            ),
        }];
        assert_eq!(ops_from_json(&ops_to_json(&odd)).unwrap(), odd);
    }

    #[test]
    fn unreadable_records_are_reported_not_panicked_on() {
        for bad in [
            "not json",
            "{}",
            "[{\"table\":\"nope\",\"key\":[],\"before\":null,\"after\":null}]",
            "[{\"table\":\"labels\",\"key\":[{\"t\":\"s\",\"v\":\"x\"}],\"before\":null,\"after\":[{\"t\":\"b\",\"v\":\"00\"}]}]",
            "[{\"table\":\"labels\",\"key\":[{\"t\":\"s\",\"v\":\"x\"}],\"before\":null,\"after\":[{\"t\":\"n\"}]}]",
            "[{\"table\":\"labels\",\"key\":[],\"before\":null,\"after\":null}]",
            "[{\"table\":\"labels\",\"key\":[{\"t\":\"q\"}],\"before\":null,\"after\":null}]",
        ] {
            assert!(ops_from_json(bad).is_err(), "{bad}");
        }
        // BLOB は書き出せるが、読み戻せない
        let blob = vec![RowOp {
            table: "labels",
            key: vec![Value::Text("x".into())],
            before: None,
            after: Some(vec![Value::Blob(vec![0, 1])]),
        }];
        assert!(ops_from_json(&ops_to_json(&blob)).is_err());
    }

    #[test]
    fn inverted_swaps_direction_and_reverses_order() {
        let ops = sample_ops();
        let inv = inverted(&ops);
        assert_eq!(inv.len(), 2);
        assert_eq!(inv[0].table, "group_members");
        assert_eq!(inv[0].before, None);
        assert_eq!(inv[0].after, ops[1].before);
        assert_eq!(inv[1].table, "labels");
        assert_eq!(inv[1].before, ops[0].after);
        assert_eq!(inv[1].after, None);
        // 2 回反転すると元に戻る
        assert_eq!(inverted(&inv), ops);
    }
}
