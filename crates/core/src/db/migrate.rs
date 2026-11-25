//! 番号付きのマイグレーション（research.md R5）。
//!
//! 契約の SQL は `crate::migrations` に埋め込まれている。構造を変えるときは、既存の移行を書き換えず、
//! 新しい番号の移行を `PROJECT_MIGRATIONS` に追加する（憲章 II）。

use rusqlite::Connection;

use crate::error::StoreError;
use crate::migrations::PROJECT_V1;

#[derive(Debug, Clone, Copy)]
pub struct Migration {
    pub version: u32,
    pub sql: &'static str,
}

/// プロジェクト DB の移行。いまは版 1 だけ。
pub const PROJECT_MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    sql: PROJECT_V1,
}];

/// 移行の列の最新の版。
pub fn latest_version(migrations: &[Migration]) -> u32 {
    migrations.iter().map(|m| m.version).max().unwrap_or(0)
}

/// 空の DB に、最新まで順に適用する。全体が 1 つのトランザクションで、失敗したら何も残らない。
pub fn apply_all(conn: &Connection, migrations: &[Migration]) -> Result<(), StoreError> {
    let tx = conn.unchecked_transaction()?;
    let mut ordered: Vec<&Migration> = migrations.iter().collect();
    ordered.sort_by_key(|m| m.version);
    for migration in ordered {
        tx.execute_batch(migration.sql).map_err(|error| {
            StoreError::MigrationFailed(format!("版 {}: {error}", migration.version))
        })?;
    }
    let version: i64 = tx.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let latest = latest_version(migrations);
    if version != i64::from(latest) {
        return Err(StoreError::MigrationFailed(format!(
            "適用後の版が {version}（期待は {latest}）"
        )));
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_all_creates_the_latest_schema() {
        let conn = Connection::open_in_memory().unwrap();
        apply_all(&conn, PROJECT_MIGRATIONS).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 1);
        assert_eq!(latest_version(PROJECT_MIGRATIONS), 1);
    }

    #[test]
    fn a_failing_migration_leaves_nothing_behind() {
        let conn = Connection::open_in_memory().unwrap();
        let broken = [
            Migration {
                version: 1,
                sql: PROJECT_V1,
            },
            Migration {
                version: 2,
                sql: "CREATE TABLE ok (x INTEGER); THIS IS NOT SQL;",
            },
        ];
        let err = apply_all(&conn, &broken).unwrap_err();
        assert_eq!(err.code(), "migration_failed");
        let tables: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 0);
    }
}
