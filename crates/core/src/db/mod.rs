//! データベース接続とテーブルの定義。

pub mod tables;

use std::path::Path;

use rusqlite::Connection;

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
