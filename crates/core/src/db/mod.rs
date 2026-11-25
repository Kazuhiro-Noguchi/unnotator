//! データベース接続とテーブルの定義。

pub mod migrate;
pub mod tables;

use std::path::Path;

use rusqlite::{Connection, ErrorCode};

use crate::error::StoreError;

/// ファイルの DB を開く。外部キーは接続ごとに有効にする（契約の SQL の PRAGMA は接続をまたいで残らない）。
/// ジャーナルモードは既定のまま（research.md R4）。
pub fn open_connection(path: &Path) -> Result<Connection, StoreError> {
    let conn = Connection::open(path)?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    Ok(conn)
}

/// メモリ上の DB を開く（テスト用）。
pub fn open_in_memory() -> Result<Connection, StoreError> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    Ok(conn)
}

/// 読めない・壊れているときの SQLite のエラーを `Corrupt` にする。
pub fn classify(error: rusqlite::Error) -> StoreError {
    if let rusqlite::Error::SqliteFailure(failure, message) = &error
        && matches!(
            failure.code,
            ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt
        )
    {
        return StoreError::Corrupt(message.clone().unwrap_or_else(|| failure.to_string()));
    }
    StoreError::Sqlite(error)
}

/// 作業用の複製・変更履歴の接続（WAL）。保存中の編集を待たせないため（S-03）。
pub fn open_wal_connection(path: &Path) -> Result<Connection, StoreError> {
    let conn = Connection::open(path).map_err(classify)?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;",
    )
    .map_err(classify)?;
    Ok(conn)
}
