//! DB スキーマの契約（`migrations/{project,recovery}/0001_init.sql`）を空の DB に適用して確かめる。

use rusqlite::Connection;
use unnotator_core::migrations::{PROJECT_V1, RECOVERY_V1};

type TestResult = Result<(), rusqlite::Error>;

fn user_version(conn: &Connection) -> Result<i64, rusqlite::Error> {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
}

#[test]
fn project_schema_applies_and_sets_user_version_1() -> TestResult {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch(PROJECT_V1)?;
    assert_eq!(user_version(&conn)?, 1);
    Ok(())
}

#[test]
fn recovery_schema_applies_and_sets_user_version_1() -> TestResult {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch(RECOVERY_V1)?;
    assert_eq!(user_version(&conn)?, 1);
    Ok(())
}

#[test]
fn broken_copy_of_schema_is_rejected() -> TestResult {
    // 契約ファイル自体は触らず、文字列を壊した写しで、壊れた SQL が失敗することを確かめる。
    let broken = PROJECT_V1.replacen("CREATE TABLE", "CREATE TABEL", 1);
    let conn = Connection::open_in_memory()?;
    assert!(conn.execute_batch(&broken).is_err());
    Ok(())
}
