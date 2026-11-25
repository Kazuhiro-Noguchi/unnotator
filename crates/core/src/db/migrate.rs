//! 番号付きのマイグレーション（research.md R5）。
//!
//! 契約の SQL は `crate::migrations` に埋め込まれている。構造を変えるときは、既存の移行を書き換えず、
//! 新しい番号の移行を `PROJECT_MIGRATIONS` に追加する（憲章 II）。

use std::path::{Path, PathBuf};

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

fn run_migration(conn: &Connection, migration: &Migration) -> Result<(), StoreError> {
    conn.execute_batch(migration.sql).map_err(|error| {
        StoreError::MigrationFailed(format!("版 {}: {error}", migration.version))
    })?;
    // 版の記録は、移行の SQL に任せきりにせず、ここでも揃える（トランザクション内なので、失敗すれば戻る）。
    conn.execute_batch(&format!("PRAGMA user_version = {}", migration.version))
        .map_err(|error| {
            StoreError::MigrationFailed(format!("版 {}: {error}", migration.version))
        })?;
    Ok(())
}

/// 空の DB に、最新まで順に適用する。全体が 1 つのトランザクションで、失敗したら何も残らない。
pub fn apply_all(conn: &Connection, migrations: &[Migration]) -> Result<(), StoreError> {
    let tx = conn.unchecked_transaction()?;
    let mut ordered: Vec<&Migration> = migrations.iter().collect();
    ordered.sort_by_key(|m| m.version);
    for migration in ordered {
        run_migration(&tx, migration)?;
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

/// 移行前の内容を `backup` として残す。`VACUUM INTO` で一時ファイルに書き、成功してから名前を変える。
fn make_backup(conn: &Connection, backup: &Path) -> Result<(), StoreError> {
    let mut temporary = PathBuf::from(backup);
    temporary.set_extension("bak.tmp");
    let _ = std::fs::remove_file(&temporary);
    conn.execute("VACUUM INTO ?1", [temporary.to_string_lossy().as_ref()])
        .map_err(|error| StoreError::MigrationFailed(format!("退避を作れない: {error}")))?;
    // 前の退避は置き換える（Windows では上書きの名前変更ができないので、先に消す）。
    let _ = std::fs::remove_file(backup);
    std::fs::rename(&temporary, backup)?;
    Ok(())
}

/// 開いた DB を最新の版にする。移行したときは、移行前の版を返す。
///
/// - 最新より新しい版: 何も書き換えずに `TooNew`。
/// - 最新と同じ版: 何もしない（退避も作らない）。
/// - 古い版: 移行前の内容を `backup` に残し、未適用の移行を 1 つのトランザクションで順に適用する。
///   途中で失敗したら全体をロールバックし、元のプロジェクトは移行前のまま使える。
pub fn migrate(
    conn: &Connection,
    backup: &Path,
    migrations: &[Migration],
) -> Result<Option<u32>, StoreError> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let latest = i64::from(latest_version(migrations));
    if version > latest {
        return Err(StoreError::TooNew {
            found: version,
            supported: latest,
        });
    }
    if version == latest {
        return Ok(None);
    }
    if version == 0 {
        // 版が記録されていない = 契約の構造が入っていない。
        return Err(StoreError::NotAProject);
    }

    make_backup(conn, backup)?;

    let tx = conn.unchecked_transaction()?;
    let mut pending: Vec<&Migration> = migrations
        .iter()
        .filter(|m| i64::from(m.version) > version)
        .collect();
    pending.sort_by_key(|m| m.version);
    for migration in pending {
        run_migration(&tx, migration)?;
    }
    tx.execute(
        "UPDATE meta SET value = ?1 WHERE key = 'schema_version'",
        [latest.to_string()],
    )?;
    tx.commit()?;
    Ok(Some(u32::try_from(version).unwrap_or(0)))
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
