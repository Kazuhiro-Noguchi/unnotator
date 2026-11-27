//! ラベルの一覧（`LabelRow`）。

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::StoreError;

/// `labels` の 1 行。並びは `sort_order`、同じなら `name`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct LabelRow {
    pub id: String,
    pub name: String,
    pub name_i18n_json: String,
    pub color: String,
    pub hotkey: Option<u8>,
    pub sort_order: i32,
    pub hidden: bool,
    pub applies_to_json: String,
}

pub fn list_labels(conn: &Connection) -> Result<Vec<LabelRow>, StoreError> {
    let mut stmt = conn.prepare(
        "SELECT id, name, name_i18n_json, color, hotkey, sort_order, hidden, applies_to_json \
         FROM labels ORDER BY sort_order, name, id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(LabelRow {
            id: row.get(0)?,
            name: row.get(1)?,
            name_i18n_json: row.get(2)?,
            color: row.get(3)?,
            hotkey: row
                .get::<_, Option<i64>>(4)?
                .and_then(|n| u8::try_from(n).ok()),
            sort_order: row.get(5)?,
            hidden: row.get::<_, i64>(6)? != 0,
            applies_to_json: row.get(7)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use crate::migrations::PROJECT_V1;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(PROJECT_V1).unwrap();
        conn
    }

    fn insert(
        conn: &Connection,
        id: &str,
        name: &str,
        order: i32,
        hotkey: Option<u8>,
        hidden: bool,
    ) {
        conn.execute(
            "INSERT INTO labels (id, name, color, hotkey, sort_order, hidden, created_at, updated_at) \
             VALUES (?1, ?2, '#112233', ?3, ?4, ?5, 0, 0)",
            rusqlite::params![id, name, hotkey, order, hidden],
        )
        .unwrap();
    }

    #[test]
    fn an_empty_project_has_no_labels() {
        assert_eq!(list_labels(&db()).unwrap(), vec![]);
    }

    #[test]
    fn labels_are_ordered_by_sort_order_then_name() {
        let conn = db();
        insert(&conn, "c", "zebra", 0, None, false);
        insert(&conn, "b", "apple", 1, Some(2), true);
        insert(&conn, "a", "mango", 0, Some(1), false);
        let rows = list_labels(&conn).unwrap();
        let names: Vec<&str> = rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["mango", "zebra", "apple"]);
        assert_eq!(rows[0].hotkey, Some(1));
        assert!(rows[2].hidden);
        assert_eq!(rows[0].applies_to_json, "{}");
    }
}
