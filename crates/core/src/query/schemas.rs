//! 属性スキーマの一覧（`SchemaRow`）。

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::StoreError;

/// `attribute_schemas` の 1 行。並びは `scope`、`target`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct SchemaRow {
    pub scope: String,
    pub target: String,
    pub schema_json: String,
}

pub fn list_schemas(conn: &Connection) -> Result<Vec<SchemaRow>, StoreError> {
    let mut stmt = conn.prepare(
        "SELECT scope, target, schema_json FROM attribute_schemas ORDER BY scope, target",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(SchemaRow {
            scope: row.get(0)?,
            target: row.get(1)?,
            schema_json: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use crate::migrations::PROJECT_V1;

    #[test]
    fn schemas_are_listed_by_scope_and_target() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(PROJECT_V1).unwrap();
        assert_eq!(list_schemas(&conn).unwrap(), vec![]);
        for (id, scope, target) in [
            ("2", "label", "l1"),
            ("1", "global", ""),
            ("3", "asset", ""),
        ] {
            conn.execute(
                "INSERT INTO attribute_schemas (id, scope, target, schema_json, updated_at) \
                 VALUES (?1, ?2, ?3, '{\"type\":\"object\"}', 0)",
                [id, scope, target],
            )
            .unwrap();
        }
        let rows = list_schemas(&conn).unwrap();
        let keys: Vec<(&str, &str)> = rows
            .iter()
            .map(|r| (r.scope.as_str(), r.target.as_str()))
            .collect();
        assert_eq!(keys, [("asset", ""), ("global", ""), ("label", "l1")]);
    }
}
